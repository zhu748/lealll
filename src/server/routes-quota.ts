/**
 * GET /quota — live quota snapshot from both upstream quota planes.
 *
 * Two planes, mirroring the official desktop panel's split (`getSnapshotForRequest`):
 *  - credits plane: `zcode-plan/billing/balance` + `billing/preview` on the
 *    configured claim origin with the stored OAuth plan JWT and the desktop
 *    identity fingerprint (start-plan/trial credit buckets);
 *  - coding plane: `GET {coding origin}/api/monitor/usage/quota/limit` with the
 *    stored coding-plan API key in `authorization` (bundle `wK`/`Z_`+`md`) —
 *    the windowed usage limits of individual coding plans (`data.limits[]`,
 *    `TIME_LIMIT` rows preferred by the official `Xj` picker).
 *
 * The billing gateway requires a UUID `X-Device-Mid`: the config identity is
 * forwarded with resolveBillingDeviceMid applied (env > config > ephemeral
 * per-process fallback) so read-only / env-only deployments still pass the
 * gateway's device check.
 *
 * @see _reverse/NOTEPAD.md "coding-plan 用量平面" (chain extracted from
 *      zcode.z.ai desktop bundle `getSnapshotForQuery`/`BigModelUsageQuotaProvider`)
 */
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { resolveConfiguredCredential } from "../auth/selection.js";
import { JsonHttpError } from "../utils/fetch-json.js";
import { readJsonLimited } from "../auth/quota.js";
import { hostSetTimeout, hostClearTimeout } from "../utils/host-timers.js";
import { proxiedFetch } from "../proxy/proxied-fetch.js";
import { loadCredential } from "../auth/store.js";
import { buildIdentityHeaders, normalizePrintableHeaderValue, resolveBillingDeviceMid } from "../proxy/identity.js";
import { inspectJwt } from "../auth/jwt-age.js";
import { credentialString, type Credential } from "../auth/types.js";
import { createResetClient, DEFAULT_RESET_ORIGIN, normalizeResetType, type ResetStatus, type ResetType } from "../auth/reset.js";
import { createClaimClient, ClaimPreviewError } from "../claim/client.js";
import type { ClaimablePlan, ClaimOutcome } from "../claim/types.js";
import { getCaptchaToken } from "../proxy/captcha.js";
import type { ProxyConfig } from "../config/types.js";
import { errorResponse } from "../proxy/handler.js";
import { fetchMcpUsage, type McpUsageSnapshot } from "../auth/mcp-quota.js";
import { fetchSubscriptionAvailability, type SubscriptionAvailability } from "../auth/subscription.js";

export interface QuotaBalanceEntry {
  showName: string;
  remainingUnits: number;
  totalUnits: number;
  usedUnits: number;
  unitType?: string;
  expiresAt?: number;
}

export interface QuotaPlanEntry {
  planId: string;
  name: string;
  description?: string;
  entitlements: Array<{
    showName: string;
    grantUnits: number;
    unitType: string;
    /** Grant recurrence — 3.14.4 adds "daily" | "one_time" (banner subtitle). */
    period?: string;
    effectiveAt?: number;
  }>;
}

/**
 * One usage window from the coding-plan monitor plane (`limits[]` entry).
 * `type` values are server-defined; `TIME_LIMIT` (the 5h/weekly prompt window
 * of individual coding plans) is the shape the official panel prefers.
 */
export interface QuotaCodingLimit {
  type: string;
  unit?: string;
  /** Upstream `number` — window total (undefined = unlimited/unreported). */
  total?: number;
  /** Upstream `usage`. */
  used?: number;
  remaining?: number;
  percentage?: number;
  /** Epoch seconds or milliseconds, as upstream sends it (both seen in the wild). */
  nextResetTime?: number;
}

export interface QuotaCodingPlan {
  /** Plan tier string from upstream (e.g. `"max"`); null when unreported. */
  level: string | null;
  limits: QuotaCodingLimit[];
}

