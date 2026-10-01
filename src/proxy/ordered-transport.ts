import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { isSocksProxy, getSocksBridge } from "./socks-bridge.js";

export type OrderedHeaderPair = [string, string];

export interface OrderedUpstreamRequest {
  url: string;
  method?: string;
  headers: OrderedHeaderPair[];
  body?: string | Uint8Array;
  decompress?: boolean;
  /** Client abort signal — destroys the socket the moment the client aborts. */
  signal?: AbortSignal;
  /**
   * Egress proxy URL (`http://` CONNECT proxy, or any SOCKS scheme routed
   * transparently through the local socks-bridge). When set, the request is
   * tunneled via an HTTP CONNECT handshake before the real request is written;
   * unset/empty connects directly (unchanged behavior).
   */
  proxy?: string;
}

type WireSocket = Socket | TLSSocket;

const CRLF = "\r\n";
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * Response-header accumulation ceiling: a misbehaving upstream streaming
 * bytes without a blank line must not grow proxy memory unbounded. Real
 * response heads are < 8 KB; 64 KB is generous.
 */
const MAX_HEADER_BUFFER_BYTES = 64 * 1024;

/**
 * HTTP response content-coding → `DecompressionStream` format token.
 *
 * The ultra gateway's CDN applies brotli to SSE streams whenever the request
 * advertises `br` (observed 2026-09-18 on coding-plan traffic rerouted via
 * proxyEndpoint.mapping; the direct provider endpoints never compress SSE).
 * The real client's fetch stack auto-inflates gzip/deflate/br — this transport
 * mirrors that. Format ids differ from HTTP tokens (`br` → `"brotli"`), and
 * support is runtime-dependent, so every coding is capability-checked before
 * use; unsupported codings fall through to raw passthrough (paired with the
 * accept-encoding cap in handler.ts, which stops the upstream selecting them).
 */
const CODING_FORMATS: Readonly<Record<string, Bun.CompressionFormat>> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
};

let advertisedCodingsCache: readonly string[] | null = null;

// The DOM-lib `DecompressionStream` constructor type omits Bun's "brotli"/"zstd"
// formats even though the runtime accepts them — route construction through a
// Bun-typed alias so the wider format union stays type-safe end to end.
type InflateConstructor = new (format: Bun.CompressionFormat) => DecompressionStream;
const makeInflateStream: InflateConstructor = DecompressionStream as unknown as InflateConstructor;

function decompressFormatFor(coding: string): Bun.CompressionFormat | null {
  const format = CODING_FORMATS[coding];
  if (format === undefined) return null;
  try {
    new makeInflateStream(format);
    return format;
  } catch {
    return null;
  }
}

/** `accept-encoding` tokens this transport can inflate itself (memoized, `x-gzip` excluded). */
export function orderedAdvertisedCodings(): readonly string[] {
  if (advertisedCodingsCache === null) {
    advertisedCodingsCache = Object.keys(CODING_FORMATS)
      .filter((coding) => coding !== "x-gzip" && decompressFormatFor(coding) !== null);
  }
  return advertisedCodingsCache;
}

