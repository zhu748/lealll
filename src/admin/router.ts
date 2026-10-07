import { errorResponse } from "../proxy/translated-response.js";
import { timingSafeEqual } from "../utils/crypto.js";
import { VERSION } from "../version.js";
import dashboardHtml from "./dashboard.html.txt" with { type: "text" };
import { handleDebugDumpsRoutes } from "./debug-dumps.js";
import { handleLogsRoutes } from "./logs.js";
import { handleOauthRoutes } from "./oauth.js";
import { handleQuotaRoutes } from "./quota.js";
import { handleAccountsRoutes } from "./routes/accounts.js";
import { handleConfigRoutes } from "./routes/config.js";
import { handlePromptRewriteRoutes } from "./routes/prompt-rewrite.js";
import { handleCredentialsRoutes } from "./routes/credentials.js";
import { handleProviderSettingsRoutes } from "./routes/provider-settings.js";
import { handleProxyPoolRoutes } from "./routes/proxy-pool.js";
import {
  clearVerifyFailure,
  isCrossOriginMutation,
  isVerifyLocked,
  jsonResp,
  recordVerifyFailure,
  resolveIpForRateLimit,
  withSecurityHeaders,
} from "./security.js";
import { handleStatsRoutes } from "./stats.js";
import type { AdminOptions, AdminRouteContext, AdminRouteHandler } from "./types.js";

/** Read the bundled dashboard HTML (inlined at build time). */
export function getDashboardHTML(): string {
  return dashboardHtml.replace("__ZCODE_PROXY_VERSION__", VERSION);
}

/** Handle admin API routes. Returns null if the path doesn't match. */
export async function handleAdminRoute(req: Request, opts: AdminOptions): Promise<Response | null> {
  const resp = await handleAdminRouteInner(req, opts);
  if (!resp) return null;
  // Apply security headers to every admin response (dashboard page + API).
  // Skipped for SSE streams (logs/stream) — adding headers post-stream-start
  // is a no-op anyway, and we don't want to interfere with the response
  // once the streaming writer has flushed.
  if (resp.headers.get("content-type")?.includes("text/event-stream")) return resp;
  return withSecurityHeaders(resp);
}

const featureRoutes = new Map<string, AdminRouteHandler>([
  ["config", handleConfigRoutes],
  ["prompt-rewrite", handlePromptRewriteRoutes],
  ["credentials", handleCredentialsRoutes],
  ["accounts", handleAccountsRoutes],
  ["import", handleCredentialsRoutes],
  ["oauth", handleOauthRoutes],
  ["endpoints", handleProviderSettingsRoutes],
  ["routing-rules", handleProviderSettingsRoutes],
  ["model-mappings", handleProviderSettingsRoutes],
  ["glm-models", handleProviderSettingsRoutes],
  ["responses-thinking", handleProviderSettingsRoutes],
  ["stats", handleStatsRoutes],
  ["logs", handleLogsRoutes],
  ["debug-dumps", handleDebugDumpsRoutes],
  ["proxy-pool", handleProxyPoolRoutes],
]);

