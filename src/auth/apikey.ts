/**
 * API-key-mode credential factory.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { Credential, PlanId } from "./types.js";
import type { ProviderId } from "../provider/types.js";

/**
 * Create a `Credential` from a raw key string.
 *
 * Accepts:
 * - `{apiKey}` — no secret (Bigmodel or Z.AI key-only)
 * - `{apiKey}.{secret}` — Z.AI format with API key + secret
 *
 * @throws Error if `key` is empty.
 */
export function createApiKeyCredential(provider: ProviderId, key: string, plan: PlanId = "coding-plan"): Credential {
  if (!key || key.trim().length === 0) {
    throw new Error("API key must not be empty");
  }

  const trimmed = key.trim();
  const dotIdx = trimmed.indexOf(".");

  // Z.AI credentials look like `{apiKey}.{secret}` — split on the FIRST dot.
  // Bigmodel keys may or may not contain a dot; if the provider is Z.AI and a
  // dot is present, treat the parts as apiKey + secret.
  if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
    const apiKey = trimmed.slice(0, dotIdx);
    const secret = trimmed.slice(dotIdx + 1);
    return { apiKey, secret, provider, plan };
  }

  return { apiKey: trimmed, provider, plan };
}
