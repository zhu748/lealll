/**
 * YAML config loader with env-var overrides and validation.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ProxyConfig, ProviderEndpoints, ProxyIdentity, RetryConfig, RoutingRule, ModelMapping, ResponsesThinkingConfig, ClientIdentityConfig, EndpointRoutingConfig, ClientSigningConfig, AsyncConfig } from "./types.js";

/** Environment variable keys that override YAML values. */
const ENV = {
  PORT: "ZCODE_PROXY_PORT",
  PROXY_API_KEY: "ZCODE_PROXY_API_KEY",
  PROVIDER: "ZCODE_PROVIDER",
  API_KEY: "ZCODE_API_KEY",
  AUTH_MODE: "ZCODE_AUTH_MODE",
  APP_VERSION: "ZCODE_APP_VERSION",
  SOURCE_TITLE: "ZCODE_SOURCE_TITLE",
  REFERER_ORIGIN: "ZCODE_REFERER_ORIGIN",
  RELEASE_CHANNEL: "ZCODE_RELEASE_CHANNEL",
  DEVICE_MID: "ZCODE_DEVICE_MID",
  ZCODE_AGENT: "ZCODE_AGENT",
  RETRY_MAX: "ZCODE_RETRY_MAX",
  RETRY_INITIAL_DELAY_MS: "ZCODE_RETRY_INITIAL_DELAY_MS",
  RETRY_MAX_DELAY_MS: "ZCODE_RETRY_MAX_DELAY_MS",
  RETRY_BACKOFF_FACTOR: "ZCODE_RETRY_BACKOFF_FACTOR",
  RETRY_STATUSES: "ZCODE_RETRY_STATUSES",
  RETRY_CREDENTIAL_SWITCH_THRESHOLD: "ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD",
  RETRY_EMPTY_STREAM_SWITCH_THRESHOLD: "ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD",
  UPSTREAM_TIMEOUT_MS: "ZCODE_UPSTREAM_TIMEOUT_MS",
  TRUST_PROXY: "ZCODE_PROXY_TRUST_PROXY",
  SSE_HEARTBEAT_MS: "ZCODE_PROXY_SSE_HEARTBEAT_MS",
  MAX_REQUEST_BODY_BYTES: "ZCODE_PROXY_MAX_REQUEST_BODY_BYTES",
  ENDPOINT_ROUTING: "ZCODE_ENDPOINT_ROUTING",
  CLIENT_SIGNING: "ZCODE_CLIENT_SIGNING",
  ASYNC_ENABLED: "ZCODE_ASYNC_ENABLED",
} as const;

