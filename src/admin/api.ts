/**
 * Admin dashboard API routes — provides CRUD endpoints for the web UI.
 *
 * All routes require the proxy API key (same key used by API clients).
 * Mounted under /admin/api/* in server.ts.
 */
import type { ProxyConfig, RoutingRule, ModelMapping, ResponsesThinkingConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential as AppCredential } from "../auth/types.js";
import { loadCredential, saveCredential, clearCredential, listAccounts, switchAccount, removeAccount, setAccountLabel, setAccountPlan, exportAccounts, importAccounts, maskApiKey } from "../auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { errorResponse } from "../proxy/handler.js";
import { timingSafeEqual } from "../utils/crypto.js";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { MODELS as GLM_CATALOG } from "../provider/models.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
// Inline the dashboard HTML at build time so it works inside a
// `bun build --compile` single-file executable. Runtime `readFileSync`
// would resolve to the exe's virtual root (e.g. B:\~BUN\root\) and fail
// with ENOENT because dashboard.html is not shipped next to the exe.
import dashboardHtml from "./dashboard.html.txt" with { type: "text" };

export interface AdminOptions {
  config: ProxyConfig;
  auth: AuthManager;
  configPath: string;
  startTime: number;
}

// In-memory stats collector.
//
// `requestIndex` is a Map<id, idx> kept alongside `stats.requests` so that
// dedup lookups (recordStat called with an id we've already seen on the retry
// path) are O(1) instead of O(n). At 200 entries × 100 req/s the old findIndex
// approach ran 20k string compares/sec; the Map version runs 100.
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  retried: 0,
  requests: [] as Array<{ id: string; time: string; model: string; status: number; ttfb: string; tokens: string; retried?: boolean }>,
  models: {} as Record<string, { count: number; avgTtfb: number; tokens: number }>,
};
const requestIndex = new Map<string, number>();

/**
 * Record a request for stats. Called from handler.ts printRow.
 *
 * Dedup: each request id is recorded at most once. Subsequent calls with
 * the same id (e.g. when printRow fires on the retry path) only refresh
 * the existing entry's status/tokens — they do NOT inflate the counters.
 * This fixes the previous bug where a single 529-then-200 request would
 * show up as 2 requests in the stats.
 */
export function recordStat(entry: { id: string; time: string; model: string; status: number; ttfb: string; tokens: string; retried?: boolean }) {
  const existingIdx = requestIndex.get(entry.id);
  if (existingIdx !== undefined) {
    // Update the existing entry — do NOT increment counters again.
    const old = stats.requests[existingIdx];
    // Re-classify if the status changed (e.g. 529 → 200 after retry).
    const wasSuccess = old.status >= 200 && old.status < 300;
    const isSuccess = entry.status >= 200 && entry.status < 300;
    if (wasSuccess !== isSuccess) {
      if (isSuccess) { stats.failed--; stats.success++; }
      else { stats.success--; stats.failed++; }
    }
    // Always count retry flag — the final entry wins.
    if (entry.retried && !old.retried) stats.retried++;
    stats.requests[existingIdx] = { ...old, ...entry, retried: entry.retried || old.retried };
    return;
  }

  const idx = stats.requests.length;
  stats.total++;
  if (entry.status >= 200 && entry.status < 300) stats.success++;
  else stats.failed++;
  if (entry.retried) stats.retried++;
  stats.requests.push(entry);
  requestIndex.set(entry.id, idx);
  if (stats.requests.length > 200) {
    // Drop the oldest 100 entries; rebuild the index from the survivors.
    stats.requests = stats.requests.slice(-100);
    requestIndex.clear();
    for (let i = 0; i < stats.requests.length; i++) {
      requestIndex.set(stats.requests[i].id, i);
    }
  }
  const m = stats.models[entry.model] ?? { count: 0, avgTtfb: 0, tokens: 0 };
  m.count++;
  const ttfbMs = parseInt(entry.ttfb) || 0;
  m.avgTtfb = Math.round((m.avgTtfb * (m.count - 1) + ttfbMs) / m.count);
  m.tokens += parseInt(entry.tokens) || 0;
  stats.models[entry.model] = m;
}

/**
 * Reset the in-memory stats collector. Exposed for unit tests so they can
 * start from a clean state without polluting each other. Not part of the
 * public API — production callers should use `DELETE /admin/api/stats`.
 * @internal
 */
