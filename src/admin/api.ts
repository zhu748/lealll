/**
 * Admin dashboard API routes — provides CRUD endpoints for the web UI.
 *
 * All routes require the proxy API key (same key used by API clients).
 * Mounted under /admin/api/* in server.ts.
 */
import type { ProxyConfig, RoutingRule } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential as AppCredential } from "../auth/types.js";
import { loadCredential, saveCredential, clearCredential, listAccounts, switchAccount, removeAccount, setAccountLabel, maskApiKey } from "../auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { errorResponse } from "../proxy/handler.js";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { stringify as stringifyYaml } from "yaml";

export interface AdminOptions {
  config: ProxyConfig;
  auth: AuthManager;
  configPath: string;
  startTime: number;
}

// In-memory stats collector
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  retried: 0,
  requests: [] as Array<{ id: string; time: string; model: string; status: number; ttfb: string; tokens: string }>,
  models: {} as Record<string, { count: number; avgTtfb: number; tokens: number }>,
};

/** Record a request for stats. Called from handler.ts printRow. */
export function recordStat(entry: { id: string; time: string; model: string; status: number; ttfb: string; tokens: string; retried?: boolean }) {
  stats.total++;
  if (entry.status >= 200 && entry.status < 300) stats.success++;
  else stats.failed++;
  if (entry.retried) stats.retried++;
  stats.requests.push(entry);
  if (stats.requests.length > 200) stats.requests = stats.requests.slice(-100);
  const m = stats.models[entry.model] ?? { count: 0, avgTtfb: 0, tokens: 0 };
  m.count++;
  const ttfbMs = parseInt(entry.ttfb) || 0;
  m.avgTtfb = Math.round((m.avgTtfb * (m.count - 1) + ttfbMs) / m.count);
  m.tokens += parseInt(entry.tokens) || 0;
  stats.models[entry.model] = m;
}

// Active OAuth flows (in-memory)
const activeFlows = new Map<string, { provider: string; flowId: string; pollToken: string; expiresAt: number; plan?: string }>();

// Log buffer for streaming — uses a fixed-size ring buffer to avoid
// expensive splice(0, N) operations on large arrays.
const LOG_BUFFER_SIZE = 2000;
const LOG_BUFFER_TRIM = 1000; // trim to this size when capacity is reached
const logBuffer: Array<{ time: string; level: string; message: string }> = [];
let logBufferStart = 0; // virtual start index for tracking client positions
const logWaiters: Array<{ resolve: (value: unknown) => void }> = [];

/** Add a log entry to the buffer (called by intercepting console.log). */
export function appendLog(level: string, message: string) {
  const entry = { time: new Date().toISOString().slice(11, 19), level, message: message.slice(0, 500) };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    // Efficient: remove in bulk instead of one-by-one splice
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_TRIM);
    logBufferStart += LOG_BUFFER_SIZE - LOG_BUFFER_TRIM;
  }
  // Wake up any waiting SSE connections
  while (logWaiters.length > 0) {
    logWaiters.shift()!.resolve(entry);
  }
}

/** Read the bundled dashboard HTML (cached after first read). */
let _dashboardHtml: string | null = null;
export function getDashboardHTML(): string {
  if (!_dashboardHtml) {
    const htmlPath = join(import.meta.dir, "dashboard.html");
    _dashboardHtml = readFileSync(htmlPath, "utf-8");
  }
  return _dashboardHtml;
}

