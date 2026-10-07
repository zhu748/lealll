import { stringify as stringifyYaml } from "yaml";
import type { ModelMapping, ProxyConfig, RetryConfig, RoutingRule } from "../config/types.js";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { normalizePromptRewriteConfig } from "../config/prompt-rewrite.js";

/**
 * Fallback retry defaults (fork multi-account layer). Mirrors the loader's
 * DEFAULTS — used when a hand-built / pre-upgrade config object lacks the
 * `retry` section (hand-written test configs, YAML files from older forks).
 * The proxy handler re-applies the same fallbacks field-by-field.
 */
export const RETRY_DEFAULTS: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  backoffFactor: 2,
  retryableStatuses: [529, 429],
  credentialSwitchThreshold: 2,
  emptyStreamSwitchThreshold: 3,
  totalDeadlineMs: 300000,
};

export const CONFIG_SECRET_MASK = "***configured***";

// Serialize read/merge/write/hot-apply together, not just the final YAML write.
const configWriteMutex = createMutex();
const savedServer = new WeakMap<ProxyConfig, { path: string; port: number; host: string }>();

function configForSave(config: ProxyConfig, configPath?: string): ProxyConfig {
  const saved = savedServer.get(config);
  if (!saved || (configPath !== undefined && saved.path !== configPath)) return config;
  return { ...config, server: { ...config.server, port: saved.port, host: saved.host } };
}

/** Read the body before entering this queue; slow uploads must not hold the save lock. */
export function withConfigUpdate<T>(
  config: ProxyConfig,
  configPath: string,
  update: (draft: ProxyConfig, save: (next: ProxyConfig) => Promise<void>) => Promise<T>,
): Promise<T> {
  return configWriteMutex.run(() => update(structuredClone(configForSave(config, configPath)), async (next) => {
    await atomicWriteFile(configPath, configToYaml(next));
    // The listening socket keeps its old address until restart. Other saves
    // and GET /config must retain the address the user has already saved.
    savedServer.set(config, { path: configPath, port: next.server.port, host: next.server.host });
  }));
}

