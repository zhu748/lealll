/**
 * SSE event translator — converts streaming events between OpenAI and Anthropic formats.
 * @see .omo/plans/zcode-proxy.md Task 12
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
import type { AnthropicStreamEvent, OpenAIStreamChunk, OpenAIStreamToolCall, OpenAIUsage } from "./types.js";
import { openaiUsageToAnthropic } from "./anthropic-to-openai.js";
import { parseSSEChunk, waitForBackpressure, type ParsedSSE } from "../utils/sse.js";
import { SSE as SSE_CONST } from "../utils/constants.js";

export interface TranslationState {
  messageId: string;
  model: string;
  roleSent: boolean;
  inputTokens: number;
  outputTokens: number;
  /**
   * v0.2.0.10: cache tokens read from upstream Anthropic usage. The proxy's
   * stats observer (handler.ts observeStreamParseSse) reads this field from
   * the final usage chunk so the dashboard can show "in: N (c:M)".
   * Without this, the Chat Completions streaming path silently dropped
   * cache_read_input_tokens — the dashboard showed only the small
   * input_tokens value (often ~35x smaller than reality when prompt
   * caching is active).
   */
  cacheReadInputTokens: number;
  /**
   * v0.2.0.10: thinking chunk count from thinking_delta events. GLM streams
   * these before the final text output when thinking is enabled. We count
   * them so the final usage chunk can carry a `reasoning_tokens` field —
   * the proxy's stats observer reads this and shows "out: N (th:M)".
   * Chunk count is approximate (one per thinking_delta event), but it's
   * the best we have without a tokeniser; the upstream message_delta.usage
   * sometimes carries an authoritative count but not always.
   */
  thinkingTokens: number;
  /**
   * Tracks active tool_use content blocks by their Anthropic block index.
   * Key = Anthropic block index (from content_block_start.index).
   * Value = { openaiIndex, id, name }.
   *
   * The OpenAI tool_calls array uses its own `index` (0, 1, 2...) which is
   * separate from Anthropic's block index (text blocks and tool_use blocks
   * share the same Anthropic index space). We assign each tool_use block a
   * sequential OpenAI index when it starts, so OpenAI clients can correlate
   * the initial `tool_calls[i].function.name` chunk with subsequent
   * `tool_calls[i].function.arguments` delta chunks.
   */
  toolBlocks: Map<number, { openaiIndex: number; id: string; name: string }>;
  /** Counter for assigning OpenAI tool_calls indices. */
  nextToolIndex: number;
  /** Whether a terminal finish_reason/usage chunk has already been emitted. */
  finalChunkSent: boolean;
}

export function initState(model: string): TranslationState {
  return {
    messageId: "",
    model,
    roleSent: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    thinkingTokens: 0,
    toolBlocks: new Map(),
    nextToolIndex: 0,
    finalChunkSent: false,
  };
}

