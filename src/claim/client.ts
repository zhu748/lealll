/**
 * HTTP client for ZCode's manual-claim billing endpoints (weekend plans).
 *
 * Mirrors the ZCode 3.15.3 desktop client's `getManualClaimPlanPreviews` /
 * `claimManualPlan` (host `BigModelCodingPlanSubscriptionProvider`) — since
 * 3.15.3 every request to the ZCode endpoint origin goes through the
 * apiClient's `withZCodeEndpointHeaders` merge: a base identity set
 * (`buildZCodeSourceHeaders` — the `Fen` context shape with X-Device-Mid from
 * telemetry-state) is laid down first and the caller's headers override/
 * append on top. This proxy mirrors that merge via the `identityHeaders`
 * option (built by `buildIdentityHeaders`):
 *
 *   - `GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=`
 *     headers: identity base + `Authorization: Bearer {jwt}` (omitted when
 *     anonymous)
 *   - `POST {origin}/api/v1/zcode-plan/billing/claim`  body `{plan_id}`
 *     headers: identity base + Authorization, Content-Type,
 *     X-Aliyun-Captcha-Verify-Param, [X-Aliyun-Captcha-Verify-Region],
 *     X-ZCode-App-Version, X-Platform (the last two override their base
 *     positions — object-spread keeps overridden keys in place, matching
 *     `Headers.set` semantics in the bundle)
 *
 * HISTORY: 3.12.3 sent a minimal header set on this plane; the 0828/0918
 * campaign gateways empirically required a UUID `X-Device-Mid` (biz 3001
 * "parameter error" without it) — a documented deviation then, and exactly
 * what 3.15.3 now does officially (full identity base incl. X-Device-Mid).
 * The `deviceMid` option keeps the billing-mid resolution (env → config →
 * ephemeral) authoritative for the X-Device-Mid position.
 *
 * @see _reverse/NOTEPAD.md "claim/billing 平面"
 */
import type { ClaimablePlan, ClaimOutcome, PlanEntitlement } from "./types.js";
import { classifyClaimCode } from "./types.js";
import { hostSetTimeout, hostClearTimeout } from "../utils/host-timers.js";

