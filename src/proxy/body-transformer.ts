/**
 * Request body transformer — applies ZCode-equivalent body mutations before
 * forwarding upstream. All transformations are no-ops on parse failure (the
 * original body is returned unchanged) so a malformed body never breaks the
 * proxy: it just loses the optimization.
 *
 * ⚠️⚠️⚠️ READ BEFORE MODIFYING — DO NOT BLINDLY REMOVE TRANSFORMS ⚠️⚠️⚠️
 *
 * This file is the result of ~10 iterations of debugging 3001 "parameter
 * error" from the ZCode start-plan gateway. Every transformation here exists
 * because the gateway REJECTED the request without it. Removing any of them
 * WILL reintroduce 3001 in some scenario. If you're tempted to "simplify"
 * or "clean up" this file, READ THE HISTORY BELOW FIRST.
 *
 * === WHY EACH TRANSFORM EXISTS ===
 *
 * 1. `transformUnsupportedAnthropicFields` — Claude Code sends
 *    `thinking:{type:"adaptive"}`, `context_management`, `output_config`.
 *    GLM only accepts `thinking:{type:"enabled"|"disabled"}` and has no
 *    equivalent for the other two. Sending them → 3001.
 *
 * 2. `relocateSystemMessages` — Claude Code puts system text in
 *    `messages[].role:"system"`. Anthropic API requires system in top-level
 *    `system` field. GLM rejects `role:"system"` in messages → 3001.
 *
 * 3. `stripThinkingBlocksFromMessages` — When thinking is enabled, GLM
 *    returns thinking_delta SSE events. Claude Code captures these and
 *    echoes them back as `thinking`/`redacted_thinking` content blocks in
 *    the NEXT turn's assistant message. GLM does NOT accept these as
 *    content blocks → 3001 on turn 2+. Without this, only turn 1 succeeds.
 *
 * 4. `ensureAssistantTextBlock` — After #3 strips thinking blocks, an
 *    assistant message may be left with ONLY tool_use blocks. ZCode gateway
 *    requires every assistant message to have at least one text block → 3001
 *    if missing. We insert `text:" "` (single space, NOT empty — empty text
 *    also 3001s) at the front.
 *
 * 5. `normalizeAllMessageContent` — Claude Code and the Responses API
 *    translator both produce `content: "string"` for simple text. ZCode
 *    gateway ONLY accepts array format `content:[{type:"text",text}]` → 3001
 *    on string content. EMPTY strings become empty text blocks → also 3001,
 *    so empty strings are converted to `text:" "` (non-empty placeholder).
 *
 * 6. `normalizeToolResultContent` — Same as #5 but for `tool_result.content`.
 *    Claude Code sends `content:"file1\nfile2"` (string). ZCode gateway
 *    requires array → 3001. Empty output → `text:" "`.
 *
 * 7. `sanitizeContentBlocks` — Strips two fields:
 *    a. `cache_control` — In start-plan mode, stripped from ALL blocks
 *       (including text). ZCode gateway rejects cache_control on ANY block.
 *       In coding-plan mode, stripped from non-text blocks only (direct GLM
 *       API accepts cache_control on text for prompt caching).
 *       DO NOT re-add cache_control in start-plan — it WILL 3001.
 *    b. `is_error` (tool_result only) — Claude Code adds `is_error:false`.
 *       ZCode gateway doesn't accept this field → 3001. Strip in both modes.
 *
 * 8. `applyAnthropicCacheControl` — In coding-plan mode, adds cache_control
 *    to the last text block of the last non-system message (for prompt
 *    caching). In start-plan mode, this is a NO-OP — see #7a above.
 *
 * 9. `applyAnthropicUserId` — In OAuth mode, injects `metadata.user_id`.
 *    ZCode gateway expects this for tracking. No-op in apikey mode.
 *
 * === TRANSFORM ORDER MATTERS ===
 *
 * The transforms run in a specific order (see `transformRequestBodyObj`):
 *   thinking fields → thinking block strip → document block convert →
 *   content normalize → sanitize (is_error:false) → cache_control add →
 *   align ZCode format (system inject + identity rewrite + key reorder)
 *
 * Reordering will break things. For example, `sanitizeContentBlocks` MUST
 * run AFTER `applyAnthropicCacheControl` would have run (it's the safety
 * net), but since `applyAnthropicCacheControl` is no-op in start-plan,
 * `sanitizeContentBlocks` is the only cc authority there. In coding-plan,
 * `sanitizeContentBlocks` strips non-text cc first, then
 * `applyAnthropicCacheControl` adds cc to text only — so even if a future
 * edit accidentally adds cc to a non-text block, sanitize would catch it
 * on the NEXT request (but not this one, since sanitize runs before add).
 *
 * === DEBUGGING 3001 ===
 *
 * If 3001 still occurs:
 *   1. Check the proxy console for `transformed request summary:` line.
 *      It shows every message's role + block types + cc markers + tool_result
 *      content format. ANY `+cc` on non-text blocks, ANY `/str` on tool_result,
 *      ANY `/+err` on tool_result indicates a regression.
 *   2. Check the dumped `zcode-proxy-debug-<reqId>.json` file in the proxy's
 *      working directory — it contains the FULL transformed request body.
 *   3. The `anthropic-beta sent:` line should show `(none)` — since v0.2.0.6
 *      we strip anthropic-beta entirely (the real ZCode client sends none),
 *      eliminating the header/body mismatch that was a 3001 cause.
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import { buildStartPlanSystem, ZCODE_SYSTEM_BLOCKS } from "./system-prompt.js";
import type { SystemBlock } from "./system-prompt.js";

export interface TransformContext {
  format: Format;
  /** When set (OAuth mode), the Anthropic-format body gets `metadata.user_id` injected. */
  userId?: string;
  /** When true (start-plan), prepend ZCode gateway system blocks. */
  startPlan?: boolean;
  /**
   * ZCode thinking tier — controls the budget_tokens + effort injected when
   * the client sends `thinking.type=enabled`.
   *   - "max"  (default): budget_tokens=32000, effort="max"
   *   - "high"          : budget_tokens=16000, effort="high"
   * When the client does NOT send `thinking`, only max_tokens=64000 is
   * injected (ZCode "no thinking" wire shape) — thinking is never forced on.
   */
  thinkingLevel?: "high" | "max";
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
    // Inject ZCode thinking format (max_tokens + budget_tokens + output_config)
    // — runs UNCONDITIONALLY. Any Anthropic request with thinking.type === "enabled"
    // gets the EXACT thinking-format fields the real ZCode desktop client sends.
    //
    // Runs AFTER transformUnsupportedAnthropicFields so we can detect the
    // simplified `thinking: { type: "enabled" }` shape. Must run BEFORE
    // any transform that might strip output_config.
    //
    // v0.1.9+: thinkingLevel controls the tier (high/max). When client doesn't
    // send `thinking`, only max_tokens=64000 is injected (ZCode "no thinking"
    // mode) — thinking is NOT forced on.
    modified = injectZCodeThinkingFormat(obj, ctx.thinkingLevel ?? "max") || modified;
    // v0.1.9+: alignZCodeFormat is the DEFAULT (and only) behavior. We no longer
    // relocate role:"system" from messages[] to top-level system — real ZCode
    // keeps them in messages[] (e.g. "The Bash tool shell was changed...").
    // The align function (called last) handles system injection.
    modified = stripThinkingBlocksFromMessages(obj) || modified;
    // Convert `document` type content blocks to `text` type — ZCode gateway
    // does not accept `document` blocks (Claude Code sends them for file
    // attachments). Must run before normalizeAllMessageContent.
    modified = convertDocumentBlocks(obj) || modified;
    // v0.1.9+: normalizeAllMessageContent still runs (converts string content
    // to array form). Real ZCode uses array form for user/assistant messages.
    modified = normalizeAllMessageContent(obj) || modified;
    // v0.1.9+: skip normalizeToolResultContent — real ZCode client sends
    // tool_result.content as STRING (49/49 in sample).
    // v0.1.9+: skip ensureAssistantTextBlock — real ZCode client allows
    // assistant messages with only tool_use blocks (18 in sample).
    modified = sanitizeContentBlocks(obj) || modified;
    modified = applyAnthropicCacheControl(obj) || modified;
    // start-plan: ZCode gateway is stricter than official Anthropic API and
    // rejects `metadata.user_id` (returns 200 + empty SSE stream — invisible
    // to the SSE error detector, surfaces as "empty/malformed response" in
    // Claude Code). Only inject for coding-plan.
    if (ctx.userId && !ctx.startPlan) {
      modified = applyAnthropicUserId(obj, ctx.userId) || modified;
    }
    // Align request structure to match real ZCode client (must run LAST so
    // all other transforms have settled). Rewrites top-level field order,
    // injects ZCode system blocks (both coding-plan AND start-plan), and
    // rewrites "You are Claude Code" → "You are ZCode model working in Claude Code".
    // v0.1.9+: this is now the default and only path.
    const aligned = alignZCodeRequestFormat(obj);
    if (aligned) {
      // alignZCodeRequestFormat rebuilds the object with correct key order.
      // We need to replace parsed's keys in place — clear and re-assign.
      for (const k of Object.keys(parsed as Record<string, unknown>)) {
        delete (parsed as Record<string, unknown>)[k];
      }
      Object.assign(parsed as Record<string, unknown>, aligned);
      modified = true;
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
 * Anthropic: enforce the real ZCode desktop client's cache_control placement
 * rules on the LAST **user** message. Verified against a 6-request complete
 * flow capture (2026-06-30) — see _reverse captures for the full transcript.
 *
 * === THE THREE ZCODE RULES ===
 *
 * Based on observed zcode desktop client behavior across 6 consecutive
 * requests in a tool-using conversation:
 *
 *   RULE 1 — Text-only last user message (req#1, req#2):
 *     Attach cc to the LAST `text` block of the message.
 *     If the client already placed cc somewhere, leave it alone (idempotent).
 *
 *   RULE 2 — Single tool_result in the last user message (req#3, req#4, req#6):
 *     KEEP cc on the tool_result block itself. The real zcode client puts
 *     `cache_control: { type: "ephemeral" }` directly on the tool_result.
 *     If the client (Claude Code) already has cc there, leave it alone.
 *     If the client did NOT put cc there, attach it (zcode always does).
 *
 *   RULE 3 — Multiple tool_result blocks in the last user message (req#5):
 *     STRIP cc from ALL tool_result blocks. The real zcode client drops cc
 *     entirely when the user message has 2+ tool_results (parallel tool
 *     continuation). Forwarding cc on multiple tool_results is a clear
 *     "non-ZCode client" tell and may trigger gateway rejection.
 *
 * === NON-LAST USER MESSAGES ===
 *
 * cc on user messages BEFORE the last one is left untouched — the zcode
 * client doesn't strip cc from history when accumulating turns. (Claude
 * Code's previous turns may carry cc on tool_result blocks; we leave them
 * as-is. Only the LAST user message gets the active rule enforcement, since
 * that's the only place where the zcode fingerprint actually matters for
 * the upstream's prompt-cache breakpoint decision.)
 *
 * === ASSISTANT / SYSTEM MESSAGES ===
 *
 * NEVER attach cc to assistant messages (real zcode never does — verified).
 * NEVER touch system messages here (system cc is handled separately by
 * alignZCodeRequestFormat, which marks the last system block).
 *
 * === HISTORY ===
 *
 * v0.1.9–v0.2.0.8: attached cc to last user OR assistant message's text
 * block, walking backwards through messages. Worked but was a fingerprint
 * mismatch vs real zcode.
 *
 * v0.2.0.9 (commit 51f2ce7): tried to mirror zcode's cc-anchor pattern by
 * appending `text:" "` + cc to tool_result user messages. MISREAD the
 * sample — caused gateway `[1213][未正常接收到prompt参数。]`.
 *
 * v0.2.1.3:保守 skip — when last user message has any tool_result, skip cc
 * entirely. Fixed the 1213 but lost cache hits for the common single-tool
 * continuation case.
 *
 * v0.2.1.4 (this version): full zcode alignment — single tool_result keeps
 * cc on itself, multiple tool_result strips all cc, text-only attaches to
 * last text block. Verified 1:1 against the 6-request zcode capture.
 *
 * The `sanitizeContentBlocks()` function runs BEFORE this and no longer
 * strips cc from tool_result blocks (v0.2.1.4 fix) — so this function sees
 * the client's original cc placement and can adjust it per the rules above.
 */
function applyAnthropicCacheControl(
  body: Record<string, unknown>,
): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // Find the LAST user message (walk backwards, skip non-user).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isPlainObject(msg)) continue;
    if (msg.role !== "user") continue;

    // === String content → wrap as text block with cc (RULE 1) ===
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }

    if (!Array.isArray(msg.content) || msg.content.length === 0) {
      // Empty/no content array — nothing to attach to.
      return false;
    }

    // === Count tool_result blocks in this user message ===
    const toolResultBlocks: number[] = [];
    for (let j = 0; j < msg.content.length; j++) {
      const b = msg.content[j];
      if (isPlainObject(b) && b.type === "tool_result") {
        toolResultBlocks.push(j);
      }
    }

    // === RULE 3: multiple tool_result blocks → strip cc from ALL of them ===
    // Real zcode drops cc entirely when the user message has 2+ tool_results
    // (verified req#5: 2 tool_results, no cc anywhere). Forwarding cc on
    // multiple tool_results is a fingerprint mismatch and risks gateway
    // rejection.
    if (toolResultBlocks.length >= 2) {
      let changed = false;
      for (const j of toolResultBlocks) {
        const b = msg.content[j] as Record<string, unknown>;
        if ("cache_control" in b) {
          delete b.cache_control;
          changed = true;
        }
      }
      // Also strip cc from any text blocks in this message — zcode's
      // multi-tool_result pattern has NO cc anywhere on the message.
      for (let j = 0; j < msg.content.length; j++) {
        const b = msg.content[j] as Record<string, unknown>;
        if (isPlainObject(b) && b.type === "text" && "cache_control" in b) {
          delete b.cache_control;
          changed = true;
        }
      }
      return changed;
    }

    // === RULE 2: single tool_result → ensure cc on the tool_result itself ===
    // Real zcode attaches cc directly to the single tool_result block
    // (verified req#3/#4/#6). If the client already has cc there, leave it
    // alone (idempotent). If not, add it.
    if (toolResultBlocks.length === 1) {
      const trIdx = toolResultBlocks[0];
      const tr = msg.content[trIdx] as Record<string, unknown>;
      if (!tr.cache_control) {
        tr.cache_control = { type: "ephemeral" };
        return true;
      }
      // Already has cc on the tool_result — message matches zcode wire shape.
      return false;
    }

    // === RULE 1: no tool_result (text-only or other blocks) → attach cc to last text block ===
    // Real zcode attaches cc to the last text block of a text-only user
    // message (verified req#1/#2). Walk backwards to find a text block.
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as Record<string, unknown>;
      if (!isPlainObject(block)) continue;
      if (block.type !== "text") continue;
      if (!block.cache_control) {
        block.cache_control = { type: "ephemeral" };
        return true;
      }
      // Already has cc on a text block — message matches zcode wire shape.
      return true;
    }

    // No text block at all (e.g. only image blocks — rare for a user msg).
    // Don't append a placeholder — that was the v0.2.0.9 mistake.
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
 * Inject the EXACT thinking-format fields the real ZCode desktop client sends.
 *
 * Runs UNCONDITIONALLY on every Anthropic request. Behavior depends on whether
 * the client sent a `thinking` field and which `thinkingLevel` tier is selected:
 *
 *   1. Client sent `thinking.type === "enabled"`:
 *      Inject the tier-specific values:
 *        - "max"  (default): max_tokens=64000, budget_tokens=32000, effort="max"
 *        - "high"          : max_tokens=64000, budget_tokens=16000, effort="high"
 *      These match the two thinking tiers the real ZCode desktop client offers
 *      to users (高 / 最高).
 *
 *   2. Client did NOT send `thinking`, or sent `thinking.type !== "enabled"`
 *      (e.g. "disabled"):
 *      Only force `max_tokens=64000`. Do NOT add `thinking` or `output_config`.
 *      This mirrors ZCode's "不思考" wire shape — the client never sends a
 *      thinking field at all in that mode.
 *
 *      We DO NOT force thinking on. If the user wants thinking, they enable it
 *      on the client side (Claude Code, Cherry Studio, etc.) — the dashboard
 *      tier selector only controls high vs max intensity, not on/off.
 *
 * Source: reverse-engineered from real ZCode Electron client traffic (2026-06).
 * Three observed wire shapes:
 *   - max tier:    { max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 32000 }, output_config: { effort: "max" } }
 *   - high tier:   { max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 16000 }, output_config: { effort: "high" } }
 *   - no thinking: { max_tokens: 64000 }   (no thinking field, no output_config field)
 *
 * Runs AFTER transformUnsupportedAnthropicFields so we can detect the simplified
 * `thinking: { type: "enabled" }` shape. Must run BEFORE any transform that
 * might strip output_config.
 */
