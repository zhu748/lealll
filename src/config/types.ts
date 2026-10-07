/**
 * Configuration types for zcode-proxy.
 * @see .omo/plans/zcode-proxy.md Task 2
 */

/** Provider endpoint configuration (one per upstream provider). */
export interface ProviderEndpoints {
  /** Base URL for Anthropic-format API, e.g. "https://api.z.ai/api/anthropic". */
  anthropicBase: string;
  /** Base URL for OpenAI-format API, e.g. "https://api.z.ai/api/coding/paas/v4". */
  openaiBase: string;
  /** Provider-specific credential override (fork admin dashboard). If absent, uses the stored multi-account credential. */
  credential?: string;
}

/** How the proxy obtains the upstream credential (fork multi-account layer). */
export type AuthMode = "apikey" | "oauth";

/** Plan tier the credential is associated with. */
export type PlanId = "coding-plan" | "start-plan";

/** Auth section of the proxy configuration. */
interface AuthConfig {
  /**
   * Key that clients must provide to use the proxy (via `Authorization: Bearer {proxyApiKey}`).
   * If unset, the proxy does not require client auth.
   */
  proxyApiKey?: string;
  /**
   * How the proxy obtains the upstream credential (fork multi-account layer).
   * Default "oauth": the credential comes from the encrypted multi-account
   * store (`auth login` / dashboard / import). "apikey" uses the static
   * `auth.apiKey` string instead. Only the dashboard hot-applies changes to
   * this field at runtime; the CLI always prefers the store when non-empty.
   */
  mode?: AuthMode;
  /** Direct credential for `apikey` mode. Format: `{apiKey}` or `{apiKey}.{secret}` (Z.AI). */
  apiKey?: string;
  /** Path to stored OAuth credentials created by `auth login`. */
  oauthCredentialsPath?: string;
}

/** Retry configuration for upstream requests (fork resilience layer). */
export interface RetryConfig {
  /** Maximum number of retry attempts for retryable status codes. Default: 3. */
  maxRetries: number;
  /** Initial delay in milliseconds before the first retry. Default: 1000. */
  initialDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 8000. */
  maxDelayMs: number;
  /** Multiplier applied to the delay for each subsequent retry attempt. Default: 2. */
  backoffFactor: number;
  /** HTTP status codes that should trigger a retry. Default: [529, 429]. */
  retryableStatuses: number[];
  /**
   * Number of consecutive failed attempts (including the initial request) with
   * the same credential before automatically switching to another stored
   * credential. Set to 0 to disable credential switching entirely. Default: 2.
   *
   * Environment variable: ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD
   */
  credentialSwitchThreshold: number;
  /**
   * Number of consecutive empty-stream 529 responses (HTTP 200 + zero SSE
   * events — the typical "quota exhausted" signature) with the same credential
   * before automatically switching to another stored credential. Set to 0 to
   * disable. Default: 3.
   *
   * Environment variable: ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD
   */
  emptyStreamSwitchThreshold: number;
  /**
   * Total wall-clock budget (ms) for the ENTIRE retry loop of one request.
   * When exceeded the loop stops and the client receives a 503.
   * Set to 0 to disable. Default: 300000 (5 minutes).
   *
   * Environment variable: ZCODE_RETRY_TOTAL_DEADLINE_MS
   */
  totalDeadlineMs: number;
}

/** Custom routing rule — overrides the default provider/endpoint for requests
 * whose model name matches `pattern` (shell-glob style, e.g. "glm-5*").
 */
export interface RoutingRule {
  /** Glob-style model pattern (matched against request body's `model` field). */
  pattern: string;
  /** Override provider for matched models. */
  provider: "zai" | "bigmodel";
  /** Optional endpoint override (full URL). If empty, the provider's default endpoint is used. */
  endpoint?: string;
  /** Optional note for the operator. */
  note?: string;
}

/**
 * Model mapping — rewrites the client-sent `model` field to a different id
 * before forwarding upstream (e.g. Codex CLI's `gpt-5.5` → a real GLM model).
 */
export interface ModelMapping {
  /** Client-sent model id to rewrite (case-insensitive exact match). */
  from: string;
  /** Target model id to forward upstream. */
  to: string;
  /** Optional note for the operator. */
  note?: string;
}

