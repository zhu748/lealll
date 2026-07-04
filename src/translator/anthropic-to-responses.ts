/**
 * Anthropic Messages → OpenAI Responses translator.
 *
 * Translates both batch and streaming Anthropic responses into the Responses
 * API format consumed by Codex CLI and the openai-node SDK's `responses` API.
 *
 * Streaming event sequence emitted (matches OpenAI's official Responses API):
 *   1. response.created              (initial empty response)
 *   2. response.in_progress          (status update)
 *   3. For each text block:
 *        response.output_item.added        (message item, status=in_progress)
 *        response.content_part.added       (output_text part, empty)
 *        response.output_text.delta *      (text deltas)
 *        response.output_text.done         (final text)
 *        response.content_part.done        (part done)
 *        response.output_item.done         (item done, status=completed)
 *   4. For each tool_use block:
 *        response.output_item.added        (function_call item, status=in_progress)
 *        response.function_call_arguments.delta * (argument deltas)
 *        response.function_call_arguments.done    (final arguments)
 *        response.output_item.done         (item done, status=completed)
 *   5. response.completed            (final response with usage)
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 */
import type {
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  OpenAIResponse,
  ResponsesOutputItem,
} from "./types.js";
import { parseSSEChunk, waitForBackpressure } from "../utils/sse.js";
import { SSE as SSE_CONST } from "../utils/constants.js";

/** Default model name when upstream doesn't echo one back. */
const DEFAULT_MODEL = "glm-4.6";

export interface ResponsesTranslationOptions {
  /** Names of Responses API custom tools, for example Codex's apply_patch. */
  customToolNames?: Iterable<string>;
}

/** Generate a Responses-style id with the given prefix. */
function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;
}

/** Map Anthropic stop_reason → Responses status (incomplete vs completed). */
function mapStopReasonToStatus(stopReason: string | null | undefined): "completed" | "incomplete" {
  if (stopReason === "max_tokens") return "incomplete";
  return "completed";
}

function customToolNameSet(opts?: ResponsesTranslationOptions): Set<string> {
  return new Set(Array.from(opts?.customToolNames ?? [], name => name.toLowerCase()));
}

function isCustomToolName(customNames: Set<string>, name: unknown): name is string {
  return typeof name === "string" && customNames.has(name.toLowerCase());
}

function extractCustomToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.patch === "string") return obj.patch;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[keys[0]] === "string") {
      return obj[keys[0]] as string;
    }
  }
  return value == null ? "" : JSON.stringify(value);
}

function extractCustomToolInputFromJson(json: string): string {
  if (!json) return "";
  try {
    return extractCustomToolInput(JSON.parse(json));
  } catch {
    return json;
  }
}

/** Build the canonical Responses `output[]` array from an Anthropic response. */
export function buildResponsesOutput(
  resp: AnthropicMessagesResponse,
  opts?: ResponsesTranslationOptions,
): ResponsesOutputItem[] {
  const out: ResponsesOutputItem[] = [];
  const customNames = customToolNameSet(opts);
  for (const block of resp.content ?? []) {
    if (block.type === "text") {
      out.push({
        type: "message",
        id: genId("msg"),
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: (block as any).text ?? "",
          annotations: [],
        }],
      });
    } else if (block.type === "tool_use") {
      const name = (block as any).name;
      if (isCustomToolName(customNames, name)) {
        out.push({
          type: "custom_tool_call",
          id: genId("ctc"),
          call_id: (block as any).id,
          name,
          input: extractCustomToolInput((block as any).input),
          status: "completed",
        });
      } else {
        out.push({
          type: "function_call",
          id: genId("fc"),
          call_id: (block as any).id,
          name,
          arguments: JSON.stringify((block as any).input ?? {}),
          status: "completed",
        });
      }
    }
    // Skip thinking blocks — Codex CLI doesn't render them and GLM's reasoning
    // summary format is incompatible with the Responses `reasoning` item shape.
  }
  return out;
}

