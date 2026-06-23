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
  /** Provider-specific credential override. If absent, uses the global `auth.apiKey`. */
  credential?: string;
}

/** Auth section of the proxy configuration. */
export interface AuthConfig {
  /**
   * Key that clients must provide to use the proxy (via `Authorization: Bearer {proxyApiKey}`).
   * If unset, the proxy does not require client auth.
   */
  proxyApiKey?: string;
  /** How the proxy obtains the upstream credential. */
  mode: "apikey" | "oauth";
  /** Direct credential for `apikey` mode. Format: `{apiKey}` or `{apiKey}.{secret}` (Z.AI). */
  apiKey?: string;
  /** Path to stored OAuth credentials (for `oauth` mode). */
  oauthCredentialsPath?: string;
}

/**
 * Identity headers injected on every upstream request to mimic the ZCode
 * desktop client. Mirrors the `eYn` builder in the reverse-engineered bundle
 * (`_reverse/zcode.cjs`); see `_reverse/NOTEPAD.md` "How Credential is Used".
 *
 * Resolution: env var (matches ZCode's own convention) → YAML override → default.
 * `appVersion` must be printable ASCII (`/^[\x20-\x7e]+$/`); non-conforming
 * values are silently dropped and fall back to the default (current ZCode
 * release), exactly like `rYn` in the bundle.
 */
export interface ProxyIdentity {
  appVersion: string;
  sourceTitle: string;
  refererOrigin: string;
}

/** Retry configuration for upstream requests. */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts for retryable status codes.
   * Set to 0 to disable retries entirely.
   * Default: 3
   */
  maxRetries: number;
  /**
   * Initial delay in milliseconds before the first retry.
   * Subsequent retries use exponential backoff: delay * backoffFactor^attempt.
   * Default: 1000
   */
  initialDelayMs: number;
  /**
   * Maximum delay cap in milliseconds. Even with exponential backoff,
   * the delay will never exceed this value.
   * Default: 8000
   */
  maxDelayMs: number;
  /**
   * Multiplier applied to the delay for each subsequent retry attempt.
   * A value of 2 means each retry waits twice as long as the previous.
   * Default: 2
   */
  backoffFactor: number;
  /**
   * HTTP status codes that should trigger a retry.
   * Common values: 429 (rate limited), 529 (site overloaded), 503 (service unavailable).
   * Default: [529]
   */
  retryableStatuses: number[];
  /**
   * Number of consecutive failed attempts (including the initial request) with
   * the same credential before automatically switching to another stored
   * credential. Set to 0 to disable credential switching entirely.
   *
   * When the threshold is reached mid-retry-loop, the proxy picks a different
   * stored credential (if any), rebuilds the request with the new credential's
   * auth headers + userId, and continues retrying. Already-tried credentials
   * are skipped in the same request to avoid cycling back to a known-bad one.
   *
   * Only effective when more than one credential is stored (multi-account mode)
   * and `retry.maxRetries` is greater than or equal to this threshold.
   * Default: 5
   */
  credentialSwitchThreshold: number;
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
 * before forwarding upstream. Used to make non-GLM model names (e.g. Codex CLI's
 * `gpt-5.5`) map to a real GLM model.
 *
 * Matching is case-insensitive exact match on `from`. The `to` value is used
 * verbatim — no validation against the model catalog (allows future GLM models
 * without code changes).
 */
export interface ModelMapping {
  /** Client-sent model id to rewrite (case-insensitive exact match). */
  from: string;
  /** Target model id to forward upstream. */
  to: string;
  /** Optional note for the operator. */
  note?: string;
}

/** Top-level proxy configuration. */
export interface ProxyConfig {
  server: {
    port: number;
    host: string;
  };
  auth: AuthConfig;
  /** Active upstream provider. */
  provider: "zai" | "bigmodel";
  /** Which plan tier to use. "coding-plan" (default) uses direct upstream endpoints; "start-plan" routes through zcode.z.ai with JWT auth. */
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
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  /**
   * Retry configuration for upstream requests.
   * When absent, defaults are applied (3 retries, exponential backoff, 529 only).
   */
  retry: RetryConfig;
  /** Custom per-model routing rules. Empty by default. */
  routingRules?: RoutingRule[];
  /** Client model id → GLM model id rewrite table. Empty by default. */
  modelMappings?: ModelMapping[];
}
