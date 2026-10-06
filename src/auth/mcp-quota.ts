/**
 * MCP gateway usage-quota client (ZCode desktop 3.14.4).
 *
 * The 3.14.4 host bundle (`out/host/index.js`) added an MCP usage-stats
 * plane: `yme = "/api/v1/mcp/usage"` with a 15s timeout (`aK = 15e3`) and
 * logger namespace `Pe("usage-stats")`. The desktop calls this to render
 * "today's plugin-MCP gateway relay usage" in its usage panel.
 *
 * Wire schema (bundle `wme` / `vme` / `Sme`, verified against the 3.14.4
 * host bundle):
 *   - `wme` (single-period snapshot): `{used, limit, remaining}` (finite numbers)
 *   - `vme` (full data): `{server_time, next_refresh_at?, level?, total_usage?: wme}`
 *   - `Sme` (envelope): `{code, msg?, data?: vme | null}`
 *
 * Authentication mirrors every other zcode-plane call (`endpoint-routing.ts`,
 * `claim/client.ts`, `routes-quota.ts`): the `buildIdentityHeaders` set with
 * `X-ZCode-Agent` stripped — the control-plane precedent. No dual token: the
 * mcp/usage endpoint is reachable with the identity fingerprint alone when
 * the account has a coding-plan credential; start-plan credentials without
 * a coding-plan JWT are not eligible (return `null` upstream-side).
 *
 * Failure mode: any network / HTTP / envelope error returns `null` — this
 * module is consumed by `GET /quota` aggregation, which tolerates per-plane
 * failures (the official desktop panel does the same — usage: null).
 *
 * @see _reverse/3.14.4/zcode.cjs (`yme` / `wme` / `vme` / `Sme` / `dK` / `fetchMcpQuotaSnapshot`)
 * @see src/proxy/identity.ts (buildIdentityHeaders)
 */
import type { Credential } from "./types.js";
import type { ProxyIdentity } from "../config/types.js";
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import { buildIdentityHeaders } from "../proxy/identity.js";
import { fetchJsonWithDeadline } from "../utils/fetch-json.js";

/** Default origin of the zcode control plane. */
export const DEFAULT_MCP_USAGE_ORIGIN = "https://zcode.z.ai";
/** Upstream request timeout — the desktop uses 15s (`aK = 15e3`). */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Parsed MCP usage snapshot. Mirrors `vme` from the bundle (with `total_usage`
 * promoted to top-level for convenience — that's the field the dashboard
 * renders).
 */
export interface McpUsageSnapshot {
  /** Epoch ms when the server generated the snapshot (`server_time * 1000`). */
  serverTime: number;
  /** Epoch ms of the next refresh window (`next_refresh_at * 1000`); absent when not reported. */
  nextRefreshAt?: number;
  /** Account level / tier string (e.g. `"max"`); absent when not reported. */
  level?: string;
  /** Used count in the current period. */
  used: number;
  /** Quota limit for the current period. */
  limit: number;
  /** Remaining calls in the current period. */
  remaining: number;
}

export interface McpUsageClientOptions {
  /** Override the zcode-plane origin (default `https://zcode.z.ai`). */
  origin?: string;
  /** Request timeout in ms (default 15000, matching the desktop `aK`). */
  timeoutMs?: number;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Identity headers (UA / app-version / device fingerprint). */
  identity?: ProxyIdentity;
}

/**
 * Fetch the MCP usage snapshot for the given coding-plan credential.
 * Returns `null` on any failure (network / HTTP non-2xx / invalid envelope /
 * business error) — matches the desktop's tolerance of usage: null.
 *
 * Requires `cred.jwt` (the zcode plan JWT captured by `auth login`). The
 * desktop's `fetchMcpQuotaSnapshot` is gated on a coding-plan credential
 * source, so a start-plan-only credential also yields `null`.
 */
export async function fetchMcpUsage(
  cred: Credential,
  opts: McpUsageClientOptions = {},
): Promise<McpUsageSnapshot | null> {
  // The desktop's fetchMcpQuotaSnapshot is invoked only for coding-plan
  // credential sources. A credential without a JWT has no coding-plan
  // access — surface as null rather than sending a request the gateway will
  // reject with 401.
  if (!cred.jwt?.trim()) return null;

  const origin = (opts.origin ?? DEFAULT_MCP_USAGE_ORIGIN).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Control-plane precedent: drop X-ZCode-Agent (claim/client.ts, reset.ts).
  const identityHeaders = buildIdentityHeaders(opts.identity ?? {
    appVersion: DEFAULT_APP_VERSION,
    sourceTitle: "cli",
    refererOrigin: DEFAULT_MCP_USAGE_ORIGIN,
  });
  delete identityHeaders["X-ZCode-Agent"];

  const headers: Record<string, string> = {
    ...identityHeaders,
    authorization: `Bearer ${cred.jwt.trim()}`,
    accept: "application/json",
  };

  const envelope = await fetchJsonWithDeadline(`${origin}/api/v1/mcp/usage`, { method: "GET", headers }, fetchImpl, timeoutMs).catch(() => null);
  if (envelope === null) return null;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    typeof (envelope as { code?: unknown }).code !== "number"
  ) {
    return null;
  }
  const code = envelope.code as number;
  if (code !== 0) return null;
  const data = (envelope as { data?: unknown }).data;
  if (data == null) return null;
  const d = data as Record<string, unknown>;
  const serverTime = toFinite(d.server_time);
  if (serverTime === undefined) return null;
  const totalUsage = d.total_usage as Record<string, unknown> | undefined;
  const used = toFinite(totalUsage?.used) ?? 0;
  const limit = toFinite(totalUsage?.limit) ?? 0;
  const remaining = toFinite(totalUsage?.remaining) ?? 0;
  const nextRefreshAt = toFinite(d.next_refresh_at);
  const level = typeof d.level === "string" ? d.level.trim() : undefined;
  return {
    serverTime: serverTime * 1000,
    used,
    limit,
    remaining,
    ...(nextRefreshAt !== undefined ? { nextRefreshAt: nextRefreshAt * 1000 } : {}),
    ...(level ? { level } : {}),
  };
}

function toFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
