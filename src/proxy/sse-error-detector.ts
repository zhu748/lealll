/**
 * SSE error event detector — catches errors hidden inside HTTP 200 SSE streams.
 *
 * Problem: Some upstream gateways (notably GLM's Anthropic-compatible endpoint)
 * return HTTP 200 + text/event-stream even when the request fails, then emit
 * an `event: error` SSE event inside the stream. This violates Anthropic's
 * documented behavior (which returns HTTP 529 directly) and bypasses the
 * proxy's status-code-based retry logic — the proxy sees 200 and happily
 * streams the error to the client without retrying.
 *
 * Solution: Peek at the first chunk(s) of an SSE response. If an error event
 * is found, convert the response into a synthetic JSON response with the
 * appropriate HTTP status code so the existing retry logic can handle it.
 * If no error is found, reconstruct the stream (buffered bytes + remaining
 * stream) and return it untouched.
 *
 * Only triggers on:
 * - HTTP 200 responses (non-200 already have a status for retry logic)
 * - content-type: text/event-stream
 * - No content-encoding (compressed SSE is skipped — can't decode as UTF-8)
 *
 * @see handler.ts — called before the retryable-status check
 */

/** Maps Anthropic error types to HTTP status codes. */
const SSE_ERROR_STATUS_MAP: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
};

export interface SseErrorInfo {
  /** Anthropic error type, e.g., "overloaded_error". */
  type: string;
  /** Mapped HTTP status code, e.g., 529. */
  status: number;
  /** Error message extracted from the SSE event. */
  message: string;
  /** Raw JSON string of the error data field. */
  rawBody: string;
}

/** Maximum bytes to buffer while peeking for an error event. 16KB is enough
 *  for any error event — they're always sent before generation starts. */
const MAX_PEEK_BYTES = 16 * 1024;

/**
 * If the response is an SSE stream with an embedded error event, convert it
 * to a synthetic JSON response with the appropriate HTTP status code.
 * Otherwise, return the response unchanged (or reconstructed with buffered
 * bytes prepended so the stream is byte-for-byte identical to the original).
 *
 * Always converts when an error is detected — even non-retryable errors
 * benefit from conversion (client sees a real 401/500 instead of a phantom
 * 200 with an error buried in the stream). The retry logic in handler.ts
 * then decides whether to retry based on retryableStatuses.
 */
export async function detectSseErrorAndConvert(resp: Response): Promise<Response> {
  if (!resp.body) return resp;
  if (resp.status !== 200) return resp;

  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) return resp;

  // Skip compressed streams — we can't decode gzip/br as UTF-8.
  // SSE streams are almost never compressed, so this is a rare edge case.
  const ce = resp.headers.get("content-encoding");
  if (ce && ce !== "identity") return resp;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const bufferedChunks: Uint8Array[] = [];

  try {
    while (buffer.length < MAX_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bufferedChunks.push(value);
      buffer += decoder.decode(value, { stream: true });

      // Check for SSE error event
      const errorInfo = parseSseError(buffer);
      if (errorInfo) {
        // Found an error — cancel the stream and return synthetic response
        try { await reader.cancel(); } catch {}
        return makeSyntheticErrorResponse(errorInfo, resp.headers);
      }

      // Check for a legitimate (non-error) event — stop peeking, pass through
      if (hasNonErrorEvent(buffer)) {
        break;
      }
    }
  } catch {
    // Read error — fall through to reconstruction with whatever we have
  }

  // No error found — reconstruct the stream with buffered bytes prepended
  return reconstructStream(resp, bufferedChunks, reader);
}

/**
 * Parse the buffer for an SSE error event.
 * Handles multiple formats seen in the wild:
 *   1. Standard Anthropic:  event: error\ndata: {"type":"error","error":{"type":"overloaded_error",...}}
 *   2. Bare data:           data: {"type":"error","error":{"type":"overloaded_error",...}}
 *   3. Direct error type:   data: {"type":"overloaded_error","message":"..."}
 *   4. Raw JSON (no SSE):   {"type":"overloaded_error","message":"..."}
 */
function parseSseError(buffer: string): SseErrorInfo | null {
  // Try parsing as SSE blocks first
  const blocks = buffer.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.split("\n").filter(Boolean);
    let eventType = "";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Handles both "data:" and "data: "
        dataStr = line.slice(5).trimStart();
      }
    }

    if (dataStr) {
      const info = extractErrorFromJson(dataStr, eventType);
      if (info) return info;
    }
  }

  // If no SSE framing found, try parsing the whole buffer as raw JSON.
  // Some gateways send the error body without SSE framing at all.
  const trimmed = buffer.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const info = extractErrorFromJson(trimmed, "");
    if (info) return info;
  }

  return null;
}