/**
 * Responses-API thinking override — force-enable thinking on `/v1/responses`
 * for specific models (matched against the post-mapping GLM model id).
 */
export interface ResponsesThinkingConfig {
  /** Model ids (post-mapping) for which thinking is force-enabled on /v1/responses. */
  models: string[];
}

/**
 * Identity headers injected on every upstream request to mimic the ZCode
 * desktop client. Mirrors the `pio` builder in the reverse-engineered bundle
 * (`_reverse/zcode.cjs`); see `_reverse/NOTEPAD.md` "How Credential is Used".
 *
 * Resolution: env var (matches ZCode's own convention) → YAML override → default.
 * `appVersion` must be printable ASCII (`/^[\x20-\x7e]+$/`); non-conforming
 * values are silently dropped and fall back to the default (current ZCode
 * release), exactly like `fio` in the bundle.
 */
export interface ProxyIdentity {
  appVersion: string;
  sourceTitle: string;
  refererOrigin: string;
  /**
   * Device identity for `X-Device-Mid` (mirrors ZCode's telemetry deviceMid:
   * a random UUIDv4 generated ONCE and reused forever — no hardware values).
   * Empty/undefined omits the header. Desktop: persisted in config.yaml
   * (`ensureDeviceMidInConfig`). Android: injected via the
   * `ZCODE_IDENTITY_DEVICE_MID` env var (NodeRunner, app-private file) — env
   * wins over YAML. Must stay stable per anti-pattern #13; never randomize
   * per-request.
   */
  deviceMid?: string;
  /**
   * ZCode release channel — emitted as the `X-Release-Channel` header (fork
   * dashboard identity panel). When unset / empty, the header is omitted.
   */
  releaseChannel?: string;
  /**
   * ZCode agent marker sent on upstream model requests as `X-ZCode-Agent`
   * (fork dashboard identity panel). Empty omits the header.
   */
  zcodeAgent?: string;
}

/** Local client-session inference mode for upstream session affinity. */
export interface ClientIdentityConfig {
  /** "observe" logs/instruments only; "enforce" reuses upstream x-session-id; "off" disables inference. */
  mode: "off" | "observe" | "enforce";
  /** In-memory session TTL in seconds. */
  ttlSeconds: number;
  /** Maximum number of inferred sessions retained in memory. */
  maxSessions: number;
}

/**
 * Responses-API (`/v1/responses`) configuration. When `enabled`, the proxy
 * translates Codex-style Responses requests to the GLM Chat Completions upstream.
 */
export interface ResponsesConfig {
  /** Enable the `/v1/responses` route. Default `true`. */
  enabled: boolean;
  /** Max stored responses (LRU). Default 1000. */
  storeMaxEntries: number;
  /** Stored-response TTL in ms. Default 24h (in-memory; cleared on restart). */
  storeTtlMs: number;
}

/**
 * Official plugin-MCP gateway relay (`/mcp/*` routes) — mirrors the ZCode
 * desktop's `zcode_official` MCP plane: each catalogue server is proxied to
 * `{upstreamOrigin}/api/v1/mcp/server/{routeId}` with the stored OAuth
 * credential injected as official auth headers.
 *
 * The server table is a build-time artifact (`src/mcp/official-catalogue.json`,
 * regenerated by `scripts/regen-mcp-catalogue.ts`) — the runtime never fetches
 * the marketplace.
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP" (host bundle `tw`/`nw`/`lme`,
 * 3.14.3) for the header contract.
 */
export interface McpGatewayConfig {
  /** Expose `GET /mcp` and `/mcp/{server}` relay routes. Default `true`. */
  enabled: boolean;
  /** Base origin substituted for `${ZCODE_BASE_URL}` in plugin `.mcp.json`
   *  URLs. Default `https://zcode.z.ai` (desktop bundle production fallback
   *  `jee`; `sYe` = chatglm.site is the test-env origin). */
  upstreamOrigin: string;
}