const DEFAULTS = {
  PORT: 8080,
  HOST: "0.0.0.0",
  // 0 means "use handler defaults": 10 min for streams, 5 min for batch.
  // A non-zero value overrides both paths.
  UPSTREAM_TIMEOUT_MS: 0,
  PROVIDER: "zai" as const,
  PLAN: "coding-plan" as const,
  DEFAULT_MODEL: "glm-4.6",
  LOG_LEVEL: "info" as const,
  ZAI_ANTHROPIC_BASE: "https://api.z.ai/api/anthropic",
  ZAI_OPENAI_BASE: "https://api.z.ai/api/coding/paas/v4",
  BIGMODEL_ANTHROPIC_BASE: "https://open.bigmodel.cn/api/anthropic",
  BIGMODEL_OPENAI_BASE: "https://open.bigmodel.cn/api/coding/paas/v4",
  // v0.3.0 (upstream zcode-api v2.6.0 alignment): appVersion default bumped
  // 3.2.5 → 3.9.1 — the current ZCode client release. The captcha config
  // API and identity headers must present a current version or the gateway
  // treats the traffic as outdated-client.
  // v0.3.1: 3.9.1 → 3.9.2 (ZCode release 2026-08-26 — client-side computer-
  // control permission prompts + browser tab fixes; no wire-protocol change,
  // safe bump). Keep in sync with src/auth/quota.ts DEFAULT_APP_VERSION.
  APP_VERSION: "3.9.2",
  SOURCE_TITLE: "cli",
  REFERER_ORIGIN: "https://zcode.z.ai",
  RELEASE_CHANNEL: "production",
  ZCODE_AGENT: "glm",
  RETRY_MAX_RETRIES: 3,
  RETRY_INITIAL_DELAY_MS: 1000,
  RETRY_MAX_DELAY_MS: 8000,
  RETRY_BACKOFF_FACTOR: 2,
  // v0.2.3.1+: 429 added by default. GLM 上游对超并发返回 429
  // `{"code":3010,"msg":"model admission concurrency limit exceeded"}`,
  // 短暂退避后重试通常能成功。503 不加入默认(偶发但语义模糊,
  // 可能是真正的服务挂了,无脑重试反而加剧);用户需要可通过
  // ZCODE_RETRY_STATUSES=529,429,503 显式开启。
  RETRY_STATUSES: [529, 429],
  // v0.1.5+: lowered from 5 to 2. With maxRetries=3 (default), the old
  // value 5 meant the retry loop ALWAYS exhausted before the switch could
  // trigger — making the feature a no-op. 2 means after the initial
  // failure + 1 retry fail (2 consecutive failures), we switch to the next
  // credential and grant one extra attempt (extraAttemptsFromSwitches=1)
  // so the new credential actually gets tried. Default still safe: if
  // maxRetries is increased, switchThreshold=2 just triggers earlier.
  RETRY_CREDENTIAL_SWITCH_THRESHOLD: 2,
  RETRY_EMPTY_STREAM_SWITCH_THRESHOLD: 3,
  // SSE heartbeat default — well under Cloudflare's 100s Proxy Read Timeout.
  // See src/utils/constants.ts SSE_HEARTBEAT for rationale.
  SSE_HEARTBEAT_MS: 15_000,
  MAX_REQUEST_BODY_BYTES: 64 * 1024 * 1024,
  // v0.3.0 upstream-alignment defaults
  CLIENT_IDENTITY_MODE: "observe" as const,
  CLIENT_IDENTITY_TTL_SECONDS: 900,
  CLIENT_IDENTITY_MAX_SESSIONS: 1024,
  ENDPOINT_ROUTING_ENABLED: true,
  ENDPOINT_ROUTING_ORIGIN: "https://zcode.z.ai",
  CLIENT_SIGNING_ENABLED: true,
  CLIENT_SIGNING_ORIGIN: "https://zcode.z.ai",
  // v0.3.1 (upstream 175ff2a): off-peak async bridge. Off by default —
  // opt-in via `async.enabled: true` or env ZCODE_ASYNC_ENABLED=1.
  ASYNC_ENABLED: false,
  ASYNC_ORIGIN: "https://zcode.z.ai",
  ASYNC_POLL_INTERVAL_MS: 5_000,
  ASYNC_KEEPALIVE_INTERVAL_MS: 3_000,
  ASYNC_MAX_WAIT_MS: 0,
  ASYNC_MAX_RETRIES: 3,
  ASYNC_SETTLE_TIMEOUT_MS: 8_000,
  ASYNC_CONTROL_TIMEOUT_MS: 15_000,
  ASYNC_DEFAULT_MODEL: "",
};

