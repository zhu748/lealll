/**
 * Admin dashboard API routes — provides CRUD endpoints for the web UI.
 *
 * All routes require the proxy API key (same key used by API clients).
 * Mounted under /admin/api/* in server.ts.
 */
import type { ProxyConfig, RoutingRule, ModelMapping, ResponsesThinkingConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential as AppCredential } from "../auth/types.js";
import { loadCredential, saveCredential, clearCredentialAsync, listAccounts, switchAccount, removeAccount, setAccountLabel, setAccountPlan, setAccountProxy, setAccountName, setAccountEmail, setAccountDisabled, exportSingleAccount, exportAccounts, exportStore, importAccounts, maskApiKey, invalidateStoreCache, validateProxyUrl } from "../auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient, normalizeCallbackWaitTimeoutMs } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { queryQuota } from "../auth/quota.js";
import { readZCodeImport, detectZCodeProvider, listAvailableZCodeImports } from "../auth/zcode-config.js";
import { errorResponse } from "../proxy/handler.js";
import { getChromeCaptchaHelperStatus, warmupChromeCaptchaHelper, shutdownChromeCaptchaHelper } from "../proxy/captcha.js";
import { wrapFetchWithSocksBridge, makeProxiedFetcher } from "../proxy/proxied-fetch.js";
import { timingSafeEqual } from "../utils/crypto.js";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { LOG as LOG_CONST } from "../utils/constants.js";
import { MODELS as GLM_CATALOG } from "../provider/models.js";
import { stringify as stringifyYaml } from "yaml";
import {
  getPoolState,
  updatePoolConfig,
  importFromText,
  importFromUrl,
  refreshFromSources,
  removeProxy,
  clearProxies,
  startTestJob,
  getTestJobState,
  cancelTestJob,
  validateProxySourceUrl,
} from "../proxy/proxy-pool.js";
// Inline the dashboard HTML at build time so it works inside a
// `bun build --compile` single-file executable. Runtime `readFileSync`
// would resolve to the exe's virtual root (e.g. B:\~BUN\root\) and fail
// with ENOENT because dashboard.html is not shipped next to the exe.
import dashboardHtml from "./dashboard.html.txt" with { type: "text" };

export interface AdminOptions {
  config: ProxyConfig;
  auth: AuthManager;
  configPath: string;
  startTime: number;
  /**
   * Optional fetch override for outbound requests made by admin handlers
   * (currently used by /admin/api/accounts/proxy-test). Defaults to the
   * global fetch. Test code passes a mock here to avoid real network calls.
   */
  fetchImpl?: typeof fetch;
  /**
   * Resolve the TCP-remote client IP for a request. In production this is
   * wired to Bun's `server.requestIP(req)?.address`, which reads the real
   * socket peer address and CANNOT be spoofed by headers. When omitted
   * (e.g., in tests where there is no real socket), client IP detection
   * falls back to "unknown" — and the loopback gate then defaults to
   * allowing the request (preserving the legacy dev behavior for direct
   * local connections).
   *
   * X-Forwarded-For / X-Real-IP are NEVER trusted unless the operator
   * explicitly opts in via `config.server.trustProxy = true`.
   */
  resolveClientIp?: (req: Request) => string | undefined;
}

// In-memory stats collector.
//
// `requestIndex` is a Map<id, idx> kept alongside `stats.requests` so that
// dedup lookups (recordStat called with an id we've already seen on the retry
// path) are O(1) instead of O(n). At 200 entries × 100 req/s the old findIndex
// approach ran 20k string compares/sec; the Map version runs 100.
//
// vceshi0.0.7+: `seenIds` is a bounded lifetime Map of ids we've already counted.
// Once a request id is evicted from `requestIndex` (via the 200-entry trim),
// retries that arrive later would otherwise be misclassified as new requests
// and inflate the totals. The value keeps the last counted status/retry state
// so post-trim retries can still re-classify success/failed without making
// counters inconsistent.
//
// The Map is bounded by `SEEN_IDS_LIMIT` (default 50000) — beyond that, we
// accept the small risk of double-counting ancient retries in exchange for
// bounded memory.
const SEEN_IDS_LIMIT = LOG_CONST.SEEN_IDS_LIMIT;
const SEEN_IDS_EVICT_BATCH = LOG_CONST.SEEN_IDS_EVICT_BATCH;
const MAX_MODEL_STATS = 100;
const MAX_CREDENTIAL_STATS = 1000;
const MAX_PROXY_POOL_REFRESH_INTERVAL_MIN = Math.floor(2_147_483_647 / 60_000);
const MAX_PROXY_POOL_ROTATIONS = 20;
const CONFIG_SECRET_MASK = "***configured***";
type StatsRequestEntry = {
  id: string;
  time: string;
  model: string;
  status: number;
  ttfb: string;
  tokens: string;
  inputTokens: string;
  cacheReadTokens?: string;
  credentialKey?: string;
  captchaMs?: string;
  retried?: boolean;
};
type SeenStat = {
  status: number;
  retried: boolean;
  model: string;
  modelBucket: string;
  ttfb: string;
  tokens: string;
  inputTokens: string;
  credentialKey?: string;
};
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  retried: 0,
  requests: [] as StatsRequestEntry[],
  models: {} as Record<string, { count: number; avgTtfb: number; tokens: number; inputTokens: number }>,
  // vceshi0.0.6+: per-credential usage stats (in-memory, reset on restart).
  // Keyed by credentialStatsKey(provider + apiKey hash) to avoid leaking
  // plaintext keys and avoid collisions from display-only apiKeyMask.
  // The dashboard joins this with listAccounts.credentialKey to display
  // "使用次数" per account.
  byCredential: {} as Record<string, { count: number; inputTokens: number; outputTokens: number; lastUsed: string; success: number; failed: number }>,
  // G5: Error stats by status code — enables the dashboard to show "529: 12, 429: 3"
  // instead of just "failed: 15". Critical for diagnosing whether failures are
  // overload (529), rate-limit (429), auth (401), or parameter errors (3001/400).
  byStatus: {} as Record<number, number>,
};
const requestIndex = new Map<string, number>();
const requestModelBuckets = new Map<string, string>();
const modelTtfbTotals = new Map<string, number>();
const seenIds = new Map<string, SeenStat>();
const credentialStatLastSeen = new Map<string, number>();
let credentialStatSeq = 0;

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function moveStatusCounter(fromStatus: number, toStatus: number): void {
  if (fromStatus === toStatus) return;
  const oldCount = (stats.byStatus[fromStatus] ?? 0) - 1;
  if (oldCount > 0) stats.byStatus[fromStatus] = oldCount;
  else delete stats.byStatus[fromStatus];
  stats.byStatus[toStatus] = (stats.byStatus[toStatus] ?? 0) + 1;
}

function statNumber(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

function resolveModelBucket(model: string): string {
  if (stats.models[model]) return model;
  if (Object.keys(stats.models).length >= MAX_MODEL_STATS) return "_other";
  return model;
}

function addModelStats(entry: StatsRequestEntry, forcedBucket?: string): string {
  const bucket = forcedBucket ?? resolveModelBucket(entry.model);
  const m = stats.models[bucket] ?? { count: 0, avgTtfb: 0, tokens: 0, inputTokens: 0 };
  const ttfbMs = statNumber(entry.ttfb);
  const nextTtfbTotal = (modelTtfbTotals.get(bucket) ?? (m.avgTtfb * m.count)) + ttfbMs;
  m.count++;
  m.avgTtfb = Math.round(nextTtfbTotal / m.count);
  m.tokens += statNumber(entry.tokens);
  m.inputTokens += statNumber(entry.inputTokens);
  stats.models[bucket] = m;
  modelTtfbTotals.set(bucket, nextTtfbTotal);
  return bucket;
}

function removeModelStats(bucket: string, entry: Pick<StatsRequestEntry, "ttfb" | "tokens" | "inputTokens">): void {
  const m = stats.models[bucket];
  if (!m) return;
  const nextCount = m.count - 1;
  const nextTtfbTotal = Math.max(0, (modelTtfbTotals.get(bucket) ?? (m.avgTtfb * m.count)) - statNumber(entry.ttfb));
  if (nextCount <= 0) {
    delete stats.models[bucket];
    modelTtfbTotals.delete(bucket);
    return;
  }
  m.count = nextCount;
  m.tokens = Math.max(0, m.tokens - statNumber(entry.tokens));
  m.inputTokens = Math.max(0, m.inputTokens - statNumber(entry.inputTokens));
  m.avgTtfb = Math.round(nextTtfbTotal / nextCount);
  stats.models[bucket] = m;
  modelTtfbTotals.set(bucket, nextTtfbTotal);
}

function updateModelStatsForRetry(oldBucket: string, oldEntry: StatsRequestEntry | SeenStat, newEntry: StatsRequestEntry): string {
  removeModelStats(oldBucket, oldEntry);
  const targetBucket = oldBucket === "_other" && !stats.models[newEntry.model] ? "_other" : undefined;
  return addModelStats(newEntry, targetBucket);
}

type CredentialStatEntry = Pick<StatsRequestEntry, "credentialKey" | "status" | "inputTokens" | "tokens"> & { time?: string };

function touchCredentialStat(key: string): void {
  credentialStatLastSeen.set(key, ++credentialStatSeq);
}

function pruneCredentialStats(): void {
  const keys = Object.keys(stats.byCredential);
  if (keys.length <= MAX_CREDENTIAL_STATS) return;
  keys.sort((a, b) => (credentialStatLastSeen.get(a) ?? 0) - (credentialStatLastSeen.get(b) ?? 0));
  const overflow = keys.length - MAX_CREDENTIAL_STATS;
  for (let i = 0; i < overflow; i++) {
    delete stats.byCredential[keys[i]];
    credentialStatLastSeen.delete(keys[i]);
  }
}

function addCredentialStats(entry: CredentialStatEntry): void {
  if (!entry.credentialKey) return;
  const c = stats.byCredential[entry.credentialKey] ?? { count: 0, inputTokens: 0, outputTokens: 0, lastUsed: "", success: 0, failed: 0 };
  if (isSuccessStatus(entry.status)) {
    c.count++;
    c.success++;
    c.inputTokens += statNumber(entry.inputTokens);
    c.outputTokens += statNumber(entry.tokens);
  } else {
    c.failed++;
  }
  c.lastUsed = entry.time ?? c.lastUsed;
  stats.byCredential[entry.credentialKey] = c;
  touchCredentialStat(entry.credentialKey);
  pruneCredentialStats();
}

function removeCredentialStats(entry: CredentialStatEntry): void {
  if (!entry.credentialKey) return;
  const c = stats.byCredential[entry.credentialKey];
  if (!c) return;
  if (isSuccessStatus(entry.status)) {
    c.count = Math.max(0, c.count - 1);
    c.success = Math.max(0, c.success - 1);
    c.inputTokens = Math.max(0, c.inputTokens - statNumber(entry.inputTokens));
    c.outputTokens = Math.max(0, c.outputTokens - statNumber(entry.tokens));
  } else {
    c.failed = Math.max(0, c.failed - 1);
  }
  if (c.count === 0 && c.success === 0 && c.failed === 0 && c.inputTokens === 0 && c.outputTokens === 0) {
    delete stats.byCredential[entry.credentialKey];
    credentialStatLastSeen.delete(entry.credentialKey);
  } else {
    stats.byCredential[entry.credentialKey] = c;
    touchCredentialStat(entry.credentialKey);
  }
}

function updateCredentialStatsForRetry(oldEntry: CredentialStatEntry, newEntry: CredentialStatEntry): void {
  removeCredentialStats(oldEntry);
  addCredentialStats(newEntry);
}

function rememberSeenStat(entry: StatsRequestEntry, modelBucket: string): void {
  // Map preserves insertion order, but `set()` on an existing key does not
  // move it. Delete first so retries refresh the id's LRU position; otherwise
  // an old request that was just updated could still be evicted immediately,
  // and a later retry would be double-counted as a brand-new request.
  seenIds.delete(entry.id);
  seenIds.set(entry.id, {
    status: entry.status,
    retried: !!entry.retried,
    model: entry.model,
    modelBucket,
    ttfb: entry.ttfb,
    tokens: entry.tokens,
    inputTokens: entry.inputTokens,
    credentialKey: entry.credentialKey,
  });
}

/**
 * Record a request for stats. Called from handler.ts printRow.
 *
 * Dedup: each request id is recorded at most once. Subsequent calls with
 * the same id (e.g. when printRow fires on the retry path) only refresh
 * the existing entry's status/tokens — they do NOT inflate the counters.
 * This fixes the previous bug where a single 529-then-200 request would
 * show up as 2 requests in the stats.
 *
 * vceshi0.0.6+: `inputTokens` and `credentialKey` fields added.
 * - inputTokens: from upstream usage.input_tokens / prompt_tokens
 * - credentialKey: credentialStatsKey(cred) for per-credential usage tracking
 */
export function recordStat(entry: { id: string; time: string; model: string; status: number; ttfb: string; tokens: string; inputTokens?: string; cacheReadTokens?: string; credentialKey?: string; retried?: boolean; captchaMs?: string }) {
  const existingIdx = requestIndex.get(entry.id);
  if (existingIdx !== undefined) {
    // Update the existing entry — do NOT increment counters again.
    const old = stats.requests[existingIdx];
    const nextEntry: StatsRequestEntry = {
      ...old,
      ...entry,
      inputTokens: entry.inputTokens ?? old.inputTokens ?? "0",
      cacheReadTokens: entry.cacheReadTokens ?? old.cacheReadTokens,
      credentialKey: entry.credentialKey ?? old.credentialKey,
      captchaMs: entry.captchaMs ?? old.captchaMs ?? "0",
      retried: entry.retried || old.retried,
    };
    // Re-classify if the status changed (e.g. 529 → 200 after retry).
    const wasSuccess = isSuccessStatus(old.status);
    const isSuccess = isSuccessStatus(entry.status);
    if (wasSuccess !== isSuccess) {
      if (isSuccess) { stats.failed--; stats.success++; }
      else { stats.success--; stats.failed++; }
    }
    // G5: Keep the status breakdown aligned with the latest status even when
    // both old/new statuses are failures, e.g. 529 -> 503.
    moveStatusCounter(old.status, entry.status);
    // Always count retry flag — the final entry wins.
    if (entry.retried && !old.retried) stats.retried++;
    updateCredentialStatsForRetry(old, nextEntry);
    const oldBucket = requestModelBuckets.get(entry.id) ?? seenIds.get(entry.id)?.modelBucket ?? old.model;
    const nextBucket = updateModelStatsForRetry(oldBucket, old, nextEntry);
    requestModelBuckets.set(entry.id, nextBucket);
    stats.requests[existingIdx] = nextEntry;
    rememberSeenStat(nextEntry, nextBucket);
    return;
  }

  // vceshi0.0.7+: even if the entry was evicted from requestIndex (by the
  // 200-entry trim below), check the lifetime seenIds set to avoid double-
  // counting. The retry's status update still flows through to the totals
  // (re-classifying success↔failed), but we don't create a new requests[]
  // row for it.
  const seen = seenIds.get(entry.id);
  if (seen) {
    // We've seen this id before but it was evicted from requestIndex. Reconcile
    // aggregate counters against the remembered state, but don't add a new row
    // or increment total.
    const wasSuccess = isSuccessStatus(seen.status);
    const isSuccess = isSuccessStatus(entry.status);
    if (wasSuccess !== isSuccess) {
      if (isSuccess) { stats.failed--; stats.success++; }
      else { stats.success--; stats.failed++; }
    }
    moveStatusCounter(seen.status, entry.status);
    if (entry.retried && !seen.retried) stats.retried++;
    const nextEntry: StatsRequestEntry = {
      id: entry.id,
      time: entry.time,
      model: entry.model,
      status: entry.status,
      ttfb: entry.ttfb,
      tokens: entry.tokens,
      inputTokens: entry.inputTokens ?? seen.inputTokens ?? "0",
      cacheReadTokens: entry.cacheReadTokens,
      credentialKey: entry.credentialKey ?? seen.credentialKey,
      captchaMs: entry.captchaMs ?? "0",
      retried: entry.retried || seen.retried,
    };
    updateCredentialStatsForRetry(seen, nextEntry);
    const nextBucket = updateModelStatsForRetry(seen.modelBucket, seen, nextEntry);
    rememberSeenStat(nextEntry, nextBucket);
    // Don't double-count total — it was already counted on first sighting.
    return;
  }

  const idx = stats.requests.length;
  stats.total++;
  if (isSuccessStatus(entry.status)) stats.success++;
  else stats.failed++;
  if (entry.retried) stats.retried++;
  // G5: Track by status code
  stats.byStatus[entry.status] = (stats.byStatus[entry.status] ?? 0) + 1;
  const fullEntry: StatsRequestEntry = { ...entry, inputTokens: entry.inputTokens ?? "0", captchaMs: entry.captchaMs ?? "0", cacheReadTokens: entry.cacheReadTokens };
  stats.requests.push(fullEntry);
  requestIndex.set(entry.id, idx);
  // vceshi0.0.7+: track lifetime-seen ids to handle post-trim retries.
  const modelBucket = addModelStats(fullEntry);
  requestModelBuckets.set(entry.id, modelBucket);
  rememberSeenStat(fullEntry, modelBucket);
  // Bound the seenIds map to prevent unbounded memory growth on long-lived
  // servers.
  //
  // v0.2.2+ FIX: LRU-style incremental eviction. The previous code did
  // `seenIds.clear()` then rebuilt from the (just-trimmed) requests array
  // — losing 4900+ ids at once and causing stats double-counting for any
  // retry whose id was older than the rebuild window. Under long-running
  // servers with frequent retries, stats could be inflated by 20%+.
  //
  // Now we evict the oldest SEEN_IDS_EVICT_BATCH entries when the limit
  // is hit. This is O(N) per eviction but only fires once per 1000 new
  // requests — negligible overhead. Map preserves insertion order so
  // `keys().next()` reliably returns the oldest entry.
  if (seenIds.size > SEEN_IDS_LIMIT) {
    let evicted = 0;
    const it = seenIds.keys();
    while (evicted < SEEN_IDS_EVICT_BATCH) {
      const r = it.next();
      if (r.done) break;
      seenIds.delete(r.value);
      evicted++;
    }
  }
  if (stats.requests.length > 200) {
    // Drop the oldest 100 entries; rebuild the index from the survivors.
    stats.requests = stats.requests.slice(-100);
    requestIndex.clear();
    requestModelBuckets.clear();
    for (let i = 0; i < stats.requests.length; i++) {
      requestIndex.set(stats.requests[i].id, i);
      const seen = seenIds.get(stats.requests[i].id);
      if (seen) requestModelBuckets.set(stats.requests[i].id, seen.modelBucket);
    }
  }

  // vceshi0.0.6+: per-credential usage tracking (in-memory).
  // G6: Now tracks both success AND failure counts per credential, enabling
  // the dashboard to display success rates. Previously only successes were
  // counted, making it impossible to identify credentials that are failing.
  // v0.2.2+: byCredential is also capped. It is normally keyed by the stored
  // credential set, but large imports or transient/rotated credential keys
  // should not grow dashboard stats forever on long-lived processes.
  addCredentialStats(fullEntry);
}

/**
 * Reset the in-memory stats collector. Exposed for unit tests so they can
 * start from a clean state without polluting each other. Not part of the
 * public API — production callers should use `DELETE /admin/api/stats`.
 * @internal
 */
function resetStats(): void {
  stats.total = 0;
  stats.success = 0;
  stats.failed = 0;
  stats.retried = 0;
  stats.requests = [];
  stats.models = {};
  stats.byCredential = {};
  stats.byStatus = {};
  requestIndex.clear();
  requestModelBuckets.clear();
  modelTtfbTotals.clear();
  seenIds.clear();
  credentialStatLastSeen.clear();
  credentialStatSeq = 0;
}

export function _resetStatsForTesting(): void {
  resetStats();
}

// Active OAuth flows (in-memory)
type ActiveOAuthFlow = { provider: string; flowId: string; pollToken: string; expiresAt: number; plan?: string; status?: string; error?: string; callbackUrl?: string; state?: string; close?: () => Promise<void> };
const MAX_ACTIVE_OAUTH_FLOWS = 100;
const OAUTH_FLOW_CLEANUP_GRACE_MS = 5 * 60_000;
const activeFlows = new Map<string, ActiveOAuthFlow>();

function closeActiveOAuthFlow(flow: ActiveOAuthFlow): void {
  const close = flow.close;
  if (!close) return;
  void close().catch((err) => {
    appendLog("debug", `OAuth flow ${flow.flowId} close failed: ${(err as Error).message}`);
  });
}

function deleteActiveOAuthFlow(flowId: string): boolean {
  const flow = activeFlows.get(flowId);
  if (!flow) return false;
  activeFlows.delete(flowId);
  closeActiveOAuthFlow(flow);
  return true;
}

function pruneActiveOAuthFlows(now = Date.now()): number {
  let cleaned = 0;
  for (const [id, flow] of activeFlows) {
    if (now > flow.expiresAt + OAUTH_FLOW_CLEANUP_GRACE_MS) {
      activeFlows.delete(id);
      closeActiveOAuthFlow(flow);
      cleaned++;
    }
  }
  while (activeFlows.size > MAX_ACTIVE_OAUTH_FLOWS) {
    const oldest = activeFlows.keys().next().value;
    if (oldest === undefined) break;
    deleteActiveOAuthFlow(oldest);
    cleaned++;
  }
  return cleaned;
}

function rememberActiveOAuthFlow(flowId: string, flow: ActiveOAuthFlow): void {
  pruneActiveOAuthFlows();
  deleteActiveOAuthFlow(flowId);
  activeFlows.set(flowId, flow);
  pruneActiveOAuthFlows();
}

export function _resetActiveOAuthFlowsForTesting(): void {
  for (const flow of activeFlows.values()) closeActiveOAuthFlow(flow);
  activeFlows.clear();
}

export function _activeOAuthFlowCountForTesting(): number {
  return activeFlows.size;
}

export function _hasActiveOAuthFlowForTesting(flowId: string): boolean {
  return activeFlows.has(flowId);
}

export function _rememberActiveOAuthFlowForTesting(
  flowId: string,
  expiresAt = Date.now() + 300_000,
  close?: () => Promise<void>,
): void {
  rememberActiveOAuthFlow(flowId, {
    provider: "zai",
    flowId,
    pollToken: flowId,
    expiresAt,
    close,
  });
}

// vceshi0.0.7+: Per-account quota result cache. Keyed by account id.
// Used by /admin/api/accounts/quota to rate-limit upstream billing queries.
// Bounded to 50 entries (FIFO eviction). Entries never expire on their own —
// they're refreshed on the next query after QUOTA_CACHE_MS.
const QUOTA_CACHE_LIMIT = 50;
const ACTIVATION_PROBE_LIMIT = 50;
const ACTIVATION_PROBE_HARD_TIMEOUT_MS = 45_000;
// Account-specific invalidation generations are tombstones for in-flight
// requests. Keep them bounded too; when this fills up we bump the global epoch
// and clear the tombstones, which safely invalidates all older in-flight quota
// requests without retaining one entry per historical account id forever.
const QUOTA_GENERATION_LIMIT = 200;
const quotaCache = new Map<string, { ts: number; result: unknown }>();
const quotaInFlight = new Map<string, Promise<unknown>>();
const quotaCacheGenerations = new Map<string, number>();
let quotaCacheEpoch = 0;
type ActivationProbeInFlight = {
  promise: Promise<unknown>;
  abort: () => void;
};
const activationProbeInFlight = new Map<string, ActivationProbeInFlight>();

function quotaGenerationForAccount(id: string): string {
  return `${quotaCacheEpoch}:${quotaCacheGenerations.get(id) ?? 0}`;
}

function pruneQuotaGenerations(): void {
  if (quotaCacheGenerations.size <= QUOTA_GENERATION_LIMIT) return;
  quotaCacheEpoch++;
  quotaCacheGenerations.clear();
}

function pruneActivationProbes(): void {
  while (activationProbeInFlight.size > ACTIVATION_PROBE_LIMIT) {
    const oldest = activationProbeInFlight.keys().next().value;
    if (oldest === undefined) break;
    const entry = activationProbeInFlight.get(oldest);
    activationProbeInFlight.delete(oldest);
    entry?.abort();
  }
}

function clearActivationProbes(): void {
  const entries = Array.from(activationProbeInFlight.values());
  activationProbeInFlight.clear();
  for (const entry of entries) entry.abort();
}

function clearQuotaCacheForAccount(id: string): void {
  quotaCache.delete(id);
  quotaInFlight.delete(id);
  quotaCacheGenerations.set(id, (quotaCacheGenerations.get(id) ?? 0) + 1);
  pruneQuotaGenerations();
}

function clearQuotaCache(): void {
  quotaCache.clear();
  quotaInFlight.clear();
  quotaCacheGenerations.clear();
  quotaCacheEpoch++;
  clearActivationProbes();
}

export function _resetQuotaCacheForTesting(): void {
  clearQuotaCache();
}

export function _quotaCacheStateForTesting(): { cached: number; inFlight: number; generations: number; epoch: number; activationProbes: number } {
  return {
    cached: quotaCache.size,
    inFlight: quotaInFlight.size,
    generations: quotaCacheGenerations.size,
    epoch: quotaCacheEpoch,
    activationProbes: activationProbeInFlight.size,
  };
}

function withActivationProbeHardTimeout<T>(task: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error(`activation probe timeout after ${ACTIVATION_PROBE_HARD_TIMEOUT_MS}ms`));
    }, ACTIVATION_PROBE_HARD_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