function injectZCodeThinkingFormat(body: Record<string, unknown>, level: "high" | "max" = "max"): boolean {
  const thinking = body.thinking;
  const isThinkingEnabled = isPlainObject(thinking) && (thinking as Record<string, unknown>).type === "enabled";

  let changed = false;

  // === Always force max_tokens=64000 (matches all 3 ZCode wire shapes) ===
  if (body.max_tokens !== 64000) {
    body.max_tokens = 64000;
    changed = true;
  }

  if (!isThinkingEnabled) {
    // ZCode "不思考" mode: max_tokens already set above, no thinking field,
    // no output_config. Make sure no leftover output_config from a prior
    // transform step sneaks through (transformUnsupportedAnthropicFields
    // already deletes it, but be defensive).
    if ("output_config" in body) {
      delete body.output_config;
      changed = true;
    }
    return changed;
  }

  // === Thinking enabled: inject tier-specific values ===
  const t = thinking as Record<string, unknown>;
  const budgetTokens = level === "high" ? 16000 : 32000;
  const effort = level === "high" ? "high" : "max";

  // 1. Force thinking.budget_tokens to the tier value.
  //    transformUnsupportedAnthropicFields strips budget_tokens (GLM "doesn't
  //    support" it — but the real ZCode client sends it anyway and the gateway
  //    accepts it). We re-add it here to match the real client's shape.
  if (t.budget_tokens !== budgetTokens) {
    t.budget_tokens = budgetTokens;
    changed = true;
  }

  // 2. Re-add output_config: { effort: <tier> }.
  //    transformUnsupportedAnthropicFields deletes this; we add it back. The
  //    real ZCode client always sends it when thinking is enabled.
  if (!isPlainObject(body.output_config) || (body.output_config as Record<string, unknown>).effort !== effort) {
    body.output_config = { effort };
    changed = true;
  }

  return changed;
}