/** Authorize every API request before dispatching it to a feature handler. */
async function handleAdminRouteInner(req: Request, opts: AdminOptions): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Serve dashboard page
  if (path === "/admin" || path === "/admin/") {
    return new Response(getDashboardHTML(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!path.startsWith("/admin/api/")) return null;

  // With a configured key, /verify must reach its own rate limiter even for
  // wrong tokens. Without a key it shares the loopback gate with every API.
  const isVerifyRouteWithAuth = path === "/admin/api/verify" && opts.config.auth.proxyApiKey;

  // Browsers can send blind cross-site mutations from the operator's own
  // machine. Check Origin/Referer before either auth or feature dispatch;
  // non-browser clients without these headers retain their existing behavior.
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && isCrossOriginMutation(req)) {
    return errorResponse(
      403,
      "cross_origin_blocked",
      `Admin API rejects cross-site ${method} requests (Origin/Referer host mismatch). ` +
      "If you manage the dashboard through a reverse proxy on another origin, add a matching Host header or access it via loopback.",
    );
  }

  if (!isVerifyRouteWithAuth) {
    // Allow SSE endpoints to receive the token via query parameter, since
    // EventSource cannot set custom HTTP headers.
    const authHeader = req.headers.get("authorization") ?? "";
    let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token && path === "/admin/api/logs/stream") {
      token = url.searchParams.get("token") ?? "";
    }

    // An unset API key permits local administration only. Remote clients
    // must configure a key; header-derived client IPs require trustProxy.
    if (!opts.config.auth.proxyApiKey) {
      // Client IP resolution priority:
      //   1. resolveClientIp (Bun's server.requestIP — TCP socket peer,
      //      cannot be spoofed by headers)
      //   2. X-Real-IP / X-Forwarded-For — ONLY when config.server.trustProxy
      //      is true (operator explicitly opted in because they're behind a
      //      trusted reverse proxy that overwrites these headers).
      //   3. "unknown" → defaults to loopback (preserves dev behavior for
      //      direct local connections and for tests that have no socket).
      let remoteIp: string | undefined;
      if (opts.resolveClientIp) {
        try { remoteIp = opts.resolveClientIp(req); } catch { /* ignore */ }
      }
      if (opts.config.server.trustProxy) {
        const xRealIp = req.headers.get("x-real-ip") ?? "";
        const xForwardedFor = req.headers.get("x-forwarded-for") ?? "";
        const xffIp = xRealIp || (xForwardedFor ? xForwardedFor.split(",")[0].trim() : "");
        if (xffIp) remoteIp = xffIp;
      }
      const isLoopback = !remoteIp
        || remoteIp === "127.0.0.1"
        || remoteIp === "::1"
        || remoteIp === "localhost"
        || remoteIp === "::ffff:127.0.0.1";

      if (!isLoopback) {
        // Non-loopback remote + no proxyApiKey configured → reject.
        // Surface a clear message so the operator knows what to fix.
        return errorResponse(
          401,
          "authentication_required",
          "Admin API requires auth.proxyApiKey to be configured when accessed from a non-loopback address. " +
          "Set `auth.proxyApiKey` in config.yaml or env ZCODE_PROXY_API_KEY, then provide it as " +
          "`Authorization: Bearer <key>` on admin API requests.",
        );
      }
      // Loopback + no proxyApiKey → allow (legacy dev behavior).
      // Fall through to per-route logic.
    } else if (!timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
      return errorResponse(401, "authentication_error", "Invalid admin token");
    }
  }

  // --- API Routes ---

  // Verify token
  // Returns {valid: true} when the token matches. When no proxyApiKey is
  // configured the endpoint returns {valid: true, warning: "no_auth"} so
  // the dashboard can surface the security warning to the user instead of
  // silently letting anyone in.
  if (path === "/admin/api/verify" && method === "GET") {
    const clientIp = resolveIpForRateLimit(req, opts);
    // Rate-limit: if this IP has exceeded the failure threshold, reject
    // without even checking the token — prevents timing-based oracle
    // attacks where an attacker could distinguish "locked" vs "wrong"
    // by response time.
    if (isVerifyLocked(clientIp)) {
      return errorResponse(429, "rate_limited", "Too many failed verification attempts. Try again later.");
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!opts.config.auth.proxyApiKey) {
      return jsonResp({ valid: true, warning: "no_auth", message: "proxyApiKey not configured — admin dashboard is open to anyone with network access" });
    }
    if (timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
      // Successful verification clears the failure counter for this IP,
      // so a user who mistypes once doesn't carry a strike forever.
      clearVerifyFailure(clientIp);
      return jsonResp({ valid: true });
    }
    recordVerifyFailure(clientIp);
    return errorResponse(401, "authentication_error", "Invalid token");
  }
  const context: AdminRouteContext = { req, opts, url, path, method };
  if (path === "/admin/api/accounts/quota" && method === "POST") {
    return handleQuotaRoutes(context);
  }
  const area = path.slice("/admin/api/".length).split("/", 1)[0];
  const handler = featureRoutes.get(area);
  return handler ? handler(context) : null;
}
