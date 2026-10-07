/** Account display and statistics identifiers; no persistence or cache access. */
import { createHash } from "node:crypto";
import type { Credential } from "./types.js";
import type { StoredAccount, AccountSummary } from "./store-types.js";

/** Mask a credential's API key for display: "abc12345...wxyz". */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 12) return apiKey;
  return apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
}

/**
 * Stable non-secret key used to join request stats back to stored accounts.
 *
 * `maskApiKey()` is only a display label and can collide when two API keys
 * share the same first 8 / last 4 characters. A short SHA-256 digest of
 * provider + apiKey avoids merging usage stats for distinct accounts while
 * still keeping the plaintext API key out of dashboard responses.
 */
export function credentialStatsKey(cred: Pick<Credential, "provider" | "apiKey">): string {
  if (!cred.apiKey) return "";
  return `sha256:${createHash("sha256")
    .update(cred.provider)
    .update("\0")
    .update(cred.apiKey)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Resolve a credential's plan for display/serving purposes.
 *   1. Explicit cred.plan wins (v0.1.4+ imports, dashboard edits)
 *   2. JWT presence → start-plan (v1 zcode-api-ref credentials)
 *   3. Default coding-plan
 */
function inferPlan(cred: Credential): "coding-plan" | "start-plan" {
  if (cred.plan === "start-plan" || cred.plan === "coding-plan") return cred.plan;
  if (cred.jwt) return "start-plan";
  return "coding-plan";
}

/** Oldest first; copies metadata and never exposes secret/JWT payloads. */
export function summarizeAccounts(accounts: readonly StoredAccount[]): AccountSummary[] {
  // Sort by createdAt ascending (oldest first). Array.prototype.sort is stable
  // in modern V8/Bun, so accounts with identical createdAt keep insertion order.
  const sortedAccounts = [...accounts].sort((a, b) => a.createdAt - b.createdAt);
  return sortedAccounts.map(a => ({
    id: a.id,
    label: a.label,
    createdAt: a.createdAt,
    provider: a.credential.provider,
    apiKeyMask: maskApiKey(a.credential.apiKey),
    credentialKey: credentialStatsKey(a.credential),
    hasSecret: !!a.credential.secret,
    userId: a.credential.userId,
    expiresAt: a.credential.expiresAt,
    hasJwt: !!a.credential.jwt,
    plan: inferPlan(a.credential),
    proxy: a.credential.proxy ?? "",
    name: a.credential.name ?? "",
    email: a.credential.email ?? "",
    disabled: !!a.credential.disabled,
  }));
}
