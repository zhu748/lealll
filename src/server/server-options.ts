/**
 * `startServer` option assembly shared by every entry that boots the proxy
 * in-process (serve / android / tui).
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { ResponseStore } from "../responses/store.js";

/** Build `startServer` options, wiring the Responses store when its config gate is on. */
export function buildServerOptions(
  config: ProxyConfig,
  auth: AuthManager,
  debug: boolean,
  extra?: { configPath?: string },
): { config: ProxyConfig; auth: AuthManager; debug: boolean; responseStore?: ResponseStore; configPath?: string; startTime: number } {
  const opts: { config: ProxyConfig; auth: AuthManager; debug: boolean; responseStore?: ResponseStore; configPath?: string; startTime: number } = {
    config,
    auth,
    debug,
    // Fork multi-account layer: the admin dashboard needs the config path to
    // persist config edits and the process start time for its uptime card.
    startTime: Date.now(),
  };
  if (extra?.configPath) {
    opts.configPath = extra.configPath;
  }
  if (config.responses.enabled) {
    opts.responseStore = new ResponseStore({ maxEntries: config.responses.storeMaxEntries, ttlMs: config.responses.storeTtlMs });
  }
  return opts;
}
