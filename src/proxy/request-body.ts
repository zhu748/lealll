import { normalizeTimerMs } from "./retry.js";
import { parseContentLength } from "./response-body.js";
// v0.3.7.1: host-captured timers — these guards/loops run per-request,
// often concurrent with captcha solve epochs; the bare globals resolve
// through the solver window alias there and get cancelled on window
// destruction (the 429-retry permanent hang). See utils/host-timers.ts.
import { hostClearTimeout, hostSetTimeout } from "../utils/host-timers.js";

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS = 30_000;

export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number, actualBytes: number) {
    super(`Request body is too large (${actualBytes} bytes, limit ${maxBytes} bytes)`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request body read timed out after ${timeoutMs}ms`);
    this.name = "RequestBodyTimeoutError";
  }
}

let requestBodyIdleTimeoutMsForTesting: number | undefined;

export function setRequestBodyIdleTimeoutForTesting(timeoutMs?: number): void {
  requestBodyIdleTimeoutMsForTesting = typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : undefined;
}

async function readRequestBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  const timeout = normalizeTimerMs(timeoutMs, DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    reader.read(),
    new Promise<"timeout">(resolve => {
      timer = hostSetTimeout(() => resolve("timeout"), timeout);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      hostClearTimeout(timer);
      timer = null;
    }
  });
  if (result === "timeout") {
    const err = new RequestBodyTimeoutError(timeout);
    void reader.cancel(err).catch(() => {});
    throw err;
  }
  return result;
}

/** Read the request body as a string, returning undefined for empty bodies. */
export async function readBody(req: Request, maxBytes: number): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const idleTimeoutMs = requestBodyIdleTimeoutMsForTesting ?? DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS;
  const declaredLength = parseContentLength(req.headers);
  if (limit > 0 && declaredLength !== undefined && declaredLength > limit) {
    void req.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError(limit, declaredLength);
  }
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readRequestBodyChunk(reader, idleTimeoutMs);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (limit > 0 && total > limit) {
        try { await reader.cancel(); } catch {}
        throw new RequestBodyTooLargeError(limit, total);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (total === 0) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
