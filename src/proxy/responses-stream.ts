/** Responses SSE framing, completion, cancellation and history storage. */
import { createBackpressuredStream } from "../utils/stream.js";
import { extractSSEData, waitForBackpressure } from "../utils/sse.js";
import { SSEFramer } from "../utils/sse-framer.js";
import { AnthropicStreamError } from "../translator/sse-translator.js";
import {
  chatChunkToResponsesEvents,
  finalizeResponsesStream,
  failResponsesStream,
  newResponsesStreamState,
  responsesEventToSse,
  type ChatToResponsesOptions,
} from "../translator/chat-to-responses.js";
import type { ResponsesInputItem, ResponsesRequest, ResponsesStreamEvent } from "../translator/responses-types.js";
import type { ResponseStore } from "../responses/store.js";
import { buildStoredResponse } from "../responses/history.js";
import { errorResponse } from "./translated-response.js";

export interface ResponsesStreamContext {
  responseId: string;
  model: string;
  meta: ChatToResponsesOptions["meta"];
  request: ResponsesRequest;
  input: ResponsesInputItem[];
  responseStore?: ResponseStore;
  debug?: boolean;
  /** Fired once when the client stream completes, errors, or is cancelled. */
  onStreamEnd?: () => void;
}

export function createResponsesStreamResponse(upstreamResp: Response, context: ResponsesStreamContext): Response {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream");
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });
  let onStreamEnded = false;
  const fireStreamEnd = (): void => {
    if (onStreamEnded) return;
    onStreamEnded = true;
    try { context.onStreamEnd?.(); } catch {}
  };

  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const stream = createBackpressuredStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = async (evt: ResponsesStreamEvent) => {
        await waitForBackpressure(controller);
        if (cancelled) return;
        controller.enqueue(encoder.encode(responsesEventToSse(evt)));
      };
      try {
        if (cancelled) return;
        const reader = upstreamResp.body!.getReader();
        upstreamReader = reader;
        const decoder = new TextDecoder();
        const framer = new SSEFramer();
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          const frames = done ? framer.finish(decoder.decode()) : framer.push(decoder.decode(value, { stream: true }));
          for (const frame of frames) {
            const dataLine = extractSSEData(frame);
            if (!dataLine || dataLine === "[DONE]") continue;
            const chunk = JSON.parse(dataLine);
            for (const evt of chatChunkToResponsesEvents(chunk, state)) await send(evt);
          }
          if (done) break;
        }
        if (cancelled) return;
        const finalEvents = finalizeResponsesStream(state);
        for (const evt of finalEvents) await send(evt);
        if (cancelled) return;
        const finalEvent = finalEvents.find((evt) => evt.type === "response.completed" || evt.type === "response.incomplete");
        if (finalEvent && context.request.store !== false && context.responseStore) {
          context.responseStore.set(buildStoredResponse(finalEvent.response, context.input, context.request.instructions));
        }
        try { controller.close(); } catch {}
      } catch (err) {
        if (cancelled) return;
        try {
          for (const evt of failResponsesStream(state, {
            code: err instanceof AnthropicStreamError ? err.code : "upstream_error",
            message: err instanceof Error ? err.message : String(err),
          })) await send(evt);
          controller.close();
        } catch { try { controller.error(err); } catch {} }
      } finally {
        fireStreamEnd();
        if (upstreamReader) {
          void upstreamReader.cancel().catch(() => {});
          try { upstreamReader.releaseLock(); } catch {}
          upstreamReader = undefined;
        }
      }
    },
    cancel(reason) {
      context.debug === true && console.log(`[responses] stream cancelled: ${String(reason)}`);
      cancelled = true;
      fireStreamEnd();
      void (upstreamReader ? upstreamReader.cancel(reason) : upstreamResp.body?.cancel(reason))?.catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
