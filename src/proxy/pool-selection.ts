import type { PoolProxy } from "./pool-types.js";
import { PROXY_POOL } from "../utils/constants.js";

/** Pool mutations replace the array; failure counters mutate the indexed entries. */
export class PoolProxyIndex {
  private proxies: readonly PoolProxy[] | undefined;
  private byUrl = new Map<string, PoolProxy>();

  sync(proxies: readonly PoolProxy[]): void {
    if (this.proxies !== proxies) {
      this.byUrl = new Map(proxies.map(proxy => [proxy.url, proxy]));
      this.proxies = proxies;
    }
  }

  get(proxies: readonly PoolProxy[], url: string): PoolProxy | undefined {
    this.sync(proxies);
    return this.byUrl.get(url);
  }

  clear(): void {
    this.proxies = undefined;
    this.byUrl.clear();
  }
}

export function isProxyCoolingDown(proxy: PoolProxy, now: number): boolean {
  return proxy.lastFailedAt !== undefined && now - proxy.lastFailedAt < PROXY_POOL.FAILURE_COOLDOWN_MS;
}

/**
 * One round-robin pass: prefer a healthy proxy, remembering the first cooling
 * candidate only as a fallback. Excluded proxies are never selected.
 */
export function selectPoolProxy(
  proxies: readonly PoolProxy[],
  cursor: number,
  excludeUrls?: ReadonlySet<string>,
  now = Date.now(),
): number | null {
  let fallback: number | null = null;
  for (let i = 0; i < proxies.length; i++) {
    const index = (cursor + i) % proxies.length;
    const candidate = proxies[index];
    if (excludeUrls?.has(candidate.url)) continue;
    if (!isProxyCoolingDown(candidate, now)) return index;
    fallback ??= index;
  }
  return fallback;
}
