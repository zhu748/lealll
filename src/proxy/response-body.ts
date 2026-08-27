import { normalizeTimerMs } from "./retry.js";
// v0.3.7.1: host-captured timers — these guards/loops run per-request,
// often concurrent with captcha solve epochs; the bare globals resolve
// through the solver window alias there and get cancelled on window
// destruction (the 429-retry permanent hang). See utils/host-timers.ts.
import { hostClearTimeout, hostSetTimeout } from "../utils/host-timers.js";

export class ResponseBodyTooLargeError extends Error {
  constructor(label: string, maxBytes: number, actualBytes: number) {
    super(`${label} is too large (${actualBytes} bytes, limit ${maxBytes} bytes)`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function isCompressedContentEncoding(value: string | null): boolean {
  return !!value && value.trim().toLowerCase() !== "identity";
}

/**
 * Content codings Bun's DecompressionStream can inflate. NOTE: "br" is
 * deliberately absent — Bun 1.3's DecompressionStream rejects it, so brotli
 * passthrough bodies stay compressed (stats observer off) and the caller
 * logs that token stats are unavailable.
 */
const DECOMPRESSIBLE_CONTENT_ENCODINGS = new Set(["gzip", "deflate", "zstd"]);

export interface DecompressedPassthrough {
  response: Response;
  /** True when the body was piped through DecompressionStream and the
   *  content-encoding/content-length headers were stripped. */
  decompressed: boolean;
  /** Raw content-encoding token when the body is compressed but NOT
   *  decompressible (e.g. "br") — caller logs a diagnosable warning. */
  unsupportedEncoding: string | null;
}

/**
 * v0.3.8.1: decompress a BYTE-PASSTHROUGH upstream response in-stream.
 *
 * Only call this on responses fetched with `decompress: false` (raw bytes).
 * Bun auto-decompressed responses (no decompress:false) keep the
 * content-encoding HEADER even though the body is already plaintext —
 * decompressing those again would corrupt the stream.
 *
 * gzip/deflate/zstd bodies are piped through DecompressionStream — the
 * decompressed stream is what stats observe, what the heartbeat can safely
 * inject comment lines into, and what the client receives (with
 * content-encoding/content-length stripped, since they no longer describe
 * the body). Streaming: no buffering beyond the codec's internal window.
 *
 * identity/absent → unchanged. br (unsupported by Bun) → unchanged with
 * unsupportedEncoding set so the caller can warn that token stats and the
 * SSE heartbeat are disabled for this response.
 */
export function decompressPassthroughResponse(resp: Response): DecompressedPassthrough {
  const rawEncoding = resp.headers.get("content-encoding");
  const encoding = rawEncoding?.trim().toLowerCase() ?? "";
  if (!encoding || encoding === "identity" || !resp.body) {
    return { response: resp, decompressed: false, unsupportedEncoding: null };
  }
  if (!DECOMPRESSIBLE_CONTENT_ENCODINGS.has(encoding)) {
    return { response: resp, decompressed: false, unsupportedEncoding: encoding };
  }
  let decoded: ReadableStream<Uint8Array>;
  try {
    const ds = new DecompressionStream(encoding as CompressionFormat);
    decoded = resp.body.pipeThrough(ds as unknown as TransformStream<Uint8Array, Uint8Array>);
  } catch {
    // Runtime without DecompressionStream (or codec init failure): pass the
    // raw bytes through untouched — same behavior as v0.3.7.
    return { response: resp, decompressed: false, unsupportedEncoding: encoding };
  }
  const headers = new Headers();
  for (const [k, v] of resp.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length") continue;
    headers.set(k, v);
  }
  return {
    response: new Response(decoded, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    }),
    decompressed: true,
    unsupportedEncoding: null,
  };
}

const utf8ByteLengthEncoder = new TextEncoder();
const utf8LogPreviewDecoder = new TextDecoder();

export function utf8ByteLength(value: string): number {
  return utf8ByteLengthEncoder.encode(value).byteLength;
}

export function truncateUtf8ForLog(value: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxBytes));
  const bytes = utf8ByteLengthEncoder.encode(value);
  if (bytes.byteLength <= limit) return { text: value, bytes: bytes.byteLength, truncated: false };
  let end = limit;
  while (end > 0 && bytes[end] !== undefined && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return {
    text: utf8LogPreviewDecoder.decode(bytes.subarray(0, end)),
    bytes: bytes.byteLength,
    truncated: true,
  };
}

export async function readResponseTextLimited(
  resp: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const declaredLength = parseContentLength(resp.headers);
  if (declaredLength !== undefined && declaredLength > limit) {
    void resp.body?.cancel().catch(() => {});
    throw new ResponseBodyTooLargeError(label, limit, declaredLength);
  }
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new ResponseBodyTooLargeError(label, limit, total);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface ResponseTextPreviewOptions {
  maxBytes: number;
  timeoutMs: number;
  clone?: boolean;
}

export interface ResponseTextPreview {
  text: string;
  truncated: boolean;
  timedOut: boolean;
  complete: boolean;
}

export async function readResponseTextPreview(
  resp: Response,
  opts: ResponseTextPreviewOptions,
): Promise<ResponseTextPreview> {
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes));
  const timeoutMs = normalizeTimerMs(opts.timeoutMs, 1_000);
  const shouldClone = opts.clone !== false;
  const declaredLength = parseContentLength(resp.headers);
  if (maxBytes > 0 && declaredLength !== undefined && declaredLength > maxBytes) {
    if (!shouldClone && resp.body) {
      void resp.body.cancel().catch(() => {});
    }
    return { text: "", truncated: true, timedOut: false, complete: false };
  }

