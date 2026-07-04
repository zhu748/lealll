import { normalizeTimerMs } from "./retry.js";

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
          timeoutTimer = setTimeout(() => resolve("timeout"), remainingMs);
        }),
      ]).finally(() => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
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
    clearTimeout(timer);
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
    clearTimeout(timer);
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