/** Translate a non-streaming Anthropic Messages response into a Responses response. */
export function translateResponseAnthropicToResponses(
  resp: AnthropicMessagesResponse,
  model: string = DEFAULT_MODEL,
  previousResponseId?: string | null,
  opts?: ResponsesTranslationOptions,
): OpenAIResponse {
  const output = buildResponsesOutput(resp, opts);
  const status = mapStopReasonToStatus(resp.stop_reason);
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  // v0.2.0.10: preserve cache_read_input_tokens from upstream Anthropic usage.
  // The proxy's stats observer (handler.ts observeStreamParseSse) reads this
  // from response.completed.response.usage so the dashboard shows
  // "in: N (c:M)". Without this, the Responses API batch path silently
  // dropped cache tokens when prompt caching was active.
  const cacheReadTokens = resp.usage?.cache_read_input_tokens ?? 0;
  // v0.2.0.10: thinking_delta events don't reach the batch translator (only
  // streaming), but the upstream Anthropic batch response may carry a
  // reasoning token count in usage.reasoning_tokens (GLM extension). If
  // present, forward it; otherwise we can't recover it from the batch body.
  const reasoningTokens = (resp.usage as any)?.reasoning_tokens ?? 0;

  return {
    id: genId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      // v0.2.0.10: forward as a top-level usage field too so the proxy
      // stats observer can pick it up (it reads j.response.usage.cache_read_input_tokens).
      // OpenAI clients ignore unknown usage fields, so this is safe.
      ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
    },
    previous_response_id: previousResponseId ?? null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  };
}

// ─────────────────────────────────────────────
// SSE streaming translator
// ─────────────────────────────────────────────

const SSE_DATA_PREFIX = "data: ";

interface ParsedSSE {
  event: string;
  data: unknown;
}

interface StreamState {
  responseId: string;
  model: string;
  createdAt: number;
  /** Anthropic messageId, used to seed our msg_ ids deterministically. */
  anthropicMessageId: string;
  inputTokens: number;
  outputTokens: number;
  /** v0.2.0.10: cache_read_input_tokens from upstream Anthropic usage. */
  cacheReadInputTokens: number;
  /** v0.2.0.10: thinking chunk count from thinking_delta events. */
  thinkingTokens: number;
  stopReason: string | null;
  /** Have we emitted response.created + response.in_progress yet? */
  headerSent: boolean;
  /** Index of the next output item to emit. */
  nextOutputIndex: number;
  /** Track open content block indices for the current Anthropic block. */
  currentBlockIndex: number | null;
  /** Anthropic content block index backing the currently open output item. */
  currentAnthropicBlockIndex: number | null;
  /** For text blocks: have we emitted the message item + content_part.added? */
  textItemOpened: boolean;
  /** For tool_use blocks: have we emitted the function_call item.added? */
  toolItemOpened: boolean;
  /** Current tool output item kind, preserving Codex custom tools. */
  currentToolKind: "function" | "custom" | null;
  /** Accumulated text for the current text block (for the .done event). */
  currentTextAccum: string;
  /** Accumulated JSON for the current tool_use block (for the .done event). */
  currentToolArgsAccum: string;
  /** Items we've emitted (for the final response.completed payload). */
  emittedItems: ResponsesOutputItem[];
  /** Whether response.completed has already been emitted. */
  completedSent: boolean;
  customToolNames: Set<string>;
}

function initState(model: string, opts?: ResponsesTranslationOptions): StreamState {
  return {
    responseId: genId("resp"),
    model,
    createdAt: Math.floor(Date.now() / 1000),
    anthropicMessageId: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    thinkingTokens: 0,
    stopReason: null,
    headerSent: false,
    nextOutputIndex: 0,
    currentBlockIndex: null,
    currentAnthropicBlockIndex: null,
    textItemOpened: false,
    toolItemOpened: false,
    currentToolKind: null,
    currentTextAccum: "",
    currentToolArgsAccum: "",
    emittedItems: [],
    completedSent: false,
    customToolNames: customToolNameSet(opts),
  };
}

function formatSSE(eventType: string, payload: unknown): string {
  return `event: ${eventType}\n${SSE_DATA_PREFIX}${JSON.stringify(payload)}\n\n`;
}

function parseStreamContentBlockIndex(value: unknown): number {
  const n = value ?? 0;
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > SSE_CONST.MAX_TO_BATCH_CONTENT_BLOCK_INDEX) {
    throw new Error(`Invalid SSE content block index: ${String(value)} (max ${SSE_CONST.MAX_TO_BATCH_CONTENT_BLOCK_INDEX})`);
  }
  return n as number;
}

function utf8ByteLength(encoder: TextEncoder, value: string): number {
  return encoder.encode(value).byteLength;
}

function buildResponseSnapshot(state: StreamState, status: OpenAIResponse["status"]): OpenAIResponse {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output: state.emittedItems,
    usage: {
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      total_tokens: state.inputTokens + state.outputTokens,
      // v0.2.0.10: use the real thinking token count instead of a hardcoded 0.
      // The proxy stats observer reads response.usage.output_tokens_details.reasoning_tokens
      // for the "(th:M)" indicator.
      output_tokens_details: { reasoning_tokens: state.thinkingTokens },
      // v0.2.0.10: forward cache_read_input_tokens so the proxy can show
      // "in: N (c:M)". OpenAI clients ignore unknown usage fields.
      ...(state.cacheReadInputTokens > 0 ? { cache_read_input_tokens: state.cacheReadInputTokens } : {}),
    },
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  };
}

