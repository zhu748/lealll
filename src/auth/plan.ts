import type { Credential, PlanId } from "./types.js";

/**
 * The credential's explicit plan wins; JWT presence alone never selects a plan.
 * The start-plan gateway requires a JWT, so imported keys use coding-plan.
 * Resolving a request must not mutate the shared config or credential.
 */
export function resolveEffectivePlan(credential: Credential, fallback: PlanId): PlanId {
  const plan = credential.plan ?? fallback;
  return plan === "start-plan" && !credential.jwt ? "coding-plan" : plan;
}
