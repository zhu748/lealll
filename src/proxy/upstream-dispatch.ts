/** Transport selection, connection retry and runtime decompression normalization. */
import type { ProxyConfig } from "../config/types.js";
import type { ClientSessionResult } from "./client-session.js";
import type { UpstreamHeaderPair } from "./upstream.js";
import { sendOrderedUpstreamRequest, orderedAdvertisedCodings } from "./ordered-transport.js";
import { makeProxiedFetcher } from "./proxied-fetch.js";
import { sleep } from "../utils/sleep.js";

export function shouldUseOrderedTransport(_config: ProxyConfig, clientSession: ClientSessionResult | undefined, hasCustomFetchImpl: boolean): boolean {
  if (hasCustomFetchImpl) return false;
  return clientSession?.action === "enforce" || clientSession?.source === "explicit";
}

/**
 * Restrict an ordered-transport header-pair list's `accept-encoding` to codings
 * the transport can inflate itself (see ordered-transport.ts). Preserves the
 * client's token order, drops q-weights and unsupported tokens (including `*`),
 * and falls back to `identity` when nothing remains. Header order is untouched —
 * only the value at the existing position changes.
 */
export function capOrderedAcceptEncoding(
  pairs: UpstreamHeaderPair[],
  supported: readonly string[] = orderedAdvertisedCodings(),
): UpstreamHeaderPair[] {
  const idx = pairs.findIndex(([name]) => name.toLowerCase() === "accept-encoding");
  if (idx < 0) return pairs;
  const advertised = pairs[idx][1];
  const tokens = advertised
    .split(",")
    .map((token) => token.split(";")[0]!.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const kept = tokens.filter((token) => token === "identity" || supported.includes(token));
  if (kept.length === tokens.length) return pairs;
  const next = kept.length > 0 ? kept.join(", ") : "identity";
  return pairs.map((pair, i) => (i === idx ? [pair[0], next] as UpstreamHeaderPair : pair));
}

/** Max attempts (initial + 2 retries) for transient CONNECT-level failures. */
export const MAX_CONNECT_ATTEMPTS = 3;

/**
 * Connect-level retry ladder shared by the chat hot path and /v1/responses.
 * Transient connect failures (DNS blip, TLS reset, Bun "Unable to connect")
 * happen a few times a day against the gateway; the request never reached
 * upstream, so resending is side-effect-free.
 *
 * Contract (review P1/P2, PR #34/#35):
 *   - `attemptDispatch` must dispatch a FRESH request each call — a reused
 *     Request has its body stream marked used after the first fetch.
 *   - failures flagged `postWrite` (ordered transport already wrote the full
 *     request) are never retried — the upstream may have processed it.
 *   - no retry once the client aborted (`opts.isAborted`).
 */
export async function dispatchWithConnectRetry(
  attemptDispatch: () => Promise<Response>,
  opts: { isAborted?: () => boolean; onRetry?: (attempt: number, err: Error) => void } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    if (opts.isAborted?.()) throw new Error("client aborted before upstream connect");
    try {
      return await attemptDispatch();
    } catch (err) {
      if ((err as { postWrite?: boolean }).postWrite) throw err;
      if (attempt >= MAX_CONNECT_ATTEMPTS) throw err;
      const backoffMs = 500 * attempt;
      opts.onRetry?.(attempt, err as Error);
      await sleep(backoffMs);
    }
  }
}

/**
 * True on runtimes whose fetch ignores Bun's `decompress: false` extension and
 * transparently inflates compressed response bodies while KEEPING the
 * `content-encoding`/`content-length` headers (verified empirically against
 * Node 22/26 undici and Bun 1.3: gzip, deflate and br are all decoded, headers
 * unchanged). Bun honors `decompress: false` (raw bytes + truthful header), so
 * no normalization is needed there.
 */
const FETCH_AUTO_DECOMPRESSES = typeof Bun === "undefined";

/** Content codings a `FETCH_AUTO_DECOMPRESSES` runtime inflates transparently. */
const AUTO_DECODED_ENCODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);

/**
 * Strip `content-encoding`/`content-length` from a Response whose body the
 * runtime fetch has ALREADY inflated. Without this, passthrough on Node would
 * forward a decoded body still labeled `content-encoding: gzip` — clients that
 * advertise gzip then fail to decompress it, and the `passthroughResponse`
 * safety net would double-decompress an already-inflated stream for clients
 * that don't. No-op for encodings the runtime leaves untouched. Returns a new
 * Response because a fetch Response's headers can be immutable.
 */
export function stripAutoDecodedEncoding(resp: Response): Response {
  const encoding = resp.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  if (!encoding) return resp;
  const codings = encoding.split(",").map((c) => c.trim());
  if (!codings.every((c) => AUTO_DECODED_ENCODINGS.has(c))) return resp;
  const headers = new Headers(resp.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export interface UpstreamDispatchOptions {
  request: Request;
  headerPairs: UpstreamHeaderPair[];
  body?: string;
  translateMode: boolean;
  useOrderedTransport: boolean;
  fetchImpl: typeof fetch;
  abortSignal?: AbortSignal;
  hasCustomFetchImpl?: boolean;
  egressProxy?: string | null;
}

export async function sendUpstreamRequest({
  request: upstreamReq, headerPairs, body, translateMode, useOrderedTransport,
  fetchImpl, abortSignal, hasCustomFetchImpl = false, egressProxy,
}: UpstreamDispatchOptions): Promise<Response> {
  if (useOrderedTransport) {
    return sendOrderedUpstreamRequest({
      url: upstreamReq.url,
      method: upstreamReq.method,
      headers: headerPairs,
      body,
      decompress: translateMode,
      signal: abortSignal,
      proxy: egressProxy ?? undefined,
    });
  }
  const fetchOpts: RequestInit & { decompress?: boolean } = translateMode ? {} : { decompress: false };
  if (abortSignal) fetchOpts.signal = abortSignal;
  const egressFetch = egressProxy ? makeProxiedFetcher(egressProxy, fetchImpl) : fetchImpl;
  const resp = await egressFetch(upstreamReq, fetchOpts);
  // Passthrough on a runtime whose fetch auto-decompresses (Node/undici in the
  // Android bundle): the body arrives inflated while its headers still claim
  // compression. Drop the stale labels so the body/header pairing downstream
  // stays truthful. Skipped for injected fetch impls (tests) — their bodies are
  // genuinely compressed and their decompression semantics are their own.
  if (!translateMode && FETCH_AUTO_DECOMPRESSES && !hasCustomFetchImpl) {
    return stripAutoDecodedEncoding(resp);
  }
  return resp;
}
