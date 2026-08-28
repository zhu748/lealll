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
 * Static inspection of the official ZCode 3.9.2 Electron bundle shows that
 * application code does not set accept-encoding. Node 24 fetch negotiates it
 * at transport time, so the aligned default is to omit the explicit header.
 *
 * handler.ts additionally decompresses any compressed passthrough response
 * (gzip/deflate/zstd via DecompressionStream) as defense in depth, so
 * overriding this back to "gzip" keeps stats working too — only "br"
 * (unsupported by Bun's DecompressionStream) would disable them.
 *
 *   ZCODE_UPSTREAM_ACCEPT_ENCODING=identity  (force plaintext for debugging)
 *   ZCODE_UPSTREAM_ACCEPT_ENCODING=gzip      (explicit compression override)
 */
export function upstreamAcceptEncoding(): string | undefined {
  const raw = process.env.ZCODE_UPSTREAM_ACCEPT_ENCODING?.trim();
  // ZCode 3.9.2 does not set this header in application code. Its Node 24
  // fetch transport negotiates gzip/deflate automatically. Omitting it here
  // gives the proxy runtime the same responsibility; operators can still pin
  // `identity` when diagnosing a non-conforming intermediary.
  return raw && raw.length > 0 ? raw : undefined;
}