function makeChunk(
  state: TranslationState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_read_input_tokens?: number; reasoning_tokens?: number },
): string {
  const chunk: OpenAIStreamChunk & { usage?: typeof usage } = {
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
      const enqueueEncoded = async (output: string): Promise<boolean> => {
        if (cancelled || streamClosed) return false;
        await waitForBackpressure(controller);
        if (cancelled || streamClosed) return false;
        try {
          controller.enqueue(encoder.encode(output));
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
              const output = translateEvent(state, p);
              if (output) {
                if (!(await enqueueEncoded(output))) return;
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
            const output = translateEvent(state, p);
            if (output) {
              if (!(await enqueueEncoded(output))) return;
            }
          }
        }

        // Emit [DONE]
        await enqueueEncoded("data: [DONE]\n\n");
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

export function translateEvent(state: TranslationState, sse: ParsedSSE): string | null {
  const data = sse.data as AnthropicStreamEvent;

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.messageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      state.inputTokens = msg?.usage?.input_tokens ?? 0;
      // v0.2.0.10: preserve cache_read_input_tokens from upstream. The
      // proxy's stats observer reads this from the final usage chunk so the
      // dashboard can show "in: N (c:M)". The authoritative value usually
      // arrives in message_delta, but message_start sometimes carries it
      // too (and is the only place GLM puts it for some models).
      state.cacheReadInputTokens = msg?.usage?.cache_read_input_tokens ?? 0;
      if (!state.roleSent) {
        state.roleSent = true;
        return makeChunk(state, { role: "assistant" });
      }
      return null;
    }

    case "content_block_start": {
      // vceshi0.0.8+: handle tool_use blocks. Previously this case was
      // skipped entirely, which meant OpenAI clients never received the
      // tool_call's id / name — the streaming tool_use was completely
      // lost. Now we emit an OpenAI-style tool_calls delta with the
      // initial id + name + empty arguments string; subsequent
      // input_json_delta events append to the arguments string.
      const block = (data as any).content_block;
      const blockIdx = parseStreamContentBlockIndex((data as any).index);
      if (block?.type === "tool_use") {
        const openaiIdx = state.nextToolIndex++;
        state.toolBlocks.set(blockIdx, {
          openaiIndex: openaiIdx,
          id: block.id ?? `call_${blockIdx}`,
          name: block.name ?? "",
        });
        return makeChunk(state, {
          tool_calls: [{
            index: openaiIdx,
            id: block.id ?? `call_${blockIdx}`,
            type: "function",
            function: { name: block.name ?? "", arguments: "" },
          }],
        });
      }
      // text blocks (and any other block type) don't need an open chunk in
      // the OpenAI format — OpenAI just streams content deltas directly.
      return null;
    }

    case "content_block_delta": {
      const delta = (data as any).delta;
      const blockIdx = parseStreamContentBlockIndex((data as any).index);
      if (delta?.type === "text_delta") {
        return makeChunk(state, { content: delta.text });
      }
      if (delta?.type === "input_json_delta") {
        // Forward the partial JSON arguments to the matching OpenAI
        // tool_call entry. The Anthropic block index tells us which
        // tool_use block this delta belongs to.
        const tool = state.toolBlocks.get(blockIdx);
        if (!tool) return null; // orphan delta — drop
        return makeChunk(state, {
          tool_calls: [{
            index: tool.openaiIndex,
            function: { arguments: delta.partial_json ?? "" },
          }],
        });
      }
      // v0.2.0.10: count thinking_delta chunks so the final usage chunk can
      // carry a reasoning_tokens field. OpenAI Chat Completions has no
      // native streaming format for reasoning, so we don't emit anything
      // to the client here (DeepSeek-style `reasoning_content` deltas were
      // considered but would pollute the OpenAI protocol and break strict
      // clients). The count is approximate — one per thinking_delta event —
      // but it's enough for the dashboard's "(th:M)" indicator.
      if (delta?.type === "thinking_delta") {
        const t = delta?.thinking;
        if (typeof t === "string" && t.length > 0) state.thinkingTokens++;
        return null;
      }
      return null;
    }

    case "content_block_stop": {
      // vceshi0.0.8+: clean up the tool_use block tracking. No OpenAI
      // event needs to be emitted — OpenAI's format doesn't have an
      // explicit "tool call ended" marker; the finish_reason carries
      // that information.
      const blockIdx = parseStreamContentBlockIndex((data as any).index);
      state.toolBlocks.delete(blockIdx);
      return null;
    }

    case "message_delta": {
      const dataAny = data as any;
      const delta = dataAny.delta;
      if (dataAny?.usage?.output_tokens !== undefined) {
        state.outputTokens = dataAny.usage.output_tokens;
      }
      // v0.2.0.10: message_delta is the AUTHORITATIVE source for cache_read_input_tokens
      // (message_start often carries placeholder 0). Update if present.
      if (typeof dataAny?.usage?.cache_read_input_tokens === "number" && dataAny.usage.cache_read_input_tokens > 0) {
        state.cacheReadInputTokens = dataAny.usage.cache_read_input_tokens;
      }
      // v0.2.0.10: if upstream provides an authoritative reasoning token count
      // in message_delta.usage, prefer it over our chunk count. GLM doesn't
      // always include this, but when it does, it's the real value.
      if (typeof dataAny?.usage?.reasoning_tokens === "number" && dataAny.usage.reasoning_tokens > 0) {
        state.thinkingTokens = dataAny.usage.reasoning_tokens;
      }
      if (delta?.stop_reason) {
        state.finalChunkSent = true;
        const finishReason = mapStopReason(delta.stop_reason);
        return makeChunk(state, {}, finishReason, {
          prompt_tokens: state.inputTokens,
          completion_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
          // v0.2.0.10: forward cache_read_input_tokens so the proxy stats
          // observer can show the cache-hit portion of input tokens. OpenAI
          // clients ignore unknown usage fields, so this is a safe extension.
          ...(state.cacheReadInputTokens > 0 ? { cache_read_input_tokens: state.cacheReadInputTokens } : {}),
          // v0.2.0.10: forward reasoning_tokens (thinking) so the proxy can
          // show "out: N (th:M)". OpenAI's Responses API uses this field
          // name; we reuse it here for consistency.
          ...(state.thinkingTokens > 0 ? { reasoning_tokens: state.thinkingTokens } : {}),
        });
      }
      return null;
    }

    case "message_stop": {
      if (state.finalChunkSent) return null;
      state.finalChunkSent = true;
      return makeChunk(state, {}, "stop", {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
        ...(state.cacheReadInputTokens > 0 ? { cache_read_input_tokens: state.cacheReadInputTokens } : {}),
        ...(state.thinkingTokens > 0 ? { reasoning_tokens: state.thinkingTokens } : {}),
      });
    }

    case "ping":
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

// v0.3.0 (upstream zcode-api v2.6.0 alignment): `openaiSseToAnthropicSse`
// reimplemented from the upstream implementation — needed because start-plan
// now routes through the zcode.z.ai OpenAI gateway (chat/completions), and
// Anthropic-format clients (Claude Code) require OpenAI SSE → Anthropic SSE
// translation on the response path. The previous local implementation was
// removed in v0.2.2 with a known bug (one content_block per delta); this
// version follows the Anthropic SSE spec correctly (single content_block_start,
// multiple deltas at the same index, single content_block_stop) and additionally
// handles: streaming tool_calls (lazily-allocated tool_use blocks with
// pending-args buffering), reasoning_content → thinking blocks, deferred usage
// folding (OpenAI emits usage only on the final chunk), and late tool-start
// flushing so partial tool calls are surfaced rather than dropped.
export function openaiSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
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

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let errored = false;

      const enqueueAnthropicEvent = (eventType: string, data: unknown) => {
        controller.enqueue(encoder.encode(formatAnthropicSSE(eventType, data)));
      };

      const closeActiveBlock = () => {
        if (!activeBlock) return;
        enqueueAnthropicEvent("content_block_stop", {
          type: "content_block_stop",
          index: activeBlock.index,
        });
        activeBlock = null;
      };

      const closeToolBlocks = () => {
        for (const idx of openToolBlockIndices) {
          enqueueAnthropicEvent("content_block_stop", {
            type: "content_block_stop",
            index: idx,
          });
        }
        openToolBlockIndices.length = 0;
      };

      const ensureActiveBlock = (type: "text" | "thinking"): number => {
        if (activeBlock?.type === type) return activeBlock.index;
        closeActiveBlock();
        const index = blockIndex++;
        activeBlock = { type, index };
        enqueueAnthropicEvent("content_block_start", {
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
      const handleToolCalls = (toolCalls: OpenAIStreamToolCall[]) => {
        // Tool calls never share a block with text/thinking — close any open prose block first.
        closeActiveBlock();
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
            enqueueAnthropicEvent("content_block_start", {
              type: "content_block_start",
              index: state.index,
              content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
            });
            openToolBlockIndices.push(state.index);
            if (state.pendingArgs.length > 0) {
              enqueueAnthropicEvent("content_block_delta", {
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
              enqueueAnthropicEvent("content_block_delta", {
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
       * silently dropped.
       */
      const startPendingToolBlocks = () => {
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
          enqueueAnthropicEvent("content_block_start", {
            type: "content_block_start",
            index: ls.index,
            content_block: { type: "tool_use", id: ls.id, name: ls.name, input: {} },
          });
          if (ls.args.length > 0) {
            enqueueAnthropicEvent("content_block_delta", {
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
      const closeContent = () => {
        if (contentClosed) return;
        contentClosed = true;
        closeActiveBlock();
        startPendingToolBlocks();
        closeToolBlocks();
      };

      /**
       * Emit the terminal message_delta + message_stop. The message_delta
       * carries the full Anthropic usage (input + output + cache) derived from
       * the latest upstream usage snapshot. This is what lets Anthropic clients
       * see a non-zero input_tokens despite OpenAI only reporting usage in the
       * stream's final chunk — the delta is deferred until that chunk lands.
       */
      const finalizeStream = () => {
        closeContent();
        if (!messageDeltaSent) {
          messageDeltaSent = true;
          const usage = openaiUsageToAnthropic(latestUsage);
          if (!latestUsage) usage.output_tokens = outputTokens;
          enqueueAnthropicEvent("message_delta", {
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
          enqueueAnthropicEvent("message_stop", { type: "message_stop" });
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();

            if (dataStr === "[DONE]") {
              finalizeStream();
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr) as OpenAIStreamChunk;
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
                enqueueAnthropicEvent("message_start", {
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
                const index = ensureActiveBlock("text");
                enqueueAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: choice.delta.content },
                });
              }

              if (choice?.delta?.reasoning_content) {
                const index = ensureActiveBlock("thinking");
                enqueueAnthropicEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "thinking_delta", thinking: choice.delta.reasoning_content },
                });
              }

              if (choice?.delta?.tool_calls?.length) {
                handleToolCalls(choice.delta.tool_calls);
              }

              if (choice?.finish_reason) {
                // Close blocks now, but hold message_delta until the stream
                // actually ends so the usage chunk (which follows finish_reason
                // in include_usage streams) is folded into the final usage.
                pendingStopReason = mapFinishReason(choice.finish_reason);
                closeContent();
              }
            } catch {
              // Skip malformed
            }
          }
        }

        // Stream ended — emit the deferred message_delta (with full usage) and
        // message_stop. Covers both explicit [DONE] already handled above and
        // streams that terminate without one.
        finalizeStream();
      } catch (err) {
        errored = true;
        // error()/close() 互斥: errored 流上再 close() 会抛 TypeError.
        try { controller.error(err); } catch {}
      } finally {
        if (!errored) {
          try { controller.close(); } catch {}
        }
        reader.releaseLock();
      }
    },
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
