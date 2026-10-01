import type { ProxyConfig } from "../config/types.js";

export type AdminRateLimitOptions = {
  config: ProxyConfig;
  resolveClientIp?: (req: Request) => string | undefined;
};

export function withSecurityHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  if (!headers.has("content-security-policy")) {
    // script-src/style-src include the two CDNs the bundled /webui page loads
    // (marked + DOMPurify from jsdelivr, highlight.js + its stylesheet from
    // cdnjs). Without them the CSP added for hardening silently broke the
    // page's own markdown/code-highlighting stack.
    headers.set("content-security-policy",
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
      "connect-src 'self' https://zcode.z.ai https://api.z.ai https://open.bigmodel.cn; " +
      "img-src 'self' data:; " +
      "font-src 'self' data:; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'");
  }
  if (!headers.has("x-frame-options")) headers.set("x-frame-options", "DENY");
  if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", "same-origin");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VERIFY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_RATE_LIMIT_MAX_FAILURES = 10;
const VERIFY_RATE_LIMIT_MAX_ENTRIES = 4096;
const VERIFY_RATE_LIMIT_GC_INTERVAL_MS = 60_000;
const verifyFailures = new Map<string, { count: number; firstAt: number }>();
let verifyFailuresLastGcAt = 0;

function gcVerifyFailures(now: number, force = false): void {
  if (!force && verifyFailures.size <= VERIFY_RATE_LIMIT_MAX_ENTRIES && now - verifyFailuresLastGcAt < VERIFY_RATE_LIMIT_GC_INTERVAL_MS) {
    return;
  }
  verifyFailuresLastGcAt = now;
  for (const [k, v] of verifyFailures) {
    if (now - v.firstAt > VERIFY_RATE_LIMIT_WINDOW_MS) verifyFailures.delete(k);
  }
  if (verifyFailures.size <= VERIFY_RATE_LIMIT_MAX_ENTRIES) return;
  const overflow = verifyFailures.size - VERIFY_RATE_LIMIT_MAX_ENTRIES;
  let dropped = 0;
  for (const k of verifyFailures.keys()) {
    verifyFailures.delete(k);
    dropped++;
    if (dropped >= overflow) break;
  }
}

export function recordVerifyFailure(ip: string): void {
  const now = Date.now();
  gcVerifyFailures(now, verifyFailures.size >= VERIFY_RATE_LIMIT_MAX_ENTRIES);
  const existing = verifyFailures.get(ip);
  if (existing) {
    existing.count++;
    if (now - existing.firstAt > VERIFY_RATE_LIMIT_WINDOW_MS) {
      existing.count = 1;
      existing.firstAt = now;
    }
  } else {
    verifyFailures.set(ip, { count: 1, firstAt: now });
  }
  if (verifyFailures.size > VERIFY_RATE_LIMIT_MAX_ENTRIES) {
    gcVerifyFailures(now, true);
  }
}

export function clearVerifyFailure(ip: string): void {
  verifyFailures.delete(ip);
}

export function isVerifyLocked(ip: string): boolean {
  const v = verifyFailures.get(ip);
  if (!v) return false;
  if (Date.now() - v.firstAt > VERIFY_RATE_LIMIT_WINDOW_MS) {
    verifyFailures.delete(ip);
    return false;
  }
  return v.count >= VERIFY_RATE_LIMIT_MAX_FAILURES;
}

export function resolveIpForRateLimit(req: Request, opts: AdminRateLimitOptions): string {
  if (opts.resolveClientIp) {
    try {
      const ip = opts.resolveClientIp(req);
      if (ip) return ip;
    } catch { /* ignore */ }
  }
  if (opts.config.server.trustProxy) {
    const xRealIp = req.headers.get("x-real-ip") ?? "";
    if (xRealIp) return xRealIp;
    const xff = req.headers.get("x-forwarded-for") ?? "";
    if (xff) return xff.split(",")[0].trim();
  }
  return "unknown";
}

/**
 * Cross-site mutation guard (CSRF) for state-changing HTTP routes.
 *
 * For non-GET/HEAD/OPTIONS requests that carry an Origin or Referer header,
 * the source host must be a loopback form or match the request's own Host
 * header. A request with neither header is treated as non-browser (curl/CLI)
 * and passes. Returns true when the mutation must be rejected.
 *
 * Shared by the /admin/api/* gate and the /quota/* mutation routes (whose
 * POSTs burn a stockpiled reset / trigger a captcha claim — equally
 * browser-reachable state changes).
 */
export function isCrossOriginMutation(req: Request): boolean {
  const originHeader = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const source = originHeader ?? referer;
  if (!source) return false;
  try {
    const srcHost = new URL(source).hostname; // "127.0.0.1" / "[::1]" / "localhost" / "evil.example"
    const loopbackForms = new Set(["127.0.0.1", "[::1]", "::1", "localhost", "[::ffff:127.0.0.1]"]);
    const isLoopbackOrigin = loopbackForms.has(srcHost) || /^(\[)?::ffff:127\./.test(srcHost);
    const rawHost = req.headers.get("host") ?? "";
    const hostName = rawHost.startsWith("[")
      ? rawHost.slice(1, rawHost.indexOf("]"))
      : rawHost.split(":")[0];
    const matchesHostHeader = hostName !== "" && (srcHost === hostName || srcHost === `[${hostName}]`);
    return !isLoopbackOrigin && !matchesHostHeader;
  } catch {
    // Unparseable Origin/Referer on a mutating request — refuse.
    return true;
  }
}
