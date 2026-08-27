/**
 * HTTP server bootstrap with routing and proxy API key auth.
 * Includes admin dashboard routes.
 *
 * Runs on `node:http.createServer` (not `Bun.serve`) so the same code works
 * on Bun (dev mode, source TS, compiled binaries) and on Node (the Android
 * bundle — libnode via Termux libs). Bun implements `node:http` natively;
 * Node has no `Bun.serve`, so node:http is the common denominator.
 *
 * Migration notes (v0.3.3.0, pattern ported from upstream zcode-api):
 * - `idleTimeout: 0` (old Bun.serve setting) maps to zeroed/raised Node
 *   server timeouts — long LLM reasoning calls must not be killed.
 * - Client IP (previously `Bun.serve#requestIP`) is read from
 *   `req.socket.remoteAddress` in the node adapter and stashed on the Web
 *   Request via a symbol; `resolveClientIp` reads it from there.
 * - `/async/*` routes get a 24h per-request socket timeout (off-peak queue
 *   waits can exceed Node's defaults).
 *
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponses } from "./routes-responses.js";
import { handleAsyncMessages, handleAsyncChat, handleAsyncHealth } from "../async/handler.js";
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
   * node:http closure can wire resolveClientIp), createFetchHandler uses
   * this instance directly instead of building its own. When omitted
   * (used by tests), createFetchHandler builds a fresh AdminOptions with
   * no resolveClientIp — which means loopback detection falls back to
   * the "unknown → allow" path, preserving the legacy test behavior.
   */
  adminOpts?: AdminOptions;
  /**
   * Resolve the TCP-remote client IP for a request. Wired by startServer to
   * the socket remote address captured by the node:http adapter; tests omit
   * it. Used by both the admin loopback gate and the proxy session-fingerprint
   * cache so neither trusts spoofable X-Forwarded-For headers by default.
   */
  resolveClientIp?: (req: Request) => string | undefined;
}

/** Minimal server handle: what the caller needs to print URLs and shut down. */
export interface ProxyServer {
  hostname: string;
  port: number;
  /**
   * Close the server. `force` (default false) = wait for in-flight requests
   * to complete, dropping only idle keep-alive connections (matches the old
   * `Bun.serve#stop(false)` semantics); `force=true` destroys all connections
   * immediately (old `stop(true)`). Resolves once fully closed.
   */
  stop(force?: boolean): Promise<void>;
  /** Alias for stop() — upstream-compatible name. */
  close(): Promise<void>;
}

/** Symbol under which the node:http adapter stashes the TCP peer address. */
const CLIENT_IP: unique symbol = Symbol("clientIp");

