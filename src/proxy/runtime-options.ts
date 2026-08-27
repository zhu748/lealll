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

/**
 * v0.3.8.1: accept-encoding advertised to model-call upstreams.
 *
 * History: v0.3.0 forwarded the CLIENT's accept-encoding (default "gzip")
 * — an upstream zcode-api v2.6.0 behavior. That was harmless while start-plan
 * went through the OpenAI gateway + response translation (Bun auto-
 * decompresses), but v0.3.7 moved start-plan to the zcode.z.ai Anthropic
 * mirror BYTE-PASSTHROUGH path (`decompress: false`) and the regression
 * surfaced: zcode.z.ai sits behind Alibaba ESA which dynamically gzips the
 * SSE response → the inline stats observer (and the SSE heartbeat, and
 * in-stream error detection) silently disabled themselves for compressed
 * bodies → dashboard/log rows showed `in:- out:-` with no tok/s.
 *
 * The real ZCode desktop client (Tauri builds) sends `accept-encoding:
 * identity` (observed in upstream zcode-api wire captures — see their
 * buildUpstreamHeaderPairs comment), so `identity` is BOTH the better
 * fingerprint match AND the fix: the upstream stops compressing, stats
 * parse plaintext again, and the heartbeat is safe to inject.
 *
 * handler.ts additionally decompresses any compressed passthrough response
 * (gzip/deflate/zstd via DecompressionStream) as defense in depth, so
 * overriding this back to "gzip" keeps stats working too — only "br"
 * (unsupported by Bun's DecompressionStream) would disable them.
 *
 *   ZCODE_UPSTREAM_ACCEPT_ENCODING=identity  (default, real-client value)
 *   ZCODE_UPSTREAM_ACCEPT_ENCODING=gzip      (bandwidth over CPU; still
 *                                             decompressed in-proxy)
 */
export function upstreamAcceptEncoding(): string {
  const raw = process.env.ZCODE_UPSTREAM_ACCEPT_ENCODING?.trim();
  return raw && raw.length > 0 ? raw : "identity";
}