export async function sendOrderedUpstreamRequest(req: OrderedUpstreamRequest): Promise<Response> {
  const url = new URL(req.url);
  const bodyBytes = bodyToBytes(req.body);
  const requestHead = buildRequestHead(url, req.method ?? "POST", req.headers, bodyBytes.byteLength);
  // Fail fast on a pre-aborted signal: previously a pre-aborted request still
  // opened a TCP/TLS connection before the promise rejected.
  if (req.signal?.aborted) {
    throw new Error("client aborted during ordered upstream request");
  }
  const socket = await openSocket(url, req.signal, req.proxy?.trim() || undefined);

  return await new Promise<Response>((resolve, reject) => {
    let headerBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let responseStarted = false;
    let postWrite = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let chunkedDecoder: ChunkedDecoder | null = null;
    let remainingContentLength: number | null = null;
    let removeAbortListener: (() => void) | null = null;

    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        socket.destroy();
      },
    });

    function fail(err: unknown): void {
      if (!responseStarted && postWrite) {
        // Review follow-up #2 (PR #34): the full request (head + body) was
        // already written to the wire, so the upstream may have processed it
        // — resending could duplicate the LLM call and consume quota twice.
        // Flag it so the connect-retry loop in handler.ts skips this error.
        try { (err as { postWrite?: boolean }).postWrite = true; } catch {}
      }
      if (responseStarted) {
        // Safe by spec: error() on an already-closed/errored ReadableStream
        // controller is a NO-OP under WHATWG Streams semantics (only close()
        // and enqueue() throw on a closed controller) — verified against both
        // Bun and Node. The unguarded call below is intentional; do not wrap
        // it (audit CL-01: triple-verified non-issue, closed).
        bodyController?.error(err);
      } else {
        reject(err);
      }
      socket.destroy();
    }

    // Abort propagation (CL-04): destroy the socket the moment the client
    // aborts. Without this the upstream LLM call kept running (consuming
    // quota for the whole generation) after the client disappeared during a
    // long-TTFB reasoning request. `fail()` both rejects this promise (a bare
    // destroy() emits "close", not "error"/"end", and would leave it pending
    // forever) and errors the consumer-side body stream when the response has
    // already started. The resulting error carries `postWrite` (the request
    // is fully on the wire by then), so handler's connect-retry ladder skips
    // it — combined with the `clientReq.signal.aborted` pre-check there,
    // client aborts never enter the retry loop.
    if (req.signal) {
      const signal = req.signal;
      const onAbort = (): void => {
        fail(new Error("client aborted during ordered upstream request"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      // De-register when the socket settles so a signal that outlives this
      // request (the handler reuses the client signal across connect
      // attempts) does not accumulate listeners.
      socket.once("close", () => signal.removeEventListener("abort", onAbort));
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    function finish(): void {
      if (chunkedDecoder && !chunkedDecoder.done) {
        try { bodyController?.error(new Error("upstream chunked body truncated")); } catch {}
        socket.destroy();
        return;
      }
      try { bodyController?.close(); } catch {}
      // The handler reuses the client signal across connect attempts — drop
      // the abort listener on normal completion too (socket "close" may never
      // fire if the upstream half-closes and lingers).
      removeAbortListener?.();
    }

    function pushBody(bytes: Uint8Array): void {
      if (!bodyController || bytes.byteLength === 0) return;
      if (chunkedDecoder) {
        chunkedDecoder.push(bytes, bodyController);
        if (chunkedDecoder.done) finish();
        return;
      }
      if (remainingContentLength !== null) {
        const next = bytes.slice(0, remainingContentLength);
        remainingContentLength -= next.byteLength;
        if (next.byteLength > 0) bodyController.enqueue(next);
        if (remainingContentLength === 0) finish();
        return;
      }
      bodyController.enqueue(bytes);
    }

    socket.on("data", (chunk: Buffer) => {
      try {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (!responseStarted) {
          headerBuffer = concatBytes(headerBuffer, bytes);
          const headerEnd = indexOfBytes(headerBuffer, HEADER_END);
          if (headerEnd < 0) {
            if (headerBuffer.byteLength > MAX_HEADER_BUFFER_BYTES) {
              fail(new Error(`upstream response headers exceed ${MAX_HEADER_BUFFER_BYTES} bytes`));
            }
            return;
          }

          const headerBytes = headerBuffer.slice(0, headerEnd);
          const rest = headerBuffer.slice(headerEnd + HEADER_END.byteLength);
          const parsed = parseResponseHeaders(headerBytes);
          responseStarted = true;

          const transferEncoding = parsed.headers.get("transfer-encoding")?.toLowerCase() ?? "";
          if (transferEncoding.split(",").map((s) => s.trim()).includes("chunked")) {
            parsed.headers.delete("transfer-encoding");
            chunkedDecoder = new ChunkedDecoder();
          } else {
            const contentLength = parsed.headers.get("content-length");
            remainingContentLength = contentLength ? Number.parseInt(contentLength, 10) : null;
            // NaN or non-integer → unknown length (rely on connection close).
            // Negative values would corrupt slice arithmetic and never trigger
            // finish() — treat them as unknown too.
            if (!Number.isFinite(remainingContentLength as number) || (remainingContentLength as number) < 0) {
              remainingContentLength = null;
            }
          }

          let responseBody: ReadableStream<Uint8Array> = bodyStream;
          const wireCoding = parsed.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
          const inflateFormat = req.decompress && wireCoding !== "" && !wireCoding.includes(",")
            ? decompressFormatFor(wireCoding)
            : null;
          if (inflateFormat !== null) {
            parsed.headers.delete("content-encoding");
            parsed.headers.delete("content-length");
            const decoder = new makeInflateStream(inflateFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
            responseBody = bodyStream.pipeThrough(decoder);
          }

          resolve(new Response(responseBody, {
            status: parsed.status,
            statusText: parsed.statusText,
            headers: parsed.headers,
          }));
          pushBody(rest);
          return;
        }
        pushBody(bytes);
      } catch (err) {
        fail(err);
      }
    });

    socket.once("error", fail);
    socket.once("end", () => {
      if (!responseStarted) {
        reject(new Error("upstream closed before sending response headers"));
        return;
      }
      finish();
    });

    socket.write(requestHead);
    if (bodyBytes.byteLength > 0) socket.write(bodyBytes);
    postWrite = true;
  });
}

function openSocket(url: URL, signal?: AbortSignal, proxyUrl?: string): Promise<WireSocket> {
  const isHttps = url.protocol === "https:";
  if (!isHttps && url.protocol !== "http:") {
    return Promise.reject(new Error(`Unsupported upstream protocol: ${url.protocol}`));
  }
  if (proxyUrl) {
    return openProxiedSocket(url, signal, proxyUrl);
  }
  return openDirectSocket(url, signal);
}

/** Direct (no-proxy) connect — the historical behavior. */
function openDirectSocket(url: URL, signal?: AbortSignal): Promise<WireSocket> {
  const isHttps = url.protocol === "https:";
  const port = Number(url.port || (isHttps ? 443 : 80));

  return new Promise((resolve, reject) => {
    // Abort during the CONNECT phase: destroy the connecting socket and
    // reject. Previously the abort listener was wired only after connect
    // resolved, so a client cancel during a slow/firewalled connect left the
    // attempt running to completion (up to the OS-level timeout) with no way
    // for the disconnect or the connect-retry ladder to break it.
    let socket: WireSocket;
    const cleanup = (): void => {
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      socket.destroy();
      reject(new Error("client aborted during ordered upstream request (connect)"));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    socket = isHttps
      ? connectTls({ host: url.hostname, port, servername: url.hostname }, onConnect)
      : connectTcp({ host: url.hostname, port }, onConnect);
    socket.once("error", onError);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Response-head ceiling for the CONNECT handshake (malformed proxy guard). */
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;

/**
 * Connect through an egress proxy: `http://` proxies speak an HTTP CONNECT
 * handshake directly; SOCKS schemes ride the local socks-bridge (whose
 * endpoint IS an HTTP CONNECT proxy). The tunnel is then upgraded to TLS for
 * https targets. The bridge handle (if any) is released when the tunnel
 * socket closes — a streaming response must keep it alive until then.
 */
function openProxiedSocket(url: URL, signal: AbortSignal | undefined, proxyUrl: string): Promise<WireSocket> {
  if (isSocksProxy(proxyUrl)) {
    const bridge = getSocksBridge(proxyUrl);
    return tunnelThroughHttpProxy(url, signal, bridge.httpProxyUrl, bridge.release);
  }
  const proxy = new URL(proxyUrl);
  if (proxy.protocol === "https:") {
    return Promise.reject(new Error(
      "https:// CONNECT proxies are not supported by the ordered transport — use http:// or socks5:// for clientIdentity.enforce traffic",
    ));
  }
  if (proxy.protocol !== "http:") {
    return Promise.reject(new Error(`Unsupported ordered-transport proxy protocol: ${proxy.protocol}`));
  }
  return tunnelThroughHttpProxy(url, signal, proxyUrl);
}

function tunnelThroughHttpProxy(
  url: URL,
  signal: AbortSignal | undefined,
  proxyUrl: string,
  releaseTunnel?: () => void,
): Promise<WireSocket> {
  const isHttps = url.protocol === "https:";
  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 80);
  const targetPort = Number(url.port || (isHttps ? 443 : 80));
  const authority = `${url.hostname}:${targetPort}`;

  const proxyAuth = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(
        `${decodeURIComponent(proxy.username)}:${proxy.password ? decodeURIComponent(proxy.password) : ""}`,
      ).toString("base64")}\r\n`
    : "";
  const connectHead = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxyAuth}Proxy-Connection: keep-alive\r\n\r\n`;

  return new Promise<WireSocket>((resolve, reject) => {
    let socket!: Socket | TLSSocket;
    let buffer = Buffer.alloc(0);
    let settled = false;
    let headWritten = false;

    const onAbort = (): void => {
      cleanup();
      try { socket.destroy(); } catch {}
      reject(new Error("client aborted during proxy CONNECT"));
    };
    const onError = (err: Error): void => {
      cleanup();
      try { socket.destroy(); } catch {}
      reject(err);
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = (): void => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.write(connectHead);
      headWritten = true;
    };
    const onData = (chunk: Buffer): void => {
      if (!headWritten) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_CONNECT_RESPONSE_BYTES) {
        socket.off("data", onData);
        socket.off("error", onError);
        cleanup();
        try { socket.destroy(); } catch {}
        reject(new Error(`proxy CONNECT response exceeds ${MAX_CONNECT_RESPONSE_BYTES} bytes`));
        return;
      }
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      socket.off("data", onData);
      socket.off("error", onError);
      cleanup();
      const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
      const status = match ? Number(match[1]) : 0;
      if (status < 200 || status >= 300) {
        try { socket.destroy(); } catch {}
        releaseTunnel?.();
        reject(new Error(`proxy CONNECT failed: ${statusLine || "no status line"}`));
        return;
      }
      // Any bytes the proxy sent past the CONNECT response belong to the
      // tunneled stream — push them back so the request reader sees them.
      const leftover = buffer.subarray(headEnd + 4);
      if (leftover.byteLength > 0 && !isHttps) {
        try { socket.unshift(leftover); } catch { /* best-effort */ }
      }
      if (isHttps) {
        // Upgrade the established tunnel to TLS toward the target.
        let tlsSocket: TLSSocket;
        try {
          tlsSocket = connectTls({ socket, servername: url.hostname }, () => {
            settle(tlsSocket);
          });
        } catch (err) {
          try { socket.destroy(); } catch {}
          releaseTunnel?.();
          reject(err as Error);
          return;
        }
        tlsSocket.once("error", (err: Error) => {
          if (settled) return;
          try { socket.destroy(); } catch {}
          releaseTunnel?.();
          reject(err);
        });
        return;
      }
      settle(socket);
    };
    const settle = (wire: WireSocket): void => {
      if (settled) return;
      settled = true;
      // Keep the bridge handle alive for the whole tunneled exchange.
      if (releaseTunnel) {
        wire.once("close", releaseTunnel);
        wire.once("error", releaseTunnel);
      }
      resolve(wire);
    };

    socket = connectTcp({ host: proxyHost, port: proxyPort }, onConnect);
    socket.on("data", onData as (chunk: Buffer) => void);
    socket.once("error", onError as (err: Error) => void);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function buildRequestHead(url: URL, method: string, headers: OrderedHeaderPair[], contentLength: number): string {
  const path = `${url.pathname || "/"}${url.search}`;
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    ...headers.map(headerLine),
    `Content-Length: ${contentLength}`,
    "Connection: close",
    "",
    "",
  ];
  return lines.join(CRLF);
}

function headerLine([name, value]: OrderedHeaderPair): string {
  if (!HEADER_NAME.test(name)) throw new Error(`Invalid upstream header name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`Invalid upstream header value for ${name}`);
  return `${name}: ${value}`;
}

function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body;
}

function parseResponseHeaders(bytes: Uint8Array): { status: number; statusText: string; headers: Headers } {
  const text = new TextDecoder("latin1").decode(bytes);
  const lines = text.split(CRLF);
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) throw new Error(`Invalid upstream status line: ${statusLine}`);

  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name) continue;
    headers.append(name, line.slice(idx + 1).trimStart());
  }

  return { status: Number(match[1]), statusText: match[2] ?? "", headers };
}

/** Max bytes buffered while waiting for a complete chunk-size line (malformed upstream guard). */
const MAX_CHUNK_SIZE_LINE_BYTES = 16 * 1024;
/** Max declared size accepted for a single chunked body chunk (malformed upstream guard). */
const MAX_CHUNK_SIZE_BYTES = 16 * 1024 * 1024;
/** Hard cap on the decoder's total pending buffer (malformed upstream guard). */
const MAX_CHUNK_BUFFER_BYTES = 32 * 1024 * 1024;

class ChunkedDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private expectedSize: number | null = null;
  done = false;

  push(bytes: Uint8Array, controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.done) return;
    this.buffer = concatBytes(this.buffer, bytes);

    while (!this.done) {
      if (this.expectedSize === null) {
        const lineEnd = indexOfCrlf(this.buffer);
        if (lineEnd < 0) {
          // Waiting for the chunk-size line: without a cap, an upstream that
          // streams bytes forever without a CRLF grows this.buffer unbounded.
          if (this.buffer.byteLength > MAX_CHUNK_SIZE_LINE_BYTES) {
            throw new Error(`chunk size line exceeds ${MAX_CHUNK_SIZE_LINE_BYTES} bytes`);
          }
          return;
        }
        const line = new TextDecoder("latin1").decode(this.buffer.slice(0, lineEnd));
        const sizeHex = line.split(";", 1)[0].trim();
        const size = Number.parseInt(sizeHex, 16);
        if (!Number.isFinite(size)) throw new Error(`Invalid chunk size: ${line}`);
        // A bogus huge declared size (e.g. FFFFFFFF) would make the payload
        // wait below buffer up to that size — reject before waiting.
        if (size > MAX_CHUNK_SIZE_BYTES) {
          throw new Error(`chunk size ${size} exceeds ${MAX_CHUNK_SIZE_BYTES} bytes`);
        }
        this.buffer = this.buffer.slice(lineEnd + 2);
        this.expectedSize = size;
        if (size === 0) {
          this.done = true;
          return;
        }
      }

      if (this.buffer.byteLength < this.expectedSize + 2) {
        // Belt-and-braces: even a "valid" declared size must not let the
        // total pending buffer run away (fast check, no per-byte work).
        if (this.buffer.byteLength > MAX_CHUNK_BUFFER_BYTES) {
          throw new Error(`chunked decode buffer exceeds ${MAX_CHUNK_BUFFER_BYTES} bytes`);
        }
        return;
      }
      const chunk = this.buffer.slice(0, this.expectedSize);
      controller.enqueue(chunk);
      this.buffer = this.buffer.slice(this.expectedSize + 2);
      this.expectedSize = null;
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  if (a.byteLength > 0) out.set(a, 0);
  if (b.byteLength > 0) out.set(b, a.byteLength);
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfCrlf(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.byteLength - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}
