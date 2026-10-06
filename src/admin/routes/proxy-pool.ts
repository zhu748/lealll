import {
  cancelTestJob,
  clearProxies,
  getPoolState,
  getTestJobState,
  importFromText,
  importFromUrl,
  refreshFromSources,
  removeProxy,
  startTestJob,
  updatePoolConfig,
  validateProxySourceUrl,
} from "../../proxy/proxy-pool.js";
import { errorResponse } from "../../proxy/translated-response.js";
import { appendLog } from "../logs.js";
import { checkProxyConnectivity, proxyTestTarget } from "../proxy-check.js";
import { MAX_PROXY_IMPORT_TEXT_BODY_BYTES, readJsonBody } from "../request-body.js";
import { jsonResp } from "../security.js";
import type { AdminRouteContext } from "../types.js";
const MAX_PROXY_POOL_REFRESH_INTERVAL_MIN = Math.floor(2_147_483_647 / 60_000);

const MAX_PROXY_POOL_ROTATIONS = 20;

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleProxyPoolRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, url, path, method } = context;

  // =====================================================================
  // Global Proxy Pool (v0.2.2+)
  // =====================================================================
  // All routes under /admin/api/proxy-pool/* manage the global proxy pool.
  // The pool provides a fallback outbound proxy shared across all accounts;
  // per-account `cred.proxy` overrides still take priority over the pool.
  // See src/proxy/proxy-pool.ts for the full design.
  if (path === "/admin/api/proxy-pool" && method === "GET") {
    try {
      const state = await getPoolState();
      return jsonResp(state);
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  if (path === "/admin/api/proxy-pool/config" && method === "PUT") {
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return errorResponse(400, "invalid_param", "Body must be a JSON object");
      }
      const patch: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
        if (typeof body.enabled !== "boolean") {
          return errorResponse(400, "invalid_param", "enabled must be a boolean");
        }
        patch.enabled = body.enabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, "refreshIntervalMin")) {
        if (typeof body.refreshIntervalMin !== "number"
          || !Number.isInteger(body.refreshIntervalMin)
          || body.refreshIntervalMin < 0
          || body.refreshIntervalMin > MAX_PROXY_POOL_REFRESH_INTERVAL_MIN) {
          return errorResponse(400, "invalid_param", `refreshIntervalMin must be an integer between 0 and ${MAX_PROXY_POOL_REFRESH_INTERVAL_MIN}`);
        }
        patch.refreshIntervalMin = body.refreshIntervalMin;
      }
      if (Object.prototype.hasOwnProperty.call(body, "sourceUrls")) {
        if (!Array.isArray(body.sourceUrls)) {
          return errorResponse(400, "invalid_param", "sourceUrls must be an array of URLs");
        }
        // Validate each URL.
        const urls: string[] = [];
        for (const u of body.sourceUrls) {
          if (typeof u !== "string") {
            return errorResponse(400, "invalid_param", "sourceUrls must contain only strings");
          }
          const trimmed = u.trim();
          if (!trimmed) continue;
          const validation = validateProxySourceUrl(trimmed);
          if (!validation.ok) return errorResponse(400, "invalid_param", validation.message);
          urls.push(validation.url);
        }
        patch.sourceUrls = urls;
      }
      if (Object.prototype.hasOwnProperty.call(body, "rotateOnGatewayBlock")) {
        if (typeof body.rotateOnGatewayBlock !== "boolean") {
          return errorResponse(400, "invalid_param", "rotateOnGatewayBlock must be a boolean");
        }
        patch.rotateOnGatewayBlock = body.rotateOnGatewayBlock;
      }
      if (Object.prototype.hasOwnProperty.call(body, "maxRotations")) {
        if (typeof body.maxRotations !== "number"
          || !Number.isInteger(body.maxRotations)
          || body.maxRotations < 0
          || body.maxRotations > MAX_PROXY_POOL_ROTATIONS) {
          return errorResponse(400, "invalid_param", `maxRotations must be an integer between 0 and ${MAX_PROXY_POOL_ROTATIONS}`);
        }
        patch.maxRotations = body.maxRotations;
      }
      const newConfig = await updatePoolConfig(patch);
      appendLog("info", `Proxy pool config updated (enabled=${newConfig.enabled}, interval=${newConfig.refreshIntervalMin}min, sources=${newConfig.sourceUrls.length})`);
      return jsonResp({ ok: true, config: newConfig });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Import proxies from a raw text block (paste or txt file upload).
  // Body: { text: string, replace?: boolean }
  // Returns: { ok: true, added, removed, total }
  if (path === "/admin/api/proxy-pool/import-text" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ text?: string; replace?: boolean }>(req, { maxBytes: MAX_PROXY_IMPORT_TEXT_BODY_BYTES });
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.text !== "string") {
        return errorResponse(400, "missing_param", "text is required");
      }
      const result = await importFromText(body.text, body.replace === true);
      appendLog("info", `Proxy pool import (text): +${result.added} -${result.removed} =${result.total}`);
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Import proxies from a remote URL (one-shot fetch, not auto-refresh).
  // Body: { url: string }
  // Returns: { ok: true, added, removed, total, fetched, error? }
  if (path === "/admin/api/proxy-pool/import-url" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ url?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.url !== "string" || !body.url.trim()) {
        return errorResponse(400, "missing_param", "url is required");
      }
      const trimmed = body.url.trim();
      const validation = validateProxySourceUrl(trimmed);
      if (!validation.ok) return errorResponse(400, "invalid_param", validation.message);
      const fetchImpl = opts.fetchImpl ?? fetch;
      const result = await importFromUrl(validation.url, fetchImpl);
      if (result.error) {
        appendLog("warn", `Proxy pool import (URL ${trimmed}) failed: ${result.error}`);
        return jsonResp({ ok: false, ...result }, 200);
      }
      appendLog("info", `Proxy pool import (URL ${trimmed}): +${result.added} -${result.removed} =${result.total} (fetched ${result.fetched})`);
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Refresh from ALL configured source URLs (manual trigger).
  // Returns: { ok: true, added, removed, total, at, errors? }
  if (path === "/admin/api/proxy-pool/refresh" && method === "POST") {
    try {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const result = await refreshFromSources(fetchImpl);
      appendLog("info", `Proxy pool refresh: +${result.added} -${result.removed} =${result.total}` + (result.errors ? ` (errors: ${Object.keys(result.errors).length})` : ""));
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Remove a single proxy by id.
  // Body: { id: string }
  if (path === "/admin/api/proxy-pool/proxy" && method === "DELETE") {
    try {
      const parsed = await readJsonBody<{ id?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.id !== "string" || !body.id.trim()) {
        return errorResponse(400, "missing_param", "id is required");
      }
      const ok = await removeProxy(body.id);
      if (!ok) return errorResponse(404, "not_found", "Proxy not found in pool");
      appendLog("info", `Proxy pool entry removed: ${body.id}`);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Clear all proxies (config preserved).
  if (path === "/admin/api/proxy-pool/clear" && method === "POST") {
    try {
      const result = await clearProxies();
      appendLog("info", `Proxy pool cleared: ${result.removed} entries removed`);
      return jsonResp({ ok: true, ...result });
    } catch (err) {
      return errorResponse(500, "proxy_pool_error", (err as Error).message);
    }
  }

  // Test a single pool proxy by id (v0.2.1.1+)
  // Does a HEAD request to the configured provider's base URL through the
  // proxy identified by `id`. Returns ok:true with latency on any HTTP
  // response (even 4xx/5xx means the proxy is reachable); ok:false on
  // network-level failures (timeout, connection refused, etc.).
  //
  // Body: { id: string, provider?: "zai"|"bigmodel" }
  // Returns: { ok: true, status, latencyMs, target, url } on success
  //          { ok: false, error, latencyMs, target, url } on failure
  if (path === "/admin/api/proxy-pool/test-one" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ id?: string; provider?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.id !== "string" || !body.id.trim()) {
        return errorResponse(400, "missing_param", "id is required");
      }
      const state = await getPoolState();
      const entry = state.proxies.find(p => p.id === body.id);
      if (!entry) {
        return errorResponse(404, "not_found", "Proxy not found in pool");
      }
      const proxyUrl = entry.url;

      const result = await checkProxyConnectivity(proxyUrl, body.provider, opts);
      return jsonResp({ ...result, id: body.id, url: proxyUrl });
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Start a background test-all job (v0.2.1.1+)
  // The job runs entirely on the server — closing the browser tab does NOT
  // stop it. The dashboard polls GET /test-status for progress.
  //
  // Body: { batchSize?: number, autoRemove?: boolean, provider?: "zai"|"bigmodel" }
  // Returns: the initial job state (running: true)
  if (path === "/admin/api/proxy-pool/test-all" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ batchSize?: number; autoRemove?: boolean; provider?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (body.batchSize !== undefined
          && (!Number.isSafeInteger(body.batchSize) || body.batchSize < 1 || body.batchSize > 50)) {
        return errorResponse(400, "invalid_param", "batchSize must be an integer between 1 and 50");
      }
      if (body.autoRemove !== undefined && typeof body.autoRemove !== "boolean") {
        return errorResponse(400, "invalid_param", "autoRemove must be a boolean");
      }
      if (body.provider !== undefined && body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }

      const testTarget = proxyTestTarget(opts.config, body.provider);

      const state = await startTestJob({
        batchSize: body.batchSize,
        autoRemove: body.autoRemove,
        fetchImpl: opts.fetchImpl,
        testTarget,
      });
      appendLog("info", `Proxy pool test-all started: ${state.total} proxies, batch=${state.batchSize}, autoRemove=${state.autoRemove}`);
      return jsonResp(state);
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Poll background test-all job status (v0.2.1.1+)
  // Returns the current job state, or { running: false, total: 0, ... } if
  // no job has ever run.
  if (path === "/admin/api/proxy-pool/test-status" && method === "GET") {
    const sinceRaw = url.searchParams.get("sinceSeq");
    const sinceSeq = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    const state = getTestJobState({ sinceSeq });
    if (!state) {
      return jsonResp({
        running: false,
        total: 0,
        tested: 0,
        okCount: 0,
        failCount: 0,
        removedCount: 0,
        batchSize: 0,
        autoRemove: false,
        startedAt: 0,
        resultSeq: 0,
        results: {},
      });
    }
    return jsonResp(state);
  }

  // Cancel the current background test-all job (v0.2.1.1+)
  if (path === "/admin/api/proxy-pool/test-cancel" && method === "POST") {
    cancelTestJob();
    appendLog("info", "Proxy pool test-all cancelled by admin");
    return jsonResp({ ok: true });
  }
  return null;
}
