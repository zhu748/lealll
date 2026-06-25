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
 *
 * EMPTY-STREAM DETECTION: if the upstream returns HTTP 200 + text/event-stream
 * but the stream is empty (no SSE events at all — typically happens when the
 * credential has run out of quota and the gateway closes the connection
 * immediately), we synthesize a 529 "overloaded_error" response. This makes
 * the existing retry logic kick in so the proxy can retry 3x then switch to
 * the next credential — instead of silently passing the empty 200 to the
 * client as if it were a valid response.
 */
export async function detectSseErrorAndConvert(resp: Response): Promise<Response> {
  if (!resp.body) return resp;
  if (resp.status !== 200) return resp;

  const ct = resp.headers.get("content-type") ?? "";

  // ----- Non-SSE 200 responses: detect empty / content-less JSON bodies -----
  //
  // Bugfix vceshi0.0.9: previously this function only inspected
  // text/event-stream responses. Non-streaming (batch) requests get
  // application/json back, and when quota is exhausted the upstream
  // gateway often returns HTTP 200 with an empty body, or `{}`, or a
  // JSON object missing the `content` / `choices` field. The detector
  // skipped these entirely → no retry → no credential switch → the
  // empty 200 was passed straight to the client.
  //
  // Symptom (user log):
  //   | #063 | ... | glm-5.2 | batch | 200 | 1019ms | in:- out:- |
  //
  // We now read the JSON body once, check for the Anthropic/OpenAI
  // "has real content" signals, and if absent convert to a synthetic
  // 529 with `x-zcode-empty-stream: 1` so the existing retry+switch
  // logic kicks in. The body is then reconstructed so any downstream
  // passthrough still has something to read.
  if (ct.includes("application/json")) {
    return detectEmptyJsonAndConvert(resp);
  }

  if (!ct.includes("text/event-stream")) return resp;

  // Skip compressed streams — we can't decode gzip/br as UTF-8.
  // SSE streams are almost never compressed, so this is a rare edge case.
  const ce = resp.headers.get("content-encoding");
  if (ce && ce !== "identity") return resp;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const bufferedChunks: Uint8Array[] = [];
  // Track whether we saw ANY complete SSE event (terminated by \n\n) inside
  // the buffer. If the stream ends with zero complete events, the upstream
  // gave us an empty SSE response — most likely a quota-exhausted gateway
  // closing the connection without emitting any data.
  let sawAnyCompleteEvent = false;

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
        sawAnyCompleteEvent = true;
        break;
      }
    }
    // If we exited the loop because buffer grew past MAX_PEEK_BYTES, we must
    // have seen at least one complete event (otherwise the loop would have
    // kept reading). Mark accordingly so the empty-stream check below doesn't
    // fire.
    if (buffer.length >= MAX_PEEK_BYTES) {
      sawAnyCompleteEvent = true;
    }
  } catch {
    // Read error — fall through to reconstruction with whatever we have
    // If we got at least some bytes, treat as non-empty.
    if (bufferedChunks.length > 0) sawAnyCompleteEvent = true;
  }

  // EMPTY-STREAM CHECK: if the stream ended with zero complete SSE events,
  // the upstream returned an empty (or whitespace/comment-only) 200 — treat
  // as a retryable error so the proxy retries + switches credentials instead
  // of passing the empty body to the client.
  //
  // vceshi0.0.9 BUGFIX: the old check required `bufferedChunks.length === 0`
  // (zero bytes read). But many quota-exhausted gateways don't return zero
  // bytes — they return a few bytes of whitespace, an SSE comment line
  // (`: keepalive\n\n`), or just `\n\n` (an empty event block). All of these
  // produce `bufferedChunks.length > 0` but `sawAnyCompleteEvent === false`.
  // The old check would fall through to `reconstructStream`, passing the
  // bogus 200 to the client — making the entire retry+switch machinery a
  // no-op for the most common empty-stream signature seen in production.
  //
  // The fix: trigger whenever we saw no real content event, regardless of
  // how many bytes were buffered. The `hasNonErrorEvent` check above already
  // correctly distinguishes "legitimate stream with ping/message_start" from
  // "only comments / whitespace / partial fragments".
  //
  // The user-visible symptom of this bug: "200 OK but no output" when a
  // credential runs out of quota. Claude Code / Codex CLI see a successful
  // HTTP response with an empty body and report "empty or malformed response".
  //
  // We map this to 529 (overloaded_error) because:
  //   1. 529 is in the default retryableStatuses ([529]), so retry kicks in
  //   2. 529 semantically means "upstream can't serve this right now" —
  //      which matches "quota exhausted, gateway returned nothing"
  //   3. The retry loop in handler.ts counts 529s toward the empty-response
  //      counter, triggering credential switch after 3 consecutive empties
  if (!sawAnyCompleteEvent) {
    try { await reader.cancel(); } catch {}
    const emptyInfo: SseErrorInfo = {
      type: "overloaded_error",
      status: 529,
      message: "Upstream returned an empty SSE stream (likely quota exhausted). Retrying with the same credential; will switch to next credential after 3 consecutive empty responses.",
      rawBody: "",
    };
    const synthetic = makeSyntheticErrorResponse(emptyInfo, resp.headers);
    // Tag the synthetic response so handler.ts can distinguish "real 529"
    // from "empty-stream 529" and apply the dedicated empty-response retry
    // policy (3 retries then credential switch) instead of the generic one.
    synthetic.headers.set("x-zcode-empty-stream", "1");
    return synthetic;
  }

  // No error found — reconstruct the stream with buffered bytes prepended
  return reconstructStream(resp, bufferedChunks, reader);
}

