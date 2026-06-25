/**
 * Upstream quota / balance query.
 *
 * Reverses the ZCode desktop client's `BigModelUsageQuotaProvider` (from
 * app.asar out/host/index.js) to read a credential's remaining quota without
 * going through the LLM gateway. Two distinct upstreams:
 *
 * - **start-plan** (zcode.z.ai, authenticates with the plan JWT):
 *     GET /api/v1/zcode-plan/billing/current  -> active plan + ends_at
 *     GET /api/v1/zcode-plan/billing/balance  -> total/used/remaining units
 *   Both require an `app_version` query param and `Authorization: <jwt>` (raw
 *   JWT, NO "Bearer" prefix — the client stores it as `zcodejwttoken`). Note
 *   this differs from upstream.ts which sends `Bearer {jwt}` to the LLM
 *   gateway; the billing API wants the bare token.
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

const ZCODE_PLAN_BASE = "https://zcode.z.ai/api/v1/zcode-plan";
// MUST match a real ZCode desktop-client version. The billing/current endpoint
// uses app_version as a gate for first-time start-plan trial activation: a low
// version (e.g. the old "2.0.0") does NOT activate the trial, while a current
// client version (3.1.x) does. Using "2.0.0" here meant lealll's quota query
// never activated a fresh account's start-plan — it returned {plans:[]} forever.
// Verified end-to-end 2026-06-25: same jwt, app_version=2.0.0 -> empty;
// app_version=3.1.5 -> instant activation. Activation is irreversible, so the
// version only matters on the first successful query.
const DEFAULT_APP_VERSION = "3.1.5";
const REQUEST_TIMEOUT_MS = 15_000;

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
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    return fetchImpl(input, { ...init, signal: ctrl.signal }).finally(() =>
      clearTimeout(timer),
    );
  }) as FetchFn;
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
 *                   client. Defaults to DEFAULT_APP_VERSION ("3.1.5").
 */
export async function queryQuota(
  cred: Credential,
  fetchImpl: FetchFn = fetch,
  appVersion: string = DEFAULT_APP_VERSION,
): Promise<QuotaResult> {
  const fetchWithTimeout = withTimeout(fetchImpl);
  const plan = cred.plan ?? "coding-plan";

  if (plan === "start-plan" && cred.jwt) {
    return queryStartPlan(cred, fetchWithTimeout, appVersion);
  }
  return queryCodingPlan(cred, fetchWithTimeout);
}

/** start-plan path: billing/current + billing/balance against zcode.z.ai. */
async function queryStartPlan(
  cred: Credential,
  fetchImpl: FetchFn,
  appVersion: string,
): Promise<QuotaResult> {
  const base: QuotaResult = {
    plan: "start-plan",
    provider: cred.provider,
    remaining: null,
    planName: null,
    expireTime: null,
    limits: [],
  };

  const headers = { Authorization: cred.jwt! };

  // billing/current — active plan + expiry
  const currentUrl = `${ZCODE_PLAN_BASE}/billing/current?app_version=${encodeURIComponent(appVersion)}`;
  let current: any;
  try {
    current = await fetchJson(fetchImpl, currentUrl, headers);
  } catch {
    return { ...base, unavailableReason: "unavailable" };
  }
  if (current?.code !== 0) {
    return { ...base, unavailableReason: "unavailable", raw: current };
  }
  const activePlan = pickActiveStartPlan(current?.data?.plans);
  if (!activePlan) {
    return { ...base, unavailableReason: "no_plan", raw: current };
  }

  // billing/balance — total/used/remaining units
  const balanceUrl = `${ZCODE_PLAN_BASE}/billing/balance?app_version=${encodeURIComponent(appVersion)}`;
  let balance: any;
  try {
    balance = await fetchJson(fetchImpl, balanceUrl, headers);
  } catch {
    // current worked but balance failed — still report the plan, no remaining.
    return {
      ...base,
      planName: activePlan.name ?? null,
      expireTime: activePlan.ends_at ?? null,
      unavailableReason: "unavailable",
      raw: current,
    };
  }
  if (balance?.code !== 0) {
    return {
      ...base,
      planName: activePlan.name ?? null,
      expireTime: activePlan.ends_at ?? null,
      unavailableReason: "unavailable",
      raw: { current, balance },
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
    raw: { current, balance },
  };
}

/** coding-plan path: /api/monitor/usage/quota/limit against the provider host. */
async function queryCodingPlan(
  cred: Credential,
  fetchImpl: FetchFn,
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
    body = await fetchJson(fetchImpl, url, { authorization: auth });
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
    throw new Error(`quota request ${url} failed: ${resp.status}`);
  }
  return resp.json();
}

/** Pick the active start-plan entry whose name/id reads as a start plan. */
function pickActiveStartPlan(plans: any[]): any | null {
  if (!Array.isArray(plans)) return null;
  const isActive = (p: any) => String(p?.status ?? "").toLowerCase() === "active";
  const isStart = (p: any) => {
    const name = String(p?.name ?? "").toLowerCase();
    const id = String(p?.plan_id ?? p?.user_plan_id ?? "").toLowerCase();
    return name.includes("start") || id.includes("start");
  };
  return plans.find((p) => isActive(p) && isStart(p)) ?? plans.find(isActive) ?? null;
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
