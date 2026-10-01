/**
 * Coding-plan usage-window reset client (ZCode desktop 3.14.4).
 *
 * The newest desktop release added a reset system on the zcode plane
 * (out/host/index.js `useCodingPlanReset`/`getCodingPlanResetStatus`/…):
 * accounts hold reset entitlements (typically earned via the rewards page)
 * that can be spent to clear the 5-hour or weekly coding-plan usage window
 * without waiting for the natural `nextResetTime` rollover. Four endpoints,
 * all under `GET/POST {origin}/api/v1/coding-plan/reset`:
 *
 *   - `GET  /status`       → which resets are available + latest history
 *   - `POST /use`          → spend a reset (`{idempotency_key, reset_type}`)
 *   - `POST /opportunity`  → poll for an automatic reset grant
 *                            (`{granted:true}` or code `3301` +
 *                            `{granted:false, next_try_at}`)
 *   - `POST /history/read` → mark the reset history as read
 *
 * Wire envelope (bundle `K_`/`wK`): `{code, msg?, data?}` — `code !== 0` is a
 * business error, `code === 0` carries `data`. The desktop validates
 * idempotency keys client-side (trimmed, ≤ 64 chars) before calling `/use`.
 *
 * Authentication (bundle `ow` = `createCodingPlanResetHeaders`) is DUAL:
 *   - `Authorization: Bearer <zcode plan JWT>`  → `Credential.jwt`
 *   - `X-Bigmodel-Authorization: <OAuth access token>` → `Credential.maasToken`
 *   - `Bigmodel-Target-Type: PERSONAL` (or `TEAM` + org/project headers when
 *     the account access is a team plan — the proxy tracks personal accounts
 *     only, so `PERSONAL` is always sent, mirroring a non-team desktop login).
 * Both tokens are required by upstream (`coding_plan_reset_zcode_jwt_required`
 * / `coding_plan_reset_maas_jwt_required`); accounts logged in before the
 * `maasToken` capture (4.7.2-fork.1) must re-login to use this feature.
 *
 * `reset_type` wire values are the desktop's UI enum, passed verbatim through
 * the host bridge with no case conversion: `FIVE_HOUR` | `WEEK` (verified in
 * the 3.14.4 bundle chain renderer → host → HTTP). Lowercase input aliases
 * are accepted here for CLI ergonomics and normalized to the wire form.
 *
 * @see zcode-unpack/asar-3144/out/host/index.js (`rw`/`ow`/`wK`/`F_`)
 */
import type { Credential } from "./types.js";
import type { ProxyIdentity } from "../config/types.js";
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import { buildIdentityHeaders } from "../proxy/identity.js";
import { hostSetTimeout, hostClearTimeout } from "../utils/host-timers.js";

/** Default origin of the zcode control plane (reset endpoints live on zcode.z.ai, not api.z.ai). */
export const DEFAULT_RESET_ORIGIN = "https://zcode.z.ai";
/** Upstream request timeout — the desktop uses 15s (`so = 15e3`). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Upstream idempotency key cap (bundle: trimmed length > 64 → hard error). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

/** The two reset windows, in the desktop's wire casing. */
export type ResetType = "FIVE_HOUR" | "WEEK";

/** One stockpiled reset entitlement from `/status`. */
export interface AvailableReset {
  /** Epoch ms when the entitlement expires (desktop maps `expire_at` verbatim). */
  expireAt: number;
}

/** Latest single-use record of a spent reset, when one exists. */
export interface ResetHistoryEntry {
  usedAt: number;
}

/** Parsed `GET /reset/status` payload. */
export interface ResetStatus {
  availableFiveHourResets: AvailableReset[];
  availableWeekResets: AvailableReset[];
  latestFiveHourResetHistory: ResetHistoryEntry | null;
  latestWeekResetHistory: ResetHistoryEntry | null;
  hasUnreadHistory: boolean;
}

/** Parsed `POST /use` payload — upstream answers `{used: true}` on success. */
export interface UseResetResult {
  used: boolean;
}

/** Parsed `POST /opportunity` payload. */
export interface ResetOpportunity {
  /** `true` = the server granted an automatic reset (spendable via `/use`). */
  granted: boolean;
  /** When `granted === false`: epoch ms of the next chance (upstream `next_try_at`). */
  nextTryAt: number | null;
}

