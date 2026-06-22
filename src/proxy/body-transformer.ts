/**
 * Request body transformer — applies ZCode-equivalent body mutations before
 * forwarding upstream. All transformations are no-ops on parse failure (the
 * original body is returned unchanged) so a malformed body never breaks the
 * proxy: it just loses the optimization.
 *
 * Transformations applied:
 *   1. OpenAI + `stream: true` → inject `stream_options.include_usage: true`
 *      (matches `@ai-sdk/openai-compatible` default in `_reverse/zcode.cjs`).
 *   2. Anthropic format → add `cache_control: { type: "ephemeral" }` to the
 *      last non-system message (mirrors `HLr` ("finalizeLatestNonSystemCacheControl")
 *      at offset ~636888 in the bundle). Anthropic's API silently ignores
 *      `cache_control` below the per-model token floor, so unconditional add
 *      is safe and matches ZCode's `applyCacheControl: true` default.
 *   3. Anthropic format + `ctx.userId` set → inject `metadata: { user_id }`.
 *      Mirrors `user_id: B.metadata.userId` at bundle offset ~4760586.
 *   4. Anthropic format → transform fields unsupported by GLM upstream
 *      (convert `thinking` to GLM format, strip `context_management`,
 *      `output_config`) and relocate `role: "system"` messages from the
 *      messages array to the `system` field.
 *      These Claude-Code-specific fields cause upstream 3001 "parameter error".
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import { buildStartPlanSystem } from "./system-prompt.js";

export interface TransformContext {
  format: Format;
  /** When set (OAuth mode), the Anthropic-format body gets `metadata.user_id` injected. */
  userId?: string;
  /** When true (start-plan), prepend ZCode gateway system blocks. */
  startPlan?: boolean;
}

/**
 * Apply body transformations. Returns the original `body` string when nothing
 * changed OR when parsing failed; otherwise returns the re-serialized body.
 */
export function transformRequestBody(body: string | undefined, ctx: TransformContext): string | undefined {
  if (body === undefined || body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;

  let modified = false;

  if (ctx.format === "openai") {
    modified = applyStreamOptionsIncludeUsage(parsed as Record<string, unknown>) || modified;
  }
  if (ctx.format === "anthropic") {
    const obj = parsed as Record<string, unknown>;
    if (ctx.startPlan) {
      modified = applyStartPlanSystem(obj) || modified;
    }
    modified = transformUnsupportedAnthropicFields(obj) || modified;
    modified = relocateSystemMessages(obj) || modified;
    modified = applyAnthropicCacheControl(obj) || modified;
    if (ctx.userId) {
      modified = applyAnthropicUserId(obj, ctx.userId) || modified;
    }
  }

  return modified ? JSON.stringify(parsed) : body;
}

/** OpenAI streaming: ensure `stream_options.include_usage: true`. */
function applyStreamOptionsIncludeUsage(body: Record<string, unknown>): boolean {
  if (body.stream !== true) return false;
  const existing = body.stream_options;
  if (isPlainObject(existing) && existing.include_usage === true) {
    return false;
  }
  const merged: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  merged.include_usage = true;
  body.stream_options = merged;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Anthropic: add `cache_control: { type: "ephemeral" }` to the last content
 * block of the last non-system message. Mirrors ZCode's `HLr` algorithm.
 * Idempotent — skips if any block on that message already carries cache_control.
 */
function applyAnthropicCacheControl(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;

    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (typeof lastBlock === "object" && lastBlock !== null && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Anthropic: inject `metadata: { user_id }` when not already set.
 * Preserves any existing `metadata.*` fields other than `user_id`.
 */
function applyAnthropicUserId(body: Record<string, unknown>, userId: string): boolean {
  const existing = body.metadata;
  if (isPlainObject(existing) && existing.user_id === userId) {
    return false;
  }
  body.metadata = {
    ...(isPlainObject(existing) ? existing : {}),
    user_id: userId,
  };
  return true;
}

/**
 * Transform or strip top-level Anthropic request fields that GLM upstream does
 * not support in the format sent by Claude Code.
 *
 * Transformations:
 *   - `thinking` — Claude Code sends `{"type":"adaptive"}` or
 *     `{"type":"enabled","budget_tokens":N}`, but GLM only supports
 *     `{"type":"enabled"}` (thinking on) or `{"type":"disabled"}` (thinking off).
 *     We convert "adaptive" and "enabled" to `{"type":"enabled"}` (stripping
 *     unsupported `budget_tokens`), and keep "disabled" as-is.
 *   - `context_management` — removed (GLM has no equivalent)
 *   - `output_config` — removed (GLM has no equivalent)
 */
function transformUnsupportedAnthropicFields(body: Record<string, unknown>): boolean {
  let changed = false;

  // Transform thinking: GLM only supports "enabled" / "disabled", no "adaptive" or "budget_tokens"
  if ("thinking" in body && isPlainObject(body.thinking)) {
    const t = body.thinking as Record<string, unknown>;
    const type = t.type;
    if (type === "adaptive" || type === "enabled") {
      // Convert to GLM's format: {"type":"enabled"} — strip budget_tokens etc.
      body.thinking = { type: "enabled" };
      changed = true;
    }
    // "disabled" is passed through as-is; any other value is also left alone
  }

  // Remove fields GLM does not support at all
  for (const key of ["context_management", "output_config"] as const) {
    if (key in body) {
      delete body[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Relocate `role: "system"` messages from the `messages` array to the `system` field.
 *
 * Claude Code places system instructions in `messages[].role = "system"`, but the
 * Anthropic Messages API requires system content in the top-level `system` field —
 * `role: "system"` is not a valid value inside `messages`. GLM's Anthropic-compatible
 * endpoint rejects this with 3001 "parameter error".
 *
 * Existing `system` content (string or array) is preserved; relocated system messages
 * are appended after any existing system blocks.
 */
function relocateSystemMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  const systemMsgs: Array<Record<string, unknown>> = [];
  const remaining: unknown[] = [];

  for (const msg of messages) {
    if (isPlainObject(msg) && msg.role === "system") {
      systemMsgs.push(msg);
    } else {
      remaining.push(msg);
    }
  }

  if (systemMsgs.length === 0) return false;

  // Move system messages out of the messages array
  body.messages = remaining;

  // Append their content to the top-level `system` field
  const newBlocks: Array<{ type: string; text: string }> = [];
  for (const msg of systemMsgs) {
    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      newBlocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isPlainObject(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          newBlocks.push({ type: "text", text: block.text });
        }
      }
    }
  }

  if (newBlocks.length === 0) return true; // messages array was modified even if nothing to append

  // Merge with existing system field
  const existing = body.system;
  if (existing == null) {
    body.system = newBlocks;
  } else if (typeof existing === "string") {
    body.system = [{ type: "text", text: existing }, ...newBlocks];
  } else if (Array.isArray(existing)) {
    body.system = [...existing, ...newBlocks];
  }
  // If system is some other type, overwrite with newBlocks (shouldn't happen)

  return true;
}

/**
 * start-plan: prepend ZCode gateway system blocks. The gateway rejects
 * requests without these identity blocks with 3012 "method not allowed".
 */
function applyStartPlanSystem(body: Record<string, unknown>): boolean {
  body.system = buildStartPlanSystem(body.system);
  return true;
}
