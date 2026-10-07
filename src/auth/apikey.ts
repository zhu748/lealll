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
 * `plan` is coerced to "coding-plan" when callers pass "start-plan" (e.g.
 * apikey mode inheriting the flipped 4.8.0 config default): start-plan
 * upstream routes authenticate with the OAuth JWT + captcha, which a static
 * API key credential never has — tagging it start-plan would route every
 * request to a plane it cannot authenticate against.
 *
 * @throws Error if `key` is empty.
 */
export function createApiKeyCredential(provider: ProviderId, key: string, plan: PlanId = "coding-plan"): Credential {
  if (!key || key.trim().length === 0) {
    throw new Error("API key must not be empty");
  }

  const safePlan: PlanId = plan === "start-plan" ? "coding-plan" : plan;
  const trimmed = key.trim();
  const dotIdx = trimmed.indexOf(".");

  // Z.AI credentials look like `{apiKey}.{secret}` — split on the FIRST dot.
  // Bigmodel keys may or may not contain a dot; if the provider is Z.AI and a
  // dot is present, treat the parts as apiKey + secret.
  if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
    const apiKey = trimmed.slice(0, dotIdx);
    const secret = trimmed.slice(dotIdx + 1);
    return { apiKey, secret, provider, plan: safePlan };
  }

  return { apiKey: trimmed, provider, plan: safePlan };
}
