/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 *
 * **Translation mode** (OpenAI clients): the proxy translates OpenAI requests
 * to Anthropic format, forwards to the Anthropic upstream (provider's
 * anthropic endpoint in coding-plan, or zcode.z.ai gateway in start-plan),
 * then translates the response back to OpenAI format. Anthropic clients
 * pass through unchanged in both plans.
 *
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamRequest } from "./upstream.js";
import { transformRequestBody, transformRequestBodyObj } from "./body-transformer.js";
import { detectCaptchaChallenge, getCaptchaToken, invalidateCaptchaToken, RETRY_HEADERS } from "./captcha.js";
import { detectSseErrorAndConvert } from "./sse-error-detector.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { translateRequestResponsesToAnthropic } from "../translator/responses-to-anthropic.js";
import { translateResponseAnthropicToResponses, anthropicSseToResponsesSse } from "../translator/anthropic-to-responses.js";
import { saveTurn } from "../translator/responses-store.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import type { OpenAIChatRequest, OpenAIResponseRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { recordStat } from "../admin/api.js";
import { sleep } from "../utils/sleep.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Uses `decompress: false` on the upstream fetch so compressed response bodies
 * (gzip/deflate/br) pass through untouched — the raw bytes and Content-Encoding
 * header are forwarded as-is, letting the client handle decompression.
 *
 * No upstream timeout is applied — matches ZCode desktop client behaviour
 * (the bundle has no automatic timer on LLM calls, only user-initiated abort).
 * Connection-level errors (ECONNREFUSED, DNS failure) still surface as 502.
 */