export const persistConfig = (config: ProxyConfig, configPath: string): Promise<void> =>
  configWriteMutex.run(() => atomicWriteFile(configPath, configToYaml(configForSave(config, configPath))));

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalConfigObject(
  body: Record<string, unknown>,
  key: string,
  field = key,
): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
  const value = body[key];
  if (!isConfigObject(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function sanitizeProviderEndpoints(provider: ProxyConfig["providers"]["zai"]): Record<string, unknown> {
  const { credential, ...rest } = provider;
  return {
    ...rest,
    ...(credential ? { credential: CONFIG_SECRET_MASK } : {}),
  };
}

export function sanitizeConfig(config: ProxyConfig): Record<string, unknown> {
  config = configForSave(config);
  return {
    server: config.server,
    provider: config.provider,
    plan: config.plan,
    auth: {
      mode: config.auth.mode,
      // Don't expose full API key, just indicate presence
      apiKey: config.auth.apiKey ? CONFIG_SECRET_MASK : "",
      proxyApiKey: config.auth.proxyApiKey ? CONFIG_SECRET_MASK : "",
      ...(config.auth.oauthCredentialsPath ? { oauthCredentialsPath: config.auth.oauthCredentialsPath } : {}),
    },
    providers: {
      zai: sanitizeProviderEndpoints(config.providers.zai),
      bigmodel: sanitizeProviderEndpoints(config.providers.bigmodel),
    },
    defaultModel: config.defaultModel,
    models: config.models,
    identity: config.identity,
    logging: config.logging,
    retry: config.retry,
    corsAllowList: config.corsAllowList ?? [],
    routingRules: config.routingRules ?? [],
    modelMappings: config.modelMappings ?? [],
    promptRewrite: normalizePromptRewriteConfig(config.promptRewrite),
    responsesThinking: config.responsesThinking ?? { models: [] },
    // v0.2.0.4: forceStreamAnthropic removed — stream:true is now unconditional.
    thinkingLevel: config.thinkingLevel === "low" || config.thinkingLevel === "high" ? config.thinkingLevel : "max",
  };
}

function configToYaml(config: ProxyConfig): string {
  // Build a plain object preserving insertion order matching config.example.yaml,
  // then let the `yaml` library handle quoting/indentation/escape correctly.
  // This keeps values with special chars (colons, leading spaces, quotes) safe
  // and avoids the brittle manual string concatenation that previously broke on
  // URLs containing ':' and other reserved characters.
  const obj: Record<string, unknown> = {
    server: {
      port: config.server.port,
      host: config.server.host,
      // v0.2.1.7+: persist all server fields so dashboard saves don't
      // drop upstreamTimeoutMs / trustProxy / sseHeartbeatMs / maxRequestBodyBytes. Previously
      // only port+host were serialized, causing these fields to vanish
      // from config.yaml on the next save (and revert to defaults on
      // restart).
      ...(config.server.upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs: config.server.upstreamTimeoutMs } : {}),
      ...(config.server.trustProxy !== undefined ? { trustProxy: config.server.trustProxy } : {}),
      ...(config.server.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: config.server.sseHeartbeatMs } : {}),
      ...(config.server.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: config.server.maxRequestBodyBytes } : {}),
    },
    auth: {
      mode: config.auth.mode,
      ...(config.auth.apiKey ? { apiKey: config.auth.apiKey } : {}),
      ...(config.auth.proxyApiKey ? { proxyApiKey: config.auth.proxyApiKey } : {}),
      ...(config.auth.oauthCredentialsPath ? { oauthCredentialsPath: config.auth.oauthCredentialsPath } : {}),
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
    promptRewrite: normalizePromptRewriteConfig(config.promptRewrite),
    // Keep upstream feature gates across any dashboard save/restart.
    // Omitting these sections silently re-enabled their loader defaults.
    clientIdentity: { ...config.clientIdentity },
    responses: { enabled: config.responses.enabled, store: { maxEntries: config.responses.storeMaxEntries, ttlMs: config.responses.storeTtlMs } },
    endpointRouting: { ...config.endpointRouting },
    clientSigning: { ...config.clientSigning },
    mcp: { ...config.mcp, gateway: { ...config.mcp.gateway } },
    async: { ...config.async },
    claim: { ...config.claim },
    ...(config.clientConfig ? { clientConfig: { ...config.clientConfig } } : {}),
    ...(config.subscription ? { subscription: { ...config.subscription } } : {}),
    logging: { ...config.logging },
    retry: config.retry ? { ...config.retry, retryableStatuses: [...config.retry.retryableStatuses] } : { ...RETRY_DEFAULTS, retryableStatuses: [...RETRY_DEFAULTS.retryableStatuses] },
    ...(config.corsAllowList && config.corsAllowList.length > 0
      ? { corsAllowList: [...config.corsAllowList] }
      : {}),
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
    // Always emit the anthropic section so the dashboard's toggles persist
    // across saves — otherwise turning ON then saving then turning OFF would
    // leave a stale `true` in the YAML forever.
    anthropic: {
      // v0.2.0.4: forceStream removed — stream:true is now unconditional.
      // Always persist thinkingLevel so users can see/change it in YAML.
      // Default "max" mirrors real ZCode desktop client's max tier.
      thinkingLevel: config.thinkingLevel === "low" || config.thinkingLevel === "high" ? config.thinkingLevel : "max",
    },
  };

  return stringifyYaml(obj, {
    indent: 2,
    lineWidth: 0,        // Don't wrap long strings (URLs, API keys)
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    nullStr: "",
  });
}