  let source = resp;
  if (shouldClone) {
    try {
      source = resp.clone();
    } catch {
      return { text: "", truncated: false, timedOut: false, complete: false };
    }
  }
  if (!source.body || maxBytes === 0) {
    if (!shouldClone && source.body) {
      void source.body.cancel().catch(() => {});
    }
    return { text: "", truncated: false, timedOut: false, complete: !source.body };
  }

  const reader = source.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  let readBytes = 0;
  let truncated = false;
  let timedOut = false;
  let complete = false;

  try {
    while (readBytes < maxBytes) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timedOut = true;
        break;
      }
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">(resolve => {
          timeoutTimer = hostSetTimeout(() => resolve("timeout"), remainingMs);
        }),
      ]).finally(() => {
        if (timeoutTimer) {
          hostClearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
      });
      if (result === "timeout") {
        timedOut = true;
        break;
      }
      const { done, value } = result;
      if (done) {
        complete = true;
        break;
      }
      if (!value) continue;
      const remainingBytes = maxBytes - readBytes;
      const chunk = value.byteLength > remainingBytes ? value.slice(0, remainingBytes) : value;
      text += decoder.decode(chunk, { stream: true });
      readBytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    }
    if (readBytes >= maxBytes && !complete) truncated = true;
    const tail = decoder.decode();
    if (complete) text += tail;
  } finally {
    if (!shouldClone || !complete) {
      // Do not await cancel here. This preview often reads a branch produced by
      // ReadableStream.tee(); in Bun, canceling one branch can wait until the
      // passthrough branch is also canceled/consumed. Awaiting that would stall
      // the real request while the client is still reading the other branch.
      void reader.cancel().catch(() => {});
    }
    try { reader.releaseLock(); } catch {}
  }

  return { text, truncated, timedOut, complete };
}

export function wrapResponseBodyWithUpstreamTimeout(
  resp: Response,
  ctrl: AbortController,
  timer: ReturnType<typeof setTimeout>,
  timeoutMs: number,
): Response {
  if (!resp.body) {
    hostClearTimeout(timer);
    return resp;
  }

  const reader = resp.body.getReader();
  let finished = false;
  let streamClosed = false;
  let timedOut = false;
  let activeController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const timeoutError = () => new Error(`upstream timeout after ${timeoutMs}ms`);
  const cleanup = (releaseReader = true): void => {
    if (finished) return;
    finished = true;
    hostClearTimeout(timer);
    ctrl.signal.removeEventListener("abort", onAbort);
    if (releaseReader) {
      try { reader.releaseLock(); } catch {}
    }
  };
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (streamClosed) return;
    streamClosed = true;
    try { controller.close(); } catch {}
  };
  const safeError = (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown): void => {
    if (streamClosed) return;
    streamClosed = true;
    try { controller.error(err); } catch {}
  };
  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array): boolean => {
    if (streamClosed) return false;
    try {
      controller.enqueue(value);
      return true;
    } catch (err) {
      safeError(controller, err);
      return false;
    }
  };
  const onAbort = (): void => {
    if (finished) return;
    timedOut = true;
    const controller = activeController;
    cleanup(false);
    if (controller) {
      safeError(controller, timeoutError());
    }
    void reader.cancel(timeoutError()).catch(() => {}).finally(() => {
      try { reader.releaseLock(); } catch {}
    });
  };
  ctrl.signal.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        if (timedOut) safeError(controller, timeoutError());
        return;
      }
      if (ctrl.signal.aborted) {
        onAbort();
        return;
      }
      activeController = controller;
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          cleanup();
          safeClose(controller);
          return;
        }
        if (value && !safeEnqueue(controller, value)) {
          cleanup(false);
          void reader.cancel("downstream closed").catch(() => {}).finally(() => {
            try { reader.releaseLock(); } catch {}
          });
        }
      } catch (err) {
        if (finished) return;
        cleanup();
        safeError(controller, ctrl.signal.aborted ? timeoutError() : err);
      } finally {
        if (activeController === controller) activeController = null;
      }
    },
    async cancel(reason) {
      streamClosed = true;
      cleanup(false);
      ctrl.abort();
      try { await reader.cancel(reason); } catch {}
      try { reader.releaseLock(); } catch {}
    },
  });

  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

export function splitResponseForPreview(resp: Response): { preview: Response; passthrough: Response } | null {
  if (!resp.body) return null;
  try {
    const [previewBody, passthroughBody] = resp.body.tee();
    const init: ResponseInit = {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    };
    return {
      preview: new Response(previewBody, init),
      passthrough: new Response(passthroughBody, init),
    };
  } catch {
    return null;
  }
}
