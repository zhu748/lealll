/** Bounded proxy-list response reads and source-fetch concurrency. */
import { parseStrictNonNegativeInteger } from "../utils/numbers.js";
import { PROXY_POOL as PROXY_POOL_CONST } from "../utils/constants.js";
import { hostSetTimeout, hostClearTimeout } from "../utils/host-timers.js";

const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const PROXY_POOL_ERROR_MAX_CHARS = 500;
const DEFAULT_SOURCE_FETCH_CONCURRENCY = 5;
const MAX_SOURCE_FETCH_CONCURRENCY = 20;

export function resolveProxySourceMaxBytes(raw = process.env.ZCODE_PROXY_POOL_MAX_SOURCE_BYTES): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_SOURCE_BYTES;
  return parseStrictNonNegativeInteger(raw) ?? DEFAULT_MAX_SOURCE_BYTES;
}

export function resolveSourceFetchConcurrency(raw = process.env.ZCODE_PROXY_POOL_SOURCE_CONCURRENCY): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_SOURCE_FETCH_CONCURRENCY;
  const n = parseStrictNonNegativeInteger(raw);
  if (n === undefined) return DEFAULT_SOURCE_FETCH_CONCURRENCY;
  return Math.max(1, Math.min(MAX_SOURCE_FETCH_CONCURRENCY, n));
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export function truncateProxyPoolError(message: string): string {
  if (message.length <= PROXY_POOL_ERROR_MAX_CHARS) return message;
  const omitted = message.length - PROXY_POOL_ERROR_MAX_CHARS;
  return `${message.slice(0, PROXY_POOL_ERROR_MAX_CHARS)}...(truncated ${omitted} chars)`;
}

function normalizeSourceReadTimeoutMs(raw: number): number {
  const safe = Number.isFinite(raw) && raw > 0 ? raw : PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS;
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(safe)));
}

async function readSourceChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  const timeout = normalizeSourceReadTimeoutMs(timeoutMs);
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
    const err = new Error(`proxy source response read timeout after ${timeout}ms`);
    void reader.cancel(err).catch(() => {});
    throw err;
  }
  return result;
}

export async function readProxySourceText(
  resp: Response,
  maxBytes = resolveProxySourceMaxBytes(),
  timeoutMs: number = PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS,
): Promise<string> {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const declaredLength = parseStrictNonNegativeInteger(resp.headers.get("content-length"));
  if (limit > 0 && declaredLength !== undefined && declaredLength > limit) {
    try { await resp.body?.cancel(); } catch {}
    throw new Error(`proxy source response exceeds ${limit} byte limit (content-length ${declaredLength})`);
  }
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const fragments: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readSourceChunkWithTimeout(reader, timeoutMs);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (limit > 0 && total > limit) {
        try { await reader.cancel(); } catch {}
        throw new Error(`proxy source response exceeds ${limit} byte limit`);
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  fragments.push(decoder.decode());
  return fragments.join("");
}

export async function _readProxySourceTextForTesting(resp: Response, maxBytes: number, timeoutMs?: number): Promise<string> {
  return readProxySourceText(resp, maxBytes, timeoutMs);
}
