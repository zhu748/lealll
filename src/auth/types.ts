/**
 * Credential and auth type definitions.
 * @see .omo/plans/zcode-proxy.md Task 4
 * @see _reverse/NOTEPAD.md "How Credential is Used"
 */
import type { ProviderId } from "../provider/types.js";

/** How the proxy obtains the upstream credential. */
export type AuthMode = "apikey" | "oauth";

/** Plan tier the credential is associated with. */
export type PlanId = "coding-plan" | "start-plan";

/** A resolved credential ready to be injected into upstream requests. */
export interface Credential {
  /** The API key portion (e.g. Z.AI API key id, or Bigmodel API key). */
  apiKey: string;
  /** The secret portion (Z.AI only — appended as `{apiKey}.{secret}`). */
  secret?: string;
  /** Which provider this credential is for. */
  provider: ProviderId;
  /** Which plan tier this credential is for. Determines upstream URL and auth headers. Defaults to "coding-plan" for backward compatibility. */
  plan?: PlanId;
  /** Unix timestamp (ms) when the credential expires. Present only for OAuth. */
  expiresAt?: number;
  /** Upstream user identifier (OAuth only). Injected as `metadata.user_id` on Anthropic-format requests. */
  userId?: string;
  /** JWT token for start-plan (zcode.z.ai). Present when login captured the ZCode plan token. */
  jwt?: string;
  /**
   * Outbound HTTP proxy URL (per-account override).
   *
   * When set, all upstream requests made under this credential are routed
   * through this proxy via Bun's native `fetch(url, { proxy })` option.
   * Supported schemes: `http://`, `https://`, `socks5://` (Bun native).
   * Empty string clears the override (falls back to direct connection).
   *
   * Introduced in v2.1.4.1test5 for per-account proxy support.
   */
  proxy?: string;
  /**
   * Human-readable name for this credential (vceshi0.0.4+).
   *
   * OAuth flow: auto-generated as `{email}-{plan}` (e.g. "alice@x.com-start-plan").
   * ZCode import: auto-generated as `zcode(N)-{plan}` where N is the count of
   *   existing zcode-imported accounts + 1 (e.g. "zcode(1)-coding-plan").
   * Manual add: empty (dashboard shows the auto-generated label as fallback).
   *
   * The dashboard's account list prefers `name` over the auto-generated `label`
   * when both are present. Empty `name` falls back to `label` for display.
   */
  name?: string;
  /**
   * Email associated with the OAuth account (vceshi0.0.4+).
   *
   * Captured from the OAuth callback response (`data.user.email`). Empty for
   * ZCode imports and manually-added API keys (no email information available
   * in those flows). Editable via the dashboard.
   */
  email?: string;
  /**
   * Disabled flag (vceshi0.0.6+).
   *
   * When true, the credential is excluded from:
   *   - `switchToNextCredential` — won't be picked as a fallback alternative
   *   - manual activation via dashboard "Activate" button (returns error)
   *
   * Useful for temporarily taking a credential out of rotation without
   * deleting it (e.g. quota exhausted, suspected ban, maintenance).
   * Toggleable via the dashboard "禁用/启用" button. Default: false (enabled).
   */
  disabled?: boolean;
}

/**
 * Convert a `Credential` to the string sent upstream.
 *
 * - Z.AI: `{apiKey}.{secret}` (secret required)
 * - Bigmodel: `{apiKey}` (no secret)
 */
export function credentialString(cred: Credential): string {
  if (cred.secret) {
    return `${cred.apiKey}.${cred.secret}`;
  }
  return cred.apiKey;
}

/** Check whether a credential has expired. */
export function isExpired(cred: Credential, now: number = Date.now()): boolean {
  if (cred.expiresAt === undefined) return false;
  return now >= cred.expiresAt;
}
