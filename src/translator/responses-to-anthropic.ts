/**
 * Responses API → Anthropic Messages request translator.
 *
 * Translates `POST /v1/responses` request bodies into Anthropic Messages
 * request bodies so they can be forwarded to GLM's anthropic-compatible
 * upstream. Handles:
 *   - input as string OR array of items (message / function_call / function_call_output / reasoning)
 *   - instructions → system
 *   - max_output_tokens → max_tokens
 *   - tools (only `type:"function"` forwarded; built-ins filtered out)
 *   - reasoning.effort → thinking enabled
 *   - previous_response_id → replay stored input+output before current input
 *
 * @see _reverse/NOTEPAD.md "Provider Endpoints"
 */
import type {
  OpenAIResponseRequest,
  ResponsesInputItem,
  ResponsesInputContentPart,
  ResponsesToolDefinition,
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicToolDefinition,
} from "./types.js";
import { getTurn } from "./responses-store.js";

const DEFAULT_MAX_TOKENS = 4096;

/** Options for translating a Responses request. */
export interface TranslateResponsesOptions {
  /**
   * Model ids (matched case-insensitively against `req.model`, which is the
   * *post-mapping* GLM model id) for which thinking should be force-enabled
   * even when the client did not send `reasoning.effort`.
   *
   * This exists because Codex CLI frequently sends `reasoning: null` in the
   * wire payload (the CLI only populates it when local config forces an
   * effort level). Without this override, the upstream GLM request goes out
   * without `thinking` and the model never actually reasons.
   */
  forceThinkingModels?: string[];
}

/** Translate an OpenAI Responses request into an Anthropic messages request. */
export function translateRequestResponsesToAnthropic(
  req: OpenAIResponseRequest,
  opts?: TranslateResponsesOptions,
): AnthropicMessagesRequest {
  // Flatten previous_response_id history + current input into a single input array.
  const inputItems = resolveInputItems(req);

  const systemParts: string[] = [];
  if (req.instructions) systemParts.push(req.instructions);

  const rawMessages: AnthropicMessage[] = [];

  for (const item of inputItems) {
    const translated = translateInputItem(item);
    if (!translated) continue;
    if (translated.kind === "system") {
      if (translated.text) systemParts.push(translated.text);
      continue;
    }
    rawMessages.push(translated.msg);
  }

  // Anthropic Messages API requires strictly alternating user/assistant roles.
  // Codex CLI frequently sends consecutive user messages (one per turn), so we
  // merge adjacent same-role messages into one. Content is merged by:
  //   - two strings → concatenated with "\n\n"
  //   - string + block[] / block[] + block[] → unified block array
  //   - empty content is skipped
  // Without this merge, GLM upstream returns 3001 "parameter error".
  const anthropicMessages: AnthropicMessage[] = [];
  for (const msg of rawMessages) {
    const last = anthropicMessages[anthropicMessages.length - 1];
    if (last && last.role === msg.role) {
      last.content = mergeContent(last.content, msg.content);
    } else {
      anthropicMessages.push({ ...msg });
    }
  }

  const result: AnthropicMessagesRequest = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };

  if (systemParts.length > 0) result.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stream !== undefined) result.stream = req.stream;
  if (req.stop) result.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  // Forward reasoning.effort → thinking enabled. Per user request, this is
  // unconditional: if the client sent `reasoning.effort`, we honor it.
  // If the model doesn't support thinking, GLM upstream will simply ignore
  // it (or the user can override by sending a different model). We don't
  // second-guess the client's intent.
  //
  // body-transformer.ts normalises any thinking field into GLM's accepted
  // `{type:"enabled"}` form before forwarding, so this is safe.
  //
  // --- Codex fallback ---
  // Codex CLI frequently sends `reasoning: null` even when the user enabled
  // reasoning in the CLI config (the wire payload only carries reasoning
  // when an explicit effort level is forced). To keep thinking actually
  // active for Codex users, we fall back to `opts.forceThinkingModels`:
  // if the post-mapping request model matches one of the configured ids,
  // we inject `thinking: {type:"enabled"}` even though the client didn't
  // ask for it. The operator opts in via the dashboard.
  const forceThinkingSet = opts?.forceThinkingModels && opts.forceThinkingModels.length > 0
    ? new Set(opts.forceThinkingModels.map(m => m.toLowerCase()))
    : null;
  const wantsThinking = (req.reasoning && req.reasoning.effort)
    || (forceThinkingSet !== null && typeof req.model === "string" && forceThinkingSet.has(req.model.toLowerCase()));
  if (wantsThinking) {
    result.thinking = { type: "enabled" };
  }

  // Filter to only function-type tools (local_shell, web_search etc. are built-in client-side)
  const functionTools = (req.tools ?? []).filter((t) => t && t.type === "function" && t.name);
  if (functionTools.length > 0) {
    result.tools = functionTools.map(translateToolResponsesToAnthropic);
  }

  if (req.tool_choice) {
    const tc = translateToolChoiceResponsesToAnthropic(req.tool_choice);
    if (tc) result.tool_choice = tc;
  }

  return result;
}

