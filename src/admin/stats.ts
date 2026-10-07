import { captchaPoolStats } from "../proxy/captcha.js";
import { LOG as LOG_CONST } from "../utils/constants.js";
import { appendLog } from "./logs.js";
import { jsonResp } from "./security.js";
import type { AdminRouteContext } from "./types.js";

// O(1) retry lookup for retained requests. The bounded seenIds map also keeps
// status/model/token history after a request leaves the display buffer, so late
// retries can reclassify totals without counting the request twice.
// IDs older than SEEN_IDS_LIMIT may be counted again to keep memory bounded.
const SEEN_IDS_LIMIT = LOG_CONST.SEEN_IDS_LIMIT;

const SEEN_IDS_EVICT_BATCH = LOG_CONST.SEEN_IDS_EVICT_BATCH;

const MAX_MODEL_STATS = 100;

const MAX_CREDENTIAL_STATS = 1000;

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

// Insertion order tracks least-recently-used credentials without sorting all
// buckets on every request. Delete+set refreshes an existing key's position.
const credentialStatLastSeen = new Map<string, true>();

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
  if (modelTtfbTotals.size >= MAX_MODEL_STATS) return "_other";
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
  credentialStatLastSeen.delete(key);
  credentialStatLastSeen.set(key, true);
}

function pruneCredentialStats(): void {
  while (credentialStatLastSeen.size > MAX_CREDENTIAL_STATS) {
    const key = credentialStatLastSeen.keys().next().value!;
    delete stats.byCredential[key];
    credentialStatLastSeen.delete(key);
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
}

export function _resetStatsForTesting(): void {
  resetStats();
}

/** Feature handler; authorization is enforced by admin/router.ts. */
export function handleStatsRoutes(context: AdminRouteContext): Response | null {
  const { opts, path, method } = context;

  // v0.3.8: the legacy Chrome-CDP "captcha helper" routes (GET status /
  // POST warmup / POST stop) were removed with the dashboard's 验证码助手 page —
  // the happy-dom token pool is fully automatic (boot pre-solve + demand
  // refill), and the old stop button killed the production token supply.
  // Pool health is now a read-only `captchaPool` field on /admin/api/stats,
  // rendered on the dashboard Overview page.

  // Get stats
  if (path === "/admin/api/stats" && method === "GET") {
    // v0.3.8: captchaPool (ready/target/activeSolves) rides along with the
    // stats snapshot — the Overview page renders it as the 验证码池 card.
    // target === 0 means the pool is not running (coding-plan, or start-plan
    // pre-solver parked); the UI shows "—" in that case.
    return jsonResp({
      ...stats,
      captchaPool: captchaPoolStats(),
      uptime: Date.now() - opts.startTime,
    });
  }

  // Reset stats
  if (path === "/admin/api/stats" && method === "DELETE") {
    resetStats();
    appendLog("info", "Stats reset by admin");
    return jsonResp({ ok: true });
  }
  return null;
}