function withLinkedAbortSignal(baseFetch: typeof fetch, signal: AbortSignal): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstreamSignal = init?.signal;
    if (!upstreamSignal) {
      return baseFetch(input, { ...(init as RequestInit), signal });
    }
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal.aborted || upstreamSignal.aborted) {
      ctrl.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await baseFetch(input, { ...(init as RequestInit), signal: ctrl.signal });
    } finally {
      signal.removeEventListener("abort", onAbort);
      upstreamSignal.removeEventListener("abort", onAbort);
    }
  }) as typeof fetch;
}

/**
 * Fire-and-forget a start-plan quota probe right after a credential is saved.
 *
 * The GET billing/current call inside queryQuota is gated by `app_version` — a
 * real client version (3.1.x) activates the start-plan trial on a fresh
 * account on the very first successful query, while a low version (2.0.0)
 * never does (see quota.ts DEFAULT_APP_VERSION + the activation memory).
 *
 * OAuth token exchange itself does NOT activate the plan (verified), so a
 * freshly-OAuth'd account is still in `plans:[]` until something queries
 * billing/current with a real version. Firing this probe once at login means a
 * new account is "OAuth done = ready to use" — the user no longer has to click
 * the quota button manually just to flip the account on.
 *
 * Non-blocking by design: OAuth success must never depend on the activation
 * probe. Activation is irreversible, so even if this fires long after the HTTP
 * response returns, the account still ends up activated. Failures (network /
 * upstream) are swallowed to a debug log — the user can always retry by
 * clicking the quota button. Only start-plan (has a jwt) is probed; coding-plan
 * has no activation concept.
 */
function probeStartPlanActivation(
  cred: AppCredential,
  fetchImpl: typeof fetch,
  appVersion: string | undefined,
): void {
  if (cred.plan !== "start-plan" || !cred.jwt) return;
  const key = `${cred.provider}:${cred.apiKey}:${cred.jwt.slice(0, 16)}:${cred.proxy ?? ""}:${appVersion ?? ""}`;
  if (activationProbeInFlight.has(key)) return;
  pruneActivationProbes();
  // Honour a per-account outbound proxy if configured, matching the quota
  // handler's accountFetch construction. SOCKS proxies are routed through
  // the local HTTP-CONNECT→SOCKS bridge transparently via makeProxiedFetcher
  // (Bun's native fetch only supports HTTP proxies — see proxied-fetch.ts).
  const probeAbort = new AbortController();
  const abortProbe = () => {
    try { probeAbort.abort(); } catch {}
  };
  const accountFetch = withLinkedAbortSignal(makeProxiedFetcher(cred.proxy, fetchImpl), probeAbort.signal);
  const tag = cred.apiKey.slice(0, 8);
  let entry!: ActivationProbeInFlight;
  const probe = withActivationProbeHardTimeout(queryQuota(cred, accountFetch, appVersion), abortProbe)
    .then((r) => {
      if (activationProbeInFlight.get(key) !== entry) return r;
      const outcome = r.planName ?? r.unavailableReason ?? "ok";
      appendLog("info", `start-plan activation probe (${tag}…): ${outcome}`);
      return r;
    })
    .catch((e) => {
      if (activationProbeInFlight.get(key) === entry) {
        appendLog("debug", `start-plan activation probe (${tag}…) failed: ${(e as Error).message}`);
      }
      return undefined;
    })
    .finally(() => {
      if (activationProbeInFlight.get(key) === entry) activationProbeInFlight.delete(key);
    });
  entry = { promise: probe, abort: abortProbe };
  activationProbeInFlight.set(key, entry);
  pruneActivationProbes();
}

export function _probeStartPlanActivationForTesting(
  cred: AppCredential,
  fetchImpl: typeof fetch,
  appVersion?: string,
): void {
  probeStartPlanActivation(cred, fetchImpl, appVersion);
}

/**
 * Periodic cleanup of expired OAuth flows. Without this, abandoned flows
 * (user closed the browser without finishing auth) would accumulate in
 * memory forever — each one carries the pollToken and callbackUrl, both
 * sensitive-ish. Runs every 5 minutes; flows expire 5 minutes after their
 * expiresAt timestamp to give in-flight poll requests a chance to drain.
 */
setInterval(() => {
  const cleaned = pruneActiveOAuthFlows();
  if (cleaned > 0) {
    appendLog("debug", `OAuth flow cleanup: removed ${cleaned} expired flow(s)`);
  }
}, 5 * 60_000).unref?.();

// ---------------------------------------------------------------------------
// Debug dump ring buffer (replaces the old writeFileSync-to-disk approach).
// Upstream 4xx bodies used to be written to <cwd>/zcode-proxy-debug-*.json,
// which leaked user conversation content to disk forever. Now we keep the
// last 20 dumps in memory and expose them via /admin/api/debug-dumps.
// ---------------------------------------------------------------------------
const DEBUG_DUMP_LIMIT = 20;
const DEBUG_DUMP_BODY_MAX_CHARS = 64 * 1024;
const DEBUG_DUMP_SUMMARY_MAX_CHARS = 8 * 1024;
const DEBUG_DUMP_ERROR_MAX_CHARS = 2 * 1024;
const DEBUG_DUMP_BETA_MAX_CHARS = 1024;
const ADMIN_ERROR_MESSAGE_MAX_CHARS = 1000;
const debugDumps: Array<{
  id: string;
  time: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}> = [];

function truncateDebugDumpField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function truncateAdminErrorMessage(value: string): string {
  if (value.length <= ADMIN_ERROR_MESSAGE_MAX_CHARS) return value;
  const omitted = value.length - ADMIN_ERROR_MESSAGE_MAX_CHARS;
  return `${value.slice(0, ADMIN_ERROR_MESSAGE_MAX_CHARS)}...(truncated ${omitted} chars)`;
}

/**
 * Record a 4xx upstream response's transformed body for diagnostics.
 * Called from handler.ts when upstream returns 4xx.
 */
export function recordDebugDump(entry: {
  id: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}): void {
  debugDumps.push({
    id: entry.id,
    status: entry.status,
    upstreamError: truncateDebugDumpField(entry.upstreamError, DEBUG_DUMP_ERROR_MAX_CHARS),
    anthropicBeta: truncateDebugDumpField(entry.anthropicBeta, DEBUG_DUMP_BETA_MAX_CHARS),
    bodySummary: truncateDebugDumpField(entry.bodySummary, DEBUG_DUMP_SUMMARY_MAX_CHARS),
    body: truncateDebugDumpField(entry.body, DEBUG_DUMP_BODY_MAX_CHARS),
    time: new Date().toISOString().slice(11, 19),
  });
  if (debugDumps.length > DEBUG_DUMP_LIMIT) {
    debugDumps.splice(0, debugDumps.length - DEBUG_DUMP_LIMIT);
  }
}

/** Clear all debug dumps. */
export function clearDebugDumps(): void {
  debugDumps.length = 0;
}

// ---------------------------------------------------------------------------
// Config persistence — atomic writes + mutex serialization.
//
// The dashboard allows concurrent edits (multiple tabs, multiple users on a
// LAN). Without serialization, two PUTs race: last write wins, losing one of
// the changes. The mutex serializes all config mutations so they apply in
// arrival order.
//
// Writes are also atomic: write to {path}.{pid}.tmp-{ts} then rename. A crash
// between truncate and full write of a non-atomic writeFile leaves a partial
// YAML file; on next startup loadConfig throws and the user is locked out of
// their own config.
// ---------------------------------------------------------------------------
const configWriteMutex = createMutex();
const persistConfig = (config: ProxyConfig, configPath: string): Promise<void> =>
  configWriteMutex.run(() => atomicWriteFile(configPath, configToYaml(config)));

/**
 * Translate a store mutation result into an HTTP response.
 *
 * After the 凭证丢失 bug fix, switchAccount / setAccount* / removeAccount can
 * return THREE values:
 *   - true  : mutation succeeded → caller continues normally
 *   - false : account not found (or disabled, for switchAccount) → 404
 *   - null  : store could not be read (transient AV lock / IO error) → 503
 *
 * The 503 path is NEW — previously the store would silently fall back to an
 * empty store and clobber the user's credentials. Now we refuse the write
 * and tell the dashboard "try again in a moment". The dashboard should
 * surface this as a transient error, NOT a "not found" error.
 *
 * Returns null when the caller should continue (success), or a Response
 * when the caller should return immediately.
 *
 * NOTE: jsonResp is defined later in this file but is hoisted (function
 * declaration), so we can reference it here.
 */
function handleMutationResult(
  result: boolean | null,
  notFoundMessage = "Account not found",
): Response | null {
  if (result === true) return null; // success — caller continues
  if (result === null) {
    return jsonResp(
      {
        error: {
          type: "store_unavailable",
          message:
            "Credential store is temporarily unreadable (possibly locked by " +
            "antivirus or another process). Please wait a few seconds and try again. " +
            "No changes were made — your credentials are safe.",
        },
      },
      503,
    );
  }
  return errorResponse(404, "not_found", notFoundMessage);
}

// Log buffer for streaming — uses a monotonic sequence number per entry
// so that SSE clients can track their position even when the underlying
// array is trimmed. The old approach used array indices, which became
// stale whenever splice() ran — causing clients to miss logs or replay
// old ones after a trim event.
const LOG_BUFFER_SIZE = LOG_CONST.BUFFER_SIZE;
// G8: Ring buffer implementation — replaces the old splice-based approach.
// splice(0, N) on a 2000-element array copies 1000 elements and is O(N).
// A ring buffer avoids the copy entirely — push at the write cursor,
// overwrite the oldest entry when full, and iterate via modulo arithmetic.
// The logBuffer array is pre-allocated to LOG_BUFFER_SIZE to avoid resizing.
type LogEntry = { seq: number; time: string; level: string; message: string };
type SerializedLogEntry = { entry: LogEntry; json: string; sse: string };
type LogWaiter = {
  resolve: (value: SerializedLogEntry) => void;
  resolveBatch: (values: readonly SerializedLogEntry[]) => void;
  flush: () => void;
};

const logBufferRing = new Array<LogEntry | null>(LOG_BUFFER_SIZE).fill(null);
let logRingWrite = 0;  // next write position (wraps around)
let logRingCount = 0;  // number of valid entries (0..LOG_BUFFER_SIZE)
let logSeq = 0; // monotonic, never reset — used as client cursor
const MAX_LOG_STREAM_SUBSCRIBERS = 50;
const logWaiters: LogWaiter[] = [];
// v0.2.2+ PERF: pending batch of log entries to fan out in one microtask.
// See appendLog() for the rationale.
let pendingLogEntries: SerializedLogEntry[] = [];
let logFlushScheduled = false;
let pendingLogOverflow = false;
const MAX_PENDING_LOG_FANOUT = 512;
const DEFAULT_LOG_STREAM_BACKPRESSURE_CHUNKS = 256;
let logStreamBackpressureChunksForTesting: number | undefined;

// G3: File logging — when set, each log entry is also appended to this file.
// Set via config.logging.file or env var ZCODE_PROXY_LOG_FILE.
let logFilePath: string | undefined;
// === CRITICAL FIX (管理面板刷新卡顿) ===
// Buffered async file logging — replaces the old `appendFileSync` per-log
// write which blocked the event loop on Windows. See appendLog() for the
// full rationale.
type PendingLogFileLine = { path: string; line: string };
const logFileBuffer: PendingLogFileLine[] = [];
let logFileFlushInterval: ReturnType<typeof setInterval> | null = null;
let logFileFlushInFlight: Promise<void> | null = null;
const LOG_FILE_FLUSH_WARN_INTERVAL_MS = 60_000;
const LOG_FILE_DROP_WARN_INTERVAL_MS = 60_000;
let logFileFlushWarnKey: string | undefined;
let logFileFlushLastWarnAt = 0;
let logFileDroppedSinceWarn = 0;
let logFileDropLastWarnAt = 0;
let logFileDropWarnInProgress = false;
import { appendFile as appendFileAsync } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let appendLogFile = appendFileAsync;

function warnLogFileFlushFailure(path: string, message: string): void {
  const now = Date.now();
  const key = `${path}\0${message}`;
  if (key === logFileFlushWarnKey && now - logFileFlushLastWarnAt < LOG_FILE_FLUSH_WARN_INTERVAL_MS) {
    return;
  }
  logFileFlushWarnKey = key;
  logFileFlushLastWarnAt = now;
  console.warn(`[admin] Could not flush log file ${path}: ${message}`);
}

function warnLogFileBufferDrop(path: string): void {
  if (logFileDropWarnInProgress) return;
  logFileDroppedSinceWarn++;
  const now = Date.now();
  if (now - logFileDropLastWarnAt < LOG_FILE_DROP_WARN_INTERVAL_MS) return;
  const dropped = logFileDroppedSinceWarn;
  logFileDroppedSinceWarn = 0;
  logFileDropLastWarnAt = now;
  logFileDropWarnInProgress = true;
  try {
    console.warn(
      `[admin] Log file buffer is full (${LOG_CONST.FILE_BUFFER_MAX} pending entries); ` +
      `dropped ${dropped} log line(s) for ${path}. Disk may be slow or unavailable.`,
    );
  } finally {
    logFileDropWarnInProgress = false;
  }
}

/**
 * Flush the log file buffer to disk asynchronously. Called by the interval
 * timer (every 500ms) and on process exit (best-effort). Errors are logged
 * to console.warn with throttling and don't break the server.
 */
async function appendLogFileBatch(path: string, lines: string[]): Promise<void> {
  try {
    await appendLogFile(path, lines.join(""));
    logFileFlushWarnKey = undefined;
    logFileFlushLastWarnAt = 0;
  } catch (err) {
    warnLogFileFlushFailure(path, (err as Error).message);
  }
}

async function drainLogFileBuffer(): Promise<void> {
  while (logFileBuffer.length > 0) {
    // Snapshot and clear the buffer atomically. Each line captures the target
    // path at append time, so switching log files while a slow flush is active
    // cannot send old-path lines into the new file.
    const snapshot = logFileBuffer.splice(0, logFileBuffer.length);
    let currentPath = "";
    let lines: string[] = [];
    for (const item of snapshot) {
      if (currentPath && item.path !== currentPath) {
        await appendLogFileBatch(currentPath, lines);
        lines = [];
      }
      currentPath = item.path;
      lines.push(item.line);
    }
    if (currentPath && lines.length > 0) {
      await appendLogFileBatch(currentPath, lines);
    }
  }
}

async function flushLogFile(): Promise<void> {
  if (logFileFlushInFlight) return logFileFlushInFlight;
  if (logFileBuffer.length === 0) return;
  // Serialize async file appends. A slow disk / antivirus scan can easily make
  // the 500ms interval fire again before the previous append completes; without
  // this guard, concurrent appendFile calls can reorder log lines and add I/O
  // pressure exactly when the machine is already struggling.
  logFileFlushInFlight = drainLogFileBuffer().finally(() => {
    logFileFlushInFlight = null;
    if (logFileBuffer.length > 0) void flushLogFile();
  });
  return logFileFlushInFlight;
}

/**
 * Set the file path for persistent log output. Called from index.ts after
 * config is loaded. Each appendLog() call will also write the entry as a
 * JSON line to this file (buffered + async, see appendLog). Set to
 * undefined to disable file logging.
 */
