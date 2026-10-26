import type { RetryConfig } from "./types.js";

/** Shared by YAML loading, admin persistence and request-local fallbacks. */
export const RETRY_DEFAULTS: Readonly<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  backoffFactor: 2,
  retryableStatuses: [529, 429],
  credentialSwitchThreshold: 2,
  emptyStreamSwitchThreshold: 3,
  totalDeadlineMs: 300000,
};

/** Old and hand-built configs may omit individual fields. Never share arrays. */
export function withRetryDefaults(config?: Partial<RetryConfig>): RetryConfig {
  return {
    maxRetries: config?.maxRetries ?? RETRY_DEFAULTS.maxRetries,
    initialDelayMs: config?.initialDelayMs ?? RETRY_DEFAULTS.initialDelayMs,
    maxDelayMs: config?.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs,
    backoffFactor: config?.backoffFactor ?? RETRY_DEFAULTS.backoffFactor,
    retryableStatuses: [...(config?.retryableStatuses ?? RETRY_DEFAULTS.retryableStatuses)],
    credentialSwitchThreshold: config?.credentialSwitchThreshold ?? RETRY_DEFAULTS.credentialSwitchThreshold,
    emptyStreamSwitchThreshold: config?.emptyStreamSwitchThreshold ?? RETRY_DEFAULTS.emptyStreamSwitchThreshold,
    totalDeadlineMs: config?.totalDeadlineMs ?? RETRY_DEFAULTS.totalDeadlineMs,
  };
}
