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
import type { Credential } from "../auth/types.js";
import { getProvider } from "../provider/providers.js";
import { listModelIds } from "../provider/models.js";
import { buildUpstreamRequest } from "./upstream.js";
import { transformRequestBodyObj } from "./body-transformer.js";
import { logUpstreamRequest } from "./request-logger.js";
import { detectCaptchaChallenge, getCaptchaToken, invalidateCaptchaToken, RETRY_HEADERS } from "./captcha.js";
import { detectSseErrorAndConvert } from "./sse-error-detector.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { translateRequestResponsesToAnthropic } from "../translator/responses-to-anthropic.js";
import { translateResponseAnthropicToResponses, anthropicSseToResponsesSse } from "../translator/anthropic-to-responses.js";
import { saveTurn } from "../translator/responses-store.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import type { OpenAIChatRequest, OpenAIResponseRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { recordStat, recordDebugDump, appendLog } from "../admin/api.js";
import { sleep } from "../utils/sleep.js";
import { exportAccounts, switchAccount, maskApiKey } from "../auth/store.js";

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
 * Upstream timeout: an AbortController fires after UPSTREAM_TIMEOUT_MS (default
 * 10 minutes for streams, 5 minutes for batch). Without this, a hung upstream
 * TCP connection pins a Bun worker + the client connection indefinitely — under
 * upstream network partitions requests accumulate until OOM or fd exhaustion.
 * The timeout is generous enough to never fire on legitimate LLM calls (the
 * slowest reasonable thinking-trace stream is well under 10 minutes).
 *
 * Connection-level errors (ECONNREFUSED, DNS failure, abort) surface as 502.
 */
const UPSTREAM_TIMEOUT_STREAM_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_BATCH_MS = 5 * 60_000;