export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const reqId = nextReqId();

  const body = await readBody(clientReq);

  // Parse the body once and reuse the parsed object throughout the pipeline.
  // Previously the body string was JSON.parse'd up to 3 times (peekBody,
  // translateOpenAIBody, transformRequestBody) — now we parse once.
  let parsedBody: unknown;
  if (body && body.length > 0) {
    try {
      parsedBody = JSON.parse(body);
    } catch (err) {
      const meta: RequestMeta = { model: "-", stream: false };
      printRow(reqId, format, meta, 400, started, Date.now(), 0, 0, 0);
      return errorResponse(400, "invalid_json", `Request body is not valid JSON: ${(err as Error).message}`);
    }
  }

  const meta = peekParsedBody(parsedBody);

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  // Translation mode: OpenAI client formats are routed through the Anthropic
  // upstream (provider's anthropic endpoint in coding-plan, or zcode.z.ai
  // gateway in start-plan). The request body is translated OpenAI→Anthropic,
  // and the response is translated back Anthropic→OpenAI.
  //
  // "openai"           → Chat Completions format
  // "openai-responses" → Responses API format (used by Codex CLI)
  const translateMode = format === "openai" || format === "openai-responses";
  const upstreamFormat: Format = translateMode ? "anthropic" : format;

  let upstreamBodyObj: unknown = parsedBody;
  if (translateMode) {
    const translated = translateClientBodyObj(parsedBody, format);
    if (translated instanceof Response) return translated;
    upstreamBodyObj = translated;
  }

  const transformedObj = transformRequestBodyObj(upstreamBodyObj, { format: upstreamFormat, userId: cred.userId, startPlan: config.plan === "start-plan" });
  const transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;

  let captchaHeaders: Record<string, string> | undefined;
  if (config.plan === "start-plan") {
    try {
      const token = await getCaptchaToken();
      captchaHeaders = { [RETRY_HEADERS.PARAM]: token.verifyParam, [RETRY_HEADERS.REGION]: token.region };
    } catch {
      // Will solve on 403 fallback below
    }
  }

  // Factory that builds a FRESH Request object for each fetch call.
  // Request bodies are single-use — once fetch() consumes the body, the same
  // Request object cannot be passed to fetch() again (throws
  // "Request body already used"). This bit us hard on retries: the first
  // request would succeed or fail, then every retry would throw that error,
  // get caught by the catch block, and get converted to a synthetic 502 —
  // making retries completely ineffective.
  const buildUpstreamReq = (captcha?: Record<string, string>) =>
    buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, config.plan, captcha);

  // Fetch + SSE error detection in one shot. Used for both the initial fetch
  // AND every retry, so SSE errors hidden in 200 streams are caught on every
  // attempt — not just the first one.
  const fetchUpstreamDetected = async (captcha?: Record<string, string>): Promise<Response> => {
    const req = buildUpstreamReq(captcha);
    let resp = await fetchImpl(req, translateMode ? {} : { decompress: false });
    if (resp.status === 200) {
      const originalStatus = resp.status;
      resp = await detectSseErrorAndConvert(resp);
      if (resp.status !== originalStatus) {
        console.log(`${reqId} SSE error detected in 200 stream → HTTP ${resp.status}`);
      }
    }
    return resp;
  };

  // Refresh captcha token if we're in start-plan mode. Returns the captcha
  // headers to use, or undefined if not in start-plan / refresh failed.
  // Called before EVERY fetch attempt (initial + retries) to avoid using a
  // stale token that expired during the retry backoff window.
  //
  // Token TTL is 45s; the first request might wait 1-8s on retry backoff,
  // and the upstream might take another few seconds to respond — easily
  // pushing us past the 45s mark. Using a stale token returns 403
  // "captcha verify failed" which then leaks through to the client.
  //
  // getCaptchaToken() internally caches for TOKEN_TTL_MS (45s), so calling
  // it on every retry is cheap — only re-solves when the cache expires.
  const refreshCaptchaHeaders = async (): Promise<Record<string, string> | undefined> => {
    if (config.plan !== "start-plan") return undefined;
    try {
      const token = await getCaptchaToken();
      return { [RETRY_HEADERS.PARAM]: token.verifyParam, [RETRY_HEADERS.REGION]: token.region };
    } catch {
      return undefined;
    }
  };

  // Handle a 403 captcha challenge by invalidating the cached token,
  // re-solving, and retrying the fetch with the fresh token.
  // Returns the new response, or the original 403 if re-solve fails.
  // Used both for the initial fetch AND for retry-loop fetches — without
  // this, a retry that returns 403 would leak through to the client.
  const handleCaptchaChallenge = async (resp: Response): Promise<Response> => {
    try { resp.body?.cancel(); } catch {}
    console.log(`${reqId} captcha challenge (403), re-solving...`);
    invalidateCaptchaToken();
    try {
      const fresh = await getCaptchaToken();
      console.log(`${reqId} captcha re-solved (token ${fresh.verifyParam.length} chars), retrying...`);
      const freshCaptcha = {
        [RETRY_HEADERS.PARAM]: fresh.verifyParam,
        [RETRY_HEADERS.REGION]: fresh.region,
      };
      const newResp = await fetchUpstreamDetected(freshCaptcha);
      headersAt = Date.now();
      return newResp;
    } catch (err) {
      console.log(`${reqId} captcha re-solve failed: ${(err as Error).message}`);
      // Return a synthetic 503 so caller can decide what to do
      return errorResponse(503, "captcha_solver_failed", (err as Error).message);
    }
  };

  let upstreamResp: Response;
  try {
    // Always refresh captcha token right before the fetch — the token we
    // got at the start of this function might have expired by now if there
    // was any await in between (config loading, body parsing, etc.).
    captchaHeaders = await refreshCaptchaHeaders();
    upstreamResp = await fetchUpstreamDetected(captchaHeaders);
  } catch (err) {
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }
  let headersAt = Date.now();

  if (upstreamResp.status === 401 && config.plan === "start-plan") {
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  // start-plan: on 403 captcha challenge, force re-solve and retry once.
  // This handles the INITIAL response. Retries that return 403 are handled
  // inside the retry loop below via the same handleCaptchaChallenge() helper.
  if (config.plan === "start-plan" && (upstreamResp.status === 403 || detectCaptchaChallenge(upstreamResp))) {
    upstreamResp = await handleCaptchaChallenge(upstreamResp);
    // If captcha re-solve itself failed, bail out
    if (upstreamResp.status === 503 && upstreamResp.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = await upstreamResp.text();
        const parsed = JSON.parse(body);
        if (parsed?.error?.type === "captcha_solver_failed") {
          printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
          return upstreamResp;
        }
      } catch { /* not a captcha_solver_failed response — continue */ }
    }
  }

  // SSE error detection for the initial response is already handled inside
  // fetchUpstreamDetected() above. The standalone detection block that used
  // to live here has been removed — fetchUpstreamDetected now handles it
  // uniformly for both the initial fetch and every retry.

  // Retry on retryable status codes (e.g. 529 site overloaded, 429 rate limited)
  // Uses exponential backoff with jitter, and respects Retry-After header.
  //
  // CRITICAL: Each retry MUST build a fresh Request via fetchUpstreamDetected().
  // Reusing the same Request object fails with "Request body already used"
  // because fetch() consumes the body on the first call — this was the bug
  // where every retry after the first would silently fail with a synthetic 502.
  if (config.retry.maxRetries > 0 && config.retry.retryableStatuses.includes(upstreamResp.status)) {
    try { upstreamResp.body?.cancel(); } catch {}

    for (let attempt = 1; attempt <= config.retry.maxRetries; attempt++) {
      // Calculate backoff delay: initialDelay * backoffFactor^(attempt-1), capped at maxDelay
      const rawDelay = config.retry.initialDelayMs * Math.pow(config.retry.backoffFactor, attempt - 1);
      let delayMs = Math.min(rawDelay, config.retry.maxDelayMs);

      // Respect Retry-After header if present (value is in seconds)
      const retryAfter = upstreamResp.headers.get("retry-after");
      if (retryAfter) {
        const retryAfterMs = parseFloat(retryAfter) * 1000;
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          delayMs = Math.max(delayMs, retryAfterMs);
        }
      }

      // Add small random jitter (0–25% of delay) to avoid thundering herd
      const jitter = delayMs * 0.25 * Math.random();
      delayMs = Math.round(delayMs + jitter);

      console.log(
        `${reqId} upstream returned ${upstreamResp.status}, retry ${attempt}/${config.retry.maxRetries} in ${delayMs}ms...`,
      );
      await sleep(delayMs);

      try {
        // Build a FRESH Request for each retry — never reuse upstreamReq.
        // fetchUpstreamDetected also runs SSE error detection so 200 streams
        // with hidden errors get caught on every attempt.
        //
        // CRITICAL for start-plan: refresh captcha token before each retry.
        // The token from the initial fetch might have expired during the
        // backoff sleep (TTL is only 45s). Using a stale token returns 403
        // "captcha verify failed" — which is NOT a retryable status, so it
        // would break out of the loop and leak the 403 to the client.
        const retryCaptcha = await refreshCaptchaHeaders();
        upstreamResp = await fetchUpstreamDetected(retryCaptcha);
        headersAt = Date.now();

        // If the retry itself returns 403 (captcha challenge), try to
        // re-solve and retry once before giving up. This handles the case
        // where the token expired between refreshCaptchaHeaders() and the
        // upstream actually validating it (rare but possible under load).
        if (config.plan === "start-plan" && (upstreamResp.status === 403 || detectCaptchaChallenge(upstreamResp))) {
          console.log(`${reqId} retry ${attempt} got 403 captcha challenge, re-solving...`);
          upstreamResp = await handleCaptchaChallenge(upstreamResp);
        }
      } catch (err) {
        // Network error during retry — log the ACTUAL error so users can
        // diagnose (the old code just said "network error" with no detail).
        const errMsg = (err as Error).message ?? String(err);
        if (attempt < config.retry.maxRetries) {
          console.log(`${reqId} fetch failed on retry ${attempt}: ${errMsg}, will retry again...`);
          // Create a synthetic 502 response so the loop can continue checking retryableStatuses
          upstreamResp = errorResponse(502, "upstream_unreachable", errMsg);
          continue;
        }
        console.log(`${reqId} fetch failed on final retry ${attempt}: ${errMsg}`);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
        return errorResponse(502, "upstream_unreachable", errMsg);
      }

      // If the new response is no longer a retryable status, break out
      if (!config.retry.retryableStatuses.includes(upstreamResp.status)) {
        console.log(`${reqId} retry ${attempt} succeeded (status ${upstreamResp.status})`);
        break;
      }

      // Still a retryable status — if this was the last attempt, keep the
      // response body intact (don't cancel) so we can return it to the
      // client with a body. Previously the code cancelled the body then
      // refetched — but that refetch reused the consumed Request object
      // and always failed. Keeping the body is simpler and correct.
      if (attempt === config.retry.maxRetries) {
        console.log(`${reqId} all ${config.retry.maxRetries} retries exhausted, returning ${upstreamResp.status}`);
        break;
      }

      // More retries left — cancel the body before looping
      try { upstreamResp.body?.cancel(); } catch {}
    }
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (translateMode) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (format === "openai-responses") {
      // Responses API translation: use the dedicated SSE / batch translators.
      if (isSSE && upstreamResp.body) {
        const translated = anthropicSseToResponsesSse(upstreamResp.body, meta.model);
        const [clientBody, statsBody] = translated.tee();
        observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null);
        return translatedSseResponse(clientBody);
      }
      return await translatedResponsesBatchResponse(
        clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt,
        (parsedBody as OpenAIResponseRequest | undefined)?.previous_response_id,
        (parsedBody as OpenAIResponseRequest | undefined)?.input,
      );
    }
    // Chat Completions translation: use the original SSE / batch translators.
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null);
      return translatedSseResponse(clientBody);
    }
    return await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt);
  }

  if (isSSE && upstreamResp.body) {
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"));
    return passthroughResponse(upstreamResp, clientBody);
  }

  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  return passthroughResponse(upstreamResp);
}