/**
 * Detect empty / content-less non-SSE JSON 200 responses.
 *
 * Anthropic non-streaming responses should contain `content: [...]` (an array
 * of content blocks, possibly empty if the model refused but still present).
 * OpenAI non-streaming responses should contain `choices: [...]`. If the
 * upstream returns 200 + JSON that:
 *   - has an empty body
 *   - parses to `{}` or any non-object
 *   - is an object missing BOTH `content` and `choices` (no recognizable
 *     response shape at all)
 *   - is an object with `content: []` AND no `output_text` AND no `usage`
 *     (Anthropic empty content with no usage — clearly a quota-exhausted
 *     signature, not a legitimate "model refused" response which would
 *     still include usage stats)
 *
 * we treat it as an empty response and convert to a synthetic 529 with
 * `x-zcode-empty-stream: 1`, mirroring the SSE path.
 *
 * Returns the original response unchanged if it looks legitimate OR if it
 * already contains an `error` field (the SSE error path covers those, but
 * just in case a non-SSE 200 has an inline error we leave it alone — the
 * existing error passthrough in handler.ts surfaces it to the client).
 */
async function detectEmptyJsonAndConvert(resp: Response): Promise<Response> {
  // Read the body once. We'll reconstruct the response either way so
  // downstream passthrough still has access to the bytes.
  let raw = "";
  try {
    raw = await resp.text();
  } catch {
    // Body read failed — can't inspect, pass through unchanged
    return resp;
  }

  // Trim whitespace — empty body is the most common case
  const trimmed = raw.trim();

  // Case 1: completely empty body
  if (trimmed === "") {
    return makeEmptyJson529(resp.headers, raw);
  }

  // Try to parse as JSON. If it's not valid JSON, that's a malformed 200 —
  // treat as empty too (the client can't make sense of it either).
  let data: any;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Malformed JSON in a 200 response — treat as empty.
    // This happens when the upstream gateway truncates mid-stream due to
    // connection drop or quota cutoff.
    return makeEmptyJson529(resp.headers, raw);
  }

  // Non-object JSON (e.g. `null`, `[]`, `"string"`, `42`) — not a valid
  // Anthropic/OpenAI response shape.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return makeEmptyJson529(resp.headers, raw);
  }

  // If the response already carries an error field, leave it alone — the
  // existing passthrough in handler.ts will surface it to the client with
  // the proper error structure.
  if (data.error && typeof data.error === "object") {
    return reconstructJsonResponse(resp, raw);
  }

  // Check for legitimate Anthropic non-streaming response:
  //   { "content": [...], "usage": {...}, ... }
  // Empty content is allowed IF usage is present (model refused / stopped
  // immediately). But empty content + no usage = clearly broken.
  const hasAnthropicContent = Array.isArray(data.content) && data.content.length > 0;
  const hasAnthropicUsage = data.usage && typeof data.usage === "object";
  const hasOutputText = typeof data.output_text === "string" && data.output_text.length > 0;

  // Check for legitimate OpenAI non-streaming response:
  //   { "choices": [...], ... }
  const hasOpenAIChoices = Array.isArray(data.choices) && data.choices.length > 0;

  // Check for legitimate Responses API shape:
  //   { "output": [...], ... }
  const hasResponsesOutput = Array.isArray(data.output) && data.output.length > 0;

  if (hasAnthropicContent || hasAnthropicUsage || hasOutputText ||
      hasOpenAIChoices || hasResponsesOutput) {
    // Looks like a real response — pass through unchanged
    return reconstructJsonResponse(resp, raw);
  }

  // None of the legitimate-content signals present → empty/malformed 200
  return makeEmptyJson529(resp.headers, raw);
}

/** Build a synthetic 529 + x-zcode-empty-stream response for non-SSE paths. */
function makeEmptyJson529(originalHeaders: Headers, originalBody: string): Response {
  const emptyInfo: SseErrorInfo = {
    type: "overloaded_error",
    status: 529,
    message: "Upstream returned an empty or content-less JSON response (likely quota exhausted). Retrying with the same credential; will switch to next credential after 3 consecutive empty responses.",
    rawBody: originalBody.slice(0, 500),
  };
  const synthetic = makeSyntheticErrorResponse(emptyInfo, originalHeaders);
  synthetic.headers.set("x-zcode-empty-stream", "1");
  return synthetic;
}

/** Reconstruct a JSON response with the already-read body so downstream
 *  passthrough still has access to the bytes. */
function reconstructJsonResponse(resp: Response, body: string): Response {
  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
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
  } catch (err) {
    // Log malformed JSON in SSE error events so silent passthrough of
    // garbage streams can be diagnosed. Previously these were swallowed.
    console.warn(`[sse-error] malformed JSON in SSE error event: ${(err as Error).message}; payload=${jsonStr.slice(0, 200)}`);
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
