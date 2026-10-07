/**
 * SSE event translator — converts streaming events between OpenAI and Anthropic formats.
 * @see .omo/plans/zcode-proxy.md Task 12
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
import type { AnthropicStreamEvent, AnthropicUsage, OpenAIStreamChunk, OpenAIStreamToolCall, OpenAIUsage } from "./types.js";
import { openaiUsageToAnthropic } from "./anthropic-to-openai.js";
import { anthropicUsageToOpenAI } from "./openai-to-anthropic.js";
import { parseSSEChunk, parseSSEEvent } from "../utils/sse.js";
import { createBackpressuredStream } from "../utils/stream.js";
import { waitForBackpressure } from "../utils/sse.js";
import { SSEFramer } from "../utils/sse-framer.js";

// Re-export the shared spec-correct parser (multi-line `data:` fields joined,
// CRLF/CR normalized, `data:x` tolerated). Previously a second, lossier
// implementation lived here (last `data:` line won; multi-line fields dropped).
export { parseSSEChunk };

import type { ParsedSSE } from "../utils/sse.js";
export type { ParsedSSE } from "../utils/sse.js";

/**
 * Legacy public splitter, retained for external callers. Stream pumps use
 * SSEFramer for bounded incremental parsing and split/mixed line endings.
 */
export const SSE_FRAME_SPLIT = /\r\n\r\n|\n\n|\r\r/;

export interface TranslationState {
  messageId: string;
  model: string;
  roleSent: boolean;
  /** Running Anthropic usage snapshot; the upstream reports it incrementally. */
  usage: AnthropicUsage;
  toolCallIndex: number;
  blockIndexToToolCallIndex: Map<number, number>;
  finishReasonSent: boolean;
}

export function initState(model: string): TranslationState {
  return {
    messageId: "",
    model,
    roleSent: false,
    usage: { input_tokens: 0, output_tokens: 0 },
    toolCallIndex: 0,
    blockIndexToToolCallIndex: new Map(),
    finishReasonSent: false,
  };
}

/**
 * Fold an incremental usage report into the running snapshot, field by field.
 * Overwrite (not accumulate) semantics: the upstream re-reports absolute
 * totals, so a later 0 must win over an earlier non-zero, while a field the
 * event omits keeps its previous value.
 */
function mergeAnthropicUsage(target: AnthropicUsage, patch: Partial<AnthropicUsage> | undefined): void {
  if (!patch) return;
  if (patch.input_tokens != null) target.input_tokens = patch.input_tokens;
  if (patch.output_tokens != null) target.output_tokens = patch.output_tokens;
  if (patch.cache_read_input_tokens != null) target.cache_read_input_tokens = patch.cache_read_input_tokens;
  if (patch.cache_creation_input_tokens != null) target.cache_creation_input_tokens = patch.cache_creation_input_tokens;
}

function makeChunk(
  state: TranslationState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: OpenAIUsage,
): string {
  const chunk: OpenAIStreamChunk = {
    id: state.messageId || "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta: delta as any,
      finish_reason: finishReason as any,
    }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Transform an Anthropic SSE stream into OpenAI SSE format.
 * Input: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 * Output: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 */
export function anthropicSseToOpenaiSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const state = initState(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new SSEFramer();

  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return createBackpressuredStream({
    async start(controller) {
      if (cancelled) return;
      const reader = upstream.getReader();
      upstreamReader = reader;
      let errored = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) break;

          for (const block of framer.push(decoder.decode(value, { stream: true }))) {
            const parsed = parseSSEEvent(block);
            if (parsed) {
              const output = translateEvent(state, parsed);
              if (output) {
                // Backpressure: a slow client must not balloon the proxy's
                // stream buffer on long reasoning generations.
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(output));
              }
            }
          }
        }

        if (cancelled) return;
        for (const block of framer.finish(decoder.decode())) {
          const parsed = parseSSEEvent(block);
          if (parsed) {
            const output = translateEvent(state, parsed);
            if (output) {
              await waitForBackpressure(controller);
              controller.enqueue(encoder.encode(output));
            }
          }
        }

        // Emit [DONE]
        await waitForBackpressure(controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        errored = true;
        void reader.cancel(err).catch(() => {});
        // error()/close() 互斥:errored 流上再 close() 会抛 TypeError,进而触发 Bun 引擎空指针崩溃。
        try { controller.error(err); } catch {}
      } finally {
        if (!errored) {
          try { controller.close(); } catch {}
        }
        upstreamReader = undefined;
        reader.releaseLock();
      }
    },
    cancel(reason) { cancelled = true; void (upstreamReader ? upstreamReader.cancel(reason) : upstream.cancel(reason)).catch(() => {}); },
  });
}