/** Handle admin API routes. Returns null if the path doesn't match. */
export async function handleAdminRoute(req: Request, opts: AdminOptions): Promise<Response | null> {
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

  // Verify auth token for API routes
  if (path.startsWith("/admin/api/") && path !== "/admin/api/verify") {
    // Allow SSE endpoints to receive the token via query parameter, since
    // EventSource cannot set custom HTTP headers.
    const authHeader = req.headers.get("authorization") ?? "";
    let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token && path === "/admin/api/logs/stream") {
      token = url.searchParams.get("token") ?? "";
    }
    if (opts.config.auth.proxyApiKey && token !== opts.config.auth.proxyApiKey) {
      return errorResponse(401, "authentication_error", "Invalid admin token");
    }
  }

  // --- API Routes ---

  // Verify token
  if (path === "/admin/api/verify" && method === "GET") {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!opts.config.auth.proxyApiKey || token === opts.config.auth.proxyApiKey) {
      return jsonResp({ valid: true });
    }
    return errorResponse(401, "authentication_error", "Invalid token");
  }

  // Get config
  if (path === "/admin/api/config" && method === "GET") {
    return jsonResp(sanitizeConfig(opts.config));
  }

  // Update config
  if (path === "/admin/api/config" && method === "PUT") {
    try {
      const body = await req.json() as Record<string, unknown>;
      // Prevent masked placeholder values from overwriting real secrets.
      // The sanitizeConfig() GET endpoint returns "***configured***" for
      // secret fields; if the dashboard sends those back unchanged we skip them.
      const MASK = "***configured***";
      const authBody = body.auth as Record<string, unknown> | undefined;
      if (authBody) {
        if (authBody.apiKey === MASK || authBody.apiKey === "") delete authBody.apiKey;
        if (authBody.proxyApiKey === MASK || authBody.proxyApiKey === "") delete authBody.proxyApiKey;
      }
      const newConfig = { ...opts.config, ...body };
      // Merge auth separately to avoid losing fields not sent by the dashboard
      if (authBody) {
        newConfig.auth = { ...opts.config.auth, ...authBody };
      }
      // Validate the merged config before persisting
      validateConfigForSave(newConfig);
      const yaml = configToYaml(newConfig as ProxyConfig);
      await writeFile(opts.configPath, yaml, "utf-8");
      appendLog("info", "Configuration updated via admin dashboard");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get credentials (active credential summary)
  if (path === "/admin/api/credentials" && method === "GET") {
    const cred = await loadCredential();
    if (!cred) return jsonResp({ credential: null });
    return jsonResp({
      credential: {
        provider: cred.provider,
        apiKeyMask: maskApiKey(cred.apiKey),
        hasSecret: !!cred.secret,
        userId: cred.userId,
        expiresAt: cred.expiresAt,
        mode: opts.config.auth.mode,
        plan: cred.plan || "coding-plan",
      },
    });
  }

  // Add API key
  if (path === "/admin/api/credentials" && method === "POST") {
    try {
      const body = await req.json() as { provider: string; apiKey: string; plan?: string };
      const plan = (body.plan === "start-plan" ? "start-plan" : "coding-plan") as "coding-plan" | "start-plan";
      const cred = { apiKey: body.apiKey, provider: body.provider as "zai" | "bigmodel", plan } as AppCredential;
      await saveCredential(cred);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Clear credentials
  if (path === "/admin/api/credentials" && method === "DELETE") {
    clearCredential();
    return jsonResp({ ok: true });
  }

  // List all stored accounts (multi-account support)
  if (path === "/admin/api/accounts" && method === "GET") {
    const result = await listAccounts();
    return jsonResp(result);
  }

  // Switch active account
  if (path === "/admin/api/accounts/active" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string };
      if (!body.id) return errorResponse(400, "missing_param", "id is required");
      const ok = await switchAccount(body.id);
      if (!ok) return errorResponse(404, "not_found", "Account not found");
      // Hot-swap the in-memory credential and sync plan
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        // Sync config.plan to match the account's plan
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Switched active account to ${body.id}`);
      return jsonResp({ ok: true, plan: cred?.plan || opts.config.plan });
    } catch (err) {
      return errorResponse(500, "switch_failed", (err as Error).message);
    }
  }

  // Update account label
  if (path === "/admin/api/accounts/label" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; label?: string };
      if (!body.id || typeof body.label !== "string") {
        return errorResponse(400, "missing_param", "id and label are required");
      }
      const ok = await setAccountLabel(body.id, body.label);
      if (!ok) return errorResponse(404, "not_found", "Account not found");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Delete an account
  if (path.startsWith("/admin/api/accounts/") && method === "DELETE") {
    const id = path.slice("/admin/api/accounts/".length);
    if (!id) return errorResponse(400, "missing_param", "account id required");
    const ok = await removeAccount(id);
    if (!ok) return errorResponse(404, "not_found", "Account not found");
    // Hot-swap the in-memory credential if active changed
    const cred = await loadCredential();
    if (cred) opts.auth.setOAuthCredential(cred);
    appendLog("info", `Removed account ${id}`);
    return jsonResp({ ok: true });
  }

  // Import from ZCode
  if (path === "/admin/api/import" && method === "POST") {
    try {
      const body = await req.json() as { provider: string; plan?: string };
      const provider = body.provider as "zai" | "bigmodel";
      const plan = (body.plan === "start-plan" ? "start-plan" : "coding-plan") as "coding-plan" | "start-plan";
      const cred = importFromZCodeConfig(provider, plan);
      await saveCredential(cred);
      return jsonResp({ ok: true, apiKeyMask: maskApiKey(cred.apiKey), plan: cred.plan });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // OAuth init
  if (path === "/admin/api/oauth/init" && method === "POST") {
    try {
      const body = await req.json() as { provider: string; plan?: string };
      const provider = body.provider as "zai" | "bigmodel";
      const oauthPlan = (body.plan === "start-plan" ? "start-plan" : "coding-plan") as "coding-plan" | "start-plan";

      if (provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        const { authorizeUrl, callbackUrl, state } = await oauth.start();
        // Store flow info for polling
        const flowId = `bm_${state.slice(0, 16)}`;
        activeFlows.set(flowId, {
          provider,
          flowId,
          pollToken: state,
          expiresAt: Date.now() + 300_000,
          // Store the localhost callback URL & state for manual callback exchange path
          callbackUrl,
          state,
          plan: oauthPlan,
        } as any);
        // Start background process to wait for callback
        (async () => {
          try {
            const authCode = await oauth.waitForCallback(300_000);
            const { accessToken, userId, jwt } = await oauth.exchangeCode(authCode, callbackUrl, state);
            const resolver = new KeyResolver();
            const cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId, oauthPlan);
            if (jwt) cred.jwt = jwt;
            await saveCredential(cred);
            // Mark flow as ready
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "ready"; }
            await oauth.close();
          } catch (err) {
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
            try { await oauth.close(); } catch (e) { appendLog("debug", `oauth.close() cleanup failed: ${(e as Error).message}`); }
          }
        })();
        return jsonResp({ flowId, authorizeUrl });
      }

      // Z.AI OAuth
      const oauth = new ZaiOAuthClient();
      const init = await oauth.init("zai");
      activeFlows.set(init.flowId, { provider, flowId: init.flowId, pollToken: init.pollToken, expiresAt: init.expiresAt, plan: oauthPlan });
      // Background poll
      (async () => {
        try {
          const result = await oauth.waitForAuth(init);
          const resolver = new KeyResolver();
          const cred = await resolver.resolveCodingPlanCredential(result.accessToken, provider, result.userId, oauthPlan);
          if (result.jwt) cred.jwt = result.jwt;
          await saveCredential(cred);
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "ready"; }
        } catch (err) {
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
        }
      })();
      return jsonResp({ flowId: init.flowId, authorizeUrl: init.authorizeUrl });
    } catch (err) {
      return errorResponse(500, "oauth_init_failed", (err as Error).message);
    }
  }

  // OAuth poll
  if (path === "/admin/api/oauth/poll" && method === "GET") {
    const flowId = url.searchParams.get("flowId");
    if (!flowId) return errorResponse(400, "missing_param", "flowId required");
    const flow = activeFlows.get(flowId);
    if (!flow) return errorResponse(404, "not_found", "Unknown flow");
    const status = (flow as any).status || "pending";
    if (status === "ready") activeFlows.delete(flowId);
    if (status === "failed") activeFlows.delete(flowId);
    return jsonResp({ status });
  }

  // OAuth manual callback URL submission
  // User pastes the redirected browser URL (containing ?code=...&state=...) after authorizing
  if (path === "/admin/api/oauth/callback" && method === "POST") {
    try {
      const body = await req.json() as { flowId?: string; callbackUrl?: string };
      const flowId = body.flowId;
      const callbackUrl = body.callbackUrl ?? "";

      if (!flowId || !callbackUrl) {
        return errorResponse(400, "missing_param", "flowId and callbackUrl are required");
      }

      const flow = activeFlows.get(flowId);
      if (!flow) {
        return errorResponse(404, "flow_not_found", "Unknown or expired OAuth flow. Please restart the login.");
      }
      if (Date.now() > flow.expiresAt) {
        activeFlows.delete(flowId);
        return errorResponse(410, "flow_expired", "OAuth flow has expired. Please restart the login.");
      }

      // Parse the callback URL to extract code & state (used as authorization confirmation)
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(callbackUrl);
      } catch {
        return errorResponse(400, "invalid_url", "Callback URL is not a valid URL.");
      }

      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      if (!code || !state) {
        return errorResponse(400, "invalid_callback", "Callback URL missing 'code' or 'state' parameter.");
      }

      // Now poll the Z.AI OAuth endpoint — the flow should be ready since the user has authorized
      if (flow.provider === "zai") {
        const oauth = new ZaiOAuthClient();
        let pollResult;
        // Try polling a few times in case the server hasn't fully processed the callback yet
        for (let attempt = 0; attempt < 5; attempt++) {
          pollResult = await oauth.poll(flow.flowId, flow.pollToken);
          if (pollResult.status === "ready") break;
          if (pollResult.status === "failed") {
            activeFlows.delete(flowId);
            return errorResponse(400, "oauth_failed", "Authorization was rejected or failed on the server side.");
          }
          // pending -> wait briefly and retry
          await new Promise(r => setTimeout(r, 1500));
        }

        if (!pollResult || pollResult.status !== "ready") {
          return errorResponse(408, "oauth_timeout", "Authorization not yet detected. Please verify you completed the authorization in the browser and try again.");
        }

        const accessToken = pollResult.zai?.access_token ?? pollResult.token;
        if (!accessToken || typeof accessToken !== "string") {
          return errorResponse(500, "oauth_no_token", "OAuth completed but no access_token was returned.");
        }

        const resolver = new KeyResolver();
        const flowPlan = (flow as any).plan as "coding-plan" | "start-plan" | undefined;
        const cred = await resolver.resolveCodingPlanCredential(accessToken, "zai", pollResult.userId, flowPlan);
        if (pollResult.token) cred.jwt = pollResult.token;
        await saveCredential(cred);

        activeFlows.delete(flowId);
        return jsonResp({
          ok: true,
          provider: "zai",
          apiKeyMask: maskApiKey(cred.apiKey),
          userId: cred.userId,
        });
      }

      // For bigmodel: the callback URL points to localhost (which the user can't reach
      // from a remote browser), so we still need to manually exchange the code via
      // zcode.z.ai proxy. Extract the code and call exchangeCode with the original
      // callback URL stored on the flow.
      if (flow.provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        // The original callbackUrl stored on the flow is the localhost URL we
        // registered at start() time — we need it for the token exchange.
        const storedCallbackUrl = (flow as any).callbackUrl;
        if (!storedCallbackUrl) {
          return errorResponse(500, "missing_callback", "Original localhost callback URL not found. Please restart the login.");
        }
        const { accessToken, userId, jwt } = await oauth.exchangeCode(code, storedCallbackUrl, state);
        const resolver = new KeyResolver();
        const flowPlan = (flow as any).plan as "coding-plan" | "start-plan" | undefined;
        const cred = await resolver.resolveCodingPlanCredential(accessToken, "bigmodel", userId, flowPlan);
        if (jwt) cred.jwt = jwt;
        await saveCredential(cred);

        activeFlows.delete(flowId);
        return jsonResp({
          ok: true,
          provider: "bigmodel",
          apiKeyMask: maskApiKey(cred.apiKey),
          userId: cred.userId,
        });
      }

      return errorResponse(400, "unsupported_provider", `Provider ${flow.provider} does not support callback URL exchange.`);
    } catch (err) {
      return errorResponse(500, "oauth_callback_failed", (err as Error).message);
    }
  }

  // Update endpoints
  if (path === "/admin/api/endpoints" && method === "PUT") {
    try {
      const body = await req.json() as { zai?: Record<string, string>; bigmodel?: Record<string, string> };
      if (body.zai) Object.assign(opts.config.providers.zai, body.zai);
      if (body.bigmodel) Object.assign(opts.config.providers.bigmodel, body.bigmodel);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get routing rules
  if (path === "/admin/api/routing-rules" && method === "GET") {
    return jsonResp({ rules: opts.config.routingRules ?? [] });
  }

  // Update routing rules (full replace)
  if (path === "/admin/api/routing-rules" && method === "PUT") {
    try {
      const body = await req.json() as { rules?: Array<{ pattern?: string; provider?: string; endpoint?: string; note?: string }> };
      if (!Array.isArray(body.rules)) {
        return errorResponse(400, "invalid_request", "rules must be an array");
      }
      // Validate & normalize
      const cleaned: RoutingRule[] = [];
      for (const r of body.rules) {
        if (typeof r.pattern !== "string" || r.pattern.trim() === "") {
          return errorResponse(400, "invalid_rule", "Each rule needs a non-empty 'pattern'");
        }
        if (r.provider !== "zai" && r.provider !== "bigmodel") {
          return errorResponse(400, "invalid_rule", `Rule '${r.pattern}' has invalid provider (must be 'zai' or 'bigmodel')`);
        }
        cleaned.push({
          pattern: r.pattern.trim(),
          provider: r.provider,
          endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : undefined,
          note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
        });
      }
      opts.config.routingRules = cleaned;
      // Persist
      const yaml = configToYaml(opts.config);
      await writeFile(opts.configPath, yaml, "utf-8");
      appendLog("info", `Routing rules updated (${cleaned.length} rule(s))`);
      return jsonResp({ ok: true, rules: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get stats
  if (path === "/admin/api/stats" && method === "GET") {
    return jsonResp({
      ...stats,
      uptime: Date.now() - opts.startTime,
    });
  }

  // Reset stats
  if (path === "/admin/api/stats" && method === "DELETE") {
    stats.total = 0;
    stats.success = 0;
    stats.failed = 0;
    stats.retried = 0;
    stats.requests = [];
    stats.models = {};
    appendLog("info", "Stats reset by admin");
    return jsonResp({ ok: true });
  }

  // Log stream (SSE)
  if (path === "/admin/api/logs/stream" && method === "GET") {
    let sentIndex = 0; // Track how many buffered entries we've already sent
    let cleanup: (() => void) | null = null;
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (entry: { time: string; level: string; message: string }) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
          } catch { /* SSE controller may be closed; safe to ignore */ }
        };

        // Send existing buffered logs first
        const initial = logBuffer.slice();
        sentIndex = logBuffer.length;
        for (const entry of initial) send(entry);

        // Set up a waiter so new entries are pushed immediately
        const waiter = { resolve: (value: unknown) => void 0 };
        logWaiters.push(waiter);

        // Polling fallback: check for any new entries every 500ms
        const interval = setInterval(() => {
          while (sentIndex < logBuffer.length) {
            send(logBuffer[sentIndex]);
            sentIndex++;
          }
        }, 500);

        // Safety timeout: close after 1 hour
        const maxTimeout = setTimeout(() => {
          doCleanup();
          try { controller.close(); } catch { /* already closed */ }
        }, 3600000);

        const doCleanup = () => {
          clearInterval(interval);
          clearTimeout(maxTimeout);
          const idx = logWaiters.indexOf(waiter);
          if (idx >= 0) logWaiters.splice(idx, 1);
        };
        cleanup = doCleanup;
      },
      cancel() {
        // Cleanup if the client disconnects early
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        // Disable Nagle's algorithm for snappier streaming
        "x-accel-buffering": "no",
      },
    });
  }

  // Get logs (batch)
  if (path === "/admin/api/logs" && method === "GET") {
    const level = url.searchParams.get("level");
    const search = url.searchParams.get("search")?.toLowerCase();
    let logs = logBuffer;
    if (level) logs = logs.filter(l => l.level === level);
    if (search) logs = logs.filter(l => l.message.toLowerCase().includes(search));
    return jsonResp({ logs: logs.slice(-200) });
  }

  return null; // Not an admin route
}

// --- Helpers ---

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sanitizeConfig(config: ProxyConfig): Record<string, unknown> {
  return {
    server: config.server,
    provider: config.provider,
    plan: config.plan,
    auth: {
      mode: config.auth.mode,
      // Don't expose full API key, just indicate presence
      apiKey: config.auth.apiKey ? "***configured***" : "",
      proxyApiKey: config.auth.proxyApiKey ? "***configured***" : "",
    },
    providers: config.providers,
    defaultModel: config.defaultModel,
    models: config.models,
    identity: config.identity,
    logging: config.logging,
    retry: config.retry,
    routingRules: config.routingRules ?? [],
  };
}

function configToYaml(config: ProxyConfig): string {
  // Build a plain object preserving insertion order matching config.example.yaml,
  // then let the `yaml` library handle quoting/indentation/escape correctly.
  // This keeps values with special chars (colons, leading spaces, quotes) safe
  // and avoids the brittle manual string concatenation that previously broke on
  // URLs containing ':' and other reserved characters.
  const obj: Record<string, unknown> = {
    server: { port: config.server.port, host: config.server.host },
    auth: {
      mode: config.auth.mode,
      ...(config.auth.apiKey ? { apiKey: config.auth.apiKey } : {}),
      ...(config.auth.proxyApiKey ? { proxyApiKey: config.auth.proxyApiKey } : {}),
    },
    provider: config.provider,
    plan: config.plan,
    providers: {
      zai: {
        anthropicBase: config.providers.zai.anthropicBase,
        openaiBase: config.providers.zai.openaiBase,
        ...(config.providers.zai.credential ? { credential: config.providers.zai.credential } : {}),
      },
      bigmodel: {
        anthropicBase: config.providers.bigmodel.anthropicBase,
        openaiBase: config.providers.bigmodel.openaiBase,
        ...(config.providers.bigmodel.credential ? { credential: config.providers.bigmodel.credential } : {}),
      },
    },
    defaultModel: config.defaultModel,
    models: config.models,
    identity: { ...config.identity },
    logging: { ...config.logging },
    retry: { ...config.retry, retryableStatuses: [...config.retry.retryableStatuses] },
    ...(config.routingRules && config.routingRules.length > 0
      ? { routingRules: config.routingRules.map(r => ({
          pattern: r.pattern,
          provider: r.provider,
          ...(r.endpoint ? { endpoint: r.endpoint } : {}),
          ...(r.note ? { note: r.note } : {}),
        })) }
      : {}),
  };

  return stringifyYaml(obj, {
    indent: 2,
    lineWidth: 0,        // Don't wrap long strings (URLs, API keys)
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    nullStr: "",
  });
}

function importFromZCodeConfig(provider: string, plan: "coding-plan" | "start-plan" = "coding-plan"): AppCredential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(configPath)) throw new Error("ZCode config not found at " + configPath);
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };

  // Read both plan keys from ZCode config
  const codingPlanKey = `builtin:${provider}-coding-plan`;
  const startPlanKey = `builtin:${provider}-start-plan`;
  const codingPlanApiKey = config.provider?.[codingPlanKey]?.options?.apiKey?.trim() || "";
  const startPlanToken = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || "";

  if (plan === "start-plan") {
    if (!startPlanToken && !codingPlanApiKey) {
      throw new Error(`No credential found for ${provider} in ZCode config. Tried: ${codingPlanKey}, ${startPlanKey}`);
    }
    const apiKey = codingPlanApiKey || startPlanToken;
    const jwt = startPlanToken || undefined;
    return { apiKey, provider: provider as "zai" | "bigmodel", plan, jwt };
  }

  // coding-plan: primary credential is the API key
  if (!codingPlanApiKey) {
    const hint = startPlanToken ? ` Found a start-plan token — import with plan=start-plan instead.` : "";
    throw new Error(`No API key for ${codingPlanKey} in ZCode config.${hint}`);
  }
  const jwt = startPlanToken || undefined;
  return { apiKey: codingPlanApiKey, provider: provider as "zai" | "bigmodel", plan, jwt };
}

/** Basic validation for config saves from the dashboard. Throws on invalid input. */
function validateConfigForSave(cfg: Record<string, unknown>): void {
  const server = cfg.server as Record<string, unknown> | undefined;
  if (server) {
    const port = typeof server.port === "number" ? server.port : parseInt(String(server.port), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`server.port ${port} is out of range (1-65535)`);
    }
  }
  const provider = cfg.provider as string | undefined;
  if (provider && provider !== "zai" && provider !== "bigmodel") {
    throw new Error(`Invalid provider "${provider}": must be "zai" or "bigmodel"`);
  }
  const plan = cfg.plan as string | undefined;
  if (plan && plan !== "coding-plan" && plan !== "start-plan") {
    throw new Error(`Invalid plan "${plan}": must be "coding-plan" or "start-plan"`);
  }
}