/** thrown on business errors (`code !== 0`) with the raw code attached. */
export class ResetApiError extends Error {
  readonly code: number;
  readonly businessCode: string;

  constructor(code: number, msg: string | undefined) {
    super(msg?.trim() || `coding_plan_reset_api_error:${code}`);
    this.name = "ResetApiError";
    this.code = code;
    this.businessCode = `coding_plan_reset_api_error:${code}`;
  }
}

/** Thrown when the stored credential lacks a token the reset endpoints require. */
export class ResetAuthMissingError extends Error {
  constructor(missing: "jwt" | "maasToken") {
    super(
      missing === "jwt"
        ? "reset requires the zcode plan JWT (re-login: zcode-proxy auth login)"
        : "reset requires the OAuth access token (maasToken) which older logins did not store — re-login to capture it",
    );
    this.name = "ResetAuthMissingError";
  }
}

export interface ResetClientOptions {
  /** Override the zcode-plane origin (default `https://zcode.z.ai`). */
  origin?: string;
  /** Request timeout in ms (default 15000, matching the desktop). */
  timeoutMs?: number;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Identity headers (UA / app-version / device fingerprint). */
  identity?: ProxyIdentity;
}

/**
 * Normalize a user-supplied reset type to the wire enum. Accepts the CLI
 * spellings (`five_hour`, `week`) and any casing of the desktop enum, and
 * mirrors the desktop's verbatim `FIVE_HOUR`/`WEEK` on the wire.
 */
export function normalizeResetType(input: string): ResetType {
  const key = input.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (key === "five_hour" || key === "fivehour") return "FIVE_HOUR";
  if (key === "week" || key === "weekly") return "WEEK";
  throw new Error(`invalid reset type "${input}" (expected five_hour | week)`);
}

/** Validate an idempotency key with the desktop's exact client-side rule. */
export function normalizeIdempotencyKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error("coding_plan_reset_invalid_idempotency_key (1-64 characters after trim)");
  }
  return trimmed;
}

/**
 * Create the 3.14.4 coding-plan reset client bound to one credential.
 * Every method enforces the dual-token auth and returns parsed payloads;
 * non-zero business codes throw `ResetApiError` (opportunity code 3301 is
 * surfaced as a normal `{granted:false}` response, matching upstream).
 */