export function setLogFilePath(path: string | undefined): void {
  // If we're switching paths or disabling, flush any pending entries first.
  // (Best-effort — don't block on this.)
  if (logFileBuffer.length > 0 && logFilePath) {
    void flushLogFile();
  }
  // Clear any existing interval before switching.
  if (logFileFlushInterval) {
    clearInterval(logFileFlushInterval);
    logFileFlushInterval = null;
  }
  logFilePath = path;
  logFileFlushWarnKey = undefined;
  logFileFlushLastWarnAt = 0;
  if (path) {
    // Ensure the parent directory exists
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch { /* may already exist */ }
    // Start the async flush interval — every LOG.FILE_FLUSH_INTERVAL_MS, drain the buffer.
    // This replaces the per-log appendFileSync which was blocking the event
    // loop on Windows (each sync write = 5-50ms with AV interference).
    logFileFlushInterval = setInterval(flushLogFile, LOG_CONST.FILE_FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for this interval — it should only
    // fire while the server is running for other reasons.
    if (typeof logFileFlushInterval.unref === "function") {
      logFileFlushInterval.unref();
    }
    appendLog("info", `File logging enabled: ${path}`);
  }
}

export function flushLogFileForShutdown(): Promise<void> {
  return flushLogFile();
}

export function _flushLogFileForTesting(): Promise<void> {
  return flushLogFileForShutdown();
}

export function _logFileFlushStateForTesting(): { pending: number; inFlight: boolean } {
  return { pending: logFileBuffer.length, inFlight: logFileFlushInFlight !== null };
}

export function _setLogFileAppendForTesting(fn?: typeof appendFileAsync): void {
  appendLogFile = fn ?? appendFileAsync;
}

export function _logWaiterCountForTesting(): number {
  return logWaiters.length;
}

export function _setLogStreamBackpressureLimitForTesting(chunks?: number): void {
  logStreamBackpressureChunksForTesting = typeof chunks === "number" && Number.isFinite(chunks)
    ? Math.max(1, Math.floor(chunks))
    : undefined;
}

export function _resetLogFileForTesting(): void {
  if (logFileFlushInterval) {
    clearInterval(logFileFlushInterval);
    logFileFlushInterval = null;
  }
  logFilePath = undefined;
  logFileBuffer.length = 0;
  logFileFlushInFlight = null;
  appendLogFile = appendFileAsync;
  logFileFlushWarnKey = undefined;
  logFileFlushLastWarnAt = 0;
  logFileDroppedSinceWarn = 0;
  logFileDropLastWarnAt = 0;
  logFileDropWarnInProgress = false;
  logStreamBackpressureChunksForTesting = undefined;
}

/**
 * Iterate over the ring buffer in order (oldest → newest).
 * Yields only non-null entries. Used by SSE flush and batch endpoint.
 */
function* iterRingBuffer(): Generator<LogEntry> {
  if (logRingCount === 0) return;
  // If the buffer isn't full yet, start from index 0.
  // If full, logRingWrite points to the OLDEST entry (next to be overwritten).
  const start = logRingCount < LOG_BUFFER_SIZE ? 0 : logRingWrite;
  for (let i = 0; i < logRingCount; i++) {
    const idx = (start + i) % LOG_BUFFER_SIZE;
    const entry = logBufferRing[idx];
    if (entry) yield entry;
  }
}

/**
 * Return the most recent log entries in chronological order without first
 * materializing the whole ring. Used by dashboard refresh paths where the
 * caller only needs a tail window.
 */
function recentRingEntries(limit: number): LogEntry[] {
  if (logRingCount === 0 || limit <= 0) return [];
  const count = Math.min(Math.floor(limit), logRingCount);
  const result: LogEntry[] = [];
  const oldest = logRingCount < LOG_BUFFER_SIZE ? 0 : logRingWrite;
  const first = logRingCount - count;
  for (let i = 0; i < count; i++) {
    const idx = (oldest + first + i) % LOG_BUFFER_SIZE;
    const entry = logBufferRing[idx];
    if (entry) result.push(entry);
  }
  return result;
}

/**
 * Return the most recent matching log entries in chronological order without
 * materializing/filtering the whole ring. This keeps the dashboard's filtered
 * log polling cheap after the process has been running for a long time.
 */
function recentMatchingRingEntries(limit: number, level?: string | null, search?: string | null): LogEntry[] {
  if (logRingCount === 0 || limit <= 0) return [];
  const count = Math.min(Math.floor(limit), logRingCount);
  const result: LogEntry[] = [];
  const oldest = logRingCount < LOG_BUFFER_SIZE ? 0 : logRingWrite;
  for (let i = logRingCount - 1; i >= 0; i--) {
    const idx = (oldest + i) % LOG_BUFFER_SIZE;
    const entry = logBufferRing[idx];
    if (!entry) continue;
    if (level && entry.level !== level) continue;
    if (search && !entry.message.toLowerCase().includes(search)) continue;
    result.push(entry);
    if (result.length >= count) break;
  }
  return result.reverse();
}

function parseQueryLimit(raw: string | null, fallback: number, max: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(n, max);
}

/** Add a log entry to the buffer (called by intercepting console.log). */
export function appendLog(level: string, message: string) {
  // v0.2.2+: keep log storage compact by default, but reserve more room for
  // explicit diagnostics. `console.log("[debug] ...")` arrives here as level
  // "info", so content tags matter in addition to the structured level.
  const isDebugDiagnostic = level === "debug" || message.includes("[debug]");
  const isVerbose = message.includes("[verbose]");
  const maxLen = isDebugDiagnostic
    ? LOG_CONST.DEBUG_MAX_CHARS
    : isVerbose
      ? LOG_CONST.VERBOSE_MAX_CHARS
      : LOG_CONST.REGULAR_MAX_CHARS;
  const entry = {
    seq: ++logSeq,
    time: new Date().toISOString().slice(11, 19),
    level,
    message: message.slice(0, maxLen),
  };
  const entryJson = JSON.stringify(entry);
  const serializedEntry: SerializedLogEntry = {
    entry,
    json: entryJson,
    sse: `data: ${entryJson}\n\n`,
  };
  // Ring buffer write — overwrite oldest when full
  logBufferRing[logRingWrite] = entry;
  logRingWrite = (logRingWrite + 1) % LOG_BUFFER_SIZE;
  if (logRingCount < LOG_BUFFER_SIZE) logRingCount++;
  // G3: File logging — append entry as JSON line if file path is set.
  //
  // === CRITICAL FIX (管理面板刷新卡顿) ===
  // Previously used `appendFileSync` which is SYNCHRONOUS — every console.log
  // blocks the event loop until the disk write completes. On Windows with
  // antivirus / Windows Search indexer running, each appendFileSync can take
  // 5-50ms (vs <1ms on Linux). At 50 logs/sec that's 250ms-2.5s of event-loop
  // blocking per second — the entire server freezes, manifesting as
  // "管理面板刷新卡一会才能点击".
  //
  // Now we use a BUFFERED ASYNC write:
  //   - Entries are pushed to an in-memory array (logFileBuffer)
  //   - A setInterval flushes the buffer every 500ms via fs.promises.appendFile
  //   - If the buffer grows too large (>1000 entries), we drop logs to avoid
  //     memory bloat (file logging is best-effort, not critical)
  //
  // This reduces disk writes from N (per-log) to ~1 per 500ms, and each
  // write is async so it doesn't block the event loop.
  if (logFilePath) {
    if (logFileBuffer.length < LOG_CONST.FILE_BUFFER_MAX) {
      logFileBuffer.push({ path: logFilePath, line: entryJson + "\n" });
    } else {
      warnLogFileBufferDrop(logFilePath);
    }
    // The flush is triggered by logFileFlushInterval (set up in setLogFilePath).
    // If the interval isn't running yet (e.g. setLogFilePath hasn't been called
    // or was called with a null path), fall back to nothing — entries will
    // just accumulate in the buffer until the next flush.
  }
  // Push the new entry to every connected SSE client.
  //
  // v0.2.2+ PERF: batched microtask fan-out. Previously each appendLog
  // call iterated `logWaiters` synchronously and called `resolve(entry)`
  // for each — at 100 logs/sec × 50 dashboard tabs that's 5000 synchronous
  // `controller.enqueue` calls per second, each doing JSON.stringify +
  // TextEncoder.encode. The synchronous fan-out blocked the event loop
  // and stalled in-flight requests under high log volume.
  //
  // Now we batch entries into a pending array and flush them in a single
  // microtask. Multiple appendLog calls within the same microtask tick
  // share one fan-out pass per waiter and one SSE chunk per waiter,
  // reducing enqueue/JSON/encode work by ~10× during log storms.
  if (!pendingLogOverflow) {
    if (pendingLogEntries.length < MAX_PENDING_LOG_FANOUT) {
      pendingLogEntries.push(serializedEntry);
    } else {
      // A synchronous log storm can enqueue thousands of entries before the
      // microtask below gets a chance to run. Don't let that pending array
      // grow without bound; ask each SSE client to flush from the ring buffer
      // cursor once instead. The ring is capped, so memory stays bounded and
      // clients still receive the latest retained entries in order.
      pendingLogOverflow = true;
      pendingLogEntries = [];
    }
  }
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    queueMicrotask(() => {
      logFlushScheduled = false;
      const batch = pendingLogEntries;
      const overflow = pendingLogOverflow;
      pendingLogEntries = [];
      pendingLogOverflow = false;
      // Iterate a snapshot in case logWaiters is mutated during the loop
      // (a waiter's resolve() may register a new waiter via re-poll).
      const waiters = logWaiters.slice();
      for (const w of waiters) {
        try {
          if (overflow) {
            w.flush();
          } else if (batch.length === 1) {
            w.resolve(batch[0]);
          } else if (batch.length > 1) {
            w.resolveBatch(batch);
          }
        } catch { /* controller closed */ }
      }
    });
  }
}

/** Read the bundled dashboard HTML (inlined at build time). */
export function getDashboardHTML(): string {
  return dashboardHtml;
}

/** Handle admin API routes. Returns null if the path doesn't match. */
export async function handleAdminRoute(req: Request, opts: AdminOptions): Promise<Response | null> {
  const resp = await handleAdminRouteInner(req, opts);
  if (!resp) return null;
  // Apply security headers to every admin response (dashboard page + API).
  // Skipped for SSE streams (logs/stream) — adding headers post-stream-start
  // is a no-op anyway, and we don't want to interfere with the response
  // once the streaming writer has flushed.
  if (resp.headers.get("content-type")?.includes("text/event-stream")) return resp;
  return withSecurityHeaders(resp);
}