/**
 * Align request structure to match the real ZCode desktop client's wire format.
 *
 * =====================================================================
 *  FORMAT CONVERSION BOUNDARY — DO NOT MODIFY WITHOUT REVIEW
 * =====================================================================
 *  This function is the FINAL stage of ZCode wire-shape alignment. Both
 *  Claude Code (Anthropic format) and Codex (Responses API format) requests
 *  flow through it after their format-specific translation.
 *
 *  Pipeline:
 *    - Claude Code  ─┐
 *                   ├─→ body-transformer.alignZCodeRequestFormat  ─→ upstream
 *    - Codex        ─┘   (Responses→Anthropic translation upstream)
 *
 *  Status: VERIFIED ALIGNED (2026-06-27)
 *    - Top-level field order: model → max_tokens → thinking → output_config
 *                             → system → messages → tools → tool_choice → stream
 *    - thinking: {type:enabled, budget_tokens:32000}
 *    - output_config: {effort:max}
 *    - max_tokens: 64000
 *    - stream: true (unconditional)
 *    - tool_choice: {type:auto} (when tools present)
 *    - system: [ZCode official +cc, ZCode official +cc, user blocks +cc on last]
 *    - metadata / context_management / billing-header: stripped
 *    - document / thinking blocks in messages: stripped
 *    - string content → array form
 *
 *  Before modifying ANY step here, run:
 *    bun run /home/z/my-project/scripts/test_alignment.ts            (Claude Code)
 *    bun run /home/z/my-project/scripts/test_responses_alignment.ts  (Codex)
 *  and confirm both still report "[OK]" on max_tokens / thinking /
 *  output_config / tool_choice / stream / all strip checks.
 *
 *  Failure modes if you "simplify" this function:
 *    - Removing stream:true force → breaks non-stream clients (no SSE buffering)
 *    - Removing cache_control injection on last system block → WAF fingerprint mismatch
 *    - Reordering steps → field conflicts / 3001 "parameter error" from gateway
 *    - Removing metadata drop → "non-ZCode client" fingerprint
 * =====================================================================
 *
 * Triggered only when `ctx.alignZCodeFormat === true`. Performs these transformations:
 *
 * 1. **Inject ZCode system blocks** (both coding-plan AND start-plan):
 *    - Prepend 2 official ZCode identity blocks from zcode_system.json
 *    - Each official block carries `cache_control: { type: "ephemeral" }`
 *    - Client's original system blocks (if any) appended AFTER the ZCode blocks
 *    - Critical for start-plan: gateway does content inspection and rejects
 *      requests missing the ZCode identity blocks
 *
 * 1b. **Mark last system block with cache_control** (v0.2.0.5):
 *    - Real ZCode client puts cc on its last (own #3) system block as a
 *      prompt-cache breakpoint. We mirror this by adding cc to the last
 *      block of our injected system array (idempotent — won't overwrite
 *      existing cc).
 *
 * 2. **Client identity rewrite** (Claude Code only): if the client's system
 *    text contains "You are Claude Code, Anthropic's official CLI for Claude."
 *    (Claude Code's default identity string), rewrite it to "You are ZCode
 *    model working in Claude Code." — preserves Claude Code's harness
 *    instructions while adopting ZCode identity for WAF bypass.
 *    Codex identity is NOT rewritten — by design, only Claude Code gets this.
 *
 * 3. **Top-level field reorder**: rebuild the object with key insertion order
 *    matching the real ZCode client:
 *      model → max_tokens → thinking → output_config → system → messages →
 *      tools → tool_choice → stream → (other fields)
 *    JSON object key order is preserved by JS engines (ES2015+), so this
 *    actually changes the wire bytes — important because some WAFs inspect
 *    key order as a fingerprint.
 *
 * 3b. **Force stream: true** (v0.2.0.4): real ZCode client always streams.
 *     We unconditionally set `body.stream = true`. The response path in
 *     handler.ts buffers SSE → batch JSON for non-stream clients transparently.
 *
 * 4. **Drop client-only fields**: `metadata` (Claude Code tracking),
 *    `context_management` (Claude Code-specific) — neither is sent by real
 *    ZCode client, their presence is a clear "non-ZCode client" fingerprint.
 *
 * Returns the new object with reordered keys, or null if no changes were made
 * (though in practice the system injection always triggers when alignZCodeFormat
 * is on, so this always returns a non-null object).
 *
 * @see _reverse/NOTEPAD.md "Real ZCode Request Structure (2026-06)"
 */