export function createResetClient(cred: Credential, opts: ResetClientOptions = {}) {
  const origin = (opts.origin ?? DEFAULT_RESET_ORIGIN).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${origin}/api/v1/coding-plan/reset`;

  function buildHeaders(withJson: boolean): Record<string, string> {
    if (!cred.jwt?.trim()) throw new ResetAuthMissingError("jwt");
    if (!cred.maasToken?.trim()) throw new ResetAuthMissingError("maasToken");
    // The billing/claim plane drops X-ZCode-Agent on control-plane calls —
    // follow the same precedent so the reset gateway sees the billing
    // fingerprint, not the proxy one.
    const identityHeaders = buildIdentityHeaders(opts.identity ?? {
      // Config default version (kept in lock-step with loader.ts, same
      // pattern as quota.ts's identity synthesis).
      appVersion: DEFAULT_APP_VERSION,
      sourceTitle: "cli",
      refererOrigin: DEFAULT_RESET_ORIGIN,
    });
    delete identityHeaders["X-ZCode-Agent"];
    const headers: Record<string, string> = {
      ...identityHeaders,
      authorization: `Bearer ${cred.jwt.trim()}`,
      // Bundle `ow`: the raw OAuth access token rides in a dedicated header.
      "X-Bigmodel-Authorization": cred.maasToken.trim(),
      // The proxy stores personal accounts only (no team-plan tracking).
      "Bigmodel-Target-Type": "PERSONAL",
      accept: "application/json",
    };
    if (withJson) headers["content-type"] = "application/json";
    return headers;
  }

  async function call(
    path: string,
    method: "GET" | "POST",
    body: unknown | undefined,
    /** Business codes that resolve to a value instead of throwing (upstream: 3301). */
    acceptedBusinessCodes: readonly number[] = [],
  ): Promise<{ code: number; msg?: string; data: unknown }> {
    const controller = new AbortController();
    // Host-safe timer, armed until BODY consumption finishes (a stalled body
    // previously had no timeout once headers arrived). See utils/host-timers.ts.
    const timer = hostSetTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(`${base}${path}`, {
        method,
        headers: buildHeaders(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      hostClearTimeout(timer);
      throw err;
    }
    // Keep the timer armed through resp.json() below; disarmed at each exit.
    if (!resp.ok) {
      hostClearTimeout(timer);
      void resp.body?.cancel().catch(() => {});
      throw new ResetApiError(resp.status, `reset ${path} HTTP ${resp.status}`);
    }
    let envelope: { code?: unknown; msg?: unknown; data?: unknown };
    try {
      envelope = await resp.json();
    } catch {
      hostClearTimeout(timer);
      throw new ResetApiError(-1, "coding_plan_reset_invalid_response");
    }
    hostClearTimeout(timer);
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      typeof (envelope as { code?: unknown }).code !== "number"
    ) {
      throw new ResetApiError(-1, "coding_plan_reset_invalid_response");
    }
    const code = envelope.code as number;
    const msg = typeof envelope.msg === "string" ? envelope.msg : undefined;
    if (code !== 0 && !acceptedBusinessCodes.includes(code)) {
      throw new ResetApiError(code, msg);
    }
    return { code, msg, data: envelope.data };
  }

  return {
    /** `GET /status` — available resets + latest usage history. */
    async getStatus(): Promise<ResetStatus> {
      const { data } = await call("/status", "GET", undefined);
      const d = (data ?? {}) as Record<string, unknown>;
      const list = (v: unknown): AvailableReset[] =>
        (Array.isArray(v) ? v : [])
          .map((e) => toFinite((e as Record<string, unknown>)?.expire_at))
          .filter((n): n is number => n !== undefined)
          .map((expireAt) => ({ expireAt }));
      const history = (v: unknown): ResetHistoryEntry | null => {
        const usedAt = toFinite((v as Record<string, unknown> | null)?.used_at);
        return usedAt !== undefined ? { usedAt } : null;
      };
      return {
        availableFiveHourResets: list(d.available_five_hour_resets),
        availableWeekResets: list(d.available_week_resets),
        latestFiveHourResetHistory: history(d.latest_five_hour_reset_history),
        latestWeekResetHistory: history(d.latest_week_reset_history),
        hasUnreadHistory: d.has_unread_history === true,
      };
    },

    /** `POST /use` — spend one reset of `type`. Returns `{used:true}`. */
    async use(type: ResetType, idempotencyKey: string): Promise<UseResetResult> {
      const key = normalizeIdempotencyKey(idempotencyKey);
      const { data } = await call("/use", "POST", { idempotency_key: key, reset_type: type });
      if ((data as { used?: unknown } | null)?.used !== true) {
        throw new ResetApiError(-1, "coding_plan_reset_invalid_response");
      }
      return { used: true };
    },

    /**
     * `POST /opportunity` — ask the server for an automatic reset grant.
     * Business code 3301 ("no opportunity yet") is a valid answer and yields
     * `{granted:false, nextTryAt}`; HTTP 429 propagates as `ResetApiError`
     * (429) so callers can apply their own backoff like the desktop does.
     */
    async requestOpportunity(idempotencyKey: string): Promise<ResetOpportunity> {
      const key = normalizeIdempotencyKey(idempotencyKey);
      const { code, data } = await call("/opportunity", "POST", { idempotency_key: key }, [3301]);
      if (code === 3301) {
        const nextTryAt = toFinite((data as Record<string, unknown> | null)?.next_try_at);
        if (nextTryAt === undefined) throw new ResetApiError(-1, "coding_plan_reset_invalid_response");
        return { granted: false, nextTryAt };
      }
      if ((data as { granted?: unknown } | null)?.granted !== true) {
        throw new ResetApiError(-1, "coding_plan_reset_invalid_response");
      }
      return { granted: true, nextTryAt: null };
    },

    /** `POST /history/read` — mark reset history as read (fire-and-forget upstream). */
    async markHistoryRead(): Promise<void> {
      await call("/history/read", "POST", undefined);
    },
  };
}

function toFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