/** GLM MCP hosted-tool configuration. Endpoints are derived from the active provider. */
export interface McpConfig {
  /** Enable MCP interception (web_search) and function-tool injection (web_reader/zread). Default `true`. */
  enabled: boolean;
  /** Intercept `web_search` / `web_search_preview` hosted tools via GLM `web_search_prime` MCP. Default `true`. */
  webSearch: boolean;
  /** Inject `webReader` as a function tool the model can call. Default `false` (off by default to limit scope). */
  webReader: boolean;
  /** Inject the three `zread` tools as function tools. Default `false`. */
  zread: boolean;
  /**
   * MCP gateway usage quota (3.14.4 supplemental, v4.7.5-fork.1).
   * When `true`, `GET /quota` fetches `/api/v1/mcp/usage` on the zcode plane
   * and returns it in the `mcpUsage` field. Default `true`. Fail-open: any
   * error → null (matches the desktop's usage:null tolerance).
   * Env: `ZCODE_MCP_USAGE_ENABLED=false`.
   */
  usageEnabled?: boolean;
  /** Official plugin-MCP gateway relay (`/mcp/*`). Separate plane from the
   *  GLM hosted-tool fields above (those remain unwired). */
  gateway: McpGatewayConfig;
}

/**
 * Remote provider-config delivery (3.14.4 supplemental, v4.7.5-fork.1).
 * Mirrors the desktop `xnr` function: fetch `/api/v1/client/configs?app_version=X&platform=Y`
 * to discover a CDN URL pointing to the latest `zcode-builtin.json`. The proxy
 * merges the remote model list with the local `models:` field (remote wins);
 * failures silently fall back to local-only.
 */
export interface ClientConfigConfig {
  /** Refresh the remote model list on startup. Default `true`. */
  refreshOnStart: boolean;
  /** Base origin of the client-configs endpoint. Default `"https://zcode.z.ai"`. */
  origin: string;
  /** Request timeout in ms (desktop uses 20s in `xnr`). Default `20000`. */
  timeoutMs: number;
}

/**
 * Coding-plan subscription availability (3.14.4 supplemental, v4.7.5-fork.1).
 * Mirrors the desktop `validateCodingPlanProviderAvailability` function:
 * probe `/api/biz/subscription/list` to check whether the active credential
 * has a usable coding-plan subscription. Used by the multi-account
 * credential rotation loop to skip expired subscriptions without burning
 * a credential-switch threshold on a 401.
 */
export interface SubscriptionConfig {
  /** Probe subscription availability on credential switch. Default `true`. */
  checkOnSwitch: boolean;
  /** Base origin of the biz-plane subscription endpoint. Default `"https://api.z.ai"`. */
  origin: string;
  /** Request timeout in ms. Default `15000`. */
  timeoutMs: number;
}

/**
 * Async (off-peak / idle-plan) bridge configuration. When `enabled`, exposes
 * `/async/v1/messages` and `/async/v1/chat/completions` that route to ZCode's
 * off-peak ticket-queue backend. The proxy keeps the client connection alive
 * with SSE comments during ticket-queue wait, forwards the LLM stream once
 * the ticket is `ready`, and auto-retries on ticket-expired (up to `maxRetries`).
 *
 * Requires a logged-in oauth credential (off-peak needs both
 * `Authorization: Bearer ${jwt}` and `X-Coding-Plan-Api-Key` headers). A
 * credential lacking the JWT makes the route entry return 400
 * `async_credentials_unavailable`.
 *
 * @see _reverse/NOTEPAD.md "Off-Peak / Idle Plan" section for full upstream protocol.
 */
export interface AsyncConfig {
  /** Enable the `/async/*` routes. Default `false`. */
  enabled: boolean;
  /** Base origin for off-peak endpoints. Default `"https://zcode.z.ai"`. */
  origin: string;
  /** Ticket-status poll interval in ms. Default `5000`. */
  pollIntervalMs: number;
  /** SSE keepalive comment interval during ticket-queue wait, in ms. Default `3000`. */
  keepAliveIntervalMs: number;
  /** Maximum total wait time for a ticket to become `ready`, in ms. `0` = unlimited. Default `0`. */
  maxWaitMs: number;
  /** Maximum auto-retry count on `off-peak-ticket-expired`. Default `3`. */
  maxRetries: number;
  /** Settle call timeout in ms (best-effort close-out on completion/abort). Default `8000`. */
  settleTimeoutMs: number;
  /** Control-plane call (takeTicket/pollStatus) timeout in ms. Default `15000`. */
  controlTimeoutMs: number;
  /** Optional model override; empty string uses the request's `model`. Default `""`. */
  defaultModel: string;
}