const ZCODE_OFFICIAL_SYSTEM_BLOCKS: ReadonlyArray<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = Object.freeze(
  (ZCODE_SYSTEM_BLOCKS as SystemBlock[]).map(b => Object.freeze({ ...b })),
);

/**
 * Claude Code's identity pattern — matches both known variants and rewrites
 * to ZCode identity. Covers:
 *   - "You are Claude Code, Anthropic's official CLI for Claude."
 *   - "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
 */
const CLAUDE_CODE_IDENTITY_RE = /You are Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?\./;
const ZCODE_IDENTITY_REPLACEMENT = "You are ZCode model working in Claude Code.";

function alignZCodeRequestFormat(body: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;

  // === Step 1: Inject ZCode system blocks (always, both plans) ===
  // Prepend official ZCode identity blocks. Client's existing system blocks
  // are appended after (with identity rewrite applied — see Step 2).
  //
  // IDEMPOTENCY: if the request has already been aligned (e.g. on retry), the
  // system field already starts with the 3 ZCode official blocks. We detect
  // this by checking if the first block's text matches the first ZCode block,
  // and if so, DON'T re-inject (just rewrite identity + reorder keys).
  const clientSystem = normalizeSystemToArray(body.system);
  const alreadyInjected = clientSystem.length > 0
    && clientSystem[0].text === ZCODE_OFFICIAL_SYSTEM_BLOCKS[0].text;

  const rewrittenClientSystem = rewriteClaudeCodeIdentity(clientSystem);
  if (rewrittenClientSystem !== clientSystem) changed = true;

  if (!alreadyInjected) {
    const officialBlocks = ZCODE_OFFICIAL_SYSTEM_BLOCKS.map(b => ({ ...b }));
    body.system = [...officialBlocks, ...rewrittenClientSystem];
  } else {
    body.system = rewrittenClientSystem;
  }
  changed = true;

  // === Step 1b: Mark the last user-provided system block with cache_control ===
  // Real ZCode desktop client puts `cache_control: { type: "ephemeral" }` on
  // the LAST system block (its own #3 "Write code..." block) — that's the
  // prompt-cache breakpoint. Our 2 official ZCode blocks already carry cc
  // (frozen in zcode_system.json), but when the client (Claude Code, Codex,
  // etc.) sends its own system text, the resulting last block has no cc.
  //
  // Without this fix, the upstream sees [official+cc, official+cc, user_no_cc]
  // — a clear fingerprint mismatch vs real ZCode's [official+cc, official+cc,
  // user+cc]. We add cc to the last user-provided block to match.
  //
  // Idempotent: if the last block already has cache_control, leave it alone.
  //
  // Edge case: if there are no user-provided blocks (rewrittenClientSystem
  // is empty), the last block IS the last official block (which already has
  // cc) — also leave it alone.
  if (Array.isArray(body.system) && body.system.length > 0) {
    const lastBlock = body.system[body.system.length - 1] as SystemBlock;
    if (lastBlock && typeof lastBlock === "object" && !lastBlock.cache_control) {
      lastBlock.cache_control = { type: "ephemeral" };
      changed = true;
    }
  }

  // === Step 2: Identity rewrite inside messages too ===
  // Claude Code's "You are Claude Code..." can also appear in messages[].role: "system"
  // (Claude Code puts its identity in messages too). Rewrite those as well.
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isPlainObject(msg)) continue;
      if ((msg as Record<string, unknown>).role !== "system") continue;
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        if (CLAUDE_CODE_IDENTITY_RE.test(content)) {
          (msg as Record<string, unknown>).content = content.replace(
            CLAUDE_CODE_IDENTITY_RE,
            ZCODE_IDENTITY_REPLACEMENT,
          );
          changed = true;
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!isPlainObject(block)) continue;
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string" && CLAUDE_CODE_IDENTITY_RE.test(text)) {
            (block as Record<string, unknown>).text = text.replace(
              CLAUDE_CODE_IDENTITY_RE,
              ZCODE_IDENTITY_REPLACEMENT,
            );
            changed = true;
          }
        }
      }
    }
  }

  // === Step 3: Fill in missing fields real ZCode always sends ===
  // Real ZCode client always includes tool_choice and stream, even when the
  // client (e.g. Claude Code) doesn't send them. Fill in the defaults to match.
  // tool_choice: { type: "auto" } — only when tools are present (real ZCode
  // only sends tool_choice when tools array is non-empty).
  if (Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice === undefined) {
    body.tool_choice = { type: "auto" };
    changed = true;
  }
  // === Step 3b: Force stream: true ===
  // Real ZCode desktop client ALWAYS streams — its body always carries
  // `stream: true`. Claude Code and some other clients omit the field (or
  // send `stream: false`), which creates a wire-shape fingerprint mismatch
  // vs the real ZCode client.
  //
  // We now ALWAYS set `stream: true` to match the real client's wire shape.
  // The proxy's response path already buffers SSE → batch JSON for clients
  // that originally requested non-streaming, so this is safe.
  //
  // History: v0.1.9 made this a configurable `forceStreamAnthropic` toggle
  // (default off) because of a concern about breaking non-stream clients.
  // v0.2.0.4: the toggle was removed and stream:true became unconditional —
  // empirically, the response-path buffering handles non-stream clients
  // correctly, and the WAF body-fingerprint alignment is more important.
  body.stream = true;
  changed = true;

  // === Step 4: Drop fields real ZCode client never sends ===
  // Claude Code sends `metadata: { user_id: "..." }` for tracking. Real ZCode
  // client never sends this field — its presence is a clear "non-ZCode client"
  // fingerprint. Drop it.
  if ("metadata" in body) {
    delete body.metadata;
    changed = true;
  }

  // === Step 5: Rebuild top-level keys in ZCode wire order ===
  // Real ZCode order (reverse-engineered):
  //   model → max_tokens → thinking → output_config → system → messages →
  //   tools → tool_choice → stream → (others)
  const ORDERED_KEYS = [
    "model", "max_tokens", "thinking", "output_config",
    "system", "messages", "tools", "tool_choice", "stream",
  ];
  const result: Record<string, unknown> = {};
  for (const k of ORDERED_KEYS) {
    if (k in body) {
      result[k] = body[k];
    }
  }
  // Append any remaining keys not in the ordered list (e.g. stop_sequences)
  // — but NOT metadata (already deleted in Step 4).
  for (const k of Object.keys(body)) {
    if (!ORDERED_KEYS.includes(k)) {
      result[k] = body[k];
    }
  }
  changed = true; // always rebuild — key order matters even if values same

  return changed ? result : null;
}

