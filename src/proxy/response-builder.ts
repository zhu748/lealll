/** Build client responses from upstream data; logging remains with the caller. */
import { gzipSync } from "node:zlib";
import { translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import type { AnthropicMessagesResponse } from "../translator/types.js";
import { errorResponse } from "./translated-response.js";

const FORWARDED_UPSTREAM_HEADERS = [
  "x-request-id",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
];

const PASSTHROUGH_HEADERS = [
  "content-type", "content-encoding", "cache-control",
  ...FORWARDED_UPSTREAM_HEADERS,
];

function copyUpstreamHeaders(upstream: Response, names: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Explicit gzip support, excluding q=0. */
export function clientAcceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}

/** Stream upstream status and allowlisted headers, honoring client gzip support. */
export function passthroughResponse(
  upstream: Response,
  acceptsGzip: boolean,
  body?: ReadableStream<Uint8Array>,
): Response {
  const headers = copyUpstreamHeaders(upstream, PASSTHROUGH_HEADERS);
  const encoding = headers.get("content-encoding")?.toLowerCase() ?? "";
  const source = body ?? upstream.body;
  if (encoding.includes("gzip") && !acceptsGzip && source) {
    const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(source.pipeThrough(gunzip), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }
  return new Response(source, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

interface TranslatedBatchResult {
  response: Response;
  tokens: number;
}

/** Decode an Anthropic batch response and emit OpenAI JSON (optionally gzipped). */
export async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
): Promise<TranslatedBatchResult> {
  const raw = await upstream.text();
  let parsed: AnthropicMessagesResponse;
  try {
    parsed = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    return {
      response: errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`),
      tokens: 0,
    };
  }
  if (!isAnthropicMessagesResponse(parsed)) {
    return {
      response: errorResponse(502, "translation_failed", `upstream returned invalid Anthropic message: ${raw.slice(0, 200)}`),
      tokens: 0,
    };
  }

  const openai = translateResponseAnthropicToOpenAI(parsed, model);
  const payload = new TextEncoder().encode(JSON.stringify(openai));
  const headers = copyUpstreamHeaders(upstream, FORWARDED_UPSTREAM_HEADERS);
  headers.set("content-type", "application/json");
  const acceptsGzip = clientAcceptsGzip(clientReq);
  if (acceptsGzip) headers.set("content-encoding", "gzip");
  return {
    response: new Response(acceptsGzip ? gzipSync(payload) : payload, {
      status: upstream.status,
      headers,
    }),
    tokens: openai.usage?.completion_tokens ?? 0,
  };
}

function isAnthropicMessagesResponse(value: unknown): value is AnthropicMessagesResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnthropicMessagesResponse>;
  return candidate.type === "message" && candidate.role === "assistant" && Array.isArray(candidate.content);
}

export function translatedSseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
