/** Validate persisted pool data and configuration patches without disk I/O. */
import { parseStrictNonNegativeInteger } from "../utils/numbers.js";
import { truncateProxyPoolError } from "./pool-source.js";
import { proxyIdForUrl, normalizeProxyLine, proxyValidationError, validateProxySourceUrl } from "./pool-format.js";
import type { PoolProxy, ProxyPoolConfig, RefreshResult, PoolFile } from "./pool-types.js";

export const DEFAULT_CONFIG: ProxyPoolConfig = {
  enabled: false,
  refreshIntervalMin: 5,
  sourceUrls: [],
  rotateOnGatewayBlock: true,
  maxRotations: 3,
};
const MAX_REFRESH_INTERVAL_MIN = Math.floor(2_147_483_647 / 60_000);
const MAX_PROXY_ROTATIONS = 20;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeNonNegativeInt(raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = parseStrictNonNegativeInteger(raw);
  if (n === undefined) return fallback;
  return Math.min(n, max);
}

function normalizeOptionalNonNegativeInt(raw: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const n = normalizeNonNegativeInt(raw, -1, max);
  return n >= 0 ? n : undefined;
}

function normalizeSourceUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const validation = validateProxySourceUrl(value);
    if (!validation.ok || seen.has(validation.url)) continue;
    seen.add(validation.url);
    out.push(validation.url);
  }
  return out;
}

export function cloneProxyPoolConfig(config: ProxyPoolConfig): ProxyPoolConfig {
  return {
    ...config,
    sourceUrls: normalizeSourceUrls(config.sourceUrls),
  };
}

export function normalizeProxyPoolConfig(config?: Partial<ProxyPoolConfig> | null): ProxyPoolConfig {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config ?? {}),
  };
  return {
    enabled: normalizeBoolean(merged.enabled, DEFAULT_CONFIG.enabled),
    refreshIntervalMin: normalizeNonNegativeInt(
      merged.refreshIntervalMin,
      DEFAULT_CONFIG.refreshIntervalMin,
      MAX_REFRESH_INTERVAL_MIN,
    ),
    sourceUrls: normalizeSourceUrls(merged.sourceUrls),
    rotateOnGatewayBlock: normalizeBoolean(
      merged.rotateOnGatewayBlock,
      DEFAULT_CONFIG.rotateOnGatewayBlock,
    ),
    maxRotations: normalizeNonNegativeInt(
      merged.maxRotations,
      DEFAULT_CONFIG.maxRotations,
      MAX_PROXY_ROTATIONS,
    ),
  };
}

export function cloneRefreshResult(result?: RefreshResult): RefreshResult | undefined {
  if (!result) return undefined;
  return {
    ...result,
    errors: result.errors ? { ...result.errors } : undefined,
  };
}

function normalizeRefreshErrors(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const sourceUrl = typeof key === "string" ? key.trim() : "";
    if (!sourceUrl || typeof value !== "string") continue;
    try {
      new URL(sourceUrl);
    } catch {
      continue;
    }
    out[sourceUrl] = truncateProxyPoolError(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRefreshResult(raw: unknown, fallbackAt?: number): RefreshResult | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const at = normalizeOptionalNonNegativeInt(r.at) ?? fallbackAt;
  if (at === undefined) return undefined;
  return {
    added: normalizeOptionalNonNegativeInt(r.added) ?? 0,
    removed: normalizeOptionalNonNegativeInt(r.removed) ?? 0,
    total: normalizeOptionalNonNegativeInt(r.total) ?? 0,
    at,
    errors: normalizeRefreshErrors(r.errors),
  };
}

function normalizeProxySource(raw: unknown): string {
  if (typeof raw !== "string") return "manual";
  const source = raw.trim();
  if (source === "manual") return source;
  if (!source.startsWith("url:")) return "manual";
  const sourceUrl = source.slice(4).trim();
  if (!sourceUrl) return "manual";
  try {
    new URL(sourceUrl);
    return `url:${sourceUrl}`;
  } catch {
    return "manual";
  }
}

function normalizePoolProxies(raw: unknown): PoolProxy[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolProxy[] = [];
  const seenUrls = new Set<string>();
  const now = Date.now();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    if (typeof p.url !== "string") continue;
    const url = normalizeProxyLine(p.url);
    if (!url || proxyValidationError(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const addedAt = normalizeOptionalNonNegativeInt(p.addedAt) ?? now;
    const proxy: PoolProxy = {
      id: proxyIdForUrl(url),
      url,
      source: normalizeProxySource(p.source),
      addedAt,
    };
    if (typeof p.note === "string" && p.note.trim()) proxy.note = p.note.trim().slice(0, 500);
    const failures = normalizeOptionalNonNegativeInt(p.failures);
    if (failures !== undefined) proxy.failures = failures;
    const lastUsedAt = normalizeOptionalNonNegativeInt(p.lastUsedAt);
    if (lastUsedAt !== undefined) proxy.lastUsedAt = lastUsedAt;
    const lastFailedAt = normalizeOptionalNonNegativeInt(p.lastFailedAt);
    if (lastFailedAt !== undefined) proxy.lastFailedAt = lastFailedAt;
    out.push(proxy);
  }
  return out;
}

/** Normalize only supplied patch fields; invalid values keep the current value. */
export function patchProxyPoolConfig(config: ProxyPoolConfig, patch: Partial<ProxyPoolConfig>): ProxyPoolConfig {
  const current = normalizeProxyPoolConfig(config);
  const patchRecord = patch as Record<string, unknown>;
  const newConfig: ProxyPoolConfig = {
    enabled: hasOwn(patchRecord, "enabled")
      ? normalizeBoolean(patchRecord.enabled, current.enabled)
      : current.enabled,
    refreshIntervalMin: hasOwn(patchRecord, "refreshIntervalMin")
      ? normalizeNonNegativeInt(
        patchRecord.refreshIntervalMin,
        current.refreshIntervalMin,
        MAX_REFRESH_INTERVAL_MIN,
      )
      : current.refreshIntervalMin,
    sourceUrls: hasOwn(patchRecord, "sourceUrls") && Array.isArray(patchRecord.sourceUrls)
      ? normalizeSourceUrls(patchRecord.sourceUrls)
      : normalizeSourceUrls(current.sourceUrls),
    rotateOnGatewayBlock: hasOwn(patchRecord, "rotateOnGatewayBlock")
      ? normalizeBoolean(patchRecord.rotateOnGatewayBlock, current.rotateOnGatewayBlock)
      : current.rotateOnGatewayBlock,
    maxRotations: hasOwn(patchRecord, "maxRotations")
      ? normalizeNonNegativeInt(patchRecord.maxRotations, current.maxRotations, MAX_PROXY_ROTATIONS)
      : current.maxRotations,
  };
  return newConfig;
}

/** Normalize an on-disk envelope. Unknown versions retain the existing empty-pool fallback. */
export function normalizePoolFile(raw: unknown): PoolFile {
  const parsed = raw as PoolFile | null;
  if (!parsed || parsed.version !== 1) {
    // Unknown version — treat as empty rather than risk clobbering.
    return { version: 1, config: cloneProxyPoolConfig(DEFAULT_CONFIG), proxies: [] };
  }
  const lastRefreshAt = normalizeOptionalNonNegativeInt(parsed.lastRefreshAt);
  return {
    version: 1,
    config: normalizeProxyPoolConfig(parsed.config),
    proxies: normalizePoolProxies(parsed.proxies),
    lastRefreshAt,
    lastRefreshResult: normalizeRefreshResult(parsed.lastRefreshResult, lastRefreshAt),
  };
}