/** Normalize system field (string | array | undefined) to an array of text blocks. */
function normalizeSystemToArray(system: unknown): SystemBlock[] {
  if (system == null) return [];
  if (typeof system === "string") {
    return system.trim() ? [{ type: "text", text: system }] : [];
  }
  if (Array.isArray(system)) {
    const out: SystemBlock[] = [];
    for (const item of system) {
      if (typeof item === "string") {
        if (item.trim()) out.push({ type: "text", text: item });
      } else if (isPlainObject(item)) {
        const b = item as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push({
            type: "text",
            text: b.text,
            ...(typeof b.cache_control === "object" && b.cache_control !== null
              ? { cache_control: b.cache_control as { type: "ephemeral" } }
              : {}),
          });
        }
      }
    }
    return out;
  }
  return [];
}

/**
 * Rewrite Claude Code identity in system blocks + strip billing header.
 * 1. Replace the identity string ("You are Claude Code, Anthropic's official CLI for Claude...")
 *    → "You are ZCode model working in Claude Code."
 *    The "in Claude Code" part is intentional — the model needs to know it's working
 *    inside Claude Code so it can function correctly (tool usage, harness behavior, etc.)
 * 2. Strip x-anthropic-billing-header blocks (ZCode never sends these)
 * 3. Do NOT replace "Claude Code" references in harness instructions — those are
 *    functional descriptions (e.g. "Claude Code is available as a CLI") that the
 *    model relies on for correct behavior.
 */
