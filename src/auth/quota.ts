/**
 * Upstream quota / balance query.
 *
 * Reverses the ZCode desktop client's `BigModelUsageQuotaProvider` (from
 * app.asar out/host/index.js) to read a credential's remaining quota without
 * going through the LLM gateway. Two distinct upstreams:
 *
 * - **start-plan** (zcode.z.ai, authenticates with the plan JWT):
 *     GET /api/v1/zcode-plan/billing/balance  -> active plan + balance units
 *     GET /api/v1/zcode-plan/billing/current  -> legacy fallback for active plan
 *   Both require an `app_version` query param and `Authorization: Bearer <jwt>`.
 *   ZCode 3.2.5 checks entitlement through billing/balance first; older
 *   bundles queried billing/current before balance.
 *
 * - **coding-plan** (api.z.ai for zai / open.bigmodel.cn for bigmodel,
 *   authenticates with the api key):
 *     GET /api/monitor/usage/quota/limit -> { level, limits[] }
 *   The limits[] entry with type "TIME_LIMIT" is the primary quota.
 *
 * @see memory: zcode-quota-endpoints
 */
import type { Credential } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import type { FetchFn } from "./oauth.js";
import { credentialString } from "./types.js";
import { getProvider } from "../provider/providers.js";
import type { ProxyIdentity } from "../config/types.js";
import { buildIdentityHeaders } from "../proxy/identity.js";

const ZCODE_PLAN_BASE = "https://zcode.z.ai/api/v1/zcode-plan";
// MUST match a real ZCode desktop-client version. The billing endpoints use
// app_version as a gate for first-time start-plan trial activation: a low
// version (e.g. the old "2.0.0") does NOT activate the trial, while the current
// client version (3.2.x) does. Using "2.0.0" here meant lealll's quota query
// never activated a fresh account's start-plan — it returned {plans:[]} forever.
// Verified end-to-end 2026-06-25: same jwt, app_version=2.0.0 -> empty;
// app_version=3.1.x/3.2.x -> instant activation. Re-checked against ZCode 3.2.5 on
// 2026-07-04: entitlement is now probed via billing/balance first. Activation
// is irreversible, so the version only matters on the first successful query.
//
// v0.3.1: kept in lock-step with config/loader.ts DEFAULTS.APP_VERSION (3.9.2,
// released 2026-08-26). This constant is only the LAST-resort fallback when a
// caller passes neither a version nor an identity — every production caller
// threads config.identity through, so the wire value tracks the config default.
const DEFAULT_APP_VERSION = "3.9.2";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUOTA_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

/** Normalized, UI-ready quota snapshot for one credential. */
export interface QuotaResult {
  /** Plan tier the credential is on. */
  plan: "coding-plan" | "start-plan";
  provider: ProviderId;
  /** Aggregate remaining units across all balance/limit entries. */
  remaining: { count: number; total: number; percentage: number } | null;
  /** Human-readable plan name / level. */
  planName: string | null;
  /** Plan expiry (ISO string or unix seconds, as the upstream returns it). */
  expireTime: string | number | null;
  /** Per-entitlement / per-limit breakdown for detailed display. */
  limits: QuotaLimit[];
  /** Raw upstream payload, kept for debugging. */
  raw?: unknown;
  /**
   * Set when no usable quota could be read. The caller surfaces this instead of
   * throwing so a dead endpoint shows "unavailable" rather than a 500.
   */
  unavailableReason?: "not_configured" | "no_plan" | "unavailable";
}

export interface QuotaLimit {
  type: string;
  label?: string;
  remaining?: number;
  total?: number;
  used?: number;
  unit?: string;
  nextResetTime?: number | null;
}

/** Reasons a Z.AI billing response is treated as "no active plan". */
const NO_PLAN_HINTS = ["不存在coding plan", "没有资格"];