/**
 * Manual claim ("weekend plan") — mirrors the ZCode 3.10 desktop client's
 * `manualClaimPlan` feature: periodically list claimable trial plans
 * (`GET {origin}/api/v1/zcode-plan/billing/preview`) and, when one is
 * available, claim it (`POST {origin}/api/v1/zcode-plan/billing/claim`) with
 * the OAuth JWT and an Aliyun captcha token. Claimed plans grant Start-Plan
 * style quota with delayed activation (`effective_at` / `starts_at`).
 *
 * Requires `auth.mode: oauth` (claim uses `Authorization: Bearer ${jwt}`).
 *
 * @see _reverse/NOTEPAD.md "Manual Claim Plan" section for the protocol.
 */
export interface ClaimConfig {
  /** Enable the claim subsystem (CLI `claim` command + auto scheduler). Default `true`. */
  enabled: boolean;
  /** Auto-claim in the background while the proxy is serving. Default `true` (effective when `enabled`). */
  auto: boolean;
  /** Base origin of the zcode-plan billing endpoints. Default `"https://zcode.z.ai"`. */
  origin: string;
  /** Preview poll interval in ms. Default `300000` (5 min). */
  pollIntervalMs: number;
  /** Backoff after a failed claim attempt in ms. Default `600000` (10 min). */
  cooldownMs: number;
  /** Optional `plan_id` to claim; empty string claims the highest-priority preview. Default `""`. */
  planId: string;
}

/**
 * Provider endpoint routing — mirrors the ZCode client's
 * `ProviderEndpointRoutingService`: periodically fetch
 * `GET {configUrl}/api/v1/agent/configs` and rewrite matching upstream URLs
 * per the server-controlled `data.proxyEndpoint.mapping` table. As of
 * 2026-08-19 only the coding-plan Anthropic endpoints are mapped (to
 * `zcode.z.ai/api/v1/ultra[-zai]/...`); resolution is generic so future
 * entries apply automatically. Always fail-open.
 */
export interface EndpointRoutingConfig {
  /** Enable URL remapping. Default `true`. */
  enabled: boolean;
  /** Base origin of the agent-configs endpoint. Default `"https://zcode.z.ai"`. */
  origin: string;
}

/**
 * Client request signing V4 — mirrors the ZCode 3.9.1
 * `ClientRequestSigningV4Signer`. When enabled, the proxy probes the same
 * feature gate the client uses (`GET {origin}/api/v1/agent/configs` →
 * `data.codingPlanSignature.enable`) and, only if the server turns the feature
 * on, signs coding-plan upstream requests (handshake + Ed25519 + proof-of-work,
 * with the client's fail-open retry ladder). Start-plan and off-peak paths are
 * permanently exempt.
 */
export interface ClientSigningConfig {
  /** Enable gate probing + signing. Default `true`. */
  enabled: boolean;
  /** Base origin of the feature-gate endpoint. Default `"https://zcode.z.ai"`. */
  origin: string;
}

