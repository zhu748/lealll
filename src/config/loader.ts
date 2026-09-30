/**
 * YAML config loader with env-var overrides and validation.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { ClientIdentityConfig, ProxyConfig, ProviderEndpoints, ProxyIdentity, ResponsesConfig, McpConfig, AsyncConfig, EndpointRoutingConfig, ClientSigningConfig, ClaimConfig, RetryConfig, RoutingRule, ModelMapping, ResponsesThinkingConfig, ClientConfigConfig, SubscriptionConfig } from "./types.js";

/** Environment variable keys that override YAML values. */
const ENV = {
  PORT: "ZCODE_PROXY_PORT",
  PROXY_API_KEY: "ZCODE_PROXY_API_KEY",
  PROVIDER: "ZCODE_PROVIDER",
  APP_VERSION: "ZCODE_APP_VERSION",
  SOURCE_TITLE: "ZCODE_SOURCE_TITLE",
  REFERER_ORIGIN: "ZCODE_REFERER_ORIGIN",
  ASYNC_ENABLED: "ZCODE_ASYNC_ENABLED",
  ASYNC_ORIGIN: "ZCODE_ASYNC_ORIGIN",
  ASYNC_MAX_RETRIES: "ZCODE_ASYNC_MAX_RETRIES",
  ASYNC_MAX_WAIT_MS: "ZCODE_ASYNC_MAX_WAIT_MS",
  CLAIM_ENABLED: "ZCODE_CLAIM_ENABLED",
  CLAIM_AUTO: "ZCODE_CLAIM_AUTO",
  CLAIM_ORIGIN: "ZCODE_CLAIM_ORIGIN",
  CLAIM_POLL_INTERVAL_MS: "ZCODE_CLAIM_POLL_INTERVAL_MS",
  ENDPOINT_ROUTING_ENABLED: "ZCODE_ENDPOINT_ROUTING",
  CLIENT_SIGNING_ENABLED: "ZCODE_CLIENT_SIGNING",
  MCP_GATEWAY_ENABLED: "ZCODE_MCP_GATEWAY",
  MCP_GATEWAY_ORIGIN: "ZCODE_MCP_GATEWAY_ORIGIN",
  MCP_USAGE_ENABLED: "ZCODE_MCP_USAGE_ENABLED",
  CLIENT_CONFIG_REFRESH_ON_START: "ZCODE_CLIENT_CONFIG_REFRESH_ON_START",
  CLIENT_CONFIG_ORIGIN: "ZCODE_CLIENT_CONFIG_ORIGIN",
  SUBSCRIPTION_CHECK_ON_SWITCH: "ZCODE_SUBSCRIPTION_CHECK_ON_SWITCH",
  SUBSCRIPTION_ORIGIN: "ZCODE_SUBSCRIPTION_ORIGIN",
  // --- fork multi-account / resilience extensions ---
  AUTH_MODE: "ZCODE_PROXY_AUTH_MODE",
  API_KEY: "ZCODE_PROXY_APIKEY",
  UPSTREAM_TIMEOUT_MS: "ZCODE_PROXY_UPSTREAM_TIMEOUT_MS",
  TRUST_PROXY: "ZCODE_PROXY_TRUST_PROXY",
  SSE_HEARTBEAT_MS: "ZCODE_PROXY_SSE_HEARTBEAT_MS",
  MAX_REQUEST_BODY_BYTES: "ZCODE_PROXY_MAX_REQUEST_BODY_BYTES",
  RETRY_MAX: "ZCODE_RETRY_MAX",
  RETRY_INITIAL_DELAY_MS: "ZCODE_RETRY_INITIAL_DELAY_MS",
  RETRY_MAX_DELAY_MS: "ZCODE_RETRY_MAX_DELAY_MS",
  RETRY_BACKOFF_FACTOR: "ZCODE_RETRY_BACKOFF_FACTOR",
  RETRY_STATUSES: "ZCODE_RETRY_STATUSES",
  RETRY_CREDENTIAL_SWITCH_THRESHOLD: "ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD",
  RETRY_EMPTY_STREAM_SWITCH_THRESHOLD: "ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD",
  RETRY_TOTAL_DEADLINE_MS: "ZCODE_RETRY_TOTAL_DEADLINE_MS",
} as const;

/** Mirrors the ZCode desktop release (`_reverse/NOTEPAD.md`); bump per client
 *  release or User-Agent/X-ZCode-App-Version become distinguishable. */
export const DEFAULT_APP_VERSION = "3.14.4";