/** Printable-ASCII gate copied from the ZCode bundle's `rYn` helper. */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const MAX_TIMER_MS = 2_147_483_647;

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
  const upstreamTimeoutMs = resolveNonNegativeInt(
    process.env[ENV.UPSTREAM_TIMEOUT_MS] ?? parsed?.server?.upstreamTimeoutMs,
    DEFAULTS.UPSTREAM_TIMEOUT_MS,
    MAX_TIMER_MS,
  );
  // trustProxy: explicit env or YAML flag. Default false — client IP comes
  // from the TCP socket (Bun's server.requestIP), which cannot be spoofed.
  const trustProxyRaw = process.env[ENV.TRUST_PROXY] ?? parsed?.server?.trustProxy;
  const trustProxy = trustProxyRaw === true || trustProxyRaw === "true" || trustProxyRaw === "1";

  // sseHeartbeatMs: interval for no-op SSE comment lines flushed to the
  // client while waiting for the upstream's first byte. Keeps the
  // connection alive across reverse proxies with a Proxy Read Timeout
  // (Cloudflare Free/Pro = 100s). Default 15s. 0 = disabled.
  const sseHeartbeatMs = resolveNonNegativeInt(
    process.env[ENV.SSE_HEARTBEAT_MS] ?? parsed?.server?.sseHeartbeatMs,
    DEFAULTS.SSE_HEARTBEAT_MS,
    MAX_TIMER_MS,
  );
  const maxRequestBodyBytes = resolveNonNegativeInt(
    process.env[ENV.MAX_REQUEST_BODY_BYTES] ?? parsed?.server?.maxRequestBodyBytes,
    DEFAULTS.MAX_REQUEST_BODY_BYTES,
  );

  // --- auth ---
  const proxyApiKey = process.env[ENV.PROXY_API_KEY] ?? parsed?.auth?.proxyApiKey;
  // ZCODE_AUTH_MODE env var overrides YAML. Lets Render users pick between
  // apikey and oauth modes without editing the bundled config.yaml.
  // Accepted values: "apikey" (default) | "oauth"
  const modeEnv = process.env[ENV.AUTH_MODE]?.toLowerCase().trim();
  const mode: "apikey" | "oauth" =
    modeEnv === "oauth" ? "oauth"
    : modeEnv === "apikey" ? "apikey"
    : (parsed?.auth?.mode === "oauth" ? "oauth" : "apikey");
  const apiKey = process.env[ENV.API_KEY] ?? parsed?.auth?.apiKey;
  const oauthCredentialsPath = parsed?.auth?.oauthCredentialsPath;

  // --- provider ---
  const provider = resolveProvider(process.env[ENV.PROVIDER] ?? parsed?.provider);
  const plan = resolvePlan(parsed?.plan);

  // --- providers ---
  const zai: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.zai?.anthropicBase ?? DEFAULTS.ZAI_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.zai?.openaiBase ?? DEFAULTS.ZAI_OPENAI_BASE,
    credential: parsed?.providers?.zai?.credential,
  };
  const bigmodel: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.bigmodel?.anthropicBase ?? DEFAULTS.BIGMODEL_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.bigmodel?.openaiBase ?? DEFAULTS.BIGMODEL_OPENAI_BASE,
    credential: parsed?.providers?.bigmodel?.credential,
  };

  // --- models ---
  const defaultModel = typeof parsed?.defaultModel === "string" ? parsed.defaultModel : DEFAULTS.DEFAULT_MODEL;
  const models = resolveModels(parsed?.models, defaultModel);

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
    releaseChannelEnv: process.env[ENV.RELEASE_CHANNEL],
    releaseChannelYaml: parsed?.identity?.releaseChannel,
    deviceMidEnv: process.env[ENV.DEVICE_MID],
    deviceMidYaml: parsed?.identity?.deviceMid,
    zcodeAgentEnv: process.env[ENV.ZCODE_AGENT],
    zcodeAgentYaml: parsed?.identity?.zcodeAgent,
  });

  // --- retry ---
  const retry = resolveRetry(parsed?.retry);

  // --- routing rules ---
  const routingRules = resolveRoutingRules(parsed?.routingRules);

  // --- model mappings ---
  const modelMappings = resolveModelMappings(parsed?.modelMappings);

  // --- responses thinking override ---
  const responsesThinking = resolveResponsesThinking(parsed?.responsesThinking);

  // --- v0.3.0 upstream-alignment sections ---
  const clientIdentity = resolveClientIdentity(parsed?.clientIdentity);
  const endpointRouting = resolveEndpointRouting(parsed?.endpointRouting);
  const clientSigning = resolveClientSigning(parsed?.clientSigning);
  const asyncConfig = resolveAsyncConfig(parsed?.async);

  // vceshi0.0.6+: verbose logging flag. Env var ZCODE_PROXY_VERBOSE_LOGGING=1
  // enables it at startup; YAML `logging.verbose: true` also works. Dashboard
  // can toggle at runtime via PUT /config (the field is hot-swappable).
  const verboseLogging = process.env.ZCODE_PROXY_VERBOSE_LOGGING === "1"
    || (typeof (parsed as any)?.logging === "object" && (parsed as any).logging?.verbose === true);

  // Debug response logging (this version). Env var
  // ZCODE_PROXY_DEBUG_LOGGING=1 enables it at startup; YAML
  // `logging.debug: true` also works. When true, logs the FULL upstream
  // response (status + headers + body preview) for every request — the
  // "调试日志" for diagnosing 529 / empty 200 / captcha 403 / etc.
  const debugLogging = process.env.ZCODE_PROXY_DEBUG_LOGGING === "1"
    || (typeof (parsed as any)?.logging === "object" && (parsed as any).logging?.debug === true);

  // G3: File logging path — when set, log entries are also written to disk.
  const logFile = (typeof (parsed as any)?.logging === "object" && typeof (parsed as any).logging?.file === "string")
    ? (parsed as any).logging.file
    : undefined;

  // v0.2.0.9+: header debug logging — writes per-request JSON files capturing
  // the inbound client headers + the outbound (translated) upstream headers,
  // so the operator can verify the translation pipeline has no header defects.
  // Only the FIRST fetch per request is recorded (retries/captcha re-solves
  // are skipped) to keep the output one-file-per-request.
  const headerDebug = process.env.ZCODE_PROXY_HEADER_DEBUG === "1"
    || (typeof (parsed as any)?.logging === "object" && (parsed as any).logging?.headerDebug === true);

  // --- CORS allowlist ---
  const corsAllowList = resolveCorsAllowList(
    process.env.ZCODE_PROXY_CORS_ALLOWLIST !== undefined
      ? process.env.ZCODE_PROXY_CORS_ALLOWLIST
      : parsed?.corsAllowList,
  );

  // v0.2.0.4: `forceStreamAnthropic` config option removed.
  // `stream: true` is now forced unconditionally inside alignZCodeRequestFormat
  // (body-transformer.ts) to match the real ZCode desktop client's wire shape.
  // The env vars `ZCODE_PROXY_FORCE_STREAM_ANTHROPIC` and YAML
  // `anthropic.forceStream` are no longer read — they're silently ignored
  // if present in existing configs (no error, just dead config).

  // --- ZCode thinking level (controls budget_tokens + effort when thinking enabled) ---
  // Two tiers mirror real ZCode desktop client:
  //   "max"  (default): max_tokens=64000, budget_tokens=32000, effort="max"
  //   "high"          : max_tokens=64000, budget_tokens=16000, effort="high"
  // When client doesn't send `thinking`, only max_tokens=64000 is injected
  // (ZCode "no thinking" mode) — proxy never forces thinking on.
  // Env var: ZCODE_PROXY_THINKING_LEVEL=high|max
  const thinkingLevelEnv = process.env.ZCODE_PROXY_THINKING_LEVEL;
  const thinkingLevel: "high" | "max" = thinkingLevelEnv === "high" || parsed?.anthropic?.thinkingLevel === "high"
    ? "high"
    : "max";

  const config: ProxyConfig = {
    server: { port, host, upstreamTimeoutMs, trustProxy, sseHeartbeatMs, maxRequestBodyBytes },
    auth: { proxyApiKey, mode, apiKey, oauthCredentialsPath },
    provider,
    plan,
    providers: { zai, bigmodel },
    defaultModel,
    models,
    thinkingLevel,
    corsAllowList,
    identity,
    clientIdentity,
    endpointRouting,
    clientSigning,
    async: asyncConfig,
    logging: { level: logLevel, verbose: verboseLogging, debug: debugLogging, file: logFile, headerDebug },
    retry,
    routingRules,
    modelMappings,
    responsesThinking,
  };

  validate(config);
  return config;
}