/** Top-level proxy configuration. */
export interface ProxyConfig {
  server: {
    port: number;
    host: string;
    /**
     * Upstream request timeout in milliseconds (fork). Leave unset or 0 for
     * the built-in defaults (stream 10 min, batch 5 min).
     */
    upstreamTimeoutMs?: number;
    /**
     * Whether to trust X-Forwarded-For / X-Real-IP headers for client IP
     * detection (fork admin security). Enable ONLY behind a trusted reverse
     * proxy. Default: false.
     */
    trustProxy?: boolean;
    /**
     * SSE heartbeat interval in milliseconds (fork): no-op SSE comment lines
     * flushed to the client while waiting for the upstream's first byte, so
     * reverse proxies with idle timeouts (e.g. Cloudflare 100s) don't kill
     * long thinking requests. Default: 15000. Set 0 to disable.
     */
    sseHeartbeatMs?: number;
    /**
     * Maximum client request body size in bytes for proxy endpoints (fork).
     * Default: 64 MiB. Set 0 to disable the guard.
     */
    maxRequestBodyBytes?: number;
  };
  auth: AuthConfig;
  /** Active upstream provider. */
  provider: "zai" | "bigmodel";
  /** Which plan tier to use. "start-plan" (default) routes through zcode.z.ai with JWT auth; "coding-plan" uses direct upstream endpoints with a permanent API key. */
  plan: "coding-plan" | "start-plan";
  /** Per-provider endpoint overrides. */
  providers: {
    zai: ProviderEndpoints;
    bigmodel: ProviderEndpoints;
  };
  /** Default model id used when client request omits `model`. */
  defaultModel: string;
  /** Whitelist of allowed model ids. */
  models: string[];
  /**
   * Identity headers injected upstream. Always present after `loadConfig`;
   * defaults mirror the production ZCode desktop client.
   */
  identity: ProxyIdentity;
  /** Local client session inference for cache-affinity experiments. */
  clientIdentity: ClientIdentityConfig;
  /** Responses-API (`/v1/responses`) configuration. */
  responses: ResponsesConfig;
  /** Server-controlled upstream URL remapping (ultra endpoints). */
  endpointRouting: EndpointRoutingConfig;
  /** Client request signing V4 (Ed25519 + PoW, gate-driven). */
  clientSigning: ClientSigningConfig;
  /** GLM MCP hosted-tool configuration. */
  mcp: McpConfig;
  /**
   * Remote provider-config delivery (3.14.4 supplemental, v4.7.5-fork.1).
   * When present, the proxy may fetch a remote `zcode-builtin.json` to
   * refresh `models` at runtime; absent field falls back to local-only.
   */
  clientConfig?: ClientConfigConfig;
  /**
   * Coding-plan subscription availability (3.14.4 supplemental, v4.7.5-fork.1).
   * When present, the proxy probes `/api/biz/subscription/list` on credential
   * switch; absent field falls back to no-availability-check.
   */
  subscription?: SubscriptionConfig;
  /** Async (off-peak / idle-plan) bridge configuration. */
  async: AsyncConfig;
  /** Manual claim ("weekend plan") configuration. */
  claim: ClaimConfig;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    /**
     * Verbose logging (fork): each request logs the full upstream request
     * headers (masked) + transformed body preview. Toggleable via dashboard.
     * Env: ZCODE_PROXY_VERBOSE_LOGGING=1
     */
    verbose?: boolean;
    /**
     * Debug response logging (fork): logs full upstream response details
     * (status, key headers, body/SSE preview). Env: ZCODE_PROXY_DEBUG_LOGGING=1
     */
    debug?: boolean;
    /**
     * Optional JSON-lines log file (fork) mirrored from the dashboard log
     * ring buffer. Env: ZCODE_PROXY_LOG_FILE
     */
    file?: string;
    /**
     * Header debug logging (fork): writes paired inbound/upstream header
     * JSON files per request for translation-pipeline diffing.
     * Env: ZCODE_PROXY_HEADER_DEBUG=1
     */
    headerDebug?: boolean;
  };
  /**
   * Retry / credential-switch resilience configuration (fork multi-account layer).
   * Optional for backward compatibility with hand-built test configs; the
   * proxy handler falls back to the loader defaults field-by-field.
   */
  retry?: RetryConfig;
  /**
   * CORS origin allowlist (fork). When set, only origins in this list receive
   * `Access-Control-Allow-Origin` headers. Env: ZCODE_PROXY_CORS_ALLOWLIST.
   */
  corsAllowList?: string[];
  /** Custom per-model routing rules (fork dashboard). Empty by default. */
  routingRules?: RoutingRule[];
  /** Client model id → GLM model id rewrite table (fork dashboard). Empty by default. */
  modelMappings?: ModelMapping[];
  /** Force-enable thinking on /v1/responses for specific models (fork dashboard). */
  responsesThinking?: ResponsesThinkingConfig;
  /**
   * ZCode thinking level (fork dashboard) — controls budget_tokens + effort
   * injected when the client sends `thinking.type=enabled`. Default "max".
   */
  thinkingLevel?: "low" | "high" | "max";
}