const DEFAULTS = {
  PORT: 8080,
  HOST: "0.0.0.0",
  PROVIDER: "zai" as const,
  PLAN: "coding-plan" as const,
  DEFAULT_MODEL: "glm-4.6",
  LOG_LEVEL: "info" as const,
  ZAI_ANTHROPIC_BASE: "https://api.z.ai/api/anthropic",
  ZAI_OPENAI_BASE: "https://api.z.ai/api/coding/paas/v4",
  BIGMODEL_ANTHROPIC_BASE: "https://open.bigmodel.cn/api/anthropic",
  BIGMODEL_OPENAI_BASE: "https://open.bigmodel.cn/api/coding/paas/v4",
  APP_VERSION: DEFAULT_APP_VERSION,
  SOURCE_TITLE: "cli",
  REFERER_ORIGIN: "https://zcode.z.ai",
  CLIENT_IDENTITY_MODE: "observe" as const,
  CLIENT_IDENTITY_TTL_SECONDS: 900,
  CLIENT_IDENTITY_MAX_SESSIONS: 1024,
  RESPONSES_ENABLED: true,
  RESPONSES_STORE_MAX_ENTRIES: 1000,
  RESPONSES_STORE_TTL_MS: 24 * 60 * 60 * 1000,
  MCP_ENABLED: true,
  MCP_WEB_SEARCH: true,
  MCP_WEB_READER: false,
  MCP_ZREAD: false,
  MCP_GATEWAY_ENABLED: true,
  // Production default for `${ZCODE_BASE_URL}` in plugin .mcp.json URLs (glm
  // bundle `jee`; the `sYe` fallback "https://zcode.chatglm.site" is the TEST
  // env origin — NOT for production traffic. 3.14.3 `p1`/`air`).
  MCP_GATEWAY_ORIGIN: "https://zcode.z.ai",
  // 3.14.4 supplemental (v4.7.5-fork.1): MCP usage quota + remote provider config + subscription availability
  MCP_USAGE_ENABLED: true,
  CLIENT_CONFIG_REFRESH_ON_START: true,
  CLIENT_CONFIG_ORIGIN: "https://zcode.z.ai",
  CLIENT_CONFIG_TIMEOUT_MS: 20000,
  SUBSCRIPTION_CHECK_ON_SWITCH: true,
  SUBSCRIPTION_ORIGIN: "https://api.z.ai",
  SUBSCRIPTION_TIMEOUT_MS: 15000,
  ASYNC_ENABLED: false,
  ASYNC_ORIGIN: "https://zcode.z.ai",
  ASYNC_POLL_INTERVAL_MS: 5000,
  ASYNC_KEEPALIVE_INTERVAL_MS: 3000,
  ASYNC_MAX_WAIT_MS: 0,
  ASYNC_MAX_RETRIES: 3,
  ASYNC_SETTLE_TIMEOUT_MS: 8000,
  ASYNC_CONTROL_TIMEOUT_MS: 15000,
  ASYNC_DEFAULT_MODEL: "",
  CLAIM_ENABLED: true,
  CLAIM_AUTO: true,
  CLAIM_ORIGIN: "https://zcode.z.ai",
  CLAIM_POLL_INTERVAL_MS: 300000,
  CLAIM_COOLDOWN_MS: 600000,
  CLAIM_PLAN_ID: "",
  ENDPOINT_ROUTING_ENABLED: true,
  ENDPOINT_ROUTING_ORIGIN: "https://zcode.z.ai",
  CLIENT_SIGNING_ENABLED: true,
  CLIENT_SIGNING_ORIGIN: "https://zcode.z.ai",
  // --- fork multi-account / resilience extensions ---
  AUTH_MODE: "oauth" as const,
  UPSTREAM_TIMEOUT_MS: 0,
  SSE_HEARTBEAT_MS: 15000,
  MAX_REQUEST_BODY_BYTES: 64 * 1024 * 1024,
  RETRY_MAX_RETRIES: 3,
  RETRY_INITIAL_DELAY_MS: 1000,
  RETRY_MAX_DELAY_MS: 8000,
  RETRY_BACKOFF_FACTOR: 2,
  RETRY_STATUSES: [529, 429],
  RETRY_CREDENTIAL_SWITCH_THRESHOLD: 2,
  RETRY_EMPTY_STREAM_SWITCH_THRESHOLD: 3,
  RETRY_TOTAL_DEADLINE_MS: 300000,
};

/** Printable-ASCII gate copied from the ZCode bundle's `rYn` helper. */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

/**
 * Load and validate proxy configuration from a YAML file, applying env overrides.
 * @throws Error if file not found or required fields are invalid.
 */
