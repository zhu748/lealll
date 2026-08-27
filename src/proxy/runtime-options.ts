let reqCounter = 0;

export function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

export function startPlanCaptchaPreflightEnabled(): boolean {
  const raw = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "never") return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes" || raw === "always";
}

export type StartPlanUpstreamStyle = "anthropic" | "openai";

/**
 * v0.3.7: start-plan upstream wire style.
 *
 * The zcode.z.ai OpenAI gateway endpoint (`/api/v1/zcode-plan/chat/
 * completions`) was REMOVED server-side around 2026-08-27 — every request
 * returns Go's default "404 page not found" (verified live). The Anthropic
 * mirror (`/api/v1/zcode-plan/anthropic/v1/messages`) is the only live
 * start-plan route (verified live: 401 without auth = registered route).
 * This flipped once already, so the legacy gateway pipeline is kept behind
 * an env escape hatch:
 *
 *   ZCODE_STARTPLAN_UPSTREAM=anthropic  (default) Anthropic mirror
 *   ZCODE_STARTPLAN_UPSTREAM=openai|gateway         legacy v0.3.0 gateway
 */
export function startPlanUpstreamStyle(): StartPlanUpstreamStyle {
  const raw = process.env.ZCODE_STARTPLAN_UPSTREAM?.trim().toLowerCase();
  return raw === "openai" || raw === "gateway" ? "openai" : "anthropic";
}