export function _resetStatsForTesting(): void {
  stats.total = 0;
  stats.success = 0;
  stats.failed = 0;
  stats.retried = 0;
  stats.requests = [];
  stats.models = {};
  requestIndex.clear();
}

// Active OAuth flows (in-memory)
const activeFlows = new Map<string, { provider: string; flowId: string; pollToken: string; expiresAt: number; plan?: string; status?: string; error?: string; callbackUrl?: string; state?: string }>();

/**
 * Periodic cleanup of expired OAuth flows. Without this, abandoned flows
 * (user closed the browser without finishing auth) would accumulate in
 * memory forever — each one carries the pollToken and callbackUrl, both
 * sensitive-ish. Runs every 5 minutes; flows expire 5 minutes after their
 * expiresAt timestamp to give in-flight poll requests a chance to drain.
 */
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, flow] of activeFlows) {
    if (now > flow.expiresAt + 5 * 60_000) {
      activeFlows.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    appendLog("debug", `OAuth flow cleanup: removed ${cleaned} expired flow(s)`);
  }
}, 5 * 60_000).unref?.();

// ---------------------------------------------------------------------------
// Debug dump ring buffer (replaces the old writeFileSync-to-disk approach).
// Upstream 4xx bodies used to be written to <cwd>/zcode-proxy-debug-*.json,
// which leaked user conversation content to disk forever. Now we keep the
// last 20 dumps in memory and expose them via /admin/api/debug-dumps.
// ---------------------------------------------------------------------------
const DEBUG_DUMP_LIMIT = 20;
const debugDumps: Array<{
  id: string;
  time: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}> = [];

/**
 * Record a 4xx upstream response's transformed body for diagnostics.
 * Called from handler.ts when upstream returns 4xx.
 */
export function recordDebugDump(entry: {
  id: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}): void {
  debugDumps.push({
    ...entry,
    time: new Date().toISOString().slice(11, 19),
  });
  if (debugDumps.length > DEBUG_DUMP_LIMIT) {
    debugDumps.splice(0, debugDumps.length - DEBUG_DUMP_LIMIT);
  }
}

/** Clear all debug dumps. */
export function clearDebugDumps(): void {
  debugDumps.length = 0;
}

// ---------------------------------------------------------------------------
// Config persistence — atomic writes + mutex serialization.
//
// The dashboard allows concurrent edits (multiple tabs, multiple users on a
// LAN). Without serialization, two PUTs race: last write wins, losing one of
// the changes. The mutex serializes all config mutations so they apply in
// arrival order.
//
// Writes are also atomic: write to {path}.{pid}.tmp-{ts} then rename. A crash
// between truncate and full write of a non-atomic writeFile leaves a partial
// YAML file; on next startup loadConfig throws and the user is locked out of
// their own config.
// ---------------------------------------------------------------------------
const configWriteMutex = createMutex();
const persistConfig = (config: ProxyConfig, configPath: string): Promise<void> =>
  configWriteMutex.run(() => atomicWriteFile(configPath, configToYaml(config)));

// Log buffer for streaming — uses a monotonic sequence number per entry
// so that SSE clients can track their position even when the underlying
// array is trimmed. The old approach used array indices, which became
// stale whenever splice() ran — causing clients to miss logs or replay
// old ones after a trim event.
const LOG_BUFFER_SIZE = 2000;
const LOG_BUFFER_TRIM = 1000; // trim to this size when capacity is reached
const logBuffer: Array<{ seq: number; time: string; level: string; message: string }> = [];
let logSeq = 0; // monotonic, never reset — used as client cursor
const logWaiters: Array<{ resolve: (value: unknown) => void }> = [];

/** Add a log entry to the buffer (called by intercepting console.log). */
export function appendLog(level: string, message: string) {
  const entry = {
    seq: ++logSeq,
    time: new Date().toISOString().slice(11, 19),
    level,
    message: message.slice(0, 500),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    // Efficient: remove in bulk instead of one-by-one splice
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_TRIM);
  }
  // Wake up any waiting SSE connections
  while (logWaiters.length > 0) {
    logWaiters.shift()!.resolve(entry);
  }
}

