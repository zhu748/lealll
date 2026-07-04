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
import { waitForBackpressure } from "../utils/sse.js";

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

interface SseBufferInspection {
  errorInfo: SseErrorInfo | null;
  hasLegitimateProgress: boolean;
}

/** Maximum bytes to buffer while peeking for an error event. 16KB is enough
 *  for any error event — they're always sent before generation starts. */
const MAX_PEEK_BYTES = 16 * 1024;
const MAX_JSON_EMPTY_INSPECT_BYTES = 2 * 1024 * 1024;

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

function isCompressedContentEncoding(value: string | null): boolean {
  return !!value && value.trim().toLowerCase() !== "identity";
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

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

  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();

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
    const ce = resp.headers.get("content-encoding");
    if (isCompressedContentEncoding(ce)) return resp;
    return detectEmptyJsonAndConvert(resp);
  }

  if (!ct.includes("text/event-stream")) return resp;

  // Skip compressed streams — we can't decode gzip/br as UTF-8.
  // SSE streams are almost never compressed, so this is a rare edge case.
  const ce = resp.headers.get("content-encoding");
  if (isCompressedContentEncoding(ce)) return resp;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let peekedBytes = 0;
  const bufferedChunks: Uint8Array[] = [];
  // Track whether we saw ANY complete SSE event (terminated by \n\n) inside
  // the buffer. If the stream ends with zero complete events, the upstream
  // gave us an empty SSE response — most likely a quota-exhausted gateway
  // closing the connection without emitting any data.
  let sawAnyCompleteEvent = false;

  try {
    while (peekedBytes < MAX_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bufferedChunks.push(value);
      const remainingBytes = MAX_PEEK_BYTES - peekedBytes;
      const peekChunk = value.byteLength > remainingBytes
        ? value.subarray(0, remainingBytes)
        : value;
      peekedBytes += peekChunk.byteLength;
      buffer += decoder.decode(peekChunk, { stream: true });

      // Inspect complete SSE blocks once per peek. Error events win over
      // keepalive/progress detection; ping-only streams keep peeking.
      const inspection = inspectSseBuffer(buffer);
      if (inspection.errorInfo) {
        // Found an error — cancel the stream and return synthetic response
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
        return makeSyntheticErrorResponse(inspection.errorInfo, resp.headers);
      }

      // Check for a legitimate (non-error) event — stop peeking, pass through
      if (inspection.hasLegitimateProgress) {
        sawAnyCompleteEvent = true;
        break;
      }

      if (peekChunk.byteLength < value.byteLength) break;
    }
    // If we hit the peek cap without finding an error or a complete event,
    // pass through unchanged. A very large first SSE event can legitimately
    // exceed the detector window; converting it to an empty-stream 529 would
    // be a false positive. The cap is enforced in bytes for the decoded
    // inspection buffer, while `bufferedChunks` retains the original bytes so
    // the downstream response stays byte-for-byte intact.
    if (peekedBytes >= MAX_PEEK_BYTES) {
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
  // correctly distinguishes "legitimate stream with message_start/content" from
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
    try { reader.releaseLock(); } catch {}
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
  // Read at most a small preview. Empty/content-less JSON responses are tiny;
  // large legitimate batch completions should not be fully buffered merely
  // for this retry heuristic.
  const declaredLength = parseContentLength(resp.headers);
  if (declaredLength !== undefined && declaredLength > MAX_JSON_EMPTY_INSPECT_BYTES) {
    return resp;
  }
  const reader = resp.body?.getReader();
  if (!reader) return resp;

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > MAX_JSON_EMPTY_INSPECT_BYTES) {
        return reconstructStream(resp, chunks, reader);
      }
    }
  } catch {
    return reconstructStream(resp, chunks, reader);
  }
  try { reader.releaseLock(); } catch {}

  const raw = decodeChunks(chunks);

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

function normalizeSseNewlines(buffer: string): string {
  return buffer.indexOf("\r") >= 0
    ? buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    : buffer;
}

/**
 * Inspect complete SSE blocks in the peek buffer.
 *
 * The previous implementation called parseSseError(buffer) and then
 * hasNonErrorEvent(buffer). Both normalized and split the whole buffer on every
 * peek chunk. Streams delivered as many tiny chunks could repeatedly allocate
 * arrays and rescan the same bytes. This single pass preserves behavior:
 *   1. Standard Anthropic:  event: error\ndata: {"type":"error","error":{"type":"overloaded_error",...}}
 *   2. Bare data:           data: {"type":"error","error":{"type":"overloaded_error",...}}
 *   3. Direct error type:   data: {"type":"overloaded_error","message":"..."}
 *   4. Raw JSON (no SSE):   {"type":"overloaded_error","message":"..."}
 */
function inspectSseBuffer(buffer: string): SseBufferInspection {
  const normalized = normalizeSseNewlines(buffer);
  let hasLegitimateProgress = false;
  let start = 0;

  for (;;) {
    const end = normalized.indexOf("\n\n", start);
    if (end < 0) break;

    const block = normalized.slice(start, end);
    start = end + 2;

    const blockResult = inspectCompleteSseBlock(block);
    if (blockResult.errorInfo) {
      return { errorInfo: blockResult.errorInfo, hasLegitimateProgress };
    }
    if (blockResult.hasLegitimateProgress) {
      hasLegitimateProgress = true;
    }
  }

  // If no SSE framing found, try parsing the whole buffer as raw JSON.
  // Some gateways send the error body without SSE framing at all.
  const trimmed = normalized.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const info = extractErrorFromJson(trimmed, "");
    if (info) return { errorInfo: info, hasLegitimateProgress };
  }

  return { errorInfo: null, hasLegitimateProgress };
}