/** Resolve port from raw value (YAML or env), defaulting to 8080. */
function resolvePort(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULTS.PORT;
  const n = parseStrictNumber(raw);
  if (n === null || !Number.isInteger(n)) {
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

function resolvePlan(raw: unknown): "coding-plan" | "start-plan" {
  if (raw === undefined || raw === null) return DEFAULTS.PLAN;
  if (raw === "coding-plan") return "coding-plan";
  if (raw === "start-plan") return "start-plan";
  throw new Error(`Invalid plan "${String(raw)}": must be "coding-plan" or "start-plan"`);
}

/** Resolve log level with fallback. */
function resolveLogLevel(raw: unknown): "debug" | "info" | "warn" | "error" {
  const levels = ["debug", "info", "warn", "error"] as const;
  if (typeof raw === "string" && levels.includes(raw as any)) {
    return raw as any;
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
  releaseChannelEnv?: string;
  releaseChannelYaml?: string;
  deviceMidEnv?: string;
  deviceMidYaml?: string;
  zcodeAgentEnv?: string;
  zcodeAgentYaml?: string;
}

/** Resolve identity fields (env > YAML > default). Non-ASCII values silently fall back to the default. */
function resolveIdentity(inp: IdentityInputs): ProxyIdentity {
  const rawVersion = (inp.appVersionEnv ?? inp.appVersionYaml ?? DEFAULTS.APP_VERSION).trim();
  const appVersion = ASCII_PRINTABLE.test(rawVersion) ? rawVersion : DEFAULTS.APP_VERSION;

  const sourceTitle = (inp.sourceTitleEnv ?? inp.sourceTitleYaml ?? DEFAULTS.SOURCE_TITLE).trim()
    || DEFAULTS.SOURCE_TITLE;

  const refererOrigin = (inp.refererEnv ?? inp.refererYaml ?? DEFAULTS.REFERER_ORIGIN).trim()
    || DEFAULTS.REFERER_ORIGIN;

  const rawReleaseChannel = (inp.releaseChannelEnv ?? inp.releaseChannelYaml ?? DEFAULTS.RELEASE_CHANNEL).trim();
  const releaseChannel = ASCII_PRINTABLE.test(rawReleaseChannel) ? rawReleaseChannel : DEFAULTS.RELEASE_CHANNEL;

  const rawDeviceMid = (inp.deviceMidEnv ?? inp.deviceMidYaml ?? readExistingZCodeDeviceMid())?.trim() ?? "";
  const deviceMid = rawDeviceMid && ASCII_PRINTABLE.test(rawDeviceMid) ? rawDeviceMid : undefined;

  const rawZCodeAgent = (inp.zcodeAgentEnv ?? inp.zcodeAgentYaml ?? DEFAULTS.ZCODE_AGENT).trim();
  const zcodeAgent = ASCII_PRINTABLE.test(rawZCodeAgent) ? rawZCodeAgent : DEFAULTS.ZCODE_AGENT;

  return { appVersion, sourceTitle, refererOrigin, releaseChannel, deviceMid, zcodeAgent };
}

/**
 * Resolve the client identity from env vars + built-in defaults — no config
 * file required. Used by code paths that run outside `serve` (e.g. the
 * `auth login` CLI OAuth flow, which may run on a host without config.yaml
 * but still needs the real-client identity headers on the token exchange).
 * Env > defaults, exactly like the YAML path inside loadConfig().
 */
export function resolveDefaultIdentity(): ProxyIdentity {
  return resolveIdentity({
    appVersionEnv: process.env[ENV.APP_VERSION],
    sourceTitleEnv: process.env[ENV.SOURCE_TITLE],
    refererEnv: process.env[ENV.REFERER_ORIGIN],
    releaseChannelEnv: process.env[ENV.RELEASE_CHANNEL],
    deviceMidEnv: process.env[ENV.DEVICE_MID],
    zcodeAgentEnv: process.env[ENV.ZCODE_AGENT],
  });
}

function readExistingZCodeDeviceMid(): string | undefined {
  for (const path of zcodeTelemetryStateCandidates()) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      return typeof parsed?.deviceMid === "string" ? parsed.deviceMid : undefined;
    } catch {
      /* ignore malformed or unreadable telemetry state */
    }
  }
  return undefined;
}

function zcodeTelemetryStateCandidates(): string[] {
  const candidates: string[] = [];
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim();
  if (base) {
    candidates.push(join(base, ".zcode", "v2", "telemetry-state.json"));
    candidates.push(join(base, "v2", "telemetry-state.json"));
    candidates.push(join(base, "telemetry-state.json"));
  }
  candidates.push(join(homedir(), ".zcode", "v2", "telemetry-state.json"));
  return [...new Set(candidates)];
}

/** Resolve retry configuration with env-var overrides and defaults. */
function resolveRetry(raw?: unknown): RetryConfig {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};

  const maxRetries = resolveNonNegativeInt(
    process.env[ENV.RETRY_MAX] ?? r.maxRetries,
    DEFAULTS.RETRY_MAX_RETRIES,
  );
  const initialDelayMs = resolvePositiveInt(
    process.env[ENV.RETRY_INITIAL_DELAY_MS] ?? r.initialDelayMs,
    DEFAULTS.RETRY_INITIAL_DELAY_MS,
    MAX_TIMER_MS,
  );
  const maxDelayMs = resolvePositiveInt(
    process.env[ENV.RETRY_MAX_DELAY_MS] ?? r.maxDelayMs,
    DEFAULTS.RETRY_MAX_DELAY_MS,
    MAX_TIMER_MS,
  );
  const backoffFactor = resolvePositiveFloat(
    process.env[ENV.RETRY_BACKOFF_FACTOR] ?? r.backoffFactor,
    DEFAULTS.RETRY_BACKOFF_FACTOR,
  );

  // retryableStatuses: env var is comma-separated (e.g. "529,429,503"), YAML is array
  let retryableStatuses = [...DEFAULTS.RETRY_STATUSES];
  const envStatuses = process.env[ENV.RETRY_STATUSES];
  if (typeof envStatuses === "string" && envStatuses.trim().length > 0) {
    retryableStatuses = normalizeRetryableStatuses(
      envStatuses.split(","),
      DEFAULTS.RETRY_STATUSES,
    );
  } else if (Array.isArray(r.retryableStatuses) && r.retryableStatuses.length > 0) {
    retryableStatuses = normalizeRetryableStatuses(
      r.retryableStatuses,
      DEFAULTS.RETRY_STATUSES,
    );
  }

  const credentialSwitchThreshold = resolveNonNegativeInt(
    process.env[ENV.RETRY_CREDENTIAL_SWITCH_THRESHOLD] ?? r.credentialSwitchThreshold,
    DEFAULTS.RETRY_CREDENTIAL_SWITCH_THRESHOLD,
  );

  // emptyStreamSwitchThreshold (vceshi0.0.4+): number of consecutive
  // empty-stream 529s before forcing a credential switch. Defaults to 3.
  // Set to 0 to disable (fall back to the generic credentialSwitchThreshold).
  const emptyStreamSwitchThreshold = resolveNonNegativeInt(
    process.env[ENV.RETRY_EMPTY_STREAM_SWITCH_THRESHOLD] ?? r.emptyStreamSwitchThreshold,
    DEFAULTS.RETRY_EMPTY_STREAM_SWITCH_THRESHOLD,
  );

  return { maxRetries, initialDelayMs, maxDelayMs, backoffFactor, retryableStatuses, credentialSwitchThreshold, emptyStreamSwitchThreshold };
}

