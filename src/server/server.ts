/**
 * Bun.serve server setup with routing and proxy API key auth.
 * Includes admin dashboard routes.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponses } from "./routes-responses.js";
import { errorResponse } from "../proxy/translated-response.js";
import { handleAdminRoute, type AdminOptions } from "../admin/api.js";
import { timingSafeEqual } from "../utils/crypto.js";

export interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Path to the config file (for admin dashboard save). */
  configPath?: string;
  /**
   * Pre-built admin options. When provided (used by startServer so the
   * Bun.serve closure can wire resolveClientIp), createFetchHandler uses
   * this instance directly instead of building its own. When omitted
   * (used by tests), createFetchHandler builds a fresh AdminOptions with
   * no resolveClientIp — which means loopback detection falls back to
   * the "unknown → allow" path, preserving the legacy test behavior.
   */
  adminOpts?: AdminOptions;
  /**
   * Resolve the TCP-remote client IP for a request. Wired to Bun's
   * `server.requestIP(req)?.address` by startServer; tests omit it.
   * Used by both the admin loopback gate and the proxy session-fingerprint
   * cache so neither trusts spoofable X-Forwarded-For headers by default.
   */
  resolveClientIp?: (req: Request) => string | undefined;
}

/** Create a Bun.serve-compatible fetch handler. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl, resolveClientIp: opts.resolveClientIp };
  const currentCorsAllow = () => config.corsAllowList;

  const adminOpts: AdminOptions = opts.adminOpts ?? {
    config,
    auth,
    configPath: opts.configPath ?? "config.yaml",
    startTime: Date.now(),
    fetchImpl: opts.fetchImpl,
    resolveClientIp: opts.resolveClientIp,
  };

  // Pre-compute the health response body — it only depends on config.provider,
  // which doesn't change between requests (hot-swap of provider updates the
  // config object in place, so we read it lazily inside the handler instead
  // of caching the string — keeps the response correct after hot-swap).
  const healthResponse = (): Response => new Response(
    JSON.stringify({ status: "ok", provider: config.provider }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  // Static route table — O(1) lookup by `${method}:${path}`.
  // Admin routes (/admin, /admin/api/*) are handled separately because they
  // use prefix matching rather than exact match.
  //
  // The Map is built ONCE when createFetchHandler is called — the closures
  // capture `proxyOpts` (which is stable). The per-request `req` is passed as
  // a parameter to each handler, so no mutation is needed.
  type RouteHandler = (req: Request) => Promise<Response> | Response;
  const routes = new Map<string, RouteHandler>([
    ["GET:/health", (req) => addCorsHeaders(healthResponse(), req, currentCorsAllow())],
    ["GET:/healthz", (req) => addCorsHeaders(healthResponse(), req, currentCorsAllow())],
    ["GET:/", (req) => addCorsHeaders(healthResponse(), req, currentCorsAllow())],
    ["GET:/v1/models", (req) => addCorsHeaders(handleListModels(), req, currentCorsAllow())],
    ["POST:/v1/chat/completions", async (req) => addCorsHeaders(await handleChatCompletions(req, proxyOpts), req, currentCorsAllow())],
    ["POST:/v1/messages", async (req) => addCorsHeaders(await handleMessages(req, proxyOpts), req, currentCorsAllow())],
    ["POST:/v1/responses", async (req) => addCorsHeaders(await handleResponses(req, proxyOpts), req, currentCorsAllow())],
  ]);

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS preflight — short-circuit before auth
      if (method === "OPTIONS") {
        return corsResponse(req, currentCorsAllow());
      }

      // Admin dashboard routes (handled before proxy API key auth).
      // Admin page itself is open; API routes use proxyApiKey.
      if (path === "/admin" || path === "/admin/" || path.startsWith("/admin/api/")) {
        const adminResp = await handleAdminRoute(req, adminOpts);
        if (adminResp) return addCorsHeaders(adminResp, req, currentCorsAllow());
      }

      // Health checks are ALWAYS open — Render/Fly/Cloud Run/K8s probes don't
      // send Authorization headers, and returning 401 here causes the platform
      // to mark the service as unhealthy and restart it in a loop. The health
      // response leaks no sensitive info (just `{status:"ok", provider}`).
      // Both `/health` (legacy) and `/healthz` (K8s convention) work.
      if (path === "/health" || path === "/healthz" || path === "/") {
        return addCorsHeaders(healthResponse(), req, currentCorsAllow());
      }

      // Proxy API key auth (if configured) — applies to all non-admin, non-health routes
      if (config.auth.proxyApiKey) {
        const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
        if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
          return addCorsHeaders(errorResponse(401, "authentication_error", "Invalid or missing proxy API key"), req, currentCorsAllow());
        }
      }

      // --- Static route lookup (O(1)) ---
      const handler = routes.get(`${method}:${path}`);
      if (handler) {
        return await handler(req);
      }

      return addCorsHeaders(errorResponse(404, "not_found_error", `No route for ${method} ${path}`), req, currentCorsAllow());
    } catch (err) {
      const message = (err as Error).message || "Unhandled server error";
      console.error(`[server] unhandled request error: ${message}`);
      return addCorsHeaders(errorResponse(500, "internal_server_error", message), req, currentCorsAllow());
    }
  };
}

/** Start the Bun.serve server. Returns the server instance. */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  // Forward-declare `server` so the resolveClientIp closure can reference it.
  // The closure is only invoked from inside `fetch(req)`, which only runs
  // AFTER Bun.serve returns and assigns to `server` — so the closure always
  // sees a defined value at call time.
  let server: ReturnType<typeof Bun.serve> | undefined;

  // Wire up the client-IP resolver so admin routes AND the proxy session
  // fingerprint can read the real TCP peer address (Bun's server.requestIP)
  // instead of trusting spoofable X-Forwarded-For headers.
  const resolveClientIp = (req: Request): string | undefined => {
    try { return server?.requestIP(req)?.address; } catch { return undefined; }
  };

  const adminOpts: AdminOptions = {
    config: opts.config,
    auth: opts.auth,
    configPath: opts.configPath ?? "config.yaml",
    startTime: Date.now(),
    fetchImpl: opts.fetchImpl,
    resolveClientIp,
  };

  const handler = createFetchHandler({ ...opts, adminOpts, resolveClientIp });
  const { port, host } = opts.config.server;

  server = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0, // 自用代理：禁用空闲超时，避免长 reasoning 的 LLM 请求被杀
    fetch(req) {
      // CORS headers are already added inside the handler (see
      // createFetchHandler) — no need to add them again here.
      return handler(req);
    },
  });
  return server;
}

