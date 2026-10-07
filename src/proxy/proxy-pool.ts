/**
 * Persistent global outbound proxy pool. An account's proxy override takes
 * precedence; otherwise selection stays sticky until failure/removal, with
 * request-local exclusions for gateway rotation.
 *
 * Owns file/cache state, selection locks and source refresh scheduling.
 * Parsing, normalization, selection and background tests live in pool-* leaves.
 * See docs/code-organization.md for module responsibilities and lock ordering.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { PROXY_POOL as PROXY_POOL_CONST } from "../utils/constants.js";
import { runtimeLog, runtimeWarn } from "../utils/log.js";
// v0.3.7.1: host-captured timers — these guards/loops run per-request,
// often concurrent with captcha solve epochs; the bare globals resolve
// through the solver window alias there and get cancelled on window
// destruction (the 429-retry permanent hang). See utils/host-timers.ts.
import { hostClearInterval, hostClearTimeout, hostSetInterval, hostSetTimeout } from "../utils/host-timers.js";

import type { PoolProxy, ProxyPoolConfig, RefreshResult, PoolFile } from "./pool-types.js";
import { proxyIdForUrl, parseProxyText, proxyValidationError, validateProxySourceUrl } from "./pool-format.js";
import {
  DEFAULT_CONFIG, cloneProxyPoolConfig, normalizeProxyPoolConfig,
  patchProxyPoolConfig, cloneRefreshResult, normalizePoolFile,
} from "./pool-normalization.js";
import { createProxyPoolTestJobs } from "./pool-test-jobs.js";
import { PoolProxyIndex, isProxyCoolingDown, selectPoolProxy } from "./pool-selection.js";
import {
  mapWithConcurrency, readProxySourceText, truncateProxyPoolError,
  resolveSourceFetchConcurrency,
} from "./pool-source.js";

// Compatibility entry points for existing pool callers.
export type { PoolProxy, ProxyPoolConfig, RefreshResult } from "./pool-types.js";
export { normalizeProxyLine, parseProxyText, validateProxySourceUrl } from "./pool-format.js";
export { resolveTestJobResultTtlMs } from "./pool-test-jobs.js";
export type { TestJobState } from "./pool-test-jobs.js";
export { resolveProxySourceMaxBytes, resolveSourceFetchConcurrency, _readProxySourceTextForTesting } from "./pool-source.js";

// --------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------

function resolveStoreDir(): string {
  return process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy");
}

let STORE_DIR = resolveStoreDir();
let POOL_FILE = join(STORE_DIR, "proxy-pool.json");

/**
 * Hard cap on pool entries: a single 10MB source response can otherwise mint
 * hundreds of thousands of unique proxies which then make every pickProxy O(n)
 * under the state mutex and bloat test-all bookkeeping. Import/refresh
 * truncate beyond the cap (manual entries survive first). Env-overridable.
 */
const PROXY_POOL_MAX_ENTRIES = Math.max(100, Number(process.env.ZCODE_PROXY_POOL_MAX_ENTRIES) || 5000);
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
const proxyIndex = new PoolProxyIndex();
const POOL_MTIME_CHECK_INTERVAL_MS = resolvePoolMtimeCheckIntervalMs();

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
  proxyIndex.clear();
  currentWorkingProxy = null;
}

function reconcileCurrentWorkingProxy(pool: PoolFile): void {
  proxyIndex.sync(pool.proxies);
  if (!currentWorkingProxy) return;
  if (!proxyIndex.get(pool.proxies, currentWorkingProxy)) {
    currentWorkingProxy = null;
  }
}

const poolMutex = createMutex();

/**
 * Protects sticky selection and in-memory failure counters independently of
 * disk writes. Warm-cache failures schedule a flush without taking poolMutex;
 * the first uncached failure takes poolMutex to persist its initial counter.
 * File mutations must not acquire stateMutex while holding poolMutex.
 */
const stateMutex = createMutex();
const testJobs = createProxyPoolTestJobs({
  loadProxies: async () => (await readPool()).proxies,
  removeFailedProxies: removeTestJobFailedProxies,
});
export const { startTestJob, getTestJobState, cancelTestJob } = testJobs;

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
// --------------------------------------------------------------------
// File I/O
// --------------------------------------------------------------------

function readPoolUncached(): PoolFile | null {
  refreshPoolPathFromEnv();
  if (!existsSync(POOL_FILE)) return null;
  try {
    const raw = readFileSync(POOL_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return normalizePoolFile(parsed);
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
    proxyIndex.clear();
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
    const newConfig = patchProxyPoolConfig(pool.config, patch);
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
      const validationErr = proxyValidationError(url);
      if (validationErr) {
        // Skip invalid silently — the parse step already filtered most bad
        // inputs; the SSRF check just blocks metadata endpoints.
        return null;
      }
      return {
        id: proxyIdForUrl(url),
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
      if (proxyValidationError(u)) continue;
      const id = proxyIdForUrl(u);
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
      if (proxyValidationError(proxyUrl)) continue;
      const id = proxyIdForUrl(proxyUrl);
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

    finalPool.proxies = finalEntries.slice(0, PROXY_POOL_MAX_ENTRIES);
    if (finalEntries.length > PROXY_POOL_MAX_ENTRIES) {
      runtimeWarn(
        `[proxy-pool] refresh truncated the pool to ${PROXY_POOL_MAX_ENTRIES} entries (${finalEntries.length - PROXY_POOL_MAX_ENTRIES} dropped — raise ZCODE_PROXY_POOL_MAX_ENTRIES if intentional)`,
      );
    }
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

    const now = Date.now();
    const stickyEntry = currentWorkingProxy ? proxyIndex.get(pool.proxies, currentWorkingProxy) : undefined;
    if (stickyEntry && !excludeUrls?.has(stickyEntry.url) && !isProxyCoolingDown(stickyEntry, now)) {
      return stickyEntry.url;
    }
    if (!stickyEntry) currentWorkingProxy = null;

    const index = selectPoolProxy(pool.proxies, roundRobinCursor, excludeUrls, now);
    if (index === null) return null;
    roundRobinCursor = (index + 1) % pool.proxies.length;
    currentWorkingProxy = pool.proxies[index].url;
    return currentWorkingProxy;
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
      const entry = proxyIndex.get(cachedPool.proxies, url);
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
          const entry = proxyIndex.get(pool.proxies, url);
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
  testJobs.reset();
  if (failureFlushTimer) {
    hostClearTimeout(failureFlushTimer);
    failureFlushTimer = null;
  }
  failureFlushScheduled = false;
  failureMutationSeq = 0;
  failureFlushBeforeWriteHook = null;
  roundRobinCursor = 0;
  proxyIndex.clear();
  currentWorkingProxy = null;
}

/** @internal Current incremental test-result index length (for tests). */
export function _testJobResultOrderLengthForTesting(): number {
  return testJobs.resultOrderLength();
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