function inspectCompleteSseBlock(block: string): SseBufferInspection {
  if (!block.trim()) return { errorInfo: null, hasLegitimateProgress: false };

  let eventType = "";
  const dataLines: string[] = [];
  let lineStart = 0;

  for (;;) {
    const lineEnd = block.indexOf("\n", lineStart);
    const line = lineEnd < 0 ? block.slice(lineStart) : block.slice(lineStart, lineEnd);
    lineStart = lineEnd < 0 ? block.length + 1 : lineEnd + 1;

    if (line) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Handles both "data:" and "data: "
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (lineEnd < 0) break;
  }

  const dataStr = dataLines.join("\n");
  if (dataStr) {
    const info = extractErrorFromJson(dataStr, eventType);
    if (info) return { errorInfo: info, hasLegitimateProgress: false };
  }

  // `ping` is only a keepalive. Keep peeking until we see a real content or
  // lifecycle event; otherwise a ping-before-error stream can bypass retry.
  if (isLegitimateProgressEvent(eventType)) {
    return { errorInfo: null, hasLegitimateProgress: true };
  }

  if (dataStr === "[DONE]") {
    return { errorInfo: null, hasLegitimateProgress: true };
  }

  // No event type but valid JSON with a real progress type is also legitimate
  // (e.g., {"type":"message_start", ...}). OpenAI Chat Completions streams
  // also omit the `event:` field and rely on `data: {"choices":[...]}` chunks.
  if (!eventType && dataStr) {
    try {
      const data = JSON.parse(dataStr);
      if (isLegitimateProgressPayload(data)) {
        return { errorInfo: null, hasLegitimateProgress: true };
      }
    } catch {
      // Not JSON — can't determine, don't short-circuit.
    }
  }

  return { errorInfo: null, hasLegitimateProgress: false };
}

/** Try to extract error info from a JSON string. Returns null if not an error. */
function extractErrorFromJson(jsonStr: string, eventType: string): SseErrorInfo | null {
  const trimmed = jsonStr.trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  let data: any;
  try {
    data = JSON.parse(trimmed);
  } catch (err) {
    // Log malformed JSON in SSE error events so silent passthrough of
    // garbage streams can be diagnosed. Previously these were swallowed.
    console.warn(`[sse-error] malformed JSON in SSE error event: ${(err as Error).message}; payload=${trimmed.slice(0, 200)}`);
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

function isLegitimateProgressEvent(type: unknown): boolean {
  if (typeof type !== "string") return false;
  return type === "message_start"
    || type === "message_delta"
    || type === "message_stop"
    || type === "content_block_start"
    || type === "content_block_delta"
    || type === "content_block_stop"
    || type === "response.created"
    || type === "response.in_progress"
    || type === "response.output_item.added"
    || type === "response.output_item.done"
    || type === "response.content_part.added"
    || type === "response.content_part.done"
    || type === "response.output_text.delta"
    || type === "response.output_text.done"
    || type === "response.function_call_arguments.delta"
    || type === "response.function_call_arguments.done"
    || type === "response.custom_tool_call_input.delta"
    || type === "response.custom_tool_call_input.done"
    || type === "response.completed"
    || type === "response.incomplete"
    || type === "response.failed";
}

function isLegitimateProgressPayload(data: any): boolean {
  if (isLegitimateProgressEvent(data?.type)) return true;

  // OpenAI Chat Completions streaming:
  //   data: {"object":"chat.completion.chunk","choices":[...]}
  // The final include_usage chunk may carry `choices: []` with a usage object.
  if (data?.object === "chat.completion.chunk" && Array.isArray(data.choices)) return true;
  if (Array.isArray(data?.choices) && data.choices.length > 0) return true;
  if (Array.isArray(data?.choices) && data?.usage && typeof data.usage === "object") return true;

  // OpenAI Responses streaming usually has an event name, but the payload's
  // `type` is authoritative. Keep this tolerant for event-stripped proxies.
  if (typeof data?.type === "string" && data.type.startsWith("response.")) return true;

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
  // v0.2.2+ FIX: track stream state so cancel() / error() / close() calls
  // don't throw "Cannot X an already-closed stream". Without this guard,
  // a client abort (cancel) racing with the async read loop's controller.error
  // would surface an uncaught exception — rare in production but visible
  // under high concurrency / flaky networks.
  let streamClosed = false;
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (streamClosed) return;
    streamClosed = true;
    try { controller.close(); } catch { /* already closed */ }
  };
  const safeError = (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown) => {
    if (streamClosed) return;
    streamClosed = true;
    try { controller.error(err); } catch { /* already closed */ }
  };
  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    if (streamClosed) return;
    try { controller.enqueue(chunk); } catch { /* already closed — drop */ }
  };

  const reconstructed = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit buffered chunks first (the bytes we already read while peeking)
      for (const chunk of bufferedChunks) {
        safeEnqueue(controller, chunk);
      }

      // Continue reading from where we left off
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await waitForBackpressure(controller);
            safeEnqueue(controller, value);
          }
          safeClose(controller);
        } catch (err) {
          safeError(controller, err);
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      })();
    },
    cancel(reason) {
      // Mark closed so the async read loop's subsequent safeEnqueue/safeClose
      // calls become no-ops instead of throwing.
      streamClosed = true;
      void reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(reconstructed, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
