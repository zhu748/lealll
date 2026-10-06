import type { ProxyConfig, RetryConfig } from "../../config/types.js";
import { errorResponse } from "../../proxy/translated-response.js";
import { synchronizeActiveCredential } from "../account-actions.js";
import {
  CONFIG_SECRET_MASK,
  RETRY_DEFAULTS,
  isConfigObject,
  normalizeConfigForSave,
  normalizeModelList,
  normalizeModelMappingsForSave,
  normalizeRetryableStatuses,
  normalizeRoutingRulesForSave,
  optionalConfigObject,
  persistConfig,
  sanitizeConfig,
  validateConfigForSave,
} from "../config.js";
import { appendLog } from "../logs.js";
import { readJsonBody } from "../request-body.js";
import { jsonResp } from "../security.js";
import type { AdminRouteContext } from "../types.js";

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleConfigRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, path, method } = context;

  // Get config
  if (path === "/admin/api/config" && method === "GET") {
    return jsonResp(sanitizeConfig(opts.config));
  }

  // Update config
  if (path === "/admin/api/config" && method === "PUT") {
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // Prevent masked placeholder values from overwriting real secrets.
      // The sanitizeConfig() GET endpoint returns "***configured***" for
      // secret fields; if the dashboard sends those back unchanged we skip them.
      const authBody = optionalConfigObject(body, "auth");
      const hasCorsAllowList = Object.prototype.hasOwnProperty.call(body, "corsAllowList");
      const hasResponsesThinking = Object.prototype.hasOwnProperty.call(body, "responsesThinking");
      const hasRoutingRules = Object.prototype.hasOwnProperty.call(body, "routingRules");
      const hasModelMappings = Object.prototype.hasOwnProperty.call(body, "modelMappings");
      const hasModels = Object.prototype.hasOwnProperty.call(body, "models");
      const newServer = optionalConfigObject(body, "server");
      const retryBody = optionalConfigObject(body, "retry");
      const identityBody = optionalConfigObject(body, "identity");
      const loggingBody = optionalConfigObject(body, "logging");
      const providersBody = optionalConfigObject(body, "providers");
      const claimBody = optionalConfigObject(body, "claim");
      if (hasModels && !Array.isArray(body.models)) {
        throw new Error("models must be an array");
      }
      if (authBody) {
        if (authBody.apiKey === CONFIG_SECRET_MASK || authBody.apiKey === "") delete authBody.apiKey;
        if (authBody.proxyApiKey === CONFIG_SECRET_MASK || authBody.proxyApiKey === "") delete authBody.proxyApiKey;
      }

      // Compute which fields changed in a way that requires a server restart
      // to take effect (vs. fields that can be hot-swapped at runtime).
      // The dashboard uses this to show "restart required" highlights.
      const oldPort = opts.config.server.port;
      const oldHost = opts.config.server.host;

      const newConfig = { ...opts.config, ...body };
      // Merge nested sections so partial edits retain unspecified fields.
      if (authBody) {
        newConfig.auth = { ...opts.config.auth, ...authBody };
      }
      // Only port/host need restart; other server fields are hot-swappable.
      if (newServer) {
        newConfig.server = {
          ...opts.config.server,
          ...newServer,
        };
      }
      if (retryBody) {
        const rawRetryStatuses = retryBody.retryableStatuses;
        const baseRetry: RetryConfig = opts.config.retry ?? { ...RETRY_DEFAULTS };
        newConfig.retry = {
          ...baseRetry,
          ...retryBody,
          // retryableStatuses is an array — if client sends it, use it; else keep existing
          retryableStatuses: Array.isArray(rawRetryStatuses)
            ? normalizeRetryableStatuses(rawRetryStatuses)
            : [...baseRetry.retryableStatuses],
        };
      }
      if (identityBody) {
        newConfig.identity = { ...opts.config.identity, ...identityBody };
      }
      // Deep-merge the claim section the same way as retry/identity — without
      // this a partial PUT like {"claim":{"planId":"x"}} would drop
      // pollIntervalMs/cooldownMs and the scheduler would crash at next boot.
      if (claimBody) {
        newConfig.claim = { ...opts.config.claim, ...claimBody };
      }
      if (loggingBody) {
        newConfig.logging = { ...opts.config.logging, ...loggingBody };
      }
      if (providersBody) {
        const zaiBody = optionalConfigObject(providersBody, "zai", "providers.zai") ?? {};
        const bigmodelBody = optionalConfigObject(providersBody, "bigmodel", "providers.bigmodel") ?? {};
        if (zaiBody.credential === CONFIG_SECRET_MASK || zaiBody.credential === "") delete zaiBody.credential;
        if (bigmodelBody.credential === CONFIG_SECRET_MASK || bigmodelBody.credential === "") delete bigmodelBody.credential;
        newConfig.providers = {
          zai: { ...opts.config.providers.zai, ...zaiBody },
          bigmodel: { ...opts.config.providers.bigmodel, ...bigmodelBody },
        };
      }
      // v0.2.2+ FIX: defensive deep-clone for nested objects that the
      // dashboard may mutate. Without this, `newConfig.responsesThinking`
      // would be the SAME object reference as `opts.config.responsesThinking`
      // (because the spread above only shallow-copies), and any in-place
      // mutation (e.g. `newConfig.responsesThinking.models.push(...)`)
      // would corrupt the live in-memory config even if the persist fails.
      // Same for `corsAllowList` and `routingRules` / `modelMappings`.
      if (opts.config.responsesThinking || hasResponsesThinking) {
        const currentResponsesThinking = opts.config.responsesThinking;
        newConfig.responsesThinking = {
          models: Array.isArray(currentResponsesThinking?.models)
            ? [...currentResponsesThinking.models]
            : [],
        };
        if (hasResponsesThinking) {
          const raw = body.responsesThinking as any;
          if (raw !== null && !Array.isArray(raw) && !isConfigObject(raw)) {
            throw new Error("responsesThinking must be an object or an array of strings");
          }
          const models = Array.isArray(raw) ? raw : raw ? raw.models : undefined;
          if (models === undefined || models === null) {
            newConfig.responsesThinking.models = [];
          } else if (Array.isArray(models) && models.every((model) => typeof model === "string")) {
            newConfig.responsesThinking.models = [...models];
          } else {
            throw new Error("responsesThinking.models must be an array of strings");
          }
        }
      }
      if (Array.isArray(opts.config.routingRules) || hasRoutingRules) {
        const rawRules = hasRoutingRules ? body.routingRules : opts.config.routingRules;
        if (!Array.isArray(rawRules)) {
          throw new Error("routingRules must be an array");
        }
        newConfig.routingRules = normalizeRoutingRulesForSave(rawRules);
      }
      if (Array.isArray(opts.config.modelMappings) || hasModelMappings) {
        const rawMappings = hasModelMappings ? body.modelMappings : opts.config.modelMappings;
        if (!Array.isArray(rawMappings)) {
          throw new Error("modelMappings must be an array");
        }
        newConfig.modelMappings = normalizeModelMappingsForSave(rawMappings);
      }
      if (Array.isArray((opts.config as any).corsAllowList)) {
        (newConfig as any).corsAllowList = [...(opts.config as any).corsAllowList];
      }
      if (hasCorsAllowList) {
        if (Array.isArray(body.corsAllowList)) {
          const entries = body.corsAllowList as unknown[];
          if (!entries.every((entry) => typeof entry === "string")) {
            throw new Error("corsAllowList must be an array of strings");
          }
          (newConfig as any).corsAllowList = entries.map((entry) => entry.trim()).filter(Boolean);
        } else if (body.corsAllowList == null) {
          delete (newConfig as any).corsAllowList;
        } else {
          throw new Error("corsAllowList must be an array of strings");
        }
      }
      if (Array.isArray(opts.config.models)) {
        newConfig.models = [...opts.config.models];
        if (Array.isArray(body.models)) {
          newConfig.models = normalizeModelList(body.models, newConfig.defaultModel);
        }
      }
      // Normalize + validate the merged config before persisting. This keeps
      // dashboard/API saves aligned with loadConfig(): numeric strings like
      // "8080" become numbers, but trailing junk like "8080abc" is rejected
      // instead of being prefix-parsed by parseInt.
      normalizeConfigForSave(newConfig);
      validateConfigForSave(newConfig);

      const restartFields: string[] = [];
      if (newServer) {
        if (Object.prototype.hasOwnProperty.call(newServer, "port") && newConfig.server.port !== oldPort) {
          restartFields.push("server.port");
        }
        if (Object.prototype.hasOwnProperty.call(newServer, "host") && newConfig.server.host !== oldHost) {
          restartFields.push("server.host");
        }
      }
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
      // v0.2.0.4: forceStreamAnthropic removed — stream:true is now unconditional.
      if (newConfig.thinkingLevel !== undefined) opts.config.thinkingLevel = newConfig.thinkingLevel === "low" || newConfig.thinkingLevel === "high" ? newConfig.thinkingLevel : "max";
      if (authBody) opts.config.auth = newConfig.auth;
      if (hasCorsAllowList) {
        if (Array.isArray((newConfig as any).corsAllowList)) {
          (opts.config as any).corsAllowList = [...(newConfig as any).corsAllowList];
        } else {
          delete (opts.config as any).corsAllowList;
        }
      }
      // providers.*.anthropicBase / openaiBase: also hot-swappable
      if (providersBody) {
        opts.config.providers = newConfig.providers;
      }
      // claim.*: hot-swappable for the request-path default target
      // (handleQuotaClaimSubmit reads claim.planId per request). The
      // background scheduler reads the config at boot, so pollIntervalMs /
      // cooldownMs changes still need a restart to re-arm — same semantics
      // as the CLI's config file.
      if (claimBody) {
        opts.config.claim = newConfig.claim;
      }
      // v0.2.1.7+: server hot-swappable fields (NOT port/host — those need
      // restart, tracked in restartFields above). upstreamTimeoutMs,
      // trustProxy, sseHeartbeatMs, and maxRequestBodyBytes all affect
      // per-request behavior and are safe to hot-swap.
      if (newServer) {
        if (newConfig.server.upstreamTimeoutMs !== undefined) opts.config.server.upstreamTimeoutMs = newConfig.server.upstreamTimeoutMs;
        if (newConfig.server.trustProxy !== undefined) opts.config.server.trustProxy = newConfig.server.trustProxy;
        if (newConfig.server.sseHeartbeatMs !== undefined) opts.config.server.sseHeartbeatMs = newConfig.server.sseHeartbeatMs;
        if (newConfig.server.maxRequestBodyBytes !== undefined) opts.config.server.maxRequestBodyBytes = newConfig.server.maxRequestBodyBytes;
      }

      // Keep AuthManager in sync with the hot-applied config. The config
      // object above is mutable, but AuthManager also caches mode/provider and
      // the parsed apikey credential internally. Without this, changing
      // auth.apiKey/provider/plan in the dashboard only takes effect after a
      // restart despite the API reporting "hotApplied: auth".
      opts.auth.updateConfig({
        mode: newConfig.auth.mode ?? "oauth",
        provider: newConfig.provider,
        apiKey: newConfig.auth.apiKey ?? newConfig.providers[newConfig.provider]?.credential,
        plan: newConfig.plan,
      });
      if ((newConfig.auth.mode ?? "oauth") === "oauth") {
        await synchronizeActiveCredential(opts.auth);
      }

      appendLog("info", "Configuration updated via admin dashboard");
      return jsonResp({
        ok: true,
        requiresRestart: restartFields.length > 0,
        restartFields,
        // hotApplied: fields that were applied to the live config without restart
        hotApplied: ["provider", "plan", "defaultModel", "models", "identity", "logging", "retry", "routingRules", "modelMappings", "responsesThinking", "thinkingLevel", ...(authBody ? ["auth"] : []), ...(hasCorsAllowList ? ["corsAllowList"] : []), ...(providersBody ? ["providers"] : []), ...(newServer ? ["server"] : [])],
      });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }
  return null;
}
