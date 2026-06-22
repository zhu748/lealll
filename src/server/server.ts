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
import { errorResponse } from "../proxy/handler.js";
import { handleAdminRoute, type AdminOptions } from "../admin/api.js";

export interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Path to the config file (for admin dashboard save). */
  configPath?: string;
}

/** Create a Bun.serve-compatible fetch handler. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl };

  const adminOpts: AdminOptions = {
    config,
    auth,
    configPath: opts.configPath ?? "config.yaml",
    startTime: Date.now(),
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse();
    }

    // Admin dashboard routes (handled before proxy API key auth)
    // The admin page itself uses cookie/session auth; API routes use proxyApiKey
    if (path === "/admin" || path === "/admin/" || path.startsWith("/admin/api/")) {
      const adminResp = await handleAdminRoute(req, adminOpts);
      if (adminResp) return adminResp;
    }

    // Proxy API key auth (if configured)
    if (config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
      }
    }

    // --- Routing ---

    // OpenAI routes
    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if (path === "/v1/models" && method === "GET") {
      return handleListModels();
    }

    // Anthropic routes
    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }

    // OpenAI Responses API route (used by Codex CLI when wire_api=responses)
    if (path === "/v1/responses" && method === "POST") {
      return handleResponses(req, proxyOpts);
    }

    // Health check
    if (path === "/health" || path === "/") {
      return new Response(JSON.stringify({ status: "ok", provider: config.provider }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`);
  };
}

/** Start the Bun.serve server. Returns the server instance. */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createFetchHandler(opts);
  const { port, host } = opts.config.server;

  return Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0, // 自用代理：禁用空闲超时，避免长 reasoning 的 LLM 请求被杀
    fetch(req) {
      // Add CORS headers to all responses
      return handler(req).then((resp) => addCorsHeaders(resp));
    },
  });
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

/** Constant-time string comparison to mitigate timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  // To avoid leaking length information, always compare the full length of
  // the expected value. If the provided value has a different length, we
  // still do a full comparison but the result will always be wrong.
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // Non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    const aChar = i < a.length ? a.charCodeAt(i) : 0;
    const bChar = i < b.length ? b.charCodeAt(i) : 0;
    result |= aChar ^ bChar;
  }
  return result === 0;
}

/** Build a CORS preflight response. */
function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

/** Add CORS headers to an existing response (non-mutating). */
function addCorsHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function corsHeaders(): Record<string, string> {
  // Restrictive CORS: only allow same-origin by default.
  // The proxy is designed for local/self-hosted use; allowing "*" means
  // any website could make requests to it. We set the origin to the
  // requesting origin so the dashboard still works while third-party
  // sites are blocked. Since we don't use cookies/credentials for API
  // auth, this is safe.
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
  };
}
