import { readRequestBytes } from "../utils/request-body.js";
import { inflateWithCap } from "./inflate.js";

/**
 * Read the request body as a string, returning undefined for empty bodies.
 * Transparently inflates `content-encoding: gzip` request bodies (the OpenAI /
 * Anthropic upstreams accept gzipped request bodies; without this, clients
 * that send them got a misleading "body is not valid JSON" 400). Corrupt gzip
 * throws a descriptive Error; inflation past `MAX_INFLATED_BODY_BYTES` throws
 * `InflatedBodyTooLargeError` (streamed + aborted early, so a small wire
 * payload cannot expand into unbounded proxy memory). When a positive
 * `maxBytes` cap is supplied (from `server.maxRequestBodyBytes`), plain bodies
 * past the cap throw `RequestBodyTooLargeError` (streamed + aborted early).
 */
export async function readBody(req: Request, maxBytes?: number): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const encoding = req.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  const bytes = await readRequestBytes(req, maxBytes, limit => new RequestBodyTooLargeError(limit));
  if (bytes.byteLength === 0) return undefined;
  if (encoding === "gzip" || encoding === "x-gzip") {
    return new TextDecoder().decode(await inflateGzipBody(bytes));
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Thrown when a request body exceeds the configured `server.maxRequestBodyBytes` cap.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} byte cap (server.maxRequestBodyBytes; 0 disables)`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Decompressed-size ceiling for gzip request bodies. Generous by design:
 * plain bodies on `/v1/*` routes are intentionally uncapped (long-context LLM
 * requests reach several MB), so this only rejects pathological amplification.
 */
const MAX_INFLATED_BODY_BYTES = 64 * 1024 * 1024;

/** Thrown when a gzip request body expands past MAX_INFLATED_BODY_BYTES. */
export class InflatedBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`gzip request body exceeds ${limit} bytes after decompression`);
    this.name = "InflatedBodyTooLargeError";
  }
}

async function inflateGzipBody(bytes: Uint8Array): Promise<Uint8Array> {
  const result = await inflateWithCap(bytes, MAX_INFLATED_BODY_BYTES);
  if (!result.ok) {
    if (result.reason === "too_large") throw new InflatedBodyTooLargeError(MAX_INFLATED_BODY_BYTES);
    throw new Error(`request body is marked content-encoding: gzip but failed to decompress: ${result.detail}`);
  }
  return result.bytes;
}
