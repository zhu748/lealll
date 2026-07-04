/**
 * Anthropic SSE → batch Message JSON reassembler.
 *
 * Used when the proxy forces `stream: true` to upstream (to align with the
 * real ZCode desktop client's wire shape) but the original client requested
 * non-streaming (no `stream: true` in their request body). In that case the
 * upstream returns SSE, but the client expects a single batch JSON response.
 * This module buffers the SSE stream and reassembles it into a complete
 * Anthropic Message object.
 *
 * Handles all standard Anthropic SSE event types:
 *   - message_start        — initial message fields (id, model, usage)
 *   - content_block_start  — opens a new content block (text / tool_use / etc.)
 *   - content_block_delta  — appends to current block (text_delta / input_json_delta)
 *   - content_block_stop   — closes current block (finalizes tool_use input JSON)
 *   - message_delta        — updates stop_reason + final usage
 *   - message_stop         — end of message
 *   - ping                 — keepalive, ignored
 *   - error                — returns error result
 *
 * Tolerant of upstreams that omit `content_block_start` (some GLM impls do) —
 * a `content_block_delta` without a prior start auto-creates a text block at
 * the delta's index.
 *
 * @see _reverse/NOTEPAD.md "Anthropic SSE Event Reference"
 */
import type { AnthropicMessagesResponse } from "../translator/types.js";
import { SSE as SSE_CONST } from "../utils/constants.js";

export interface SseToBatchSuccess {
  message: AnthropicMessagesResponse;
  outputTokens: number;
  inputTokens: number;
}

export interface SseToBatchError {
  error: string;
}

export type SseToBatchResult = SseToBatchSuccess | SseToBatchError;

export interface SseToBatchOptions {
  /** Maximum raw SSE bytes to consume while rebuilding a batch response. */
  maxBytes?: number;
  /** Maximum UTF-8 bytes to keep for one unfinished SSE event. */
  maxBufferedEventBytes?: number;
  /** Maximum content block index accepted from upstream events. */
  maxContentBlockIndex?: number;
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/**
 * Consume an Anthropic SSE stream and return a complete Anthropic Message
 * object. The stream is fully consumed before returning (no streaming to
 * caller — this is by design, the caller wants a batch response).
 *
 * @param body The upstream SSE stream
 * @param fallbackModel Used if `message_start.message.model` is missing
 */
export async function anthropicSseToBatchMessage(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  options: SseToBatchOptions = {},
): Promise<SseToBatchResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const maxBytes = normalizePositiveLimit(options.maxBytes, SSE_CONST.MAX_TO_BATCH_BYTES);
  const maxBufferedEventBytes = normalizePositiveLimit(options.maxBufferedEventBytes, SSE_CONST.MAX_TO_BATCH_BUFFERED_EVENT_BYTES);
  const maxContentBlockIndex = normalizePositiveLimit(options.maxContentBlockIndex, SSE_CONST.MAX_TO_BATCH_CONTENT_BLOCK_INDEX);

  // The Message we're building up. Initialized with sensible defaults so the
  // result is well-formed even if message_start is missing.
  const message: AnthropicMessagesResponse = {
    id: "",
    type: "message",
    role: "assistant",
    model: fallbackModel,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  // Per-block accumulator for tool_use input_json_delta (partial JSON strings
  // need to be concatenated then JSON.parsed on content_block_stop).
  const partialJsonByIndex = new Map<number, string>();

  let outputTokens = 0;
  let inputTokens = 0;
  let totalBytes = 0;

  const applyEventString = (eventStr: string): string | undefined => {
    // Parse the SSE event — extract `data:` lines, ignore `event:`/`id:`/etc.
    // Anthropic's wire format puts the type inside the JSON `data` payload,
    // not in the SSE `event:` field, so we only need `data:`.
    const dataStr = extractSseData(eventStr);
    if (!dataStr || dataStr === "[DONE]") return undefined;

    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      // Malformed JSON in a data event — skip this event, keep processing.
      // Don't fail the whole reassembly over one bad event.
      return undefined;
    }

    const result = handleEvent(data, message, partialJsonByIndex, maxContentBlockIndex);
    if (result.usage) {
      if (typeof result.usage.output_tokens === "number") {
        outputTokens = result.usage.output_tokens;
        (message.usage as any).output_tokens = result.usage.output_tokens;
      }
      if (typeof result.usage.input_tokens === "number") {
        inputTokens = result.usage.input_tokens;
        (message.usage as any).input_tokens = result.usage.input_tokens;
      }
      // v0.2.0.6: preserve cache_read_input_tokens / cache_creation_input_tokens
      // in the rebuilt message.usage so the downstream batch path can extract
      // them for the dashboard row. Without this, cache tokens are lost when
      // we buffer SSE → batch JSON for non-stream clients.
      if (typeof result.usage.cache_read_input_tokens === "number") {
        (message.usage as any).cache_read_input_tokens = result.usage.cache_read_input_tokens;
      }
      if (typeof result.usage.cache_creation_input_tokens === "number") {
        (message.usage as any).cache_creation_input_tokens = result.usage.cache_creation_input_tokens;
      }
    }
    return result.error;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { error: `SSE->batch response exceeded ${maxBytes} byte limit` };
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.indexOf("\r") >= 0) {
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      }