/** Create a runtime-agnostic fetch handler (used by node:http adapter and tests). */
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

      // --- Async (off-peak) bridge routes (v0.3.1, upstream 175ff2a) ---
      // "错峰算力" ticket-queue endpoints: the proxy holds the client connection
      // open (SSE keepalives) until an off-peak ticket is ready, then streams the
      // LLM response through. Gated LIVE per-request on config.async.enabled so
      // the dashboard can toggle it without a restart. Requires the active
      // credential to carry a JWT (OAuth / ZCode-imported) — apikey-only
      // accounts get a 400 async_credentials_unavailable from the handler.
      if (config.async.enabled && path.startsWith("/async/")) {
        const asyncOpts = { config, auth, fetchImpl: opts.fetchImpl, debug: config.logging.debug === true };
        if (method === "POST" && path === "/async/v1/messages") {
          return addCorsHeaders(await handleAsyncMessages(req, asyncOpts), req, currentCorsAllow());
        }
        if (method === "POST" && path === "/async/v1/chat/completions") {
          return addCorsHeaders(await handleAsyncChat(req, asyncOpts), req, currentCorsAllow());
        }
        if (method === "GET" && path === "/async/v1/health") {
          return addCorsHeaders(await handleAsyncHealth(req, asyncOpts), req, currentCorsAllow());
        }
        return addCorsHeaders(errorResponse(404, "not_found_error", `No async route for ${method} ${path}`), req, currentCorsAllow());
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

/**
 * Start the HTTP server on node:http. Resolves once the listener is bound.
 *
 * Server timeout policy (mirrors the old `Bun.serve({ idleTimeout: 0 })` for
 * self-hosted long reasoning calls):
 *   - requestTimeout 600s / headersTimeout 600s — generous caps on receiving
 *     a request; the response stream is NOT bounded by these.
 *   - keepAliveTimeout 120s — idle keep-alive sockets close after 2 min.
 *   - `/async/*` requests additionally get a 24h socket timeout so an
 *     off-peak queue wait (which can legitimately take hours) survives.
 */
export function startServer(opts: ServerOptions): Promise<ProxyServer> {
  // Client IP: captured per-request from the node socket by the adapter
  // below (equivalent of Bun.serve's server.requestIP(req)).
  const resolveClientIp = (req: Request): string | undefined =>
    (req as { [CLIENT_IP]?: string })[CLIENT_IP];

  const adminOpts: AdminOptions = {
    config: opts.config,
    auth: opts.auth,
    configPath: opts.configPath ?? "config.yaml",
    startTime: Date.now(),
    fetchImpl: opts.fetchImpl,
    resolveClientIp,
  };

  const handler = createFetchHandler({ ...opts, adminOpts, resolveClientIp });
  const { port: requestedPort, host } = opts.config.server;

  const server: Server = createServer(async (req, res) => {
    // Abort plumbing: when the client disconnects mid-request/mid-stream,
    // abort the Web-level signal so upstream fetches get cancelled.
    const abortController = new AbortController();
    const onClientClose = (): void => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on("close", onClientClose);

    // Off-peak async routes hold the connection open for minutes-to-hours
    // while waiting for a ticket. Lift the per-request socket timeout to 24h
    // (Node's server default would kill it).
    if ((req.url ?? "").startsWith("/async/")) {
      req.setTimeout(24 * 60 * 60 * 1000);
    }

    try {
      const webReq = nodeReqToWebRequest(req, abortController.signal);
      // CORS headers are added inside the handler (see createFetchHandler).
      const resp = await handler(webReq);
      await writeWebResponseToNodeResp(resp, res, abortController.signal);
    } catch (err) {
      if (abortController.signal.aborted) return; // client already gone
      console.error(`[server] request adapter error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal_error", message: (err as Error).message } }));
      } else {
        try { res.end(); } catch { /* already destroyed */ }
      }
    }
  });

  server.requestTimeout = 600_000;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 600_000;

  return new Promise<ProxyServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      const stop = (force = false): Promise<void> => new Promise<void>((done) => {
        // force: destroy all connections now (old Bun stop(true)).
        // graceful: drop idle keep-alives, let in-flight finish (old stop(false)).
        if (force) server.closeAllConnections?.();
        else server.closeIdleConnections?.();
        server.close(() => done());
      });
      resolve({
        hostname: host,
        port: actualPort,
        stop,
        close: () => stop(false),
      });
    });
  });
}

/** Convert a Node.js IncomingMessage to a Web API Request (stashing the TCP peer address). */
function nodeReqToWebRequest(req: IncomingMessage, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }
  const host = headers.get("host") ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  let webReq: Request;
  if (method === "GET" || method === "HEAD") {
    webReq = new Request(url, { method, headers, signal });
  } else {
    // Cast: Node's stream type ≠ Web ReadableStream at the type layer, but
    // Readable.toWeb returns a spec-compliant stream at runtime.
    const bodyStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      body: bodyStream,
      duplex: "half",
      signal,
    };
    webReq = new Request(url, init);
  }
  // Stash the TCP peer address for resolveClientIp (admin loopback gate +
  // session fingerprint cache). Symbol-keyed so it never collides with
  // anything the app layer puts on the Request.
  (webReq as { [CLIENT_IP]?: string })[CLIENT_IP] = req.socket.remoteAddress;
  return webReq;
}

/** Write a Web API Response to a Node.js ServerResponse (stream-aware). */
async function writeWebResponseToNodeResp(
  resp: Response,
  res: ServerResponse,
  abortSignal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  resp.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (typeof existing === "string") {
      headers[key] = [existing, value];
    } else {
      existing.push(value);
    }
  });

  res.writeHead(resp.status, resp.statusText, headers);

  if (resp.body == null) {
    res.end();
    return;
  }

  const reader = resp.body.getReader();
  const onAbort = (): void => { reader.cancel().catch(() => {}); };
  abortSignal?.addEventListener("abort", onAbort);
  try {
    // Backpressure-aware pump: wait for drain when the socket is full.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
  } catch (err) {
    if (abortSignal?.aborted) {
      try { res.end(); } catch { /* client gone */ }
    } else {
      try { res.destroy(err as Error); } catch { /* already destroyed */ }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }
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