function toNumber(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function isNoPlanMessage(msg: unknown): boolean {
  if (typeof msg !== "string") return false;
  return NO_PLAN_HINTS.some((h) => msg.includes(h));
}

function withTimeout(fetchImpl: FetchFn): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctrl = new AbortController();
    const upstreamSignal = init?.signal;
    let upstreamAborted = false;
    const onUpstreamAbort = () => {
      upstreamAborted = true;
      ctrl.abort();
    };
    if (upstreamSignal) {
      if (upstreamSignal.aborted) onUpstreamAbort();
      else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await fetchImpl(input, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (ctrl.signal.aborted && !upstreamAborted) {
        throw new Error(`quota request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (upstreamSignal) upstreamSignal.removeEventListener("abort", onUpstreamAbort);
    }
  }) as FetchFn;
}

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

function normalizeTimerMs(raw: number, fallback = REQUEST_TIMEOUT_MS): number {
  const candidate = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const safe = Number.isFinite(candidate) && candidate > 0 ? candidate : REQUEST_TIMEOUT_MS;
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(safe)));
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    reader.read(),
    new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
  if (result === "timeout") {
    const err = new Error(`quota JSON response read timeout after ${timeoutMs}ms`);
    void reader.cancel(err).catch(() => {});
    throw err;
  }
  return result;
}

async function readJsonLimited(resp: Response, maxBytes = MAX_QUOTA_JSON_BYTES, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const readTimeoutMs = normalizeTimerMs(timeoutMs);
  const declaredLength = parseContentLength(resp.headers);
  if (declaredLength !== undefined && declaredLength > limit) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`quota JSON response exceeds ${limit} byte limit (content-length ${declaredLength})`);
  }
  if (!resp.body) return {};

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunkWithTimeout(reader, readTimeoutMs);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new Error(`quota JSON response exceeds ${limit} byte limit`);
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
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : {};
}

/**
 * Query upstream quota for a credential.
 *
 * @param cred     The credential to inspect.
 * @param fetchImpl Injected fetch (lets tests mock + lets the caller attach a
 *                  per-account outbound proxy).
 * @param appVersion ZCode client version sent as `app_version` on start-plan
 *                   requests (required by the billing API, and used by the
 *                   server as the start-plan activation gate — see
 *                   DEFAULT_APP_VERSION). Callers should pass the resolved
 *                   identity.appVersion from config so it matches the real
 *                   client. Defaults to DEFAULT_APP_VERSION ("3.9.2").
 * @param identity  Optional full proxy identity. When provided (or derived
 *                  from appVersion), every quota request carries the same
 *                  identity header set the real ZCode desktop client emits
 *                  (`User-Agent: ZCode/<ver>`, `X-ZCode-App-Version`,
 *                  `X-Title`, platform headers, …). Without this the billing
 *                  request used to go out with ONLY an Authorization header —
 *                  zero User-Agent — which is a fingerprint no real client
 *                  ever produces and an easy WAF flag on zcode.z.ai.
 */
export async function queryQuota(
  cred: Credential,
  fetchImpl: FetchFn = fetch,
  appVersion: string = DEFAULT_APP_VERSION,
  identity?: ProxyIdentity,
): Promise<QuotaResult> {
  const fetchWithTimeout = withTimeout(fetchImpl);
  const plan = cred.plan ?? "coding-plan";
  // Real-client header set: explicit identity wins; otherwise synthesize one
  // from the appVersion param (with the same defaults config.loader applies)
  // so even legacy callers send a plausible UA.
  const effectiveIdentity: ProxyIdentity = identity ?? {
    appVersion,
    sourceTitle: "cli",
    refererOrigin: "https://zcode.z.ai",
  };
  const identityHeaders = buildIdentityHeaders(effectiveIdentity);

  if (plan === "start-plan" && cred.jwt?.trim()) {
    return queryStartPlan(cred, fetchWithTimeout, appVersion, identityHeaders);
  }
  return queryCodingPlan(cred, fetchWithTimeout, identityHeaders);
}

/** start-plan path: billing/balance first, then billing/current as legacy fallback. */
async function queryStartPlan(
  cred: Credential,
  fetchImpl: FetchFn,
  appVersion: string,
  identityHeaders: Record<string, string>,
): Promise<QuotaResult> {
  const base: QuotaResult = {
    plan: "start-plan",
    provider: cred.provider,
    remaining: null,
    planName: null,
    expireTime: null,
    limits: [],
  };

  // Full client header set (UA/X-ZCode-App-Version/…) + the plan JWT. The
  // desktop client's billing calls carry its standard identity headers; a
  // bare Authorization-only request is a fingerprint mismatch.
  const headers = { ...identityHeaders, Authorization: normalizeBearerHeader(cred.jwt!) };

  // ZCode 3.2.5 probes start-plan entitlement through billing/balance.
  const balanceUrl = `${ZCODE_PLAN_BASE}/billing/balance?app_version=${encodeURIComponent(appVersion)}`;
  let balance: any;
  let balanceOk = false;
  try {
    balance = await fetchJson(fetchImpl, balanceUrl, headers);
    balanceOk = balance?.code === 0;
  } catch {
    balanceOk = false;
  }

  if (balance && !balanceOk) {
    return { ...base, unavailableReason: "unavailable", raw: balance };
  }

  // New response shape: billing/balance includes plans + balances.
  // Old response shape: billing/balance only includes balances, so fall back to
  // billing/current for the active plan metadata.
  let current: any;
  const balanceHasPlans = Array.isArray(balance?.data?.plans);
  let activePlan = pickActiveStartPlan(balance?.data?.plans);
  if (!activePlan && balanceHasPlans) {
    return { ...base, unavailableReason: "no_plan", raw: balance };
  }
  if (!activePlan) {
    const currentUrl = `${ZCODE_PLAN_BASE}/billing/current?app_version=${encodeURIComponent(appVersion)}`;
    try {
      current = await fetchJson(fetchImpl, currentUrl, headers);
    } catch {
      return { ...base, unavailableReason: "unavailable", raw: balance };
    }
    if (current?.code !== 0) {
      return { ...base, unavailableReason: "unavailable", raw: { balance, current } };
    }
    activePlan = pickActiveStartPlan(current?.data?.plans);
    if (!activePlan) {
      return { ...base, unavailableReason: "no_plan", raw: { balance, current } };
    }
  }

  if (!balanceOk) {
    // current worked but balance failed — still report the plan, no remaining.
    return {
      ...base,
      planName: activePlan.name ?? null,
      expireTime: activePlan.ends_at ?? null,
      unavailableReason: "unavailable",
      raw: current,
    };
  }
  const limits = mapStartPlanBalances(balance?.data?.balances);
  const remaining = aggregateRemaining(limits);

  return {
    ...base,
    remaining,
    planName: activePlan.name ?? null,
    expireTime: activePlan.ends_at ?? null,
    limits,
    raw: current ? { balance, current } : { balance },
  };
}

/** coding-plan path: /api/monitor/usage/quota/limit against the provider host. */
async function queryCodingPlan(
  cred: Credential,
  fetchImpl: FetchFn,
  identityHeaders: Record<string, string>,
): Promise<QuotaResult> {
  const base: QuotaResult = {
    plan: "coding-plan",
    provider: cred.provider,
    remaining: null,
    planName: null,
    expireTime: null,
    limits: [],
  };

  const auth = credentialString(cred);
  const host = getProvider(cred.provider).bizHost;
  const url = `${host}/api/monitor/usage/quota/limit`;

  let body: any;
  try {
    body = await fetchJson(fetchImpl, url, { ...identityHeaders, authorization: auth });
  } catch {
    return { ...base, unavailableReason: "unavailable" };
  }

  // Upstream signals success via code 200 + a truthy `data`. A `msg` hinting
  // the account has no coding-plan entitlement maps to no_plan.
  const success = body?.code === 200 && body?.success !== false;
  if (isNoPlanMessage(body?.msg)) {
    return { ...base, unavailableReason: "no_plan", raw: body };
  }
  if (!success || !body?.data) {
    return { ...base, unavailableReason: "unavailable", raw: body };
  }

  const limits = mapCodingPlanLimits(body?.data?.limits);
  const remaining = aggregateRemaining(limits);

  return {
    ...base,
    remaining,
    planName: body?.data?.level ? String(body.data.level) : null,
    limits,
    raw: body,
  };
}

async function fetchJson(
  fetchImpl: FetchFn,
  url: string,
  headers: Record<string, string>,
): Promise<any> {
  const resp = await fetchImpl(url, { method: "GET", headers });
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`quota request ${url} failed: ${resp.status}`);
  }
  return readJsonLimited(resp);
}

function normalizeBearerHeader(token: string): string {
  const trimmed = token.trim();
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/** Pick the active start-plan entry whose name/id reads as a start plan. */
function pickActiveStartPlan(plans: any[]): any | null {
  if (!Array.isArray(plans)) return null;
  const isActive = (p: any) => String(p?.status ?? "").toLowerCase() === "active";
  const isStart = (p: any) => {
    const name = String(p?.name ?? p?.plan_name ?? "").toLowerCase();
    const id = String(p?.plan_id ?? p?.user_plan_id ?? p?.id ?? "").toLowerCase();
    if (!name && !id) return true;
    const text = `${id} ${name}`.replace(/_/g, "-");
    return text.includes("start-plan") || text.includes("start plan");
  };
  return plans.find((p) => isActive(p) && isStart(p)) ?? null;
}

/** Map start-plan balance entries to normalized limits. */
function mapStartPlanBalances(balances: any): QuotaLimit[] {
  if (!Array.isArray(balances)) return [];
  return balances
    .map((b: any): QuotaLimit | null => {
      const total = toNumber(b?.total_units);
      const used = toNumber(b?.used_units);
      const remaining = toNumber(b?.remaining_units);
      const label = b?.show_name ?? b?.entitlement_id ?? b?.meter;
      const nextResetTime = toNumber(b?.period_end) ?? toNumber(b?.expires_at) ?? null;
      return {
        type: b?.entitlement_id ? String(b.entitlement_id) : label ? String(label) : "balance",
        label: label != null ? String(label) : undefined,
        remaining,
        total,
        used,
        unit: "units",
        nextResetTime,
      };
    })
    .filter((x): x is QuotaLimit => x !== null);
}

/** Map coding-plan limits[] to normalized limits. */
function mapCodingPlanLimits(limits: any): QuotaLimit[] {
  if (!Array.isArray(limits)) return [];
  return limits
    .filter((l: any) => typeof l?.type === "string" && l.type.length > 0)
    .map((l: any): QuotaLimit => ({
      type: String(l.type),
      label: l.type === "TIME_LIMIT" ? "时长额度" : String(l.type),
      remaining: toNumber(l.remaining),
      total: toNumber(l.number),
      used: toNumber(l.usage),
      unit: typeof l.unit === "number" ? String(l.unit) : undefined,
      nextResetTime: toNumber(l.nextResetTime) ?? null,
    }));
}

/** Sum remaining/total across limits for an aggregate figure. */
function aggregateRemaining(limits: QuotaLimit[]): QuotaResult["remaining"] {
  const withTotals = limits.filter(
    (l) => typeof l.remaining === "number" && typeof l.total === "number",
  );
  if (withTotals.length === 0) return null;
  const total = withTotals.reduce((s, l) => s + (l.total ?? 0), 0);
  const count = withTotals.reduce((s, l) => s + (l.remaining ?? 0), 0);
  return {
    count,
    total,
    percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
  };
}
