/**
 * Shared SSE (Server-Sent Events) parsing & formatting utilities.
 *
 * Previously the same SSE block parser was duplicated three times
 * (sse-translator.ts, anthropic-to-responses.ts, and inline in handler.ts).
 * Bugs in SSE parsing (multi-line data: fields, \r\n line endings, malformed
 * JSON) had to be fixed in three places. This module is the single source
 * of truth.
 */

export interface ParsedSSE {
  /** Event type from the `event:` line, or "" if absent. */
  event: string;
  /** Parsed JSON data, or the raw string if JSON.parse failed. */
  data: unknown;
}

/**
 * Parse a raw SSE chunk (one or more `\n\n`-delimited blocks) into structured
 * events. Tolerates `\r\n` line endings by normalizing them first.
 *
 * Per the SSE spec, multiple `data:` lines within a block are concatenated
 * with newlines. Malformed JSON is reported via console.warn and the data is
 * returned as the raw string (so callers can decide how to handle it).
 */
export function parseSSEChunk(raw: string): ParsedSSE[] {
  const results: ParsedSSE[] = [];
  // Normalize CRLF → LF so the split-on-"\n\n" works for both line endings.
  const normalized = raw.indexOf("\r") >= 0 ? raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : raw;
  const blocks = normalized.split("\n\n");

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    let eventType = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Handles both "data:" and "data: "
        dataLines.push(line.slice(5).replace(/^\s/, ""));
      }
    }

    if (dataLines.length === 0) continue;
    const dataStr = dataLines.join("\n");
    if (!dataStr || dataStr === "[DONE]") continue;

    let data: unknown;
    try {
      data = JSON.parse(dataStr);
    } catch (err) {
      console.warn(`[sse] malformed JSON in SSE event: ${(err as Error).message}; payload=${dataStr.slice(0, 200)}`);
      data = dataStr; // preserve raw string so callers can decide what to do
    }
    results.push({ event: eventType, data });
  }

  return results;
}

/**
 * Format a single SSE event as a wire string.
 *
 *   event: {eventType}\n
 *   data: {JSON}\n\n
 */
export function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Wait for a ReadableStream's internal buffer to drain below the high-water
 * mark before continuing. Returns immediately if backpressure is not active
 * (e.g. desiredSize is null) or if the controller is already closed.
 *
 * Use this before every `controller.enqueue(...)` on a translated SSE stream
 * so that a slow downstream client cannot cause unbounded memory growth in
 * the proxy's translated-stream buffer.
 */
export async function waitForBackpressure(
  controller: ReadableStreamDefaultController,
  maxYieldMs: number = 1,
): Promise<void> {
  // desiredSize === null means the controller is errored or closed — caller
  // will get an exception on enqueue, which they should handle.
  // desiredSize <= 0 means the consumer is behind — yield to the event loop
  // so the consumer can drain. We use a tiny setTimeout rather than the
  // queueMicrotask/promise pattern because we want to give the runtime a
  // chance to actually drain the underlying sink.
  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
    await new Promise<void>(r => setTimeout(r, maxYieldMs));
  }
}