/** An in-band Anthropic failure must not become a successful empty Chat stream. */
export class AnthropicStreamError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AnthropicStreamError";
  }
}

export function translateEvent(state: TranslationState, sse: ParsedSSE): string | null {
  const data = sse.data as AnthropicStreamEvent;

  if ((sse.data as { type?: string }).type === "error") {
    const error = (data as { error?: { type?: string; message?: string } }).error;
    throw new AnthropicStreamError(error?.type ?? "upstream_error", error?.message ?? "Anthropic upstream stream failed");
  }

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.messageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      mergeAnthropicUsage(state.usage, msg?.usage);
      if (!state.roleSent) {
        state.roleSent = true;
        return makeChunk(state, { role: "assistant" });
      }
      return null;
    }

    case "content_block_start": {
      if (data.type !== "content_block_start") return null;
      const block = data.content_block;
      const blockIdx = data.index;
      if (block.type === "tool_use") {
        const myIndex = state.toolCallIndex++;
        state.blockIndexToToolCallIndex.set(blockIdx, myIndex);
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        });
      }
      return null;
    }

    case "content_block_delta": {
      if (data.type !== "content_block_delta") return null;
      const delta = data.delta;
      const blockIdx = data.index;
      if (delta.type === "text_delta") {
        return makeChunk(state, { content: delta.text });
      }
      if (delta.type === "thinking_delta") {
        return makeChunk(state, { reasoning_content: delta.thinking });
      }
      if (delta.type === "signature_delta") {
        return null;
      }
      if (delta.type === "input_json_delta") {
        const myIndex = state.blockIndexToToolCallIndex.get(blockIdx);
        if (myIndex === undefined) return null;
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            function: { arguments: delta.partial_json ?? "" },
          }],
        });
      }
      return null;
    }

    case "message_delta": {
      // Fold usage in *before* the stop_reason branch: the upstream carries
      // both in the same event, and this is the only place the real input and
      // cache counts ever arrive. Usage that lands only *after* the finish
      // chunk was emitted updates the snapshot but is not re-announced — the
      // alternative is a trailing `choices: []` usage chunk, which some clients
      // index into blindly. No observed upstream orders the events that way.
      mergeAnthropicUsage(state.usage, data.usage);
      if (data.delta?.stop_reason && !state.finishReasonSent) {
        const finishReason = mapStopReason(data.delta.stop_reason);
        state.finishReasonSent = true;
        return makeChunk(state, {}, finishReason, anthropicUsageToOpenAI(state.usage));
      }
      return null;
    }

    case "message_stop": {
      if (state.finishReasonSent) return null;
      state.finishReasonSent = true;
      return makeChunk(state, {}, "stop", anthropicUsageToOpenAI(state.usage));
    }

    case "ping":
    case "content_block_stop":
      return null;

    default:
      return null;
  }
}