export function loadConfig(path: string): ProxyConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw) ?? {};

  // --- server ---
  const port = resolvePort(process.env[ENV.PORT] ?? parsed?.server?.port);
  const host = typeof parsed?.server?.host === "string" ? parsed.server.host : DEFAULTS.HOST;

  // --- server (fork extensions) ---
  const upstreamTimeoutMs = resolveNonNegativeInt(
    process.env[ENV.UPSTREAM_TIMEOUT_MS] ?? parsed?.server?.upstreamTimeoutMs,
    DEFAULTS.UPSTREAM_TIMEOUT_MS,
  );
  const trustProxyRaw = process.env[ENV.TRUST_PROXY] ?? parsed?.server?.trustProxy;
  const trustProxy = trustProxyRaw === true || trustProxyRaw === "true" || trustProxyRaw === "1";
  const sseHeartbeatMs = resolveNonNegativeInt(
    process.env[ENV.SSE_HEARTBEAT_MS] ?? parsed?.server?.sseHeartbeatMs,
    DEFAULTS.SSE_HEARTBEAT_MS,
  );
  const maxRequestBodyBytes = resolveNonNegativeInt(
    process.env[ENV.MAX_REQUEST_BODY_BYTES] ?? parsed?.server?.maxRequestBodyBytes,
    DEFAULTS.MAX_REQUEST_BODY_BYTES,
  );

  // --- auth ---
  const proxyApiKey = process.env[ENV.PROXY_API_KEY] ?? parsed?.auth?.proxyApiKey;
  const oauthCredentialsPath = parsed?.auth?.oauthCredentialsPath;
  // Fork multi-account layer: mode selects between the encrypted multi-account
  // store ("oauth", default) and a static config string ("apikey").
  const modeEnv = process.env[ENV.AUTH_MODE]?.toLowerCase().trim();
  const authMode: "apikey" | "oauth" =
    modeEnv === "oauth" ? "oauth"
    : modeEnv === "apikey" ? "apikey"
    : (parsed?.auth?.mode === "apikey" ? "apikey" : DEFAULTS.AUTH_MODE);
  const authApiKey = process.env[ENV.API_KEY] ?? (typeof parsed?.auth?.apiKey === "string" ? parsed.auth.apiKey : undefined);

  // --- provider ---
  const provider = resolveProvider(process.env[ENV.PROVIDER] ?? parsed?.provider);
  const plan = resolvePlan(parsed?.plan);

  // --- providers ---
  const zai: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.zai?.anthropicBase ?? DEFAULTS.ZAI_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.zai?.openaiBase ?? DEFAULTS.ZAI_OPENAI_BASE,
    ...(typeof parsed?.providers?.zai?.credential === "string" ? { credential: parsed.providers.zai.credential } : {}),
  };
  const bigmodel: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.bigmodel?.anthropicBase ?? DEFAULTS.BIGMODEL_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.bigmodel?.openaiBase ?? DEFAULTS.BIGMODEL_OPENAI_BASE,
    ...(typeof parsed?.providers?.bigmodel?.credential === "string" ? { credential: parsed.providers.bigmodel.credential } : {}),
  };

  // --- models ---
  const defaultModel = typeof parsed?.defaultModel === "string" ? parsed.defaultModel : DEFAULTS.DEFAULT_MODEL;
  const models = Array.isArray(parsed?.models) ? parsed.models : [defaultModel];

  // --- logging ---
  const logLevel = resolveLogLevel(parsed?.logging?.level);

  // --- identity ---
  const identity = resolveIdentity({
    appVersionEnv: process.env[ENV.APP_VERSION],
    appVersionYaml: parsed?.identity?.appVersion,
    sourceTitleEnv: process.env[ENV.SOURCE_TITLE],
    sourceTitleYaml: parsed?.identity?.sourceTitle,
    refererEnv: process.env[ENV.REFERER_ORIGIN],
    refererYaml: parsed?.identity?.refererOrigin,
    deviceMidYaml: parsed?.identity?.deviceMid,
  });

  const clientIdentity = resolveClientIdentity(parsed?.clientIdentity);
  const responses = resolveResponsesConfig(parsed?.responses);
  const mcp = resolveMcpConfig(parsed?.mcp);
  const clientConfig = resolveClientConfig(parsed?.clientConfig);
  const subscription = resolveSubscriptionConfig(parsed?.subscription);
  const asyncCfg = resolveAsyncConfig(parsed?.async);
  const claimCfg = resolveClaimConfig(parsed?.claim);
  const endpointRouting = resolveEndpointRoutingConfig(parsed?.endpointRouting);
  const clientSigning = resolveClientSigningConfig(parsed?.clientSigning);

  // --- fork dashboard / resilience extensions ---
  const retry = resolveRetry(parsed?.retry);
  const routingRules = resolveRoutingRules(parsed?.routingRules);
  const modelMappings = resolveModelMappings(parsed?.modelMappings);
  const responsesThinking = resolveResponsesThinking(parsed?.responsesThinking);
  const verboseLogging = process.env.ZCODE_PROXY_VERBOSE_LOGGING === "1"
    || (typeof parsed?.logging === "object" && parsed?.logging?.verbose === true);
  const debugLogging = process.env.ZCODE_PROXY_DEBUG_LOGGING === "1"
    || (typeof parsed?.logging === "object" && parsed?.logging?.debug === true);
  const headerDebug = process.env.ZCODE_PROXY_HEADER_DEBUG === "1"
    || (typeof parsed?.logging === "object" && parsed?.logging?.headerDebug === true);
  const logFile = process.env.ZCODE_PROXY_LOG_FILE
    ?? (typeof parsed?.logging?.file === "string" ? parsed.logging.file : undefined);
  const corsAllowList = resolveCorsAllowList(
    process.env.ZCODE_PROXY_CORS_ALLOWLIST
      ? String(process.env.ZCODE_PROXY_CORS_ALLOWLIST).split(",")
      : parsed?.corsAllowList,
  );
  const thinkingLevelRaw = process.env.ZCODE_PROXY_THINKING_LEVEL ?? parsed?.thinkingLevel;
  const thinkingLevel: "low" | "high" | "max" =
    thinkingLevelRaw === "low" || thinkingLevelRaw === "high" ? thinkingLevelRaw : "max";

  const config: ProxyConfig = {
    server: { port, host, upstreamTimeoutMs, trustProxy, sseHeartbeatMs, maxRequestBodyBytes },
    auth: { proxyApiKey, mode: authMode, apiKey: authApiKey, oauthCredentialsPath },
    provider,
    plan,
    providers: { zai, bigmodel },
    defaultModel,
    models,
    identity,
    clientIdentity,
    responses,
    endpointRouting,
    clientSigning,
    mcp,
    ...(clientConfig ? { clientConfig } : {}),
    ...(subscription ? { subscription } : {}),
    async: asyncCfg,
    claim: claimCfg,
    logging: { level: logLevel, verbose: verboseLogging, debug: debugLogging, file: logFile, headerDebug },
    retry,
    corsAllowList,
    routingRules,
    modelMappings,
    responsesThinking,
    thinkingLevel,
  };

  validate(config);
  return config;
}

