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

const MALFORMED_SSE_WARN_LIMIT = 5;
const MALFORMED_SSE_WARN_WINDOW_MS = 10_000;
const MAX_BACKPRESSURE_YIELD_MS = 100;
const MAX_BACKPRESSURE_WAIT_MS = 5_000;
let malformedSseWarnWindowStart = 0;
let malformedSseWarnCount = 0;

function warnMalformedSseJson(message: string, payload: string): void {
  const now = Date.now();
  if (now - malformedSseWarnWindowStart > MALFORMED_SSE_WARN_WINDOW_MS) {
    malformedSseWarnWindowStart = now;
    malformedSseWarnCount = 0;
  }
  if (malformedSseWarnCount < MALFORMED_SSE_WARN_LIMIT) {
    malformedSseWarnCount++;
    console.warn(`[sse] malformed JSON in SSE event: ${message}; payload=${payload.slice(0, 200)}`);
    return;
  }
  if (malformedSseWarnCount === MALFORMED_SSE_WARN_LIMIT) {
    malformedSseWarnCount++;
    console.warn(`[sse] further malformed JSON warnings suppressed for ${MALFORMED_SSE_WARN_WINDOW_MS / 1000}s`);
  }
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
  // Normalize CRLF -> LF so delimiter scanning works for all common line endings.
  const normalized = raw.indexOf("\r") >= 0 ? raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : raw;

  let start = 0;
  for (;;) {
    const end = normalized.indexOf("\n\n", start);
    if (end < 0) {
      parseSSEBlock(normalized.slice(start), results);
      break;
    }

    parseSSEBlock(normalized.slice(start, end), results);
    start = end + 2;
  }

  return results;
}

function parseSSEBlock(block: string, results: ParsedSSE[]): void {
  const trimmedBlock = block.trim();
  if (!trimmedBlock) return;

  let eventType = "";
  const dataLines: string[] = [];
  let lineStart = 0;

  for (;;) {
    const lineEnd = trimmedBlock.indexOf("\n", lineStart);
    const line = lineEnd < 0 ? trimmedBlock.slice(lineStart) : trimmedBlock.slice(lineStart, lineEnd);
    lineStart = lineEnd < 0 ? trimmedBlock.length + 1 : lineEnd + 1;

    if (line) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Handles both "data:" and "data: "
        dataLines.push(line.slice(5).replace(/^\s/, ""));
      }
    }

    if (lineEnd < 0) break;
  }

  if (dataLines.length === 0) return;
  const dataStr = dataLines.join("\n");
  if (!dataStr || dataStr === "[DONE]") return;

  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch (err) {
    warnMalformedSseJson((err as Error).message, dataStr);
    data = dataStr; // preserve raw string so callers can decide what to do
  }
  results.push({ event: eventType, data });
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
  maxWaitMs: number = 25,
): Promise<void> {
  // desiredSize === null means the controller is errored or closed — caller
  // will get an exception on enqueue, which they should handle.
  // desiredSize <= 0 means the consumer is behind — yield to the event loop
  // so the consumer can drain. This is deliberately bounded: a disconnected
  // or not-yet-attached consumer must slow us down, not deadlock the stream.
  const rawYield = Number.isFinite(maxYieldMs) ? Math.floor(maxYieldMs) : 1;
  const yieldMs = Math.max(1, Math.min(rawYield > 0 ? rawYield : 1, MAX_BACKPRESSURE_YIELD_MS));
  const rawWait = Number.isFinite(maxWaitMs) ? Math.floor(maxWaitMs) : 25;
  const waitMs = Math.max(yieldMs, Math.min(rawWait > 0 ? rawWait : yieldMs, MAX_BACKPRESSURE_WAIT_MS));
  const deadline = Date.now() + waitMs;
  while (controller.desiredSize !== null && controller.desiredSize <= 0) {
    await new Promise<void>(r => setTimeout(r, yieldMs));
    if (Date.now() >= deadline) break;
  }
}

/** @internal test helper */
export function _resetSseWarningStateForTesting(): void {
  malformedSseWarnWindowStart = 0;
  malformedSseWarnCount = 0;
}