export interface QuotaSnapshot {
  provider: string;
  serverTime: number;
  /**
   * Stored start-plan JWT age (informational). The token has no `exp` and is
   * not rejected by age — an 8-day-old JWT still serves billing/balance. Only
   * a real 401/3012 from the billing gateway indicates re-login is needed,
   * which surfaces in `errors`.
   */
  jwt: { ageHours: number; issuedAt: number } | null;
  balances: QuotaBalanceEntry[];
  claimablePlans: QuotaPlanEntry[];
  /**
   * Coding-plan monitor plane snapshot; null when the endpoint failed or was
   * unreachable — the official panel tolerates the same way (quota: null).
   */
  codingPlan: QuotaCodingPlan | null;
  /**
   * MCP gateway usage snapshot (3.14.4 `yme`/`fetchMcpQuotaSnapshot` plane).
   * Null when the credential has no coding-plan JWT or the endpoint failed
   * — the official panel tolerates the same way (usage: null).
   *
   * Introduced in v4.7.5-fork.1 (desktop 3.14.4 alignment, supplemental).
   */
  mcpUsage?: McpUsageSnapshot | null;
  /**
   * Coding-plan subscription availability (3.14.4 `nfe`/`validateCodingPlanProviderAvailability`
   * plane). Returns `{kind:'unknown'|'available'|'unavailable', count}`.
   * `kind:'unknown'` is fail-open for transient errors (do not skip account
   * in failover loop).
   *
   * Introduced in v4.7.5-fork.1 (desktop 3.14.4 alignment, supplemental).
   */
  subscriptionAvailability?: SubscriptionAvailability | null;
  errors: string[];
}

/** Per-call timeout + byte cap for billing envelope fetches. */
const BILLING_TIMEOUT_MS = 15_000;
const BILLING_MAX_BYTES = 1024 * 1024;