function resolveClientIdentity(raw: unknown): ClientIdentityConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = resolveClientIdentityMode(obj.mode);
  const ttlSeconds = resolvePositiveInt(obj.ttlSeconds, DEFAULTS.CLIENT_IDENTITY_TTL_SECONDS, "clientIdentity.ttlSeconds");
  const maxSessions = resolvePositiveInt(obj.maxSessions, DEFAULTS.CLIENT_IDENTITY_MAX_SESSIONS, "clientIdentity.maxSessions");
  return { mode, ttlSeconds, maxSessions };
}

function resolveClientIdentityMode(raw: unknown): ClientIdentityConfig["mode"] {
  if (raw === undefined || raw === null) return DEFAULTS.CLIENT_IDENTITY_MODE;
  if (raw === "off" || raw === "observe" || raw === "enforce") return raw;
  throw new Error(`Invalid clientIdentity.mode "${String(raw)}": must be "off", "observe", or "enforce"`);
}

function resolveResponsesConfig(raw: unknown): ResponsesConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const storeRaw = obj.store && typeof obj.store === "object" ? obj.store as Record<string, unknown> : {};
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.RESPONSES_ENABLED),
    storeMaxEntries: resolvePositiveInt(storeRaw.maxEntries, DEFAULTS.RESPONSES_STORE_MAX_ENTRIES, "responses.store.maxEntries"),
    storeTtlMs: resolvePositiveInt(storeRaw.ttlMs, DEFAULTS.RESPONSES_STORE_TTL_MS, "responses.store.ttlMs"),
  };
}

function resolveMcpConfig(raw: unknown): McpConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const gwRaw = obj.gateway && typeof obj.gateway === "object" ? obj.gateway as Record<string, unknown> : {};
  const gwEnabledEnv = process.env[ENV.MCP_GATEWAY_ENABLED];
  const gwOriginEnv = process.env[ENV.MCP_GATEWAY_ORIGIN];
  const gwOrigin = (gwOriginEnv ?? (typeof gwRaw.upstreamOrigin === "string" ? gwRaw.upstreamOrigin : DEFAULTS.MCP_GATEWAY_ORIGIN)).trim()
    || DEFAULTS.MCP_GATEWAY_ORIGIN;
  validateOrigin(gwOrigin, "mcp.gateway.upstreamOrigin");
  const usageEnabledEnv = process.env[ENV.MCP_USAGE_ENABLED];
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.MCP_ENABLED),
    webSearch: resolveBool(obj.webSearch ?? obj.web_search, DEFAULTS.MCP_WEB_SEARCH),
    webReader: resolveBool(obj.webReader ?? obj.web_reader, DEFAULTS.MCP_WEB_READER),
    zread: resolveBool(obj.zread, DEFAULTS.MCP_ZREAD),
    usageEnabled: usageEnabledEnv !== undefined ? resolveBool(usageEnabledEnv, DEFAULTS.MCP_USAGE_ENABLED) : resolveBool(obj.usageEnabled ?? obj.usage_enabled, DEFAULTS.MCP_USAGE_ENABLED),
    gateway: {
      enabled: gwEnabledEnv !== undefined ? resolveBool(gwEnabledEnv, DEFAULTS.MCP_GATEWAY_ENABLED) : resolveBool(gwRaw.enabled, DEFAULTS.MCP_GATEWAY_ENABLED),
      upstreamOrigin: gwOrigin,
    },
  };
}