/** Resolve the configured model list while keeping the returned array isolated
 * from YAML parser internals and default constants. */
function resolveModels(raw: unknown, defaultModel: string): string[] {
  const source = Array.isArray(raw) ? raw : [defaultModel];
  const models = source
    .filter((m): m is string => typeof m === "string")
    .map(m => m.trim())
    .filter(Boolean);
  return models.length > 0 ? models : [defaultModel];
}

/** Resolve a non-negative integer from a raw value, falling back to default. */
function resolveNonNegativeInt(raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === null) return fallback;
  const n = parseStrictNumber(raw);
  return n !== null && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** Resolve a positive integer (> 0) from a raw value, falling back to default. */
function resolvePositiveInt(raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === null) return fallback;
  const n = parseStrictNumber(raw);
  return n !== null && Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Resolve a positive float from a raw value, falling back to default. */
function resolvePositiveFloat(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = parseStrictNumber(raw);
  return n !== null && n > 0 ? n : fallback;
}

function parseStrictNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function normalizeRetryableStatuses(raw: unknown[], fallback: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    const n = parseStrictNumber(value);
    if (n === null || !Number.isInteger(n) || n < 100 || n > 599) continue;
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
 * Resolve responses-thinking override from YAML.
 *
 * Accepts either:
 *   - `{ models: ["glm-5.2", ...] }`  (canonical shape)
 *   - `["glm-5.2", ...]`               (shorthand array of model ids)
 *
 * Model ids are trimmed but kept as-is (case preserved for display;
 * matching at request time is case-insensitive). Duplicates are dropped.
 * Always returns a non-undefined object so downstream code can do
 * `config.responsesThinking?.models` without null-checking.
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

/** Resolve client-identity (session inference) configuration. */
function resolveClientIdentity(raw: unknown): ClientIdentityConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = resolveClientIdentityMode(obj.mode);
  const ttlSeconds = resolvePositiveInt(obj.ttlSeconds, DEFAULTS.CLIENT_IDENTITY_TTL_SECONDS);
  const maxSessions = resolvePositiveInt(obj.maxSessions, DEFAULTS.CLIENT_IDENTITY_MAX_SESSIONS);
  return { mode, ttlSeconds, maxSessions };
}