/** Inner implementation — returns raw responses without security headers. */
async function handleAdminRouteInner(req: Request, opts: AdminOptions): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Serve dashboard page
  if (path === "/admin" || path === "/admin/") {
    return new Response(getDashboardHTML(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Verify auth token for API routes
  //
  // v0.2.0.8 SECURITY: /admin/api/verify is now ALSO subject to the loopback
  // gate when proxyApiKey is unset (previously it was exempt, leaking "no auth
  // configured" to non-loopback callers). However, when proxyApiKey IS set,
  // /verify must fall through to its own route handler so the per-IP
  // rate-limiting on wrong tokens still works — otherwise the gate would
  // short-circuit every wrong token to 401 and the verify route's
  // rate-limit counter would never increment.
  const isVerifyRouteWithAuth = path === "/admin/api/verify" && opts.config.auth.proxyApiKey;
  if (path.startsWith("/admin/api/") && !isVerifyRouteWithAuth) {
    // Allow SSE endpoints to receive the token via query parameter, since
    // EventSource cannot set custom HTTP headers.
    const authHeader = req.headers.get("authorization") ?? "";
    let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token && path === "/admin/api/logs/stream") {
      token = url.searchParams.get("token") ?? "";
    }

    // v0.1.5+ SECURITY: when proxyApiKey is NOT configured, all admin API
    // routes require the request to come from the loopback address
    // (127.0.0.1, ::1, localhost).
    //
    // Without this check, anyone who can reach the proxy port can:
    //   - POST /admin/api/credentials → inject their own API key
    //   - DELETE /admin/api/credentials → wipe the user's stored accounts
    //   - PUT /admin/api/config → change config (e.g. disable proxyApiKey)
    //   - POST /admin/api/accounts/import → inject credentials
    //
    // Loopback-only is a safe default: local dev tools (dashboard, CLI)
    // run on the same host. Remote admin requires explicit proxyApiKey
    // configuration. Operators who want remote admin without auth can
    // still do so by binding to 0.0.0.0 + setting proxyApiKey (recommended)
    // or by accepting the risk and proxying via SSH.
    if (!opts.config.auth.proxyApiKey) {
      // Client IP resolution priority:
      //   1. resolveClientIp (Bun's server.requestIP — TCP socket peer,
      //      cannot be spoofed by headers)
      //   2. X-Real-IP / X-Forwarded-For — ONLY when config.server.trustProxy
      //      is true (operator explicitly opted in because they're behind a
      //      trusted reverse proxy that overwrites these headers).
      //   3. "unknown" → defaults to loopback (preserves dev behavior for
      //      direct local connections and for tests that have no socket).
      let remoteIp: string | undefined;
      if (opts.resolveClientIp) {
        try { remoteIp = opts.resolveClientIp(req); } catch { /* ignore */ }
      }
      if (opts.config.server.trustProxy) {
        const xRealIp = req.headers.get("x-real-ip") ?? "";
        const xForwardedFor = req.headers.get("x-forwarded-for") ?? "";
        const xffIp = xRealIp || (xForwardedFor ? xForwardedFor.split(",")[0].trim() : "");
        if (xffIp) remoteIp = xffIp;
      }
      const isLoopback = !remoteIp
        || remoteIp === "127.0.0.1"
        || remoteIp === "::1"
        || remoteIp === "localhost"
        || remoteIp === "::ffff:127.0.0.1";

      if (!isLoopback) {
        // Non-loopback remote + no proxyApiKey configured → reject.
        // Surface a clear message so the operator knows what to fix.
        return errorResponse(
          401,
          "authentication_required",
          "Admin API requires auth.proxyApiKey to be configured when accessed from a non-loopback address. " +
          "Set `auth.proxyApiKey` in config.yaml or env ZCODE_PROXY_API_KEY, then provide it as " +
          "`Authorization: Bearer <key>` on admin API requests.",
        );
      }
      // Loopback + no proxyApiKey → allow (legacy dev behavior).
      // Fall through to per-route logic.
    } else if (!timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
      return errorResponse(401, "authentication_error", "Invalid admin token");
    }
  }

  // --- API Routes ---

  // Verify token
  // Returns {valid: true} when the token matches. When no proxyApiKey is
  // configured the endpoint returns {valid: true, warning: "no_auth"} so
  // the dashboard can surface the security warning to the user instead of
  // silently letting anyone in.
  if (path === "/admin/api/verify" && method === "GET") {
    const clientIp = resolveIpForRateLimit(req, opts);
    // Rate-limit: if this IP has exceeded the failure threshold, reject
    // without even checking the token — prevents timing-based oracle
    // attacks where an attacker could distinguish "locked" vs "wrong"
    // by response time.
    if (isVerifyLocked(clientIp)) {
      return errorResponse(429, "rate_limited", "Too many failed verification attempts. Try again later.");
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!opts.config.auth.proxyApiKey) {
      return jsonResp({ valid: true, warning: "no_auth", message: "proxyApiKey not configured — admin dashboard is open to anyone with network access" });
    }
    if (timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
      // Successful verification clears the failure counter for this IP,
      // so a user who mistypes once doesn't carry a strike forever.
      verifyFailures.delete(clientIp);
      return jsonResp({ valid: true });
    }
    recordVerifyFailure(clientIp);
    return errorResponse(401, "authentication_error", "Invalid token");
  }

  // Get config
  if (path === "/admin/api/config" && method === "GET") {
    return jsonResp(sanitizeConfig(opts.config));
  }

  // Update config
  if (path === "/admin/api/config" && method === "PUT") {
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // Prevent masked placeholder values from overwriting real secrets.
      // The sanitizeConfig() GET endpoint returns "***configured***" for
      // secret fields; if the dashboard sends those back unchanged we skip them.
      const authBody = optionalConfigObject(body, "auth");
      const hasCorsAllowList = Object.prototype.hasOwnProperty.call(body, "corsAllowList");
      const hasResponsesThinking = Object.prototype.hasOwnProperty.call(body, "responsesThinking");
      const hasRoutingRules = Object.prototype.hasOwnProperty.call(body, "routingRules");
      const hasModelMappings = Object.prototype.hasOwnProperty.call(body, "modelMappings");
      const hasModels = Object.prototype.hasOwnProperty.call(body, "models");
      const newServer = optionalConfigObject(body, "server");
      const retryBody = optionalConfigObject(body, "retry");
      const identityBody = optionalConfigObject(body, "identity");
      const loggingBody = optionalConfigObject(body, "logging");
      const providersBody = optionalConfigObject(body, "providers");
      if (hasModels && !Array.isArray(body.models)) {
        throw new Error("models must be an array");
      }
      if (authBody) {
        if (authBody.apiKey === CONFIG_SECRET_MASK || authBody.apiKey === "") delete authBody.apiKey;
        if (authBody.proxyApiKey === CONFIG_SECRET_MASK || authBody.proxyApiKey === "") delete authBody.proxyApiKey;
      }

      // Compute which fields changed in a way that requires a server restart
      // to take effect (vs. fields that can be hot-swapped at runtime).
      // The dashboard uses this to show "restart required" highlights.
      const oldPort = opts.config.server.port;
      const oldHost = opts.config.server.host;

      const newConfig = { ...opts.config, ...body };
      // Deep-merge nested objects so partial updates don't drop fields.
      // Previously only `auth` was deep-merged; `retry` / `identity` / `logging`
      // / `providers` were shallow-merged, meaning a client sending
      // `{"retry":{"maxRetries":5}}` would lose all other retry fields
      // (initialDelayMs, retryableStatuses, emptyStreamSwitchThreshold, etc.),
      // causing runtime TypeError in handler.ts when those fields became undefined.
      if (authBody) {
        newConfig.auth = { ...opts.config.auth, ...authBody };
      }
      // v0.2.1.7+: deep-merge server so partial updates (e.g. only sending
      // sseHeartbeatMs) don't drop port / host / upstreamTimeoutMs / trustProxy /
      // maxRequestBodyBytes.
      // port + host changes require restart; other server fields are hot-swappable.
      if (newServer) {
        newConfig.server = {
          ...opts.config.server,
          ...newServer,
        };
      }
      if (retryBody) {
        const rawRetryStatuses = retryBody.retryableStatuses;
        newConfig.retry = {
          ...opts.config.retry,
          ...retryBody,
          // retryableStatuses is an array — if client sends it, use it; else keep existing
          retryableStatuses: Array.isArray(rawRetryStatuses)
            ? normalizeRetryableStatuses(rawRetryStatuses)
            : [...opts.config.retry.retryableStatuses],
        };
      }
      if (identityBody) {
        newConfig.identity = { ...opts.config.identity, ...identityBody };
      }
      if (loggingBody) {
        newConfig.logging = { ...opts.config.logging, ...loggingBody };
      }
      if (providersBody) {
        const zaiBody = optionalNestedConfigObject(providersBody, "zai", "providers.zai") ?? {};
        const bigmodelBody = optionalNestedConfigObject(providersBody, "bigmodel", "providers.bigmodel") ?? {};
        if (zaiBody.credential === CONFIG_SECRET_MASK || zaiBody.credential === "") delete zaiBody.credential;
        if (bigmodelBody.credential === CONFIG_SECRET_MASK || bigmodelBody.credential === "") delete bigmodelBody.credential;
        newConfig.providers = {
          zai: { ...opts.config.providers.zai, ...zaiBody },
          bigmodel: { ...opts.config.providers.bigmodel, ...bigmodelBody },
        };
      }
      // v0.2.2+ FIX: defensive deep-clone for nested objects that the
      // dashboard may mutate. Without this, `newConfig.responsesThinking`
      // would be the SAME object reference as `opts.config.responsesThinking`
      // (because the spread above only shallow-copies), and any in-place
      // mutation (e.g. `newConfig.responsesThinking.models.push(...)`)
      // would corrupt the live in-memory config even if the persist fails.
      // Same for `corsAllowList` and `routingRules` / `modelMappings`.
      if (opts.config.responsesThinking || hasResponsesThinking) {
        const currentResponsesThinking = opts.config.responsesThinking;
        newConfig.responsesThinking = {
          models: Array.isArray(currentResponsesThinking?.models)
            ? [...currentResponsesThinking.models]
            : [],
        };
        if (hasResponsesThinking) {
          const raw = body.responsesThinking as any;
          if (raw !== null && !Array.isArray(raw) && !isConfigObject(raw)) {
            throw new Error("responsesThinking must be an object or an array of strings");
          }
          const models = Array.isArray(raw) ? raw : raw ? raw.models : undefined;
          if (models === undefined || models === null) {
            newConfig.responsesThinking.models = [];
          } else if (Array.isArray(models) && models.every((model) => typeof model === "string")) {
            newConfig.responsesThinking.models = [...models];
          } else {
            throw new Error("responsesThinking.models must be an array of strings");
          }
        }
      }
      if (Array.isArray(opts.config.routingRules) || hasRoutingRules) {
        const rawRules = hasRoutingRules ? body.routingRules : opts.config.routingRules;
        if (!Array.isArray(rawRules)) {
          throw new Error("routingRules must be an array");
        }
        newConfig.routingRules = normalizeRoutingRulesForSave(rawRules);
      }
      if (Array.isArray(opts.config.modelMappings) || hasModelMappings) {
        const rawMappings = hasModelMappings ? body.modelMappings : opts.config.modelMappings;
        if (!Array.isArray(rawMappings)) {
          throw new Error("modelMappings must be an array");
        }
        newConfig.modelMappings = normalizeModelMappingsForSave(rawMappings);
      }
      if (Array.isArray((opts.config as any).corsAllowList)) {
        (newConfig as any).corsAllowList = [...(opts.config as any).corsAllowList];
      }
      if (hasCorsAllowList) {
        if (Array.isArray(body.corsAllowList)) {
          const entries = body.corsAllowList as unknown[];
          if (!entries.every((entry) => typeof entry === "string")) {
            throw new Error("corsAllowList must be an array of strings");
          }
          (newConfig as any).corsAllowList = entries.map((entry) => entry.trim()).filter(Boolean);
        } else if (body.corsAllowList == null) {
          delete (newConfig as any).corsAllowList;
        } else {
          throw new Error("corsAllowList must be an array of strings");
        }
      }
      if (Array.isArray(opts.config.models)) {
        newConfig.models = [...opts.config.models];
        if (Array.isArray(body.models)) {
          newConfig.models = normalizeModelList(body.models, newConfig.defaultModel);
        }
      }
      // Normalize + validate the merged config before persisting. This keeps
      // dashboard/API saves aligned with loadConfig(): numeric strings like
      // "8080" become numbers, but trailing junk like "8080abc" is rejected
      // instead of being prefix-parsed by parseInt.
      normalizeConfigForSave(newConfig);
      validateConfigForSave(newConfig);

      const restartFields: string[] = [];
      if (newServer) {
        if (Object.prototype.hasOwnProperty.call(newServer, "port") && newConfig.server.port !== oldPort) {
          restartFields.push("server.port");
        }
        if (Object.prototype.hasOwnProperty.call(newServer, "host") && newConfig.server.host !== oldHost) {
          restartFields.push("server.host");
        }
      }
      await persistConfig(newConfig as ProxyConfig, opts.configPath);

      // Apply hot-swappable fields to the in-memory config so they take
      // effect immediately. Restart-required fields (port/host) are NOT
      // applied — they only take effect after the user restarts the process.
      opts.config.provider = newConfig.provider;
      opts.config.plan = newConfig.plan;
      opts.config.defaultModel = newConfig.defaultModel;
      opts.config.models = newConfig.models;
      opts.config.identity = newConfig.identity;
      opts.config.logging = newConfig.logging;
      opts.config.retry = newConfig.retry;
      opts.config.routingRules = newConfig.routingRules;
      opts.config.modelMappings = newConfig.modelMappings;
      if (newConfig.responsesThinking) opts.config.responsesThinking = newConfig.responsesThinking;
      // v0.2.0.4: forceStreamAnthropic removed — stream:true is now unconditional.
      if (newConfig.thinkingLevel !== undefined) opts.config.thinkingLevel = newConfig.thinkingLevel === "high" ? "high" : "max";
      if (authBody) opts.config.auth = newConfig.auth;
      if (hasCorsAllowList) {
        if (Array.isArray((newConfig as any).corsAllowList)) {
          (opts.config as any).corsAllowList = [...(newConfig as any).corsAllowList];
        } else {
          delete (opts.config as any).corsAllowList;
        }
      }
      // providers.*.anthropicBase / openaiBase: also hot-swappable
      if (providersBody) {
        opts.config.providers = newConfig.providers;
      }
      // v0.2.1.7+: server hot-swappable fields (NOT port/host — those need
      // restart, tracked in restartFields above). upstreamTimeoutMs,
      // trustProxy, sseHeartbeatMs, and maxRequestBodyBytes all affect
      // per-request behavior and are safe to hot-swap.
      if (newServer) {
        if (newConfig.server.upstreamTimeoutMs !== undefined) opts.config.server.upstreamTimeoutMs = newConfig.server.upstreamTimeoutMs;
        if (newConfig.server.trustProxy !== undefined) opts.config.server.trustProxy = newConfig.server.trustProxy;
        if (newConfig.server.sseHeartbeatMs !== undefined) opts.config.server.sseHeartbeatMs = newConfig.server.sseHeartbeatMs;
        if (newConfig.server.maxRequestBodyBytes !== undefined) opts.config.server.maxRequestBodyBytes = newConfig.server.maxRequestBodyBytes;
      }

      // Keep AuthManager in sync with the hot-applied config. The config
      // object above is mutable, but AuthManager also caches mode/provider and
      // the parsed apikey credential internally. Without this, changing
      // auth.apiKey/provider/plan in the dashboard only takes effect after a
      // restart despite the API reporting "hotApplied: auth".
      opts.auth.updateConfig({
        mode: newConfig.auth.mode,
        provider: newConfig.provider,
        apiKey: newConfig.auth.apiKey ?? newConfig.providers[newConfig.provider]?.credential,
        plan: newConfig.plan,
      });
      if (newConfig.auth.mode === "oauth") {
        const activeCredential = await loadCredential();
        if (activeCredential) opts.auth.setOAuthCredential(activeCredential);
        else opts.auth.clearOAuthCredential();
      }

      appendLog("info", "Configuration updated via admin dashboard");
      return jsonResp({
        ok: true,
        requiresRestart: restartFields.length > 0,
        restartFields,
        // hotApplied: fields that were applied to the live config without restart
        hotApplied: ["provider", "plan", "defaultModel", "models", "identity", "logging", "retry", "routingRules", "modelMappings", "responsesThinking", "thinkingLevel", ...(authBody ? ["auth"] : []), ...(hasCorsAllowList ? ["corsAllowList"] : []), ...(providersBody ? ["providers"] : []), ...(newServer ? ["server"] : [])],
      });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get credentials (active credential summary)
  if (path === "/admin/api/credentials" && method === "GET") {
    // NOTE: do NOT call invalidateStoreCache() here. readStore() already
    // does a statSync-based mtime check (store.ts:441-447) that detects
    // external writes (e.g. start.bat adding a credential). Calling
    // invalidateStoreCache() forces a full disk read + AES-GCM decrypt on
    // EVERY dashboard refresh, AND it makes concurrent reads miss the cache
    // too — turning every refresh into a global cache-bust event. This was
    // a major contributor to the "管理面板刷新卡一会" symptom.
    const store = await exportStore();
    const activeAccount = store?.accounts.find((a) => a.id === store.activeId);
    const cred = activeAccount?.credential;
    if (!cred) return jsonResp({ credential: null });
    return jsonResp({
      credential: {
        id: activeAccount.id,
        label: activeAccount.label,
        provider: cred.provider,
        apiKeyMask: maskApiKey(cred.apiKey),
        hasSecret: !!cred.secret,
        userId: cred.userId,
        expiresAt: cred.expiresAt,
        mode: opts.config.auth.mode,
        plan: cred.plan || "coding-plan",
        name: cred.name,
        email: cred.email,
        proxy: cred.proxy,
        disabled: !!cred.disabled,
      },
    });
  }

  // Add API key
  if (path === "/admin/api/credentials" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ provider: string; apiKey: string; plan?: string; proxy?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // Field validation (vceshi0.0.5+): reject empty apiKey / unknown provider
      // before they get persisted as garbage that breaks later requests.
      if (!body.apiKey || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        return errorResponse(400, "missing_param", "apiKey is required and must be a non-empty string");
      }
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      if (body.plan !== undefined && body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const plan = (body.plan ?? "coding-plan") as "coding-plan" | "start-plan";
      const cred = {
        apiKey: body.apiKey.trim(),
        provider: body.provider,
        plan,
        // Per-account proxy (v2.1.4.1test5+). Trim; empty/whitespace → undefined
        // so the field is omitted from the serialized credential entirely.
        ...(body.proxy && body.proxy.trim() ? { proxy: body.proxy.trim() } : {}),
      } as AppCredential;
      // Manual add: NO keepActive — new key becomes active (matches user expectation
      // that clicking "Add Key" makes it the active credential immediately).
      await saveCredential(cred);
      invalidateStoreCache();
      // Hot-swap in-memory credential so oauth-mode requests pick up the new
      // active credential immediately without restart.
      const active = await loadCredential();
      if (active && active.apiKey === cred.apiKey) {
        opts.auth.setOAuthCredential(active);
      }
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Clear ALL credentials (the "Clear Credentials" button).
  //
  // vceshi0.0.7+: also clear the in-memory oauth credential so running
  // requests stop using the just-deleted credential. Previously the proxy
  // kept serving from the stale in-memory credential until restart —
  // defeating the purpose of the clear action and creating a confusing
  // "I cleared credentials but the proxy still works" experience.
  if (path === "/admin/api/credentials" && method === "DELETE") {
    // Use clearCredentialAsync (mutex-protected) instead of sync clearCredential
    // — the sync version can race with concurrent withStoreLock writers
    // (handler.ts auto-switch + dashboard add/edit running in parallel),
    // causing the deleted file to be "resurrected" by the in-flight write.
    await clearCredentialAsync();
    clearQuotaCache();
    opts.auth.clearOAuthCredential();
    appendLog("info", "All credentials cleared via admin dashboard");
    return jsonResp({ ok: true });
  }

  // List all stored accounts (multi-account support)
  //
  // NOTE: do NOT call invalidateStoreCache() here. readStore() already
  // does a statSync-based mtime check that detects external writes (e.g.
  // start.bat adding a credential while the proxy is running). The explicit
  // invalidate was a performance footgun — it forced a full disk read +
  // AES-GCM decrypt on every dashboard refresh, and made concurrent reads
  // miss the cache too. Removing it cuts ~5-20ms off every /admin refresh.
  if (path === "/admin/api/accounts" && method === "GET") {
    const result = await listAccounts();
    return jsonResp(result);
  }

  // Switch active account
  if (path === "/admin/api/accounts/active" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id) return errorResponse(400, "missing_param", "id is required");
      const ok = await switchAccount(body.id);
      // Handle null (store temporarily unreadable) vs false (not found) vs true
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      // Hot-swap the in-memory credential and sync plan
      const cred = await loadCredential();
      let planSynced = false;
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        // Sync config.plan to match the account's plan, and persist to yaml
        // so the change survives a server restart. Without this, users who
        // switch plan via the dashboard find the change silently reverted
        // after restart — leading to confusing "still coding-plan" reports.
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          planSynced = true;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Switched active account to ${body.id}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      if (planSynced) {
        try {
          await persistConfig(opts.config, opts.configPath);
          appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
        } catch (e) {
          appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
        }
      }
      return jsonResp({ ok: true, plan: cred?.plan || opts.config.plan });
    } catch (err) {
      return errorResponse(500, "switch_failed", (err as Error).message);
    }
  }

  // Update account label
  if (path === "/admin/api/accounts/label" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; label?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.label !== "string") {
        return errorResponse(400, "missing_param", "id and label are required");
      }
      const ok = await setAccountLabel(body.id, body.label);
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Update account plan
  if (path === "/admin/api/accounts/plan" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; plan?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || !body.plan) {
        return errorResponse(400, "missing_param", "id and plan are required");
      }
      if (body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const ok = await setAccountPlan(body.id, body.plan);
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      clearQuotaCacheForAccount(body.id);

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use the new
      // plan. Without this, the proxy would keep using the old plan until
      // restart — defeating the purpose of the dashboard edit.
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Account ${body.id} plan changed to ${body.plan}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      // Always write — even if plan matches config, the dashboard edit is
      // an explicit user action worth persisting (in case config.yaml had
      // been manually edited out of band).
      try {
        await persistConfig(opts.config, opts.configPath);
        appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
      } catch (e) {
        appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
      }
      return jsonResp({ ok: true, plan: body.plan });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Update account outbound proxy (v2.1.4.1test5+)
  // Accepts an empty/whitespace string to clear the override.
  if (path === "/admin/api/accounts/proxy" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; proxy?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required");
      }
      if (typeof body.proxy !== "string") {
        return errorResponse(400, "missing_param", "proxy is required (use empty string to clear)");
      }
      // M3 fix: validate via new URL() instead of a loose regex. The old
      // regex `/^(https?|socks5h?):\/\/[^\s]+$/i` allowed single quotes,
      // angle brackets and other characters that could escape the inline
      // onclick JS string in the dashboard, causing stored XSS. URL()
      // parsing rejects malformed URLs, and we additionally block any
      // host containing HTML/JS metacharacters as defense-in-depth.
      // Empty string clears the override.
      const trimmed = body.proxy.trim();
      if (trimmed) {
        let proxyUrl: URL;
        try {
          proxyUrl = new URL(trimmed);
        } catch {
          return errorResponse(
            400,
            "invalid_param",
            "proxy must be a valid URL with scheme http://, https://, socks4://, socks4a://, socks5://, or socks5h://",
          );
        }
        const allowedProtocols = ["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"];
        if (!allowedProtocols.includes(proxyUrl.protocol)) {
          return errorResponse(
            400,
            "invalid_param",
            "proxy must be a valid URL with scheme http://, https://, socks4://, socks4a://, socks5://, or socks5h://",
          );
        }
        // Reject hosts containing HTML/JS metacharacters — these can never
        // appear in a legitimate hostname and would escape any inline JS
        // string context in the dashboard.
        if (/[<>'"\s]/.test(proxyUrl.host)) {
          return errorResponse(
            400,
            "invalid_param",
            "proxy host contains invalid characters",
          );
        }
      }
      const success = await setAccountProxy(body.id, body.proxy);
      const errResp = handleMutationResult(success);
      if (errResp) return errResp;
      clearQuotaCacheForAccount(body.id);

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use (or stop
      // using) the new proxy. Without this, the proxy change would only
      // take effect after a server restart — defeating the purpose of the
      // dashboard edit.
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
      }
      appendLog(
        "info",
        `Account ${body.id} proxy ${trimmed ? `set to ${trimmed}` : "cleared"}`,
      );
      return jsonResp({ ok: true, proxy: trimmed });
    } catch (err) {
      // v0.2.0.8: setAccountProxy now throws on SSRF / scheme validation
      // failures. Distinguish those (400, client error) from genuine update
      // failures (500, server error) by sniffing the message — the validator
      // in store.ts produces messages starting with "Proxy URL" / "Invalid proxy".
      const msg = (err as Error).message ?? "";
      const isValidation = /^Proxy URL|Invalid proxy URL|points at an internal|scheme .* is not allowed|missing a hostname/i.test(msg);
      if (isValidation) {
        return errorResponse(400, "invalid_param", msg);
      }
      return errorResponse(500, "update_failed", msg);
    }
  }

  // Test proxy connectivity (v2.1.4.1test6+)
  // Does a HEAD request to the configured provider's base URL through the
  // supplied proxy URL. Any HTTP response (even 4xx/5xx) means the proxy is
  // reachable; only network-level failures (timeout, connection refused, DNS
  // failure through the proxy, auth rejection by the proxy) report ok=false.
  //
  // Body: { proxy: string, provider?: "zai"|"bigmodel" }
  // Returns: { ok: true, status, latencyMs, target } on success
  //          { ok: false, error, latencyMs, target } on failure (still HTTP 200
  //           so the dashboard can render the error message cleanly)
  if (path === "/admin/api/accounts/proxy-test" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ proxy?: string; provider?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.proxy !== "string") {
        return errorResponse(400, "missing_param", "proxy is required");
      }
      const trimmed = body.proxy.trim();
      if (!trimmed) {
        return errorResponse(400, "invalid_param", "proxy URL cannot be empty (use 'No proxy' on the dashboard instead)");
      }
      // Keep the "test proxy" path aligned with the actual account proxy
      // save path. Without this, the dashboard could initiate a connectivity
      // probe to a URL that /accounts/proxy would later reject (e.g. cloud
      // metadata / link-local addresses).
      const validation = validateProxyUrl(trimmed);
      if (!validation.ok) {
        return errorResponse(400, "invalid_param", validation.message);
      }

      // Test target: the relevant provider's base host. Hitting the bare host
      // (no path, no auth) is enough to verify the proxy can reach it — any
      // HTTP response means success. 10s timeout is generous for slow proxies
      // but short enough that a dead proxy doesn't hang the dashboard.
      const providerId = body.provider === "bigmodel" ? "bigmodel" : "zai";
      const providerCfg = opts.config.providers[providerId];
      // Use the anthropicBase URL (e.g. https://api.z.ai/api/anthropic) and
      // strip down to just the origin — we want a HEAD against the host root,
      // not a real API path (which would 404 anyway, but origin is cleaner).
      let target: string;
      try {
        const u = new URL(providerCfg.anthropicBase);
        target = `${u.protocol}//${u.host}`;
      } catch {
        target = providerId === "bigmodel"
          ? "https://open.bigmodel.cn"
          : "https://api.z.ai";
      }

      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      timer.unref?.();
      // Use injected fetchImpl if provided (for tests); fall back to global.
      // wrapFetchWithSocksBridge transparently routes SOCKS proxies through
      // a local HTTP-CONNECT→SOCKS bridge (Bun's native fetch would throw
      // UnsupportedProxyProtocol for socks4:// / socks5:// schemes).
      const fetchImpl = wrapFetchWithSocksBridge(opts.fetchImpl ?? fetch);
      try {
        // Bun native: fetch(url, { proxy, signal })
        const resp = await fetchImpl(target, {
          method: "HEAD",
          signal: ctrl.signal,
          // Allow redirects to be followed automatically so a 3xx-to-200
          // path is treated as success, not a redirect failure.
          redirect: "follow",
          // cast through any because { proxy } is Bun-specific
          ...(trimmed ? { proxy: trimmed } : {}),
        } as any);
        const latencyMs = Date.now() - started;
        try { await resp.body?.cancel(); } catch {}
        // Any HTTP response means the proxy is working — the upstream may
        // return 200, 404, 403, etc. depending on its root path handling.
        return jsonResp({
          ok: true,
          status: resp.status,
          latencyMs,
          target,
        });
      } catch (err) {
        const latencyMs = Date.now() - started;
        const errMsg = (err as Error).message || String(err);
        // Distinguish timeout from other errors for clearer UX
        const isTimeout = ctrl.signal.aborted || /abort/i.test(errMsg);
        return jsonResp({
          ok: false,
          error: isTimeout ? `Connection timed out after 10s` : truncateAdminErrorMessage(errMsg),
          latencyMs,
          target,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Query upstream quota / balance for an account (v2.1.4.2+)
  // Reverses the ZCode client's BigModelUsageQuotaProvider. start-plan queries
  // zcode.z.ai billing with the JWT; coding-plan queries the provider's monitor
  // quota/limit with the api key. Never throws — surface unavailableReason.
  //
  // vceshi0.0.7+: per-account rate limit (max 1 query / 15s). The upstream
  // billing endpoint is not free — repeated hammering from a refresh-happy
  // user can exhaust the JWT or trigger IP-based throttling. The cache is
  // per-account so querying account A doesn't block account B.
  if (path === "/admin/api/accounts/quota" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ id?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      const accountId = body.id;
      // Per-account rate limit: 1 query / 15s. Stale cached results are
      // returned with a `cached: true` flag so the dashboard can show "this
      // is a cached result, query again in Ns" instead of silently returning
      // old data.
      const now = Date.now();
      const QUOTA_CACHE_MS = 15_000;
      const store = await exportStore();
      const acct = store?.accounts.find((a) => a.id === accountId);
      if (!acct || !acct.credential) {
        clearQuotaCacheForAccount(accountId);
        return errorResponse(404, "not_found", "Account not found");
      }
      const cached = quotaCache.get(accountId);
      if (cached && now - cached.ts < QUOTA_CACHE_MS) {
        // Spread the cached result object and add cache metadata.
        // Cast through Record<string, unknown> because the cached result
        // is typed as `unknown` (we accept any QuotaResult shape).
        return jsonResp({ ...(cached.result as Record<string, unknown>), cached: true, cachedAt: cached.ts });
      }
      const cred = acct.credential;
      // Honour a per-account outbound proxy if configured, matching how real
      // LLM requests are routed (proxy-test handler uses the same wrap).
      // makeProxiedFetcher transparently routes SOCKS proxies through the
      // local HTTP-CONNECT→SOCKS bridge.
      const baseFetch = opts.fetchImpl ?? fetch;
      const accountFetch = makeProxiedFetcher(cred.proxy, baseFetch);
      const generation = quotaGenerationForAccount(accountId);
      let inFlight = quotaInFlight.get(accountId);
      if (!inFlight) {
        inFlight = queryQuota(cred, accountFetch, opts.config.identity?.appVersion)
          .finally(() => {
            if (quotaInFlight.get(accountId) === inFlight) quotaInFlight.delete(accountId);
          });
        quotaInFlight.set(accountId, inFlight);
      }
      const result = await inFlight;
      const freshTs = Date.now();
      // Cache the fresh result (even on failure — saves the upstream from
      // immediate re-hammering when the failure is durable like a 403). If the
      // account changed while this request was in flight, skip the write so an
      // old proxy/key/plan result cannot overwrite the invalidated cache.
      if (quotaGenerationForAccount(accountId) === generation) {
        quotaCache.set(accountId, { ts: freshTs, result });
        // Bound the cache size — 50 accounts is plenty, drop oldest by insertion.
        if (quotaCache.size > QUOTA_CACHE_LIMIT) {
          const firstKey = quotaCache.keys().next().value;
          if (firstKey !== undefined) quotaCache.delete(firstKey);
        }
      }
      return jsonResp({ ...(result as Record<string, unknown>), cached: false });
    } catch (err) {
      return errorResponse(500, "quota_failed", (err as Error).message);
    }
  }

  // Delete an account
  if (path.startsWith("/admin/api/accounts/") && method === "DELETE") {
    const id = path.slice("/admin/api/accounts/".length);
    if (!id) return errorResponse(400, "missing_param", "account id required");
    const ok = await removeAccount(id);
    const errResp = handleMutationResult(ok);
    if (errResp) return errResp;
    // v0.2.0.8: drop any cached quota result for this account so a future
    // account reusing the same id (unlikely but possible) doesn't see stale
    // data. Previously the cache entry leaked — bounded to 50 entries so it
    // self-corrected eventually, but explicit cleanup is cleaner.
    clearQuotaCacheForAccount(id);
    // Hot-swap the in-memory credential if active changed
    const cred = await loadCredential();
    if (cred) opts.auth.setOAuthCredential(cred);
    else opts.auth.clearOAuthCredential();
    appendLog("info", `Removed account ${id}`);
    return jsonResp({ ok: true });
  }

  // Import from ZCode
  // Reads BOTH config.json + credentials.json (encrypted) and merges them —
  // config.json gives the directly-usable apiKey, credentials.json supplements
  // email/userId + drives provider auto-detect. When the only coding-plan
  // credential is a raw access_token JWT (no plaintext apiKey in config.json),
  // resolve it via the biz API first. See zcode-config.ts.
  if (path === "/admin/api/import" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ provider: string; plan?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const provider = body.provider as "zai" | "bigmodel";
      if (body.plan !== undefined && body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      // The dashboard's plan dropdown is the user's explicit choice — pass it
      // as forcedPlan so readZCodeImport imports exactly what they picked.
      const forcedPlan = body.plan as "coding-plan" | "start-plan" | undefined;
      const source = readZCodeImport(provider, forcedPlan);

      // Build the Credential. A raw access_token JWT needs the biz-API exchange
      // to become a usable apiKey.secret; a config.json plaintext apiKey is
      // already usable.
      let cred: AppCredential;
      if (source.isRawAccessToken) {
        const resolver = new KeyResolver(opts.fetchImpl ?? fetch);
        cred = await resolver.resolveCredential(source.apiKey, source.provider, source.userId, source.plan, source.jwt, source.email);
      } else {
        cred = {
          apiKey: source.apiKey,
          provider: source.provider,
          plan: source.plan,
          jwt: source.jwt,
          userId: source.userId,
          email: source.email,
        };
      }
      // Auto-generate name: prefer `{email}-{plan}` (like OAuth imports) when
      // we have an email from credentials.json; otherwise fall back to the
      // `zcode(N)-{plan}` numbering convention.
      if (source.email) {
        cred.name = `${source.email}-${source.plan}`;
      } else {
        try {
          const list = await listAccounts();
          const zcodeCount = list.accounts.filter(a => (a.name || "").startsWith("zcode(")).length;
          cred.name = `zcode(${zcodeCount + 1})-${source.plan}`;
        } catch { /* non-fatal */ }
      }
      // Import should NOT auto-activate the new credential — preserve the
      // user's currently-active account. The user can manually click
      // "Activate" on the new account if they want to switch to it.
      // This matches the user's explicit requirement: "通过zcode导入的凭证
      // 会直接开启它，应该不默认开启，而是保留原来凭证开启，就是不要立马切换
      // 新导入凭证".
      await saveCredential(cred, { keepActive: true });
      invalidateStoreCache();
      // NO hot-swap — the in-memory active credential stays as-is. The new
      // account is added to the store but doesn't become active until the
      // user explicitly activates it via the dashboard.
      return jsonResp({
        ok: true,
        apiKeyMask: maskApiKey(cred.apiKey),
        plan: cred.plan,
        email: cred.email,
        name: cred.name,
        activated: false, // signal to dashboard: not auto-activated
      });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // Detect available ZCode imports — drives the dashboard's import dropdown
  // pre-fill (activeProvider) + option disabling (availability). Reads both
  // config.json + credentials.json.
  if (path === "/admin/api/import/detect" && method === "GET") {
    try {
      const activeProvider = detectZCodeProvider();
      const available = listAvailableZCodeImports();
      return jsonResp({ activeProvider, available });
    } catch (err) {
      return errorResponse(500, "detect_failed", (err as Error).message);
    }
  }

  // Export all accounts (backup)
  if (path === "/admin/api/accounts/export" && method === "GET") {
    try {
      const accounts = await exportAccounts();
      return jsonResp({ accounts, exportedAt: Date.now(), version: 2 });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Export credentials as a base64 blob suitable for the ZCODE_OAUTH_CREDENTIAL
  // env var on Render / Fly.io / K8s.
  //
  // This is the dashboard equivalent of `zcode-proxy auth export` on the CLI.
  // Use case: you logged in via the dashboard (or imported from ZCode), and
  // now want to deploy to Render without re-doing the OAuth flow there.
  //
  // Two output formats, auto-selected by account count:
  //
  //   • Single account  → base64(JSON.stringify(credential))
  //     Backward-compatible with the original render-start.sh, which wraps the
  //     decoded blob as a single-account v2 store on the remote host.
  //
  //   • Multiple accounts → base64(JSON.stringify({version:2, activeId, accounts}))
  //     The full v2 store envelope, so all accounts (and the activeId pointer)
  //     survive the trip to Render. render-start.sh detects this format (top-
  //     level `version: 2` + `accounts` array) and writes it directly to
  //     credentials.json instead of wrapping.
  //
  // Returns:
  //   { credential: <base64>, json: <pretty JSON>, envVars: {...},
  //     multi: boolean, accountCount: number, instructions: <string> }
  // The `credential` field is what you paste into Render's ZCODE_OAUTH_CREDENTIAL.
  // The `json` field is the decoded payload for human inspection.
  // ---------------------------------------------------------------------
  // vceshi0.0.4+: Edit account name/email + export single account JSON
  // ---------------------------------------------------------------------

  // Edit account name/email (vceshi0.0.4+).
  // Body: { id, name?, email? } — only provided fields are updated; omitted
  // fields preserve their current value. Empty string clears the field.
  if (path === "/admin/api/accounts/edit" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; name?: string; email?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      // Type-check name/email (vceshi0.0.5+): non-string values (numbers, null,
      // objects) would crash setAccountName's .trim() call. Reject early.
      if (body.name !== undefined && typeof body.name !== "string") {
        return errorResponse(400, "invalid_param", "name must be a string");
      }
      if (body.email !== undefined && typeof body.email !== "string") {
        return errorResponse(400, "invalid_param", "email must be a string");
      }
      // At least one of name/email must be provided (otherwise the call is a no-op).
      if (body.name === undefined && body.email === undefined) {
        return errorResponse(400, "missing_param", "At least one of name or email must be provided");
      }

      // Update name if provided (including empty string to clear)
      if (body.name !== undefined) {
        const ok = await setAccountName(body.id, body.name);
        const errResp = handleMutationResult(ok);
        if (errResp) return errResp;
      }
      // Update email if provided (including empty string to clear)
      if (body.email !== undefined) {
        const ok = await setAccountEmail(body.id, body.email);
        const errResp = handleMutationResult(ok);
        if (errResp) return errResp;
      }

      // If the active account was edited, hot-swap the in-memory credential so
      // the new name/email take effect immediately for any running requests
      // (email is read by some upstreams via metadata.user_id — though name
      // is purely for display, hot-swapping is cheap and keeps things consistent).
      invalidateStoreCache();
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);

      appendLog("info", `Account ${body.id} edited (name=${body.name !== undefined ? "updated" : "kept"}, email=${body.email !== undefined ? "updated" : "kept"})`);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "edit_failed", (err as Error).message);
    }
  }

  // Export single account as JSON (vceshi0.0.4+).
  // Query param: ?id=<accountId>
  // Returns the full account record including plaintext credential — caller
  // should treat the response as sensitive (recommend downloading as a file
  // rather than logging).
  if (path === "/admin/api/accounts/export-single" && method === "GET") {
    try {
      const id = url.searchParams.get("id");
      if (!id) {
        return errorResponse(400, "missing_param", "id query param is required");
      }
      // NOTE: do NOT call invalidateStoreCache() here — readStore() already
      // detects external writes via mtime check. Removing this cuts latency
      // on this endpoint and avoids causing concurrent reads to miss cache.
      const account = await exportSingleAccount(id);
      if (!account) {
        return errorResponse(404, "not_found", "Account not found");
      }
      return jsonResp({ ok: true, account });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Toggle account disabled state (vceshi0.0.6+).
  // Body: { id, disabled: boolean }
  // When disabled, the credential is excluded from auto-switch + manual activation.
  if (path === "/admin/api/accounts/disabled" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; disabled?: boolean }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      if (typeof body.disabled !== "boolean") {
        return errorResponse(400, "invalid_param", "disabled must be a boolean");
      }
      const ok = await setAccountDisabled(body.id, body.disabled);
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      invalidateStoreCache();
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);
      else opts.auth.clearOAuthCredential();
      appendLog("info", `Account ${body.id} ${body.disabled ? "disabled" : "enabled"}`);
      return jsonResp({ ok: true, disabled: body.disabled });
    } catch (err) {
      return errorResponse(500, "toggle_failed", (err as Error).message);
    }
  }

  if (path === "/admin/api/accounts/render-export" && method === "GET") {
    try {
      const store = await exportStore();
      if (!store || store.accounts.length === 0) {
        return errorResponse(404, "not_logged_in", "No stored credential. Login or import first.");
      }

      // Single-account path: emit the bare credential (backward compat with
      // existing render-start.sh consumers).
      if (store.accounts.length === 1) {
        const cred = store.accounts[0].credential;
        const json = JSON.stringify(cred);
        const b64 = Buffer.from(json, "utf8").toString("base64");
        return jsonResp({
          credential: b64,
          json: JSON.stringify(cred, null, 2),
          envVars: {
            ZCODE_AUTH_MODE: "oauth",
            ZCODE_OAUTH_CREDENTIAL: b64,
          },
          multi: false,
          accountCount: 1,
          instructions: [
            "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
            "2. On Render, go to your service → Environment → add/edit:",
            "   - ZCODE_AUTH_MODE = oauth",
            "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
            "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
            "4. Save and let Render redeploy.",
            "",
            "WARNING: This blob contains your upstream credential in plaintext.",
            "Treat it like a password. On Render, mark the env var as Secret.",
          ].join("\n"),
        });
      }

      // Multi-account path: emit the full v2 store envelope so all accounts
      // are preserved on the remote host.
      const storeJson = JSON.stringify(store);
      const b64 = Buffer.from(storeJson, "utf8").toString("base64");
      return jsonResp({
        credential: b64,
        json: JSON.stringify(store, null, 2),
        envVars: {
          ZCODE_AUTH_MODE: "oauth",
          ZCODE_OAUTH_CREDENTIAL: b64,
        },
        multi: true,
        accountCount: store.accounts.length,
        instructions: [
          `Detected ${store.accounts.length} stored accounts — exporting the full credential store (v2 envelope).`,
          "All accounts and the active-account pointer are preserved in the base64 blob.",
          "",
          "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
          "2. On Render, go to your service → Environment → add/edit:",
          "   - ZCODE_AUTH_MODE = oauth",
          "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
          "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
          "4. Save and let Render redeploy.",
          "",
          "WARNING: This blob contains ALL your upstream credentials in plaintext.",
          "Treat it like a password. On Render, mark the env var as Secret.",
        ].join("\n"),
      });
    } catch (err) {
      return errorResponse(500, "render_export_failed", (err as Error).message);
    }
  }

  // Import accounts from backup
  if (path === "/admin/api/accounts/import" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ accounts?: unknown[] }>(req, { maxBytes: MAX_ACCOUNT_IMPORT_BODY_BYTES });
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.accounts)) {
        return errorResponse(400, "invalid_param", "accounts array is required");
      }
      // Basic validation: each account must have id, label, createdAt, credential
      const validated = body.accounts.filter((a: any) =>
        a && typeof a.id === "string" && typeof a.label === "string" &&
        typeof a.createdAt === "number" && a.credential && typeof a.credential.apiKey === "string"
      );
      if (validated.length === 0) {
        return errorResponse(400, "invalid_param", "No valid accounts found in import data");
      }
      const result = await importAccounts(validated as any);
      clearQuotaCache();
      appendLog("info", `Imported accounts: ${result.added} added, ${result.updated} updated`);
      // Hot-swap active credential (only if it changed). After import we
      // must invalidate cache so loadCredential() reads the freshly-imported
      // store from disk (importAccounts already wrote it, but our cache is
      // stale).
      invalidateStoreCache();
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);
      else opts.auth.clearOAuthCredential();
      return jsonResp({ ok: true, added: result.added, updated: result.updated });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // OAuth init
  if (path === "/admin/api/oauth/init" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ provider?: string; plan?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // vceshi0.0.7+: validate provider explicitly. The old code did an
      // unchecked `as "zai" | "bigmodel"` cast, which meant an unknown
      // provider would slip through and crash deep inside the OAuth client
      // (e.g. BigmodelOAuthClient constructor) with a confusing message
      // like "Cannot read property of undefined". Surface a clear 400 instead.
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const provider = body.provider;
      if (body.plan !== undefined && body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const oauthPlan = (body.plan ?? "coding-plan") as "coding-plan" | "start-plan";

      if (provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        const { authorizeUrl, callbackUrl, state } = await oauth.start();
        // Store flow info for polling
        const flowId = `bm_${state.slice(0, 16)}`;
        rememberActiveOAuthFlow(flowId, {
          provider,
          flowId,
          pollToken: state,
          expiresAt: Date.now() + 300_000,
          // Store the localhost callback URL & state for manual callback exchange path
          callbackUrl,
          state,
          plan: oauthPlan,
          close: () => oauth.close(),
        });
        // Start background process to wait for callback.
        //
        // Wrapped in try/finally so oauth.close() ALWAYS runs — even if
        // saveCredential throws (e.g. disk full). The old code only called
        // close() on success or in the catch block, so a saveCredential
        // failure left the localhost OAuth callback server listening until
        // the 5-minute flow cleanup interval fired (10 min after expiry).
        (async () => {
          try {
            const authCode = await oauth.waitForCallback(300_000);
            const { accessToken, userId, jwt, email } = await oauth.exchangeCode(authCode, callbackUrl, state);
            const resolver = new KeyResolver();
            const cred = await resolver.resolveCredential(accessToken, provider, userId, oauthPlan, jwt, email);
            // Auto-generate name from email + plan (vceshi0.0.4+).
            // Falls back to no name (label will be auto-generated by store) if
            // email is missing — e.g. older OAuth responses without email field.
            if (email) {
              cred.name = `${email}-${oauthPlan}`;
            }
            // keepActive:true — do NOT silently swap the user's currently-active
            // credential out from under them. The new account appears in the
            // dashboard list; the user explicitly clicks "Activate" to switch.
            // (Only swap if there's no active credential yet — i.e. first-ever login.)
            await saveCredential(cred, { keepActive: true });
            // Hot-swap the in-memory credential ONLY IF there was no active
            // credential before this OAuth flow completed. Otherwise preserve
            // the current selection — the user can activate the new account
            // explicitly from the dashboard.
            const existingActive = await loadCredential();
            // If existingActive is the just-saved cred (i.e. there was no prior
            // active), hot-swap. Otherwise leave the in-memory credential alone.
            if (existingActive && existingActive.apiKey === cred.apiKey) {
              opts.auth.setOAuthCredential(existingActive);
            }
            // Probe start-plan activation in the background (fire-and-forget).
            // See probeStartPlanActivation — non-blocking, never fails the login.
            probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);
            // Mark flow as ready
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "ready"; }
          } catch (err) {
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
            appendLog("debug", `bigmodel OAuth flow ${flowId} failed: ${(err as Error).message}`);
          } finally {
            // ALWAYS close the localhost callback server, regardless of
            // outcome. Without this, abandoned flows leak a listening socket
            // for ~10 min until the cleanup interval fires.
            try { await oauth.close(); } catch (e) { appendLog("debug", `oauth.close() cleanup failed: ${(e as Error).message}`); }
          }
        })();
        return jsonResp({ flowId, authorizeUrl });
      }

      // Z.AI OAuth — same auth-code/callback shape as bigmodel above.
      // start() spins up the localhost callback server and returns the
      // authorize URL (flowId == state doubles as the CSRF token + flow key).
      const oauth = new ZaiOAuthClient();
      const init = await oauth.start();
      rememberActiveOAuthFlow(init.flowId, {
        provider,
        flowId: init.flowId,
        pollToken: init.pollToken,
        expiresAt: init.expiresAt,
        callbackUrl: init.callbackUrl,
        state: init.state,
        plan: oauthPlan,
        close: () => oauth.close(),
      });
      // Background process: wait for the localhost callback, then exchange.
      // Wrapped in try/finally so oauth.close() ALWAYS runs — see bigmodel path.
      (async () => {
        try {
          const authCode = await oauth.waitForCallback(normalizeCallbackWaitTimeoutMs(init.expiresAt - Date.now()));
          const { accessToken, userId, jwt, email } = await oauth.exchangeCode(authCode, init.callbackUrl, init.state);
          const resolver = new KeyResolver();
          const cred = await resolver.resolveCredential(accessToken, provider, userId, oauthPlan, jwt, email);
          // Auto-generate name from email + plan (vceshi0.0.4+).
          if (email) {
            cred.name = `${email}-${oauthPlan}`;
          }
          // keepActive:true — see bigmodel path comment above.
          await saveCredential(cred, { keepActive: true });
          const existingActive = await loadCredential();
          if (existingActive && existingActive.apiKey === cred.apiKey) {
            opts.auth.setOAuthCredential(existingActive);
          }
          // Probe start-plan activation in the background (fire-and-forget).
          probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "ready"; }
        } catch (err) {
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
          appendLog("debug", `zai OAuth flow ${init.flowId} failed: ${(err as Error).message}`);
        } finally {
          try { await oauth.close(); } catch (e) { appendLog("debug", `oauth.close() cleanup failed: ${(e as Error).message}`); }
        }
      })();
      return jsonResp({ flowId: init.flowId, authorizeUrl: init.authorizeUrl, expiresAt: init.expiresAt });
    } catch (err) {
      return errorResponse(500, "oauth_init_failed", (err as Error).message);
    }
  }

  // OAuth poll
  if (path === "/admin/api/oauth/poll" && method === "GET") {
    const flowId = url.searchParams.get("flowId");
    if (!flowId) return errorResponse(400, "missing_param", "flowId required");
    const flow = activeFlows.get(flowId);
    if (!flow) return errorResponse(404, "not_found", "Unknown flow");
    // Check expiry (vceshi0.0.5+): expired flows return "expired" status so the
    // dashboard can show a clear "授权已过期" message instead of spinning forever.
    if (Date.now() > flow.expiresAt) {
      deleteActiveOAuthFlow(flowId);
      return jsonResp({ status: "expired" });
    }
    const status = (flow as any).status || "pending";
    const resp: any = { status };
    // Surface the error message on failure (vceshi0.0.5+) — previously the
    // dashboard couldn't tell the user WHY the flow failed.
    if (status === "failed" && (flow as any).error) {
      resp.error = (flow as any).error;
    }
    if (status === "ready" || status === "failed") deleteActiveOAuthFlow(flowId);
    return jsonResp(resp);
  }

  // OAuth manual callback URL submission
  // User pastes the redirected browser URL (containing ?code=...&state=...) after authorizing
  if (path === "/admin/api/oauth/callback" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ flowId?: string; callbackUrl?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      const flowId = body.flowId;
      const callbackUrl = body.callbackUrl ?? "";

      if (!flowId || !callbackUrl) {
        return errorResponse(400, "missing_param", "flowId and callbackUrl are required");
      }

      const flow = activeFlows.get(flowId);
      if (!flow) {
        return errorResponse(404, "flow_not_found", "Unknown or expired OAuth flow. Please restart the login.");
      }
      if (Date.now() > flow.expiresAt) {
        deleteActiveOAuthFlow(flowId);
        return errorResponse(410, "flow_expired", "OAuth flow has expired. Please restart the login.");
      }

      // Parse the callback URL to extract code & state (used as authorization confirmation)
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(callbackUrl);
      } catch {
        return errorResponse(400, "invalid_url", "Callback URL is not a valid URL.");
      }

      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      if (!code || !state) {
        return errorResponse(400, "invalid_callback", "Callback URL missing 'code' or 'state' parameter.");
      }

      // Z.AI manual callback: same shape as the bigmodel path below. The
      // user pasted the redirected browser URL (containing ?code=&state=);
      // we exchange it via the zcode.z.ai proxy using the localhost
      // callback URL + state recorded on the flow at start() time.
      if (flow.provider === "zai") {
        const oauth = new ZaiOAuthClient();
        const storedCallbackUrl = (flow as any).callbackUrl;
        if (!storedCallbackUrl) {
          return errorResponse(500, "missing_callback", "Original localhost callback URL not found. Please restart the login.");
        }
        // state from the pasted URL must match the state recorded on the flow
        if (state !== flow.state) {
          return errorResponse(400, "state_mismatch", "Callback state does not match the OAuth flow. Please restart the login.");
        }
        const { accessToken, userId, jwt, email } = await oauth.exchangeCode(code, storedCallbackUrl, state);
        const resolver = new KeyResolver();
        const flowPlan = ((flow as any).plan ?? "coding-plan") as "coding-plan" | "start-plan";
        const cred = await resolver.resolveCredential(accessToken, "zai", userId, flowPlan, jwt, email);
        // Auto-generate name from email + plan (vceshi0.0.4+).
        if (email) {
          cred.name = `${email}-${flowPlan}`;
        }
        // keepActive:true — manual callback path matches auto-poll path behavior.
        await saveCredential(cred, { keepActive: true });
        const existingActive = await loadCredential();
        if (existingActive && existingActive.apiKey === cred.apiKey) {
          opts.auth.setOAuthCredential(existingActive);
        }
        // Probe start-plan activation in the background (fire-and-forget).
        probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);

        deleteActiveOAuthFlow(flowId);
        return jsonResp({
          ok: true,
          provider: "zai",
          apiKeyMask: maskApiKey(cred.apiKey),
          userId: cred.userId,
        });
      }

      // For bigmodel: the callback URL points to localhost (which the user can't reach
      // from a remote browser), so we still need to manually exchange the code via
      // zcode.z.ai proxy. Extract the code and call exchangeCode with the original
      // callback URL stored on the flow.
      if (flow.provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        // The original callbackUrl stored on the flow is the localhost URL we
        // registered at start() time — we need it for the token exchange.
        const storedCallbackUrl = (flow as any).callbackUrl;
        if (!storedCallbackUrl) {
          return errorResponse(500, "missing_callback", "Original localhost callback URL not found. Please restart the login.");
        }
        // State validation (vceshi0.0.5+): defense-in-depth CSRF check, matching
        // the zai path above. Previously bigmodel manual callback skipped this.
        if (state !== flow.state) {
          return errorResponse(400, "state_mismatch", "Callback state does not match the OAuth flow. Please restart the login.");
        }
        const { accessToken, userId, jwt, email } = await oauth.exchangeCode(code, storedCallbackUrl, state);
        const resolver = new KeyResolver();
        const flowPlan = ((flow as any).plan ?? "coding-plan") as "coding-plan" | "start-plan";
        const cred = await resolver.resolveCredential(accessToken, "bigmodel", userId, flowPlan, jwt, email);
        // Auto-generate name from email + plan (vceshi0.0.4+).
        if (email) {
          cred.name = `${email}-${flowPlan}`;
        }
        // keepActive:true — matches zai manual path + auto-poll path behavior.
        await saveCredential(cred, { keepActive: true });
        const existingActive = await loadCredential();
        if (existingActive && existingActive.apiKey === cred.apiKey) {
          opts.auth.setOAuthCredential(existingActive);
        }
        // Probe start-plan activation in the background (fire-and-forget).
        probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);

        deleteActiveOAuthFlow(flowId);
        return jsonResp({
          ok: true,
          provider: "bigmodel",
          apiKeyMask: maskApiKey(cred.apiKey),
          userId: cred.userId,
        });
      }

      return errorResponse(400, "unsupported_provider", `Provider ${flow.provider} does not support callback URL exchange.`);
    } catch (err) {
      return errorResponse(500, "oauth_callback_failed", (err as Error).message);
    }
  }

  // Update endpoints (zai/bigmodel anthropicBase + openaiBase).
  //
  // vceshi0.0.7+: validate URLs before applying. The config PUT path goes
  // through validateConfigForSave() which rejects malformed URLs, but this
  // endpoint bypassed that check — meaning a typo like "api.z.ai" (missing
  // https://) would be silently accepted, then 404 every subsequent request
  // until the user noticed. Now we mirror validateConfigForSave's check.
  if (path === "/admin/api/endpoints" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ zai?: Record<string, unknown>; bigmodel?: Record<string, unknown> }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // Validate first; only apply if all fields pass.
      const allowedFields = ["anthropicBase", "openaiBase"] as const;
      for (const provKey of ["zai", "bigmodel"] as const) {
        const prov = body[provKey];
        if (!prov || typeof prov !== "object") continue;
        for (const field of allowedFields) {
          const v = prov[field];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.length === 0) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${field} must be a non-empty string`);
          }
          try {
            const u = new URL(v);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              return errorResponse(400, "invalid_param", `providers.${provKey}.${field} must be http(s):// URL (got ${u.protocol})`);
            }
          } catch (err) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${field} is not a valid URL: ${(err as Error).message}`);
          }
        }
        // Reject unknown fields to prevent accidental injection of unrelated keys.
        for (const k of Object.keys(prov)) {
          if (!allowedFields.includes(k as any)) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${k} is not allowed on this endpoint (only anthropicBase and openaiBase)`);
          }
        }
      }
      // Apply validated changes
      if (body.zai) Object.assign(opts.config.providers.zai, body.zai);
      if (body.bigmodel) Object.assign(opts.config.providers.bigmodel, body.bigmodel);
      // Persist to disk so changes survive restart (vceshi0.0.5+ fix — previously
      // the in-memory update was hot but lost on restart, silently reverting).
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", "Proxy endpoints updated via admin dashboard");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get routing rules
  if (path === "/admin/api/routing-rules" && method === "GET") {
    return jsonResp({ rules: opts.config.routingRules ?? [] });
  }

  // Update routing rules (full replace)
  if (path === "/admin/api/routing-rules" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ rules?: Array<{ pattern?: string; provider?: string; endpoint?: string; note?: string }> }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.rules)) {
        return errorResponse(400, "invalid_request", "rules must be an array");
      }
      // Validate & normalize
      const cleaned: RoutingRule[] = [];
      for (const r of body.rules) {
        if (typeof r.pattern !== "string" || r.pattern.trim() === "") {
          return errorResponse(400, "invalid_rule", "Each rule needs a non-empty 'pattern'");
        }
        if (r.provider !== "zai" && r.provider !== "bigmodel") {
          return errorResponse(400, "invalid_rule", `Rule '${r.pattern}' has invalid provider (must be 'zai' or 'bigmodel')`);
        }
        cleaned.push({
          pattern: r.pattern.trim(),
          provider: r.provider,
          endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : undefined,
          note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
        });
      }
      opts.config.routingRules = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Routing rules updated (${cleaned.length} rule(s))`);
      return jsonResp({ ok: true, rules: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get model mappings
  if (path === "/admin/api/model-mappings" && method === "GET") {
    return jsonResp({ mappings: opts.config.modelMappings ?? [] });
  }

  // Update model mappings (full replace)
  if (path === "/admin/api/model-mappings" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ mappings?: Array<{ from?: string; to?: string; note?: string }> }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.mappings)) {
        return errorResponse(400, "invalid_request", "mappings must be an array");
      }
      const cleaned: ModelMapping[] = [];
      const seenFrom = new Set<string>();
      for (const m of body.mappings) {
        if (typeof m.from !== "string" || m.from.trim() === "") {
          return errorResponse(400, "invalid_mapping", "Each mapping needs a non-empty 'from'");
        }
        if (typeof m.to !== "string" || m.to.trim() === "") {
          return errorResponse(400, "invalid_mapping", `Mapping '${m.from}' has empty 'to'`);
        }
        const fromLower = m.from.trim().toLowerCase();
        if (seenFrom.has(fromLower)) {
          return errorResponse(400, "invalid_mapping", `Duplicate 'from' value: '${m.from}' (case-insensitive)`);
        }
        seenFrom.add(fromLower);
        cleaned.push({
          from: fromLower,
          to: m.to.trim(),
          note: typeof m.note === "string" && m.note.trim() ? m.note.trim() : undefined,
        });
      }
      opts.config.modelMappings = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Model mappings updated (${cleaned.length} mapping(s))`);
      return jsonResp({ ok: true, mappings: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get GLM model catalog (full pinned list from provider/models.ts).
  // Used by the dashboard for "pull current model list for quick selection"
  // dropdowns in model mappings and responses-thinking config.
  if (path === "/admin/api/glm-models" && method === "GET") {
    return jsonResp({
      models: GLM_CATALOG.map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        reasoning: !!m.reasoning,
      })),
    });
  }

  // Get responses-thinking config
  if (path === "/admin/api/responses-thinking" && method === "GET") {
    return jsonResp({ models: opts.config.responsesThinking?.models ?? [] });
  }

  // Update responses-thinking config (full replace)
  if (path === "/admin/api/responses-thinking" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ models?: unknown }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.models)) {
        return errorResponse(400, "invalid_request", "models must be an array of strings");
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const item of body.models) {
        if (typeof item !== "string") {
          return errorResponse(400, "invalid_model", `Each model must be a string (got ${typeof item})`);
        }
        const id = item.trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(id);
      }
      const cfg: ResponsesThinkingConfig = { models: cleaned };
      opts.config.responsesThinking = cfg;
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Responses thinking override updated (${cleaned.length} model(s))`);
      return jsonResp({ ok: true, models: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Chrome captcha helper state/control. Warmup starts the hidden persistent
  // CDP renderer without solving a token; stop releases the browser/profile.
  if (path === "/admin/api/captcha-helper" && method === "GET") {
    return jsonResp(getChromeCaptchaHelperStatus());
  }

  if (path === "/admin/api/captcha-helper/warmup" && method === "POST") {
    try {
      const status = await warmupChromeCaptchaHelper();
      appendLog("info", status.running
        ? "Captcha helper warmed up (Chrome CDP persistent session active)"
        : "Captcha helper warmup skipped (persistent Chrome disabled or ephemeral profile)");
      return jsonResp(status);
    } catch (err) {
      appendLog("warn", `Captcha helper warmup failed: ${(err as Error).message}`);
      return errorResponse(500, "captcha_helper_failed", (err as Error).message);
    }
  }

  if (path === "/admin/api/captcha-helper/stop" && method === "POST") {
    const status = await shutdownChromeCaptchaHelper("admin stop");
    appendLog("info", "Captcha helper stopped by admin");
    return jsonResp(status);
  }

  // Get stats
  if (path === "/admin/api/stats" && method === "GET") {
    return jsonResp({
      ...stats,
      uptime: Date.now() - opts.startTime,
    });
  }

  // Reset stats
  if (path === "/admin/api/stats" && method === "DELETE") {
    resetStats();
    appendLog("info", "Stats reset by admin");
    return jsonResp({ ok: true });
  }

  // Log stream (SSE)
  // Uses monotonic seq numbers instead of array indices so that clients
  // never miss logs even when the underlying buffer is trimmed. The client
  // cursor (lastSentSeq) is a seq value, not an array index — it stays
  // valid across splice() calls because we look up entries by seq.
  //
  // vceshi0.0.7+ HOTFIX: this handler was rewritten to fix an infinite loop
  // bug. The previous version registered a waiter whose resolve() re-pushed
  // itself into logWaiters synchronously — appendLog's `while (length > 0)
  // { shift().resolve() }` then looped forever, blocking the event loop.
  // The new model: each SSE connection owns ONE long-lived waiter (registered
  // once at start(), removed on cancel()). appendLog just iterates the array
  // and calls resolve(entry) — no shift, no re-push. The waiter's resolve()
  // sends the specific entry directly to the SSE stream (no flushNew re-scan
  // needed), keeping push-based delivery with low latency.
  //
  // The 2s polling interval is kept as a safety net for the rare race where
  // appendLog fires between the initial buffer-scan and the logWaiters.push()
  // (which would otherwise be missed because the waiter isn't registered yet).
  if (path === "/admin/api/logs/stream" && method === "GET") {
    if (logWaiters.length >= MAX_LOG_STREAM_SUBSCRIBERS) {
      return errorResponse(
        503,
        "too_many_log_streams",
        `Too many concurrent log stream connections (max ${MAX_LOG_STREAM_SUBSCRIBERS}). Close other dashboard tabs and retry.`,
      );
    }
    let lastSentSeq = logSeq;
    let cleanup: (() => void) | null = null;
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const backpressureLimit = logStreamBackpressureChunksForTesting ?? DEFAULT_LOG_STREAM_BACKPRESSURE_CHUNKS;
        let streamWaiter: LogWaiter | null = null;
        const closeLogStream = (): void => {
          closed = true;
          cleanup?.();
          if (streamWaiter) {
            const idx = logWaiters.indexOf(streamWaiter);
            if (idx >= 0) logWaiters.splice(idx, 1);
          }
          try { controller.close(); } catch { /* already closed */ }
        };
        const sendPayload = (payload: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(payload));
            const desiredSize = controller.desiredSize;
            if (typeof desiredSize === "number" && desiredSize <= -backpressureLimit) {
              closeLogStream();
              return false;
            }
            return true;
          } catch {
            // The client is already gone. Clean up immediately instead of
            // keeping a dead waiter until the next heartbeat/maxTimeout.
            closeLogStream();
            return false;
          }
        };
        const sendBatch = (entries: readonly LogEntry[], respectCursor = true): boolean => {
          if (closed || entries.length === 0) return !closed;
          let payload = "";
          let nextSeq = lastSentSeq;
          for (const entry of entries) {
            if (respectCursor && entry.seq <= nextSeq) continue;
            payload += `data: ${JSON.stringify(entry)}\n\n`;
            if (entry.seq > nextSeq) nextSeq = entry.seq;
          }
          if (!payload) return true;
          if (!sendPayload(payload)) return false;
          lastSentSeq = nextSeq;
          return true;
        };
        const sendSerializedBatch = (entries: readonly SerializedLogEntry[]): boolean => {
          if (closed || entries.length === 0) return !closed;
          let payload = "";
          let nextSeq = lastSentSeq;
          for (const item of entries) {
            const entry = item.entry;
            if (entry.seq <= nextSeq) continue;
            payload += item.sse;
            if (entry.seq > nextSeq) nextSeq = entry.seq;
          }
          if (!payload) return true;
          if (!sendPayload(payload)) return false;
          lastSentSeq = nextSeq;
          return true;
        };
        const sendSerialized = (entry: SerializedLogEntry): boolean => sendSerializedBatch([entry]);

        // Flush any new entries with seq > lastSentSeq, then advance cursor.
        // Used by the safety-net polling interval only — push delivery goes
        // through waiter.resolve(entry) directly, no full buffer scan needed.
        const flushNew = () => {
          const pending: LogEntry[] = [];
          for (const e of iterRingBuffer()) {
            if (e.seq > lastSentSeq) {
              pending.push(e);
            }
          }
          if (pending.length > 0 && !sendBatch(pending)) return;
          if (!closed) lastSentSeq = logSeq;
        };

        // Send existing buffered logs first — but ONLY the most recent
        // INITIAL_REPLAY_LIMIT entries, not the entire ring buffer.
        //
        // === CRITICAL FIX (运行久了刷新卡顿) ===
        // Previously this loop sent ALL entries in the ring buffer (up to
        // LOG_BUFFER_SIZE = 2000). When the server had been running long
        // enough to fill the buffer, every dashboard refresh pushed 2000
        // SSE messages to the browser in ~50ms. Even with the client-side
        // rAF debounce in renderLogs(), this still:
        //   - Allocated 2000 JSON-encode operations on the main thread
        //   - Pushed 2000 entries through the SSE controller (each = a
        //     chunked write + TCP flush)
        //   - Forced the browser to parse 2000 SSE messages + JSON.parse
        //     each one + push to logLines + splice when > 2000
        //   - Made the dashboard log panel jump from empty → 2000 rows
        //     in one frame, causing layout thrash
        //
        // The user only needs "what just happened" context on refresh —
        // 200 recent entries is plenty for that. Older history is still
        // queryable via the /admin/api/logs batch endpoint (with search
        // + filter + pagination) and the on-disk log file (if enabled).
        //
        // The cap is intentionally a separate constant from
        // LOG_BUFFER_SIZE so we can tune replay size independently of
        // retention.
        const replay = recentRingEntries(LOG_CONST.INITIAL_REPLAY_LIMIT);
        const replayEndSeq = replay.length > 0 ? replay[replay.length - 1].seq : logSeq;
        if (!sendBatch(replay, false)) return;
        // Advance only to the last entry we actually replayed. If a log is
        // appended between the replay snapshot and waiter registration, it is
        // not in `replay`; flushNew below must still be able to deliver it.
        lastSentSeq = replayEndSeq;

        // Long-lived waiter: appendLog() calls resolve(entry) for every
        // connected SSE client. resolve() just sends the entry directly —
        // NO re-push, NO flushNew (the entry is right here, no need to
        // re-scan the buffer). The waiter stays in logWaiters until the
        // connection closes (cancel() handler removes it).
        const waiter: LogWaiter = {
          resolve: (entry: SerializedLogEntry) => {
            if (closed) return;
            // The value IS the new log entry — send it directly.
            // No need to flushNew() because we have the entry right here.
            if (entry.entry.seq > lastSentSeq) {
              sendSerialized(entry);
            }
          },
          resolveBatch: (entries: readonly SerializedLogEntry[]) => {
            if (closed) return;
            sendSerializedBatch(entries);
          },
          flush: flushNew,
        };
        streamWaiter = waiter;
        logWaiters.push(waiter);
        // v0.2.0.8: cap concurrent SSE log subscribers. Each connected
        // dashboard tab holds one entry here; without a cap a script (or a
        // browser tab flood) could grow logWaiters unbounded, and every
        // appendLog call would fan out to all of them. 50 is plenty for any
        // realistic ops use; a 51st connection gets a 503 + explanatory
        // message so the client can retry with backoff. The route-level
        // preflight above rejects before initial replay; this guard is kept
        // as a defensive backstop if stream starts interleave unexpectedly.
        if (logWaiters.length > MAX_LOG_STREAM_SUBSCRIBERS) {
          logWaiters.pop(); // undo the push
          closed = true;
          controller.error(new Error(`Too many concurrent log stream connections (max ${MAX_LOG_STREAM_SUBSCRIBERS}). Close other dashboard tabs and retry.`));
          return;
        }

        // Close the narrow race window between initial replay and waiter
        // registration. This is cheap (ring buffer is bounded) and prevents
        // rare dashboard log gaps on refresh.
        flushNew();

        // v0.1.5+ HEARTBEAT + SHORTER maxTimeout.
        //
        // doCleanup is declared BEFORE the intervals that reference it
        // (heartbeats call doCleanup on enqueue failure). const-hoisting +
        // closure semantics make this safe: setInterval's callback fires
        // asynchronously, well after `doCleanup` has been assigned.
        let interval: ReturnType<typeof setInterval> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let maxTimeout: ReturnType<typeof setTimeout> | null = null;

        const doCleanup = () => {
          closed = true;
          if (interval) clearInterval(interval);
          if (heartbeat) clearInterval(heartbeat);
          if (maxTimeout) clearTimeout(maxTimeout);
          const idx = logWaiters.indexOf(waiter);
          if (idx >= 0) logWaiters.splice(idx, 1);
        };
        cleanup = doCleanup;

        // Safety-net polling: 2s interval, used only to recover from the
        // rare race where appendLog fires between the buffer-scan above and
        // the logWaiters.push() above. Slow enough to be cheap on idle
        // systems; fast enough that the race window is negligible.
        interval = setInterval(() => {
          if (closed) return;
          flushNew();
        }, 2000);
        interval.unref?.();

        // v0.1.5+ HEARTBEAT: send a no-op SSE comment (": heartbeat\n\n")
        // every 30s. This serves two purposes:
        //   1. Detects dead connections — if the client closed without
        //      sending TCP FIN (mobile network drops, browser tab crash,
        //      laptop sleep), the controller.enqueue throws and we clean
        //      up the waiter. Without this, the waiter leaks for the full
        //      maxTimeout window (10 min), and appendLog keeps calling
        //      resolve() on it (no-op but still O(N) iteration cost).
        //   2. Keeps the TCP connection alive through proxies / load
        //      balancers that close idle connections after 60s.
        // The SSE comment line (starting with ":") is ignored by the
        // browser's EventSource API — it doesn't trigger any message event.
        heartbeat = setInterval(() => {
          if (closed) return;
          if (!sendPayload(`: heartbeat\n\n`)) {
            // enqueue failed — client is gone. Trigger cleanup.
            doCleanup();
            try { controller.close(); } catch { /* already closed */ }
          }
        }, LOG_CONST.HEARTBEAT_MS);
        heartbeat.unref?.();

        // v0.1.5+ SHORTER maxTimeout: was 1 hour (way too long — leaked
        // waiters up to 1h per disconnected client). 10 minutes was still
        // too long — leaked waiters block `for (const w of logWaiters)`
        // iteration in appendLog() for the full window, and on Windows
        // where abrupt disconnects (F5 refresh, tab close, laptop sleep)
        // aren't always detected immediately, this caused "运行久了刷新卡顿".
        //
        // 2 minutes is plenty for a dashboard log viewer session; the client
        // auto-reconnects via EventSource's built-in retry after we close.
        // Even with 10 leaked waiters, the worst-case iteration cost in
        // appendLog drops from 10min × N to 2min × N — a 5x improvement.
        maxTimeout = setTimeout(() => {
          doCleanup();
          try { controller.close(); } catch { /* already closed */ }
        }, LOG_CONST.MAX_CONNECTION_MS);
        maxTimeout.unref?.();
      },
      cancel() {
        // Cleanup if the client disconnects early
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        // Disable Nagle's algorithm for snappier streaming
        "x-accel-buffering": "no",
      },
    });
  }

  // Get logs (batch)
  if (path === "/admin/api/logs" && method === "GET") {
    const level = url.searchParams.get("level");
    const search = url.searchParams.get("search")?.toLowerCase();
    const limit = parseQueryLimit(url.searchParams.get("limit"), 200, 2000);
    const logs = level || search
      ? recentMatchingRingEntries(limit, level, search)
      : recentRingEntries(limit);
    return jsonResp({ logs, total: logRingCount });
  }

  // Get debug dumps (memory ring buffer of upstream 4xx transformed bodies).
  // Replaces the old writeFileSync-to-disk approach that leaked user
  // conversation content to <cwd>/zcode-proxy-debug-*.json forever.
  if (path === "/admin/api/debug-dumps" && method === "GET") {
    const limit = parseQueryLimit(url.searchParams.get("limit"), 20, 100);
    // Strip the full body by default — only return it when ?full=1.
    // Bodies can be 90KB+ and may contain user conversation content, so we
    // hide them behind an explicit opt-in to avoid surprising the user.
    const includeBody = url.searchParams.get("full") === "1";
    const dumpId = url.searchParams.get("id");
    if (dumpId) {
      const dump = debugDumps.find(d => d.id === dumpId);
      if (!dump) return errorResponse(404, "not_found", "Debug dump not found");
      return jsonResp(includeBody ? dump : { ...dump, body: undefined });
    }
    return jsonResp({
      dumps: (limit <= 0 ? [] : debugDumps.slice(-limit).reverse()).map(d =>
        includeBody ? d : { ...d, body: undefined }
      ),
      total: debugDumps.length,
    });
  }

  // Clear debug dumps
  if (path === "/admin/api/debug-dumps" && method === "DELETE") {
    clearDebugDumps();
    appendLog("info", "Debug dumps cleared by admin");
    return jsonResp({ ok: true });
  }

  // =====================================================================
  // Global Proxy Pool (v0.2.2+)
  // =====================================================================
  // All routes under /admin/api/proxy-pool/* manage the global proxy pool.
  // The pool provides a fallback outbound proxy shared across all accounts;
  // per-account `cred.proxy` overrides still take priority over the pool.
  // See src/proxy/proxy-pool.ts for the full design.
  if (path === "/admin/api/proxy-pool" && method === "GET") {
    try {
      const state = await getPoolState();
      return jsonResp(state);
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  if (path === "/admin/api/proxy-pool/config" && method === "PUT") {
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return errorResponse(400, "invalid_param", "Body must be a JSON object");
      }
      const patch: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
        if (typeof body.enabled !== "boolean") {
          return errorResponse(400, "invalid_param", "enabled must be a boolean");
        }
        patch.enabled = body.enabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, "refreshIntervalMin")) {
        if (typeof body.refreshIntervalMin !== "number"
          || !Number.isInteger(body.refreshIntervalMin)
          || body.refreshIntervalMin < 0
          || body.refreshIntervalMin > MAX_PROXY_POOL_REFRESH_INTERVAL_MIN) {
          return errorResponse(400, "invalid_param", `refreshIntervalMin must be an integer between 0 and ${MAX_PROXY_POOL_REFRESH_INTERVAL_MIN}`);
        }
        patch.refreshIntervalMin = body.refreshIntervalMin;
      }
      if (Object.prototype.hasOwnProperty.call(body, "sourceUrls")) {
        if (!Array.isArray(body.sourceUrls)) {
          return errorResponse(400, "invalid_param", "sourceUrls must be an array of URLs");
        }
        // Validate each URL.
        const urls: string[] = [];
        for (const u of body.sourceUrls) {
          if (typeof u !== "string") {
            return errorResponse(400, "invalid_param", "sourceUrls must contain only strings");
          }
          const trimmed = u.trim();
          if (!trimmed) continue;
          const validation = validateProxySourceUrl(trimmed);
          if (!validation.ok) return errorResponse(400, "invalid_param", validation.message);
          urls.push(validation.url);
        }
        patch.sourceUrls = urls;
      }
      if (Object.prototype.hasOwnProperty.call(body, "rotateOnGatewayBlock")) {
        if (typeof body.rotateOnGatewayBlock !== "boolean") {
          return errorResponse(400, "invalid_param", "rotateOnGatewayBlock must be a boolean");
        }
        patch.rotateOnGatewayBlock = body.rotateOnGatewayBlock;
      }
      if (Object.prototype.hasOwnProperty.call(body, "maxRotations")) {
        if (typeof body.maxRotations !== "number"
          || !Number.isInteger(body.maxRotations)
          || body.maxRotations < 0
          || body.maxRotations > MAX_PROXY_POOL_ROTATIONS) {
          return errorResponse(400, "invalid_param", `maxRotations must be an integer between 0 and ${MAX_PROXY_POOL_ROTATIONS}`);
        }
        patch.maxRotations = body.maxRotations;
      }
      const newConfig = await updatePoolConfig(patch);
      appendLog("info", `Proxy pool config updated (enabled=${newConfig.enabled}, interval=${newConfig.refreshIntervalMin}min, sources=${newConfig.sourceUrls.length})`);
      return jsonResp({ ok: true, config: newConfig });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Import proxies from a raw text block (paste or txt file upload).
  // Body: { text: string, replace?: boolean }
  // Returns: { ok: true, added, removed, total }
  if (path === "/admin/api/proxy-pool/import-text" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ text?: string; replace?: boolean }>(req, { maxBytes: MAX_PROXY_IMPORT_TEXT_BODY_BYTES });
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.text !== "string") {
        return errorResponse(400, "missing_param", "text is required");
      }
      const result = await importFromText(body.text, body.replace === true);
      appendLog("info", `Proxy pool import (text): +${result.added} -${result.removed} =${result.total}`);
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Import proxies from a remote URL (one-shot fetch, not auto-refresh).
  // Body: { url: string }
  // Returns: { ok: true, added, removed, total, fetched, error? }
  if (path === "/admin/api/proxy-pool/import-url" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ url?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.url !== "string" || !body.url.trim()) {
        return errorResponse(400, "missing_param", "url is required");
      }
      const trimmed = body.url.trim();
      const validation = validateProxySourceUrl(trimmed);
      if (!validation.ok) return errorResponse(400, "invalid_param", validation.message);
      const fetchImpl = opts.fetchImpl ?? fetch;
      const result = await importFromUrl(validation.url, fetchImpl);
      if (result.error) {
        appendLog("warn", `Proxy pool import (URL ${trimmed}) failed: ${result.error}`);
        return jsonResp({ ok: false, ...result }, 200);
      }
      appendLog("info", `Proxy pool import (URL ${trimmed}): +${result.added} -${result.removed} =${result.total} (fetched ${result.fetched})`);
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Refresh from ALL configured source URLs (manual trigger).
  // Returns: { ok: true, added, removed, total, at, errors? }
  if (path === "/admin/api/proxy-pool/refresh" && method === "POST") {
    try {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const result = await refreshFromSources(fetchImpl);
      appendLog("info", `Proxy pool refresh: +${result.added} -${result.removed} =${result.total}` + (result.errors ? ` (errors: ${Object.keys(result.errors).length})` : ""));
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Remove a single proxy by id.
  // Body: { id: string }
  if (path === "/admin/api/proxy-pool/proxy" && method === "DELETE") {
    try {
      const parsed = await readJsonBody<{ id?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.id !== "string" || !body.id.trim()) {
        return errorResponse(400, "missing_param", "id is required");
      }
      const ok = await removeProxy(body.id);
      if (!ok) return errorResponse(404, "not_found", "Proxy not found in pool");
      appendLog("info", `Proxy pool entry removed: ${body.id}`);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Clear all proxies (config preserved).
  if (path === "/admin/api/proxy-pool/clear" && method === "POST") {
    try {
      const result = await clearProxies();
      appendLog("info", `Proxy pool cleared: ${result.removed} entries removed`);
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Test a single pool proxy by id (v0.2.1.1+)
  // Does a HEAD request to the configured provider's base URL through the
  // proxy identified by `id`. Returns ok:true with latency on any HTTP
  // response (even 4xx/5xx means the proxy is reachable); ok:false on
  // network-level failures (timeout, connection refused, etc.).
  //
  // Body: { id: string, provider?: "zai"|"bigmodel" }
  // Returns: { ok: true, status, latencyMs, target, url } on success
  //          { ok: false, error, latencyMs, target, url } on failure
  if (path === "/admin/api/proxy-pool/test-one" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ id?: string; provider?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.id !== "string" || !body.id.trim()) {
        return errorResponse(400, "missing_param", "id is required");
      }
      const state = await getPoolState();
      const entry = state.proxies.find(p => p.id === body.id);
      if (!entry) {
        return errorResponse(404, "not_found", "Proxy not found in pool");
      }
      const proxyUrl = entry.url;

      // Determine test target (provider's base host origin).
      const providerId = body.provider === "bigmodel" ? "bigmodel" : "zai";
      const providerCfg = opts.config.providers[providerId];
      let target: string;
      try {
        const u = new URL(providerCfg.anthropicBase);
        target = `${u.protocol}//${u.host}`;
      } catch {
        target = providerId === "bigmodel"
          ? "https://open.bigmodel.cn"
          : "https://api.z.ai";
      }

      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      timer.unref?.();
      // wrapFetchWithSocksBridge transparently routes SOCKS proxies through
      // the local HTTP-CONNECT→SOCKS bridge.
      const fetchImpl = wrapFetchWithSocksBridge(opts.fetchImpl ?? fetch);
      try {
        const resp = await fetchImpl(target, {
          method: "HEAD",
          signal: ctrl.signal,
          redirect: "follow",
          ...(proxyUrl ? { proxy: proxyUrl } : {}),
        } as any);
        const latencyMs = Date.now() - started;
        try { await resp.body?.cancel(); } catch {}
        return jsonResp({
          ok: true,
          id: body.id,
          url: proxyUrl,
          status: resp.status,
          latencyMs,
          target,
        });
      } catch (err) {
        const latencyMs = Date.now() - started;
        const errMsg = (err as Error).message || String(err);
        const isTimeout = ctrl.signal.aborted || /abort/i.test(errMsg);
        return jsonResp({
          ok: false,
          id: body.id,
          url: proxyUrl,
          error: isTimeout ? "Connection timed out after 10s" : truncateAdminErrorMessage(errMsg),
          latencyMs,
          target,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Start a background test-all job (v0.2.1.1+)
  // The job runs entirely on the server — closing the browser tab does NOT
  // stop it. The dashboard polls GET /test-status for progress.
  //
  // Body: { batchSize?: number, autoRemove?: boolean, provider?: "zai"|"bigmodel" }
  // Returns: the initial job state (running: true)
  if (path === "/admin/api/proxy-pool/test-all" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ batchSize?: number; autoRemove?: boolean; provider?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (body.batchSize !== undefined
          && (!Number.isSafeInteger(body.batchSize) || body.batchSize < 1 || body.batchSize > 50)) {
        return errorResponse(400, "invalid_param", "batchSize must be an integer between 1 and 50");
      }
      if (body.autoRemove !== undefined && typeof body.autoRemove !== "boolean") {
        return errorResponse(400, "invalid_param", "autoRemove must be a boolean");
      }
      if (body.provider !== undefined && body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }

      // Determine test target (provider's base host origin).
      const providerId = body.provider === "bigmodel" ? "bigmodel" : "zai";
      const providerCfg = opts.config.providers[providerId];
      let testTarget: string;
      try {
        const u = new URL(providerCfg.anthropicBase);
        testTarget = `${u.protocol}//${u.host}`;
      } catch {
        testTarget = providerId === "bigmodel"
          ? "https://open.bigmodel.cn"
          : "https://api.z.ai";
      }

      const state = await startTestJob({
        batchSize: body.batchSize,
        autoRemove: body.autoRemove,
        fetchImpl: opts.fetchImpl,
        testTarget,
      });
      appendLog("info", `Proxy pool test-all started: ${state.total} proxies, batch=${state.batchSize}, autoRemove=${state.autoRemove}`);
      return jsonResp(state);
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Poll background test-all job status (v0.2.1.1+)
  // Returns the current job state, or { running: false, total: 0, ... } if
  // no job has ever run.
  if (path === "/admin/api/proxy-pool/test-status" && method === "GET") {
    const sinceRaw = url.searchParams.get("sinceSeq");
    const sinceSeq = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    const state = getTestJobState({ sinceSeq });
    if (!state) {
      return jsonResp({
        running: false,
        total: 0,
        tested: 0,
        okCount: 0,
        failCount: 0,
        removedCount: 0,
        batchSize: 0,
        autoRemove: false,
        startedAt: 0,
        resultSeq: 0,
        results: {},
      });
    }
    return jsonResp(state);
  }

  // Cancel the current background test-all job (v0.2.1.1+)
  if (path === "/admin/api/proxy-pool/test-cancel" && method === "POST") {
    cancelTestJob();
    appendLog("info", "Proxy pool test-all cancelled by admin");
    return jsonResp({ ok: true });
  }

  return null; // Not an admin route
}

// --- Helpers ---

/**
 * Maximum allowed JSON request body size for ordinary admin API routes (1 MiB).
 * All admin mutation endpoints accept small structured payloads (credentials,
 * config patches, OAuth flow ids) — anything larger is almost certainly
 * malicious or a misconfigured client. Limiting prevents OOM from a
 * malicious 1GB JSON body reaching `await req.json()`.
 *
 * File-import endpoints intentionally opt into larger per-route limits so the
 * backend matches the dashboard's documented client-side caps:
 *   - accounts JSON: 2 MiB file + JSON wrapper/escaping headroom
 *   - proxy text: 5 MiB text can grow after JSON string escaping newlines
 */
const MAX_ADMIN_BODY_BYTES = 1 * 1024 * 1024;
const MAX_ACCOUNT_IMPORT_BODY_BYTES = 3 * 1024 * 1024;
const MAX_PROXY_IMPORT_TEXT_BODY_BYTES = 12 * 1024 * 1024;
const DEFAULT_ADMIN_BODY_IDLE_TIMEOUT_MS = 30_000;

let adminBodyIdleTimeoutMsForTesting: number | undefined;

export function _setAdminBodyIdleTimeoutForTesting(timeoutMs?: number): void {
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

/**
 * Read and parse a JSON request body with a size limit. Returns
 * `{ ok: false, error }` when the body is too large or not valid JSON,
 * so callers can early-return without exception handling boilerplate.
 */
async function readJsonBody<T = unknown>(
  req: Request,
  options: { maxBytes?: number; idleTimeoutMs?: number } = {},
): Promise<{ ok: true; body: T } | { ok: false; error: Response }> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? MAX_ADMIN_BODY_BYTES));
  const idleTimeoutMs = Math.max(1, Math.floor(
    options.idleTimeoutMs ?? adminBodyIdleTimeoutMsForTesting ?? DEFAULT_ADMIN_BODY_IDLE_TIMEOUT_MS,
  ));
  // Content-Length is set by virtually all well-behaved clients. If it's
  // missing we still cap the actual read via the streaming check below.
  const declaredLength = parseDeclaredContentLength(req.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    void req.body?.cancel().catch(() => {});
    return { ok: false, error: errorResponse(413, "request_too_large", `Request body exceeds ${maxBytes} byte limit`) };
  }
  // Read the body as text with an explicit cap — defends against clients
  // that omit Content-Length (chunked transfer encoding) or lie about it.
  const reader = req.body?.getReader();
  if (!reader) {
    // No body — treat as empty object (some GETs reach here erroneously).
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

/** Security headers added to all admin responses (dashboard + API). */
function withSecurityHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  // CSP: only allow same-origin scripts/styles. External connections are
  // limited to the known upstream OAuth / quota endpoints. Inline scripts
  // are NOT allowed (dashboard uses inline event handlers today, so we use
  // 'unsafe-inline' for script-src as a temporary measure — TODO: replace
  // inline handlers with addEventListener to drop 'unsafe-inline').
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy",
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https://zcode.z.ai https://api.z.ai https://open.bigmodel.cn; " +
      "img-src 'self' data:; " +
      "font-src 'self' data:; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'");
  }
  if (!headers.has("x-frame-options")) headers.set("x-frame-options", "DENY");
  if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", "same-origin");
  // Dashboard returns secrets on some endpoints — never cache.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/**
 * In-memory rate limiter for the /admin/api/verify endpoint. Tracks failed
 * attempts per client IP; after MAX_FAILURES within the WINDOW, all further
 * attempts from that IP are rejected with 429 until the lockout expires.
 *
 * This is a soft limit — it lives in process memory and resets on restart.
 * Its purpose is to make brute-forcing proxyApiKey impractical from a
 * single IP, not to defend against a distributed attacker (that requires
 * proxyApiKey to be strong, which is the operator's responsibility).
 */
const VERIFY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const VERIFY_RATE_LIMIT_MAX_FAILURES = 10;
const VERIFY_RATE_LIMIT_MAX_ENTRIES = 4096;
const VERIFY_RATE_LIMIT_GC_INTERVAL_MS = 60_000;
const verifyFailures = new Map<string, { count: number; firstAt: number }>();
let verifyFailuresLastGcAt = 0;

function gcVerifyFailures(now: number, force = false): void {
  if (!force && verifyFailures.size <= VERIFY_RATE_LIMIT_MAX_ENTRIES && now - verifyFailuresLastGcAt < VERIFY_RATE_LIMIT_GC_INTERVAL_MS) {
    return;
  }
  verifyFailuresLastGcAt = now;
  for (const [k, v] of verifyFailures) {
    if (now - v.firstAt > VERIFY_RATE_LIMIT_WINDOW_MS) verifyFailures.delete(k);
  }
  if (verifyFailures.size <= VERIFY_RATE_LIMIT_MAX_ENTRIES) return;
  const overflow = verifyFailures.size - VERIFY_RATE_LIMIT_MAX_ENTRIES;
  let dropped = 0;
  for (const k of verifyFailures.keys()) {
    verifyFailures.delete(k);
    dropped++;
    if (dropped >= overflow) break;
  }
}

/** Record a failed /verify attempt for `ip`. Evicts stale entries to bound memory. */
function recordVerifyFailure(ip: string): void {
  const now = Date.now();
  gcVerifyFailures(now, verifyFailures.size >= VERIFY_RATE_LIMIT_MAX_ENTRIES);
  const existing = verifyFailures.get(ip);
  if (existing) {
    existing.count++;
    // If the first attempt is older than the window, reset the counter.
    if (now - existing.firstAt > VERIFY_RATE_LIMIT_WINDOW_MS) {
      existing.count = 1;
      existing.firstAt = now;
    }
  } else {
    verifyFailures.set(ip, { count: 1, firstAt: now });
  }
  if (verifyFailures.size > VERIFY_RATE_LIMIT_MAX_ENTRIES) {
    gcVerifyFailures(now, true);
  }
}

/** Returns true if `ip` is currently rate-locked-out. */
function isVerifyLocked(ip: string): boolean {
  const v = verifyFailures.get(ip);
  if (!v) return false;
  if (Date.now() - v.firstAt > VERIFY_RATE_LIMIT_WINDOW_MS) {
    verifyFailures.delete(ip);
    return false;
  }
  return v.count >= VERIFY_RATE_LIMIT_MAX_FAILURES;
}

/** Resolve a client IP for rate-limiting purposes. Prefers the socket-based resolver. */
function resolveIpForRateLimit(req: Request, opts: AdminOptions): string {
  if (opts.resolveClientIp) {
    try {
      const ip = opts.resolveClientIp(req);
      if (ip) return ip;
    } catch { /* ignore */ }
  }
  // Fall back to XFF ONLY if trustProxy (consistent with the loopback gate).
  if (opts.config.server.trustProxy) {
    const xRealIp = req.headers.get("x-real-ip") ?? "";
    if (xRealIp) return xRealIp;
    const xff = req.headers.get("x-forwarded-for") ?? "";
    if (xff) return xff.split(",")[0].trim();
  }
  return "unknown";
}

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalConfigObject(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  const value = body[key];
  if (!isConfigObject(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value;
}

function optionalNestedConfigObject(body: Record<string, unknown>, key: string, path: string): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  const value = body[key];
  if (!isConfigObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function sanitizeProviderEndpoints(provider: ProxyConfig["providers"]["zai"]): Record<string, unknown> {
  const { credential, ...rest } = provider;
  return {
    ...rest,
    ...(credential ? { credential: CONFIG_SECRET_MASK } : {}),
  };
}

function sanitizeConfig(config: ProxyConfig): Record<string, unknown> {
  return {
    server: config.server,
    provider: config.provider,
    plan: config.plan,
    auth: {
      mode: config.auth.mode,
      // Don't expose full API key, just indicate presence
      apiKey: config.auth.apiKey ? CONFIG_SECRET_MASK : "",
      proxyApiKey: config.auth.proxyApiKey ? CONFIG_SECRET_MASK : "",
      ...(config.auth.oauthCredentialsPath ? { oauthCredentialsPath: config.auth.oauthCredentialsPath } : {}),
    },
    providers: {
      zai: sanitizeProviderEndpoints(config.providers.zai),
      bigmodel: sanitizeProviderEndpoints(config.providers.bigmodel),
    },
    defaultModel: config.defaultModel,
    models: config.models,
    identity: config.identity,
    logging: config.logging,
    retry: config.retry,
    corsAllowList: config.corsAllowList ?? [],
    routingRules: config.routingRules ?? [],
    modelMappings: config.modelMappings ?? [],
    responsesThinking: config.responsesThinking ?? { models: [] },
    // v0.2.0.4: forceStreamAnthropic removed — stream:true is now unconditional.
    thinkingLevel: config.thinkingLevel === "high" ? "high" : "max",
  };
}

function configToYaml(config: ProxyConfig): string {
  // Build a plain object preserving insertion order matching config.example.yaml,
  // then let the `yaml` library handle quoting/indentation/escape correctly.
  // This keeps values with special chars (colons, leading spaces, quotes) safe
  // and avoids the brittle manual string concatenation that previously broke on
  // URLs containing ':' and other reserved characters.
  const obj: Record<string, unknown> = {
    server: {
      port: config.server.port,
      host: config.server.host,
      // v0.2.1.7+: persist all server fields so dashboard saves don't
      // drop upstreamTimeoutMs / trustProxy / sseHeartbeatMs / maxRequestBodyBytes. Previously
      // only port+host were serialized, causing these fields to vanish
      // from config.yaml on the next save (and revert to defaults on
      // restart).
      ...(config.server.upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs: config.server.upstreamTimeoutMs } : {}),
      ...(config.server.trustProxy !== undefined ? { trustProxy: config.server.trustProxy } : {}),
      ...(config.server.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: config.server.sseHeartbeatMs } : {}),
      ...(config.server.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: config.server.maxRequestBodyBytes } : {}),
    },
    auth: {
      mode: config.auth.mode,
      ...(config.auth.apiKey ? { apiKey: config.auth.apiKey } : {}),
      ...(config.auth.proxyApiKey ? { proxyApiKey: config.auth.proxyApiKey } : {}),
      ...(config.auth.oauthCredentialsPath ? { oauthCredentialsPath: config.auth.oauthCredentialsPath } : {}),
    },
    provider: config.provider,
    plan: config.plan,
    providers: {
      zai: {
        anthropicBase: config.providers.zai.anthropicBase,
        openaiBase: config.providers.zai.openaiBase,
        ...(config.providers.zai.credential ? { credential: config.providers.zai.credential } : {}),
      },
      bigmodel: {
        anthropicBase: config.providers.bigmodel.anthropicBase,
        openaiBase: config.providers.bigmodel.openaiBase,
        ...(config.providers.bigmodel.credential ? { credential: config.providers.bigmodel.credential } : {}),
      },
    },
    defaultModel: config.defaultModel,
    models: config.models,
    identity: { ...config.identity },
    logging: { ...config.logging },
    retry: { ...config.retry, retryableStatuses: [...config.retry.retryableStatuses] },
    ...(config.corsAllowList && config.corsAllowList.length > 0
      ? { corsAllowList: [...config.corsAllowList] }
      : {}),
    ...(config.routingRules && config.routingRules.length > 0
      ? { routingRules: config.routingRules.map(r => ({
          pattern: r.pattern,
          provider: r.provider,
          ...(r.endpoint ? { endpoint: r.endpoint } : {}),
          ...(r.note ? { note: r.note } : {}),
        })) }
      : {}),
    ...(config.modelMappings && config.modelMappings.length > 0
      ? { modelMappings: config.modelMappings.map(m => ({
          from: m.from,
          to: m.to,
          ...(m.note ? { note: m.note } : {}),
        })) }
      : {}),
    ...(config.responsesThinking && config.responsesThinking.models.length > 0
      ? { responsesThinking: { models: [...config.responsesThinking.models] } }
      : {}),
    // Always emit the anthropic section so the dashboard's toggles persist
    // across saves — otherwise turning ON then saving then turning OFF would
    // leave a stale `true` in the YAML forever.
    anthropic: {
      // v0.2.0.4: forceStream removed — stream:true is now unconditional.
      // Always persist thinkingLevel so users can see/change it in YAML.
      // Default "max" mirrors real ZCode desktop client's max tier.
      thinkingLevel: config.thinkingLevel === "high" ? "high" : "max",
    },
  };

  return stringifyYaml(obj, {
    indent: 2,
    lineWidth: 0,        // Don't wrap long strings (URLs, API keys)
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    nullStr: "",
  });
}

function normalizeRetryableStatuses(values: unknown[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const s of values) {
    const n = typeof s === "number"
      ? s
      : (typeof s === "string" && /^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new Error(`retry.retryableStatuses contains invalid status: ${s}`);
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function normalizeModelList(values: unknown[], defaultModel: unknown): string[] {
  const models = values
    .filter((m): m is string => typeof m === "string")
    .map(m => m.trim())
    .filter(Boolean);
  if (typeof defaultModel === "string" && defaultModel.trim() && !models.includes(defaultModel.trim())) {
    models.push(defaultModel.trim());
  }
  return models;
}

function normalizeRoutingRulesForSave(values: unknown[]): RoutingRule[] {
  const rules: RoutingRule[] = [];
  for (const item of values) {
    if (!isConfigObject(item)) {
      throw new Error("routingRules entries must be objects");
    }
    if (typeof item.pattern !== "string" || item.pattern.trim() === "") {
      throw new Error("routingRules entries need a non-empty pattern");
    }
    if (item.provider !== "zai" && item.provider !== "bigmodel") {
      throw new Error(`routingRules entry "${item.pattern}" has invalid provider`);
    }
    if (item.endpoint !== undefined && item.endpoint !== null && typeof item.endpoint !== "string") {
      throw new Error("routingRules.endpoint must be a string");
    }
    if (item.note !== undefined && item.note !== null && typeof item.note !== "string") {
      throw new Error("routingRules.note must be a string");
    }
    rules.push({
      pattern: item.pattern.trim(),
      provider: item.provider,
      endpoint: typeof item.endpoint === "string" && item.endpoint.trim() ? item.endpoint.trim() : undefined,
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
    });
  }
  return rules;
}

function normalizeModelMappingsForSave(values: unknown[]): ModelMapping[] {
  const mappings: ModelMapping[] = [];
  const seenFrom = new Set<string>();
  for (const item of values) {
    if (!isConfigObject(item)) {
      throw new Error("modelMappings entries must be objects");
    }
    if (typeof item.from !== "string" || item.from.trim() === "") {
      throw new Error("modelMappings entries need a non-empty from");
    }
    if (typeof item.to !== "string" || item.to.trim() === "") {
      throw new Error("modelMappings entries need a non-empty to");
    }
    const from = item.from.trim().toLowerCase();
    if (seenFrom.has(from)) {
      throw new Error(`Duplicate modelMappings.from value: "${item.from}"`);
    }
    seenFrom.add(from);
    if (item.note !== undefined && item.note !== null && typeof item.note !== "string") {
      throw new Error("modelMappings.note must be a string");
    }
    mappings.push({
      from,
      to: item.to.trim(),
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
    });
  }
  return mappings;
}

function parseStrictNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function requireStrictNumber(raw: unknown, field: string): number {
  const n = parseStrictNumber(raw);
  if (n === null) throw new Error(`${field} must be a valid number`);
  return n;
}

function normalizeIntegerField(
  obj: Record<string, unknown>,
  key: string,
  field: string,
  opts: { min?: number; max?: number } = {},
): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  const n = requireStrictNumber(obj[key], field);
  if (!Number.isSafeInteger(n)) throw new Error(`${field} must be an integer`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${field} ${n} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${field} ${n} is out of range (${opts.min ?? "-Infinity"}-${opts.max})`);
  obj[key] = n;
}

function normalizePositiveNumberField(obj: Record<string, unknown>, key: string, field: string): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  const n = requireStrictNumber(obj[key], field);
  if (n <= 0) throw new Error(`${field} ${n} must be > 0`);
  obj[key] = n;
}

function normalizeBooleanField(obj: Record<string, unknown>, key: string, field: string): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  const value = obj[key];
  if (typeof value === "boolean") return;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      obj[key] = true;
      return;
    }
    if (normalized === "false" || normalized === "0") {
      obj[key] = false;
      return;
    }
  }
  throw new Error(`${field} must be a boolean`);
}

function normalizeConfigForSave(cfg: Record<string, unknown>): void {
  const server = cfg.server as Record<string, unknown> | undefined;
  if (server) {
    normalizeIntegerField(server, "port", "server.port", { min: 1, max: 65535 });
    normalizeIntegerField(server, "maxRequestBodyBytes", "server.maxRequestBodyBytes", { min: 0 });
    normalizeIntegerField(server, "upstreamTimeoutMs", "server.upstreamTimeoutMs", { min: 0 });
    normalizeIntegerField(server, "sseHeartbeatMs", "server.sseHeartbeatMs", { min: 0 });
    normalizeBooleanField(server, "trustProxy", "server.trustProxy");
  }

  const retry = cfg.retry as Record<string, unknown> | undefined;
  if (retry) {
    normalizeIntegerField(retry, "maxRetries", "retry.maxRetries", { min: 0 });
    normalizeIntegerField(retry, "initialDelayMs", "retry.initialDelayMs", { min: 1, max: 60_000 });
    normalizeIntegerField(retry, "maxDelayMs", "retry.maxDelayMs", { min: 1, max: 300_000 });
    normalizeIntegerField(retry, "credentialSwitchThreshold", "retry.credentialSwitchThreshold", { min: 0 });
    normalizeIntegerField(retry, "emptyStreamSwitchThreshold", "retry.emptyStreamSwitchThreshold", { min: 0 });
    normalizePositiveNumberField(retry, "backoffFactor", "retry.backoffFactor");
    if (Object.prototype.hasOwnProperty.call(retry, "retryableStatuses")) {
      if (!Array.isArray(retry.retryableStatuses)) {
        throw new Error("retry.retryableStatuses must be an array");
      }
      retry.retryableStatuses = normalizeRetryableStatuses(retry.retryableStatuses);
    }
  }
}

/** Basic validation for config saves from the dashboard. Throws on invalid input. */
function validateConfigForSave(cfg: Record<string, unknown>): void {
  const server = cfg.server as Record<string, unknown> | undefined;
  if (server) {
    const port = typeof server.port === "number" ? server.port : NaN;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`server.port ${port} is out of range (1-65535)`);
    }
    if (server.host !== undefined && typeof server.host !== "string") {
      throw new Error("server.host must be a string");
    }
    if (typeof server.host === "string" && server.host.length > 0) {
      // Basic host validation: IPv4, IPv6, or hostname. Rejects spaces and
      // most special chars. 0.0.0.0 is allowed (bind to all interfaces).
      const hostRe = /^(\d{1,3}\.){3}\d{1,3}$|^[a-fA-F0-9:]+:[a-fA-F0-9:]+$|^[a-zA-Z0-9._-]+$/;
      if (!hostRe.test(server.host)) {
        throw new Error(`server.host "${server.host}" is not a valid IP or hostname`);
      }
    }
    if (server.maxRequestBodyBytes !== undefined) {
      const maxRequestBodyBytes = typeof server.maxRequestBodyBytes === "number" ? server.maxRequestBodyBytes : NaN;
      if (!Number.isFinite(maxRequestBodyBytes) || maxRequestBodyBytes < 0) {
        throw new Error(`server.maxRequestBodyBytes ${server.maxRequestBodyBytes} must be >= 0`);
      }
    }
    if (server.upstreamTimeoutMs !== undefined && (typeof server.upstreamTimeoutMs !== "number" || server.upstreamTimeoutMs < 0)) {
      throw new Error(`server.upstreamTimeoutMs ${server.upstreamTimeoutMs} must be >= 0`);
    }
    if (server.sseHeartbeatMs !== undefined && (typeof server.sseHeartbeatMs !== "number" || server.sseHeartbeatMs < 0)) {
      throw new Error(`server.sseHeartbeatMs ${server.sseHeartbeatMs} must be >= 0`);
    }
    if (server.trustProxy !== undefined && typeof server.trustProxy !== "boolean") {
      throw new Error("server.trustProxy must be a boolean");
    }
  }
  const provider = cfg.provider as string | undefined;
  if (provider && provider !== "zai" && provider !== "bigmodel") {
    throw new Error(`Invalid provider "${provider}": must be "zai" or "bigmodel"`);
  }
  const plan = cfg.plan as string | undefined;
  if (plan && plan !== "coding-plan" && plan !== "start-plan") {
    throw new Error(`Invalid plan "${plan}": must be "coding-plan" or "start-plan"`);
  }

  // Validate providers.*.anthropicBase / openaiBase are URLs (when present).
  // Catches typos like missing https:// or trailing slashes that would 404
  // silently on every request.
  const providers = cfg.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    for (const [name, p] of Object.entries(providers)) {
      for (const field of ["anthropicBase", "openaiBase"]) {
        const v = p?.[field];
        if (typeof v === "string" && v.length > 0) {
          try {
            const u = new URL(v);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              throw new Error(`providers.${name}.${field} must be http(s):// URL (got ${u.protocol})`);
            }
          } catch (err) {
            throw new Error(`providers.${name}.${field} is not a valid URL: ${(err as Error).message}`);
          }
        }
      }
      const credential = p?.credential;
      if (credential !== undefined && credential !== null && typeof credential !== "string") {
        throw new Error(`providers.${name}.credential must be a string`);
      }
    }
  }

  // Validate retry config bounds to prevent runaway retry loops.
  // Note: maxRetries has NO upper bound — operators may legitimately want
  // to retry indefinitely (e.g. a flaky upstream during peak hours).
  const retry = cfg.retry as Record<string, unknown> | undefined;
  if (retry) {
    const maxRetries = typeof retry.maxRetries === "number" ? retry.maxRetries : NaN;
    if (Number.isFinite(maxRetries) && maxRetries < 0) {
      throw new Error(`retry.maxRetries ${maxRetries} must be >= 0`);
    }
    const initialDelayMs = typeof retry.initialDelayMs === "number" ? retry.initialDelayMs : NaN;
    if (Number.isFinite(initialDelayMs) && (initialDelayMs < 1 || initialDelayMs > 60_000)) {
      throw new Error(`retry.initialDelayMs ${initialDelayMs} is out of range (1-60000)`);
    }
    const maxDelayMs = typeof retry.maxDelayMs === "number" ? retry.maxDelayMs : NaN;
    if (Number.isFinite(maxDelayMs) && (maxDelayMs < 1 || maxDelayMs > 300_000)) {
      throw new Error(`retry.maxDelayMs ${maxDelayMs} is out of range (1-300000)`);
    }
    if (Array.isArray(retry.retryableStatuses)) {
      for (const s of retry.retryableStatuses) {
        const n = typeof s === "number" ? s : NaN;
        if (!Number.isFinite(n) || n < 100 || n > 599) {
          throw new Error(`retry.retryableStatuses contains invalid status: ${s}`);
        }
      }
    }
    // credentialSwitchThreshold: 0 = disabled, otherwise the number of
    // consecutive failures (including initial) before switching credentials.
    // No upper bound — but if it exceeds maxRetries+1, switching will never
    // trigger (the retry loop exhausts first). We allow any non-negative int.
    const credentialSwitchThreshold = typeof retry.credentialSwitchThreshold === "number"
      ? retry.credentialSwitchThreshold
      : NaN;
    if (Number.isFinite(credentialSwitchThreshold) && credentialSwitchThreshold < 0) {
      throw new Error(`retry.credentialSwitchThreshold ${credentialSwitchThreshold} must be >= 0`);
    }
    // emptyStreamSwitchThreshold (vceshi0.0.5+): 0 = disabled, otherwise the
    // number of consecutive empty-stream 529s before forcing a credential switch.
    const emptyStreamSwitchThreshold = typeof retry.emptyStreamSwitchThreshold === "number"
      ? retry.emptyStreamSwitchThreshold
      : NaN;
    if (Number.isFinite(emptyStreamSwitchThreshold) && emptyStreamSwitchThreshold < 0) {
      throw new Error(`retry.emptyStreamSwitchThreshold ${emptyStreamSwitchThreshold} must be >= 0`);
    }
    // backoffFactor: must be > 0 (0 → all delays become 0, no backoff; negative → invalid)
    const backoffFactor = typeof retry.backoffFactor === "number"
      ? retry.backoffFactor
      : NaN;
    if (Number.isFinite(backoffFactor) && backoffFactor <= 0) {
      throw new Error(`retry.backoffFactor ${backoffFactor} must be > 0`);
    }
  }

  // Validate models array is non-empty (after applying changes).
  const models = cfg.models as unknown[] | undefined;
  if (Array.isArray(models) && models.length === 0) {
    throw new Error(`models must contain at least one entry (got empty array)`);
  }
  const defaultModel = cfg.defaultModel as string | undefined;
  if (defaultModel !== undefined && typeof defaultModel !== "string") {
    throw new Error(`defaultModel must be a string`);
  }
  // Mirrors loadConfig's auto-append behavior (loader.ts:291-294): if
  // defaultModel is set but not in models[], we add it here so the dashboard
  // save and the next startup agree on what `GET /v1/models` returns.
  // Without this, a dashboard user setting `defaultModel: gpt-4` while
  // `models: [glm-4.6]` would silently grow the array on next loadConfig,
  // producing an inconsistent validation surface.
  if (typeof defaultModel === "string" && defaultModel.length > 0
      && Array.isArray(models) && models.length > 0
      && !models.includes(defaultModel)) {
    models.push(defaultModel);
  }
}