function mapStopReason(stopReason: string): string {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Transform an OpenAI SSE stream into Anthropic SSE format.
 * Input: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 * Output: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 */
export function openaiSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const framer = new SSEFramer();
  let messageStarted = false;
  let blockIndex = 0;
  let activeBlock: { type: "text" | "thinking"; index: number } | null = null;
  /** OpenAI tool_call index → Anthropic block state. */
  const toolBlocks = new Map<number, { index: number; id: string; name: string; started: boolean; pendingArgs: string }>();
  /** Anthropic block indices of started tool_use blocks, in open order. */
  const openToolBlockIndices: number[] = [];
  let outputTokens = 0;
  /** Latest upstream usage — OpenAI only emits it in the final chunk, so we
   *  accumulate and emit it once, deferred to end-of-stream. */
  let latestUsage: OpenAIUsage | undefined;
  /** Stop reason captured from the finish_reason chunk; held until we can pair
   *  it with the complete usage before emitting message_delta. */
  let pendingStopReason: string | null = null;
  let contentClosed = false;
  let messageDeltaSent = false;
  let messageStopped = false;
  const messageId = `msg_${Date.now()}`;

  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return createBackpressuredStream({
    async start(controller) {
      if (cancelled) return;
      const reader = upstream.getReader();
      upstreamReader = reader;
      let errored = false;

      // Every emit awaits backpressure first: a slow downstream client must
      // not balloon the proxy's stream buffer on long generations.
      const enqueueAnthropicEvent = async (eventType: string, data: unknown) => {
        await waitForBackpressure(controller);
        controller.enqueue(encoder.encode(formatAnthropicSSE(eventType, data)));
      };

      const closeActiveBlock = async () => {
        if (!activeBlock) return;
        await enqueueAnthropicEvent("content_block_stop", {
          type: "content_block_stop",
          index: activeBlock.index,
        });
        activeBlock = null;
      };

      const closeToolBlocks = async () => {
        for (const idx of openToolBlockIndices) {
          await enqueueAnthropicEvent("content_block_stop", {
            type: "content_block_stop",
            index: idx,
          });
        }
        openToolBlockIndices.length = 0;
      };

      const ensureActiveBlock = async (type: "text" | "thinking"): Promise<number> => {
        if (activeBlock?.type === type) return activeBlock.index;
        await closeActiveBlock();
        const index = blockIndex++;
        activeBlock = { type, index };
        await enqueueAnthropicEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: type === "text"
            ? { type: "text", text: "" }
            : { type: "thinking", thinking: "", signature: "" },
        });
        return index;
      };

      /**
       * Route OpenAI streaming tool_call deltas into Anthropic tool_use blocks.
       * OpenAI identifies each parallel call by `index`; we lazily allocate an
       * Anthropic block per index, emit `content_block_start` once id+name
       * arrive, then stream `input_json_delta` for each arguments fragment.
       * Arguments that arrive before id/name (non-standard ordering from some
       * compatible upstreams) are buffered into `pendingArgs` and flushed on
       * start, so the tool input is never silently truncated.
       */
      const handleToolCalls = async (toolCalls: OpenAIStreamToolCall[]) => {
        // Tool calls never share a block with text/thinking — close any open prose block first.
        await closeActiveBlock();
        for (const tc of toolCalls) {
          const idx = tc.index ?? 0;
          let state = toolBlocks.get(idx);
          if (!state) {
            state = { index: blockIndex++, id: "", name: "", started: false, pendingArgs: "" };
            toolBlocks.set(idx, state);
          }
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;

          if (!state.started && state.id && state.name) {
            state.started = true;
            await enqueueAnthropicEvent("content_block_start", {
              type: "content_block_start",
              index: state.index,
              content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
            });
            openToolBlockIndices.push(state.index);
            if (state.pendingArgs.length > 0) {
              await enqueueAnthropicEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: state.pendingArgs },
              });
              state.pendingArgs = "";
            }
          }

          const argsDelta = tc.function?.arguments;
          if (argsDelta) {
            if (state.started) {
              await enqueueAnthropicEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.index,
                delta: { type: "input_json_delta", partial_json: argsDelta },
              });
            } else {
              // id/name not yet seen — buffer until the block can open.
              state.pendingArgs += argsDelta;
            }
          }
        }
      };

      /**
       * Force-open any tool blocks that accumulated arguments (or a partial
       * id/name) but never crossed the id+name threshold before the stream
       * ended. Uses fallback id/name so the data is surfaced rather than
       * silently dropped. Mirrors cc-switch's "late tool starts" flush.
       */
      const startPendingToolBlocks = async () => {
        const lateStarts: Array<{ index: number; id: string; name: string; args: string }> = [];
        for (const [openaiIdx, state] of toolBlocks) {
          if (state.started) continue;
          if (!state.pendingArgs && !state.id && !state.name) continue;
          state.started = true;
          lateStarts.push({
            index: state.index,
            id: state.id || `tool_call_${openaiIdx}`,
            name: state.name || "unknown_tool",
            args: state.pendingArgs,
          });
          state.pendingArgs = "";
          openToolBlockIndices.push(state.index);
        }
        lateStarts.sort((a, b) => a.index - b.index);
        for (const ls of lateStarts) {
          await enqueueAnthropicEvent("content_block_start", {
            type: "content_block_start",
            index: ls.index,
            content_block: { type: "tool_use", id: ls.id, name: ls.name, input: {} },
          });
          if (ls.args.length > 0) {
            await enqueueAnthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: ls.index,
              delta: { type: "input_json_delta", partial_json: ls.args },
            });
          }
        }
      };

      /**
       * Close every open content block (text/thinking/tool_use). Idempotent via
       * the `contentClosed` flag so it is safe to call at both finish_reason
       * and end-of-stream. Split from `finalizeStream` so the finish_reason
       * chunk can close blocks *without* emitting message_delta — the usage
       * chunk arrives afterwards and must be folded in first.
       */
      const closeContent = async () => {
        if (contentClosed) return;
        contentClosed = true;
        await closeActiveBlock();
        await startPendingToolBlocks();
        await closeToolBlocks();
      };

      /**
       * Emit the terminal message_delta + message_stop. The message_delta
       * carries the full Anthropic usage (input + output + cache) derived from
       * the latest upstream usage snapshot. This is what lets Anthropic clients
       * see a non-zero input_tokens despite OpenAI only reporting usage in the
       * stream's final chunk — the delta is deferred until that chunk lands.
       */
      const finalizeStream = async () => {
        // Zero-data-frame stream (the gateway's silent quota-exhaustion 200
        // shape): message_start never fired. Emit a default message shell so
        // the event sequence stays spec-complete
        // (message_start → message_delta → message_stop) — strict Anthropic
        // SDKs fail on a stream that opens with message_delta.
        if (!messageStarted) {
          messageStarted = true;
          await enqueueAnthropicEvent("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model,
              stop_reason: null,
              stop_sequence: null,
              usage: openaiUsageToAnthropic(undefined),
            },
          });
        }
        await closeContent();
        if (!messageDeltaSent) {
          messageDeltaSent = true;
          const usage = openaiUsageToAnthropic(latestUsage);
          if (!latestUsage) usage.output_tokens = outputTokens;
          await enqueueAnthropicEvent("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: pendingStopReason ?? "end_turn",
              stop_sequence: null,
            },
            usage,
          });
        }
        if (!messageStopped) {
          messageStopped = true;
          await enqueueAnthropicEvent("message_stop", { type: "message_stop" });
        }
      };

      // Shared spec-correct parser: multi-line `data:` fields joined,
      // CRLF/CR normalized, `data:x` (no space) tolerated. [DONE] is
      // filtered by the parser itself — finalizeStream() runs
      // unconditionally at end-of-stream below (idempotent), so the
      // explicit marker no longer needs its own branch.
      const handleBlock = async (block: string): Promise<void> => {
        const parsed = parseSSEEvent(block);
        if (!parsed) return;
        const chunk = parsed.data as OpenAIStreamChunk;
        // Malformed JSON arrives as the raw string — skip it (the old
        // inline JSON.parse try/catch did the same).
        if (typeof chunk !== "object" || chunk === null) return;
        const choice = chunk.choices?.[0];

        // Accumulate usage from every chunk that carries one. OpenAI's
        // include_usage stream emits it only on the final (often
        // choices-less) chunk, but compatible upstreams may spread it
        // across chunks — keep the freshest snapshot.
        if (chunk.usage) {
          latestUsage = chunk.usage;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }

        if (!messageStarted) {
          messageStarted = true;
          // message_start must lead the stream, but the upstream usage
          // has not arrived yet at this point, so input_tokens starts at
          // 0 here and is delivered for real via the deferred
          // message_delta once usage lands. (Anthropic's own streaming
          // also reports input_tokens up-front; we cannot, given the
          // upstream timing.)
          const startUsage = openaiUsageToAnthropic(chunk.usage);
          await enqueueAnthropicEvent("message_start", {
            type: "message_start",
            message: {
              id: chunk.id ?? messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: chunk.model || model,
              stop_reason: null,
              stop_sequence: null,
              usage: startUsage,
            },
          });
        }

        if (choice?.delta?.content) {
          const index = await ensureActiveBlock("text");
          await enqueueAnthropicEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: choice.delta.content },
          });
        }

        if (choice?.delta?.reasoning_content) {
          const index = await ensureActiveBlock("thinking");
          await enqueueAnthropicEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: choice.delta.reasoning_content },
          });
        }

        if (choice?.delta?.tool_calls?.length) {
          await handleToolCalls(choice.delta.tool_calls);
        }

        if (choice?.finish_reason) {
          // Close blocks now, but hold message_delta until the stream
          // actually ends so the usage chunk (which follows finish_reason
          // in include_usage streams) is folded into the final usage.
          pendingStopReason = mapFinishReason(choice.finish_reason);
          await closeContent();
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) break;

          for (const block of framer.push(decoder.decode(value, { stream: true }))) {
            await handleBlock(block);
          }
        }

        if (cancelled) return;
        // Flush a trailing frame that lacked its final blank-line terminator
        // (the old line splitter consumed it; frame splitting needs this).
        for (const block of framer.finish(decoder.decode())) {
          await handleBlock(block);
        }

        // Stream ended — emit the deferred message_delta (with full usage) and
        // message_stop. Covers both explicit [DONE] already seen above and
        // streams that terminate without one.
        await finalizeStream();
      } catch (err) {
        errored = true;
        void reader.cancel(err).catch(() => {});
        // error()/close() 互斥:errored 流上再 close() 会抛 TypeError,进而触发 Bun 引擎空指针崩溃。
        try { controller.error(err); } catch {}
      } finally {
        if (!errored) {
          try { controller.close(); } catch {}
        }
        upstreamReader = undefined;
        reader.releaseLock();
      }
    },
    cancel(reason) { cancelled = true; void (upstreamReader ? upstreamReader.cancel(reason) : upstream.cancel(reason)).catch(() => {}); },
  });
}

function formatAnthropicSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapFinishReason(finishReason: string): string {
  switch (finishReason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}