function emitHeaderIfNeeded(state: StreamState): string[] {
  if (state.headerSent) return [];
  state.headerSent = true;
  const out: string[] = [];
  out.push(formatSSE("response.created", {
    type: "response.created",
    response: buildResponseSnapshot(state, "in_progress"),
  }));
  out.push(formatSSE("response.in_progress", {
    type: "response.in_progress",
    response: buildResponseSnapshot(state, "in_progress"),
  }));
  return out;
}

function openTextItem(state: StreamState, anthropicBlockIndex: number = 0): string[] {
  const out: string[] = [];
  const outputIndex = state.nextOutputIndex;
  const msgId = genId("msg");
  const item: ResponsesOutputItem = {
    type: "message",
    id: msgId,
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  out.push(formatSSE("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item,
  }));
  out.push(formatSSE("response.content_part.added", {
    type: "response.content_part.added",
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  }));
  // Track this item so we can close it later. We'll mutate its content when closing.
  state.emittedItems.push(item);
  state.currentBlockIndex = outputIndex;
  state.currentAnthropicBlockIndex = anthropicBlockIndex;
  state.textItemOpened = true;
  state.currentTextAccum = "";
  return out;
}

function closeTextItem(state: StreamState): string[] {
  if (!state.textItemOpened) return [];
  const out: string[] = [];
  const outputIndex = state.currentBlockIndex!;
  const finalText = state.currentTextAccum;
  out.push(formatSSE("response.output_text.done", {
    type: "response.output_text.done",
    output_index: outputIndex,
    content_index: 0,
    text: finalText,
  }));
  out.push(formatSSE("response.content_part.done", {
    type: "response.content_part.done",
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: finalText, annotations: [] },
  }));
  // Replace the in_progress item with a completed one carrying the final text.
  const itemRef = state.emittedItems[outputIndex] as Extract<ResponsesOutputItem, { type: "message" }>;
  itemRef.status = "completed";
  itemRef.content = [{ type: "output_text", text: finalText, annotations: [] }];
  out.push(formatSSE("response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: itemRef,
  }));
  state.nextOutputIndex++;
  state.textItemOpened = false;
  state.currentTextAccum = "";
  state.currentBlockIndex = null;
  state.currentAnthropicBlockIndex = null;
  return out;
}

function openToolItem(state: StreamState, block: { id: string; name: string }, anthropicBlockIndex: number = 0): string[] {
  const out: string[] = [];
  const outputIndex = state.nextOutputIndex;
  const isCustom = isCustomToolName(state.customToolNames, block.name);
  const item: ResponsesOutputItem = isCustom
    ? {
      type: "custom_tool_call",
      id: genId("ctc"),
      call_id: block.id,
      name: block.name,
      input: "",
      status: "in_progress",
    }
    : {
      type: "function_call",
      id: genId("fc"),
      call_id: block.id,
      name: block.name,
      arguments: "",
      status: "in_progress",
    };
  out.push(formatSSE("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item,
  }));
  state.emittedItems.push(item);
  state.currentBlockIndex = outputIndex;
  state.currentAnthropicBlockIndex = anthropicBlockIndex;
  state.toolItemOpened = true;
  state.currentToolKind = isCustom ? "custom" : "function";
  state.currentToolArgsAccum = "";
  return out;
}

function closeToolItem(state: StreamState): string[] {
  if (!state.toolItemOpened) return [];
  const out: string[] = [];
  const outputIndex = state.currentBlockIndex!;
  const finalArgs = state.currentToolArgsAccum;
  const itemRef = state.emittedItems[outputIndex];
  if (state.currentToolKind === "custom" && itemRef?.type === "custom_tool_call") {
    const finalInput = extractCustomToolInputFromJson(finalArgs);
    if (finalInput.length > 0) {
      out.push(formatSSE("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        output_index: outputIndex,
        item_id: itemRef.id,
        delta: finalInput,
      }));
    }
    out.push(formatSSE("response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      output_index: outputIndex,
      item_id: itemRef.id,
      input: finalInput,
    }));
    itemRef.input = finalInput;
    itemRef.status = "completed";
  } else {
    out.push(formatSSE("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      arguments: finalArgs,
    }));
    const functionItem = itemRef as Extract<ResponsesOutputItem, { type: "function_call" }>;
    functionItem.arguments = finalArgs;
    functionItem.status = "completed";
  }
  out.push(formatSSE("response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: itemRef,
  }));
  state.nextOutputIndex++;
  state.toolItemOpened = false;
  state.currentToolKind = null;
  state.currentToolArgsAccum = "";
  state.currentBlockIndex = null;
  state.currentAnthropicBlockIndex = null;
  return out;
}