/**
 * Resolve the optional `clientConfig` section (3.14.4 supplemental,
 * v4.7.5-fork.1). Absent YAML + absent env → undefined (the proxy uses
 * local-only `models`); present env with absent YAML returns an explicit
 * disabled-enabled flag so operators can opt out without writing a section.
 */
function resolveClientConfig(raw: unknown): ClientConfigConfig | undefined {
  if (raw === undefined || raw === null) {
    const envOff = process.env[ENV.CLIENT_CONFIG_REFRESH_ON_START];
    if (envOff === undefined) return undefined;
    return {
      refreshOnStart: resolveBool(envOff, DEFAULTS.CLIENT_CONFIG_REFRESH_ON_START),
      origin: DEFAULTS.CLIENT_CONFIG_ORIGIN,
      timeoutMs: DEFAULTS.CLIENT_CONFIG_TIMEOUT_MS,
    };
  }
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const originEnv = process.env[ENV.CLIENT_CONFIG_ORIGIN];
  const origin = (originEnv ?? (typeof obj.origin === "string" ? obj.origin : DEFAULTS.CLIENT_CONFIG_ORIGIN)).trim()
    || DEFAULTS.CLIENT_CONFIG_ORIGIN;
  validateOrigin(origin, "clientConfig.origin");
  const refreshEnv = process.env[ENV.CLIENT_CONFIG_REFRESH_ON_START];
  return {
    refreshOnStart: refreshEnv !== undefined ? resolveBool(refreshEnv, DEFAULTS.CLIENT_CONFIG_REFRESH_ON_START) : resolveBool(obj.refreshOnStart ?? obj.refresh_on_start, DEFAULTS.CLIENT_CONFIG_REFRESH_ON_START),
    origin,
    timeoutMs: resolvePositiveInt(obj.timeoutMs ?? obj.timeout_ms, DEFAULTS.CLIENT_CONFIG_TIMEOUT_MS, "clientConfig.timeoutMs"),
  };
}

/**
 * Resolve the optional `subscription` section (3.14.4 supplemental,
 * v4.7.5-fork.1). Same absent-section semantics as `clientConfig`.
 */
function resolveSubscriptionConfig(raw: unknown): SubscriptionConfig | undefined {
  if (raw === undefined || raw === null) {
    const envOff = process.env[ENV.SUBSCRIPTION_CHECK_ON_SWITCH];
    if (envOff === undefined) return undefined;
    return {
      checkOnSwitch: resolveBool(envOff, DEFAULTS.SUBSCRIPTION_CHECK_ON_SWITCH),
      origin: DEFAULTS.SUBSCRIPTION_ORIGIN,
      timeoutMs: DEFAULTS.SUBSCRIPTION_TIMEOUT_MS,
    };
  }
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const originEnv = process.env[ENV.SUBSCRIPTION_ORIGIN];
  const origin = (originEnv ?? (typeof obj.origin === "string" ? obj.origin : DEFAULTS.SUBSCRIPTION_ORIGIN)).trim()
    || DEFAULTS.SUBSCRIPTION_ORIGIN;
  validateOrigin(origin, "subscription.origin");
  const checkEnv = process.env[ENV.SUBSCRIPTION_CHECK_ON_SWITCH];
  return {
    checkOnSwitch: checkEnv !== undefined ? resolveBool(checkEnv, DEFAULTS.SUBSCRIPTION_CHECK_ON_SWITCH) : resolveBool(obj.checkOnSwitch ?? obj.check_on_switch, DEFAULTS.SUBSCRIPTION_CHECK_ON_SWITCH),
    origin,
    timeoutMs: resolvePositiveInt(obj.timeoutMs ?? obj.timeout_ms, DEFAULTS.SUBSCRIPTION_TIMEOUT_MS, "subscription.timeoutMs"),
  };
}