function resolveClientIdentityMode(raw: unknown): ClientIdentityConfig["mode"] {
  if (raw === undefined || raw === null) return DEFAULTS.CLIENT_IDENTITY_MODE;
  if (raw === "off" || raw === "observe" || raw === "enforce") return raw;
  throw new Error(`Invalid clientIdentity.mode "${String(raw)}": must be "off", "observe", or "enforce"`);
}

/** Resolve endpoint-routing configuration. Fail-open feature — invalid
 * origins fall back to the default rather than rejecting the config. */
function resolveEndpointRouting(raw: unknown): EndpointRoutingConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.ENDPOINT_ROUTING];
  const enabled = enabledEnv !== undefined
    ? resolveBoolFlag(enabledEnv, DEFAULTS.ENDPOINT_ROUTING_ENABLED)
    : resolveBoolFlag(obj.enabled, DEFAULTS.ENDPOINT_ROUTING_ENABLED);
  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.ENDPOINT_ROUTING_ORIGIN).trim()
    || DEFAULTS.ENDPOINT_ROUTING_ORIGIN;
  return { enabled, origin };
}

/** Resolve client-signing configuration. */
function resolveClientSigning(raw: unknown): ClientSigningConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.CLIENT_SIGNING];
  const enabled = enabledEnv !== undefined
    ? resolveBoolFlag(enabledEnv, DEFAULTS.CLIENT_SIGNING_ENABLED)
    : resolveBoolFlag(obj.enabled, DEFAULTS.CLIENT_SIGNING_ENABLED);
  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.CLIENT_SIGNING_ORIGIN).trim()
    || DEFAULTS.CLIENT_SIGNING_ORIGIN;
  return { enabled, origin };
}