/** Read the request body as a string, returning undefined for empty bodies. */
async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const text = await req.text();
  if (text.length === 0) return undefined;
  return text;
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status, headers, and body stream.
 */
function passthroughResponse(upstream: Response, body?: ReadableStream<Uint8Array>): Response {
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

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** True when the client request explicitly accepts gzip (and has not disabled it via q=0). */
function clientAcceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}

/** Build a translated batch (non-streaming) OpenAI response. Gzip if client accepts. */
async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
): Promise<Response> {
  const raw = await upstream.text();
  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const json = JSON.stringify(openaiResp);
  const payload = new TextEncoder().encode(json);

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, openaiResp.usage?.completion_tokens ?? 0, 0, 0);
    return new Response(Bun.gzipSync(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, openaiResp.usage?.completion_tokens ?? 0, 0, 0);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
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

/**
 * Build a translated batch (non-streaming) Responses API response.
 * Saves the input+output to the in-memory store keyed by the new response id,
 * so subsequent requests with `previous_response_id` can replay the history.
 * Gzip if client accepts.
 */
async function translatedResponsesBatchResponse(
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
): Promise<Response> {
  const raw = await upstream.text();
  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const responsesResp = translateResponseAnthropicToResponses(parsedAnthropic, model, previousResponseId ?? null);

  // Persist turn for previous_response_id chaining.
  const normalizedInput = typeof clientInput === "string"
    ? [{ type: "message", role: "user", content: clientInput }]
    : Array.isArray(clientInput) ? clientInput : [];
  saveTurn(responsesResp.id, normalizedInput as unknown[], responsesResp.output as unknown[]);

  const json = JSON.stringify(responsesResp);
  const payload = new TextEncoder().encode(json);

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, responsesResp.usage?.output_tokens ?? 0, 0, 0);
    return new Response(Bun.gzipSync(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, responsesResp.usage?.output_tokens ?? 0, 0, 0);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
}

function translatedSseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

interface RequestMeta {
  model: string;
  stream: boolean;
}

function peekParsedBody(parsed: unknown): RequestMeta {
  if (!parsed || typeof parsed !== "object") return { model: "-", stream: false };
  const p = parsed as Record<string, unknown>;
  return {
    model: typeof p.model === "string" ? p.model : "-",
    stream: p.stream === true,
  };
}

/** Translate a client request body object to Anthropic JSON. Returns error Response on failure. */
function translateClientBodyObj(parsed: unknown, format: Format): Response | unknown {
  if (parsed === undefined || parsed === null) {
    return errorResponse(400, "translation_failed", `${format} request body is empty; cannot translate.`);
  }
  try {
    if (format === "openai-responses") {
      return translateRequestResponsesToAnthropic(parsed as OpenAIResponseRequest);
    }
    return translateRequestOpenAIToAnthropic(parsed as OpenAIChatRequest);
  } catch (err) {
    return errorResponse(400, "translation_failed", `${format}→Anthropic translation failed: ${(err as Error).message}`);
  }
}

let reqCounter = 0;
let headerPrinted = false;

function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  console.log(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB |   Tok |  tok/s |   Total |",
  );
  console.log(
    "|------|------------|-----|-------------|--------|------|---------|-------|--------|---------|",
  );
}