export interface ClaimClientOptions {
  origin: string;
  /** OAuth JWT (`zcodejwttoken`); preview works without it, claim does not. */
  jwt?: string;
  appVersion: string;
  /** `${process.platform}-{arch}` in the real client (`u3()`). */
  platform: string;
  /**
   * 3.15.3 `withZCodeEndpointHeaders` base identity set (the `Fen`/context
   * shape from `buildIdentityHeaders`). Merged under the caller headers so
   * preview/claim carry the full official fingerprint. When omitted the
   * calls fall back to the minimal legacy header set (tests / old callers).
   */
  identityHeaders?: Record<string, string>;
  /**
   * Billing-gateway deviceMid (env → config → ephemeral). Overrides the
   * identity base's X-Device-Mid position when both exist.
   */
  deviceMid?: string;
  /** Per-call timeout in ms. Default `15000` (bundle `ss`). */
  timeoutMs?: number;
  /** DI seam for tests. Default `globalThis.fetch`. */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface ClaimClient {
  getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  claim(planId: string, captcha: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Preview failure with the HTTP status preserved (404 = campaign not deployed yet). */
export class ClaimPreviewError extends Error {
  readonly status: number;
  readonly code: number | string;
  constructor(message: string, status: number, code: number | string) {
    super(message);
    this.name = "ClaimPreviewError";
    this.status = status;
    this.code = code;
  }
}

interface RawEntitlement {
  entitlement_id?: string;
  show_name?: string;
  meter?: string;
  unit_type?: string;
  capabilities?: string[];
  grant_units?: number;
  period?: string;
  priority?: number;
  effective_at?: number;
}

interface RawClaimedPlan {
  user_plan_id?: string;
  plan_id?: string;
  status?: string;
  starts_at?: number;
  ends_at?: number;
  entitlements?: Array<{ entitlement_id?: string; show_name?: string; effective_at?: number }>;
}

interface RawPlan {
  plan_id?: string;
  name?: string;
  description?: string;
  priority?: number;
  entitlements?: RawEntitlement[];
  starts_at?: number;
  ends_at?: number;
}

export function createClaimClient(opts: ClaimClientOptions): ClaimClient {
  const origin = opts.origin.replace(/\/+$/, "");
  const jwt = opts.jwt?.trim() || undefined;
  const identityBase = opts.identityHeaders;
  const deviceMid = opts.deviceMid?.trim() || undefined;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  /**
   * 3.15.3 `withZCodeEndpointHeaders` (`gAe`): base identity set first, then
   * the caller's headers override/append — object spread keeps overridden
   * keys at their base positions, matching the bundle's `Headers.set`
   * semantics. The billing deviceMid (env → config → ephemeral) stays
   * authoritative for the X-Device-Mid position.
   */
  function mergeHeaders(caller: Record<string, string>): Record<string, string> {
    const merged: Record<string, string> = { ...identityBase, ...caller };
    if (deviceMid) merged["X-Device-Mid"] = deviceMid;
    return merged;
  }

  function parseEntitlement(c: RawEntitlement): PlanEntitlement | null {
    const entitlementId = c.entitlement_id?.trim() ?? "";
    if (!entitlementId) return null;
    const e: PlanEntitlement = {
      entitlementId,
      showName: c.show_name?.trim() ?? "",
      meter: c.meter?.trim() ?? "",
      unitType: c.unit_type?.trim() ?? "",
      capabilities: Array.isArray(c.capabilities) ? c.capabilities : [],
      grantUnits: Number.isFinite(c.grant_units) ? (c.grant_units as number) : 0,
      period: c.period?.trim() ?? "",
      priority: Number.isFinite(c.priority) ? (c.priority as number) : 0,
    };
    if (Number.isFinite(c.effective_at)) e.effectiveAt = c.effective_at as number;
    return e;
  }

  function parsePlan(p: RawPlan): ClaimablePlan | null {
    const planId = p.plan_id?.trim() ?? "";
    if (!planId) return null;
    const plan: ClaimablePlan = {
      planId,
      name: p.name?.trim() || planId,
      description: p.description?.trim() ?? "",
      priority: Number.isFinite(p.priority) ? (p.priority as number) : 0,
      entitlements: (p.entitlements ?? []).flatMap((c) => {
        const e = parseEntitlement(c);
        return e ? [e] : [];
      }),
    };
    if (Number.isFinite(p.starts_at)) plan.startsAt = p.starts_at as number;
    if (Number.isFinite(p.ends_at)) plan.endsAt = p.ends_at as number;
    return plan;
  }

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ status: number; json: Record<string, unknown> | undefined; text: string }> {
    const controller = new AbortController();
    // Host-safe timer (see utils/host-timers.ts): claim calls run concurrently
    // with captcha solve epochs.
    const timer = hostSetTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let resp: Response;
    try {
      resp = await fetchImpl(`${origin}${path}`, {
        method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await resp.text();
      let json: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
      } catch { /* non-JSON body surfaced via text */ }
      return { status: resp.status, json, text };
    } finally {
      hostClearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function unwrapError(json: Record<string, unknown> | undefined, status: number, text: string): { code: number | string; message: string } {
    const code = json?.code !== undefined ? (json.code as number | string) : status >= 400 ? status : -1;
    const rawMsg = json?.msg ?? json?.message;
    const message = typeof rawMsg === "string" && rawMsg.trim() ? rawMsg.trim() : text.length > 0 && text.length < 200 ? text : `HTTP ${status}`;
    return { code, message };
  }

  return {
    async getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      const url = `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(opts.appVersion)}&platform=${encodeURIComponent(opts.platform)}`;
      // 3.15.3: identity base + `Authorization: Bearer` only when a JWT
      // exists; anonymous preview carries just the identity base.
      const headers = mergeHeaders(jwt ? { Authorization: `Bearer ${jwt}` } : {});
      const { status, json, text } = await request("GET", url, { headers, signal });
      // `data === null` (a {code:0,data:null} envelope) must surface as a
      // structured ClaimPreviewError — the old `=== undefined` check let null
      // through and `data.plans` then threw a bare TypeError.
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined || json?.data === null) {
        const { code, message } = unwrapError(json, status, text);
        throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code);
      }
      const data = json.data as { plans?: RawPlan[] };
      return (data.plans ?? []).flatMap((p) => {
        const plan = parsePlan(p);
        return plan ? [plan] : [];
      });
    },

    async claim(planId: string, captcha: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome> {
      if (!jwt) return { ok: false, planId, failureKind: "login_required", code: 401, message: "manual_claim_login_required" };
      // 3.15.3 `claimManualPlan`: caller set = Authorization, Content-Type,
      // captcha param, [captcha region], X-ZCode-App-Version, X-Platform —
      // merged over the identity base (version/platform override their base
      // positions; the rest append after the base keys).
      const headers = mergeHeaders({
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-Aliyun-Captcha-Verify-Param": captcha.verifyParam,
      });
      if (captcha.region) headers["X-Aliyun-Captcha-Verify-Region"] = captcha.region;
      headers["X-ZCode-App-Version"] = opts.appVersion;
      headers["X-Platform"] = opts.platform;
      const { status, json, text } = await request("POST", "/api/v1/zcode-plan/billing/claim", { body: { plan_id: planId }, headers, signal });

      const data = json?.data as { plan?: RawPlan | RawClaimedPlan } | undefined;
      const bizCode = json?.code !== undefined ? (json.code as number) : undefined;
      const plan = data?.plan;
      if (status >= 200 && status < 300 && bizCode === 0 && plan) {
        // 3.14.4 echoes the claimed plan with user_plan_id/status/entitlements;
        // older campaigns returned bare starts_at/ends_at — accept both.
        const claimed = plan as RawClaimedPlan;
        const out: ClaimOutcome = { ok: true, planId };
        if (Number.isFinite(plan.starts_at)) out.startsAt = plan.starts_at as number;
        if (Number.isFinite(plan.ends_at)) out.endsAt = plan.ends_at as number;
        if (typeof claimed.user_plan_id === "string" && claimed.user_plan_id.trim()) {
          out.userPlanId = claimed.user_plan_id.trim();
        }
        if (typeof claimed.status === "string" && claimed.status.trim()) {
          out.status = claimed.status.trim();
        }
        const grants = Array.isArray(claimed.entitlements)
          ? claimed.entitlements.flatMap((e) => {
              const id = e?.entitlement_id?.trim() ?? "";
              if (!id) return [];
              const g: { entitlementId: string; showName: string; effectiveAt?: number } = {
                entitlementId: id,
                showName: e.show_name?.trim() ?? "",
              };
              if (Number.isFinite(e?.effective_at)) g.effectiveAt = e.effective_at as number;
              return [g];
            })
          : [];
        if (grants.length > 0) out.entitlements = grants;
        return out;
      }
      const { code, message } = unwrapError(json, status, text);
      const failureEndsAt = Number.isFinite(plan?.ends_at) ? (plan?.ends_at as number) : undefined;
      const httpDerived = status >= 400 && bizCode === undefined;
      return {
        ok: false,
        planId,
        failureKind: httpDerived ? (status === 401 ? "login_required" : "http_error") : classifyClaimCode(code),
        code,
        message,
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
      };
    },
  };
}