/** Resolve the effective input array, prepending previous_response_id history if present. */
function resolveInputItems(req: OpenAIResponseRequest): ResponsesInputItem[] {
  const currentInput = normalizeInput(req.input);

  if (!req.previous_response_id) return currentInput;

  const prev = getTurn(req.previous_response_id);
  if (!prev) {
    // Previous not found — either restarted proxy, or stale id from a different session.
    // Drop silently and proceed with current input only (better UX than 400).
    return currentInput;
  }

  const prevItems = [
    ...(prev.input as ResponsesInputItem[]),
    ...(prev.output as ResponsesInputItem[]),
  ];
  return [...prevItems, ...currentInput];
}

function normalizeInput(input: unknown): ResponsesInputItem[] {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: input }];
  }
  if (Array.isArray(input)) {
    return input as ResponsesInputItem[];
  }
  return [];
}

/** Merge two Anthropic message contents (string | block[]) into one. */
function mergeContent(
  a: string | AnthropicContentBlock[],
  b: string | AnthropicContentBlock[],
): string | AnthropicContentBlock[] {
  // Normalize both sides to block arrays, drop empty entries, then concat.
  const blocksA = toBlockArray(a);
  const blocksB = toBlockArray(b);
  const merged = [...blocksA, ...blocksB];

  // Optimization: if every block is text, collapse to a single string.
  if (merged.length > 0 && merged.every((b) => b.type === "text")) {
    const text = merged
      .map((b) => (b as { type: "text"; text: string }).text)
      .filter((t) => t.length > 0)
      .join("\n\n");
    return text;
  }
  return merged;
}

/** Coerce string|block[] to block[], dropping empty content. */
function toBlockArray(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.filter((b) => {
      if (b && b.type === "text") {
        const text = (b as { text?: string }).text;
        return typeof text === "string" && text.length > 0;
      }
      return Boolean(b);
    });
  }
  return [];
}

type TranslatedItem =
  | { kind: "system"; text: string }
  | { kind: "message"; msg: AnthropicMessage };

function translateInputItem(item: ResponsesInputItem): TranslatedItem | null {
  if (!item || typeof item !== "object") return null;

  switch (item.type) {
    case "message": {
      const role = item.role;
      if (role === "system" || role === "developer") {
        return { kind: "system", text: extractMessageText(item) };
      }
      const anthRole = role === "assistant" ? "assistant" : "user";
      const content = translateMessageContent(item);
      return { kind: "message", msg: { role: anthRole, content } };
    }

    case "function_call": {
      // Prior assistant tool call → Anthropic assistant message with tool_use block.
      // Use call_id as the tool_use id so the matching function_call_output can reference it.
      let inputObj: Record<string, unknown> = {};
      try {
        inputObj = JSON.parse(item.arguments || "{}");
      } catch { inputObj = {}; }
      const block: AnthropicContentBlock = {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: inputObj,
      };
      return { kind: "message", msg: { role: "assistant", content: [block] } };
    }

    case "function_call_output": {
      // Tool result → Anthropic user message with tool_result block.
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      };
      return { kind: "message", msg: { role: "user", content: [block] } };
    }

    case "reasoning": {
      // GLM doesn't accept reasoning items in input. If it has encrypted_content
      // we could pass it through as a system note, but for v1 we just drop it.
      return null;
    }

    default:
      return null;
  }
}

function extractMessageText(item: { content?: string | ResponsesInputContentPart[] }): string {
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

function translateMessageContent(item: { content?: string | ResponsesInputContentPart[] }): string | AnthropicContentBlock[] {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content) || item.content.length === 0) return "";

  // For text-only content, return a plain string (simpler, matches Anthropic idiom).
  const allText = item.content.every((c) => c.type === "input_text" || c.type === "output_text");
  if (allText) {
    return item.content.map((c) => c.text ?? "").join("");
  }

  // Mixed content with images: emit blocks.
  const blocks: AnthropicContentBlock[] = [];
  for (const c of item.content) {
    if (c.type === "input_text" || c.type === "output_text") {
      blocks.push({ type: "text", text: c.text ?? "" });
    } else if (c.type === "input_image" && c.image_url) {
      // Best-effort: pass URL as-is. GLM may or may not accept URL images; base64 data URIs work.
      const url = c.image_url;
      const dataUriMatch = url.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUriMatch) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: dataUriMatch[1], data: dataUriMatch[2] },
        });
      }
      // Non-data URIs skipped — would require fetching upstream, out of scope for v1.
    }
  }
  return blocks.length > 0 ? blocks : "";
}

function translateToolResponsesToAnthropic(tool: ResponsesToolDefinition): AnthropicToolDefinition {
  const out: AnthropicToolDefinition = { name: tool.name! };
  if (tool.description) out.description = tool.description;
  if (tool.parameters) out.input_schema = tool.parameters;
  return out;
}

function translateToolChoiceResponsesToAnthropic(
  tc: OpenAIResponseRequest["tool_choice"],
): { type: "auto" | "any" | "tool"; name?: string } | undefined {
  if (typeof tc === "string") {
    switch (tc) {
      case "auto": return { type: "auto" };
      case "required": return { type: "any" };
      case "none": return undefined; // Anthropic has no "none"; just drop tools instead
      default: return undefined;
    }
  }
  if (tc && typeof tc === "object") {
    if (tc.type === "function" && typeof (tc as any).name === "string") {
      return { type: "tool", name: (tc as any).name };
    }
  }
  return undefined;
}