function resolveAsyncConfig(raw: unknown): AsyncConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.ASYNC_ENABLED];
  const originEnv = process.env[ENV.ASYNC_ORIGIN];
  const maxRetriesEnv = process.env[ENV.ASYNC_MAX_RETRIES];
  const maxWaitMsEnv = process.env[ENV.ASYNC_MAX_WAIT_MS];

  const origin = (originEnv ?? (typeof obj.origin === "string" ? obj.origin : DEFAULTS.ASYNC_ORIGIN)).trim() || DEFAULTS.ASYNC_ORIGIN;
  validateOrigin(origin, "async.origin");

  return {
    enabled: enabledEnv !== undefined ? resolveBool(enabledEnv, DEFAULTS.ASYNC_ENABLED) : resolveBool(obj.enabled, DEFAULTS.ASYNC_ENABLED),
    origin,
    pollIntervalMs: resolvePositiveInt(obj.pollIntervalMs ?? obj.poll_interval_ms, DEFAULTS.ASYNC_POLL_INTERVAL_MS, "async.pollIntervalMs"),
    keepAliveIntervalMs: resolvePositiveInt(obj.keepAliveIntervalMs ?? obj.keepalive_interval_ms, DEFAULTS.ASYNC_KEEPALIVE_INTERVAL_MS, "async.keepAliveIntervalMs"),
    maxWaitMs: resolveNonNegativeInt(maxWaitMsEnv ?? obj.maxWaitMs ?? obj.max_wait_ms, DEFAULTS.ASYNC_MAX_WAIT_MS, "async.maxWaitMs"),
    maxRetries: resolveNonNegativeInt(maxRetriesEnv ?? obj.maxRetries ?? obj.max_retries, DEFAULTS.ASYNC_MAX_RETRIES, "async.maxRetries"),
    settleTimeoutMs: resolvePositiveInt(obj.settleTimeoutMs ?? obj.settle_timeout_ms, DEFAULTS.ASYNC_SETTLE_TIMEOUT_MS, "async.settleTimeoutMs"),
    controlTimeoutMs: resolvePositiveInt(obj.controlTimeoutMs ?? obj.control_timeout_ms, DEFAULTS.ASYNC_CONTROL_TIMEOUT_MS, "async.controlTimeoutMs"),
    defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : DEFAULTS.ASYNC_DEFAULT_MODEL,
  };
}