async function fetchBilling(
  origin: string,
  path: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ code?: number; msg?: string; data?: unknown; success?: unknown } | null> {
  const url = `${origin.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = hostSetTimeout(() => controller.abort(), BILLING_TIMEOUT_MS);
  timer.unref?.();
  try {
    const resp = await fetchImpl(url, { headers, signal: controller.signal });
    if (resp.ok) {
      return await readJsonLimited(resp, BILLING_MAX_BYTES, BILLING_TIMEOUT_MS, controller.signal);
    }
    // The billing plane answers errors with a JSON envelope (e.g. HTTP 400 +
    // {"code":3001,"msg":"parameter error"}). The generic fetchJsonWithDeadline
    // throws before reading the body, which masked every 3001 as an opaque
    // "HTTP 400" in the TUI/panel — surface the real code/msg instead.
    const errEnvelope = await readJsonLimited(resp, BILLING_MAX_BYTES, BILLING_TIMEOUT_MS, controller.signal).catch(() => null);
    const code = typeof errEnvelope?.code === "number" ? errEnvelope.code : resp.status;
    const msg = typeof errEnvelope?.msg === "string" && errEnvelope.msg.trim() ? errEnvelope.msg.trim() : `HTTP ${resp.status}`;
    return { code, msg };
  } catch (e) {
    return { code: e instanceof JsonHttpError ? e.status : -1, msg: String(e).slice(0, 120) };
  } finally {
    hostClearTimeout(timer);
  }
}

/** Mirror of the bundle's `$_` (isSuccessfulBigModelEnvelope): `success !== false` and code absent/0/200. */
function isSuccessfulEnvelope(e: { code?: number; success?: unknown }): boolean {
  return e.success !== false && (e.code === undefined || e.code === 0 || e.code === 200);
}

/** Coding origin per stored credential's provider — `https://api.z.ai` / `https://open.bigmodel.cn`. */
function codingOrigin(config: ProxyConfig, provider: Credential["provider"]): string | null {
  try {
    return new URL(config.providers[provider].openaiBase).origin;
  } catch {
    return null;
  }
}

/** Normalize one upstream limit entry; rows without any usable number are display noise and dropped. */
function parseCodingLimit(e: any): QuotaCodingLimit | null {
  if (typeof e?.type !== "string" || e.type.trim() === "") return null;
  const total = toFiniteNumber(e.number);
  const used = toFiniteNumber(e.usage);
  const remaining = toFiniteNumber(e.remaining);
  if (total === undefined && used === undefined && remaining === undefined) return null;
  const pct = toFiniteNumber(e.percentage);
  const reset = toFiniteNumber(e.next_reset_time ?? e.nextResetTime);
  const unit = typeof e.unit === "string" && e.unit.trim() !== "" ? e.unit : undefined;
  return {
    type: e.type.trim(),
    ...(unit ? { unit } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(pct !== undefined ? { percentage: pct } : {}),
    ...(reset !== undefined ? { nextResetTime: reset } : {}),
  };
}

/** Coerce an upstream value to a finite number, or undefined (never NaN — JSON.stringify would emit null). */
function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const quotaInFlight = new WeakMap<typeof fetch, Map<string, Promise<QuotaSnapshot>>>();

/** Identical concurrent refreshes share work; completed snapshots are never cached. */
export async function collectQuotaSnapshot(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<QuotaSnapshot> {
  config = structuredClone(config);
  const cred = await resolveConfiguredCredential(config, loadCredentialImpl);
  if (!cred) throw new Error("not logged in or no usable credential for the configured provider");
  const key = createHash("sha256").update(JSON.stringify([
    cred, config.provider, config.plan, config.providers, config.claim.origin,
    config.identity, config.mcp.usageEnabled, config.subscription?.checkOnSwitch,
  ])).digest("hex");
  let requests = quotaInFlight.get(fetchImpl);
  if (!requests) { requests = new Map(); quotaInFlight.set(fetchImpl, requests); }
  const existing = requests.get(key);
  if (existing) return existing;
  const transport = cred.proxy
    ? ((input, init) => proxiedFetch(input, { ...init, proxy: cred.proxy }, fetchImpl)) as typeof fetch
    : fetchImpl;
  const pending = buildQuotaSnapshot(config, cred, transport);
  requests.set(key, pending);
  try { return await pending; }
  finally { if (requests.get(key) === pending) requests.delete(key); }
}

async function buildQuotaSnapshot(config: ProxyConfig, cred: Credential, fetchImpl: typeof fetch): Promise<QuotaSnapshot> {
  const jwtInfo = cred.jwt ? inspectJwt(cred.jwt) : null;
  const jwt = jwtInfo
    ? { ageHours: Number(jwtInfo.ageHours.toFixed(2)), issuedAt: jwtInfo.iat }
    : null;
  const identity = {
    ...config.identity,
    // Billing gateway rejects device-mid-less balance calls (3001); fall back
    // to an ephemeral per-process mid when config/env have none.
    deviceMid: resolveBillingDeviceMid(config.identity.deviceMid),
  };
  const idHeaders = buildIdentityHeaders(identity);
  // The claim client drops X-ZCode-Agent for zcode.z.ai control-plane calls;
  // the billing gateway follows the same precedent.
  delete idHeaders["X-ZCode-Agent"];
  const headers: Record<string, string> = { ...idHeaders, authorization: `Bearer ${cred.jwt}`, Accept: "application/json" };
  // Billing fingerprint is reconstructed from the observed claim-client format
  // (`${platform}-${arch}`). Reuses identity.ts's env-override normalization
  // (same ZCODE_IDENTITY_PLATFORM/ARCH overrides the proxy headers use —
  // Android seeds linux-x64 via index.ts); empty or non-printable overrides
  // fall back to the real values — an empty override must not yield
  // `-x64`/`linux-`.
  // NOTE: ProxyIdentity has no platform/arch fields — do not read them off `identity`.
  const platform = `${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM) ?? process.platform}-${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH) ?? os.arch()}`;
  const origin = config.claim.origin || "https://zcode.z.ai";
  const appVersion = identity.appVersion;

  const errors: string[] = [];
  // Credits plane needs the plan JWT; a coding-plan account without one still
  // gets its monitor-plane limits below instead of a dead snapshot.
  const cOrigin = codingOrigin(config, cred.provider);
  const [balance, preview, cEnvelope, mcpUsage, subscriptionAvailability] = await Promise.all([
    // billing/balance carries app_version ONLY on the 3.14.4 client
    // (buildZaiStartPlanBalanceUrl); the extra &platform= the older snapshot
    // sent is a fingerprint mismatch against that bundle.
    cred.jwt ? fetchBilling(origin, `/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}`, headers, fetchImpl) : null,
    cred.jwt ? fetchBilling(origin, `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl) : null,
    cOrigin ? fetchBilling(cOrigin, "/api/monitor/usage/quota/limit", { authorization: credentialString(cred), accept: "application/json" }, fetchImpl) : null,
    config.mcp.usageEnabled === false ? null : fetchMcpUsage(cred, { origin, fetchImpl, identity }).catch(() => null),
    config.subscription?.checkOnSwitch === false ? null : fetchSubscriptionAvailability(cred, { fetchImpl, identity, origin: config.subscription?.origin, timeoutMs: config.subscription?.timeoutMs }).catch(() => null),
  ]);
  if (cred.jwt) {
    if (balance && !isSuccessfulEnvelope(balance)) errors.push(`balance: ${balance.code} ${balance.msg ?? ""}`.trim());
    if (preview && !isSuccessfulEnvelope(preview)) errors.push(`preview: ${preview.code} ${preview.msg ?? ""}`.trim());
  } else errors.push("balance: no plan JWT — credits plane unavailable (re-login to capture it)");
  let codingPlan: QuotaCodingPlan | null = null;
  if (cOrigin) {
    if (cEnvelope && isSuccessfulEnvelope(cEnvelope)) {
      const d = (cEnvelope.data ?? {}) as { level?: unknown; limits?: unknown };
      codingPlan = {
        level: typeof d.level === "string" && d.level.trim() !== "" ? d.level.trim() : null,
        limits: (Array.isArray(d.limits) ? d.limits : []).map(parseCodingLimit).filter((l): l is QuotaCodingLimit => l !== null),
      };
    } else errors.push(`coding: ${cEnvelope ? `${cEnvelope.code} ${cEnvelope.msg ?? ""}`.trim() : "request failed"}`);
  }

  const balances: QuotaBalanceEntry[] = [];
  const balanceData = (balance?.data ?? {}) as { balances?: any[]; server_time?: number };
  for (const b of Array.isArray(balanceData.balances) ? balanceData.balances : []) {
    // unitType/expiresAt camelCase aliases observed live alongside snake_case;
    // accept both so neither casing drops the field.
    const expiresAt = toFiniteNumber(b.expires_at ?? b.expiresAt);
    const unitType = b.unit_type ?? b.unitType;
    balances.push({
      showName: String(b.show_name ?? ""),
      remainingUnits: toFiniteNumber(b.remaining_units ?? b.remainingUnits) ?? 0,
      totalUnits: toFiniteNumber(b.total_units ?? b.totalUnits) ?? 0,
      usedUnits: toFiniteNumber(b.used_units ?? b.usedUnits) ?? 0,
      ...(unitType ? { unitType: String(unitType) } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  }

  const claimablePlans: QuotaPlanEntry[] = [];
  const previewData = (preview?.data ?? {}) as { plans?: any[] };
  for (const p of Array.isArray(previewData.plans) ? previewData.plans : []) {
    claimablePlans.push({
      planId: String(p.plan_id ?? ""),
      name: String(p.name ?? p.plan_id ?? ""),
      ...(p.description ? { description: String(p.description) } : {}),
      entitlements: (Array.isArray(p.entitlements) ? p.entitlements : []).map((e: any) => ({
        showName: String(e.show_name ?? ""),
        grantUnits: toFiniteNumber(e.grant_units ?? e.grantUnits) ?? 0,
        unitType: String(e.unit_type ?? e.unitType ?? "token"),
        ...(typeof e.period === "string" && e.period.trim() !== ""
          ? { period: e.period.trim() }
          : {}),
        ...(toFiniteNumber(e.effective_at ?? e.effectiveAt) !== undefined
          ? { effectiveAt: toFiniteNumber(e.effective_at ?? e.effectiveAt) as number }
          : {}),
      })),
    });
  }

  return {
    provider: config.provider,
    serverTime: toFiniteNumber(balanceData.server_time) ?? Math.floor(Date.now() / 1000),
    jwt,
    balances,
    claimablePlans,
    codingPlan,
    mcpUsage,
    subscriptionAvailability,
    errors,
  };
}

/** Handle GET /quota — JSON snapshot with the proxy error envelope on failure. `loadCredentialImpl` is injectable for tests. */
export async function handleQuota(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<Response> {
  try {
    const snapshot = await collectQuotaSnapshot(config, fetchImpl, loadCredentialImpl);
    return new Response(JSON.stringify(snapshot, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(503, "quota_unavailable", `quota query failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Coding-plan reset (desktop 3.14.4 alignment, 4.7.2-fork.1)
//
// `GET /quota/reset` — reset entitlements for the active account, fetched from
// the zcode plane (`/api/v1/coding-plan/reset/status`). Kept separate from
// `/quota` so the (heavier) billing/monitor snapshot stays untouched; the
// dashboard polls both in parallel. Accounts missing the dual reset tokens
// (pre-4.7.2-fork.1 logins have no stored `maasToken`) degrade to
// `{available:false, reason}` instead of failing the whole response.
// ---------------------------------------------------------------------------

/** Reset snapshot served by `GET /quota/reset`. */
export interface QuotaResetSnapshot {
  provider: string;
  serverTime: number;
  /** False when the account cannot use the reset endpoints (tokens missing / request failed). */
  available: boolean;
  /** Human-readable blocker when `available === false` (re-login hint etc.). */
  reason?: string;
  status: ResetStatus | null;
}

/** Collect the reset snapshot for the active credential. Exported for tests. */
export async function collectResetSnapshot(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<QuotaResetSnapshot> {
  const cred = await resolveConfiguredCredential(config, loadCredentialImpl);
  if (!cred) {
    throw new Error("not logged in (run: zcode-proxy auth login)");
  }
  const client = createResetClient(cred, {
    origin: config.claim.origin || DEFAULT_RESET_ORIGIN,
    fetchImpl,
    identity: config.identity,
  });
  try {
    const status = await client.getStatus();
    return { provider: config.provider, serverTime: Math.floor(Date.now() / 1000), available: true, status };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { provider: config.provider, serverTime: Math.floor(Date.now() / 1000), available: false, reason, status: null };
  }
}

/** Handle GET /quota/reset — reset entitlements with the proxy error envelope on failure. */
export async function handleQuotaReset(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<Response> {
  try {
    const snapshot = await collectResetSnapshot(config, fetchImpl, loadCredentialImpl);
    return new Response(JSON.stringify(snapshot, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(503, "quota_reset_unavailable", `reset status query failed: ${(e as Error).message}`);
  }
}

/** Parsed `POST /quota/reset` body — `use` spends one reset, `opportunity`
 * asks the server for an automatic grant (same actions as the CLI's
 * `zcode-proxy reset --use/--opportunity`). */
export interface QuotaResetActionBody {
  action?: unknown;
  type?: unknown;
  idempotency_key?: unknown;
}

/** Handle POST /quota/reset — spend a stockpiled reset or request an automatic
 * reset grant for the active credential. Body `{action:"use",type:"five_hour"|"week"}`
 * or `{action:"opportunity"}`; an optional `idempotency_key` (1-64 chars) is
 * honored so retries stay idempotent, otherwise a fresh UUID is generated.
 * Business verdicts (`ResetApiError`) come back as 200 `{ok:false,...}` so the
 * dashboard can render the upstream reason verbatim; transport failures use
 * the error envelope. `resetClientImpl` is a DI seam for tests. */
const MAX_QUOTA_BODY_BYTES = 64 * 1024;

/**
 * Bounded body read for the /quota POST routes: the payloads here are tiny
 * JSON objects, but `req.text()` alone would let a single chunked POST buffer
 * the process to OOM (these routes run before/outside maxRequestBodyBytes).
 */
async function readBoundedQuotaBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; resp: Response }> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_QUOTA_BODY_BYTES) {
    return { ok: false, resp: errorResponse(413, "payload_too_large", `quota request body exceeds ${MAX_QUOTA_BODY_BYTES} bytes`) };
  }
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_QUOTA_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return { ok: false, resp: errorResponse(413, "payload_too_large", `quota request body exceeds ${MAX_QUOTA_BODY_BYTES} bytes`) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, resp: errorResponse(400, "invalid_request_error", "failed to read request body") };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

export async function handleQuotaResetAction(
  req: Request,
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
  resetClientImpl: typeof createResetClient = createResetClient,
): Promise<Response> {
  let body: QuotaResetActionBody = {};
  try {
    const read = await readBoundedQuotaBody(req);
    if (!read.ok) return read.resp;
    if (read.text.trim() !== "") body = JSON.parse(read.text) as typeof body;
  } catch {
    return errorResponse(400, "reset_invalid_body", "request body must be JSON");
  }
  const cred = await resolveConfiguredCredential(config, loadCredentialImpl);
  if (!cred) {
    return errorResponse(401, "not_logged_in", "not logged in (run: zcode-proxy auth login)");
  }
  const action = body.action;
  let type: ResetType | undefined;
  if (action === "use") {
    // Validate the reset type BEFORE any upstream call so a bad value is a
    // clean 400 instead of a transport-shaped 502.
    try {
      type = normalizeResetType(typeof body.type === "string" ? body.type : "");
    } catch (e) {
      return errorResponse(400, "reset_invalid_type", (e as Error).message);
    }
  }
  const client = resetClientImpl(cred, {
    origin: config.claim.origin || DEFAULT_RESET_ORIGIN,
    fetchImpl,
    identity: config.identity,
  });
  // The CLI generates the key the same way (random UUID per invocation).
  const rawKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  const idempotencyKey = rawKey.trim() !== "" ? rawKey : randomUUID();
  try {
    if (action === "opportunity") {
      const result = await client.requestOpportunity(idempotencyKey);
      return new Response(JSON.stringify({ ok: true, action: "opportunity", ...result }, null, 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (action === "use" && type) {
      await client.use(type, idempotencyKey);
      return new Response(JSON.stringify({ ok: true, action: "use", used: true, type }, null, 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return errorResponse(
      400,
      "reset_invalid_action",
      'body.action must be "use" (with type "five_hour"|"week") or "opportunity"',
    );
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    // ResetApiError (business verdict: no stock, invalid key, 429 backoff…)
    // is a normal upstream answer — surface it verbatim, not as a 5xx.
    if ((e as Error).name === "ResetApiError") {
      return new Response(JSON.stringify({ ok: false, action: body.action ?? null, error: message }, null, 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return errorResponse(502, "reset_action_failed", `reset action failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Manual claim plan (desktop 3.14.4 alignment) — limited-time trial-plan
// claiming (the "100M tokens" style marketing events).
//
// The claim CLIENT lives in `src/claim/client.ts` (3.12.3 verbatim mirror +
// campaign-proven X-Device-Mid deviation + Aliyun captcha pool). These routes
// expose it over HTTP so the dashboard can render the banner data the desktop
// shows (`manualClaimPlan.*` i18n namespace):
//
//   `GET /quota/claim`  — claimable plans for the active account (`billing/
//                         preview` plane; 404 campaigns degrade to an empty
//                         list, matching the desktop's “活动已结束” state).
//   `POST /quota/claim` — claim one plan; body `{plan_id?}`. The captcha
//                         verify param is solved in-process via the captcha
//                         pool (`getCaptchaToken`) — the same path the CLI's
//                         `claim now` uses. Business failures return the
//                         upstream verdict `{success:false, code, failureKind}`
//                         verbatim; transport failures use the error envelope.
// ---------------------------------------------------------------------------

/** Claim-plane snapshot served by `GET /quota/claim`. */
export interface QuotaClaimSnapshot {
  provider: string;
  serverTime: number;
  /** False when the campaign endpoint is not deployed (HTTP 404 off-season). */
  available: boolean;
  /** Human-readable blocker when `available === false`. */
  reason?: string;
  plans: ClaimablePlan[];
}

/** Collect claimable plans for the active credential. Exported for tests. */
export async function collectClaimSnapshot(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<QuotaClaimSnapshot> {
  const cred = await resolveConfiguredCredential(config, loadCredentialImpl);
  if (!cred) {
    throw new Error("not logged in (run: zcode-proxy auth login)");
  }
  const client = createClaimClient({
    origin: config.claim.origin || "https://zcode.z.ai",
    jwt: cred.jwt,
    appVersion: config.identity.appVersion,
    platform: `${process.platform}-${os.arch()}`,
    deviceMid: resolveBillingDeviceMid(config.identity.deviceMid),
    fetchImpl: fetchImpl as unknown as (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  });
  try {
    const plans = await client.getPreviews();
    return { provider: config.provider, serverTime: Math.floor(Date.now() / 1000), available: true, plans };
  } catch (e) {
    // Off-season: the desktop renders "活动已结束或套餐暂不可领取" — an empty
    // list with `available:false`, not an error.
    if (e instanceof ClaimPreviewError && e.status === 404) {
      return {
        provider: config.provider,
        serverTime: Math.floor(Date.now() / 1000),
        available: false,
        reason: "campaign endpoint not deployed (404) — no claimable plans right now",
        plans: [],
      };
    }
    throw e;
  }
}

/** Handle GET /quota/claim — claimable plans with the proxy error envelope on failure. */
export async function handleQuotaClaim(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<Response> {
  try {
    const snapshot = await collectClaimSnapshot(config, fetchImpl, loadCredentialImpl);
    return new Response(JSON.stringify(snapshot, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(503, "quota_claim_unavailable", `claim preview failed: ${(e as Error).message}`);
  }
}

/** Handle POST /quota/claim — claim the configured (or highest-priority) plan
 * with an in-process solved captcha. Body `{plan_id?}` (optional: defaults to
 * `claim.planId` from config, else the highest-priority preview). Business
 * failures come back as 200 `{success:false,...}` verbatim from upstream.
 * `captchaImpl` is a DI seam for tests (defaults to the real captcha pool). */
export async function handleQuotaClaimSubmit(
  req: Request,
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
  captchaImpl: typeof getCaptchaToken = getCaptchaToken,
): Promise<Response> {
  let body: { plan_id?: unknown } = {};
  try {
    const read = await readBoundedQuotaBody(req);
    if (!read.ok) return read.resp;
    if (read.text.trim() !== "") body = JSON.parse(read.text) as typeof body;
  } catch {
    return errorResponse(400, "claim_invalid_body", "request body must be JSON");
  }
  const cred = await resolveConfiguredCredential(config, loadCredentialImpl);
  if (!cred) {
    return errorResponse(401, "not_logged_in", "not logged in (run: zcode-proxy auth login)");
  }
  if (!cred.jwt?.trim()) {
    return errorResponse(401, "claim_login_required", "claim requires the zcode plan JWT (re-login to capture it)");
  }
  const client = createClaimClient({
    origin: config.claim.origin || "https://zcode.z.ai",
    jwt: cred.jwt,
    appVersion: config.identity.appVersion,
    platform: `${process.platform}-${os.arch()}`,
    deviceMid: resolveBillingDeviceMid(config.identity.deviceMid),
    fetchImpl: fetchImpl as unknown as (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  });
  try {
    // Resolve the target plan: explicit body param → configured claim.planId
    // → highest-priority preview (same precedence as runClaimCli).
    let planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    if (!planId) {
      const plans = await client.getPreviews();
      const wanted = config.claim.planId.trim();
      const target = wanted
        ? plans.find((p) => p.planId === wanted)
        : [...plans].sort((a, b) => b.priority - a.priority)[0];
      if (!target) {
        return errorResponse(404, "claim_no_target", `no claimable plan to target (configured planId "${wanted}" not in preview)`);
      }
      planId = target.planId;
    }
    // Captcha solved in-process (pool take + happy-dom solve) — the same flow
    // the CLI and scheduler use; the desktop solves the identical Aliyun
    // widget locally before submitting.
    const captcha = await captchaImpl(config.identity.appVersion);
    const outcome: ClaimOutcome = await client.claim(planId, {
      verifyParam: captcha.verifyParam,
      region: captcha.region || undefined,
    });
    return new Response(JSON.stringify(outcome, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(502, "claim_submit_failed", `claim failed: ${(e as Error).message}`);
  }
}