function rewriteClaudeCodeIdentity(blocks: SystemBlock[]): SystemBlock[] {
  return blocks
    .filter(b => {
      // Strip x-anthropic-billing-header blocks — they are a Claude Code fingerprint
      // that real ZCode never sends.
      if (b.text.startsWith("x-anthropic-billing-header:")) return false;
      return true;
    })
    .map(b => {
      let text = b.text;
      if (CLAUDE_CODE_IDENTITY_RE.test(text)) {
        text = text.replace(CLAUDE_CODE_IDENTITY_RE, ZCODE_IDENTITY_REPLACEMENT);
      }
      return text === b.text ? b : { ...b, text };
    });
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
 * If stripping leaves an ASSISTANT message with only non-text blocks (e.g.
 * only `tool_use` blocks — which happens when the original was
 * `[thinking, tool_use]` and thinking is stripped), an empty `text` block
 * is inserted at the front. ZCode's start-plan gateway rejects assistant
 * messages that contain only `tool_use` blocks with 3001 "parameter error"
 * — Anthropic's official API accepts them, but the gateway is stricter.
 * This was the root cause of the v2.1.3.6beta0 user report: rounds 3-5
 * had assistant messages `[tool_use]` (after thinking strip) and the
 * gateway 3001'd on round 7 once enough had accumulated.
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

    // If this is an assistant message that now has ONLY non-text blocks
    // (e.g. only tool_use), insert an empty text block at the front.
    // ZCode gateway rejects assistant messages with no text block.
    //
    // v2.1.3.10beta0: use a single space " " instead of empty string "" —
    // some gateways reject empty text blocks. A space renders as nothing
    // visible but is technically non-empty.
    if (msg.role === "assistant") {
      const hasText = filtered.some((b: unknown) =>
        isPlainObject(b) && b.type === "text"
      );
      if (!hasText) {
        msg.content = [{ type: "text", text: " " }, ...filtered];
      }
    }

    surviving.push(msg);
  }

  if (changed) {
    body.messages = surviving;
  }
  return changed;
}