function hasPartialResponse(state: StreamState): boolean {
  return state.headerSent
    || state.emittedItems.length > 0
    || state.textItemOpened
    || state.toolItemOpened
    || state.stopReason !== null;
}

function emitResponseCompleted(state: StreamState): string[] {
  if (state.completedSent) return [];
  const out: string[] = [];
  if (state.textItemOpened) out.push(...closeTextItem(state));
  if (state.toolItemOpened) out.push(...closeToolItem(state));
  if (!state.headerSent) out.push(...emitHeaderIfNeeded(state));
  const status = mapStopReasonToStatus(state.stopReason);
  out.push(formatSSE("response.completed", {
    type: "response.completed",
    response: buildResponseSnapshot(state, status),
  }));
  state.completedSent = true;
  return out;
}

function translateStreamEvent(state: StreamState, sse: ParsedSSE): string[] {
  const data = sse.data as AnthropicStreamEvent;
  const out: string[] = [];

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.anthropicMessageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      state.inputTokens = msg?.usage?.input_tokens ?? 0;
      // v0.2.0.10: preserve cache_read_input_tokens from upstream. The
      // authoritative value usually arrives in message_delta, but
      // message_start sometimes carries it too.
      state.cacheReadInputTokens = msg?.usage?.cache_read_input_tokens ?? 0;
      // Emit response.created + response.in_progress
      out.push(...emitHeaderIfNeeded(state));
      return out;
    }

    case "content_block_start": {
      const block = (data as any).content_block;
      const idx = parseStreamContentBlockIndex((data as any).index);
      // Close any previously open output item before opening another. Normal
      // Anthropic streams send content_block_stop first; this is defensive for
      // malformed/interleaved streams.
      if (block?.type === "text") {
        if (state.textItemOpened) out.push(...closeTextItem(state));
        if (state.toolItemOpened) out.push(...closeToolItem(state));
        out.push(...openTextItem(state, idx));
      } else if (block?.type === "tool_use") {
        if (state.toolItemOpened) out.push(...closeToolItem(state));
        if (state.textItemOpened) out.push(...closeTextItem(state));
        out.push(...openToolItem(state, { id: block.id, name: block.name }, idx));
      } else {
        // thinking blocks etc. do not have a Responses output item, so they
        // must not mutate currentBlockIndex (that field is an output index).
      }
      return out;
    }

    case "content_block_delta": {
      const delta = (data as any).delta;
      const idx = parseStreamContentBlockIndex((data as any).index);
      if (delta?.type === "text_delta") {
        // Be tolerant of upstreams that omit content_block_start (some GLM
        // streams jump straight to deltas). Open a text item lazily here.
        if (!state.textItemOpened && !state.toolItemOpened) {
          out.push(...openTextItem(state, idx));
        }
        if (state.textItemOpened && state.currentAnthropicBlockIndex === idx) {
          state.currentTextAccum += delta.text ?? "";
          out.push(formatSSE("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: state.currentBlockIndex,
            content_index: 0,
            delta: delta.text ?? "",
          }));
        }
      } else if (delta?.type === "input_json_delta") {
        // Tool argument delta — content_block_start should have arrived first
        // with the tool_use block; if it didn't, we can't recover the tool
        // name/id, so silently drop.
        if (state.toolItemOpened && state.currentAnthropicBlockIndex === idx) {
          state.currentToolArgsAccum += delta.partial_json ?? "";
          if (state.currentToolKind !== "custom") {
            out.push(formatSSE("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              output_index: state.currentBlockIndex,
              delta: delta.partial_json ?? "",
            }));
          }
        }
      } else if (delta?.type === "thinking_delta") {
        // v0.2.0.10: count thinking_delta chunks so the final response.completed
        // usage can carry a real reasoning_tokens value. Codex CLI doesn't render
        // reasoning summaries (we skip thinking blocks in buildResponsesOutput),
        // but the proxy stats observer reads reasoning_tokens for the "(th:M)"
        // dashboard indicator. We don't emit any Responses API event for thinking
        // — the protocol has no standard streaming format for reasoning summaries
        // and emitting a non-standard one would break Codex.
        const t = delta?.thinking;
        if (typeof t === "string" && t.length > 0) state.thinkingTokens++;
      }
      return out;
    }

    case "content_block_stop": {
      const idx = parseStreamContentBlockIndex((data as any).index);
      if (state.currentAnthropicBlockIndex !== idx) return out;
      if (state.textItemOpened) out.push(...closeTextItem(state));
      else if (state.toolItemOpened) out.push(...closeToolItem(state));
      return out;
    }

    case "message_delta": {
      const dataAny = data as any;
      const delta = dataAny.delta;
      if (dataAny?.usage?.output_tokens !== undefined) {
        state.outputTokens = dataAny.usage.output_tokens;
      }
      // v0.2.0.10: message_delta is the AUTHORITATIVE source for cache_read_input_tokens.
      if (typeof dataAny?.usage?.cache_read_input_tokens === "number" && dataAny.usage.cache_read_input_tokens > 0) {
        state.cacheReadInputTokens = dataAny.usage.cache_read_input_tokens;
      }
      // v0.2.0.10: if upstream provides an authoritative reasoning_tokens count,
      // prefer it over our chunk count.
      if (typeof dataAny?.usage?.reasoning_tokens === "number" && dataAny.usage.reasoning_tokens > 0) {
        state.thinkingTokens = dataAny.usage.reasoning_tokens;
      }
      if (delta?.stop_reason) {
        state.stopReason = delta.stop_reason;
      }
      return out;
    }

    case "message_stop": {
      out.push(...emitResponseCompleted(state));
      return out;
    }

    case "ping":
    default:
      return out;
  }
}