/**
 * Check whether the client provided the correct proxy API key.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function checkProxyKey(authHeader: string, expected: string): boolean {
  // Accept "Bearer {key}" or bare key
  const trimmed = authHeader.trim();
  let provided: string;
  if (trimmed.startsWith("Bearer ")) {
    provided = trimmed.slice(7).trim();
  } else {
    provided = trimmed;
  }
  return timingSafeEqual(provided, expected);
}

/** Build a CORS preflight response. */
function corsResponse(req: Request, allowList?: string[]): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req, allowList),
  });
}

/** Add CORS headers to an existing response (non-mutating). */
function addCorsHeaders(resp: Response, req: Request, allowList?: string[]): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(req, allowList))) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function corsHeaders(req: Request, allowList?: string[]): Record<string, string> {
  // CORS policy:
  //   1. No Origin header (server-to-server / curl) → return "*" for
  //      compatibility with simple clients. No browser involved, so the
  //      CORS check doesn't apply.
  //   2. Origin present + allowlist configured → echo Origin ONLY if it's
  //      in the allowlist (case-insensitive). Otherwise "null".
  //   3. Origin present + NO allowlist → return "null" (deny by default).
  //      Previous versions echoed any Origin here for backwards compat,
  //      but that defeated the purpose of CORS for users who hadn't read
  //      the docs. The secure default is to deny; operators who want to
  //      allow a specific frontend must set ZCODE_PROXY_CORS_ALLOWLIST.
  //
  // We do NOT use Access-Control-Allow-Credentials, so cookies are not sent
  // cross-origin — API auth is via Authorization header only.
  const origin = req.headers.get("origin");
  let allowOrigin: string;
  if (!origin) {
    allowOrigin = "*";
  } else if (allowList && allowList.length > 0) {
    // Allowlist configured — only echo if origin is in the list (case-insensitive).
    allowOrigin = allowList.some(o => o.toLowerCase() === origin.toLowerCase()) ? origin : "null";
  } else {
    // No allowlist configured — secure default: deny cross-origin browser
    // access. Server-to-server clients (no Origin header) still work via
    // the "*" branch above. Operators who need browser access from a
    // specific origin must set ZCODE_PROXY_CORS_ALLOWLIST.
    allowOrigin = "null";
  }
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}