/** Read the bundled dashboard HTML (inlined at build time). */
export function getDashboardHTML(): string {
  return dashboardHtml;
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
    if (opts.config.auth.proxyApiKey && !timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
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
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!opts.config.auth.proxyApiKey) {
      return jsonResp({ valid: true, warning: "no_auth", message: "proxyApiKey not configured — admin dashboard is open to anyone with network access" });
    }
    if (timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
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

      // Compute which fields changed in a way that requires a server restart
      // to take effect (vs. fields that can be hot-swapped at runtime).
      // The dashboard uses this to show "restart required" highlights.
      const restartFields: string[] = [];
      const oldPort = opts.config.server.port;
      const oldHost = opts.config.server.host;
      const newServer = body.server as Record<string, unknown> | undefined;
      if (newServer) {
        const newPort = typeof newServer.port === "number" ? newServer.port : parseInt(String(newServer.port), 10);
        if (Number.isFinite(newPort) && newPort !== oldPort) restartFields.push("server.port");
        if (typeof newServer.host === "string" && newServer.host !== oldHost) restartFields.push("server.host");
      }

      const newConfig = { ...opts.config, ...body };
      // Merge auth separately to avoid losing fields not sent by the dashboard
      if (authBody) {
        newConfig.auth = { ...opts.config.auth, ...authBody };
      }
      // Validate the merged config before persisting
      validateConfigForSave(newConfig);
      await persistConfig(newConfig as ProxyConfig, opts.configPath);

      // Apply hot-swappable fields to the in-memory config so they take
      // effect immediately. Restart-required fields (port/host) are NOT
      // applied — they only take effect after the user restarts the process.
      opts.config.provider = newConfig.provider;
      opts.config.plan = newConfig.plan;
      opts.config.defaultModel = newConfig.defaultModel;
      opts.config.models = newConfig.models;
      opts.config.identity = newConfig.identity;
      opts.config.logging = newConfig.logging;
      opts.config.retry = newConfig.retry;
      opts.config.routingRules = newConfig.routingRules;
      opts.config.modelMappings = newConfig.modelMappings;
      if (newConfig.responsesThinking) opts.config.responsesThinking = newConfig.responsesThinking;
      if (authBody) opts.config.auth = newConfig.auth;
      // providers.*.anthropicBase / openaiBase: also hot-swappable
      if (body.providers) {
        opts.config.providers = newConfig.providers;
      }

      appendLog("info", "Configuration updated via admin dashboard");
      return jsonResp({
        ok: true,
        requiresRestart: restartFields.length > 0,
        restartFields,
        // hotApplied: fields that were applied to the live config without restart
        hotApplied: ["provider", "plan", "defaultModel", "models", "identity", "logging", "retry", "routingRules", "modelMappings", "responsesThinking", ...(authBody ? ["auth"] : []), ...(body.providers ? ["providers"] : [])],
      });
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
      let planSynced = false;
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        // Sync config.plan to match the account's plan, and persist to yaml
        // so the change survives a server restart. Without this, users who
        // switch plan via the dashboard find the change silently reverted
        // after restart — leading to confusing "still coding-plan" reports.
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          planSynced = true;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Switched active account to ${body.id}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      if (planSynced) {
        try {
          await persistConfig(opts.config, opts.configPath);
          appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
        } catch (e) {
          appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
        }
      }
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

  // Update account plan
  if (path === "/admin/api/accounts/plan" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; plan?: string };
      if (!body.id || !body.plan) {
        return errorResponse(400, "missing_param", "id and plan are required");
      }
      if (body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const ok = await setAccountPlan(body.id, body.plan);
      if (!ok) return errorResponse(404, "not_found", "Account not found");

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use the new
      // plan. Without this, the proxy would keep using the old plan until
      // restart — defeating the purpose of the dashboard edit.
      const cred = await loadCredential();
      let planSynced = false;
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          planSynced = true;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Account ${body.id} plan changed to ${body.plan}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      // Always write — even if plan matches config, the dashboard edit is
      // an explicit user action worth persisting (in case config.yaml had
      // been manually edited out of band).
      try {
        await persistConfig(opts.config, opts.configPath);
        appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
      } catch (e) {
        appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
      }
      return jsonResp({ ok: true, plan: body.plan });
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

  // Export all accounts (backup)
  if (path === "/admin/api/accounts/export" && method === "GET") {
    try {
      const accounts = await exportAccounts();
      return jsonResp({ accounts, exportedAt: Date.now(), version: 2 });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Export the ACTIVE account as a base64 blob suitable for the
  // ZCODE_OAUTH_CREDENTIAL env var on Render / Fly.io / K8s.
  //
  // This is the dashboard equivalent of `zcode-proxy auth export` on the CLI.
  // Use case: you logged in via the dashboard (or imported from ZCode), and
  // now want to deploy to Render without re-doing the OAuth flow there.
  //
  // Returns:
  //   { credential: <base64>, json: <pretty JSON>, instructions: <string> }
  // The `credential` field is what you paste into Render's ZCODE_OAUTH_CREDENTIAL.
  // The `json` field is the decoded credential for human inspection.
  if (path === "/admin/api/accounts/render-export" && method === "GET") {
    try {
      const cred = await loadCredential();
      if (!cred) {
        return errorResponse(404, "not_logged_in", "No active credential. Login or import first.");
      }
      const json = JSON.stringify(cred);
      const b64 = Buffer.from(json, "utf8").toString("base64");
      return jsonResp({
        credential: b64,
        json: JSON.stringify(cred, null, 2),
        envVars: {
          ZCODE_AUTH_MODE: "oauth",
          ZCODE_OAUTH_CREDENTIAL: b64,
        },
        instructions: [
          "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
          "2. On Render, go to your service → Environment → add/edit:",
          "   - ZCODE_AUTH_MODE = oauth",
          "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
          "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
          "4. Save and let Render redeploy.",
          "",
          "WARNING: This blob contains your upstream credential in plaintext.",
          "Treat it like a password. On Render, mark the env var as Secret.",
        ].join("\n"),
      });
    } catch (err) {
      return errorResponse(500, "render_export_failed", (err as Error).message);
    }
  }

  // Import accounts from backup
  if (path === "/admin/api/accounts/import" && method === "POST") {
    try {
      const body = await req.json() as { accounts?: unknown[] };
      if (!Array.isArray(body.accounts)) {
        return errorResponse(400, "invalid_param", "accounts array is required");
      }
      // Basic validation: each account must have id, label, createdAt, credential
      const validated = body.accounts.filter((a: any) =>
        a && typeof a.id === "string" && typeof a.label === "string" &&
        typeof a.createdAt === "number" && a.credential && typeof a.credential.apiKey === "string"
      );
      if (validated.length === 0) {
        return errorResponse(400, "invalid_param", "No valid accounts found in import data");
      }
      const result = await importAccounts(validated as any);
      appendLog("info", `Imported accounts: ${result.added} added, ${result.updated} updated`);
      // Hot-swap active credential
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);
      return jsonResp({ ok: true, added: result.added, updated: result.updated });
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
        // Start background process to wait for callback.
        //
        // Wrapped in try/finally so oauth.close() ALWAYS runs — even if
        // saveCredential throws (e.g. disk full). The old code only called
        // close() on success or in the catch block, so a saveCredential
        // failure left the localhost OAuth callback server listening until
        // the 5-minute flow cleanup interval fired (10 min after expiry).
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
          } catch (err) {
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
            appendLog("debug", `bigmodel OAuth flow ${flowId} failed: ${(err as Error).message}`);
          } finally {
            // ALWAYS close the localhost callback server, regardless of
            // outcome. Without this, abandoned flows leak a listening socket
            // for ~10 min until the cleanup interval fires.
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
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Routing rules updated (${cleaned.length} rule(s))`);
      return jsonResp({ ok: true, rules: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get model mappings
  if (path === "/admin/api/model-mappings" && method === "GET") {
    return jsonResp({ mappings: opts.config.modelMappings ?? [] });
  }

  // Update model mappings (full replace)
  if (path === "/admin/api/model-mappings" && method === "PUT") {
    try {
      const body = await req.json() as { mappings?: Array<{ from?: string; to?: string; note?: string }> };
      if (!Array.isArray(body.mappings)) {
        return errorResponse(400, "invalid_request", "mappings must be an array");
      }
      const cleaned: ModelMapping[] = [];
      const seenFrom = new Set<string>();
      for (const m of body.mappings) {
        if (typeof m.from !== "string" || m.from.trim() === "") {
          return errorResponse(400, "invalid_mapping", "Each mapping needs a non-empty 'from'");
        }
        if (typeof m.to !== "string" || m.to.trim() === "") {
          return errorResponse(400, "invalid_mapping", `Mapping '${m.from}' has empty 'to'`);
        }
        const fromLower = m.from.trim().toLowerCase();
        if (seenFrom.has(fromLower)) {
          return errorResponse(400, "invalid_mapping", `Duplicate 'from' value: '${m.from}' (case-insensitive)`);
        }
        seenFrom.add(fromLower);
        cleaned.push({
          from: fromLower,
          to: m.to.trim(),
          note: typeof m.note === "string" && m.note.trim() ? m.note.trim() : undefined,
        });
      }
      opts.config.modelMappings = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Model mappings updated (${cleaned.length} mapping(s))`);
      return jsonResp({ ok: true, mappings: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get GLM model catalog (full pinned list from provider/models.ts).
  // Used by the dashboard for "pull current model list for quick selection"
  // dropdowns in model mappings and responses-thinking config.
  if (path === "/admin/api/glm-models" && method === "GET") {
    return jsonResp({
      models: GLM_CATALOG.map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        reasoning: !!m.reasoning,
      })),
    });
  }

  // Get responses-thinking config
  if (path === "/admin/api/responses-thinking" && method === "GET") {
    return jsonResp({ models: opts.config.responsesThinking?.models ?? [] });
  }

  // Update responses-thinking config (full replace)
  if (path === "/admin/api/responses-thinking" && method === "PUT") {
    try {
      const body = await req.json() as { models?: unknown };
      if (!Array.isArray(body.models)) {
        return errorResponse(400, "invalid_request", "models must be an array of strings");
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const item of body.models) {
        if (typeof item !== "string") {
          return errorResponse(400, "invalid_model", `Each model must be a string (got ${typeof item})`);
        }
        const id = item.trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(id);
      }
      const cfg: ResponsesThinkingConfig = { models: cleaned };
      opts.config.responsesThinking = cfg;
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Responses thinking override updated (${cleaned.length} model(s))`);
      return jsonResp({ ok: true, models: cleaned });
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
    requestIndex.clear();
    appendLog("info", "Stats reset by admin");
    return jsonResp({ ok: true });
  }

  // Log stream (SSE)
  // Uses monotonic seq numbers instead of array indices so that clients
  // never miss logs even when the underlying buffer is trimmed. The client
  // cursor (lastSentSeq) is a seq value, not an array index — it stays
  // valid across splice() calls because we look up entries by seq.
  if (path === "/admin/api/logs/stream" && method === "GET") {
    let lastSentSeq = logSeq; // start by sending everything currently buffered
    let cleanup: (() => void) | null = null;
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (entry: { seq: number; time: string; level: string; message: string }) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
          } catch { /* SSE controller may be closed; safe to ignore */ }
        };

        // Send existing buffered logs first.
        //
        // Iterate the buffer directly (entries are sorted by seq, and we
        // know the lowest seq currently buffered). The old code used a
        // `for (s = startSeq; s <= logSeq; s++)` loop with logBuffer.find()
        // inside — O(n²) on every dashboard connect (2M string compares for
        // a 2000-entry buffer). Now we just walk the array once.
        const startSeq = logBuffer.length > 0 ? logBuffer[0].seq : logSeq + 1;
        for (const entry of logBuffer) {
          if (entry.seq < startSeq) continue;
          send(entry);
        }
        lastSentSeq = logSeq;

        // Set up a waiter so new entries are pushed immediately.
        // The push-based path is the primary delivery mechanism; the polling
        // interval below is only a safety net for the rare race where a new
        // entry is appended between the `logBuffer.length` check above and
        // the `logWaiters.push(waiter)` below. The old code polled every
        // 500ms indefinitely — wasteful and redundant with the push path.
        const waiter = { resolve: (value: unknown) => void 0 };
        logWaiters.push(waiter);

        // Safety-net polling: short interval, used only to recover from
        // the registration race (entry pushed between buffer-scan and
        // waiter-registration). Stops as soon as we catch up to logSeq.
        const interval = setInterval(() => {
          // Iterate the buffer once and send any entries we haven't sent.
          // Buffer entries are sorted by seq, so this is O(n) per poll.
          for (const e of logBuffer) {
            if (e.seq > lastSentSeq) {
              send(e);
            }
          }
          // Update lastSentSeq to the highest seq we've seen (may be logSeq
          // or lower if entries were evicted).
          lastSentSeq = logSeq;
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
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 2000);
    let logs = logBuffer;
    if (level) logs = logs.filter(l => l.level === level);
    if (search) logs = logs.filter(l => l.message.toLowerCase().includes(search));
    return jsonResp({ logs: logs.slice(-limit), total: logBuffer.length });
  }

  // Get debug dumps (memory ring buffer of upstream 4xx transformed bodies).
  // Replaces the old writeFileSync-to-disk approach that leaked user
  // conversation content to <cwd>/zcode-proxy-debug-*.json forever.
  if (path === "/admin/api/debug-dumps" && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);
    // Strip the full body by default — only return it when ?full=1.
    // Bodies can be 90KB+ and may contain user conversation content, so we
    // hide them behind an explicit opt-in to avoid surprising the user.
    const includeBody = url.searchParams.get("full") === "1";
    const dumpId = url.searchParams.get("id");
    if (dumpId) {
      const dump = debugDumps.find(d => d.id === dumpId);
      if (!dump) return errorResponse(404, "not_found", "Debug dump not found");
      return jsonResp(dump);
    }
    return jsonResp({
      dumps: debugDumps.slice(-limit).reverse().map(d =>
        includeBody ? d : { ...d, body: undefined }
      ),
      total: debugDumps.length,
    });
  }

  // Clear debug dumps
  if (path === "/admin/api/debug-dumps" && method === "DELETE") {
    clearDebugDumps();
    appendLog("info", "Debug dumps cleared by admin");
    return jsonResp({ ok: true });
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
    modelMappings: config.modelMappings ?? [],
    responsesThinking: config.responsesThinking ?? { models: [] },
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
    ...(config.modelMappings && config.modelMappings.length > 0
      ? { modelMappings: config.modelMappings.map(m => ({
          from: m.from,
          to: m.to,
          ...(m.note ? { note: m.note } : {}),
        })) }
      : {}),
    ...(config.responsesThinking && config.responsesThinking.models.length > 0
      ? { responsesThinking: { models: [...config.responsesThinking.models] } }
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

function importFromZCodeConfig(provider: string, forcedPlan?: "coding-plan" | "start-plan"): AppCredential {
  // Auto-detect active plan from ZCode config (enabled: true wins).
  // forcedPlan (--plan= flag from dashboard) overrides auto-detection.
  // See src/index.ts importFromZCodeConfig for full rationale.
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(configPath)) throw new Error("ZCode config not found at " + configPath);
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as {
    provider?: Record<string, {
      options?: { apiKey?: string };
      enabled?: boolean;
    }>;
  };

  const codingPlanKey = `builtin:${provider}-coding-plan`;
  const startPlanKey = `builtin:${provider}-start-plan`;
  const codingEntry = config.provider?.[codingPlanKey];
  const startEntry = config.provider?.[startPlanKey];
  const codingPlanApiKey = codingEntry?.options?.apiKey?.trim() || "";
  const startPlanToken = startEntry?.options?.apiKey?.trim() || "";

  // Auto-detect: enabled: true wins
  let detectedPlan: "coding-plan" | "start-plan" | null = null;
  if (codingEntry?.enabled === true && codingPlanApiKey) detectedPlan = "coding-plan";
  else if (startEntry?.enabled === true && startPlanToken) detectedPlan = "start-plan";

  const plan: "coding-plan" | "start-plan" = forcedPlan ?? detectedPlan ?? "coding-plan";

  if (plan === "start-plan") {
    if (!startPlanToken) {
      throw new Error(`No start-plan JWT in ZCode config (looked for ${startPlanKey}). Available: coding-plan API key=${codingPlanApiKey ? "yes" : "no"}`);
    }
    return {
      apiKey: codingPlanApiKey || startPlanToken,
      provider: provider as "zai" | "bigmodel",
      plan,
      jwt: startPlanToken,
    };
  }

  // coding-plan
  if (!codingPlanApiKey) {
    const hint = startPlanToken
      ? ` Found a start-plan JWT — import with plan=start-plan instead.`
      : "";
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
    if (typeof server.host === "string" && server.host.length > 0) {
      // Basic host validation: IPv4, IPv6, or hostname. Rejects spaces and
      // most special chars. 0.0.0.0 is allowed (bind to all interfaces).
      const hostRe = /^(\d{1,3}\.){3}\d{1,3}$|^[a-fA-F0-9:]+:[a-fA-F0-9:]+$|^[a-zA-Z0-9._-]+$/;
      if (!hostRe.test(server.host)) {
        throw new Error(`server.host "${server.host}" is not a valid IP or hostname`);
      }
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

  // Validate providers.*.anthropicBase / openaiBase are URLs (when present).
  // Catches typos like missing https:// or trailing slashes that would 404
  // silently on every request.
  const providers = cfg.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    for (const [name, p] of Object.entries(providers)) {
      for (const field of ["anthropicBase", "openaiBase"]) {
        const v = p?.[field];
        if (typeof v === "string" && v.length > 0) {
          try {
            const u = new URL(v);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              throw new Error(`providers.${name}.${field} must be http(s):// URL (got ${u.protocol})`);
            }
          } catch (err) {
            throw new Error(`providers.${name}.${field} is not a valid URL: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // Validate retry config bounds to prevent runaway retry loops.
  // Note: maxRetries has NO upper bound — operators may legitimately want
  // to retry indefinitely (e.g. a flaky upstream during peak hours).
  const retry = cfg.retry as Record<string, unknown> | undefined;
  if (retry) {
    const maxRetries = typeof retry.maxRetries === "number" ? retry.maxRetries : parseInt(String(retry.maxRetries), 10);
    if (Number.isFinite(maxRetries) && maxRetries < 0) {
      throw new Error(`retry.maxRetries ${maxRetries} must be >= 0`);
    }
    const initialDelayMs = typeof retry.initialDelayMs === "number" ? retry.initialDelayMs : parseInt(String(retry.initialDelayMs), 10);
    if (Number.isFinite(initialDelayMs) && (initialDelayMs < 0 || initialDelayMs > 60_000)) {
      throw new Error(`retry.initialDelayMs ${initialDelayMs} is out of range (0-60000)`);
    }
    const maxDelayMs = typeof retry.maxDelayMs === "number" ? retry.maxDelayMs : parseInt(String(retry.maxDelayMs), 10);
    if (Number.isFinite(maxDelayMs) && (maxDelayMs < 0 || maxDelayMs > 300_000)) {
      throw new Error(`retry.maxDelayMs ${maxDelayMs} is out of range (0-300000)`);
    }
    if (Array.isArray(retry.retryableStatuses)) {
      for (const s of retry.retryableStatuses) {
        const n = typeof s === "number" ? s : parseInt(String(s), 10);
        if (!Number.isFinite(n) || n < 100 || n > 599) {
          throw new Error(`retry.retryableStatuses contains invalid status: ${s}`);
        }
      }
    }
    // credentialSwitchThreshold: 0 = disabled, otherwise the number of
    // consecutive failures (including initial) before switching credentials.
    // No upper bound — but if it exceeds maxRetries+1, switching will never
    // trigger (the retry loop exhausts first). We allow any non-negative int.
    const credentialSwitchThreshold = typeof retry.credentialSwitchThreshold === "number"
      ? retry.credentialSwitchThreshold
      : parseInt(String(retry.credentialSwitchThreshold), 10);
    if (Number.isFinite(credentialSwitchThreshold) && credentialSwitchThreshold < 0) {
      throw new Error(`retry.credentialSwitchThreshold ${credentialSwitchThreshold} must be >= 0`);
    }
  }

  // Validate models array is non-empty (after applying changes).
  const models = cfg.models as unknown[] | undefined;
  if (Array.isArray(models) && models.length === 0) {
    throw new Error(`models must contain at least one entry (got empty array)`);
  }
  const defaultModel = cfg.defaultModel as string | undefined;
  if (defaultModel !== undefined && typeof defaultModel !== "string") {
    throw new Error(`defaultModel must be a string`);
  }
  // Mirrors loadConfig's auto-append behavior (loader.ts:291-294): if
  // defaultModel is set but not in models[], we add it here so the dashboard
  // save and the next startup agree on what `GET /v1/models` returns.
  // Without this, a dashboard user setting `defaultModel: gpt-4` while
  // `models: [glm-4.6]` would silently grow the array on next loadConfig,
  // producing an inconsistent validation surface.
  if (typeof defaultModel === "string" && defaultModel.length > 0
      && Array.isArray(models) && models.length > 0
      && !models.includes(defaultModel)) {
    models.push(defaultModel);
  }
}