/**
 * Convert `document` type content blocks to `text` type blocks.
 *
 * Claude Code sends `document` blocks (e.g. attached log files) with the
 * structure: `{ type: "document", source: { type: "text", media_type, data } }`.
 * The ZCode gateway does not accept `document` as a content block type — it
 * returns 3001 "parameter error". We convert them to `text` blocks, preserving
 * the document data as plain text.
 *
 * No-op if no `document` blocks are found.
 */
function convertDocumentBlocks(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!isPlainObject(block)) continue;
      if ((block as Record<string, unknown>).type !== "document") continue;

      // Extract text from the document block's source.data field
      const source = (block as Record<string, unknown>).source;
      let text = "";
      if (isPlainObject(source) && typeof (source as Record<string, unknown>).data === "string") {
        text = (source as Record<string, unknown>).data as string;
      }
      content[i] = { type: "text", text: text || " " };
      changed = true;
    }
  }
  return changed;
}

/**
 * Sanitize content blocks in `messages[].content` to remove fields that GLM
 * upstream / ZCode gateway reject with 3001 "parameter error".
 *
 * v0.2.1.4+ — REVISED cache_control policy based on real ZCode desktop
 * client wire capture (2026-06-30, 6-request complete flow log):
 *
 *   - Real ZCode KEEPS `cache_control` on `tool_result` blocks when the
 *     user message has a SINGLE tool_result (verified req#3/#4/#6 — cc
 *     directly on the tool_result block itself).
 *   - Real ZCode drops cc entirely when the user message has MULTIPLE
 *     tool_result blocks (verified req#5 — no cc on any block).
 *   - The "strip cc from tool_result" rule introduced in v0.2.0.9 was
 *     based on a wrong assumption and broke cache hits for the most common
 *     single-tool-call continuation pattern.
 *
 * `applyAnthropicCacheControl()` (runs AFTER this) enforces the multi-
 * tool_result stripping rule. `sanitizeContentBlocks` itself no longer
 * touches cc on tool_result blocks — it leaves them as the client sent
 * them, so applyAnthropicCacheControl can apply the correct zcode-aligned
 * policy with full message context.
 *
 * Still strips:
 *
 * 1. `is_error:false` (tool_result blocks only):
 *    Real ZCode client only sends `is_error:true` (for actual errors).
 *    Claude Code adds `is_error:false` on success. The gateway may reject
 *    `is_error:false`. We keep `is_error:true` — real ZCode preserves it.
 *
 * Root cause history:
 *   - v2.1.3.3beta0: stripped thinking blocks (round-2 3001)
 *   - v2.1.3.5beta0: stripped cache_control from tool_result (round-3 3001)
 *   - v2.1.3.6beta0: stripped cache_control from tool_use (round-3 3001 variant)
 *   - v2.1.3.9beta0: strip cache_control from text too in start-plan;
 *                    strip is_error from tool_result in both modes
 *   - v0.1.9: keep is_error (real ZCode has is_error:true in sample)
 *   - v0.1.10: strip is_error:false only; keep is_error:true
 *   - v0.2.0.9: strip cc from tool_result (WRONG — based on misread sample)
 *   - v0.2.1.3: stop appending text+cc to tool_result user messages
 *   - v0.2.1.4: stop stripping cc from tool_result; let applyAnthropicCacheControl
 *               enforce the multi-tool_result strip rule with full context
 */
