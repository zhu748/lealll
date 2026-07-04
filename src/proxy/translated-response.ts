import type { Format, AnthropicMessagesResponse } from "../translator/types.js";
import { translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { translateResponseAnthropicToResponses } from "../translator/anthropic-to-responses.js";
import { saveTurn } from "../translator/responses-store.js";
import { SSE as SSE_CONST } from "../utils/constants.js";
import { readResponseTextLimited } from "./response-body.js";
import { printRow, type RequestMeta } from "./stats.js";

const DEFAULT_TRANSLATED_UPSTREAM_BODY_BYTES = 32 * 1024 * 1024;

function parsePositiveIntegerLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function translatedUpstreamBodyLimitBytes(): number {
  return parsePositiveIntegerLimit(
    process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES,
    DEFAULT_TRANSLATED_UPSTREAM_BODY_BYTES,
  );
}

export function sseToBatchBodyLimitBytes(): number {
  return parsePositiveIntegerLimit(
    process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES,
    SSE_CONST.MAX_TO_BATCH_BYTES,
  );
}

export function passthroughResponse(upstream: Response, body?: ReadableStream<Uint8Array>): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(body ?? upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientAcceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}

function gzipPayloadStream(payload: Uint8Array): ReadableStream<Uint8Array> {
  try {
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    return readable.pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  } catch {
    const gz = Bun.gzipSync(payload as Uint8Array<ArrayBuffer>);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gz as Uint8Array);
        controller.close();
      },
    });
  }
}

function forwardedUpstreamHeaders(): string[] {
  return [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];
}

function jsonResponseWithOptionalGzip(
  clientReq: Request,
  payload: Uint8Array,
  upstream: Response,
): Response {
  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    return new Response(gzipPayloadStream(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }

  return new Response(payload as Uint8Array<ArrayBuffer>, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
  credKey?: string,
  captchaMs: number = 0,
  retried: boolean = false,
): Promise<Response> {
  let raw: string;
  try {
    raw = await readResponseTextLimited(
      upstream,
      translatedUpstreamBodyLimitBytes(),
      "Translated upstream response",
    );
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0, retried, 0, credKey, captchaMs);
    return errorResponse(502, "translation_failed", `failed to read upstream response body: ${(err as Error).message}`);
  }

  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0, retried, 0, credKey, captchaMs);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }

  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const payload = new TextEncoder().encode(JSON.stringify(openaiResp));
  const inTok = openaiResp.usage?.prompt_tokens ?? 0;
  const outTok = openaiResp.usage?.completion_tokens ?? 0;
  const cacheReadTok = parsedAnthropic.usage?.cache_read_input_tokens ?? 0;

  printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, retried, inTok, credKey, captchaMs, cacheReadTok);
  return jsonResponseWithOptionalGzip(clientReq, payload, upstream);
}

export async function translatedResponsesBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
  previousResponseId: string | undefined,
  clientInput: unknown,
  customToolNames?: string[],
  credKey?: string,
  captchaMs: number = 0,
  retried: boolean = false,
): Promise<Response> {
  let raw: string;
  try {
    raw = await readResponseTextLimited(
      upstream,
      translatedUpstreamBodyLimitBytes(),
      "Translated upstream response",
    );
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0, retried, 0, credKey, captchaMs);
    return errorResponse(502, "translation_failed", `failed to read upstream response body: ${(err as Error).message}`);
  }

  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0, retried, 0, credKey, captchaMs);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }

  const responsesResp = translateResponseAnthropicToResponses(
    parsedAnthropic,
    model,
    previousResponseId ?? null,
    { customToolNames },
  );
  const normalizedInput = typeof clientInput === "string"
    ? [{ type: "message", role: "user", content: clientInput }]
    : Array.isArray(clientInput) ? clientInput : [];
  saveTurn(responsesResp.id, normalizedInput as unknown[], responsesResp.output as unknown[]);

  const payload = new TextEncoder().encode(JSON.stringify(responsesResp));
  const inTok = responsesResp.usage?.input_tokens ?? 0;
  const outTok = responsesResp.usage?.output_tokens ?? 0;
  const cacheReadTok = parsedAnthropic.usage?.cache_read_input_tokens ?? 0;

  printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, retried, inTok, credKey, captchaMs, cacheReadTok);
  return jsonResponseWithOptionalGzip(clientReq, payload, upstream);
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
