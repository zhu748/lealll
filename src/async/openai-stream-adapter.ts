/**
 * OpenAI SSE stream adapter for the async path.
 *
 * Single persistent state machine for the whole stream — preserves message ID,
 * usage, tool-call index mapping, and finish state across events. Re-using the
 * same translation state is what the existing `anthropicSseToOpenaiSse` does;
 * we add two extra concerns for the async bridge:
 *
 *   1. Preserve `: keepalive` comments (the existing translator drops them).
 *      Comments are the only queue-wait liveness signal; dropping them defeats
 *      the bridge design.
 *   2. Convert Anthropic `event: error` events to OpenAI
 *      `data: {"error":...}` + terminal `[DONE]`. The existing translator
 *      silently drops Anthropic errors, which would mask permanent bridge
 *      failures as a clean `[DONE]`.
 *
 * Anti-pattern: NEVER create a fresh translator per event. State (messageId,
 * toolCallIndex, finishReasonSent, usage) must persist across the whole stream
 * or downstream clients see inconsistent IDs, missing tool arguments, and
 * duplicate finish reasons.
 */
import { initState, parseSSEChunk, translateEvent, SSE_FRAME_SPLIT, type TranslationState, type ParsedSSE } from "../translator/sse-translator.js";
import { waitForBackpressure } from "../utils/sse.js";

export function anthropicSseToOpenaiSseWithKeepalive(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state: TranslationState = initState(model);
  let doneSent = false;
  let errored = false;

  async function emit(out: string): Promise<void> {
    if (errored) return;
    try {
      controller0.enqueue(encoder.encode(out));
      // Mirror the shared translator's backpressure contract: a slow (but
      // connected) OpenAI client must slow the pump down instead of letting
      // the translated queue grow unbounded for the whole generation.
      await waitForBackpressure(controller0);
    } catch {
      // controller closed by consumer
    }
  }

  // Hoisted controller reference so `emit()` can be defined above the ReadableStream
  // constructor without forward-let noise.
  let controller0: ReadableStreamDefaultController<Uint8Array>;
  // Hoisted upstream reader so cancel() can stop the pump immediately.
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller0 = controller;
      const reader = upstream.getReader();
      upstreamReader = reader;
      let buffer = "";

      reader.read().then(async function pump({ done, value }): Promise<unknown | undefined> {
        if (done) {
          // Flush trailing buffer
          if (buffer.trim()) await processBlock(buffer, state);
          buffer = "";
          emitDone();
          try { controller.close(); } catch {}
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(SSE_FRAME_SPLIT);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          await processBlock(block, state);
          if (errored) {
            // Early exit: stop draining the upstream bridge stream — leaving
            // it open would keep consuming the LLM stream until req.signal
            // fires indirectly.
            await reader.cancel().catch(() => {});
            try { controller.close(); } catch {}
            return;
          }
        }
        return reader.read().then(pump);
      }).catch((err) => {
        if (!errored) {
          const errPayload = JSON.stringify({ error: { message: `async stream error: ${(err as Error).message}`, type: "server_error" } });
          void emit(`data: ${errPayload}\n\n`);
          emitDone();
        }
        try { controller.close(); } catch {}
      }).finally(() => {
        if (upstreamReader === reader) upstreamReader = undefined;
        reader.releaseLock?.();
      });
    },

    cancel() {
      // Consumer disconnected mid-stream: flip errored so the pending pump
      // iteration stops, and cancel the upstream reader.
      errored = true;
      upstreamReader?.cancel().catch(() => {});
    },
  });

  async function processBlock(block: string, st: TranslationState): Promise<void> {
    const trimmed = block.trim();
    if (trimmed === "") return;

    // Pure comment frame — pass through unchanged. Only when EVERY non-empty
    // line is a comment: a frame mixing comments with data fields must go
    // through parseSSEChunk below (verbatim passthrough would leak raw
    // Anthropic JSON into the OpenAI stream).
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > 0 && lines.every((l) => l.trimStart().startsWith(":"))) {
      await emit(block + "\n\n");
      return;
    }

    // Detect Anthropic error event before parseSSEChunk would silently drop it
    // (parseSSEChunk only returns events with data; error events have data too,
    // but the existing translateEvent doesn't handle `type:"error"`).
    if (trimmed.startsWith("event: error") || trimmed.startsWith("event:error")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      let anthropicMsg = "unknown error";
      let anthropicType = "api_error";
      if (dataLine) {
        try {
          const data = JSON.parse(dataLine.slice(5).trim());
          if (data?.error?.message) anthropicMsg = String(data.error.message);
          if (data?.error?.type) anthropicType = String(data.error.type);
        } catch {
          // leave defaults
        }
      }
      const oaiPayload = JSON.stringify({ error: { message: anthropicMsg, type: anthropicType } });
      await emit(`data: ${oaiPayload}\n\n`);
      emitDone();
      errored = true;
      return;
    }

    // Standard Anthropic event — parse + translate using shared state.
    const parsed = parseSSEChunk(block);
    for (const p of parsed) {
      const out = translateEvent(st, p);
      if (out) await emit(out);
    }
  }

  function emitDone(): void {
    if (doneSent) return;
    doneSent = true;
    emit("data: [DONE]\n\n");
  }
}

// Re-export for tests
export type { ParsedSSE, TranslationState };
