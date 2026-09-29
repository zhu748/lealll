/**
 * Global Proxy Pool
 *
 * A persistent, refreshable pool of outbound HTTP proxies shared across all
 * accounts. The pool is consulted ONLY when an account has no per-account
 * proxy override (`cred.proxy`) — single-account proxy always wins over the
 * pool, mirroring the "优先级低于单账号设置的代理" requirement.
 *
 * Sources:
 *   - Manual proxies: added one-by-one or pasted/imported from a txt file.
 *   - URL imports: one or more remote txt lists (one proxy per line), e.g.
 *     https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.txt
 *
 * The pool auto-refreshes from the configured URL sources on a configurable
 * interval (default 5 minutes). A manual refresh returns the count of
 * added / removed / total proxies so the dashboard can show "本次更新新增 X，
 * 删除 Y".
 *
 * Proxy format expected (one per line):
 *   - `http://host:port`
 *   - `https://host:port`
 *   - `socks4://host:port`
 *   - `socks4a://host:port`
 *   - `socks5://host:port`
 *   - `socks5h://host:port`
 *   - `host:port`           (defaults to http://)
 *   - `user:pass@host:port` (credentials embedded)
 *
 * Lines starting with `#` are ignored. Empty lines are ignored.
 *
 * Persistence: ~/.zcode-proxy/proxy-pool.json (configurable via
 * ZCODE_PROXY_STORE_DIR). The file contains:
 *   {
 *     "version": 1,
 *     "config": { enabled, refreshIntervalMin, sourceUrls, rotateOnGatewayBlock },
 *     "proxies": [{ id, url, source, addedAt }],
 *     "lastRefreshAt": 1234567890,
 *     "lastRefreshResult": { added, removed, total, at }
 *   }
 *
 * Rotation: when the handler detects a 405 / WAF block (gateway interception),
 * it calls `pool.next(excluding)` to rotate to a different proxy and retries
 * the request. The current cursor is per-request (in-memory), so concurrent
 * requests use different proxies.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { validateProxyUrl } from "../auth/store.js";
import { PROXY_POOL as PROXY_POOL_CONST } from "../utils/constants.js";
import { runtimeLog, runtimeWarn } from "../utils/log.js";
import { wrapFetchWithSocksBridge } from "./proxied-fetch.js";
// v0.3.7.1: host-captured timers — these guards/loops run per-request,
// often concurrent with captcha solve epochs; the bare globals resolve
// through the solver window alias there and get cancelled on window
// destruction (the 429-retry permanent hang). See utils/host-timers.ts.
import { hostClearInterval, hostClearTimeout, hostSetInterval, hostSetTimeout } from "../utils/host-timers.js";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

/** A single proxy entry in the pool. */
export interface PoolProxy {
  /** Stable unique id (sha-ish 12-char hex of the normalized URL). */
  id: string;
  /** Normalized URL (always with scheme). */
  url: string;
  /** Source: "manual" | "url:<n>" where n is the source URL index. */
  source: string;
  /** When this entry was added (Unix ms). */
  addedAt: number;
  /** Optional human-readable label (e.g. the original line for non-URL form). */
  note?: string;
  /**
   * Consecutive failure counter (incremented on rotation due to gateway
   * block). Used to deprioritize bad proxies without removing them.
   */
  failures?: number;
  /** Last time this proxy was used (Unix ms). */
  lastUsedAt?: number;
  /**
   * v0.2.2+: Timestamp of the last markProxyFailed call. Used by pickProxy
   * to skip recently-failed proxies (FAILURE_COOLDOWN_MS). Not set on
   * freshly-imported proxies — they're eligible immediately.
   */
  lastFailedAt?: number;
}

/** Pool configuration. */
export interface ProxyPoolConfig {
  /** Master switch. When false, the pool is not consulted at all. */
  enabled: boolean;
  /** Auto-refresh interval in minutes. 0 = disabled. Default 5. */
  refreshIntervalMin: number;
  /** URL sources for auto-refresh. Empty = no URL sources. */
  sourceUrls: string[];
  /**
   * Whether to rotate proxies on 405 / WAF gateway block errors. When true
   * (default), the handler will pick a different proxy and retry the request.
   */
  rotateOnGatewayBlock: boolean;
  /**
   * Maximum retries via different proxies on a gateway block before giving
   * up. Default 3. Set to 0 to disable proxy rotation entirely (the pool
   * is still consulted for the INITIAL proxy choice).
   */
  maxRotations: number;
}

/** Result of a refresh operation. */
export interface RefreshResult {
  /** Number of new proxies added in this refresh. */
  added: number;
  /** Number of proxies removed (no longer in any source). */
  removed: number;
  /** Total proxies in the pool after refresh. */
  total: number;
  /** When the refresh happened (Unix ms). */
  at: number;
  /** Per-source errors (if any), keyed by source URL. */
  errors?: Record<string, string>;
}

/** On-disk file format. */
interface PoolFile {
  version: 1;
  config: ProxyPoolConfig;
  proxies: PoolProxy[];
  lastRefreshAt?: number;
  lastRefreshResult?: RefreshResult;
}

// --------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------

function resolveStoreDir(): string {
  return process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy");
}

let STORE_DIR = resolveStoreDir();
let POOL_FILE = join(STORE_DIR, "proxy-pool.json");

const DEFAULT_CONFIG: ProxyPoolConfig = {
  enabled: false,
  refreshIntervalMin: 5,
  sourceUrls: [],
  rotateOnGatewayBlock: true,
  maxRotations: 3,
};
const MAX_TIMER_MS = 2_147_483_647;
const MAX_REFRESH_INTERVAL_MIN = Math.floor(2_147_483_647 / 60_000);
const MAX_PROXY_ROTATIONS = 20;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeNonNegativeInt(raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = parseStrictNonNegativeInteger(raw);
  if (n === undefined) return fallback;
  return Math.min(n, max);
}

function normalizeOptionalNonNegativeInt(raw: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const n = normalizeNonNegativeInt(raw, -1, max);
  return n >= 0 ? n : undefined;
}

function normalizeSourceUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const validation = validateProxySourceUrl(value);
    if (!validation.ok || seen.has(validation.url)) continue;
    seen.add(validation.url);
    out.push(validation.url);
  }
  return out;
}

export function validateProxySourceUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "source URL cannot be empty" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: `Invalid source URL: ${trimmed}` };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return { ok: false, message: `Source URL scheme "${parsed.protocol}" is not allowed. Use http:// or https://` };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, message: "Source URL is missing a hostname" };
  if (parsed.port === "0") return { ok: false, message: "Source URL port must be between 1 and 65535" };

  const blocked = sourceUrlHostBlockReason(host);
  if (blocked) {
    return {
      ok: false,
      message: `Source URL host "${host}" is a ${blocked} — fetching proxy lists from cloud metadata or unspecified addresses is blocked.`,
    };
  }

  return { ok: true, url: trimmed };
}

function sourceUrlHostBlockReason(host: string): string | null {
  const ipHost = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipHost)) {
    const parts = ipHost.split(".").map(Number);
    if (parts.some(p => p > 255)) return null;
    const [a, b] = parts;
    if (a === 0) return "0.0.0.0/8 unspecified address";
    if (a === 169 && b === 254) return "169.254/16 link-local / cloud metadata endpoint";
    return null;
  }
  const lower = ipHost.toLowerCase();
  if (lower === "::") return ":: unspecified";
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return "fe80::/10 IPv6 link-local";
  }
  return null;
}

function cloneProxyPoolConfig(config: ProxyPoolConfig): ProxyPoolConfig {
  return {
    ...config,
    sourceUrls: normalizeSourceUrls(config.sourceUrls),
  };
}

function normalizeProxyPoolConfig(config?: Partial<ProxyPoolConfig> | null): ProxyPoolConfig {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config ?? {}),
  };
  return {
    enabled: normalizeBoolean(merged.enabled, DEFAULT_CONFIG.enabled),
    refreshIntervalMin: normalizeNonNegativeInt(
      merged.refreshIntervalMin,
      DEFAULT_CONFIG.refreshIntervalMin,
      MAX_REFRESH_INTERVAL_MIN,
    ),
    sourceUrls: normalizeSourceUrls(merged.sourceUrls),
    rotateOnGatewayBlock: normalizeBoolean(
      merged.rotateOnGatewayBlock,
      DEFAULT_CONFIG.rotateOnGatewayBlock,
    ),
    maxRotations: normalizeNonNegativeInt(
      merged.maxRotations,
      DEFAULT_CONFIG.maxRotations,
      MAX_PROXY_ROTATIONS,
    ),
  };
}

