import { queryQuota } from "../auth/quota.js";
import { exportStore } from "../auth/store.js";
import type { Credential as AppCredential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { captchaPoolStats } from "../proxy/captcha.js";
import { makeProxiedFetcher } from "../proxy/proxied-fetch.js";
import { errorResponse } from "../proxy/translated-response.js";
import { hostClearTimeout, hostSetTimeout } from "../utils/host-timers.js";
import { appendLog } from "./logs.js";
import { readJsonBody } from "./request-body.js";
import { jsonResp } from "./security.js";
import type { AdminRouteContext } from "./types.js";

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

export function clearQuotaCacheForAccount(id: string): void {
  quotaCache.delete(id);
  quotaInFlight.delete(id);
  quotaCacheGenerations.set(id, (quotaCacheGenerations.get(id) ?? 0) + 1);
  pruneQuotaGenerations();
}

export function clearQuotaCache(): void {
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
    timer = hostSetTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error(`activation probe timeout after ${ACTIVATION_PROBE_HARD_TIMEOUT_MS}ms`));
    }, ACTIVATION_PROBE_HARD_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) {
      hostClearTimeout(timer);
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
 * The GET billing/balance call inside queryQuota is gated by `app_version` — a
 * real client version (3.2.x) activates the start-plan trial on a fresh
 * account on the very first successful query, while a low version (2.0.0)
 * never does (see quota.ts DEFAULT_APP_VERSION + the activation memory).
 *
 * OAuth token exchange itself does NOT activate the plan (verified), so a
 * freshly-OAuth'd account is still in `plans:[]` until something queries
 * billing/balance with a real version. Firing this probe once at login means a
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
/**
 * v0.3.6.2: lazily start the captcha token pool once a start-plan credential
 * lands. Fresh oauth installs defer the pre-solver at boot (see index.ts — a
 * mint-failure retry spiral used to starve the event loop exactly while the
 * user was trying to log in). This hook closes the loop: the pool comes up
 * right after the first usable credential is saved, without a restart.
 *
 * Fire-and-forget by design: never blocks and never fails the OAuth flow.
 * Skips when the pool is already running (running === target > 0 or an
 * in-flight solve — startCaptchaPool restarts the refill timer safely, but
 * a duplicate prefill on a broken mint environment would just burn CPU).
 */
export async function ensureCaptchaPoolForStartPlan(cred: AppCredential, appVersion?: string): Promise<void> {
  if (cred.plan !== "start-plan" && !cred.jwt) return;
  try {
    // v0.3.8: pool-running check via the stats helper (the ChromeCaptchaHelper
    // shim was removed with the legacy dashboard page). Same predicate the
    // old shim used: target > 0 or an in-flight solve.
    const pool = captchaPoolStats();
    if (pool.target > 0 || pool.activeSolves > 0) return;
    const { startCaptchaPool } = await import("../proxy/captcha.js");
    await startCaptchaPool(appVersion || "3.9.1");
    console.log("  captcha: token pool started (start-plan credential saved)");
  } catch (e) {
    // Non-fatal: requests fall back to on-demand solving at take-time.
    console.warn(`[captcha] pool start after login failed (non-fatal): ${(e as Error).message}`);
  }
}

export function probeStartPlanActivation(
  cred: AppCredential,
  fetchImpl: typeof fetch,
  appVersion: string | undefined,
  identity?: ProxyIdentity,
): void {
  // Stored credentials imported with a jwt but NO plan field are start-plan
  // (JWTs are start-plan exclusive — same inference as queryQuota / the serve
  // path in index.ts). Gating on `cred.plan !== "start-plan"` alone skipped
  // the activation probe for those, so a fresh account's free trial was never
  // activated by the proxy ("免费套餐刷不出来" until something else queried
  // billing/balance with a real client version).
  if ((cred.plan && cred.plan !== "start-plan") || !cred.jwt?.trim()) return;
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
  const probe = withActivationProbeHardTimeout(queryQuota(cred, accountFetch, appVersion, identity), abortProbe)
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
  identity?: ProxyIdentity,
): void {
  probeStartPlanActivation(cred, fetchImpl, appVersion, identity);
}

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleQuotaRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, path, method } = context;

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
        inFlight = queryQuota(cred, accountFetch, opts.config.identity?.appVersion, opts.config.identity)
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
  return null;
}