function validateOrigin(origin: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`${name} "${origin}" is not a valid URL`);
  }
  // Scheme allowlist: only http/https. Other schemes (ftp:, file:, etc.) rejected.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http: or https: scheme (got ${parsed.protocol})`);
  }
  // Cleartext HTTP only for loopback (dev/mock mode). Real off-peak backend requires
  // HTTPS — cleartext would leak the JWT + coding-plan API key to any network observer.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error(`${name} http:// is only allowed for loopback hosts (got ${hostname}). Use https:// for remote origins.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain userinfo`);
  }
  if (parsed.hash) {
    throw new Error(`${name} must not contain a fragment`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${name} must not contain a path (got "${parsed.pathname}"); clients append their own paths`);
  }
  if (parsed.search) {
    throw new Error(`${name} must not contain a query string`);
  }
}

function resolveEndpointRoutingConfig(raw: unknown): EndpointRoutingConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.ENDPOINT_ROUTING_ENABLED];
  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.ENDPOINT_ROUTING_ORIGIN).trim()
    || DEFAULTS.ENDPOINT_ROUTING_ORIGIN;
  validateOrigin(origin, "endpointRouting.origin");
  return {
    enabled: enabledEnv !== undefined ? resolveBool(enabledEnv, DEFAULTS.ENDPOINT_ROUTING_ENABLED) : resolveBool(obj.enabled, DEFAULTS.ENDPOINT_ROUTING_ENABLED),
    origin,
  };
}

function resolveClientSigningConfig(raw: unknown): ClientSigningConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.CLIENT_SIGNING_ENABLED];
  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.CLIENT_SIGNING_ORIGIN).trim()
    || DEFAULTS.CLIENT_SIGNING_ORIGIN;
  validateOrigin(origin, "clientSigning.origin");
  return {
    enabled: enabledEnv !== undefined ? resolveBool(enabledEnv, DEFAULTS.CLIENT_SIGNING_ENABLED) : resolveBool(obj.enabled, DEFAULTS.CLIENT_SIGNING_ENABLED),
    origin,
  };
}

function resolveBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return fallback;
}

function resolvePositiveInt(raw: unknown, fallback: number, name?: string): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) {
    if (name) throw new Error(`${name} must be a positive integer`);
    return fallback;
  }
  return n;
}

function resolveNonNegativeInt(raw: unknown, fallback: number, name?: string): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0) {
    if (name) throw new Error(`${name} must be a non-negative integer`);
    return fallback;
  }
  return n;
}

/** Resolve port from raw value (YAML or env), defaulting to 8080. */
function resolvePort(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULTS.PORT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    throw new Error("server.port must be a valid number");
  }
  return n;
}

/** Resolve and validate provider string. */
function resolveProvider(raw: unknown): "zai" | "bigmodel" {
  const v = typeof raw === "string" ? raw : DEFAULTS.PROVIDER;
  if (v !== "zai" && v !== "bigmodel") {
    throw new Error(`Invalid provider "${v}": must be "zai" or "bigmodel"`);
  }
  return v;
}

/**
 * Resolve and validate the plan tier. Mirrors `resolveProvider`'s hard
 * validation style: an unrecognized value (e.g. `start_plan`/`startplan`
 * typos) THROWS instead of silently falling back to coding-plan — a silent
 * fallback sent users to the wrong upstream (401/403, no captcha/quota flow)
 * with nothing pointing at the config typo.
 */
function resolvePlan(raw: unknown): "coding-plan" | "start-plan" {
  if (raw === undefined || raw === null) return DEFAULTS.PLAN;
  if (raw === "coding-plan" || raw === "start-plan") return raw;
  throw new Error(`Invalid plan "${String(raw)}": must be "coding-plan" or "start-plan"`);
}

/** Resolve log level with fallback. */
function resolveLogLevel(raw: unknown): "debug" | "info" | "warn" | "error" {
  const levels = ["debug", "info", "warn", "error"] as const;
  if (typeof raw === "string" && (levels as readonly string[]).includes(raw)) {
    return raw as "debug" | "info" | "warn" | "error";
  }
  return DEFAULTS.LOG_LEVEL;
}

interface IdentityInputs {
  appVersionEnv?: string;
  appVersionYaml?: string;
  sourceTitleEnv?: string;
  sourceTitleYaml?: string;
  refererEnv?: string;
  refererYaml?: string;
  deviceMidYaml?: string;
}

/** Resolve identity fields (env > YAML > default). Non-ASCII `appVersion` silently falls back to the default. */
function resolveIdentity(inp: IdentityInputs): ProxyIdentity {
  const rawVersion = (inp.appVersionEnv ?? inp.appVersionYaml ?? DEFAULTS.APP_VERSION).trim();
  const appVersion = ASCII_PRINTABLE.test(rawVersion) ? rawVersion : DEFAULTS.APP_VERSION;

  const sourceTitle = (inp.sourceTitleEnv ?? inp.sourceTitleYaml ?? DEFAULTS.SOURCE_TITLE).trim()
    || DEFAULTS.SOURCE_TITLE;

  const refererOrigin = (inp.refererEnv ?? inp.refererYaml ?? DEFAULTS.REFERER_ORIGIN).trim()
    || DEFAULTS.REFERER_ORIGIN;

  const deviceMid = typeof inp.deviceMidYaml === "string" ? inp.deviceMidYaml.trim() : "";
  return { appVersion, sourceTitle, refererOrigin, ...(deviceMid ? { deviceMid } : {}) };
}

/** Cross-field validation after all fields are resolved. */
function resolveClaimConfig(raw: unknown): ClaimConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.CLAIM_ENABLED];
  const autoEnv = process.env[ENV.CLAIM_AUTO];
  const originEnv = process.env[ENV.CLAIM_ORIGIN];
  const pollIntervalEnv = process.env[ENV.CLAIM_POLL_INTERVAL_MS];

  const origin = (originEnv ?? (typeof obj.origin === "string" ? obj.origin : DEFAULTS.CLAIM_ORIGIN)).trim() || DEFAULTS.CLAIM_ORIGIN;
  validateOrigin(origin, "claim.origin");

  return {
    enabled: enabledEnv !== undefined ? resolveBool(enabledEnv, DEFAULTS.CLAIM_ENABLED) : resolveBool(obj.enabled, DEFAULTS.CLAIM_ENABLED),
    auto: autoEnv !== undefined ? resolveBool(autoEnv, DEFAULTS.CLAIM_AUTO) : resolveBool(obj.auto, DEFAULTS.CLAIM_AUTO),
    origin,
    pollIntervalMs: resolvePositiveInt(pollIntervalEnv ?? obj.pollIntervalMs ?? obj.poll_interval_ms, DEFAULTS.CLAIM_POLL_INTERVAL_MS, "claim.pollIntervalMs"),
    cooldownMs: resolvePositiveInt(obj.cooldownMs ?? obj.cooldown_ms, DEFAULTS.CLAIM_COOLDOWN_MS, "claim.cooldownMs"),
    planId: typeof obj.planId === "string" ? obj.planId.trim() : DEFAULTS.CLAIM_PLAN_ID,
  };
}

function validate(config: ProxyConfig): void {
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`server.port ${config.server.port} is out of range (1-65535)`);
  }

  // Fork multi-account layer: in apikey mode a static credential must exist
  // (global or provider-scoped). OAuth mode (default) pulls from the store.
  if (config.auth.mode === "apikey") {
    const hasGlobal = typeof config.auth.apiKey === "string" && config.auth.apiKey.length > 0;
    const hasProvider = typeof config.providers[config.provider].credential === "string";
    if (!hasGlobal && !hasProvider) {
      throw new Error(
        `auth.apiKey is required when auth.mode is "apikey" (or set providers.${config.provider}.credential)`,
      );
    }
  }

  if (!config.models.includes(config.defaultModel)) {
    // defaultModel not in the models list — add it automatically
    config.models.push(config.defaultModel);
  }
}

// ---------------------------------------------------------------------------
// Fork dashboard / resilience extension resolvers
// ---------------------------------------------------------------------------

/** Resolve retry configuration (fork) with env-var overrides and defaults. */
function resolveRetry(raw?: unknown): RetryConfig {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};

  const maxRetries = resolveNonNegativeInt(process.env[ENV.RETRY_MAX] ?? r.maxRetries, DEFAULTS.RETRY_MAX_RETRIES);
  const initialDelayMs = resolvePositiveInt(process.env[ENV.RETRY_INITIAL_DELAY_MS] ?? r.initialDelayMs, DEFAULTS.RETRY_INITIAL_DELAY_MS);
  const maxDelayMs = resolvePositiveInt(process.env[ENV.RETRY_MAX_DELAY_MS] ?? r.maxDelayMs, DEFAULTS.RETRY_MAX_DELAY_MS);
  const backoffFactor = resolvePositiveFloat(process.env[ENV.RETRY_BACKOFF_FACTOR] ?? r.backoffFactor, DEFAULTS.RETRY_BACKOFF_FACTOR);

  // retryableStatuses: env var is comma-separated (e.g. "529,429,503"), YAML is array
  let retryableStatuses = [...DEFAULTS.RETRY_STATUSES];
  const envStatuses = process.env[ENV.RETRY_STATUSES];
  if (typeof envStatuses === "string" && envStatuses.trim().length > 0) {
    retryableStatuses = normalizeRetryableStatuses(envStatuses.split(","), DEFAULTS.RETRY_STATUSES);
  } else if (Array.isArray(r.retryableStatuses) && r.retryableStatuses.length > 0) {
    retryableStatuses = normalizeRetryableStatuses(r.retryableStatuses, DEFAULTS.RETRY_STATUSES);
  }

  const credentialSwitchThreshold = resolveNonNegativeInt(
    process.env[ENV.RETRY_CREDENTIAL_SWITCH_THRESHOLD] ?? r.credentialSwitchThreshold,
    DEFAULTS.RETRY_CREDENTIAL_SWITCH_THRESHOLD,
  );
  const emptyStreamSwitchThreshold = resolveNonNegativeInt(
    process.env[ENV.RETRY_EMPTY_STREAM_SWITCH_THRESHOLD] ?? r.emptyStreamSwitchThreshold,
    DEFAULTS.RETRY_EMPTY_STREAM_SWITCH_THRESHOLD,
  );
  const totalDeadlineMs = resolveNonNegativeInt(
    process.env[ENV.RETRY_TOTAL_DEADLINE_MS] ?? r.totalDeadlineMs,
    DEFAULTS.RETRY_TOTAL_DEADLINE_MS,
  );

  return { maxRetries, initialDelayMs, maxDelayMs, backoffFactor, retryableStatuses, credentialSwitchThreshold, emptyStreamSwitchThreshold, totalDeadlineMs };
}

function resolvePositiveFloat(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeRetryableStatuses(raw: unknown[], fallback: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    const n = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!Number.isInteger(n) || n < 100 || n > 599) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : [...fallback];
}

/** Resolve routing rules from YAML, validating each rule's shape. */
function resolveRoutingRules(raw: unknown): RoutingRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: RoutingRule[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.pattern !== "string" || r.pattern.trim() === "") continue;
    if (r.provider !== "zai" && r.provider !== "bigmodel") continue;
    rules.push({
      pattern: r.pattern.trim(),
      provider: r.provider,
      endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : undefined,
      note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
    });
  }
  return rules;
}

/** Resolve model mappings from YAML. `from` is lowercased for case-insensitive lookup. */
function resolveModelMappings(raw: unknown): ModelMapping[] {
  if (!Array.isArray(raw)) return [];
  const mappings: ModelMapping[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.from !== "string" || m.from.trim() === "") continue;
    if (typeof m.to !== "string" || m.to.trim() === "") continue;
    mappings.push({
      from: m.from.trim().toLowerCase(),
      to: m.to.trim(),
      note: typeof m.note === "string" && m.note.trim() ? m.note.trim() : undefined,
    });
  }
  return mappings;
}

/**
 * Resolve responses-thinking override from YAML. Accepts either
 * `{ models: [...] }` (canonical) or a bare array of model ids (shorthand).
 */
function resolveResponsesThinking(raw: unknown): ResponsesThinkingConfig {
  const arr: unknown = Array.isArray(raw)
    ? raw
    : (typeof raw === "object" && raw !== null)
      ? (raw as Record<string, unknown>).models
      : undefined;
  if (!Array.isArray(arr)) return { models: [] };
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(id);
  }
  return { models };
}

/** Parse CORS allowlist from env (`a,b`) or YAML (`[a, b]`). */
function resolveCorsAllowList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const list = raw.map((entry) => {
      if (typeof entry !== "string") {
        throw new Error("corsAllowList must contain only strings");
      }
      return entry.trim();
    }).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return undefined;
    const list = raw.split(",").map(s => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}