      // Process complete SSE events (separated by \n\n)
      //
      // v0.2.2+ PERF: use a cursor instead of `buffer = buffer.slice(...)`
      // for each event. The previous form was O(N²) — every event slice
      // copied the remaining buffer. With a cursor, we only compact the
      // buffer once when the loop exits (to retain the unfinished tail).
      let cursor = 0;
      let eventEnd: number;
      while ((eventEnd = buffer.indexOf("\n\n", cursor)) !== -1) {
        const eventStr = buffer.slice(cursor, eventEnd);
        cursor = eventEnd + 2;

        const error = applyEventString(eventStr);
        if (error) {
          try { await reader.cancel(); } catch {}
          return { error };
        }
      }
      // Compact the buffer: keep only the unfinished tail (from cursor onward).
      // This is the only slice — one allocation per chunk instead of one per event.
      if (cursor > 0) {
        buffer = buffer.slice(cursor);
      }
      if (utf8ByteLength(buffer) > maxBufferedEventBytes) {
        try { await reader.cancel(); } catch {}
        return { error: `SSE->batch buffered event exceeded ${maxBufferedEventBytes} byte limit` };
      }
    }
    if (buffer.trim()) {
      if (utf8ByteLength(buffer) > maxBufferedEventBytes) {
        return { error: `SSE->batch buffered event exceeded ${maxBufferedEventBytes} byte limit` };
      }
      const error = applyEventString(buffer);
      if (error) return { error };
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Finalize any unfinished tool_use blocks — if upstream ended without
  // content_block_stop (rare but possible on network errors), try to parse
  // the accumulated partial JSON so the tool_use input isn't lost.
  for (const [idx, partial] of partialJsonByIndex) {
    const block = (message.content as any[])[idx];
    if (block && block.type === "tool_use" && typeof partial === "string") {
      try {
        block.input = JSON.parse(partial);
      } catch {
        // Leave whatever was set in content_block_start (usually {}) — better
        // than corrupting the structure with bad JSON.
      }
    }
  }

  // Sparse indexes are possible when an upstream skips an earlier block index
  // or emits deltas without content_block_start. Downstream translators expect
  // every content item to be an object with a `type`; compact placeholders so
  // a single null hole cannot turn a valid batch response into a 500.
  message.content = (message.content as any[]).filter(Boolean) as any;

  return { message, outputTokens, inputTokens };
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function extractSseData(eventStr: string): string | undefined {
  let data = "";
  let hasData = false;
  let lineStart = 0;

  for (;;) {
    const lineEnd = eventStr.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? eventStr.length : lineEnd;

    if (eventStr.startsWith("data:", lineStart)) {
      let valueStart = lineStart + 5;
      // Per SSE spec, strip one leading space after the colon.
      if (valueStart < end && eventStr.charCodeAt(valueStart) === 32) valueStart++;
      const value = eventStr.slice(valueStart, end);
      data = hasData ? `${data}\n${value}` : value;
      hasData = true;
    }

    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }

  return hasData ? data : undefined;
}

interface HandleEventResult {
  // v0.2.0.6: cache_read_input_tokens / cache_creation_input_tokens added
  // to preserve Anthropic prompt-caching usage info through SSE → batch.
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: string;
}

function handleEvent(
  data: any,
  message: AnthropicMessagesResponse,
  partialJsonByIndex: Map<number, string>,
  maxContentBlockIndex: number,
): HandleEventResult {
  const type = data?.type;
  const content = message.content as any[];

  switch (type) {
    case "message_start": {
      const msg = data.message;
      if (msg) {
        if (typeof msg.id === "string") message.id = msg.id;
        if (typeof msg.model === "string") message.model = msg.model;
        if (msg.usage) {
          // v0.2.0.6: forward cache token fields if present (message_start
          // sometimes carries them; the authoritative values come from the
          // later message_delta event, but we preserve these too).
          return {
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
            },
          };
        }
      }
      return {};
    }

    case "content_block_start": {
      const idx = parseContentBlockIndex(data.index, maxContentBlockIndex);
      if (!idx.ok) return { error: idx.error };
      const blockIndex = idx.value;
      const block = data.content_block;
      if (!block) return {};
      // Initialize the block. For text blocks, default text to "". For tool_use,
      // default input to {} (will be overwritten by partial JSON on stop).
      const newBlock: any = { ...block };
      if (newBlock.type === "text" && typeof newBlock.text !== "string") newBlock.text = "";
      if (newBlock.type === "tool_use" && typeof newBlock.input !== "object") newBlock.input = {};
      // Ensure array is long enough
      while (content.length <= blockIndex) content.push(null);
      content[blockIndex] = newBlock;
      return {};
    }

    case "content_block_delta": {
      const idx = parseContentBlockIndex(data.index, maxContentBlockIndex);
      if (!idx.ok) return { error: idx.error };
      const blockIndex = idx.value;
      const delta = data.delta;
      if (!delta) return {};

      // Auto-create a text block if content_block_start was missing (tolerant)
      while (content.length <= blockIndex) content.push(null);
      if (!content[blockIndex]) {
        content[blockIndex] = { type: "text", text: "" };
      }
      const block = content[blockIndex];

      if (delta.type === "text_delta") {
        if (typeof delta.text === "string") {
          block.text = (block.text ?? "") + delta.text;
        }
      } else if (delta.type === "input_json_delta") {
        if (typeof delta.partial_json === "string") {
          const prev = partialJsonByIndex.get(blockIndex) ?? "";
          partialJsonByIndex.set(blockIndex, prev + delta.partial_json);
        }
      } else if (delta.type === "thinking_delta") {
        // v0.2.0.7: reassemble thinking content. When thinking is enabled,
        // GLM streams thinking_delta events with partial thinking text in
        // `delta.thinking`. We concatenate into block.thinking so the
        // reassembled message preserves the full reasoning trace.
        // (Non-stream clients — those going through SSE→batch buffering —
        // should see the same thinking content as stream clients.)
        if (typeof delta.thinking === "string") {
          block.thinking = (block.thinking ?? "") + delta.thinking;
        }
      }
      // Other delta types (e.g. citations_delta, signature_delta) are not
      // reassembled — they're rare and not critical for non-stream clients.
      return {};
    }

    case "content_block_stop": {
      const idx = parseContentBlockIndex(data.index, maxContentBlockIndex);
      if (!idx.ok) return { error: idx.error };
      const blockIndex = idx.value;
      const partial = partialJsonByIndex.get(blockIndex);
      if (partial !== undefined) {
        const block = content[blockIndex];
        if (block && block.type === "tool_use") {
          try {
            block.input = JSON.parse(partial);
          } catch {
            // Leave the existing input (usually {}) — better than corrupting.
          }
        }
        partialJsonByIndex.delete(blockIndex);
      }
      return {};
    }

    case "message_delta": {
      const delta = data.delta;
      if (delta) {
        if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
          message.stop_reason = delta.stop_reason;
        }
        if (delta.stop_sequence !== undefined) {
          message.stop_sequence = delta.stop_sequence;
        }
      }
      // message_delta may carry final usage (output_tokens, input_tokens,
      // cache_read_input_tokens, cache_creation_input_tokens).
      // This is the AUTHORITATIVE source for cache token counts —
      // message_start carries placeholder 0/0 values.
      if (data.usage) {
        return {
          usage: {
            input_tokens: data.usage.input_tokens,
            output_tokens: data.usage.output_tokens,
            cache_read_input_tokens: data.usage.cache_read_input_tokens,
            cache_creation_input_tokens: data.usage.cache_creation_input_tokens,
          },
        };
      }
      return {};
    }

    case "message_stop": {
      // End of message — nothing to do, the function will return after this.
      return {};
    }

    case "ping": {
      // Keepalive — ignore.
      return {};
    }

    case "error": {
      // Upstream-reported error event. Format: { type: "error", error: { type, message } }
      const errMsg = data.error?.message ?? data.message ?? JSON.stringify(data);
      return { error: errMsg };
    }

    default: {
      // Unknown event type — ignore (forward compatibility).
      return {};
    }
  }
}

function parseContentBlockIndex(value: unknown, maxIndex: number): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maxIndex) {
    return { ok: false, error: `Invalid SSE content block index: ${String(value)} (max ${maxIndex})` };
  }
  return { ok: true, value };
}