function printRow(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
  retried: boolean = false,
): void {
  printHeader();
  const ts = new Date(started).toISOString().slice(11, 19);
  const tag = format === "anthropic" ? "ANT" : format === "openai-responses" ? "RSP" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
  );
  // Record stats for the admin dashboard
  recordStat({
    id: reqId,
    time: ts,
    model: meta.model,
    status,
    ttfb: String(headersAt - started),
    tokens: String(tokens),
    retried,
  });
}

function observeStream(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  requestSentAt: number,
  body: ReadableStream<Uint8Array>,
  contentEncoding: string | null,
): void {
  const compressed = contentEncoding !== null;
  let tokens = 0;
  let sseBuffer = "";
  let firstChunkAt = 0;

  function parseSse(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trimStart();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const j = JSON.parse(dataStr);
        // Prefer authoritative usage fields over event counting
        if (j.usage?.completion_tokens) { tokens = j.usage.completion_tokens; continue; }
        if (j.usage?.output_tokens) { tokens = j.usage.output_tokens; continue; }
        // OpenAI Chat Completions content delta: choices[0].delta.content
        const oai = j.choices?.[0]?.delta?.content;
        if (typeof oai === "string" && oai.length > 0) { tokens++; continue; }
        // Anthropic content delta: type=content_block_delta, delta.type=text_delta
        if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
          const t = j.delta?.text;
          if (typeof t === "string" && t.length > 0) tokens++;
          continue;
        }
        // Responses API text delta: type=response.output_text.delta
        if (j.type === "response.output_text.delta") {
          const t = j.delta;
          if (typeof t === "string" && t.length > 0) tokens++;
          continue;
        }
        // Responses API final event carries usage
        if (j.type === "response.completed" && j.response?.usage?.output_tokens) {
          tokens = j.response.usage.output_tokens;
          continue;
        }
      } catch {}
    }
  }

  (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        if (!compressed) {
          sseBuffer += decoder.decode(value, { stream: true });
          const idx = sseBuffer.lastIndexOf("\n");
          if (idx >= 0) {
            parseSse(sseBuffer.slice(0, idx));
            sseBuffer = sseBuffer.slice(idx + 1);
          }
        }
      }
      if (!compressed && sseBuffer) parseSse(sseBuffer);
    } catch {}
    const endAt = Date.now();
    const ttfbMs = (firstChunkAt > 0 ? firstChunkAt : endAt) - requestSentAt;
    const totalMs = endAt - requestSentAt;
    const avgTps = tokens > 0 && totalMs > 0 ? tokens / (totalMs / 1000) : 0;
    printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, tokens, avgTps, endAt);
  })().catch(() => {});
}
