/**
 * Proxy-aware fetch wrapper.
 *
 * Bun's native `fetch(url, { proxy })` only supports HTTP/HTTPS proxies —
 * passing a SOCKS URL (`socks4://`, `socks4a://`, `socks5://`, `socks5h://`)
 * throws `UnsupportedProxyProtocol`. This module transparently routes SOCKS
 * proxies through a local HTTP-CONNECT→SOCKS bridge (see `socks-bridge.ts`)
 * so call sites can pass any proxy URL without worrying about the scheme.
 *
 * Routing
 * -------
 *   - no proxy               → fetch as-is (no `proxy` opt)
 *   - http:// or https://    → fetch with `{ proxy }` (Bun native, unchanged)
 *   - socks4://, socks4a://, socks5://, socks5h://
 *                            → acquire a bridge handle, fetch with the
 *                              bridge's `http://127.0.0.1:<port>` URL as
 *                              `proxy`, release the handle when the response
 *                              body is consumed/cancelled (or immediately on
 *                              fetch error)
 *
 * Two entry points
 * ----------------
 *   1. `proxiedFetch(input, init, baseFetch?)` — one-off call. Use when you
 *      have a single fetch to make and don't need a reusable function.
 *
 *   2. `wrapFetchWithSocksBridge(baseFetch)` — returns a `typeof fetch` that
 *      transparently routes SOCKS proxies through the bridge. Use when you
 *      need to pass a `fetchImpl` to a subsystem that calls fetch multiple
 *      times with potentially different proxies (e.g. the proxy pool test
 *      job, which tests a different proxy per iteration).
 *
 * Test compatibility
 * ------------------
 * Both entry points accept a `baseFetch` injection. If a test passes a mock
 * fetch, the mock receives a non-SOCKS `proxy` URL (the bridge URL) when the
 * original proxy was SOCKS — the mock never has to actually speak SOCKS.
 */

import { isSocksProxy, getSocksBridge } from "./socks-bridge.js";

function releaseAfterResponseBody(resp: Response, release: () => void): Response {
  if (!resp.body) {
    release();
    return resp;
  }

  const reader = resp.body.getReader();
  let released = false;
  let streamClosed = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch {}
    release();
  };
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (streamClosed) return;
    streamClosed = true;
    try { controller.close(); } catch {}
  };
  const safeError = (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown): void => {
    if (streamClosed) return;
    streamClosed = true;
    try { controller.error(err); } catch {}
  };
  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array): boolean => {
    if (streamClosed) return false;
    try {
      controller.enqueue(value);
      return true;
    } catch (err) {
      safeError(controller, err);
      return false;
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (streamClosed) return;
        if (done) {
          finish();
          safeClose(controller);
          return;
        }
        if (value && !safeEnqueue(controller, value)) {
          finish();
        }
      } catch (err) {
        finish();
        safeError(controller, err);
      }
    },
    async cancel(reason) {
      streamClosed = true;
      try { await reader.cancel(reason); } catch {}
      finish();
    },
  });

  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

/**
 * Fetch through a proxy of any supported scheme (http/https/socks4/4a/5/5h).
 *
 * `init.proxy` may be `undefined` (no proxy — direct connection) or any of the
 * schemes listed above. The returned promise resolves/rejects exactly like a
 * native `fetch` call with the same semantics.
 *
 * The bridge handle (if any) is released automatically when the response body
 * finishes or is cancelled, so streaming responses keep the bridge alive.
 *
 * `baseFetch` defaults to the global `fetch`. Tests pass a mock here.
 */
export async function proxiedFetch(
  input: RequestInfo | URL,
  init?: RequestInit & { proxy?: string },
  baseFetch: typeof fetch = fetch,
): Promise<Response> {
  const proxyUrl = (init as { proxy?: string } | undefined)?.proxy;
  if (!proxyUrl) {
    return baseFetch(input as RequestInfo | URL, init as RequestInit);
  }
  if (!isSocksProxy(proxyUrl)) {
    return baseFetch(input as RequestInfo | URL, init as RequestInit);
  }
  // SOCKS proxy — route through the local bridge.
  const { httpProxyUrl, release } = getSocksBridge(proxyUrl);
  const { proxy: _drop, ...rest } = init as RequestInit & { proxy?: string };
  void _drop;
  try {
    const resp = await baseFetch(input as RequestInfo | URL, {
      ...rest,
      proxy: httpProxyUrl,
    } as RequestInit & { proxy: string });
    return releaseAfterResponseBody(resp, release);
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Wrap `baseFetch` so that any call with `init.proxy` set to a SOCKS URL is
 * transparently re-routed through a local bridge. Calls with HTTP/HTTPS
 proxies or no proxy pass through unchanged.
 *
 * The returned function is `typeof fetch`-compatible — pass it anywhere a
 * `fetchImpl` is expected.
 */
export function wrapFetchWithSocksBridge(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const proxyUrl = (init as { proxy?: string } | undefined)?.proxy;
    if (!proxyUrl || !isSocksProxy(proxyUrl)) {
      return baseFetch(input, init);
    }
    const { httpProxyUrl, release } = getSocksBridge(proxyUrl);
    const { proxy: _drop, ...rest } = init as RequestInit & { proxy?: string };
    void _drop;
    try {
      const resp = await baseFetch(input as RequestInfo | URL, {
        ...rest,
        proxy: httpProxyUrl,
      } as RequestInit & { proxy: string });
      return releaseAfterResponseBody(resp, release);
    } catch (err) {
      release();
      throw err;
    }
  }) as typeof fetch;
}

/**
 * Build a `typeof fetch`-compatible wrapper that injects the supplied proxy
 * URL into every fetch call. Used by call sites that previously built a
 * one-off inline wrapper (e.g. the quota query in admin/api.ts).
 *
 * If `proxyUrl` is empty/undefined, the returned function calls the supplied
 * `baseFetch` (or global fetch) directly with no `proxy` opt — so callers
 * don't need to branch on "is a proxy configured?" themselves.
 *
 * SOCKS proxies are routed through the bridge automatically.
 */
export function makeProxiedFetcher(
  proxyUrl: string | undefined,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!proxyUrl || !proxyUrl.trim()) {
    return baseFetch;
  }
  const socksAware = wrapFetchWithSocksBridge(baseFetch);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // If the caller already set a `proxy` on init, respect it (don't override).
    const existing = (init as { proxy?: string } | undefined)?.proxy;
    if (existing) {
      return socksAware(input, init);
    }
    return socksAware(input, { ...(init as RequestInit), proxy: proxyUrl });
  }) as typeof fetch;
}