/**
 * Resolve the async (off-peak) bridge configuration (v0.3.1, upstream 175ff2a).
 * Numeric fields clamp defensively: non-finite / negative values fall back to
 * the default; maxWaitMs and maxRetries additionally accept 0 (unlimited / no
 * retry). Env override: ZCODE_ASYNC_ENABLED=1|true enables without YAML.
 */
function resolveAsyncConfig(raw: unknown): AsyncConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabledEnv = process.env[ENV.ASYNC_ENABLED];
  const enabled = enabledEnv !== undefined
    ? resolveBoolFlag(enabledEnv, DEFAULTS.ASYNC_ENABLED)
    : resolveBoolFlag(obj.enabled, DEFAULTS.ASYNC_ENABLED);
  const positiveInt = (v: unknown, fallback: number, allowZero = false): number => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n)) return fallback;
    if (n === 0 && allowZero) return 0;
    return n > 0 && Number.isInteger(n) ? Math.floor(n) : fallback;
  };
  return {
    enabled,
    origin: (typeof obj.origin === "string" ? obj.origin : DEFAULTS.ASYNC_ORIGIN).trim() || DEFAULTS.ASYNC_ORIGIN,
    pollIntervalMs: positiveInt(obj.pollIntervalMs, DEFAULTS.ASYNC_POLL_INTERVAL_MS),
    keepAliveIntervalMs: positiveInt(obj.keepAliveIntervalMs, DEFAULTS.ASYNC_KEEPALIVE_INTERVAL_MS),
    maxWaitMs: positiveInt(obj.maxWaitMs, DEFAULTS.ASYNC_MAX_WAIT_MS, true),
    maxRetries: positiveInt(obj.maxRetries, DEFAULTS.ASYNC_MAX_RETRIES, true),
    settleTimeoutMs: positiveInt(obj.settleTimeoutMs, DEFAULTS.ASYNC_SETTLE_TIMEOUT_MS),
    controlTimeoutMs: positiveInt(obj.controlTimeoutMs, DEFAULTS.ASYNC_CONTROL_TIMEOUT_MS),
    defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel.trim() : DEFAULTS.ASYNC_DEFAULT_MODEL,
  };
}

