import { errorResponse } from "../proxy/translated-response.js";

export const MAX_ADMIN_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_ACCOUNT_IMPORT_BODY_BYTES = 3 * 1024 * 1024;
export const MAX_PROXY_IMPORT_TEXT_BODY_BYTES = 12 * 1024 * 1024;

const DEFAULT_ADMIN_BODY_IDLE_TIMEOUT_MS = 30_000;

let adminBodyIdleTimeoutMsForTesting: number | undefined;

export function setAdminBodyIdleTimeoutForTesting(timeoutMs?: number): void {
  adminBodyIdleTimeoutMsForTesting = typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : undefined;
}

function parseDeclaredContentLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

export async function readJsonBody<T = unknown>(
  req: Request,
  options: { maxBytes?: number; idleTimeoutMs?: number } = {},
): Promise<{ ok: true; body: T } | { ok: false; error: Response }> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? MAX_ADMIN_BODY_BYTES));
  const idleTimeoutMs = Math.max(1, Math.floor(
    options.idleTimeoutMs ?? adminBodyIdleTimeoutMsForTesting ?? DEFAULT_ADMIN_BODY_IDLE_TIMEOUT_MS,
  ));
  const declaredLength = parseDeclaredContentLength(req.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    void req.body?.cancel().catch(() => {});
    return { ok: false, error: errorResponse(413, "request_too_large", `Request body exceeds ${maxBytes} byte limit`) };
  }

  const reader = req.body?.getReader();
  if (!reader) {
    try { return { ok: true, body: {} as T }; } catch { return { ok: false, error: errorResponse(400, "invalid_request", "Empty body") }; }
  }

  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await readRequestBodyChunk(reader, idleTimeoutMs);
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { ok: false, error: errorResponse(413, "request_too_large", `Request body exceeds ${maxBytes} byte limit`) };
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof AdminBodyTimeoutError) {
      return { ok: false, error: errorResponse(408, "request_timeout", `Request body read timed out after ${idleTimeoutMs}ms`) };
    }
    return { ok: false, error: errorResponse(400, "invalid_request", `Failed to read body: ${(e as Error).message}`) };
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }

  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (!text) return { ok: true, body: {} as T };
  try {
    return { ok: true, body: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: errorResponse(400, "invalid_request", `Invalid JSON: ${(e as Error).message}`) };
  }
}

class AdminBodyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`request body read timed out after ${timeoutMs}ms`);
    this.name = "AdminBodyTimeoutError";
  }
}

async function readRequestBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AdminBodyTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } catch (err) {
    void reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}