export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const reqId = nextReqId();

  // Debug logging flag — when true, logs the full upstream response details
  // (status + key headers + body preview) for every request. Enabled via
  // config.logging.debug OR env var ZCODE_PROXY_DEBUG_LOGGING=1. This is the
  // "调试日志" the user requested: see exactly what 529 / empty 200 / etc.
  // the upstream returns, including the error JSON body.
  const debugLoggingEnabled = config.logging?.debug === true
    || process.env.ZCODE_PROXY_DEBUG_LOGGING === "1";

  let body: string | undefined;
  try {
    body = await readBody(clientReq);
  } catch (err) {
    const e = err as Error & { httpStatus?: number; errorType?: string };
    const status = e.httpStatus ?? 400;
    const type = e.errorType ?? "body_read_failed";
    const meta: RequestMeta = { model: "-", stream: false };
    printRow(reqId, format, meta, status, started, Date.now(), 0, 0, 0);
    return errorResponse(status, type, e.message);
  }

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

  // Per-model routing rules: if any rule's pattern matches the request's
  // model field (glob-style, e.g. "glm-5*" matches "glm-5.1"), override the
  // provider/endpoint. Previously the rules were configured but never
  // consulted at request time — making the entire feature a no-op.
  const matchedRule = meta.model !== "-" && config.routingRules && config.routingRules.length > 0
    ? config.routingRules.find(r => globMatch(r.pattern, meta.model))
    : undefined;
  const effectiveProviderId = matchedRule?.provider ?? config.provider;

  const staticProvider = getProvider(effectiveProviderId);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[effectiveProviderId].anthropicBase,
    openaiBaseURL: config.providers[effectiveProviderId].openaiBase,
  };
  if (matchedRule) {
    console.log(`${reqId} routing rule matched: ${matchedRule.pattern} → provider=${matchedRule.provider}${matchedRule.endpoint ? `, endpoint=${matchedRule.endpoint}` : ""}`);
    // Note: matchedRule.endpoint is currently used for documentation/UI only.
    // Applying a custom endpoint here would require restructuring buildUpstreamURL
    // to accept a URL override; tracked separately. For now, the rule's provider
    // override is applied (the most common use case).
  }

  let cred: Credential;
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

  // Model rewrite for translation modes:
  //   1. If client-sent model matches a modelMappings entry (case-insensitive),
  //      rewrite to the mapped target.
  //   2. Else if the model is not a known GLM model (e.g. Codex CLI's "gpt-5.5"),
  //      fall back to config.defaultModel so GLM upstream doesn't 400.
  // Original model is preserved in the response echo for client compatibility.
  //
  // This is only applied in translation mode because passthrough mode lets the
  // upstream decide (matches the original proxy semantics — see README: "the
  // listing is informational, not a gate").
  if (translateMode && parsedBody && typeof parsedBody === "object") {
    const bodyObj = parsedBody as Record<string, unknown>;
    const clientModel = typeof bodyObj.model === "string" ? bodyObj.model : "";
    if (clientModel) {
      const mapped = lookupModelMapping(clientModel, config.modelMappings);
      if (mapped) {
        console.log(`${reqId} model mapping: ${clientModel} → ${mapped} (configured)`);
        bodyObj.model = mapped;
        meta.model = mapped;
      } else if (!isKnownGlmModel(clientModel)) {
        const fallback = config.defaultModel || "glm-4.6";
        console.log(`${reqId} model fallback: ${clientModel} → ${fallback} (non-GLM model not accepted upstream)`);
        bodyObj.model = fallback;
        meta.model = fallback;
      }
    }
  }

  let upstreamBodyObj: unknown = parsedBody;
  if (translateMode) {
    const forceThinkingModels = format === "openai-responses"
      ? config.responsesThinking?.models
      : undefined;
    const translated = translateClientBodyObj(parsedBody, format, forceThinkingModels ? { forceThinkingModels } : undefined);
    if (translated instanceof Response) return translated;
    upstreamBodyObj = translated;
  }

  // currentPlan tracks the effective plan for the CURRENT credential. It starts
  // as config.plan but is updated whenever the credential is switched mid-retry
  // (vceshi0.0.5+ fix for the "cross-plan credential switch" bug). Without this,
  // switching from a coding-plan cred to a start-plan cred (or vice versa) would
  // keep using the old plan's upstream URL, auth headers, and captcha logic —
  // guaranteeing the retried request fails the same way.
  let currentPlan: "coding-plan" | "start-plan" = config.plan;
  const effectivePlanForCred = (c: Credential): "coding-plan" | "start-plan" => {
    if (c.plan === "start-plan" || c.plan === "coding-plan") return c.plan;
    // Infer from JWT presence (matches store.ts inferPlan logic)
    return c.jwt ? "start-plan" : "coding-plan";
  };

  let transformedObj = transformRequestBodyObj(upstreamBodyObj, { format: upstreamFormat, userId: cred.userId, startPlan: currentPlan === "start-plan", testFlags: config.testFlags });

  // Force-enable streaming for Anthropic format when config.forceStreamAnthropic
  // is true. Overrides the client's stream preference (including missing/undefined
  // and stream:false) so the upstream returns SSE — giving the client real-time
  // token-by-token output instead of waiting for the full batch response.
  // Only applies to the Anthropic passthrough path (format === "anthropic");
  // translation modes (openai / openai-responses) already default to streaming.
  if (format === "anthropic" && config.forceStreamAnthropic && transformedObj && typeof transformedObj === "object") {
    const obj = transformedObj as Record<string, unknown>;
    if (obj.stream !== true) {
      console.log(`${reqId} force-stream: overriding stream=${obj.stream ?? "(unset)"} → true (forceStreamAnthropic enabled)`);
      obj.stream = true;
      meta.stream = true;
    }
  }

  let transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;

  // Diagnostic: log thinking-block strip counts so users can verify the fix
  // is actually running. If the count goes from N → 0, the strip worked.
  // If N > 0 in the transformed body, something is wrong.
  if (format === "anthropic") {
    const before = countThinkingBlocks(parsedBody);
    const after = countThinkingBlocks(transformedObj);
    if (before > 0 || after > 0) {
      console.log(`${reqId} thinking blocks: ${before} → ${after} (stripped ${before - after})`);
    }
    // Also log cache_control-on-tool_result strip counts — this was the
    // root cause of the v2.1.3.4beta0 start-plan 3001.
    const ccBefore = countToolResultCacheControl(parsedBody);
    const ccAfter = countToolResultCacheControl(transformedObj);
    if (ccBefore > 0 || ccAfter > 0) {
      console.log(`${reqId} tool_result+cache_control: ${ccBefore} → ${ccAfter} (stripped ${ccBefore - ccAfter})`);
    }
  }

  let captchaHeaders: Record<string, string> | undefined;
  if (currentPlan === "start-plan") {
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
    buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, currentPlan, captcha, config.testFlags);

  // vceshi0.0.8+: tracks the AbortController of the most-recent successful
  // upstream fetch, so the SSE response wrapper can abort it when the client
  // disconnects. Without this, a client that cancels a long SSE stream would
  // leave the upstream socket open until the 10-minute stream timeout fires —
  // and repeated disconnects would exhaust file descriptors.
  let activeUpstreamCtrl: AbortController | null = null;

  // Track the last anthropic-beta header actually sent upstream. Captured
  // during the real fetch so diagnostics on 4xx don't need to build a second
  // throwaway Request (which would generate fresh random UUIDs and log a
  // header belonging to a different request than the one actually sent).
  let lastSentBeta: string | null = null;

  // Fetch + SSE error detection in one shot. Used for both the initial fetch
  // AND every retry, so SSE errors hidden in 200 streams are caught on every
  // attempt — not just the first one.
  //
  // An AbortController applies an upstream timeout: 10 min for streaming
  // requests (LLM thinking traces can be long), 5 min for batch. Prevents a
  // hung upstream TCP connection from pinning a Bun worker forever.
  //
  // vceshi0.0.8+: the AbortController is RETURNED alongside the response so
  // the caller can wire it to the client's disconnect signal. When the client
  // cancels reading the response body, we abort the upstream fetch — which
  // releases the upstream socket immediately instead of letting it run until
  // the 10-minute timeout. Without this, repeated client disconnects on long
  // SSE streams would exhaust file descriptors.
  //
  // Also: for streaming responses, we DON'T clearTimeout on fetch resolve.
  // The timer keeps running and serves as an overall-stream lifetime cap —
  // if the upstream silently stops sending chunks mid-stream, the abort
  // fires after the timeout and frees the socket. (Previously the timer was
  // cleared as soon as headers arrived, leaving no idle-timeout protection
  // for the body-reading phase.)
  //
  // Per-account outbound proxy (v2.1.4.1test5+): if `cred.proxy` is set,
  // route the upstream fetch through that proxy via Bun's native
  // `{ proxy: url }` RequestInit option. We re-read `cred.proxy` on EVERY
  // call (not captured in a closure) so a credential switch mid-retry picks
  // up the new account's proxy automatically — without this, switching from
  // a proxied account to a direct one would keep using the old proxy.
  const fetchUpstreamDetected = async (captcha?: Record<string, string>): Promise<{ resp: Response; ctrl: AbortController }> => {
    const req = buildUpstreamReq(captcha);
    lastSentBeta = req.headers.get("anthropic-beta");
    // REQUEST LOG: save the prepared upstream request (headers + body) to disk
    // for debugging. Runs synchronously; failure is caught inside the logger.
    if (config.requestLog?.enabled) {
      try {
        logUpstreamRequest(req, transformedBody, reqId, {
          enabled: true,
          maxCount: config.requestLog.maxCount ?? 10,
          dir: config.requestLog.dir ?? "./log",
        });
      } catch (e) {
        // Logger errors must NEVER break the request flow
        console.error(`[request-log] ${reqId} log failed:`, e);
      }
    }
    const timeoutMs = meta.stream ? UPSTREAM_TIMEOUT_STREAM_MS : UPSTREAM_TIMEOUT_BATCH_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Bun's native fetch accepts `{ proxy: "http://..." }` / `socks5://...`
    // Cast through `any` because the option is Bun-specific and not in the
    // standard TypeScript DOM RequestInit type.
    const fetchOpts: any = {
      ...(translateMode ? {} : { decompress: false }),
      signal: ctrl.signal,
    };
    if (cred.proxy) {
      fetchOpts.proxy = cred.proxy;
    }
    let resp: Response;
    try {
      resp = await fetchImpl(req, fetchOpts);
    } catch (err) {
      clearTimeout(timer);
      // Distinguish abort (timeout) from real network errors so the error
      // message surfaces the actual cause to the client.
      if (ctrl.signal.aborted) {
        throw new Error(`upstream timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
    // vceshi0.0.8+: for non-streaming responses, clear the timer as before
    // (the body will be consumed synchronously by .text()/.json()). For
    // streaming responses, KEEP the timer running — it acts as an overall
    // stream lifetime cap. If the upstream silently stops sending chunks,
    // the timer fires and aborts the fetch, freeing the socket. The caller
    // is responsible for clearing the timer when the stream completes
    // naturally (via the wrapper installed below).
    if (!meta.stream) {
      clearTimeout(timer);
    }
    // vceshi0.0.6+: verbose logging — log the upstream request headers + body
    // when logging.verbose is enabled. Auth tokens are masked to avoid leaking
    // secrets to the dashboard log panel. Truncated to 2000 chars to avoid
    // flooding the 500-char-per-line log buffer (appendLog truncates anyway,
    // but we truncate here too so the console output stays readable).
    if (config.logging?.verbose) {
      try {
        const headerSummary: Record<string, string> = {};
        for (const [k, v] of req.headers.entries()) {
          const lk = k.toLowerCase();
          // Mask auth-bearing headers
          if (lk === "authorization" || lk === "x-api-key") {
            headerSummary[k] = v.length > 12 ? v.slice(0, 8) + "..." + v.slice(-4) : "***";
          } else {
            headerSummary[k] = v;
          }
        }
        console.log(`${reqId} [verbose] upstream headers: ${JSON.stringify(headerSummary)}`);
        if (transformedBody) {
          const bodyPreview = transformedBody.length > 2000
            ? transformedBody.slice(0, 2000) + `...(truncated, total ${transformedBody.length} chars)`
            : transformedBody;
          console.log(`${reqId} [verbose] transformed body: ${bodyPreview}`);
        }
      } catch { /* verbose logging must never break the request */ }
    }
    if (resp.status === 200) {
      const originalStatus = resp.status;
      resp = await detectSseErrorAndConvert(resp);
      if (resp.status !== originalStatus) {
        console.log(`${reqId} SSE error detected in 200 stream → HTTP ${resp.status}`);
      }
    }
    // DEBUG: log the upstream response details for debugging quota / empty /
    // error issues. Enabled when config.logging.debug is true (or env var
    // ZCODE_PROXY_DEBUG_LOGGING=1). Shows status, key headers, and a body
    // preview so the user can see EXACTLY what the upstream returned —
    // whether it's a 529 with an error JSON, an empty 200, or a real
    // response. This is the "调试日志" the user requested: "无论返回什么
    // 都能看到它具体返回啥的东西，比如529还是空回200都能看到具体返回的参数".
    if (debugLoggingEnabled) {
      logUpstreamResponseDebug(reqId, resp, meta.stream);
    }
    return { resp, ctrl };
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
    if (currentPlan !== "start-plan") return undefined;
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
      const fetched = await fetchUpstreamDetected(freshCaptcha);
      const newResp = fetched.resp;
      // For the captcha-retry path: if the new response is also 4xx/5xx,
      // abort the upstream immediately to free the socket (we won't read
      // the body anyway — handleCaptchaChallenge's caller will discard it).
      if (!newResp.ok) {
        try { fetched.ctrl.abort(); } catch {}
      } else {
        activeUpstreamCtrl = fetched.ctrl;
      }
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
    const fetched0 = await fetchUpstreamDetected(captchaHeaders);
    upstreamResp = fetched0.resp;
    // If the initial fetch returned an error, abort the upstream socket
    // immediately — we're going to retry or return an error response, so we
    // don't need to keep the upstream connection open. If it succeeded,
    // remember the ctrl so the SSE wrapper can abort it on client disconnect.
    if (!upstreamResp.ok) {
      try { fetched0.ctrl.abort(); } catch {}
      activeUpstreamCtrl = null;
    } else {
      activeUpstreamCtrl = fetched0.ctrl;
    }
  } catch (err) {
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }
  let headersAt = Date.now();

  if (upstreamResp.status === 401 && currentPlan === "start-plan") {
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  // start-plan: on 403 captcha challenge, force re-solve and retry once.
  // This handles the INITIAL response. Retries that return 403 are handled
  // inside the retry loop below via the same handleCaptchaChallenge() helper.
  if (currentPlan === "start-plan" && (upstreamResp.status === 403 || detectCaptchaChallenge(upstreamResp))) {
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
    // Detect empty-stream 529 (set by sse-error-detector.ts when the upstream
    // returned HTTP 200 + text/event-stream with zero SSE events — typical
    // quota-exhausted signature). This gets a dedicated retry policy:
    //   - retry up to 3 times with the SAME credential
    //   - if still empty after 3 retries, switch to the next stored credential
    //     and retry with the new one (counter resets on credential switch)
    //   - if no alternative credential is available, return the error to client
    //
    // This is separate from the generic credentialSwitchThreshold because
    // empty-stream is a high-confidence "this credential is dead" signal —
    // we don't want to wait for 5 generic failures before switching.
    const isEmptyStream529 = upstreamResp.status === 529 &&
      upstreamResp.headers.get("x-zcode-empty-stream") === "1";

    try { upstreamResp.body?.cancel(); } catch {}

    // Credential switching: track consecutive failures with the current
    // credential. When the threshold (config.retry.credentialSwitchThreshold)
    // is reached, the proxy switches to another stored credential before the
    // next retry. The initial attempt already failed (we only enter this block
    // on a retryable status), so the counter starts at 1.
    let consecutiveCredFailures = 1;
    // Fallback to 0 (disabled) if the field is missing — e.g. when a partial
    // config update via the admin API replaced the retry object without this
    // field. The loader always sets it, so this is just a safety net.
    const switchThreshold = config.retry.credentialSwitchThreshold ?? 0;
    // Credentials already tried in this request — prevents cycling back to a
    // known-failing credential when multiple alternatives exist.
    const triedApiKeys = new Set<string>([cred.apiKey]);
    // EMPTY-STREAM counter: tracks consecutive empty-stream 529s with the
    // current credential. When it hits EMPTY_STREAM_SWITCH_THRESHOLD, switch
    // to the next credential (regardless of the generic switchThreshold).
    // Threshold is configurable via config.retry.emptyStreamSwitchThreshold
    // (env var: ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD). Default 3.
    // Set to 0 to disable (fall back to the generic credentialSwitchThreshold).
    const EMPTY_STREAM_SWITCH_THRESHOLD = config.retry.emptyStreamSwitchThreshold ?? 3;
    let consecutiveEmptyStreams = isEmptyStream529 ? 1 : 0;
    // Track whether we already forcibly bumped maxRetries to give the empty-stream
    // path enough attempts to cycle through alternative credentials. The user's
    // spec is "retry 3 times then switch" — we may need MORE than maxRetries
    // total attempts if we want to actually try an alternative credential after
    // the switch (default maxRetries=3 would exhaust before the switch+retry).
    // We bump the effective limit by 1 per credential switch.
    //
    // vceshi0.0.8+: cap extraAttempts at 2× the number of unique credentials
    // we've tried. Without this, a pathological config (maxRetries=10, 5
    // dead credentials) would burn 10 + (5×2) = 20 retries × N seconds of
    // backoff each — leaving the client waiting minutes for a response that
    // was doomed after the first switch failed. The cap ensures we stop
    // cycling once every available credential has been tried twice.
    let extraAttemptsFromSwitches = 0;
    // vceshi0.0.8+: dynamic cap, recomputed at each switch. Without this,
    // a pathological config (maxRetries=10, 5 dead credentials) would burn
    // 10 + (5×2) = 20 retries × N seconds of backoff each — leaving the
    // client waiting minutes for a response that was doomed after the first
    // switch failed. The cap ensures we stop cycling once every available
    // credential has been tried twice.
    const extraAttemptsCap = () => Math.max(2, triedApiKeys.size * 2);

    for (let attempt = 1; attempt <= config.retry.maxRetries + extraAttemptsFromSwitches; attempt++) {
      // Calculate backoff delay: initialDelay * backoffFactor^(attempt-1), capped at maxDelay
      const rawDelay = config.retry.initialDelayMs * Math.pow(config.retry.backoffFactor, attempt - 1);
      let delayMs = Math.min(rawDelay, config.retry.maxDelayMs);

      // Respect Retry-After header. Per RFC 7231 §7.1.3 the value can be:
      //   - delta-seconds (e.g. "120"), OR
      //   - HTTP-date   (e.g. "Wed, 21 Oct 2025 07:28:00 GMT")
      // The old code only parsed delta-seconds and silently ignored HTTP-date
      // values — meaning the proxy would retry sooner than the upstream
      // explicitly requested.
      const retryAfter = upstreamResp.headers.get("retry-after");
      if (retryAfter) {
        let retryAfterMs: number;
        const asNum = parseFloat(retryAfter);
        if (Number.isFinite(asNum)) {
          retryAfterMs = asNum * 1000;
        } else {
          // Try HTTP-date format
          const dateMs = Date.parse(retryAfter);
          retryAfterMs = Number.isFinite(dateMs) ? dateMs - Date.now() : NaN;
        }
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

      // Credential switching: if the current credential has failed
      // consecutively enough times, switch to another stored credential
      // before this retry attempt. The new credential's auth headers and
      // userId are applied by reassigning `cred` and rebuilding the
      // transformed body — the buildUpstreamReq closure picks up the new
      // values automatically on the next fetch.
      //
      // EMPTY-STREAM SHORTCUT: if we've seen EMPTY_STREAM_SWITCH_THRESHOLD
      // (default 3) consecutive empty-stream 529s with the current credential,
      // switch IMMEDIATELY regardless of switchThreshold. Empty streams are
      // a much stronger "credential is dead" signal than a generic 529, so
      // we don't make the user wait through 5 generic failures first.
      // When EMPTY_STREAM_SWITCH_THRESHOLD is 0, the shortcut is disabled
      // (falls back to the generic credentialSwitchThreshold only).
      const shouldSwitchForEmptyStream = EMPTY_STREAM_SWITCH_THRESHOLD > 0 &&
        consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD;
      if (shouldSwitchForEmptyStream ||
          (switchThreshold > 0 && consecutiveCredFailures >= switchThreshold)) {
        const failedCount = consecutiveCredFailures;
        const newCred = await auth.switchToNextCredential(triedApiKeys);
        if (newCred) {
          const reason = shouldSwitchForEmptyStream
            ? `${consecutiveEmptyStreams} consecutive empty-stream responses`
            : `${failedCount} consecutive failures`;
          console.log(
            `${reqId} credential switched after ${reason} ` +
            `(retry ${attempt}/${config.retry.maxRetries + extraAttemptsFromSwitches}): ${maskApiKey(cred.apiKey)} → ${maskApiKey(newCred.apiKey)}`,
          );
          cred = newCred;
          // Sync currentPlan to the new credential's plan (vceshi0.0.5+ fix for
          // cross-plan credential switch bug). Without this, switching from a
          // coding-plan cred to a start-plan cred (or vice versa) would keep
          // using the old plan's upstream URL, auth headers, captcha logic —
          // guaranteeing the retried request fails the same way.
          const newPlan = effectivePlanForCred(newCred);
          if (newPlan !== currentPlan) {
            console.log(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
            currentPlan = newPlan;
          }
          // Rebuild the transformed body — userId is credential-specific and
          // gets injected into Anthropic metadata on start-plan.
          transformedObj = transformRequestBodyObj(upstreamBodyObj, {
            format: upstreamFormat,
            userId: cred.userId,
            startPlan: currentPlan === "start-plan",
            testFlags: config.testFlags,
          });
          transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;
          consecutiveCredFailures = 0;
          consecutiveEmptyStreams = 0; // reset empty-stream counter on switch
          triedApiKeys.add(newCred.apiKey);
          // Grant one extra retry attempt ONLY for empty-stream switches.
          // The user's spec is "retry 3 times then switch" — without an extra
          // attempt, the new credential would only get whatever's left of the
          // original maxRetries budget (often just 1 attempt with default
          // maxRetries=3). The extra attempt gives the new credential a fair
          // shot. For generic switchThreshold switches we DON'T add extra
          // attempts — the existing tests expect the loop to end at maxRetries.
          if (shouldSwitchForEmptyStream && extraAttemptsFromSwitches < extraAttemptsCap()) {
            extraAttemptsFromSwitches++;
          }
          // Persist the switch so the dashboard reflects the new active account.
          // Non-fatal: if persistence fails, the in-memory switch still works
          // for the remainder of this request.
          try {
            const accounts = await exportAccounts();
            const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
            if (match) {
              await switchAccount(match.id);
              appendLog("info", `Auto-switched credential to "${match.label}" (${maskApiKey(newCred.apiKey)}) after ${reason}`);
            }
          } catch (e) {
            console.log(`${reqId} could not persist credential switch: ${(e as Error).message}`);
          }
        } else {
          // No alternative credential available (or all alternatives already
          // tried in this request). Continue retrying with the current one.
          console.log(
            `${reqId} credential switch threshold reached but no alternative credential available ` +
            `(tried ${triedApiKeys.size} credential(s)), continuing with current`,
          );
        }
      }

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
        const fetchedRetry = await fetchUpstreamDetected(retryCaptcha);
        upstreamResp = fetchedRetry.resp;
        // Track the active ctrl so the SSE wrapper can abort on client
        // disconnect. If this is a retryable status (we'll loop again),
        // the body will be cancelled below before the next attempt — that
        // cancellation does NOT need to abort the ctrl (we want the socket
        // to close naturally as the body drains). Only the FINAL successful
        // response's ctrl matters for the SSE wrapper.
        if (upstreamResp.ok) {
          activeUpstreamCtrl = fetchedRetry.ctrl;
        } else if (config.retry.retryableStatuses.includes(upstreamResp.status)) {
          // Retryable error — body will be cancelled below, abort ctrl to
          // free the socket immediately since we won't read the body.
          try { fetchedRetry.ctrl.abort(); } catch {}
          activeUpstreamCtrl = null;
        }
        headersAt = Date.now();

        // If the retry itself returns 403 (captcha challenge), try to
        // re-solve and retry once before giving up. This handles the case
        // where the token expired between refreshCaptchaHeaders() and the
        // upstream actually validating it (rare but possible under load).
        if (currentPlan === "start-plan" && (upstreamResp.status === 403 || detectCaptchaChallenge(upstreamResp))) {
          console.log(`${reqId} retry ${attempt} got 403 captcha challenge, re-solving...`);
          upstreamResp = await handleCaptchaChallenge(upstreamResp);
        }
      } catch (err) {
        // Network error during retry — log the ACTUAL error so users can
        // diagnose (the old code just said "network error" with no detail).
        const errMsg = (err as Error).message ?? String(err);
        // Network errors count toward the credential-switch failure counter.
        consecutiveCredFailures++;
        if (attempt < config.retry.maxRetries + extraAttemptsFromSwitches) {
          console.log(`${reqId} fetch failed on retry ${attempt}: ${errMsg}, will retry again...`);
          // Network errors are ALWAYS retryable — they are the most common
          // retry scenario (upstream blip, transient DNS, ECONNREFUSED during
          // deploy). The previous code synthesized a 502 and then checked
          // `retryableStatuses.includes(502)` — but the default config is
          // `[529]` only, so synthetic 502 broke the loop and the actual
          // retry never happened. Skip the retryable-status check below by
          // continuing the loop directly here.
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

      // Still a retryable status — count as a failure for credential switching.
      consecutiveCredFailures++;
      // Track empty-stream responses separately — they trigger a faster
      // credential switch (3 consecutive empties vs. switchThreshold=5 for
      // generic failures).
      const retryWasEmptyStream = upstreamResp.status === 529 &&
        upstreamResp.headers.get("x-zcode-empty-stream") === "1";
      if (retryWasEmptyStream) {
        consecutiveEmptyStreams++;
        console.log(`${reqId} retry ${attempt} got empty-stream 529 (${consecutiveEmptyStreams}/${EMPTY_STREAM_SWITCH_THRESHOLD} before forced switch)`);
      } else {
        // Any non-empty retryable status resets the empty-stream counter —
        // a 529 from a real overloaded_error is a different signal than
        // an empty stream, and we don't want it to count toward the
        // empty-stream switch.
        consecutiveEmptyStreams = 0;
      }

      // vceshi0.0.5+ fix: off-by-one in empty-stream switch.
      // Previously the switch check was only at the TOP of the loop, so if
      // the threshold was reached on the LAST retry attempt, the break below
      // would fire before the switch ever triggered — making the feature
      // a no-op under default config (maxRetries=3, threshold=3, initial
      // response non-empty). Now we check AFTER incrementing and BEFORE the
      // break: if threshold reached AND there's an alternative credential
      // available, force a switch + grant an extra attempt so the new cred
      // actually gets tried.
      const shouldForceSwitchNow = (
        (EMPTY_STREAM_SWITCH_THRESHOLD > 0 && consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD) ||
        (switchThreshold > 0 && consecutiveCredFailures >= switchThreshold)
      );
      if (shouldForceSwitchNow) {
        // Try to switch — if a new cred is available, grant an extra attempt
        // and continue the loop instead of breaking.
        const failedCount = consecutiveCredFailures;
        const newCred = await auth.switchToNextCredential(triedApiKeys);
        if (newCred) {
          const reason = (EMPTY_STREAM_SWITCH_THRESHOLD > 0 && consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD)
            ? `${consecutiveEmptyStreams} consecutive empty-stream responses`
            : `${failedCount} consecutive failures`;
          console.log(
            `${reqId} credential switched (end-of-loop) after ${reason} ` +
            `(retry ${attempt}/${config.retry.maxRetries + extraAttemptsFromSwitches}): ${maskApiKey(cred.apiKey)} → ${maskApiKey(newCred.apiKey)}`,
          );
          cred = newCred;
          const newPlan = effectivePlanForCred(newCred);
          if (newPlan !== currentPlan) {
            console.log(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
            currentPlan = newPlan;
          }
          transformedObj = transformRequestBodyObj(upstreamBodyObj, {
            format: upstreamFormat,
            userId: cred.userId,
            startPlan: currentPlan === "start-plan",
            testFlags: config.testFlags,
          });
          transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;
          consecutiveCredFailures = 0;
          consecutiveEmptyStreams = 0;
          triedApiKeys.add(newCred.apiKey);
          if (extraAttemptsFromSwitches < extraAttemptsCap()) {
            extraAttemptsFromSwitches++;
          }
          // Persist the switch so the dashboard reflects the new active account.
          // This was MISSING in the end-of-loop switch block — the in-memory
          // credential was switched (so the request used the new account), but
          // the on-disk activeId still pointed at the old account. The user
          // saw "激活还是停在原来的账号上，但实际上已经用了下一个账号进行调用了".
          // Now both switch blocks (top-of-loop and end-of-loop) persist the
          // switch consistently. Non-fatal: if persistence fails, the in-memory
          // switch still works for the remainder of this request.
          try {
            const accounts = await exportAccounts();
            const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
            if (match) {
              await switchAccount(match.id);
              appendLog("info", `Auto-switched credential to "${match.label}" (${maskApiKey(newCred.apiKey)}) after ${reason}`);
            }
          } catch (e) {
            console.log(`${reqId} could not persist credential switch: ${(e as Error).message}`);
          }
          try { upstreamResp.body?.cancel(); } catch {}
          continue; // skip the break, give the new cred a chance
        }
        // No alternative credential — fall through to break
      }

      // Still a retryable status — if this was the last attempt, keep the
      // response body intact (don't cancel) so we can return it to the
      // client with a body. Previously the code cancelled the body then
      // refetched — but that refetch reused the consumed Request object
      // and always failed. Keeping the body is simpler and correct.
      if (attempt === config.retry.maxRetries + extraAttemptsFromSwitches) {
        console.log(`${reqId} all ${config.retry.maxRetries + extraAttemptsFromSwitches} retries exhausted, returning ${upstreamResp.status}`);
        break;
      }

      // More retries left — cancel the body before looping
      try { upstreamResp.body?.cancel(); } catch {}
    }
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  // Diagnostic: when the upstream rejects with 4xx (especially 3001 "parameter
  // error" from GLM), record a debug dump in memory so the user can inspect
  // the exact transformed body via /admin/api/debug-dumps without writing
  // files to disk. The old code wrote to <cwd>/zcode-proxy-debug-*.json
  // which leaked user conversation content to disk forever.
  if (!upstreamResp.ok && upstreamResp.status >= 400 && upstreamResp.status < 500) {
    const errPeek = await upstreamResp.text().catch(() => "");
    console.log(`${reqId} upstream ${upstreamResp.status} ${errPeek.slice(0, 200)}`);
    console.log(`${reqId} transformed request summary: ${summarizeBody(transformedObj ?? parsedBody)}`);
    // Also log the anthropic-beta header that was actually sent upstream —
    // mismatched beta flags vs body is a common 3001 cause on ZCode gateway.
    // Reuses lastSentBeta captured during the real fetch (instead of building
    // a fresh Request just to read one header — the old code generated new
    // random UUIDs for x-request-id etc., making the logged header belong to
    // a different request than the one actually sent).
    console.log(`${reqId} anthropic-beta sent: ${lastSentBeta ?? "(none)"}`);
    if (transformedBody) {
      try {
        recordDebugDump({
          id: reqId,
          status: upstreamResp.status,
          upstreamError: errPeek.slice(0, 500),
          anthropicBeta: lastSentBeta ?? "",
          bodySummary: summarizeBody(transformedObj ?? parsedBody),
          body: transformedBody,
        });
      } catch (e) {
        console.log(`${reqId} failed to record debug dump: ${(e as Error).message}`);
      }
    }
    // Reconstruct the response with the peeked body so the passthrough below
    // still has something to send. upstreamResp.text() consumed the body.
    upstreamResp = new Response(errPeek, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  }

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
        observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null, maskApiKey(cred.apiKey));
        return translatedSseResponse(wrapStreamWithClientAbort(clientBody, activeUpstreamCtrl));
      }
      return await translatedResponsesBatchResponse(
        clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt,
        (parsedBody as OpenAIResponseRequest | undefined)?.previous_response_id,
        (parsedBody as OpenAIResponseRequest | undefined)?.input,
        maskApiKey(cred.apiKey),
      );
    }
    // Chat Completions translation: use the original SSE / batch translators.
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null, maskApiKey(cred.apiKey));
      return translatedSseResponse(wrapStreamWithClientAbort(clientBody, activeUpstreamCtrl));
    }
    return await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt, maskApiKey(cred.apiKey));
  }

  if (isSSE && upstreamResp.body) {
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"), maskApiKey(cred.apiKey));
    return passthroughResponse(upstreamResp, wrapStreamWithClientAbort(clientBody, activeUpstreamCtrl));
  }

  // Non-streaming anthropic passthrough — try to extract usage from the response
  // body for stats. We read the body once, parse usage, then reconstruct the
  // Response for passthrough. (Response.clone() doesn't work reliably with all
  // mock implementations, so we read-once-and-rebuild instead.)
  let passthroughInputTokens = 0;
  let passthroughOutputTokens = 0;
  let passthroughBody: ReadableStream<Uint8Array> | string | null = null;
  const ct = upstreamResp.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && upstreamResp.body) {
    try {
      const raw = await upstreamResp.text();
      passthroughBody = raw;
      const usage = JSON.parse(raw)?.usage;
      if (usage) {
        passthroughInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
        passthroughOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      }
    } catch { /* non-JSON or parse error — leave as 0, fall back to original body */ }
  }
  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, passthroughOutputTokens, 0, 0, false, passthroughInputTokens, maskApiKey(cred.apiKey));
  // Reconstruct the response with the read body so passthrough still has content
  if (passthroughBody !== null) {
    return new Response(passthroughBody, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  }
  return passthroughResponse(upstreamResp);
}

/** Read the request body as a string, returning undefined for empty bodies. */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024; // 32 MB hard cap — blocks OOM attacks

async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  // vceshi0.0.8+: enforce a hard body size cap BEFORE reading, so a malicious
  // or buggy client sending a 1GB JSON body can't OOM the proxy. 32MB is
  // generous for typical LLM workloads (long Codex history + tool results
  // rarely exceed 1MB) while still blocking the abuse vector. Returns 413
  // by throwing — caller catches and converts to errorResponse.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error(`Request body too large: ${n} bytes (max ${MAX_REQUEST_BODY_BYTES})`), { httpStatus: 413, errorType: "request_too_large" });
    }
  }
  // Read with a streaming byte cap as a defense-in-depth — Content-Length
  // could be missing or lying. We accumulate the text but abort if the
  // accumulated size exceeds the cap.
  const reader = req.body?.getReader();
  if (!reader) {
    // No body — fall back to req.text() for compatibility with empty bodies.
    const text = await req.text();
    return text.length === 0 ? undefined : text;
  }
  const decoder = new TextDecoder();
  let acc = "";
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      try { await reader.cancel(); } catch {}
      throw Object.assign(new Error(`Request body exceeded ${MAX_REQUEST_BODY_BYTES} bytes while reading`), { httpStatus: 413, errorType: "request_too_large" });
    }
    acc += decoder.decode(value, { stream: true });
  }
  acc += decoder.decode(); // flush trailing bytes
  return acc.length === 0 ? undefined : acc;
}

/**
 * Count `thinking` / `redacted_thinking` content blocks across all messages.
 * Used for diagnostic logging so users can verify the strip-thinking-blocks
 * transform actually fired.
 */
function countThinkingBlocks(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as Record<string, unknown>).type;
        if (t === "thinking" || t === "redacted_thinking") count++;
      }
    }
  }
  return count;
}

/**
 * Count `tool_result` blocks that carry a `cache_control` field. These get
 * stripped by sanitizeContentBlocks() because ZCode's start-plan gateway
 * rejects them with 3001. Used for diagnostic logging.
 */
function countToolResultCacheControl(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && b.cache_control !== undefined) count++;
      }
    }
  }
  return count;
}

/**
 * Build a one-line summary of the transformed request body for diagnostic
 * logging on upstream 4xx. Shows top-level fields that GLM commonly rejects
 * (thinking, context_management, output_config), the message role/content-type
 * sequence (so role-alternation issues are visible), and the system block count.
 *
 * The full body can be 90KB+; this summary is <500 chars and surfaces exactly
 * the fields that cause GLM 3001 "parameter error".
 */
function summarizeBody(body: unknown): string {
  if (!body || typeof body !== "object") return "(empty)";
  const b = body as Record<string, unknown>;
  const parts: string[] = [];

  // Top-level fields GLM cares about
  if (b.model) parts.push(`model=${b.model}`);
  parts.push(`thinking=${JSON.stringify(b.thinking)}`);
  if (b.context_management) parts.push("context_management=present");
  if (b.output_config) parts.push("output_config=present");
  if (b.metadata) parts.push(`metadata=${JSON.stringify(b.metadata).slice(0, 80)}`);

  // Messages — role + content block types per message, with cache_control flags
  // so we can see if cache_control is landing on tool_result blocks (which
  // triggers ZCode gateway 3001).
  const messages = b.messages;
  if (Array.isArray(messages)) {
    const msgSummary = messages.map((m: unknown, i: number) => {
      if (!m || typeof m !== "object") return `[${i}]?`;
      const msg = m as Record<string, unknown>;
      const role = msg.role ?? "?";
      const content = msg.content;
      if (typeof content === "string") return `[${i}]${role}/str`;
      if (!Array.isArray(content)) return `[${i}]${role}/?`;
      const types = content.map((c: unknown) => {
        if (!c || typeof c !== "object") return "?";
        const blk = c as Record<string, unknown>;
        const t = blk.type ?? "?";
        // Annotate cache_control presence so tool_result+cache_control is visible
        const cc = blk.cache_control ? "+cc" : "";
        // For tool_result blocks, show content format (str vs arr) and is_error
        // presence — these are common 3001 triggers on ZCode gateway.
        let suffix = "";
        if (t === "tool_result") {
          if (typeof blk.content === "string") suffix = "/str";
          else if (Array.isArray(blk.content)) suffix = "/arr";
          if ("is_error" in blk) suffix += "/+err";
        }
        return `${t}${cc}${suffix}`;
      });
      return `[${i}]${role}/{${types.join(",")}}`;
    });
    parts.push(`msgs[${msgSummary.join(",")}]`);
  }

  // System block count (relocation may have changed it)
  if (Array.isArray(b.system)) {
    parts.push(`system=${b.system.length} blocks`);
  } else if (typeof b.system === "string") {
    parts.push("system=string");
  }

  // Tool count
  if (Array.isArray(b.tools)) {
    parts.push(`tools=${b.tools.length}`);
  }

  return parts.join(" | ");
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
  credKey?: string,
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
  // vceshi0.0.6+: capture input tokens from translated OpenAI response usage
  const inTok = openaiResp.usage?.prompt_tokens ?? 0;
  const outTok = openaiResp.usage?.completion_tokens ?? 0;

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

    if (clientAcceptsGzip(clientReq)) {
      respHeaders.set("content-encoding", "gzip");
      printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey);
      // vceshi0.0.8+: use level=1 instead of the default (6). level 1 is ~5x
      // faster for typical 50-200KB JSON responses while only marginally
      // larger output (~10% worse compression). For a chat-completions proxy
      // where the client is local and bandwidth is not the bottleneck, the
      // event-loop savings dominate. If you need max compression, switch to
      // a worker thread.
      return new Response(Bun.gzipSync(payload, { level: 1 }), {
        status: upstream.status,
        headers: respHeaders,
      });
    }
  printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey);
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
  credKey?: string,
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
  // vceshi0.0.6+: capture input/output tokens from translated Responses API usage
  const inTok = responsesResp.usage?.input_tokens ?? 0;
  const outTok = responsesResp.usage?.output_tokens ?? 0;

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey);
    return new Response(Bun.gzipSync(payload, { level: 1 }), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey);
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

/**
 * Wrap a ReadableStream so that when the downstream client cancels reading
 * (e.g. network drop, IDE closed, user pressed Ctrl+C in their CLI), the
 * provided AbortController is aborted — which releases the upstream socket
 * immediately instead of letting it run until the 10-minute stream timeout.
 *
 * vceshi0.0.8+: previously the upstream AbortController was only tied to a
 * wall-clock timeout, NOT to the client's read state. A client disconnect
 * left the upstream socket open for up to 10 minutes per request, and
 * repeated disconnects under load would exhaust file descriptors.
 */
function wrapStreamWithClientAbort<T>(
  body: ReadableStream<T>,
  ctrl: AbortController | null,
): ReadableStream<T> {
  if (!ctrl) return body; // no upstream ctrl to abort (e.g. synthetic response)
  const reader = body.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // Upstream errored — propagate to client.
        controller.error(err);
      }
    },
    cancel(reason) {
      // Client disconnected — abort the upstream fetch to free the socket.
      try { ctrl.abort(); } catch {}
      try { reader.cancel(reason); } catch {}
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

/**
 * Shell-glob style matcher supporting `*` (any chars) and `?` (single char).
 * Case-insensitive — model ids often differ only in case ("GLM-5" vs "glm-5").
 * Implemented as a non-backtracking DP so a pathological pattern like
 * "a*****b" against "aaaaaa...a" won't blow up.
 *
 * Examples:
 *   globMatch("glm-5*", "glm-5.1")      // true
 *   globMatch("glm-5?", "glm-5.1")      // true
 *   globMatch("glm-5", "glm-5")         // true (exact match)
 *   globMatch("glm-5", "glm-5.1")       // false (no wildcard)
 */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return false;
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  // Fast paths
  if (p === "*") return true;
  if (!p.includes("*") && !p.includes("?")) return p === v;

  // DP: dp[i] = true if v[0..i) matches the part of pattern processed so far.
  // Use Uint8Array (1 byte per cell) instead of Array<boolean> — slightly
  // less memory, faster to allocate (no .fill call needed since 0 is falsy).
  const dp = new Uint8Array(v.length + 1);
  dp[0] = 1;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    if (ch === "*") {
      // `*` matches zero or more chars: dp[j] = dp[j] || dp[j-1]
      for (let j = 1; j <= v.length; j++) dp[j] = dp[j]! || dp[j - 1]! ? 1 : 0;
    } else {
      // Single char (or `?`): must match exactly one char, shift right-to-left.
      for (let j = v.length; j >= 1; j--) {
        dp[j] = dp[j - 1]! && (ch === "?" || ch === v[j - 1]) ? 1 : 0;
      }
      dp[0] = 0; // any non-* char requires at least one input char
    }
  }
  return dp[v.length] === 1;
}

/**
 * Check if a model id is a known GLM model OR a plausible GLM variant (starts with "glm-").
 */
function isKnownGlmModel(model: string): boolean {
  if (!model) return false;
  if (model.startsWith("glm-")) return true;
  return knownGlmModelSet.has(model);
}

const knownGlmModelSet = new Set(listModelIds());

/**
 * Look up a model rewrite in the configured modelMappings.
 * Case-insensitive exact match on `from` (mappings are stored lowercased).
 * Returns the target model id, or undefined if no mapping matches.
 */
function lookupModelMapping(clientModel: string, mappings: { from: string; to: string }[] | undefined): string | undefined {
  if (!mappings || mappings.length === 0) return undefined;
  const lower = clientModel.toLowerCase();
  return mappings.find((m) => m.from === lower)?.to;
}

/** Translate a client request body object to Anthropic JSON. Returns error Response on failure. */
function translateClientBodyObj(parsed: unknown, format: Format, opts?: { forceThinkingModels?: string[] }): Response | unknown {
  if (parsed === undefined || parsed === null) {
    return errorResponse(400, "translation_failed", `${format} request body is empty; cannot translate.`);
  }
  try {
    if (format === "openai-responses") {
      return translateRequestResponsesToAnthropic(parsed as OpenAIResponseRequest, opts?.forceThinkingModels ? { forceThinkingModels: opts.forceThinkingModels } : undefined);
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
  inputTokens: number = 0,
  credKey?: string,
): void {
  printHeader();
  const ts = new Date(started).toISOString().slice(11, 19);
  const tag = format === "anthropic" ? "ANT" : format === "openai-responses" ? "RSP" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const inTok = inputTokens > 0 ? String(inputTokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | in:${inTok.padStart(5)} out:${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
  );
  // Record stats for the admin dashboard
  recordStat({
    id: reqId,
    time: ts,
    model: meta.model,
    status,
    ttfb: String(headersAt - started),
    tokens: String(tokens),
    inputTokens: String(inputTokens),
    credentialKey: credKey,
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
  credKey?: string,
): void {
  const compressed = contentEncoding !== null;
  let tokens = 0;
  let inputTokens = 0;
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
        if (j.usage?.completion_tokens) { tokens = j.usage.completion_tokens; }
        if (j.usage?.output_tokens) { tokens = j.usage.output_tokens; }
        // vceshi0.0.6+: capture input tokens from upstream usage
        if (j.usage?.prompt_tokens) { inputTokens = j.usage.prompt_tokens; }
        if (j.usage?.input_tokens) { inputTokens = j.usage.input_tokens; }
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
        if (j.type === "response.completed" && j.response?.usage) {
          if (j.response.usage.output_tokens) tokens = j.response.usage.output_tokens;
          if (j.response.usage.input_tokens) inputTokens = j.response.usage.input_tokens;
          continue;
        }
        // Anthropic message_delta carries usage (final event with stop_reason)
        if (j.type === "message_delta" && j.usage) {
          if (j.usage.output_tokens) tokens = j.usage.output_tokens;
          if (j.usage.input_tokens) inputTokens = j.usage.input_tokens;
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
    printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, tokens, avgTps, endAt, false, inputTokens, credKey);
  })().catch(() => {});
}

/**
 * Debug log the upstream response — shows EXACTLY what the upstream returned.
 *
 * Uses `resp.clone()` to read a copy of the body without consuming the
 * original — the caller's retry / passthrough logic still sees the full
 * response. Response.clone() is supported by both Bun and the Fetch spec; it
 * internally buffers the body so both the clone and original can be read.
 *
 * Logs:
 *   - HTTP status + key headers (content-type, retry-after, empty-stream flag,
 *     ratelimit headers)
 *   - Body preview: first 1000 chars (for JSON) or first 2KB (for SSE streams)
 *
 * This is the "调试日志" the user requested: see what 529 / empty 200 / captcha
 * 403 actually returned, including the error JSON body. Enabled via
 * config.logging.debug or ZCODE_PROXY_DEBUG_LOGGING=1.
 *
 * MUST never throw — all operations wrapped in try/catch.
 */
async function logUpstreamResponseDebug(reqId: string, resp: Response, _isStream: boolean): Promise<void> {
  try {
    const status = resp.status;
    const ct = resp.headers.get("content-type") ?? "";
    const ce = resp.headers.get("content-encoding") ?? "";
    const retryAfter = resp.headers.get("retry-after") ?? "";
    const emptyStream = resp.headers.get("x-zcode-empty-stream") ?? "";
    const ratelimitRemaining = resp.headers.get("anthropic-ratelimit-requests-remaining")
      ?? resp.headers.get("x-ratelimit-remaining") ?? "";

    // Header summary — always logged
    const headerParts: string[] = [`status=${status}`, `ct=${ct || "(none)"}`];
    if (ce && ce !== "identity") headerParts.push(`encoding=${ce}`);
    if (retryAfter) headerParts.push(`retry-after=${retryAfter}`);
    if (emptyStream) headerParts.push(`empty-stream=${emptyStream}`);
    if (ratelimitRemaining) headerParts.push(`ratelimit-remaining=${ratelimitRemaining}`);
    console.log(`${reqId} [debug] upstream response: ${headerParts.join(" | ")}`);

    // Body preview via clone() — doesn't consume the original response.
    // clone() buffers the body internally; both the clone and original can
    // be read independently. This is the cleanest way to inspect a Response
    // without breaking downstream passthrough.
    let clone: Response;
    try {
      clone = resp.clone();
    } catch {
      // Some Response implementations (e.g. streaming with non-cloneable
      // bodies) may reject clone() — skip body preview in that case.
      console.log(`${reqId} [debug] (body preview unavailable — response not cloneable)`);
      return;
    }

    // Read the clone's body with a timeout so a hung stream doesn't block
    // the request forever. 3s is enough to get the first SSE event or the
    // full JSON body of an error response.
    //
    // vceshi0.0.8+: previously used Promise.race([previewPromise, timeout])
    // — but when the timeout won, the previewPromise was still running in
    // the background with an open reader on `clone.body`, leaking the
    // upstream socket until the stream naturally ended (could be up to
    // 10 minutes for SSE). Now we use an AbortController: when the timeout
    // fires, we cancel the reader explicitly, which releases the underlying
    // socket immediately.
    const preview = await new Promise<string>(async (resolve) => {
      if (!clone.body) { resolve("(no body)"); return; }
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let settled = false;
      const finish = (val: string) => {
        if (settled) return;
        settled = true;
        try { reader.cancel(); } catch { /* already closed */ }
        resolve(val);
      };
      // Timeout — cancels the reader and resolves with what we have so far.
      const timer = setTimeout(() => finish(acc + "(read timeout after 3s)"), 3000);
      try {
        const deadline = Date.now() + 3000;
        while (acc.length < 2048 && Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          // For SSE: stop after first complete event (enough to diagnose)
          if (ct.includes("text/event-stream") && acc.includes("\n\n") && acc.length > 50) break;
          // For JSON: stop when we likely have the full body (small error responses)
          if (ct.includes("application/json") && acc.length > 0 && acc.trim().endsWith("}")) break;
        }
        clearTimeout(timer);
        finish(acc);
      } catch {
        clearTimeout(timer);
        finish(acc + "(body read failed)");
      }
    });

    const trimmed = preview.length > 1000
      ? preview.slice(0, 1000) + `...(truncated, total ${preview.length} chars)`
      : preview;
    console.log(`${reqId} [debug] body preview (${preview.length} chars): ${trimmed || "(empty body)"}`);
  } catch (err) {
    console.log(`${reqId} [debug] failed to log response: ${(err as Error).message}`);
  }
}