function cloneRefreshResult(result?: RefreshResult): RefreshResult | undefined {
  if (!result) return undefined;
  return {
    ...result,
    errors: result.errors ? { ...result.errors } : undefined,
  };
}

function normalizeRefreshErrors(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const sourceUrl = typeof key === "string" ? key.trim() : "";
    if (!sourceUrl || typeof value !== "string") continue;
    try {
      new URL(sourceUrl);
    } catch {
      continue;
    }
    out[sourceUrl] = truncateProxyPoolError(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRefreshResult(raw: unknown, fallbackAt?: number): RefreshResult | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const at = normalizeOptionalNonNegativeInt(r.at) ?? fallbackAt;
  if (at === undefined) return undefined;
  return {
    added: normalizeOptionalNonNegativeInt(r.added) ?? 0,
    removed: normalizeOptionalNonNegativeInt(r.removed) ?? 0,
    total: normalizeOptionalNonNegativeInt(r.total) ?? 0,
    at,
    errors: normalizeRefreshErrors(r.errors),
  };
}

const ALLOWED_SCHEMES = ["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"];
const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const PROXY_POOL_ERROR_MAX_CHARS = 500;
const DEFAULT_SOURCE_FETCH_CONCURRENCY = 5;
const MAX_SOURCE_FETCH_CONCURRENCY = 20;
const DEFAULT_POOL_MTIME_CHECK_INTERVAL_MS = 1000;
const MIN_POOL_MTIME_CHECK_INTERVAL_MS = 100;
const MAX_POOL_MTIME_CHECK_INTERVAL_MS = 60_000;

// --------------------------------------------------------------------
// In-memory state + cache
// --------------------------------------------------------------------

let cachedPool: PoolFile | null = null;
let cachedMtimeMs = -1;
let cachedCtimeMs = -1;
let cachedSize = -1;
let lastMtimeCheckAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshInFlight = false;
let refreshSourcesInFlight: Promise<RefreshResult> | null = null;
let roundRobinCursor = 0;
const POOL_MTIME_CHECK_INTERVAL_MS = resolvePoolMtimeCheckIntervalMs();

function parseStrictNonNegativeInteger(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function resolvePoolMtimeCheckIntervalMs(raw = process.env.ZCODE_PROXY_POOL_MTIME_CHECK_MS): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_POOL_MTIME_CHECK_INTERVAL_MS;
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_POOL_MTIME_CHECK_INTERVAL_MS;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return DEFAULT_POOL_MTIME_CHECK_INTERVAL_MS;
  return Math.max(
    MIN_POOL_MTIME_CHECK_INTERVAL_MS,
    Math.min(MAX_POOL_MTIME_CHECK_INTERVAL_MS, n),
  );
}

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

async function mapWithConcurrency<T, R>(
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

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

function truncateProxyPoolError(message: string): string {
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

async function readProxySourceText(
  resp: Response,
  maxBytes = resolveProxySourceMaxBytes(),
  timeoutMs: number = PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS,
): Promise<string> {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const declaredLength = parseContentLength(resp.headers);
  if (limit > 0 && declaredLength !== undefined && declaredLength > limit) {
    try { await resp.body?.cancel(); } catch {}
    throw new Error(`proxy source response exceeds ${limit} byte limit (content-length ${declaredLength})`);
  }
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
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

export async function _readProxySourceTextForTesting(resp: Response, maxBytes: number, timeoutMs?: number): Promise<string> {
  return readProxySourceText(resp, maxBytes, timeoutMs);
}

/**
 * Sticky proxy — the proxy that's currently "working" and should be reused
 * for subsequent requests until it fails (405/WAF/network error). When set,
 * `pickProxy` returns this proxy instead of advancing the round-robin cursor.
 *
 * Set by `pickProxy` whenever it picks a new proxy. Cleared by
 * `markProxyFailed` when the sticky proxy fails, and by `removeProxy` /
 * `clearProxies` when the sticky proxy is removed from the pool.
 *
 * This implements the user's "后面请求也要记住这个代理继续使用 直到代理
 * 失效或405报错继续轮循" requirement: a working proxy is sticky across
 * requests, rotation only happens on failure.
 */
let currentWorkingProxy: string | null = null;

function refreshPoolPathFromEnv(): void {
  const nextDir = resolveStoreDir();
  if (nextDir === STORE_DIR) return;
  STORE_DIR = nextDir;
  POOL_FILE = join(STORE_DIR, "proxy-pool.json");
  cachedPool = null;
  cachedMtimeMs = -1;
  cachedCtimeMs = -1;
  cachedSize = -1;
  lastMtimeCheckAt = 0;
  roundRobinCursor = 0;
  currentWorkingProxy = null;
}

function reconcileCurrentWorkingProxy(pool: PoolFile): void {
  if (!currentWorkingProxy) return;
  if (!pool.proxies.some(p => p.url === currentWorkingProxy)) {
    currentWorkingProxy = null;
  }
}

const poolMutex = createMutex();

/**
 * v0.2.2+ FIX (race condition): separate mutex protecting in-memory sticky
 * state (`currentWorkingProxy`, `roundRobinCursor`, dirty failures counters).
 *
 * The disk-file mutex (`poolMutex`) is held during read+write cycles —
 * nesting it inside `pickProxy`/`markProxyFailed` would either deadlock
 * (non-reentrant) or serialize ALL proxy picks globally (every request
 * blocks on every other request's pool I/O). This lightweight state mutex
 * never nests `poolMutex`. readPool is cache-first and throttles external
 * mtime checks, so the common request path avoids repeated synchronous disk
 * stats while still preserving sticky-proxy consistency.
 */
const stateMutex = createMutex();

/**
 * v0.2.2+ PERF: debounced disk flush for `failures` counters.
 *
 * Previously, every `markProxyFailed` call did a full readPool + writePool
 * cycle (mutex + JSON parse + atomic file write). Under WAF rotation with
 * 3 retries × 3 rotations, that's 6–9 disk writes per request — on Windows
 * with antivirus interference each write is 5–50ms, blocking the event
 * loop 30–450ms per WAF-blocked request.
 *
 * Now we mutate `failures` in memory (on `cachedPool`) and schedule a
 * debounced flush. Multiple failures within the debounce window collapse
 * into a single write. The sticky state (`currentWorkingProxy = null`)
 * still updates synchronously so the next `pickProxy` immediately rotates.
 */
let failureFlushScheduled = false;
let failureFlushTimer: ReturnType<typeof setTimeout> | null = null;
let failureMutationSeq = 0;
let failureFlushBeforeWriteHook: (() => void | Promise<void>) | null = null;

function mergeFailureCountersFromMemory(target: PoolFile, memory: PoolFile): boolean {
  const memoryByUrl = new Map(memory.proxies.map(p => [p.url, p]));
  let changed = false;
  for (const p of target.proxies) {
    const mem = memoryByUrl.get(p.url);
    if (!mem) continue;
    const nextFailures = Math.max(p.failures ?? 0, mem.failures ?? 0);
    if (nextFailures > 0 && p.failures !== nextFailures) {
      p.failures = nextFailures;
      changed = true;
    }
    const nextLastFailedAt = Math.max(p.lastFailedAt ?? 0, mem.lastFailedAt ?? 0);
    if (nextLastFailedAt > 0 && p.lastFailedAt !== nextLastFailedAt) {
      p.lastFailedAt = nextLastFailedAt;
      changed = true;
    }
  }
  return changed;
}

async function flushFailureCounters(): Promise<void> {
  await poolMutex.run(async () => {
    // Force an uncached disk read to pick up any external mutations, then
    // merge our in-memory `failures`/`lastFailedAt` counters onto the
    // latest on-disk state. Calling readPool() here would usually return
    // the same cachedPool object that markProxyFailed just mutated, making
    // the comparison below a no-op and silently skipping the disk flush.
    const memory = cachedPool;
    if (!memory) return;
    const mutationSeqAtStart = failureMutationSeq;
    const fresh = readPoolUncached() ?? {
      version: 1 as const,
      config: cloneProxyPoolConfig(memory.config),
      proxies: memory.proxies.map(p => ({ ...p })),
      lastRefreshAt: memory.lastRefreshAt,
      lastRefreshResult: cloneRefreshResult(memory.lastRefreshResult),
    };
    const changed = mergeFailureCountersFromMemory(fresh, memory);
    if (changed) {
      await failureFlushBeforeWriteHook?.();
      await writePool(fresh);
      // A new markProxyFailed() can run while the async disk write above is
      // in flight. It mutates the old cachedPool object (`memory`) and
      // schedules another flush, but writePool() replaces cachedPool with
      // `fresh`. Merge those late in-memory increments back into the new
      // cache so the follow-up flush can persist them instead of losing them.
      if (failureMutationSeq !== mutationSeqAtStart && cachedPool) {
        if (mergeFailureCountersFromMemory(cachedPool, memory)) {
          scheduleFailureFlush();
        }
      }
    }
  });
}

function scheduleFailureFlush(): void {
  if (failureFlushScheduled) return;
  failureFlushScheduled = true;
  if (failureFlushTimer) {
    try { hostClearTimeout(failureFlushTimer); } catch {}
  }
  failureFlushTimer = hostSetTimeout(() => {
    failureFlushScheduled = false;
    failureFlushTimer = null;
    // Fire-and-forget — caller doesn't wait for disk write.
    void flushFailureCounters().catch(() => { /* best-effort */ });
  }, PROXY_POOL_CONST.FAILURE_FLUSH_DEBOUNCE_MS);
  // Don't keep the process alive just for this timer.
  if (typeof failureFlushTimer.unref === "function") {
    failureFlushTimer.unref();
  }
}

// --------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------

/** Cheap stable hash for ids (FNV-1a 32-bit, hex). */
function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Normalize a raw proxy line into a valid URL string.
 * - Empty / comment lines return null.
 * - Bare `host:port` becomes `http://host:port`.
 * - URLs without scheme get `http://` prepended.
 * - Invalid schemes / hosts return null.
 */
export function normalizeProxyLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return null;

  let candidate = trimmed;
  // If it has no scheme, prepend http://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Heuristic: if it looks like `host:port` or `user:pass@host:port`, prepend http://
    candidate = `http://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  // Reject HTML/JS metacharacters in the host (defense-in-depth, mirrors
  // setAccountProxy validation).
  if (/[<>'"\s]/.test(parsed.host)) return null;

  // Re-serialize without hash/fragment and without trailing slash.
  const port = parsed.port ? `:${parsed.port}` : "";
  const auth = parsed.username
    ? `${encodeURIComponent(parsed.username)}${parsed.password ? ":" + encodeURIComponent(parsed.password) : ""}@`
    : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${port}`;
}

/** Parse a multi-line text block into a list of normalized proxy URLs. */
export function parseProxyText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let lineStart = 0;
  for (;;) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const line = text.slice(lineStart, end);
    const norm = normalizeProxyLine(line);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return out;
}

/**
 * Run SSRF / scheme validation on a normalized URL. Returns null if valid,
 * or an error message string. Reuses store.ts `validateProxyUrl` for parity
 * with the per-account proxy gate.
 */
function validateProxy(normalized: string): string | null {
  const v = validateProxyUrl(normalized);
  return v.ok ? null : v.message;
}

function normalizeProxySource(raw: unknown): string {
  if (typeof raw !== "string") return "manual";
  const source = raw.trim();
  if (source === "manual") return source;
  if (!source.startsWith("url:")) return "manual";
  const sourceUrl = source.slice(4).trim();
  if (!sourceUrl) return "manual";
  try {
    new URL(sourceUrl);
    return `url:${sourceUrl}`;
  } catch {
    return "manual";
  }
}

function normalizePoolProxies(raw: unknown): PoolProxy[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolProxy[] = [];
  const seenUrls = new Set<string>();
  const now = Date.now();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    if (typeof p.url !== "string") continue;
    const url = normalizeProxyLine(p.url);
    if (!url || validateProxy(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const addedAt = normalizeOptionalNonNegativeInt(p.addedAt) ?? now;
    const proxy: PoolProxy = {
      id: hashId(url),
      url,
      source: normalizeProxySource(p.source),
      addedAt,
    };
    if (typeof p.note === "string" && p.note.trim()) proxy.note = p.note.trim().slice(0, 500);
    const failures = normalizeOptionalNonNegativeInt(p.failures);
    if (failures !== undefined) proxy.failures = failures;
    const lastUsedAt = normalizeOptionalNonNegativeInt(p.lastUsedAt);
    if (lastUsedAt !== undefined) proxy.lastUsedAt = lastUsedAt;
    const lastFailedAt = normalizeOptionalNonNegativeInt(p.lastFailedAt);
    if (lastFailedAt !== undefined) proxy.lastFailedAt = lastFailedAt;
    out.push(proxy);
  }
  return out;
}

// --------------------------------------------------------------------
// File I/O
// --------------------------------------------------------------------

function readPoolUncached(): PoolFile | null {
  refreshPoolPathFromEnv();
  if (!existsSync(POOL_FILE)) return null;
  try {
    const raw = readFileSync(POOL_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PoolFile;
    if (!parsed || parsed.version !== 1) {
      // Unknown version — treat as empty rather than risk clobbering.
      return { version: 1, config: cloneProxyPoolConfig(DEFAULT_CONFIG), proxies: [] };
    }
    const lastRefreshAt = normalizeOptionalNonNegativeInt(parsed.lastRefreshAt);
    return {
      version: 1,
      config: normalizeProxyPoolConfig(parsed.config),
      proxies: normalizePoolProxies(parsed.proxies),
      lastRefreshAt,
      lastRefreshResult: normalizeRefreshResult(parsed.lastRefreshResult, lastRefreshAt),
    };
  } catch {
    return null;
  }
}

async function writePool(pool: PoolFile): Promise<void> {
  refreshPoolPathFromEnv();
  try {
    if (!existsSync(STORE_DIR)) {
      mkdirSync(STORE_DIR, { recursive: true });
    }
    await atomicWriteFile(POOL_FILE, JSON.stringify(pool, null, 2));
    cachedPool = pool;
    reconcileCurrentWorkingProxy(pool);
    try {
      const st = statSync(POOL_FILE);
      cachedMtimeMs = st.mtimeMs;
      cachedCtimeMs = st.ctimeMs;
      cachedSize = st.size;
      lastMtimeCheckAt = Date.now();
    } catch {
      cachedMtimeMs = Date.now();
      cachedCtimeMs = -1;
      cachedSize = -1;
      lastMtimeCheckAt = Date.now();
    }
  } catch (e) {
    // User-facing mutations (admin config/import/remove/clear) must not report
    // success when the durable file was not written. Because callers mutate the
    // cached pool object in-place before calling writePool(), also drop the
    // cache so the next read goes back to the last durable on-disk state.
    cachedPool = null;
    cachedMtimeMs = -1;
    cachedCtimeMs = -1;
    cachedSize = -1;
    lastMtimeCheckAt = 0;
    const message = (e as Error).message;
    runtimeWarn(`[proxy-pool] failed to persist pool file: ${message}`);
    throw new Error(`Could not persist proxy pool to ${POOL_FILE}: ${message}`);
  }
}

/** Read the pool, refreshing from disk if the file changed externally. */
async function readPool(): Promise<PoolFile> {
  refreshPoolPathFromEnv();
  if (cachedPool) {
    const now = Date.now();
    const interval = Number.isFinite(POOL_MTIME_CHECK_INTERVAL_MS) && POOL_MTIME_CHECK_INTERVAL_MS >= 0
      ? POOL_MTIME_CHECK_INTERVAL_MS
      : 1000;
    if (now - lastMtimeCheckAt >= interval) {
      lastMtimeCheckAt = now;
      try {
        if (existsSync(POOL_FILE)) {
          const st = statSync(POOL_FILE);
          if (st.mtimeMs !== cachedMtimeMs ||
              st.ctimeMs !== cachedCtimeMs ||
              st.size !== cachedSize) {
            cachedPool = null;
            cachedMtimeMs = -1;
            cachedCtimeMs = -1;
            cachedSize = -1;
          }
        } else {
          cachedPool = null;
          cachedMtimeMs = -1;
          cachedCtimeMs = -1;
          cachedSize = -1;
        }
      } catch {
        /* ignore stat errors */
      }
    }
  }
  if (!cachedPool) {
    cachedPool = readPoolUncached() ?? {
      version: 1,
      config: cloneProxyPoolConfig(DEFAULT_CONFIG),
      proxies: [],
    };
    reconcileCurrentWorkingProxy(cachedPool);
    try {
      if (existsSync(POOL_FILE)) {
        const st = statSync(POOL_FILE);
        cachedMtimeMs = st.mtimeMs;
        cachedCtimeMs = st.ctimeMs;
        cachedSize = st.size;
        lastMtimeCheckAt = Date.now();
      }
    } catch {
      cachedMtimeMs = -1;
      cachedCtimeMs = -1;
      cachedSize = -1;
      lastMtimeCheckAt = Date.now();
    }
  }
  return cachedPool;
}

// --------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------

/** Get the current pool state (for the admin API). */
export async function getPoolState(): Promise<{
  config: ProxyPoolConfig;
  proxies: PoolProxy[];
  lastRefreshAt?: number;
  lastRefreshResult?: RefreshResult;
  currentWorkingProxy: string | null;
}> {
  const pool = await readPool();
  return {
    config: cloneProxyPoolConfig(pool.config),
    proxies: pool.proxies.map(p => ({ ...p })),
    lastRefreshAt: pool.lastRefreshAt,
    lastRefreshResult: cloneRefreshResult(pool.lastRefreshResult),
    currentWorkingProxy,
  };
}

/** Update the pool configuration (also (re)schedules the auto-refresh timer). */
export async function updatePoolConfig(patch: Partial<ProxyPoolConfig>): Promise<ProxyPoolConfig> {
  return poolMutex.run(async () => {
    const pool = await readPool();
    const current = normalizeProxyPoolConfig(pool.config);
    const patchRecord = patch as Record<string, unknown>;
    const newConfig: ProxyPoolConfig = {
      enabled: hasOwn(patchRecord, "enabled")
        ? normalizeBoolean(patchRecord.enabled, current.enabled)
        : current.enabled,
      refreshIntervalMin: hasOwn(patchRecord, "refreshIntervalMin")
        ? normalizeNonNegativeInt(
          patchRecord.refreshIntervalMin,
          current.refreshIntervalMin,
          MAX_REFRESH_INTERVAL_MIN,
        )
        : current.refreshIntervalMin,
      sourceUrls: hasOwn(patchRecord, "sourceUrls") && Array.isArray(patchRecord.sourceUrls)
        ? normalizeSourceUrls(patchRecord.sourceUrls)
        : normalizeSourceUrls(current.sourceUrls),
      rotateOnGatewayBlock: hasOwn(patchRecord, "rotateOnGatewayBlock")
        ? normalizeBoolean(patchRecord.rotateOnGatewayBlock, current.rotateOnGatewayBlock)
        : current.rotateOnGatewayBlock,
      maxRotations: hasOwn(patchRecord, "maxRotations")
        ? normalizeNonNegativeInt(patchRecord.maxRotations, current.maxRotations, MAX_PROXY_ROTATIONS)
        : current.maxRotations,
    };
    pool.config = newConfig;
    await writePool(pool);
    scheduleAutoRefresh(newConfig);
    return cloneProxyPoolConfig(newConfig);
  });
}

/**
 * Import proxies from a raw text block (manual / txt file upload).
 *
 * @param text Multi-line proxy text.
 * @param replace Whether to replace ALL existing proxies (true) or merge (false).
 * @returns { added, total } — added is the count of new entries.
 */
export async function importFromText(
  text: string,
  replace: boolean = false,
): Promise<{ added: number; removed: number; total: number }> {
  const urls = parseProxyText(text);
  return poolMutex.run(async () => {
    const pool = await readPool();
    const now = Date.now();
    const newEntries: PoolProxy[] = urls.map((url, idx) => {
      const validationErr = validateProxy(url);
      if (validationErr) {
        // Skip invalid silently — the parse step already filtered most bad
        // inputs; the SSRF check just blocks metadata endpoints.
        return null;
      }
      return {
        id: hashId(url),
        url,
        source: "manual",
        addedAt: now,
        note: `line ${idx + 1}`,
      } as PoolProxy;
    }).filter((x): x is PoolProxy => x !== null);

    const before = pool.proxies.length;
    let addedCount = 0;
    if (replace) {
      // In replace mode, ALL old entries are removed and ALL new entries are
      // added (after validation). The "added" count is the number of valid
      // new entries that made it into the pool.
      addedCount = newEntries.length;
      pool.proxies = newEntries;
    } else {
      // Merge: keep existing manual entries, dedupe by id.
      const existingIds = new Set(pool.proxies.map(p => p.id));
      const addedEntries = newEntries.filter(e => !existingIds.has(e.id));
      addedCount = addedEntries.length;
      pool.proxies = [...pool.proxies, ...addedEntries];
    }
    await writePool(pool);
    return {
      added: addedCount,
      removed: replace ? before : 0,
      total: pool.proxies.length,
    };
  });
}

/**
 * Fetch a remote txt list and import it. The fetch is done via the provided
 * fetchImpl so tests can mock it. The result replaces any proxies that came
 * from the SAME source URL (idempotent refresh).
 *
 * @param url Source URL to fetch.
 * @param fetchImpl Optional fetch override.
 * @returns { added, removed, total, fetched } — fetched is the count parsed
 *          from the remote list.
 */
export async function importFromUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ added: number; removed: number; total: number; fetched: number; error?: string }> {
  const source = validateProxySourceUrl(url);
  if (!source.ok) {
    return { added: 0, removed: 0, total: 0, fetched: 0, error: source.message };
  }

  let text: string;
  try {
    const ctrl = new AbortController();
    const timer = hostSetTimeout(() => ctrl.abort(), PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const resp = await fetchImpl(source.url, {
        signal: ctrl.signal,
        headers: { "user-agent": "zcode-proxy/proxy-pool" },
      });
      if (!resp.ok) {
        try { await resp.body?.cancel(); } catch {}
        return { added: 0, removed: 0, total: 0, fetched: 0, error: `HTTP ${resp.status}` };
      }
      text = await readProxySourceText(resp);
    } finally {
      hostClearTimeout(timer);
    }
  } catch (e) {
    return { added: 0, removed: 0, total: 0, fetched: 0, error: truncateProxyPoolError((e as Error).message) };
  }

  return importFromFetchedText(source.url, text);
}

/**
 * v0.2.2+ PERF: import proxies from already-fetched text. Used by
 * refreshFromSources after the parallel network fetch — avoids the
 * redundant HTTP GET that importFromUrl would do. The pool write logic
 * is identical to importFromUrl's.
 */
async function importFromFetchedText(
  url: string,
  text: string,
): Promise<{ added: number; removed: number; total: number; fetched: number; error?: string }> {
  const urls = parseProxyText(text);
  const sourceTag = `url:${url}`;
  return poolMutex.run(async () => {
    const pool = await readPool();
    const now = Date.now();
    // Remove existing entries from the SAME source.
    const kept = pool.proxies.filter(p => p.source !== sourceTag);
    const removed = pool.proxies.length - kept.length;

    const existingIds = new Set(kept.map(p => p.id));
    const newEntries: PoolProxy[] = [];
    for (const u of urls) {
      if (validateProxy(u)) continue;
      const id = hashId(u);
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      newEntries.push({ id, url: u, source: sourceTag, addedAt: now });
    }

    pool.proxies = [...kept, ...newEntries];
    await writePool(pool);
    return {
      added: newEntries.length,
      removed,
      total: pool.proxies.length,
      fetched: urls.length,
    };
  });
}

/**
 * Refresh from ALL configured source URLs. Each source is fetched; existing
 * proxies from each source are replaced. Proxies from other sources (manual,
 * other URLs) are preserved.
 *
 * **Failure handling**: if a URL source fails to fetch (network error, HTTP
 * 4xx/5xx), its EXISTING proxies are preserved in the pool — only the new
 * fetch is skipped. This prevents a transient network blip from wiping out
 * all working proxies from that source.
 *
 * **Removed sources**: if a URL source was removed from `sourceUrls` config
 * since the last refresh, its proxies are dropped (they're no longer in
 * `allEntries` and not in the current source list).
 *
 * @param fetchImpl Optional fetch override.
 * @returns RefreshResult with aggregate added/removed/total + per-source errors.
 */
export async function refreshFromSources(
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult> {
  if (refreshSourcesInFlight) return refreshSourcesInFlight;
  const inFlight = refreshFromSourcesInner(fetchImpl).finally(() => {
    if (refreshSourcesInFlight === inFlight) refreshSourcesInFlight = null;
  });
  refreshSourcesInFlight = inFlight;
  return inFlight;
}

async function refreshFromSourcesInner(
  fetchImpl: typeof fetch,
): Promise<RefreshResult> {
  const pool = await readPool();
  const initialProxies = pool.proxies.map(p => ({ ...p }));
  const initialIds = new Set(initialProxies.map(p => p.id));
  const urls = pool.config.sourceUrls ?? [];
  const urlSet = new Set(urls.map(u => `url:${u}`));
  const errors: Record<string, string> = {};
  const allEntries: PoolProxy[] = [];
  const seenIds = new Set<string>();
  const refreshedAt = Date.now();

  // First, keep manual entries (source === "manual").
  for (const p of initialProxies) {
    if (p.source === "manual") {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allEntries.push(p);
      }
    }
  }

  // For each configured URL source, try to fetch + import. If the fetch
  // fails, preserve the existing entries from that source so a transient
  // network error doesn't wipe the pool.
  //
  // v0.2.2+ PERF: parallelize the network fetches. The old code awaited
  // each `importFromUrl` serially — with 5 source URLs × 30s timeout,
  // worst-case refresh time was 150s. Now we fetch URL sources concurrently
  // (just the HTTP GET + text decode), with a cap to avoid a dashboard paste
  // of many source URLs creating an unbounded connection burst. Results are
  // then merged in memory and written once at the end.
  //
  // We don't parallelize the WRITES (importFromUrl's poolMutex.run) because
  // those need to serialize on the on-disk pool file — concurrent writes
  // would race. But the writes are fast (<<1ms each), so serializing them
  // after parallel fetches is still a major win.
  const failedSources = new Set<string>();
  // Step 1: bounded parallel network fetch — just GET + text decode, no pool I/O.
  const fetchResults = await mapWithConcurrency(
    urls,
    resolveSourceFetchConcurrency(),
    async (srcUrl) => {
      try {
        const ctrl = new AbortController();
        const timer = hostSetTimeout(() => ctrl.abort(), PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS);
        timer.unref?.();
        try {
          const resp = await fetchImpl(srcUrl, {
            signal: ctrl.signal,
            headers: { "user-agent": "zcode-proxy/proxy-pool" },
          });
          if (!resp.ok) {
            try { await resp.body?.cancel(); } catch {}
            return { srcUrl, text: null, error: `HTTP ${resp.status}` };
          }
          const text = await readProxySourceText(resp);
          return { srcUrl, text, error: null as string | null };
        } finally {
          hostClearTimeout(timer);
        }
      } catch (e) {
        return { srcUrl, text: null, error: truncateProxyPoolError((e as Error).message) };
      }
    },
  );
  // Step 2: in-memory merge. Older versions called importFromFetchedText()
  // for every successful source, which wrote the pool file once per URL and
  // then wrote it again below for the final merged result. On Windows those
  // redundant atomic writes can stall the dashboard during refresh. Build the
  // refreshed source entries in memory and persist once at the end.
  for (const r of fetchResults) {
    const sourceTag = `url:${r.srcUrl}`;
    if (r.error || r.text === null) {
      errors[r.srcUrl] = r.error ?? "unknown fetch error";
      failedSources.add(sourceTag);
      continue;
    }
    for (const proxyUrl of parseProxyText(r.text)) {
      if (validateProxy(proxyUrl)) continue;
      const id = hashId(proxyUrl);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      allEntries.push({ id, url: proxyUrl, source: sourceTag, addedAt: refreshedAt });
    }
  }

  // Preserve existing entries from FAILED sources (transient network errors
  // must not wipe working proxies). We read the pool's PRE-refresh state
  // (captured at the top of this function) to get the entries that existed
  // before any importFromUrl calls modified the pool.
  for (const p of initialProxies) {
    if (failedSources.has(p.source) && urlSet.has(p.source)) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allEntries.push(p);
      }
    }
  }

  // Write the merged result with the new totals.
  return poolMutex.run(async () => {
    const finalPool = await readPool();
    const finalUrlSet = new Set((finalPool.config.sourceUrls ?? []).map(u => `url:${u}`));
    const finalErrors: Record<string, string> = {};
    for (const [url, error] of Object.entries(errors)) {
      if (finalUrlSet.has(`url:${url}`)) finalErrors[url] = error;
    }
    const finalEntries: PoolProxy[] = [];
    const finalSeenIds = new Set<string>();
    const addFinalEntry = (entry: PoolProxy) => {
      if (finalSeenIds.has(entry.id)) return;
      finalSeenIds.add(entry.id);
      finalEntries.push({ ...entry });
    };

    // Preserve manual edits made while the network refresh was in-flight.
    // The refresh fetch can take up to 30s; during that window the dashboard
    // may import/remove manual proxies. Using the initial snapshot here would
    // resurrect removed manual entries or drop newly-added ones.
    for (const p of finalPool.proxies) {
      if (p.source === "manual") addFinalEntry(p);
    }

    // Preserve latest on-disk entries for sources this refresh did NOT
    // successfully replace. This covers failed sources and sources added to
    // the config while the network fetch was already in flight. Sources
    // removed from the config while fetching are intentionally dropped.
    for (const p of finalPool.proxies) {
      if (p.source === "manual") continue;
      if (!finalUrlSet.has(p.source)) continue;
      if (failedSources.has(p.source) || !urlSet.has(p.source)) addFinalEntry(p);
    }

    // Apply freshly fetched entries only for sources that are STILL configured
    // at write time. Otherwise a slow refresh can resurrect proxies from a
    // source the user removed while the fetch was in flight.
    for (const p of allEntries) {
      if (p.source === "manual") continue;
      if (failedSources.has(p.source)) continue;
      if (!finalUrlSet.has(p.source)) continue;
      addFinalEntry(p);
    }

    const finalEntryIds = new Set(finalEntries.map(p => p.id));
    let actualAdded = 0;
    for (const p of finalEntries) {
      if (p.source === "manual") continue;
      if (urlSet.has(p.source) && !initialIds.has(p.id)) actualAdded++;
    }
    let actualRemoved = 0;
    for (const p of initialProxies) {
      if (p.source === "manual") continue;
      if (!finalEntryIds.has(p.id)) actualRemoved++;
    }

    finalPool.proxies = finalEntries;
    finalPool.lastRefreshAt = Date.now();
    const result: RefreshResult = {
      added: actualAdded,
      removed: actualRemoved,
      total: finalPool.proxies.length,
      at: finalPool.lastRefreshAt,
      errors: Object.keys(finalErrors).length > 0 ? finalErrors : undefined,
    };
    finalPool.lastRefreshResult = result;
    await writePool(finalPool);
    return result;
  });
}

/** Remove a single proxy by id. Returns true if removed. */
export async function removeProxy(id: string): Promise<boolean> {
  return (await removeProxies([id])) > 0;
}

/** Remove multiple proxies by id in one pool write. Returns the removed count. */
export async function removeProxies(ids: Iterable<string>): Promise<number> {
  const idSet = new Set(Array.from(ids).filter(id => typeof id === "string" && id.length > 0));
  if (idSet.size === 0) return 0;

  let removedStickyUrl: string | null = null;
  const removed = await poolMutex.run(async () => {
    const pool = await readPool();
    const before = pool.proxies.length;
    const removedUrls = new Set<string>();
    pool.proxies = pool.proxies.filter(p => {
      if (!idSet.has(p.id)) return true;
      removedUrls.add(p.url);
      return false;
    });
    const removedCount = before - pool.proxies.length;
    if (removedCount === 0) return 0;
    // Capture sticky state — clear it under stateMutex AFTER releasing
    // poolMutex to avoid nested-lock complexity.
    if (currentWorkingProxy && removedUrls.has(currentWorkingProxy)) {
      removedStickyUrl = currentWorkingProxy;
    }
    await writePool(pool);
    return removedCount;
  });
  // v0.2.2+ race fix: clear sticky state under stateMutex after releasing
  // poolMutex. Await it so the admin API response and immediate follow-up
  // getPoolState() cannot still show a deleted proxy as sticky.
  if (removedStickyUrl) {
    await stateMutex.run(async () => {
      if (currentWorkingProxy === removedStickyUrl) {
        currentWorkingProxy = null;
      }
    });
  }
  return removed;
}

async function removeTestJobFailedProxies(failed: Iterable<PoolProxy>): Promise<number> {
  const snapshots = new Map<string, Pick<PoolProxy, "id" | "url" | "source" | "addedAt">>();
  for (const p of failed) {
    if (!p?.id) continue;
    snapshots.set(p.id, {
      id: p.id,
      url: p.url,
      source: p.source,
      addedAt: p.addedAt,
    });
  }
  if (snapshots.size === 0) return 0;

  let removedStickyUrl: string | null = null;
  const removed = await poolMutex.run(async () => {
    const pool = await readPool();
    const before = pool.proxies.length;
    const removedUrls = new Set<string>();
    pool.proxies = pool.proxies.filter(p => {
      const snapshot = snapshots.get(p.id);
      if (!snapshot) return true;
      if (p.url !== snapshot.url || p.source !== snapshot.source || p.addedAt !== snapshot.addedAt) {
        return true;
      }
      removedUrls.add(p.url);
      return false;
    });
    const removedCount = before - pool.proxies.length;
    if (removedCount === 0) return 0;
    if (currentWorkingProxy && removedUrls.has(currentWorkingProxy)) {
      removedStickyUrl = currentWorkingProxy;
    }
    await writePool(pool);
    return removedCount;
  });

  if (removedStickyUrl) {
    await stateMutex.run(async () => {
      if (currentWorkingProxy === removedStickyUrl) {
        currentWorkingProxy = null;
      }
    });
  }
  return removed;
}

/** Clear all proxies (config is preserved). */
export async function clearProxies(): Promise<{ removed: number }> {
  // Clear sticky state under stateMutex (v0.2.2+ race fix).
  await stateMutex.run(async () => {
    currentWorkingProxy = null;
  });
  return poolMutex.run(async () => {
    const pool = await readPool();
    const removed = pool.proxies.length;
    pool.proxies = [];
    await writePool(pool);
    return { removed };
  });
}

/**
 * Pick the next proxy to use. Returns null if the pool is disabled or empty.
 *
 * **Sticky behavior**: if a `currentWorkingProxy` is set (from a previous
 * successful pick), it's returned for every subsequent call — UNLESS it's
 * in the `excludeUrls` set (caller is rotating away from it after a failure)
 * or it's no longer in the pool. This makes a working proxy persist across
 * requests; rotation only happens when the sticky proxy fails.
 *
 * @param excludeUrls Optional set of URLs to skip (used during rotation
 *   after a gateway block — we don't want to retry the same proxy that
 *   just got blocked).
 */
export async function pickProxy(excludeUrls?: Set<string>): Promise<string | null> {
  // v0.2.2+ FIX (race condition): hold stateMutex for the entire pick
  // decision. Previously, two concurrent requests could both observe
  // `currentWorkingProxy === null`, both advance roundRobinCursor, and
  // both return DIFFERENT proxies — sticky behavior was lost and the
  // failed-of-A counter could be written onto proxy B. The state mutex
  // is lightweight (no disk I/O inside) and held for microseconds.
  return stateMutex.run(async () => {
    const pool = await readPool();
    if (!pool.config.enabled) return null;
    if (pool.proxies.length === 0) return null;

    const poolUrls = new Set(pool.proxies.map(p => p.url));

    // Sticky: if currentWorkingProxy is still valid (in pool + not excluded
    // + not in failure cooldown), return it without advancing the cursor.
    //
    // v0.2.2+: the cooldown check here prevents the sticky proxy from
    // being reused if it JUST failed (markProxyFailed clears sticky, but
    // a race could set it back). Belt + suspenders.
    if (currentWorkingProxy && poolUrls.has(currentWorkingProxy)) {
      const isExcluded = !excludeUrls || !excludeUrls.has(currentWorkingProxy);
      const stickyEntry = pool.proxies.find(p => p.url === currentWorkingProxy);
      const inCooldown = stickyEntry?.lastFailedAt !== undefined
        && (Date.now() - stickyEntry.lastFailedAt < PROXY_POOL_CONST.FAILURE_COOLDOWN_MS);
      if (isExcluded && !inCooldown) {
        return currentWorkingProxy;
      }
      // Sticky proxy is excluded or in cooldown. Fall through to pick a new one.
    } else {
      // Sticky proxy is stale (removed from pool). Clear it.
      currentWorkingProxy = null;
    }

    // v0.2.2+: filter out proxies in failure cooldown. If ALL non-excluded
    // proxies are in cooldown, fall through to the old behavior (pick any
    // non-excluded one) — better to try a recently-failed proxy than to
    // return null and force a direct connection that's guaranteed to fail
    // (e.g. when the IP itself is WAF-blacklisted).
    const now = Date.now();
    const isEligible = (p: PoolProxy): boolean => {
      if (excludeUrls && excludeUrls.has(p.url)) return false;
      if (p.lastFailedAt !== undefined && now - p.lastFailedAt < PROXY_POOL_CONST.FAILURE_COOLDOWN_MS) return false;
      return true;
    };
    const hasAnyEligible = pool.proxies.some(isEligible);

    // Advance round-robin to find a new proxy.
    const n = pool.proxies.length;
    for (let i = 0; i < n; i++) {
      const idx = (roundRobinCursor + i) % n;
      const candidate = pool.proxies[idx];
      // If we have eligible (non-cooldown) proxies, skip cooldown ones.
      // If NO proxies are eligible (all in cooldown), fall through to
      // the old exclusion-only check so we still return something.
      if (hasAnyEligible) {
        if (!isEligible(candidate)) continue;
      } else {
        if (excludeUrls && excludeUrls.has(candidate.url)) continue;
      }
      // Found a new proxy — make it sticky.
      roundRobinCursor = (idx + 1) % n;
      currentWorkingProxy = candidate.url;
      return candidate.url;
    }
    // All excluded — return null (caller should fall through to direct/no-proxy).
    return null;
  });
}

/**
 * Get the current sticky (working) proxy for diagnostics/logging. Returns
 * null if no proxy is currently sticky.
 */
export function getCurrentWorkingProxy(): string | null {
  return currentWorkingProxy;
}

/**
 * Explicitly set the current working proxy. Used by the handler when a
 * request succeeds through a pool proxy — the proxy that served the
 * successful request becomes sticky for future requests.
 *
 * v0.2.2+ note: this stays SYNCHRONOUS for two reasons:
 *   1. The test suite expects synchronous visibility (the call returns,
 *      getCurrentWorkingProxy immediately reflects the new value).
 *   2. JS is single-threaded, so a simple assignment is atomic and
 *      cannot interleave with pickProxy's read-modify-write cycle in
 *      a way that corrupts state. pickProxy's only `await` (readPool)
 *      happens BEFORE the currentWorkingProxy read/write, so any
 *      synchronous setCurrentWorkingProxy call between the await and
 *      the read produces a coherent view.
 *
 * The race condition we're fixing (P0-2) is between TWO pickProxy calls
 * — both async, both with `await readPool` in the middle. stateMutex
 * serializes them. setCurrentWorkingProxy's single assignment doesn't
 * need the same protection.
 */
export function setCurrentWorkingProxy(url: string | null): void {
  currentWorkingProxy = url;
}

/**
 * Get the configured maxRotations for WAF retry. Returns the pool's
 * `maxRotations` value (default 3). Used by the handler to cap proxy
 * rotation attempts on 405/WAF gateway blocks.
 */
export async function getMaxRotations(): Promise<number> {
  const pool = await readPool();
  if (pool.config.rotateOnGatewayBlock === false) return 0;
  return pool.config.maxRotations ?? DEFAULT_CONFIG.maxRotations;
}

/**
 * Mark a proxy as failed (increment its failure counter). Called by the
 * handler when a request via this proxy hit a 405 / WAF block / network
 * error. Used for diagnostics and future deprioritization; the proxy is
 * NOT removed from the pool.
 *
 * If the failed proxy is the current sticky proxy, the sticky state is
 * cleared so the next `pickProxy` call advances to a new proxy.
 *
 * v0.2.2+ PERF: sticky-state clearing is synchronous (under stateMutex),
 * but the disk-write to persist the `failures` counter is debounced —
 * multiple failures within `FAILURE_FLUSH_DEBOUNCE_MS` collapse into a
 * single writePool call. This eliminates the 30–450ms event-loop blocking
 * that previously occurred on every WAF-blocked request.
 */
export async function markProxyFailed(url: string): Promise<void> {
  refreshPoolPathFromEnv();
  // Synchronously clear sticky state under the state mutex so the next
  // pickProxy immediately rotates away from this proxy. We don't need to
  // wait for the disk write — the in-memory cachedPool is updated in the
  // same critical section, so subsequent reads see the new failures count.
  await stateMutex.run(async () => {
    if (currentWorkingProxy === url) {
      currentWorkingProxy = null;
    }
    // Mutate the in-memory cache directly (no disk I/O here).
    if (cachedPool) {
      const entry = cachedPool.proxies.find(p => p.url === url);
      if (entry) {
        entry.failures = (entry.failures ?? 0) + 1;
        // v0.2.2+: record the failure timestamp so pickProxy can skip
        // this proxy for FAILURE_COOLDOWN_MS. This "consumes" the
        // previously-dead `failures` field by making it actionable.
        entry.lastFailedAt = Date.now();
        failureMutationSeq++;
        // Schedule a debounced flush — coalesces multiple failures into
        // one disk write.
        scheduleFailureFlush();
      }
    } else {
      // No cached pool yet — fall back to the old synchronous read+write
      // path so we don't lose the failure record on the very first call
      // after process startup.
      try {
        await poolMutex.run(async () => {
          const pool = await readPool();
          const entry = pool.proxies.find(p => p.url === url);
          if (!entry) return;
          entry.failures = (entry.failures ?? 0) + 1;
          entry.lastFailedAt = Date.now();
          failureMutationSeq++;
          await writePool(pool);
        });
      } catch { /* best-effort */ }
    }
  });
}

// --------------------------------------------------------------------
// Auto-refresh scheduler
// --------------------------------------------------------------------

/**
 * (Re)schedule the auto-refresh timer based on the current pool config.
 * Call this on startup and whenever the config changes.
 */
export function scheduleAutoRefresh(config?: ProxyPoolConfig): void {
  if (refreshTimer) {
    hostClearInterval(refreshTimer);
    refreshTimer = null;
  }
  const rawConfig = config ?? cachedPool?.config;
  if (!rawConfig) return;
  const cfg = normalizeProxyPoolConfig(rawConfig);
  if (!cfg.enabled || cfg.refreshIntervalMin <= 0 || cfg.sourceUrls.length === 0) return;
  const intervalMs = Math.max(1, cfg.refreshIntervalMin) * 60_000;
  refreshTimer = hostSetInterval(() => {
    // Fire-and-forget, but don't allow slow source URLs to stack overlapping
    // refresh jobs. With several 30s timeout sources and a short interval,
    // overlapping jobs create needless network load and pool-file churn.
    if (autoRefreshInFlight) return;
    autoRefreshInFlight = true;
    refreshFromSources()
      .catch(e => {
        runtimeWarn(`[proxy-pool] auto-refresh failed: ${(e as Error).message}`);
      })
      .finally(() => {
        autoRefreshInFlight = false;
      });
  }, intervalMs);
  // Don't keep the process alive just for the timer.
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

/**
 * Initialize the pool on startup. Reads the file (if any), schedules the
 * auto-refresh timer, and optionally fires one refresh immediately if the
 * pool is empty but URLs are configured.
 */
export async function initPool(fetchImpl: typeof fetch = fetch): Promise<void> {
  const pool = await readPool();
  scheduleAutoRefresh(pool.config);
  // If pool is empty but URLs are configured + enabled, fire one initial refresh.
  if (pool.config.enabled
    && pool.proxies.length === 0
    && pool.config.sourceUrls.length > 0) {
    runtimeLog("[proxy-pool] pool empty + URLs configured — firing initial refresh");
    refreshFromSources(fetchImpl).catch(e => {
      runtimeWarn(`[proxy-pool] initial refresh failed: ${(e as Error).message}`);
    });
  }
}

// --------------------------------------------------------------------
// Background test job (server-side, survives page close)
// --------------------------------------------------------------------

/**
 * State of a background test-all job. The job runs entirely on the server —
 * the dashboard starts it via POST /admin/api/proxy-pool/test-all and polls
 * GET /admin/api/proxy-pool/test-status for progress. Closing the browser
 * tab does NOT stop the job.
 */
export interface TestJobState {
  /** Whether the job is currently running. */
  running: boolean;
  /** Total proxies to test (captured at job start). */
  total: number;
  /** Number of proxies tested so far. */
  tested: number;
  /** Number of successful tests so far. */
  okCount: number;
  /** Number of failed tests so far. */
  failCount: number;
  /** Number of failed proxies auto-removed (0 if autoRemove is off). */
  removedCount: number;
  /** Batch size (concurrent tests per batch). */
  batchSize: number;
  /** Whether failed proxies are auto-removed after the job. */
  autoRemove: boolean;
  /** Job start time (Unix ms). */
  startedAt: number;
  /** Job finish time (Unix ms, set when job completes). */
  finishedAt?: number;
  /** Per-proxy results: { [proxyId]: { ok, latencyMs, status?, error? } }. */
  results: Record<string, { ok: boolean; latencyMs: number; status?: number; error?: string; seq?: number }>;
  /** Monotonic sequence assigned to test results, used for incremental polling. */
  resultSeq: number;
  /** Error message if the job itself failed (rare). */
  error?: string;
}

let currentTestJob: TestJobState | null = null;
let currentTestJobAbort: AbortController | null = null;
let currentTestJobResultIds: string[] = [];
let currentTestJobCleanupTimer: ReturnType<typeof setTimeout> | null = null;
const DEFAULT_TEST_JOB_BATCH_SIZE = 5;
const MIN_TEST_JOB_BATCH_SIZE = 1;
const MAX_TEST_JOB_BATCH_SIZE = 50;

function normalizeTestJobBatchSize(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TEST_JOB_BATCH_SIZE;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return DEFAULT_TEST_JOB_BATCH_SIZE;
  return Math.max(MIN_TEST_JOB_BATCH_SIZE, Math.min(MAX_TEST_JOB_BATCH_SIZE, raw));
}

export function resolveTestJobResultTtlMs(raw = process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return PROXY_POOL_CONST.TEST_JOB_RESULT_TTL_MS;
  }
  const n = parseStrictNonNegativeInteger(raw);
  return n === undefined ? PROXY_POOL_CONST.TEST_JOB_RESULT_TTL_MS : Math.min(n, MAX_TIMER_MS);
}

function clearTestJobCleanupTimer(): void {
  if (!currentTestJobCleanupTimer) return;
  try { hostClearTimeout(currentTestJobCleanupTimer); } catch {}
  currentTestJobCleanupTimer = null;
}

function clearCompletedTestJob(job: TestJobState): void {
  if (currentTestJob !== job || job.running) return;
  currentTestJob = null;
  currentTestJobResultIds = [];
  if (currentTestJobAbort) {
    try { currentTestJobAbort.abort(); } catch {}
    currentTestJobAbort = null;
  }
  clearTestJobCleanupTimer();
}

function pruneExpiredTestJob(now = Date.now()): void {
  const job = currentTestJob;
  if (!job || job.running || job.finishedAt === undefined) return;
  const ttlMs = resolveTestJobResultTtlMs();
  if (ttlMs <= 0 || now - job.finishedAt >= ttlMs) {
    clearCompletedTestJob(job);
  }
}

function scheduleCompletedTestJobCleanup(job: TestJobState): void {
  clearTestJobCleanupTimer();
  if (currentTestJob !== job || job.running || job.finishedAt === undefined) return;
  const ttlMs = resolveTestJobResultTtlMs();
  if (ttlMs <= 0) {
    clearCompletedTestJob(job);
    return;
  }
  const delay = Math.max(0, job.finishedAt + ttlMs - Date.now());
  currentTestJobCleanupTimer = hostSetTimeout(() => {
    if (currentTestJob === job) pruneExpiredTestJob();
  }, delay);
  if (typeof currentTestJobCleanupTimer.unref === "function") {
    currentTestJobCleanupTimer.unref();
  }
}

/** Get the current test job state (for polling). Null if no job has ever run. */
export function getTestJobState(options: { sinceSeq?: number } = {}): TestJobState | null {
  pruneExpiredTestJob();
  if (!currentTestJob) return null;
  const sinceSeq = Number.isFinite(options.sinceSeq) && options.sinceSeq !== undefined
    ? Math.max(0, Math.floor(options.sinceSeq))
    : undefined;
  if (sinceSeq !== undefined && sinceSeq >= currentTestJob.resultSeq) {
    return { ...currentTestJob, results: {} };
  }
  const results: TestJobState["results"] = {};
  if (sinceSeq !== undefined) {
    // Incremental polling should stay incremental. Scanning the full results
    // object on every dashboard poll made large proxy tests progressively
    // slower (N results × N polls). Result sequence numbers start at 1, so
    // slice(sinceSeq) returns ids whose seq is greater than sinceSeq.
    for (let i = sinceSeq; i < currentTestJobResultIds.length; i++) {
      const id = currentTestJobResultIds[i];
      const result = currentTestJob.results[id];
      if (!result || (result.seq ?? 0) <= sinceSeq) continue;
      results[id] = { ...result };
    }
    return { ...currentTestJob, results };
  }
  for (const [id, result] of Object.entries(currentTestJob.results)) {
    results[id] = { ...result };
  }
  return { ...currentTestJob, results };
}

function recordTestJobResult(
  job: TestJobState,
  proxyId: string,
  result: Omit<TestJobState["results"][string], "seq">,
): TestJobState["results"][string] {
  const withSeq = { ...result, seq: ++job.resultSeq };
  job.results[proxyId] = withSeq;
  if (currentTestJob === job) {
    currentTestJobResultIds.push(proxyId);
  }
  return withSeq;
}

/**
 * Start a background test-all job. If a job is already running, returns its
 * state without starting a new one (idempotent).
 *
 * The job runs fire-and-forget on the server. The caller gets back the
 * initial state immediately and can poll `getTestJobState()` for progress.
 *
 * @param options batchSize (1-50, default 5), autoRemove (default false),
 *                fetchImpl (for testing), testTarget (override target URL).
 * @returns The job state.
 */
export async function startTestJob(options: {
  batchSize?: number;
  autoRemove?: boolean;
  fetchImpl?: typeof fetch;
  testTarget?: string;
}): Promise<TestJobState> {
  pruneExpiredTestJob();
  // If a job is already running, return its state (don't start a duplicate).
  if (currentTestJob && currentTestJob.running) {
    return getTestJobState()!;
  }
  clearTestJobCleanupTimer();

  const pool = await readPool();
  const proxies = pool.proxies;
  const batchSize = normalizeTestJobBatchSize(options.batchSize);
  const autoRemove = options.autoRemove === true;
  const jobAbort = new AbortController();

  const job: TestJobState = {
    running: true,
    total: proxies.length,
    tested: 0,
    okCount: 0,
    failCount: 0,
    removedCount: 0,
    batchSize,
    autoRemove,
    startedAt: Date.now(),
    results: {},
    resultSeq: 0,
  };
  currentTestJob = job;
  currentTestJobAbort = jobAbort;
  currentTestJobResultIds = [];

  // Fire-and-forget — run the job in the background. Errors are captured
  // into job.error so the dashboard can surface them.
  runTestJob(job, proxies, options.fetchImpl ?? fetch, options.testTarget, jobAbort.signal)
    .catch(e => {
      job.error = (e as Error).message;
      job.running = false;
      job.finishedAt = Date.now();
    })
    .finally(() => {
      if (currentTestJob === job && currentTestJobAbort === jobAbort) {
        currentTestJobAbort = null;
      }
      if (!job.running && job.finishedAt === undefined) {
        job.finishedAt = Date.now();
      }
      scheduleCompletedTestJobCleanup(job);
    });

  return getTestJobState()!;
}

/**
 * Internal: run the test job. Processes proxies in batches of `batchSize`,
 * updating `job` in real-time so pollers see progress. After all batches
 * complete, auto-removes failed proxies if `autoRemove` is true.
 */
async function runTestJob(
  job: TestJobState,
  proxies: PoolProxy[],
  fetchImpl: typeof fetch,
  testTargetOverride?: string,
  jobSignal?: AbortSignal,
): Promise<void> {
  const failedProxies: PoolProxy[] = [];
  const total = proxies.length;
  // Wrap fetchImpl once so every proxy in the batch (HTTP, HTTPS, or SOCKS)
  // is handled correctly. SOCKS proxies are transparently routed through
  // the local HTTP-CONNECT→SOCKS bridge (Bun's native fetch would otherwise
  // throw UnsupportedProxyProtocol for socks4:// / socks5:// schemes).
  const wrappedFetch = wrapFetchWithSocksBridge(fetchImpl);

  for (let i = 0; i < total; i += job.batchSize) {
    // If job was cancelled (a new job started), stop early.
    if (!job.running || jobSignal?.aborted) {
      job.running = false;
      job.finishedAt ??= Date.now();
      return;
    }

    const batch = proxies.slice(i, i + job.batchSize);
    const promises = batch.map(async p => {
      if (!job.running || jobSignal?.aborted) return;
      const target = testTargetOverride ?? "https://api.z.ai";
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = hostSetTimeout(() => ctrl.abort(), 10_000);
      if (typeof timer.unref === "function") timer.unref();
      const onJobAbort = () => ctrl.abort();
      if (jobSignal) {
        if (jobSignal.aborted) ctrl.abort();
        else jobSignal.addEventListener("abort", onJobAbort, { once: true });
      }
      try {
        const resp = await wrappedFetch(target, {
          method: "HEAD",
          signal: ctrl.signal,
          redirect: "follow",
          ...(p.url ? { proxy: p.url } : {}),
        } as any);
        const latencyMs = Date.now() - started;
        try { await resp.body?.cancel(); } catch {}
        if (!job.running || jobSignal?.aborted) {
          recordTestJobResult(job, p.id, { ok: false, latencyMs, error: "Test cancelled" });
          return;
        }
        recordTestJobResult(job, p.id, { ok: true, latencyMs, status: resp.status });
        job.okCount++;
      } catch (err) {
        const latencyMs = Date.now() - started;
        const rawErrMsg = (err as Error).message || String(err);
        if (!job.running || jobSignal?.aborted) {
          recordTestJobResult(job, p.id, { ok: false, latencyMs, error: "Test cancelled" });
          return;
        }
        const isTimeout = ctrl.signal.aborted || /abort/i.test(rawErrMsg);
        recordTestJobResult(job, p.id, { ok: false, latencyMs, error: isTimeout ? "Connection timed out after 10s" : truncateProxyPoolError(rawErrMsg) });
        job.failCount++;
        failedProxies.push(p);
      } finally {
        hostClearTimeout(timer);
        if (jobSignal) jobSignal.removeEventListener("abort", onJobAbort);
        job.tested++;
      }
    });
    await Promise.all(promises);
  }

  if (!job.running || jobSignal?.aborted) {
    job.running = false;
    job.finishedAt ??= Date.now();
    return;
  }

  // Auto-remove failed proxies if enabled.
  if (job.autoRemove && failedProxies.length > 0) {
    job.removedCount = await removeTestJobFailedProxies(failedProxies);
  }

  job.running = false;
  job.finishedAt = Date.now();
}

/** Cancel the current test job (if any). The job stops after the current batch. */
export function cancelTestJob(): void {
  currentTestJobAbort?.abort();
  if (currentTestJob) {
    currentTestJob.running = false;
    currentTestJob.finishedAt ??= Date.now();
    scheduleCompletedTestJobCleanup(currentTestJob);
  }
}

// --------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------

/** @internal Reset all in-memory state (for tests). */
export function _resetForTesting(): void {
  refreshPoolPathFromEnv();
  cachedPool = null;
  cachedMtimeMs = -1;
  cachedCtimeMs = -1;
  cachedSize = -1;
  lastMtimeCheckAt = 0;
  if (refreshTimer) {
    hostClearInterval(refreshTimer);
    refreshTimer = null;
  }
  autoRefreshInFlight = false;
  refreshSourcesInFlight = null;
  clearTestJobCleanupTimer();
  if (failureFlushTimer) {
    hostClearTimeout(failureFlushTimer);
    failureFlushTimer = null;
  }
  failureFlushScheduled = false;
  failureMutationSeq = 0;
  failureFlushBeforeWriteHook = null;
  roundRobinCursor = 0;
  currentWorkingProxy = null;
  currentTestJob = null;
  currentTestJobAbort?.abort();
  currentTestJobAbort = null;
  currentTestJobResultIds = [];
}

/** @internal Current incremental test-result index length (for tests). */
export function _testJobResultOrderLengthForTesting(): number {
  return currentTestJobResultIds.length;
}

/** @internal Flush debounced failure counters immediately (for tests). */
export async function _flushFailureCountersForTesting(): Promise<void> {
  if (failureFlushTimer) {
    hostClearTimeout(failureFlushTimer);
    failureFlushTimer = null;
  }
  failureFlushScheduled = false;
  await flushFailureCounters();
}

/** @internal Install a hook that runs inside failure-counter flush before writePool(). */
export function _setFailureFlushBeforeWriteHookForTesting(
  hook: (() => void | Promise<void>) | null,
): void {
  failureFlushBeforeWriteHook = hook;
}

/** @internal Get the pool file path (for tests). */
export function _poolFilePath(): string {
  refreshPoolPathFromEnv();
  return POOL_FILE;
}