/** Resolve a boolean from YAML (true/false) or env ("1"/"true"/"0"/"false"). */
function resolveBoolFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  }
  return fallback;
}

/** Cross-field validation after all fields are resolved. */
function validate(config: ProxyConfig): void {
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`server.port ${config.server.port} is out of range (1-65535)`);
  }

  // v0.2.0.8 SECURITY: enforce a minimum length on proxyApiKey. A 1-character
  // key passes the existing "truthy" check but is brute-forceable in seconds.
  // 8 chars is the hard floor (blocks trivial keys like "x" or "test" while
  // keeping existing short-but-real deployments working); we recommend 32+ in
  // docs. Empty is allowed (loopback-only admin mode).
  if (config.auth.proxyApiKey !== undefined && config.auth.proxyApiKey !== null && config.auth.proxyApiKey !== "") {
    if (config.auth.proxyApiKey.length < 8) {
      throw new Error(
        `auth.proxyApiKey must be at least 8 characters (current: ${config.auth.proxyApiKey.length}). ` +
        `Use a strong random string (32+ chars recommended). Set ZCODE_PROXY_API_KEY to a longer value.`,
      );
    }
  }

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

/** Parse CORS allowlist from env (`a,b`) or YAML (`[a, b]`). */
function resolveCorsAllowList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return undefined;
    const list = raw.split(",").map(s => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("corsAllowList must be a comma-separated string or an array of strings");
  }
  const list = raw.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("corsAllowList must contain only strings");
    }
    return entry.trim();
  }).filter(Boolean);
  return list.length > 0 ? list : undefined;
}