export function normalizeRetryableStatuses(values: unknown[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const s of values) {
    const n = typeof s === "number"
      ? s
      : (typeof s === "string" && /^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new Error(`retry.retryableStatuses contains invalid status: ${s}`);
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function normalizeModelList(values: unknown[], defaultModel: unknown): string[] {
  const models = values
    .filter((m): m is string => typeof m === "string")
    .map(m => m.trim())
    .filter(Boolean);
  if (typeof defaultModel === "string" && defaultModel.trim() && !models.includes(defaultModel.trim())) {
    models.push(defaultModel.trim());
  }
  return models;
}

export function normalizeRoutingRulesForSave(values: unknown[]): RoutingRule[] {
  const rules: RoutingRule[] = [];
  for (const item of values) {
    if (!isConfigObject(item)) {
      throw new Error("routingRules entries must be objects");
    }
    if (typeof item.pattern !== "string" || item.pattern.trim() === "") {
      throw new Error("routingRules entries need a non-empty pattern");
    }
    if (item.provider !== "zai" && item.provider !== "bigmodel") {
      throw new Error(`routingRules entry "${item.pattern}" has invalid provider`);
    }
    if (item.endpoint !== undefined && item.endpoint !== null && typeof item.endpoint !== "string") {
      throw new Error("routingRules.endpoint must be a string");
    }
    if (item.note !== undefined && item.note !== null && typeof item.note !== "string") {
      throw new Error("routingRules.note must be a string");
    }
    rules.push({
      pattern: item.pattern.trim(),
      provider: item.provider,
      endpoint: typeof item.endpoint === "string" && item.endpoint.trim() ? item.endpoint.trim() : undefined,
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
    });
  }
  return rules;
}

export function normalizeModelMappingsForSave(values: unknown[]): ModelMapping[] {
  const mappings: ModelMapping[] = [];
  const seenFrom = new Set<string>();
  for (const item of values) {
    if (!isConfigObject(item)) {
      throw new Error("modelMappings entries must be objects");
    }
    if (typeof item.from !== "string" || item.from.trim() === "") {
      throw new Error("modelMappings entries need a non-empty from");
    }
    if (typeof item.to !== "string" || item.to.trim() === "") {
      throw new Error("modelMappings entries need a non-empty to");
    }
    const from = item.from.trim().toLowerCase();
    if (seenFrom.has(from)) {
      throw new Error(`Duplicate modelMappings.from value: "${item.from}"`);
    }
    seenFrom.add(from);
    if (item.note !== undefined && item.note !== null && typeof item.note !== "string") {
      throw new Error("modelMappings.note must be a string");
    }
    mappings.push({
      from,
      to: item.to.trim(),
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
    });
  }
  return mappings;
}

function parseStrictNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function requireStrictNumber(raw: unknown, field: string): number {
  const n = parseStrictNumber(raw);
  if (n === null) throw new Error(`${field} must be a valid number`);
  return n;
}

function normalizeIntegerField(
  obj: Record<string, unknown>,
  key: string,
  field: string,
  opts: { min?: number; max?: number } = {},
): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  const n = requireStrictNumber(obj[key], field);
  if (!Number.isSafeInteger(n)) throw new Error(`${field} must be an integer`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${field} ${n} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${field} ${n} is out of range (${opts.min ?? "-Infinity"}-${opts.max})`);
  obj[key] = n;
}

function normalizePositiveNumberField(obj: Record<string, unknown>, key: string, field: string): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  const n = requireStrictNumber(obj[key], field);
  if (n <= 0) throw new Error(`${field} ${n} must be > 0`);
  obj[key] = n;
}

function normalizeBooleanField(obj: Record<string, unknown>, key: string, field: string): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  const value = obj[key];
  if (typeof value === "boolean") return;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      obj[key] = true;
      return;
    }
    if (normalized === "false" || normalized === "0") {
      obj[key] = false;
      return;
    }
  }
  throw new Error(`${field} must be a boolean`);
}

export function normalizeConfigForSave(cfg: Record<string, unknown>): void {
  const server = cfg.server as Record<string, unknown> | undefined;
  if (server) {
    normalizeIntegerField(server, "port", "server.port", { min: 1, max: 65535 });
    normalizeIntegerField(server, "maxRequestBodyBytes", "server.maxRequestBodyBytes", { min: 0 });
    normalizeIntegerField(server, "upstreamTimeoutMs", "server.upstreamTimeoutMs", { min: 0 });
    normalizeIntegerField(server, "sseHeartbeatMs", "server.sseHeartbeatMs", { min: 0 });
    normalizeBooleanField(server, "trustProxy", "server.trustProxy");
  }

  const retry = cfg.retry as Record<string, unknown> | undefined;
  if (retry) {
    normalizeIntegerField(retry, "maxRetries", "retry.maxRetries", { min: 0 });
    normalizeIntegerField(retry, "initialDelayMs", "retry.initialDelayMs", { min: 1, max: 60_000 });
    normalizeIntegerField(retry, "maxDelayMs", "retry.maxDelayMs", { min: 1, max: 300_000 });
    normalizeIntegerField(retry, "credentialSwitchThreshold", "retry.credentialSwitchThreshold", { min: 0 });
    normalizeIntegerField(retry, "emptyStreamSwitchThreshold", "retry.emptyStreamSwitchThreshold", { min: 0 });
    normalizePositiveNumberField(retry, "backoffFactor", "retry.backoffFactor");
    if (Object.prototype.hasOwnProperty.call(retry, "retryableStatuses")) {
      if (!Array.isArray(retry.retryableStatuses)) {
        throw new Error("retry.retryableStatuses must be an array");
      }
      retry.retryableStatuses = normalizeRetryableStatuses(retry.retryableStatuses);
    }
  }
}

/** Basic validation for config saves from the dashboard. Throws on invalid input. */
export function validateConfigForSave(cfg: Record<string, unknown>): void {
  const server = cfg.server as Record<string, unknown> | undefined;
  if (server) {
    const port = typeof server.port === "number" ? server.port : NaN;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`server.port ${port} is out of range (1-65535)`);
    }
    if (server.host !== undefined && typeof server.host !== "string") {
      throw new Error("server.host must be a string");
    }
    if (typeof server.host === "string" && server.host.length > 0) {
      // Basic host validation: IPv4, IPv6, or hostname. Rejects spaces and
      // most special chars. 0.0.0.0 is allowed (bind to all interfaces).
      const hostRe = /^(\d{1,3}\.){3}\d{1,3}$|^[a-fA-F0-9:]+:[a-fA-F0-9:]+$|^[a-zA-Z0-9._-]+$/;
      if (!hostRe.test(server.host)) {
        throw new Error(`server.host "${server.host}" is not a valid IP or hostname`);
      }
    }
    if (server.maxRequestBodyBytes !== undefined) {
      const maxRequestBodyBytes = typeof server.maxRequestBodyBytes === "number" ? server.maxRequestBodyBytes : NaN;
      if (!Number.isFinite(maxRequestBodyBytes) || maxRequestBodyBytes < 0) {
        throw new Error(`server.maxRequestBodyBytes ${server.maxRequestBodyBytes} must be >= 0`);
      }
    }
    if (server.upstreamTimeoutMs !== undefined && (typeof server.upstreamTimeoutMs !== "number" || server.upstreamTimeoutMs < 0)) {
      throw new Error(`server.upstreamTimeoutMs ${server.upstreamTimeoutMs} must be >= 0`);
    }
    if (server.sseHeartbeatMs !== undefined && (typeof server.sseHeartbeatMs !== "number" || server.sseHeartbeatMs < 0)) {
      throw new Error(`server.sseHeartbeatMs ${server.sseHeartbeatMs} must be >= 0`);
    }
    if (server.trustProxy !== undefined && typeof server.trustProxy !== "boolean") {
      throw new Error("server.trustProxy must be a boolean");
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
      const credential = p?.credential;
      if (credential !== undefined && credential !== null && typeof credential !== "string") {
        throw new Error(`providers.${name}.credential must be a string`);
      }
    }
  }

  // Validate retry config bounds to prevent runaway retry loops.
  // Note: maxRetries has NO upper bound — operators may legitimately want
  // to retry indefinitely (e.g. a flaky upstream during peak hours).
  const retry = cfg.retry as Record<string, unknown> | undefined;
  if (retry) {
    const maxRetries = typeof retry.maxRetries === "number" ? retry.maxRetries : NaN;
    if (Number.isFinite(maxRetries) && maxRetries < 0) {
      throw new Error(`retry.maxRetries ${maxRetries} must be >= 0`);
    }
    const initialDelayMs = typeof retry.initialDelayMs === "number" ? retry.initialDelayMs : NaN;
    if (Number.isFinite(initialDelayMs) && (initialDelayMs < 1 || initialDelayMs > 60_000)) {
      throw new Error(`retry.initialDelayMs ${initialDelayMs} is out of range (1-60000)`);
    }
    const maxDelayMs = typeof retry.maxDelayMs === "number" ? retry.maxDelayMs : NaN;
    if (Number.isFinite(maxDelayMs) && (maxDelayMs < 1 || maxDelayMs > 300_000)) {
      throw new Error(`retry.maxDelayMs ${maxDelayMs} is out of range (1-300000)`);
    }
    if (Array.isArray(retry.retryableStatuses)) {
      for (const s of retry.retryableStatuses) {
        const n = typeof s === "number" ? s : NaN;
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
      : NaN;
    if (Number.isFinite(credentialSwitchThreshold) && credentialSwitchThreshold < 0) {
      throw new Error(`retry.credentialSwitchThreshold ${credentialSwitchThreshold} must be >= 0`);
    }
    // emptyStreamSwitchThreshold (vceshi0.0.5+): 0 = disabled, otherwise the
    // number of consecutive empty-stream 529s before forcing a credential switch.
    const emptyStreamSwitchThreshold = typeof retry.emptyStreamSwitchThreshold === "number"
      ? retry.emptyStreamSwitchThreshold
      : NaN;
    if (Number.isFinite(emptyStreamSwitchThreshold) && emptyStreamSwitchThreshold < 0) {
      throw new Error(`retry.emptyStreamSwitchThreshold ${emptyStreamSwitchThreshold} must be >= 0`);
    }
    // backoffFactor: must be > 0 (0 → all delays become 0, no backoff; negative → invalid)
    const backoffFactor = typeof retry.backoffFactor === "number"
      ? retry.backoffFactor
      : NaN;
    if (Number.isFinite(backoffFactor) && backoffFactor <= 0) {
      throw new Error(`retry.backoffFactor ${backoffFactor} must be > 0`);
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
