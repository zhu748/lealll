/**
 * Coding-plan subscription availability client (ZCode desktop 3.14.4).
 *
 * The 3.14.4 host bundle (`out/host/index.js`) added a subscription
 * availability plane: `nfe = "/api/biz/subscription/list"` with
 * `Nj = "zcodejwttoken"` as the auth header name and logger namespace
 * `Pe("coding-plan-availability")`.
 *
 * Used by `validateCodingPlanProviderAvailability({planKind, family,
 * apiClient})`:
 *   - `planKind === "start-plan"` → does NOT call this endpoint (start-plan
 *     availability is implicit — the JWT is valid → plan is usable);
 *   - `planKind === "individual-coding-plan"` and `family === "zai"` →
 *     fetches `rfe()` (the zai subscription list);
 *   - `family === "bigmodel"` → fetches `Wo(env, nfe)` (bigmodel variant);
 *   - Returns `{kind: "unknown" | "available" | ...}`.
 *
 * Use case: the desktop uses this to decide whether to show an account as
 * "active" in the account picker. lealll uses it to skip over accounts
 * whose coding-plan subscription has expired when rotating credentials
 * in the multi-account failover loop (`src/auth/manager.ts`).
 *
 * Auth: `zcodejwttoken` is the OAuth provider access token (the value stored
 * in `Credential.maasToken` since 4.7.2-fork.1). The header name
 * "zcodejwttoken" is lowercase-merged by the host's header-builder. We
 * emit it as `X-Bigmodel-Authorization` to match the precedent set by
 * `reset.ts` (the desktop's `ow` function uses the same header for the
 * same token in the coding-plan reset plane).
 *
 * Failure mode: any network / HTTP / envelope error returns `"unknown"` —
 * the caller treats unknown as "do not skip this account" (fail-open),
 * matching the desktop's behavior where a transient network failure does
 * NOT hide the account from the picker.
 *
 * @see _reverse/3.14.4/asar_out/out_host_index.js (`nfe` / `Nj` / `rfe` / `ofe` / `validateCodingPlanProviderAvailability`)
 * @see src/auth/reset.ts (dual-token header precedent)
 */
import type { Credential, PlanId } from "./types.js";
import type { ProxyIdentity } from "../config/types.js";
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import { buildIdentityHeaders } from "../proxy/identity.js";
import { fetchJsonWithDeadline } from "../utils/fetch-json.js";

/** Default origin of the z.ai biz plane (subscription list lives here, not zcode.z.ai). */
export const DEFAULT_SUBSCRIPTION_ORIGIN = "https://api.z.ai";
/** Upstream request timeout — the desktop uses 15s (`s_ = 15e3`). */
const REQUEST_TIMEOUT_MS = 15_000;

/** Result of an availability probe — mirrors the desktop's `kind` enum. */
export type AvailabilityKind = "unknown" | "available" | "unavailable";

export interface SubscriptionAvailability {
  /** Whether the account has a usable coding-plan subscription. */
  kind: AvailabilityKind;
  /** Number of subscription entries returned by the upstream (informational). */
  count: number;
}

export interface SubscriptionClientOptions {
  /** Override the biz-plane origin (default `https://api.z.ai`). */
  origin?: string;
  /** Request timeout in ms (default 15000, matching the desktop `s_`). */
  timeoutMs?: number;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Identity headers (UA / app-version / device fingerprint). */
  identity?: ProxyIdentity;
}

/**
 * Probe the coding-plan subscription availability for the given credential.
 *
 * - Start-plan credentials return `{kind:"unknown"}` immediately without
 *   any network call (matching the desktop's `ofe` shortcut for
 *   `planKind === "start-plan"`). Start-plan availability is implicit in
 *   the JWT validity; the proxy's failover already retries 401s.
 * - Coding-plan credentials without `maasToken` return `{kind:"unknown"}`
 *   — the desktop's header builder would emit an empty `zcodejwttoken`
 *   and the gateway would 401, which the proxy surfaces as "unknown"
 *   rather than "unavailable" so the failover loop doesn't burn a switch
 *   threshold on a misconfigured credential.
 * - Coding-plan credentials with `maasToken` fetch the subscription list
 *   and return `{kind:"available"}` if any subscription is returned,
 *   `{kind:"unavailable"}` if the list is empty, or `{kind:"unknown"}`
 *   on any error.
 */
export async function fetchSubscriptionAvailability(
  cred: Credential,
  opts: SubscriptionClientOptions = {},
): Promise<SubscriptionAvailability> {
  // Start-plan: shortcut — implicit availability.
  if (cred.plan === "start-plan" as PlanId) {
    return { kind: "unknown", count: 0 };
  }
  // Coding-plan without maasToken: cannot call gateway → unknown (fail-open).
  if (!cred.maasToken?.trim()) {
    return { kind: "unknown", count: 0 };
  }

  const origin = (opts.origin ?? DEFAULT_SUBSCRIPTION_ORIGIN).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Control-plane precedent: drop X-ZCode-Agent (claim/client.ts, reset.ts).
  const identityHeaders = buildIdentityHeaders(opts.identity ?? {
    appVersion: DEFAULT_APP_VERSION,
    sourceTitle: "cli",
    refererOrigin: DEFAULT_SUBSCRIPTION_ORIGIN,
  });
  delete identityHeaders["X-ZCode-Agent"];

  // Bundle `Nj = "zcodejwttoken"` — the desktop's header name for the OAuth
  // access token. We emit it as `X-Bigmodel-Authorization` to match the
  // dual-token precedent in reset.ts (same token, same header, same plane).
  const headers: Record<string, string> = {
    ...identityHeaders,
    "X-Bigmodel-Authorization": cred.maasToken.trim(),
    accept: "application/json",
  };

  const envelope = await fetchJsonWithDeadline(`${origin}/api/biz/subscription/list`, { method: "GET", headers }, fetchImpl, timeoutMs).catch(() => null);
  if (envelope === null) return { kind: "unknown", count: 0 };
  if (typeof envelope !== "object" || envelope === null) {
    return { kind: "unknown", count: 0 };
  }
  // The z.ai biz plane uses BigModel envelope: {code, msg?, data?: [...]}.
  // Any non-zero code → unknown (fail-open; do not penalize transient 3103).
  const code = (envelope as { code?: unknown }).code;
  if (typeof code !== "number" || code !== 0) {
    return { kind: "unknown", count: 0 };
  }
  const data = (envelope as { data?: unknown }).data;
  const count = Array.isArray(data) ? data.length : 0;
  return { kind: count > 0 ? "available" : "unavailable", count };
}