/**
 * Transform an Anthropic SSE stream into Responses API SSE format.
 * Input: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 * Output: ReadableStream<Uint8Array> (Responses SSE bytes)
 */
export function anthropicSseToResponsesSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = DEFAULT_MODEL,
  opts?: ResponsesTranslationOptions,
): ReadableStream<Uint8Array> {
  const state = initState(model, opts);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let streamClosed = false;

  return new ReadableStream({
    async start(controller) {
      reader = upstream.getReader();
      const safeClose = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        try { controller.close(); } catch {}
      };
      const safeError = (err: unknown): void => {
        if (streamClosed) return;
        streamClosed = true;
        try { controller.error(err); } catch {}
      };
      const enqueueEncoded = async (line: string): Promise<boolean> => {
        if (cancelled || streamClosed) return false;
        await waitForBackpressure(controller);
        if (cancelled || streamClosed) return false;
        try {
          controller.enqueue(encoder.encode(line));
          return true;
        } catch (err) {
          streamClosed = true;
          if (!cancelled) throw err;
          return false;
        }
      };

      try {
        while (true) {
          if (cancelled || streamClosed) break;
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled || streamClosed) break;

          buffer += decoder.decode(value, { stream: true });
          if (buffer.indexOf("\r") >= 0) {
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          }

          let cursor = 0;
          let eventEnd: number;
          while ((eventEnd = buffer.indexOf("\n\n", cursor)) !== -1) {
            const block = buffer.slice(cursor, eventEnd);
            cursor = eventEnd + 2;
            if (utf8ByteLength(encoder, block) > SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES) {
              throw new Error(`SSE event exceeded ${SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES} byte limit`);
            }
            const parsed = parseSSEChunk(block);
            for (const p of parsed) {
              const output = translateStreamEvent(state, p);
              for (const line of output) {
                if (!(await enqueueEncoded(line))) return;
              }
            }
          }
          if (cursor > 0) {
            buffer = buffer.slice(cursor);
          }
          if (utf8ByteLength(encoder, buffer) > SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES) {
            throw new Error(`SSE buffered event exceeded ${SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES} byte limit`);
          }
        }

        if (cancelled) return;
        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSEChunk(buffer);
          for (const p of parsed) {
            const output = translateStreamEvent(state, p);
            for (const line of output) {
              if (!(await enqueueEncoded(line))) return;
            }
          }
        }

        // If upstream ended without message_stop (rare), still emit a terminal
        // response.completed for clients that wait for the Responses stream's
        // lifecycle event instead of only relying on EOF.
        if (!state.completedSent && hasPartialResponse(state)) {
          for (const line of emitResponseCompleted(state)) {
            if (!(await enqueueEncoded(line))) return;
          }
        }
      } catch (err) {
        if (!cancelled) {
          // Parser/translation failures mean this output stream is done; cancel
          // the upstream body too so a bad SSE event does not leave the fetch
          // body sitting unread until the server closes it.
          void reader?.cancel(err).catch(() => {});
          safeError(err);
        }
      } finally {
        safeClose();
        try { reader.releaseLock(); } catch {}
        reader = null;
      }
    },
    cancel(reason) {
      cancelled = true;
      streamClosed = true;
      void reader?.cancel(reason).catch(() => {});
    },
  });
}