/** Try to extract error info from a JSON string. Returns null if not an error. */
function extractErrorFromJson(jsonStr: string, eventType: string): SseErrorInfo | null {
  let data: any;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  // Case 1: Anthropic standard {"type":"error","error":{"type":"overloaded_error","message":"..."}}
  if (data?.type === "error" && data?.error) {
    const errType = data.error.type ?? "api_error";
    const message = data.error.message ?? "SSE error event";
    const status = SSE_ERROR_STATUS_MAP[errType] ?? 500;
    return { type: errType, status, message, rawBody: jsonStr };
  }

  // Case 2: Direct error type {"type":"overloaded_error","message":"..."}
  // (GLM's gateway uses this format — see user reports of [1305] errors)
  if (data?.type && SSE_ERROR_STATUS_MAP[data.type]) {
    const message = data.message ?? data.error?.message ?? "SSE error event";
    return {
      type: data.type,
      status: SSE_ERROR_STATUS_MAP[data.type],
      message,
      rawBody: jsonStr,
    };
  }

  // Case 3: event: error with arbitrary data payload
  if (eventType === "error") {
    const errType = data?.type ?? data?.error?.type ?? "api_error";
    const message = data?.message ?? data?.error?.message ?? "SSE error event";
    const status = SSE_ERROR_STATUS_MAP[errType] ?? 500;
    return { type: errType, status, message, rawBody: jsonStr };
  }

  return null;
}

/**
 * Check if the buffer contains a complete, non-error SSE event.
 * Used to short-circuit peeking once we know the stream is legitimate
 * (e.g., we've seen `message_start` or `content_block_start`).
 *
 * IMPORTANT: Only checks COMPLETE blocks (those terminated by \n\n).
 * The last block after split("\n\n") might be a partial event (e.g.,
 * `event: er` when the full `event: error` hasn't arrived yet). Checking
 * partial blocks would cause false positives — "er" !== "error" would
 * make us think it's a non-error event and stop peeking prematurely.
 */
function hasNonErrorEvent(buffer: string): boolean {
  const blocks = buffer.split("\n\n");
  // Skip the last block — it may be incomplete (no trailing \n\n).
  // If buffer ends with \n\n, the last element is "" (empty), which is safe to skip.
  // If buffer doesn't end with \n\n, the last element is a partial block we must skip.
  for (let i = 0; i < blocks.length - 1; i++) {
    const block = blocks[i];
    if (!block.trim()) continue;

    const lines = block.split("\n").filter(Boolean);
    let eventType = "";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataStr = line.slice(5).trimStart();
      }
    }

    // A non-error event type means the stream is legitimate
    if (eventType && eventType !== "error") {
      return true;
    }

    // No event type but valid JSON with a non-error type is also legitimate
    // (e.g., {"type":"message_start", ...})
    if (!eventType && dataStr) {
      try {
        const data = JSON.parse(dataStr);
        if (data?.type && data.type !== "error" && !SSE_ERROR_STATUS_MAP[data.type]) {
          return true;
        }
      } catch {
        // Not JSON — can't determine, don't short-circuit
      }
    }
  }

  return false;
}

/** Build a synthetic JSON error response to replace the SSE stream. */
function makeSyntheticErrorResponse(info: SseErrorInfo, originalHeaders: Headers): Response {
  // Use Anthropic-style error envelope so it's consistent with non-SSE errors
  // from the same upstream. This way the client sees the same error format
  // regardless of whether the upstream returned 529 directly or via SSE.
  const body = JSON.stringify({
    type: "error",
    error: {
      type: info.type,
      message: info.message,
    },
  });

  const headers = new Headers({
    "content-type": "application/json",
  });

  // Preserve useful headers from the original SSE response
  for (const h of [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ]) {
    const v = originalHeaders.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(body, {
    status: info.status,
    headers,
  });
}

/**
 * Reconstruct the response stream by prepending buffered chunks to the
 * remaining unread stream. This ensures legitimate SSE streams are passed
 * through byte-for-byte unchanged — the client sees exactly what the upstream
 * sent, just with a tiny delay from the peek.
 */
function reconstructStream(
  resp: Response,
  bufferedChunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Response {
  const reconstructed = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit buffered chunks first (the bytes we already read while peeking)
      for (const chunk of bufferedChunks) {
        controller.enqueue(chunk);
      }

      // Continue reading from where we left off
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      })();
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch {}
    },
  });

  return new Response(reconstructed, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
