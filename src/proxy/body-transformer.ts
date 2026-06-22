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
 *   5. Anthropic format → strip `thinking` / `redacted_thinking` content
 *      blocks from `messages[].content`. GLM upstream only accepts the
 *      top-level `thinking` field — thinking blocks echoed back in assistant
 *      history (which Claude Code sends on turn 2+) cause 3001 "parameter
 *      error". Without this, only the first turn of a Claude Code session
 *      succeeds; every subsequent turn 3001s.
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

  const result = transformRequestBodyObj(parsed, ctx);
  return result !== undefined ? JSON.stringify(result) : body;
}

/**
 * Apply body transformations on a pre-parsed object. Returns the transformed
 * object (mutated in place for efficiency), or undefined if nothing changed.
 */
export function transformRequestBodyObj(parsed: unknown, ctx: TransformContext): unknown | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;

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
    modified = stripThinkingBlocksFromMessages(obj) || modified;
    modified = sanitizeContentBlocks(obj) || modified;
    modified = applyAnthropicCacheControl(obj) || modified;
    if (ctx.userId) {
      modified = applyAnthropicUserId(obj, ctx.userId) || modified;
    }
  }

  return modified ? parsed : undefined;
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
 *
 * IMPORTANT: Skips `tool_result` blocks — ZCode's start-plan gateway rejects
 * cache_control on tool_result blocks with 3001. If the last block of the
 * last message is a tool_result, we look backwards for a text block to attach
 * cache_control to; if none exists, we skip cache_control entirely for that
 * message (better to miss the cache optimization than to 3001).
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
      // Find the last block that can accept cache_control.
      // tool_result blocks cannot (ZCode gateway 3001s); text blocks can.
      // If the message is entirely tool_result blocks (e.g. a tool-result-only
      // user turn), skip cache_control for this message and continue to the
      // previous message.
      let attached = false;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (typeof block !== "object" || block === null) continue;
        if (block.type === "tool_result") continue; // skip — gateway rejects
        if (!block.cache_control) {
          block.cache_control = { type: "ephemeral" };
          attached = true;
          break;
        }
        // Already has cache_control — message is fine, stop searching.
        attached = true;
        break;
      }
      if (attached) return true;
      // No attachable block on this message — fall through to previous message.
      continue;
    }
    continue;
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
 * Strip `thinking` and `redacted_thinking` content blocks from every message's
 * `content` array.
 *
 * Problem: When the proxy enables thinking (`thinking: {type:"enabled"}`) on
 * the upstream, GLM returns `thinking_delta` SSE events in the assistant's
 * response. Claude Code captures these and, on the NEXT turn, echoes the
 * assistant's prior turn back in `messages[].content` — including the
 * `thinking` block (with an empty or invalid `signature`, since the proxy's
 * signature is not a real Anthropic cryptographic signature).
 *
 * GLM's Anthropic-compatible endpoint does NOT accept `thinking` /
 * `redacted_thinking` content blocks inside `messages[].content` — only the
 * top-level `thinking` field. Sending them produces
 * `400 {"code":3001,"msg":"parameter error"}` from the upstream, which the
 * proxy transparently forwards back to Claude Code. This is why the FIRST
 * turn succeeds (no assistant history yet) but every subsequent turn fails
 * with 3001 — until the conversation is reset.
 *
 * This function strips those blocks before forwarding, so GLM only sees
 * `text` / `image` / `tool_use` / `tool_result` blocks in message content.
 *
 * If stripping leaves a message's content array empty, that message is
 * removed from `messages` entirely (an empty assistant turn would also
 * trip GLM's parameter validation).
 *
 * No-op for non-array `content` (string content is never a thinking block).
 */
function stripThinkingBlocksFromMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  const surviving: unknown[] = [];

  for (const msg of messages) {
    if (!isPlainObject(msg)) {
      surviving.push(msg);
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      surviving.push(msg);
      continue;
    }

    const filtered = content.filter((block: unknown) => {
      if (!isPlainObject(block)) return true;
      const type = block.type;
      // Strip both thinking variants. Anthropic's API defines:
      //   - "thinking"          — {type, thinking, signature}
      //   - "redacted_thinking" — {type, data}
      // GLM upstream rejects either as a content block in messages.
      return type !== "thinking" && type !== "redacted_thinking";
    });

    if (filtered.length === content.length) {
      // No thinking blocks found — keep message as-is
      surviving.push(msg);
      continue;
    }

    changed = true;
    if (filtered.length === 0) {
      // All blocks were thinking — drop the message entirely to avoid
      // sending an empty-content assistant turn upstream (which GLM also
      // rejects with 3001).
      continue;
    }
    msg.content = filtered;
    surviving.push(msg);
  }

  if (changed) {
    body.messages = surviving;
  }
  return changed;
}

/**
 * Sanitize content blocks in `messages[].content` to remove fields that GLM
 * upstream / ZCode gateway reject with 3001 "parameter error".
 *
 * Currently strips:
 *   - `cache_control` from `tool_result` blocks.
 *     Claude Code attaches `cache_control: {type:"ephemeral"}` to the last
 *     block of the last user message — when that message is a tool_result
 *     (i.e. the last turn was a tool call), the cache_control lands ON the
 *     tool_result block. ZCode's start-plan gateway does NOT accept
 *     cache_control on tool_result blocks (only on text blocks) and returns
 *     3001. Anthropic's official API accepts it, but GLM's gateway is stricter.
 *
 *     This is the root cause of the v2.1.3.4beta0 user report: round 3
 *     request had `msgs[..., [4]user/{tool_result}]` where the tool_result
 *     carried cache_control from Claude Code, and the gateway 3001'd.
 *
 * `cache_control` on `text` blocks is preserved (ZCode gateway accepts it
 * there — the proxy's own applyAnthropicCacheControl adds it to text blocks).
 */
function sanitizeContentBlocks(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isPlainObject(block)) continue;
      // Strip cache_control from tool_result blocks only.
      // text blocks keep their cache_control (gateway accepts it there).
      if (block.type === "tool_result" && "cache_control" in block) {
        delete block.cache_control;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * start-plan: prepend ZCode gateway system blocks. The gateway rejects
 * requests without these identity blocks with 3012 "method not allowed".
 */
function applyStartPlanSystem(body: Record<string, unknown>): boolean {
  body.system = buildStartPlanSystem(body.system);
  return true;
}
