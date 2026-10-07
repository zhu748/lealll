/** A single proxy entry in the pool. */
export interface PoolProxy {
  /** Stable unique id (sha-ish 12-char hex of the normalized URL). */
  id: string;
  /** Normalized URL (always with scheme). */
  url: string;
  /** Source: "manual" | "url:<n>" where n is the source URL index. */
  source: string;
  /** When this entry was added (Unix ms). */
  addedAt: number;
  /** Optional human-readable label (e.g. the original line for non-URL form). */
  note?: string;
  /**
   * Consecutive failure counter (incremented on rotation due to gateway
   * block). Used to deprioritize bad proxies without removing them.
   */
  failures?: number;
  /** Last time this proxy was used (Unix ms). */
  lastUsedAt?: number;
  /**
   * v0.2.2+: Timestamp of the last markProxyFailed call. Used by pickProxy
   * to skip recently-failed proxies (FAILURE_COOLDOWN_MS). Not set on
   * freshly-imported proxies — they're eligible immediately.
   */
  lastFailedAt?: number;
}

/** Pool configuration. */
export interface ProxyPoolConfig {
  /** Master switch. When false, the pool is not consulted at all. */
  enabled: boolean;
  /** Auto-refresh interval in minutes. 0 = disabled. Default 5. */
  refreshIntervalMin: number;
  /** URL sources for auto-refresh. Empty = no URL sources. */
  sourceUrls: string[];
  /**
   * Whether to rotate proxies on 405 / WAF gateway block errors. When true
   * (default), the handler will pick a different proxy and retry the request.
   */
  rotateOnGatewayBlock: boolean;
  /**
   * Maximum retries via different proxies on a gateway block before giving
   * up. Default 3. Set to 0 to disable proxy rotation entirely (the pool
   * is still consulted for the INITIAL proxy choice).
   */
  maxRotations: number;
}

/** Result of a refresh operation. */
export interface RefreshResult {
  /** Number of new proxies added in this refresh. */
  added: number;
  /** Number of proxies removed (no longer in any source). */
  removed: number;
  /** Total proxies in the pool after refresh. */
  total: number;
  /** When the refresh happened (Unix ms). */
  at: number;
  /** Per-source errors (if any), keyed by source URL. */
  errors?: Record<string, string>;
}

/** On-disk file format. */
export interface PoolFile {
  version: 1;
  config: ProxyPoolConfig;
  proxies: PoolProxy[];
  lastRefreshAt?: number;
  lastRefreshResult?: RefreshResult;
}
