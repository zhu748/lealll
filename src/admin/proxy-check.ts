import { wrapFetchWithSocksBridge } from "../proxy/proxied-fetch.js";
import { hostClearTimeout, hostSetTimeout } from "../utils/host-timers.js";
import { truncateAdminErrorMessage } from "./http-utils.js";
import type { AdminOptions } from "./types.js";

/** Probe the provider's origin without sending credentials or API payloads. */
export function proxyTestTarget(config: AdminOptions["config"], provider?: string): string {
  const id = provider === "bigmodel" ? "bigmodel" : "zai";
  const providerConfig = config.providers[id];
  try {
    const url = new URL(providerConfig.anthropicBase);
    return `${url.protocol}//${url.host}`;
  } catch {
    return id === "bigmodel" ? "https://open.bigmodel.cn" : "https://api.z.ai";
  }
}

type ProxyCheckResult = {
  latencyMs: number;
  target: string;
} & ({ ok: true; status: number } | { ok: false; error: string });

/** Any HTTP response counts as reachable; always release its response body. */
export async function checkProxyConnectivity(
  proxyUrl: string,
  provider: string | undefined,
  opts: AdminOptions,
): Promise<ProxyCheckResult> {
  const target = proxyTestTarget(opts.config, provider);
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = hostSetTimeout(() => ctrl.abort(), 10_000);
  timer.unref?.();
  const fetchImpl = wrapFetchWithSocksBridge(opts.fetchImpl ?? fetch);
  try {
    const response = await fetchImpl(target, {
      method: "HEAD",
      signal: ctrl.signal,
      redirect: "follow",
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
    const latencyMs = Date.now() - started;
    try { await response.body?.cancel(); } catch {}
    return { ok: true, status: response.status, latencyMs, target };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = (err as Error).message || String(err);
    const timedOut = ctrl.signal.aborted || /abort/i.test(message);
    return {
      ok: false,
      error: timedOut ? "Connection timed out after 10s" : truncateAdminErrorMessage(message),
      latencyMs,
      target,
    };
  } finally {
    hostClearTimeout(timer);
  }
}