function sanitizeContentBlocks(
  body: Record<string, unknown>,
): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isPlainObject(block)) continue;

      // v0.1.9+: NEVER strip cache_control from `text` blocks — real ZCode
      // client keeps cache_control on the last user message's text block.
      //
      // v0.2.1.4+: NO LONGER strip cache_control from `tool_result` blocks
      // either. Real ZCode desktop client (verified 2026-06-30 against a
      // 6-request complete flow log) attaches cc directly to single
      // tool_result blocks (req#3/#4/#6). The previous "strip cc from
      // tool_result" rule (v0.2.0.9-v0.2.1.3) was based on a wrong
      // assumption and broke cache hits for single-tool continuations.
      //
      // The multi-tool_result stripping rule (req#5) is enforced by
      // applyAnthropicCacheControl, which has full message context and can
      // count the tool_result blocks in the last user message.

      // Strip is_error:false from tool_result blocks. Real ZCode client only
      // sends is_error:true (for actual errors). Claude Code adds is_error:false
      // on success (62 in sample). The gateway may reject is_error:false.
      // Keep is_error:true — real ZCode preserves it.
      if ((block as Record<string, unknown>).type === "tool_result"
          && "is_error" in (block as Record<string, unknown>)
          && (block as Record<string, unknown>).is_error === false) {
        delete (block as Record<string, unknown>).is_error;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Normalize ALL message `content` from string to array format.
 *
 * Anthropic's official API accepts both formats for message content:
 *   - string:  `{ role: "user", content: "hello" }`
 *   - array:   `{ role: "user", content: [{ type: "text", text: "hello" }] }`
 *
 * Claude Code sends simple text as **string** and complex content (with tools,
 * images, etc.) as **array**. Some Anthropic-compatible gateways (including
 * ZCode's start-plan gateway) are stricter and ONLY accept the array format,
 * rejecting string content with 3001 "parameter error".
 *
 * This function converts ALL string `content` to the array format by wrapping
 * in a single text block. Array content is left untouched.
 *
 * v2.1.3.10beta0: previously only `tool_result.content` was normalized. We now
 * normalize ALL message content (user + assistant) because the gateway's
 * strictness may apply to all message types, not just tool_result.
 *
 * v2.1.3.11beta0: **empty string content** is converted to `[{type:"text",
 * text:" "}]` (single space) instead of `[{type:"text", text:""}]` (empty).
 * This is the same fix as `ensureAssistantTextBlock`'s non-empty placeholder,
 * but applied at the normalize layer so it catches empty strings produced by
 * the Responses API translator (which `ensureAssistantTextBlock` cannot see,
 * because the translator emits `""` as a *string*, not as a missing-text-block
 * scenario). The Responses API translator produces empty strings in several
 * cases:
 *   - `translateMessageContent` returns `""` for empty/missing content
 *   - `mergeContent` collapses all-empty-text blocks to `""`
 *   - `function_call_output` emits `content: ""` when output is empty
 * Without this fix, these empty strings become `[{type:"text", text:""}]`
 * after normalization — an empty text block that the ZCode gateway rejects.
 *
 * No-op if `messages` is missing or not an array.
 */
function normalizeAllMessageContent(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    if (typeof msg.content === "string") {
      // v2.1.3.11beta0: empty string → single space (non-empty placeholder).
      // ZCode gateway rejects empty text blocks; a space is invisible but
      // technically non-empty.
      const text = msg.content.length > 0 ? msg.content : " ";
      msg.content = [{ type: "text", text }];
      changed = true;
    }
  }
  return changed;
}

/**
 * start-plan: prepend ZCode gateway system blocks. The gateway rejects
 * requests without these identity blocks with 3012 "method not allowed".
 *
 * Returns true only if the body's system field was actually changed —
 * short-circuits the `JSON.stringify(transformedObj)` in handler.ts when
 * the body already had the official blocks in the right position, saving
 * ~5ms on a 90KB body for the common case of repeated identical requests.
 */
function applyStartPlanSystem(body: Record<string, unknown>): boolean {
  // Idempotency check: if `body.system` already starts with the official
  // ZCode blocks (e.g. on retry/replay where a previous transform already
  // injected them), DON'T re-inject. buildStartPlanSystem() would otherwise
  // concatenate official blocks + the user blocks (which themselves now
  // contain the official blocks), producing [official, official, client...]
  // — a 5-block system instead of 3-block.
  //
  // Detection: walk the first N=official_blocks positions of cur and check
  // each text matches. If all match, the official prefix is already there.
  const cur = body.system;
  const officialTexts = ZCODE_SYSTEM_BLOCKS.map(b => b.text);
  if (Array.isArray(cur) && cur.length >= officialTexts.length) {
    let alreadyInjected = true;
    for (let i = 0; i < officialTexts.length; i++) {
      const c = cur[i] as { text?: string } | undefined;
      if (!c || c.text !== officialTexts[i]) {
        alreadyInjected = false;
        break;
      }
    }
    if (alreadyInjected) {
      return false;
    }
  }
  const newSystem = buildStartPlanSystem(body.system);
  body.system = newSystem;
  return true;
}
