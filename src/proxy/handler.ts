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
import type { Format, OpenAIResponseRequest } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamRequest } from "./upstream.js";
import { getCaptchaToken, RETRY_HEADERS } from "./captcha.js";
import { transformRequestBodyObj } from "./body-transformer.js";
import { detectSseErrorAndConvert } from "./sse-error-detector.js";
import { anthropicSseToBatchMessage } from "./sse-to-batch.js";
import { anthropicSseToResponsesSse } from "../translator/anthropic-to-responses.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import { pickProxy, markProxyFailed, getMaxRotations, getCurrentWorkingProxy, setCurrentWorkingProxy } from "./proxy-pool.js";
import { wrapFetchWithSocksBridge } from "./proxied-fetch.js";
import { recordDebugDump, appendLog } from "../admin/api.js";
import { sleep } from "../utils/sleep.js";
import { exportAccounts, switchAccount, maskApiKey, credentialStatsKey } from "../auth/store.js";
import { recordHeaders } from "../utils/header-debug.js";
import { runtimeError } from "../utils/log.js";
import { RETRY as RETRY_CONST, PROXY_POOL as PROXY_POOL_CONST } from "../utils/constants.js";
import { computeRetryDelayMs, normalizeTimerMs } from "./retry.js";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readBody,
  setRequestBodyIdleTimeoutForTesting,
} from "./request-body.js";
import {
  countThinkingBlocks,
  countToolResultCacheControl,
  stripUndefinedStringFields,
  summarizeBody,
} from "./request-diagnostics.js";
import {
  globMatch,
  isKnownGlmModel,
  lookupModelMapping,
  peekParsedBody,
} from "./model-routing.js";
import { withSseHeartbeat } from "./sse-heartbeat.js";
import {
  createStatsTransform,
  observeStatsStream,
  printRow,
  proxyLog,
  shouldEmitProxyLog,
  type RequestMeta,
} from "./stats.js";
import { checkWafBlock } from "./waf.js";
import { logUpstreamResponseDebug } from "./upstream-debug.js";
import { translateClientBodyObj } from "./request-translation.js";
import { nextReqId, startPlanCaptchaPreflightEnabled } from "./runtime-options.js";
import {
  errorResponse,
  passthroughResponse,
  sseToBatchBodyLimitBytes,
  translatedBatchResponse,
  translatedResponsesBatchResponse,
  translatedSseResponse,
} from "./translated-response.js";
import {
  isCompressedContentEncoding,
  readResponseTextLimited,
  readResponseTextPreview,
  splitResponseForPreview,
  utf8ByteLength,
  wrapResponseBodyWithUpstreamTimeout,
  type ResponseTextPreview,
  type ResponseTextPreviewOptions,
} from "./response-body.js";

export { computeRetryDelayMs, parseRetryAfterMs } from "./retry.js";
export { checkWafBlock } from "./waf.js";
export { globMatch } from "./model-routing.js";
export { errorResponse } from "./translated-response.js";
export { startPlanCaptchaPreflightEnabled } from "./runtime-options.js";

function responsesCustomToolNames(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const tools = (body as OpenAIResponseRequest).tools;
  if (!Array.isArray(tools)) return undefined;
  const names = tools
    .filter(tool => tool?.type === "custom" && typeof tool.name === "string" && tool.name.length > 0)
    .map(tool => tool.name!);
  return names.length > 0 ? names : undefined;
}

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override captcha solving in focused request-flow tests. */
  captchaTokenProvider?: typeof getCaptchaToken;
  /**
   * Resolve the TCP-remote client IP for a request. In production this is
   * wired to Bun's `server.requestIP(req)?.address`, which reads the real
   * socket peer address and CANNOT be spoofed by headers. When omitted
   * (e.g., in tests), the proxy path falls back to X-Forwarded-For ONLY
   * when `config.server.trustProxy` is true, otherwise to the empty string.
   *
   * vceshi0.0.8+: previously the sessionCache fingerprint always read XFF
   * without any trust gate, which meant any client could spoof XFF to
   * share/pollute another user's upstream session ID. Now we use the
   * socket address by default and only fall back to XFF when explicitly
   * opted in.
   */
  resolveClientIp?: (req: Request) => string | undefined;
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
/**
 * Default upstream timeout constants. The stream timeout is longer than
 * the batch timeout because LLM streams can legitimately run for many
 * minutes on long reasoning chains.
 *
 * These are DEFAULTS — operators can override via
 * `config.server.upstreamTimeoutMs` (a single value applied to both
 * stream and batch paths). When the config value is set (non-zero), it
 * takes precedence over these constants. When unset (0 or undefined),
 * the constants are used as-is. This lets operators tighten the timeout
 * for fast networks or loosen it for very long context windows without
 * recompiling.
 *
 * vceshi0.0.8+ bugfix: previously these constants were hardcoded and the
 * `config.server.upstreamTimeoutMs` field was parsed by the loader but
 * never read by the handler — the config was effectively dead. Now the
 * handler reads the config value and falls back to these defaults.
 */
const DEFAULT_UPSTREAM_TIMEOUT_STREAM_MS = 10 * 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_BATCH_MS = 5 * 60_000;
const ERROR_RESPONSE_PREVIEW_BYTES = 64 * 1024;
const PASSTHROUGH_USAGE_PREVIEW_BYTES = 2 * 1024 * 1024;

export function _setRequestBodyIdleTimeoutForTesting(timeoutMs?: number): void {
  setRequestBodyIdleTimeoutForTesting(timeoutMs);
}

export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  // wrapFetchWithSocksBridge transparently routes SOCKS proxies (socks4://,
  // socks4a://, socks5://, socks5h://) through a local HTTP-CONNECT→SOCKS
  // bridge. Bun's native fetch only supports HTTP/HTTPS proxies and would
  // otherwise throw `UnsupportedProxyProtocol` for SOCKS URLs — breaking
  // both the per-account `cred.proxy` and the global proxy pool entries
  // that use a SOCKS scheme. HTTP/HTTPS proxies and direct connections
  // pass through unchanged. The injected `opts.fetchImpl` (used by tests)
  // is wrapped so mock fetches still receive the bridge URL for SOCKS
  // proxies (and the original proxy URL for HTTP proxies).
  const fetchImpl = wrapFetchWithSocksBridge(opts.fetchImpl ?? fetch);
  const started = Date.now();
  const reqId = nextReqId();

  // G1: Request entry log — the FIRST log line for every request, appearing
  // before any routing/transform/upstream log. Without this, the first log
  // for a request appears at the routing stage, making it impossible to
  // correlate "how long did the request wait before routing?" or "which
  // reqId corresponds to this client request?".
  const clientPath = new URL(clientReq.url).pathname;
  const clientMethod = clientReq.method;
  proxyLog(`${reqId} >>> ${clientMethod} ${clientPath} (${format})`);

  // Debug logging flag — when true, logs the full upstream response details
  // (status + key headers + body preview) for every request. Enabled via
  // config.logging.debug OR env var ZCODE_PROXY_DEBUG_LOGGING=1. This is the
  // "调试日志" the user requested: see exactly what 529 / empty 200 / etc.
  // the upstream returns, including the error JSON body.
  const debugLoggingEnabled = config.logging?.debug === true
    || process.env.ZCODE_PROXY_DEBUG_LOGGING === "1";

  let body: string | undefined;
  try {
    body = await readBody(clientReq, config.server.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      const meta: RequestMeta = { model: "-", stream: false };
      printRow(reqId, format, meta, 413, started, Date.now(), 0, 0, 0);
      return errorResponse(413, "request_body_too_large", err.message);
    }
    if (err instanceof RequestBodyTimeoutError) {
      const meta: RequestMeta = { model: "-", stream: false };
      printRow(reqId, format, meta, 408, started, Date.now(), 0, 0, 0);
      return errorResponse(408, "request_timeout", err.message);
    }
    throw err;
  }

  // G7: Log actual body size (more accurate than Content-Length header, which
  // may be absent for chunked transfers or inaccurate for compressed bodies).
  if (body && body.length > 0) {
    const bodyBytes = utf8ByteLength(body);
    const sizeKB = (bodyBytes / 1024).toFixed(1);
    proxyLog(`${reqId} body size: ${sizeKB}KB (${bodyBytes} bytes)`);
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

  // Strip "[undefined]" string values from the parsed body.
  //
  // Some clients (notably Cherry Studio) serialize JavaScript `undefined`
  // values as the literal STRING "[undefined]" instead of omitting the field.
  // JSON.parse then turns these into string values, not undefined — so they
  // pass through to z.ai as actual request fields like:
  //   "temperature": "[undefined]"
  //   "system": "[undefined]"
  //   "tools": "[undefined]"
  //
  // These garbage fields are a strong WAF fingerprint — no real client
  // would ever send them. z.ai's WAF scores requests containing these as
  // script traffic and starts blocking. We recursively strip any field
  // whose value is exactly the string "[undefined]".
  if (parsedBody && typeof parsedBody === "object") {
    const removed = stripUndefinedStringFields(parsedBody as Record<string, unknown>);
    if (removed > 0) {
      proxyLog(`${reqId} stripped ${removed} "[undefined]" field(s) from request body`);
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
    proxyLog(`${reqId} routing rule matched: ${matchedRule.pattern} → provider=${matchedRule.provider}${matchedRule.endpoint ? `, endpoint=${matchedRule.endpoint}` : ""}`);
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
        proxyLog(`${reqId} model mapping: ${clientModel} → ${mapped} (configured)`);
        bodyObj.model = mapped;
        meta.model = mapped;
      } else if (!isKnownGlmModel(clientModel)) {
        const fallback = config.defaultModel || "glm-4.6";
        proxyLog(`${reqId} model fallback: ${clientModel} → ${fallback} (non-GLM model not accepted upstream)`);
        bodyObj.model = fallback;
        meta.model = fallback;
      }
    }
  }

  // =====================================================================
  //  FORMAT CONVERSION ORCHESTRATION (Claude Code + Codex → ZCode upstream)
  // =====================================================================
  //  Two client paths converge here before forwarding to z.ai upstream:
  //
  //    Claude Code (anthropic)  ─→  NO translation needed (already Anthropic)
  //                                 ↓
  //                                 body-transformer.alignZCodeRequestFormat
  //                                 ↓
  //                                 upstream
  //
  //    Codex      (responses)  ─→  responses-to-anthropic.translateRequest...
  //                                 ↓
  //                                 body-transformer.alignZCodeRequestFormat
  //                                 ↓
  //                                 upstream
  //
  //    OpenAI     (openai)     ─→  openai-to-anthropic.translateRequest...
  //                                 ↓
  //                                 body-transformer.alignZCodeRequestFormat
  //                                 ↓
  //                                 upstream
  //
  //  Both translators + alignZCodeRequestFormat are MARKED as format conversion
  //  boundaries — see the doc comments in those files. Do NOT casually modify
  //  them; run the alignment test scripts first if you must.
  //
  //  Verification scripts:
  //    /home/z/my-project/scripts/test_alignment.ts            (Claude Code)
  //    /home/z/my-project/scripts/test_responses_alignment.ts  (Codex)
  // =====================================================================
  let upstreamBodyObj: unknown = parsedBody;
  if (translateMode) {
    const forceThinkingModels = format === "openai-responses"
      ? config.responsesThinking?.models
      : undefined;
    const translated = translateClientBodyObj(parsedBody, format, forceThinkingModels ? { forceThinkingModels } : undefined);
    if (translated instanceof Response) return translated;
    upstreamBodyObj = translated;
  }

  // currentPlan tracks the effective plan for the CURRENT credential. The
  // credential must win over config.yaml in OAuth/store mode: if a start-plan
  // account is active but config.yaml still says coding-plan, sending it to the
  // coding endpoint (or using x-api-key instead of Authorization) can surface as
  // upstream 403/3007 errors. In API-key mode, config.plan remains authoritative
  // because the static credential object is created with a backward-compatible
  // default plan of coding-plan.
  const effectivePlanForCred = (c: Credential): "coding-plan" | "start-plan" => {
    if (auth.getMode() === "apikey") return config.plan;
    if (c.plan === "start-plan" || c.plan === "coding-plan") return c.plan;
    // Infer from JWT presence (matches store.ts inferPlan logic)
    return c.jwt ? "start-plan" : config.plan;
  };
  let currentPlan: "coding-plan" | "start-plan" = effectivePlanForCred(cred);
  const currentCredentialStatsKey = (): string => credentialStatsKey(cred);
  if (currentPlan !== config.plan) {
    proxyLog(`${reqId} plan resolved from active credential: ${config.plan} → ${currentPlan}`);
  }

  let transformedObj = transformRequestBodyObj(upstreamBodyObj, { format: upstreamFormat, userId: cred.userId, startPlan: currentPlan === "start-plan", thinkingLevel: config.thinkingLevel === "high" ? "high" : "max" });

  // v0.2.2+ PERF: cache transformed body keyed by (userId|plan|thinkingLevel).
  // On credential switch mid-retry, the transform is re-run even though
  // only `userId` (and possibly `plan`) actually changed — for coding-plan
  // switches the userId isn't even applied (applyAnthropicUserId is a no-op
  // when startPlan=false), so the transform output is IDENTICAL. Re-running
  // it on a 90KB body costs ~5-10ms each time, plus another 3-5ms for
  // JSON.stringify. Caching shaves 8-30ms off each credential switch retry.
  //
  // IMPORTANT: this does NOT touch the ZCode wire-shape transform logic
  // itself — `alignZCodeRequestFormat`, `sanitizeContentBlocks`, etc. all
  // still run; we just don't re-run them when the inputs are unchanged.
  let transformedCacheKey = `${cred.userId ?? ""}|${currentPlan}|${config.thinkingLevel ?? ""}`;
  let transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;
  // Cache the (key → { obj, body }) pair so a credential switch can
  // short-circuit when the new key matches.
  const transformedCache = new Map<string, { obj: unknown; body: string | undefined }>();
  if (transformedObj !== undefined) {
    transformedCache.set(transformedCacheKey, { obj: transformedObj, body: transformedBody });
  }
  /**
   * Re-run the transform only when (userId|plan|thinkingLevel) actually
   * changed. Returns the cached values otherwise. Safe to call after a
   * credential switch — the closure captures `upstreamBodyObj` and
   * `upstreamFormat` which never change within a single request.
   */
  const rebuildTransformedBody = (newUserId: string | undefined, newPlan: "coding-plan" | "start-plan"): void => {
    const newKey = `${newUserId ?? ""}|${newPlan}|${config.thinkingLevel ?? ""}`;
    if (newKey === transformedCacheKey) {
      // Inputs unchanged — keep existing transformedObj/transformedBody.
      return;
    }
    const cached = transformedCache.get(newKey);
    if (cached) {
      transformedObj = cached.obj;
      transformedBody = cached.body;
      transformedCacheKey = newKey;
      return;
    }
    // Cache miss — actually run the transform.
    transformedObj = transformRequestBodyObj(upstreamBodyObj, {
      format: upstreamFormat,
      userId: newUserId,
      startPlan: newPlan === "start-plan",
      thinkingLevel: config.thinkingLevel === "high" ? "high" : "max",
    });
    transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;
    transformedCacheKey = newKey;
    if (transformedObj !== undefined) {
      transformedCache.set(newKey, { obj: transformedObj, body: transformedBody });
    }
  };

  // v0.2.0.4: `stream: true` is now forced unconditionally inside
  // alignZCodeRequestFormat (body-transformer.ts) to match the real ZCode
  // desktop client's wire shape. The separate `forceStreamAnthropic` config
  // toggle has been removed — there is no longer a "respect client stream
  // preference" mode. The response path buffers SSE → batch JSON for clients
  // that originally requested non-streaming, so this is transparent to them.

  // (transformedBody is declared above, alongside the transform cache.)

  // Diagnostic: log thinking-block strip counts so users can verify the fix
  // is actually running. If the count goes from N → 0, the strip worked.
  // If N > 0 in the transformed body, something is wrong.
  if (format === "anthropic") {
    const before = countThinkingBlocks(parsedBody);
    const after = countThinkingBlocks(transformedObj);
    if (before > 0 || after > 0) {
      proxyLog(`${reqId} thinking blocks: ${before} → ${after} (stripped ${before - after})`);
    }
    // Also log cache_control-on-tool_result count changes. Current ZCode
    // alignment may keep, add, or strip these depending on whether the last
    // user message has one or multiple tool_result blocks.
    const ccBefore = countToolResultCacheControl(parsedBody);
    const ccAfter = countToolResultCacheControl(transformedObj);
    if (ccBefore > 0 || ccAfter > 0) {
      const delta = ccAfter - ccBefore;
      proxyLog(`${reqId} tool_result+cache_control: ${ccBefore} → ${ccAfter} (delta ${delta >= 0 ? "+" : ""}${delta})`);
    }
  }

  let totalCaptchaMs = 0;
  let captchaRetryHeaders: Record<string, string> | undefined;
  let hadRetryAttempt = false;

  const checkCaptchaVerifyFailed = async (resp: Response): Promise<{ failed: boolean; response: Response }> => {
    if (currentPlan !== "start-plan" || resp.status !== 403) return { failed: false, response: resp };
    try {
      const split = splitResponseForPreview(resp);
      const previewResp = split?.preview ?? resp;
      const { text } = await readResponseTextPreview(previewResp, {
        maxBytes: ERROR_RESPONSE_PREVIEW_BYTES,
        timeoutMs: 2_000,
        clone: !split,
      });
      return {
        failed: /"code"\s*:\s*3007/.test(text) || /captcha verify failed/i.test(text),
        response: split?.passthrough ?? resp,
      };
    } catch {
      return { failed: false, response: resp };
    }
  };

  const refreshCaptchaHeaders = async (solver?: "chrome"): Promise<Record<string, string>> => {
    const solved = await (opts.captchaTokenProvider ?? getCaptchaToken)(reqId, {
      appVersion: config.identity.appVersion,
      solver,
    });
    totalCaptchaMs += solved.solveMs;
    return {
      [RETRY_HEADERS.PARAM]: solved.verifyParam,
      [RETRY_HEADERS.REGION]: solved.region,
    };
  };

  type CaptchaChallengeResult = { response: Response; error?: Error; retried: boolean };

  const cancelResponseBody = async (resp: Response): Promise<void> => {
    try { await resp.body?.cancel(); } catch { /* best-effort */ }
  };

  // Factory that builds a FRESH Request object for each fetch call.
  // Request bodies are single-use — once fetch() consumes the body, the same
  // Request object cannot be passed to fetch() again (throws
  // "Request body already used"). This bit us hard on retries: the first
  // request would succeed or fail, then every retry would throw that error,
  // get caught by the catch block, and get converted to a synthetic 502 —
  // making retries completely ineffective.
  const buildUpstreamReq = (extraHeaders?: Record<string, string>) =>
    buildUpstreamRequest(
      clientReq,
      upstreamFormat,
      provider,
      cred,
      transformedBody,
      config.identity,
      currentPlan,
      extraHeaders,
      opts.resolveClientIp,
      config.server.trustProxy,
    );

  // Track the last anthropic-beta header actually sent upstream. We send the
  // fixed ZCode beta value and never pass through downstream client beta lists
  // (Claude Code sends many claude-code-* flags).
  let lastSentBeta: string | null = null;

  // === Global proxy pool integration ===
  // Resolution order (per the user spec "优先级低于单账号设置的代理"):
  //   1. cred.proxy (per-account override) — highest priority
  //   2. proxy pool (pickProxy round-robin) — fallback when no per-account proxy
  //   3. direct connection (no proxy)
  //
  // The currentRequestProxy is tracked per-request so that on a 405/WAF block
  // we can rotate to a DIFFERENT pool proxy and retry. Proxies already tried
  // in this request are kept in `triedPoolProxies` so we don't cycle back.
  let currentRequestProxy: string | undefined = undefined;
  // v0.2.2+ FIX: triedPoolProxies now uses a Map<url, triedAt> with a TTL
  // cooldown. Previously a Set accumulated across all retries in the
  // request — once a proxy was tried (even on a transient WAF blip), it was
  // excluded for ALL subsequent retries, even if it had recovered by then.
  // In the worst case (maxRotations=3, maxRetries=3) this exhausted the
  // pool and forced a direct connection that was guaranteed to fail.
  //
  // With TTL cooldown (default 60s), a proxy becomes eligible again after
  // the cooldown expires — retries have a fair chance of succeeding.
  const triedPoolProxies = new Map<string, number>();
  const isProxyInCooldown = (url: string): boolean => {
    const triedAt = triedPoolProxies.get(url);
    if (triedAt === undefined) return false;
    if (Date.now() - triedAt > PROXY_POOL_CONST.TRIED_TTL_MS) {
      triedPoolProxies.delete(url);
      return false;
    }
    return true;
  };
  const markProxyTried = (url: string): void => {
    triedPoolProxies.set(url, Date.now());
  };
  // Adapter Set view for pickProxy's excludeUrls param (filters by TTL).
  // Built fresh on each call so the cooldown check fires at lookup time.
  const triedProxySetView = (): Set<string> => {
    const s = new Set<string>();
    for (const url of triedPoolProxies.keys()) {
      if (isProxyInCooldown(url)) s.add(url);
    }
    return s;
  };

  // Fetch + SSE error detection in one shot. Used for both the initial fetch
  // AND every retry, so SSE errors hidden in 200 streams are caught on every
  // attempt — not just the first one.
  //
  // An AbortController applies an upstream timeout: 10 min for streaming
  // requests (LLM thinking traces can be long), 5 min for batch. Prevents a
  // hung upstream TCP connection from pinning a Bun worker forever.
  //
  // Per-account outbound proxy (v2.1.4.1test5+): if `cred.proxy` is set,
  // route the upstream fetch through that proxy via Bun's native
  // `{ proxy: url }` RequestInit option. We re-read `cred.proxy` on EVERY
  // call (not captured in a closure) so a credential switch mid-retry picks
  // up the new account's proxy automatically — without this, switching from
  // a proxied account to a direct one would keep using the old proxy.
  //
  // Global proxy pool (v0.2.2+): when `cred.proxy` is NOT set, we consult
  // the pool (pickProxy) for a fallback proxy. The picked proxy is stored
  // in `currentRequestProxy` so the WAF-rotation path can advance to the
  // next one on retry.
  const fetchUpstreamDetected = async (extraHeaders?: Record<string, string>, isInitialAttempt: boolean = false): Promise<Response> => {
    const req = buildUpstreamReq(extraHeaders);
    lastSentBeta = req.headers.get("anthropic-beta");

    // v0.2.0.9+: header debug logging — record the inbound client request
    // headers + the translated upstream request headers to a JSON file, so
    // the operator can diff "what the client sent" vs "what the proxy sent
    // upstream" and verify the translation pipeline has no header defects.
    //
    // Only the FIRST fetch attempt per request is recorded. Retries and
    // proxy-rotation fetches pass isInitialAttempt=false (the default),
    // so they skip this block entirely — one pair per request, no noise
    // from retries. This is the user-requested behaviour: "重试的不记录".
    //
    // v0.2.0.9: recordHeaders writes TWO files — {prefix}_inbound.json
    // (the raw client request) and {prefix}_upstream.json (the translated
    // request sent to z.ai). Pass the raw `body` (client request body as
    // received) as inboundBody so the operator can diff client body vs
    // translated body alongside the header diff.
    //
    // Fire-and-forget (recordHeaders is async, never awaited, never throws).
    if (isInitialAttempt && config.logging?.headerDebug) {
      try {
        recordHeaders(clientReq, req, reqId, format, transformedBody, body);
      } catch (e) {
        // Defensive — recordHeaders already swallows errors, but belt + suspenders.
        void e;
      }
    }

    // vceshi0.0.8+: read the operator-configured upstream timeout (if any)
    // and fall back to the hardcoded defaults. A single config value applies
    // to BOTH stream and batch paths — operators who want different stream
    // vs batch timeouts should leave this unset and rely on the defaults.
    const configuredTimeout = config.server.upstreamTimeoutMs ?? 0;
    const defaultTimeout = meta.stream ? DEFAULT_UPSTREAM_TIMEOUT_STREAM_MS : DEFAULT_UPSTREAM_TIMEOUT_BATCH_MS;
    const timeoutMs = normalizeTimerMs(configuredTimeout > 0 ? configuredTimeout : defaultTimeout, defaultTimeout);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    // Bun's native fetch accepts `{ proxy: "http://..." }` / `socks5://...`
    // Cast through `any` because the option is Bun-specific and not in the
    // standard TypeScript DOM RequestInit type.
    const fetchOpts: any = {
      ...(translateMode ? {} : { decompress: false }),
      signal: ctrl.signal,
    };
    // === Proxy resolution (v0.2.2+ global pool) ===
    // Priority: cred.proxy (per-account) > pool (sticky/round-robin) > direct.
    if (cred.proxy) {
      fetchOpts.proxy = cred.proxy;
    } else {
      // Pool consultation is best-effort: if the pool is disabled or empty,
      // pickProxy returns null and we fall through to a direct connection.
      //
      // Sticky behavior: pickProxy returns the current "working" proxy if
      // one is set (from a previous successful request), so subsequent
      // requests reuse the same proxy until it fails. On failure
      // (markProxyFailed), the sticky proxy is cleared and the next pickProxy
      // advances to a new one.
      if (!currentRequestProxy) {
        try {
          const picked = await pickProxy(triedProxySetView());
          if (picked) {
            currentRequestProxy = picked;
            markProxyTried(picked);
            // Log which proxy is being used for this request. Sticky proxies
            // (reused from a previous success) are marked accordingly.
            const sticky = getCurrentWorkingProxy() === picked;
            proxyLog(`${reqId} proxy: ${picked}${sticky ? " (sticky)" : ""}`);
          }
        } catch (e) {
          // Pool must NEVER break the request — log and fall through.
          proxyLog(`${reqId} proxy pool pick failed: ${(e as Error).message}`);
        }
      }
      if (currentRequestProxy) {
        fetchOpts.proxy = currentRequestProxy;
      }
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
    resp = wrapResponseBodyWithUpstreamTimeout(resp, ctrl, timer, timeoutMs);
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
        proxyLog(`${reqId} [verbose] upstream headers: ${JSON.stringify(headerSummary)}`);
        if (transformedBody) {
          const bodyPreview = transformedBody.length > 2000
            ? transformedBody.slice(0, 2000) + `...(truncated, total ${transformedBody.length} chars)`
            : transformedBody;
          proxyLog(`${reqId} [verbose] transformed body: ${bodyPreview}`);
        }
      } catch { /* verbose logging must never break the request */ }
    }
    if (resp.status === 200) {
      const originalStatus = resp.status;
      resp = await detectSseErrorAndConvert(resp);
      if (resp.status !== originalStatus) {
        proxyLog(`${reqId} SSE error detected in 200 stream → HTTP ${resp.status}`);
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
      const split = splitResponseForPreview(resp);
      if (split) {
        resp = split.passthrough;
        logUpstreamResponseDebug(reqId, split.preview, true);
      } else {
        logUpstreamResponseDebug(reqId, resp, false);
      }
    }
    return resp;
  };

  const retryStartPlanCaptchaChallenge = async (
    resp: Response,
    context: string,
  ): Promise<CaptchaChallengeResult> => {
    const captchaCheck = await checkCaptchaVerifyFailed(resp);
    const checkedResp = captchaCheck.response;
    if (!captchaCheck.failed) return { response: checkedResp, retried: false };

    await cancelResponseBody(checkedResp);
    proxyLog(`${reqId} start-plan captcha verify failed${context}; solving Aliyun captcha with Chrome and retrying once...`);
    hadRetryAttempt = true;
    try {
      captchaRetryHeaders = await refreshCaptchaHeaders("chrome");
      const retryResp = await fetchUpstreamDetected(captchaRetryHeaders);
      if (!startPlanCaptchaPreflightEnabled()) captchaRetryHeaders = undefined;
      const retryCheck = await checkCaptchaVerifyFailed(retryResp);
      const checkedRetryResp = retryCheck.response;
      if (retryCheck.failed) {
        await cancelResponseBody(checkedRetryResp);
        return {
          response: checkedRetryResp,
          retried: true,
          error: new Error("captcha verify failed after solving once"),
        };
      }
      return { response: checkedRetryResp, retried: true };
    } catch (err) {
      if (!startPlanCaptchaPreflightEnabled()) captchaRetryHeaders = undefined;
      return { response: checkedResp, retried: true, error: err as Error };
    }
  };

  let upstreamResp: Response;
  try {
    if (currentPlan === "start-plan" && startPlanCaptchaPreflightEnabled()) {
      proxyLog(`${reqId} start-plan captcha preflight enabled: refreshing runtime headers before model request...`);
      try {
        captchaRetryHeaders = await refreshCaptchaHeaders();
      } catch (err) {
        printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0, false, 0, currentCredentialStatsKey(), totalCaptchaMs);
        return errorResponse(503, "captcha_failed", (err as Error).message);
      }
    }
    // isInitialAttempt=true: this is the FIRST fetch for this request.
    // Header debug logging (if enabled) records inbound + upstream headers
    // here. Retries below call fetchUpstreamDetected without this flag, so
    // only the first attempt is logged.
    upstreamResp = await fetchUpstreamDetected(captchaRetryHeaders, true);
    const captchaResult = await retryStartPlanCaptchaChallenge(upstreamResp, "");
    upstreamResp = captchaResult.response;
    if (captchaResult.error) {
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
      return errorResponse(503, "captcha_failed", captchaResult.error.message);
    }
  } catch (err) {
    const errMsg = (err as Error).message ?? String(err);
    if (config.retry.maxRetries <= 0) {
      printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
      return errorResponse(502, "upstream_unreachable", errMsg);
    }
    proxyLog(`${reqId} initial upstream fetch failed: ${errMsg}; entering retry loop...`);
    upstreamResp = new Response(
      JSON.stringify({ error: { type: "upstream_unreachable", message: errMsg } }),
      {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-zcode-network-error": "1",
        },
      },
    );
  }
  let headersAt = Date.now();

  // === WAF 拦截检测 ===
  // z.ai / zcode.z.ai 用阿里云 WAF。被拦截时返回:
  //   - HTTP 405 / 403 / 200 + content-type: text/html
  //   - body 是阿里云拦截页 HTML，含 `errors.aliyun.com` 字样
  //   - server: Tengine
  //
  // 这种响应绝对不能重试 — 越撞越黑。立即返回一个明确的错误，避免
  // 进入 retry 循环让 IP 越拉越黑。
  // vceshi0.0.8+: checkWafBlock consumes the body to inspect it, and on
  // the non-WAF path returns a FRESH Response with the body reconstructed.
  // We reassign `upstreamResp` to the fresh response so all downstream
  // code (`.body.tee()`, `.text()`, `.json()`) works as if the inspection
  // never happened. Previously, the non-WAF path left `upstreamResp.body`
  // in a consumed/locked state, causing `body.tee()` to throw on rare
  // 200 + HTML upstream responses.
  const wafCheck = await checkWafBlock(upstreamResp);
  if (wafCheck.wafBlocked) {
    // === v0.2.2+ Proxy rotation on WAF block ===
    // The original behavior was: STOP all retries immediately. Hammering the
    // WAF from a blacklisted IP makes the blacklist worse.
    //
    // With the global proxy pool, we have a third option: rotate to a
    // DIFFERENT proxy and retry. The new IP may not be blacklisted. We try
    // up to `pool.config.maxRotations` (default 3) different proxies before
    // giving up. Each tried proxy is added to `triedPoolProxies` so we don't
    // cycle back to it within the same request.
    //
    // Conditions for rotation:
    //   1. We were using a pool proxy (currentRequestProxy is set AND came
    //      from the pool, not from cred.proxy — per-account proxy rotation
    //      is a separate concern and we don't touch it here).
    //   2. The pool still has untried proxies.
    //   3. We haven't exceeded maxRotations.
    //
    // If rotation is not possible (no pool, no untried proxies, or per-account
    // proxy was in use), we fall back to the original "stop & return 503" path.
    const ct = upstreamResp.headers.get("content-type") ?? "";
    runtimeError(
      `${reqId} ⚠️  ALIYUN WAF BLOCK DETECTED — status=${upstreamResp.status}, ` +
      `content-type=${ct}. Will attempt proxy rotation if pool has alternatives.`,
    );

    // Mark the current pool proxy as failed (best-effort).
    if (currentRequestProxy) {
      try { await markProxyFailed(currentRequestProxy); } catch { /* non-fatal */ }
    }

    // Try rotating through up to maxRotations different pool proxies.
    // maxRotations comes from the pool config (default 3); read it fresh
    // so a dashboard config change takes effect immediately.
    const maxRotations = await getMaxRotations().catch(() => 3);
    let rotated = false;
    if (maxRotations > 0) {
      for (let rot = 0; rot < maxRotations; rot++) {
      // If we were using a per-account proxy (cred.proxy), there's no pool
      // rotation to do — bail and surface the WAF error.
      if (cred.proxy) break;

      // Force pickProxy to skip the current proxy by clearing
      // currentRequestProxy and adding it to the tried set (already done).
      currentRequestProxy = undefined;
      let nextProxy: string | null = null;
      try {
        nextProxy = await pickProxy(triedProxySetView());
      } catch (e) {
        proxyLog(`${reqId} proxy pool rotation failed: ${(e as Error).message}`);
        break;
      }
      if (!nextProxy) {
        // No more untried proxies in the pool — give up.
        proxyLog(`${reqId} proxy pool exhausted after ${rot} rotation(s) — surfacing WAF error`);
        break;
      }
      currentRequestProxy = nextProxy;
      markProxyTried(nextProxy);
      proxyLog(`${reqId} WAF rotation ${rot + 1}/${maxRotations}: switching to proxy ${nextProxy}`);

      // Cancel the old response body before refetching.
      await cancelResponseBody(upstreamResp);

      // Refetch with the new proxy. Keep the same official header shape — no
      // captcha headers are added on start-plan.
      try {
        hadRetryAttempt = true;
        upstreamResp = await fetchUpstreamDetected();
        headersAt = Date.now();
      } catch (err) {
        proxyLog(`${reqId} WAF rotation ${rot + 1} fetch failed: ${(err as Error).message}`);
        // Network error with this proxy — try the next one.
        try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
        continue;
      }

      // Re-check the new response for WAF block. If it's still blocked,
      // loop and try the next proxy. If it's NOT a WAF block, we're done.
      const rotWafCheck = await checkWafBlock(upstreamResp);
      if (!rotWafCheck.wafBlocked) {
        const captchaResult = await retryStartPlanCaptchaChallenge(
          rotWafCheck.response,
          ` after WAF rotation ${rot + 1}`,
        );
        upstreamResp = captchaResult.response;
        if (captchaResult.error) {
          printRow(reqId, format, meta, 503, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
          return errorResponse(503, "captcha_failed", captchaResult.error.message);
        }
        if (captchaResult.retried) {
          const postCaptchaWafCheck = await checkWafBlock(upstreamResp);
          if (postCaptchaWafCheck.wafBlocked) {
            try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
            proxyLog(`${reqId} WAF rotation ${rot + 1} captcha retry was blocked on proxy ${nextProxy}`);
            continue;
          }
          upstreamResp = postCaptchaWafCheck.response;
        }
        proxyLog(`${reqId} WAF rotation ${rot + 1} succeeded — request now proceeds with proxy ${nextProxy}`);
        rotated = true;
        break;
      }
      // Still blocked — mark this proxy failed and try the next one.
      try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
      proxyLog(`${reqId} WAF rotation ${rot + 1} still blocked on proxy ${nextProxy}`);
      }
    }

    if (!rotated) {
      // All rotations failed (or none were possible). Return the WAF error.
      await cancelResponseBody(upstreamResp);
      printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
      return errorResponse(
        503,
        "waf_blocked",
        "Request blocked by Aliyun WAF (status=" + upstreamResp.status + "). " +
        "Your IP is likely blacklisted. Stop retrying immediately, change IP, and wait before retrying. " +
        "See: https://errors.aliyun.com",
      );
    }
    // Rotated successfully — fall through to normal response handling.
  } else {
    // Not a WAF block — use the reconstructed response (fresh readable body).
    upstreamResp = wafCheck.response;
  }

  if (upstreamResp.status === 401 && currentPlan === "start-plan") {
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  // Official start-plan path: the first request is sent without synthetic
  // captcha headers by default, matching the normal ZCode message path. If
  // upstream returns the explicit Aliyun 3007 JSON challenge, we solve once and
  // retry with a fresh one-shot runtime header. Operators can opt into the old
  // pre-send refresh behavior with ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT=1.

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
  //
  // === CRITICAL FIX (命令行还在继续重试 bug) ===
  // Declared OUTSIDE the retry-if block so the post-retry 503 check (which
  // lives outside the block, after the retry loop ends) can read it. Without
  // this outer scope, TypeScript would reject the reference as out-of-scope.
  let allCredentialsExhausted = false;
  const isInitialNetworkError = upstreamResp.status === 502 &&
    upstreamResp.headers.get("x-zcode-network-error") === "1";
  if (config.retry.maxRetries > 0 && (isInitialNetworkError || config.retry.retryableStatuses.includes(upstreamResp.status))) {
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

    await cancelResponseBody(upstreamResp);

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
    let extraAttemptsFromSwitches = 0;
    // === CRITICAL FIX (命令行还在继续重试 bug) ===
    // allCredentialsExhausted is declared OUTSIDE this if-block (a few lines
    // above) so the post-retry 503 check can read it. When this flag is true
    // and the retry loop exhausts, we return 503 (non-retryable) instead of
    // forwarding 529 (retryable) — tells well-behaved clients like Claude
    // Code, OpenAI SDK to STOP retrying.
    //
    // IMPORTANT: this flag is ONLY set when we actually had multiple
    // credentials to try AND all of them failed. When there's only one
    // credential (no alternatives to begin with), we DON'T set this flag —
    // the failure might be transient upstream overload, so forwarding 529
    // (retryable) is correct. Setting 503 in the single-credential case
    // would break legitimate "service overloaded, retry later" semantics.
    //
    // We track the total available credential count up front so we can
    // distinguish "no alternatives because there's only one" from "no
    // alternatives because all N have been tried".
    let totalAvailableCredentials = 1; // default: assume only the current one
    try {
      totalAvailableCredentials = await auth.getAvailableCredentialCount();
      // Edge case: getAvailableCredentialCount returns 0 if listAllCredentials
      // isn't configured. In that case, fall back to 1 (the current credential
      // is the only one we know about).
      if (totalAvailableCredentials === 0) totalAvailableCredentials = 1;
    } catch { /* ignore — fall back to 1 */ }

    // Per-request switch suppression: once the current request has already
    // proven that the configured credential set has no alternative, avoid
    // hammering the credential store and flooding the dashboard log with the
    // same message on every retry. We still refresh the count right before
    // suppressing so a credential added during a long request can be picked up.
    let loggedSingleCredentialNoAlternative = false;
    let loggedExhaustedCredentialsNoAlternative = false;
    const refreshAvailableCredentialCount = async (): Promise<void> => {
      try {
        const count = await auth.getAvailableCredentialCount();
        totalAvailableCredentials = count > 0 ? count : 1;
      } catch { /* keep the last known count */ }
    };
    const canAttemptCredentialSwitch = async (): Promise<boolean> => {
      if (totalAvailableCredentials <= 1 || triedApiKeys.size >= totalAvailableCredentials) {
        await refreshAvailableCredentialCount();
      }
      return totalAvailableCredentials > 1 && triedApiKeys.size < totalAvailableCredentials;
    };
    const logNoAlternativeCredential = (context: string): void => {
      if (totalAvailableCredentials > 1) {
        allCredentialsExhausted = true;
        if (!loggedExhaustedCredentialsNoAlternative) {
          proxyLog(
            `${reqId} ${context} but no alternative credential available ` +
            `(tried ${triedApiKeys.size} of ${totalAvailableCredentials} credential(s)). ` +
            `Will return 503 (not 529) after retries exhaust to stop client retry loops.`,
          );
          loggedExhaustedCredentialsNoAlternative = true;
        }
      } else if (!loggedSingleCredentialNoAlternative) {
        proxyLog(
          `${reqId} ${context} but no alternative credential available ` +
          `(only ${totalAvailableCredentials} credential configured). Continuing with current — ` +
          `forwarding 529 (retryable) to client since this may be transient overload.`,
        );
        loggedSingleCredentialNoAlternative = true;
      }
    };

    // v0.2.2+ FIX (infinite retry loop): hard cap on total attempts.
    // `extraAttemptsFromSwitches` increments on every credential switch,
    // so under concurrent dashboard imports / large credential pools the
    // loop could run far longer than the operator intended. Cap at
    // max(config.retry.maxRetries * 4 + 10, MAX_TOTAL_ATTEMPTS_CAP) to
    // guarantee termination in bounded time.
    const MAX_TOTAL_ATTEMPTS = Math.min(
      config.retry.maxRetries * RETRY_CONST.MAX_TOTAL_ATTEMPTS_FACTOR + RETRY_CONST.MAX_TOTAL_ATTEMPTS_FLAT,
      RETRY_CONST.MAX_TOTAL_ATTEMPTS_CAP,
    );
    const effectiveRetryLimit = (): number =>
      Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS);

    for (let attempt = 1; attempt <= effectiveRetryLimit(); attempt++) {
      // v0.2.2+ safety: if we've hit the hard cap, force-exit the loop
      // immediately. This catches the edge case where extraAttemptsFromSwitches
      // grew faster than the cap check (the for-condition only re-evaluates
      // at the top of each iteration).
      if (attempt > MAX_TOTAL_ATTEMPTS) {
        proxyLog(`${reqId} hit MAX_TOTAL_ATTEMPTS cap (${MAX_TOTAL_ATTEMPTS}) — stopping retry loop`);
        allCredentialsExhausted = totalAvailableCredentials > 1;
        break;
      }
      // Respect Retry-After header. Per RFC 7231 §7.1.3 the value can be:
      //   - delta-seconds (e.g. "120"), OR
      //   - HTTP-date   (e.g. "Wed, 21 Oct 2025 07:28:00 GMT")
      // The old code only parsed delta-seconds and silently ignored HTTP-date
      // values — meaning the proxy would retry sooner than the upstream
      // explicitly requested. Keep the operator's maxDelayMs as a hard cap:
      // a malicious or broken upstream can legally send Retry-After: 3600,
      // but holding a client request open for an hour looks like a hung proxy.
      const retryAfter = upstreamResp.headers.get("retry-after");
      const delayMs = computeRetryDelayMs(config.retry, attempt, retryAfter);

      proxyLog(
        `${reqId} upstream returned ${upstreamResp.status}, retry ${attempt}/${effectiveRetryLimit()} in ${delayMs}ms...`,
      );
      hadRetryAttempt = true;
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
        const newCred = await canAttemptCredentialSwitch()
          ? await auth.switchToNextCredential(triedApiKeys)
          : null;
        if (newCred) {
          const reason = shouldSwitchForEmptyStream
            ? `${consecutiveEmptyStreams} consecutive empty-stream responses`
            : `${failedCount} consecutive failures`;
          proxyLog(
            `${reqId} credential switched after ${reason} ` +
            `(retry ${attempt}/${effectiveRetryLimit()}): ${maskApiKey(cred.apiKey)} → ${maskApiKey(newCred.apiKey)}`,
          );
          cred = newCred;
          // Sync currentPlan to the new credential's plan (vceshi0.0.5+ fix for
          // cross-plan credential switch bug). Without this, switching from a
          // coding-plan cred to a start-plan cred (or vice versa) would keep
          // using the old plan's upstream URL, auth headers, captcha logic —
          // guaranteeing the retried request fails the same way.
          const newPlan = effectivePlanForCred(newCred);
          if (newPlan !== currentPlan) {
            proxyLog(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
            currentPlan = newPlan;
          }
          // v0.2.2+ PERF: rebuild the transformed body only if the
          // (userId|plan|thinkingLevel) key actually changed. For coding-plan
          // → coding-plan switches, the userId isn't applied (startPlan=false
          // makes applyAnthropicUserId a no-op) and the transform output is
          // IDENTICAL — re-running it on a 90KB body wastes 5-10ms each time.
          rebuildTransformedBody(newCred.userId, currentPlan);
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
          if (shouldSwitchForEmptyStream) {
            extraAttemptsFromSwitches++;
          }
          // Persist the switch so the dashboard reflects the new active account.
          // Non-fatal: if persistence fails, the in-memory switch still works
          // for the remainder of this request.
          //
          // === CRITICAL FIX (账号全没 bug) ===
          // switchAccount now returns `null` when the store can't be read
          // (transient AV lock etc.) instead of silently writing an empty
          // store. Handle all three return values explicitly so we don't
          // log a misleading "Auto-switched" message when the write was
          // actually skipped.
          try {
            const accounts = await exportAccounts();
            if (accounts.length === 0) {
              // Store is empty — don't even try switchAccount (it would
              // return false anyway). This is expected when the user has
              // cleared credentials; the in-memory switch above still
              // works for the remainder of this request.
              proxyLog(`${reqId} credential store is empty, skipping switchAccount persist`);
            } else {
              const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
              if (match) {
                const persistResult = await switchAccount(match.id);
                if (persistResult === true) {
                  appendLog("info", `Auto-switched credential to "${match.label}" (${maskApiKey(newCred.apiKey)}) after ${reason}`);
                } else if (persistResult === null) {
                  // Transient store read failure — the in-memory switch still
                  // works for this request. Don't log an error (it's not
                  // actionable), just a debug note.
                  proxyLog(`${reqId} could not persist credential switch: store temporarily unreadable, will retry on next switch`);
                } else {
                  // false: account not in store (race condition — another
                  // process removed it between exportAccounts and switchAccount)
                  proxyLog(`${reqId} could not persist credential switch: account ${match.id} not found in store (race condition)`);
                }
              }
            }
          } catch (e) {
            proxyLog(`${reqId} could not persist credential switch: ${(e as Error).message}`);
          }
        } else {
          // No alternative credential available (or all alternatives already
          // tried in this request). Mark/log through the shared helper so this
          // request emits the diagnostic once instead of once per retry.
          logNoAlternativeCredential("credential switch threshold reached");
        }
      }

      try {
        // Build a FRESH Request for each retry — never reuse upstreamReq.
        // fetchUpstreamDetected also runs SSE error detection so 200 streams
        // with hidden errors get caught on every attempt.
        //
        // start-plan captcha alignment: by default retries are sent without
        // captcha headers and only solve on an explicit 3007 challenge. If the
        // operator enables preflight, refresh before every retry because Aliyun
        // verify params are one-shot and cannot be reused.
        if (currentPlan === "start-plan" && startPlanCaptchaPreflightEnabled()) {
          captchaRetryHeaders = await refreshCaptchaHeaders();
        } else {
          captchaRetryHeaders = undefined;
        }
        upstreamResp = await fetchUpstreamDetected(captchaRetryHeaders);
        const retryCaptchaResult = await retryStartPlanCaptchaChallenge(upstreamResp, ` on retry ${attempt}`);
        upstreamResp = retryCaptchaResult.response;
        if (retryCaptchaResult.error) {
          printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
          return errorResponse(503, "captcha_failed", retryCaptchaResult.error.message);
        }
        headersAt = Date.now();

        // vceshi0.0.8+: also check for WAF block on retry — if the IP got
        // blacklisted DURING the retry loop, we need to bail immediately
        // (same rationale as the pre-loop check; hammering the WAF makes
        // the blacklist worse). checkWafBlock returns a fresh response on
        // the non-WAF path so downstream code can read the body normally.
        //
        // v0.2.2+: with the global proxy pool, we now attempt proxy rotation
        // before giving up (same logic as the pre-loop WAF handler). If a
        // different pool proxy succeeds, the rotated response replaces the
        // blocked one and the retry loop continues normally.
        const retryWafCheck = await checkWafBlock(upstreamResp);
        if (retryWafCheck.wafBlocked) {
          const ct = upstreamResp.headers.get("content-type") ?? "";
          runtimeError(
            `${reqId} ⚠️  ALIYUN WAF BLOCK DETECTED on retry ${attempt} — status=${upstreamResp.status}, ` +
            `content-type=${ct}. Attempting proxy rotation...`,
          );

          // Mark current pool proxy failed (best-effort).
          if (currentRequestProxy) {
            try { await markProxyFailed(currentRequestProxy); } catch { /* non-fatal */ }
          }

          // Try up to maxRotations different pool proxies (from pool config).
          let retryRotated = false;
          if (!cred.proxy) { // only rotate when using the pool, not per-account proxy
            const retryMaxRotations = await getMaxRotations().catch(() => 3);
            if (retryMaxRotations > 0) {
              for (let rot = 0; rot < retryMaxRotations; rot++) {
                currentRequestProxy = undefined;
                let nextProxy: string | null = null;
                try {
                  nextProxy = await pickProxy(triedProxySetView());
                } catch (e) {
                  proxyLog(`${reqId} retry proxy pool rotation failed: ${(e as Error).message}`);
                  break;
                }
                if (!nextProxy) {
                  proxyLog(`${reqId} retry proxy pool exhausted after ${rot} rotation(s)`);
                  break;
                }
                currentRequestProxy = nextProxy;
                markProxyTried(nextProxy);
                proxyLog(`${reqId} retry WAF rotation ${rot + 1}/${retryMaxRotations}: switching to proxy ${nextProxy}`);

                await cancelResponseBody(upstreamResp);
                try {
                  hadRetryAttempt = true;
                  upstreamResp = await fetchUpstreamDetected();
                  headersAt = Date.now();
                } catch (err) {
                  proxyLog(`${reqId} retry WAF rotation ${rot + 1} fetch failed: ${(err as Error).message}`);
                  try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
                  continue;
                }
                const rotWafCheck = await checkWafBlock(upstreamResp);
                if (!rotWafCheck.wafBlocked) {
                  const captchaResult = await retryStartPlanCaptchaChallenge(
                    rotWafCheck.response,
                    ` after retry ${attempt} WAF rotation ${rot + 1}`,
                  );
                  upstreamResp = captchaResult.response;
                  if (captchaResult.error) {
                    printRow(reqId, format, meta, 503, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
                    return errorResponse(503, "captcha_failed", captchaResult.error.message);
                  }
                  if (captchaResult.retried) {
                    const postCaptchaWafCheck = await checkWafBlock(upstreamResp);
                    if (postCaptchaWafCheck.wafBlocked) {
                      try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
                      proxyLog(`${reqId} retry WAF rotation ${rot + 1} captcha retry was blocked on ${nextProxy}`);
                      continue;
                    }
                    upstreamResp = postCaptchaWafCheck.response;
                  }
                  proxyLog(`${reqId} retry WAF rotation ${rot + 1} succeeded — proxy ${nextProxy}`);
                  retryRotated = true;
                  break;
                }
                try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
                proxyLog(`${reqId} retry WAF rotation ${rot + 1} still blocked on ${nextProxy}`);
              }
            }
          }

          if (!retryRotated) {
            await cancelResponseBody(upstreamResp);
            printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
            return errorResponse(
              503,
              "waf_blocked",
              "Request blocked by Aliyun WAF (status=" + upstreamResp.status + "). " +
              "Your IP is likely blacklisted. Stop retrying immediately, change IP, and wait before retrying. " +
              "See: https://errors.aliyun.com",
            );
          }
          // Rotated successfully — fall through; the new upstreamResp is the
          // rotated (non-WAF) response.
        } else {
          upstreamResp = retryWafCheck.response;
        }
      } catch (err) {
        // Network error during retry — log the ACTUAL error so users can
        // diagnose (the old code just said "network error" with no detail).
        const errMsg = (err as Error).message ?? String(err);
        // Network errors count toward the credential-switch failure counter.
        consecutiveCredFailures++;
        if (attempt < effectiveRetryLimit()) {
          proxyLog(`${reqId} fetch failed on retry ${attempt}: ${errMsg}, will retry again...`);
          // Network errors are ALWAYS retryable — they are the most common
          // retry scenario (upstream blip, transient DNS, ECONNREFUSED during
          // deploy). The previous code synthesized a 502 and then checked
          // `retryableStatuses.includes(502)` — but the default config is
          // `[529]` only, so synthetic 502 broke the loop and the actual
          // retry never happened. Skip the retryable-status check below by
          // continuing the loop directly here.
          continue;
        }
        proxyLog(`${reqId} fetch failed on final retry ${attempt}: ${errMsg}`);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
        return errorResponse(502, "upstream_unreachable", errMsg);
      }

      // If the new response is no longer a retryable status, break out
      if (!config.retry.retryableStatuses.includes(upstreamResp.status)) {
        proxyLog(`${reqId} retry ${attempt} succeeded (status ${upstreamResp.status})`);
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
        proxyLog(`${reqId} retry ${attempt} got empty-stream 529 (${consecutiveEmptyStreams}/${EMPTY_STREAM_SWITCH_THRESHOLD} before forced switch)`);
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
        const newCred = await canAttemptCredentialSwitch()
          ? await auth.switchToNextCredential(triedApiKeys)
          : null;
        if (newCred) {
          const reason = (EMPTY_STREAM_SWITCH_THRESHOLD > 0 && consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD)
            ? `${consecutiveEmptyStreams} consecutive empty-stream responses`
            : `${failedCount} consecutive failures`;
          proxyLog(
            `${reqId} credential switched (end-of-loop) after ${reason} ` +
            `(retry ${attempt}/${effectiveRetryLimit()}): ${maskApiKey(cred.apiKey)} → ${maskApiKey(newCred.apiKey)}`,
          );
          cred = newCred;
          const newPlan = effectivePlanForCred(newCred);
          if (newPlan !== currentPlan) {
            proxyLog(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
            currentPlan = newPlan;
          }
          // v0.2.2+ PERF: see rebuildTransformedBody docstring above.
          rebuildTransformedBody(newCred.userId, currentPlan);
          consecutiveCredFailures = 0;
          consecutiveEmptyStreams = 0;
          triedApiKeys.add(newCred.apiKey);
          extraAttemptsFromSwitches++;
          // Persist the switch so the dashboard reflects the new active account.
          // This was MISSING in the end-of-loop switch block — the in-memory
          // credential was switched (so the request used the new account), but
          // the on-disk activeId still pointed at the old account. The user
          // saw "激活还是停在原来的账号上，但实际上已经用了下一个账号进行调用了".
          // Now both switch blocks (top-of-loop and end-of-loop) persist the
          // switch consistently. Non-fatal: if persistence fails, the in-memory
          // switch still works for the remainder of this request.
          //
          // === CRITICAL FIX (账号全没 bug) ===
          // Handle switchAccount's new null return value (store transiently
          // unreadable) — don't log misleading "Auto-switched" message.
          try {
            const accounts = await exportAccounts();
            if (accounts.length === 0) {
              proxyLog(`${reqId} credential store is empty, skipping switchAccount persist (end-of-loop)`);
            } else {
              const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
              if (match) {
                const persistResult = await switchAccount(match.id);
                if (persistResult === true) {
                  appendLog("info", `Auto-switched credential to "${match.label}" (${maskApiKey(newCred.apiKey)}) after ${reason}`);
                } else if (persistResult === null) {
                  proxyLog(`${reqId} could not persist credential switch (end-of-loop): store temporarily unreadable`);
                } else {
                  proxyLog(`${reqId} could not persist credential switch (end-of-loop): account ${match.id} not found (race)`);
                }
              }
            }
          } catch (e) {
            proxyLog(`${reqId} could not persist credential switch: ${(e as Error).message}`);
          }
          await cancelResponseBody(upstreamResp);
          continue; // skip the break, give the new cred a chance
        }
        // No alternative credential — mark/log through the shared helper so
        // exhausted retry loops do not spam duplicate diagnostics.
        logNoAlternativeCredential("credential switch threshold reached (end-of-loop)");
      }

      // Still a retryable status — if this was the last attempt, keep the
      // response body intact (don't cancel) so we can return it to the
      // client with a body. Previously the code cancelled the body then
      // refetched — but that refetch reused the consumed Request object
      // and always failed. Keeping the body is simpler and correct.
      if (attempt === effectiveRetryLimit()) {
        proxyLog(`${reqId} all ${effectiveRetryLimit()} retries exhausted, returning ${upstreamResp.status}`);
        break;
      }

      // More retries left — cancel the body before looping
      await cancelResponseBody(upstreamResp);
    }
  }

  // === CRITICAL FIX (命令行还在继续重试 bug) ===
  // If all credentials have been tried and exhausted (switchToNextCredential
  // returned null), return 503 (non-retryable) instead of forwarding the
  // upstream's 529 (retryable). This tells well-behaved clients like Claude
  // Code, OpenAI SDK, etc. to STOP retrying — they honor Retry-After.
  //
  // Previously the proxy forwarded 529 to the client after exhausting all
  // credentials. Clients interpret 529 as "service overloaded, try again
  // later" and keep re-sending the request. The proxy runs the same retry
  // loop, exhausts again, returns 529 again... infinite loop. The user
  // reported "命令行还在继续重试" long after the proxy had given up.
  //
  // 503 with Retry-After: 300 (5 minutes) gives the upstream quota time to
  // reset. The user can also manually add a new credential via the dashboard
  // during this window.
  //
  // We only do this if the final status is a retryable 5xx (529/503/502 etc.)
  // — for non-retryable statuses (4xx), forwarding the original response is
  // correct.
  if (allCredentialsExhausted && upstreamResp.status >= 500 && upstreamResp.status < 600) {
    proxyLog(
      `${reqId} all credentials exhausted + upstream ${upstreamResp.status}, ` +
      `returning 503 (Retry-After: 300) to stop client retry loops`,
    );
    printRow(reqId, format, meta, 503, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
    await cancelResponseBody(upstreamResp);
    const body = JSON.stringify({
      error: {
        type: "all_credentials_exhausted",
        message:
          "All stored credentials have been tried and exhausted. " +
          "The proxy will not retry automatically — please add a new credential " +
          "via the dashboard, or wait for upstream quota to reset " +
          "(Retry-After: 300 seconds).",
      },
    });
    return new Response(body, {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": "300",
        // X-Should-Not-Retry is a non-standard hint for clients that don't
        // honor Retry-After on 503 (rare but possible).
        "x-should-not-retry": "1",
      },
    });
  }

  // === Sticky proxy: mark the current pool proxy as "working" ===
  // If this request used a pool proxy (not cred.proxy) and the response is
  // successful (2xx), make it the sticky proxy for future requests. This
  // implements "后面请求也要记住这个代理继续使用" — once a proxy works,
  // subsequent requests reuse it until it fails.
  //
  // We do NOT clear the sticky state on non-2xx responses here — that's
  // already handled by markProxyFailed in the WAF rotation path. For other
  // 4xx/5xx errors (quota, auth, etc.), we leave the sticky proxy in place
  // because the error is likely account-specific, not proxy-specific.
  if (currentRequestProxy && !cred.proxy && upstreamResp.status >= 200 && upstreamResp.status < 300) {
    if (getCurrentWorkingProxy() !== currentRequestProxy) {
      setCurrentWorkingProxy(currentRequestProxy);
      proxyLog(`${reqId} proxy sticky: ${currentRequestProxy} (will reuse for future requests)`);
    }
  }

  const isSSEUpstream = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;
  // isSSE mutates below: when we buffer SSE → batch JSON for non-stream
  // clients, isSSE becomes false so the SSE branch is skipped.
  let isSSE = isSSEUpstream;

  // v0.2.0.4: stream:true is forced upstream (in alignZCodeRequestFormat) to
  // match the real ZCode desktop client's wire shape. When the original client
  // requested non-streaming (no `stream: true` in their body), upstream still
  // returns SSE — we buffer it into batch JSON so the client gets the response
  // format it expects. This makes the wire-shape alignment transparent to
  // non-stream clients (Claude Code, SDK calls, integration tests, etc.).
  //
  // Both passthrough AND translation paths benefit (translatedBatchResponse /
  // translatedResponsesBatchResponse both expect a JSON body — the synthetic
  // JSON response flows through them naturally).
  //
  // Runs only on 2xx SSE responses (4xx/5xx are handled by the diagnostic
  // peek below; the SSE error detector converts errored/empty SSE to non-2xx
  // JSON before we reach here, so isSSE=false for those).
  if (isSSE && upstreamResp.ok && !meta.stream && upstreamResp.body) {
    const result = await anthropicSseToBatchMessage(upstreamResp.body, meta.model, {
      maxBytes: sseToBatchBodyLimitBytes(),
    });
    if ("error" in result) {
      proxyLog(`${reqId} SSE->batch reassembly error: ${result.error}`);
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
      return errorResponse(502, "upstream_stream_error", result.error);
    }
    const json = JSON.stringify(result.message);
    // Preserve relevant upstream headers (request-id, ratelimit-*). Drop the
    // text/event-stream content-type — the synthetic response is JSON.
    const respHeaders = new Headers();
    for (const h of ["x-request-id", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-reset"]) {
      const v = upstreamResp.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    respHeaders.set("content-type", "application/json");
    upstreamResp = new Response(json, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
    isSSE = false; // the synthetic response is JSON, not SSE
    // The reassembled message carries `usage` (input_tokens / output_tokens),
    // which the batch path below extracts automatically — no need to plumb
    // token counts separately.
  }

  // Diagnostic: when the upstream rejects with 4xx (especially 3001 "parameter
  // error" from GLM), record a debug dump in memory so the user can inspect
  // the exact transformed body via /admin/api/debug-dumps without writing
  // files to disk. The old code wrote to <cwd>/zcode-proxy-debug-*.json
  // which leaked user conversation content to disk forever.
  let upstreamErrorPreview: string | null = null;
  if (!upstreamResp.ok && upstreamResp.status >= 400 && upstreamResp.status < 500) {
    const split = splitResponseForPreview(upstreamResp);
    if (split) upstreamResp = split.passthrough;
    const errPeek = await readResponseTextPreview(split?.preview ?? upstreamResp, {
      maxBytes: ERROR_RESPONSE_PREVIEW_BYTES,
      timeoutMs: 3_000,
      clone: !split,
    }).catch(() => ({ text: "", truncated: false, timedOut: false, complete: false }));
    upstreamErrorPreview = errPeek.text;
    const suffix = errPeek.truncated ? `...(truncated at ${ERROR_RESPONSE_PREVIEW_BYTES} bytes)` : errPeek.timedOut ? "...(preview timed out)" : "";
    proxyLog(`${reqId} upstream ${upstreamResp.status} ${upstreamErrorPreview.slice(0, 200)}${suffix}`);
    proxyLog(`${reqId} transformed request summary: ${summarizeBody(transformedObj ?? parsedBody)}`);
    // Also log the anthropic-beta header that was actually sent upstream —
    // mismatched beta flags vs body is a common 3001 cause on ZCode gateway.
    // Reuses lastSentBeta captured during the real fetch (instead of building
    // a fresh Request just to read one header — the old code generated new
    // random UUIDs for x-request-id etc., making the logged header belong to
    // a different request than the one actually sent).
    proxyLog(`${reqId} anthropic-beta sent: ${lastSentBeta ?? "(none)"}`);
    if (transformedBody) {
      try {
        recordDebugDump({
          id: reqId,
          status: upstreamResp.status,
          upstreamError: upstreamErrorPreview.slice(0, 500),
          anthropicBeta: lastSentBeta ?? "",
          bodySummary: summarizeBody(transformedObj ?? parsedBody),
          body: transformedBody,
        });
      } catch (e) {
        proxyLog(`${reqId} failed to record debug dump: ${(e as Error).message}`);
      }
    }
  }

  if (translateMode) {
    if (!upstreamResp.ok) {
      const errBody = upstreamErrorPreview ?? (await readResponseTextPreview(upstreamResp, {
        maxBytes: ERROR_RESPONSE_PREVIEW_BYTES,
        timeoutMs: 3_000,
      }).then(r => r.text).catch(() => ""));
      // Translation mode returns a local JSON error instead of forwarding the
      // upstream response body. If the 4xx diagnostic path tee'd the body for a
      // preview, the passthrough branch would otherwise remain open until the
      // upstream/bridge times out.
      try { await upstreamResp.body?.cancel(); } catch (e) { void e; }
      printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0, hadRetryAttempt, 0, currentCredentialStatsKey(), totalCaptchaMs);
      return errorResponse(upstreamResp.status, "upstream_error", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (format === "openai-responses") {
      // Responses API translation: use the dedicated SSE / batch translators.
      const customToolNames = responsesCustomToolNames(parsedBody);
      if (isSSE && upstreamResp.body) {
        const translated = anthropicSseToResponsesSse(upstreamResp.body, meta.model, { customToolNames });
        // v0.2.0.8: pipe through an inline stats TransformStream instead of
        // tee()+parallel reader — avoids buffering the whole stream when the
        // stats reader falls behind (see createStatsTransform docs).
        const stats = createStatsTransform(reqId, format, meta, upstreamResp.status, started, null, currentCredentialStatsKey(), totalCaptchaMs, hadRetryAttempt);
        // v0.2.1.7: heartbeat AFTER stats (closer to client). Stats sees
        // only real upstream bytes; heartbeat comment lines flow straight
        // to the client without stats inspecting them.
        return translatedSseResponse(withSseHeartbeat(observeStatsStream(translated, stats), config.server.sseHeartbeatMs ?? 0));
      }
      return await translatedResponsesBatchResponse(
        clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt,
        (parsedBody as OpenAIResponseRequest | undefined)?.previous_response_id,
        (parsedBody as OpenAIResponseRequest | undefined)?.input,
        customToolNames,
        currentCredentialStatsKey(),
        totalCaptchaMs,
        hadRetryAttempt,
      );
    }
    // Chat Completions translation: use the original SSE / batch translators.
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      // v0.2.0.8: inline stats transform (see createStatsTransform docs).
      const stats = createStatsTransform(reqId, format, meta, upstreamResp.status, started, null, currentCredentialStatsKey(), totalCaptchaMs, hadRetryAttempt);
      // v0.2.1.7: heartbeat AFTER stats — see openai-responses branch above.
      return translatedSseResponse(withSseHeartbeat(observeStatsStream(translated, stats), config.server.sseHeartbeatMs ?? 0));
    }
    return await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt, currentCredentialStatsKey(), totalCaptchaMs, hadRetryAttempt);
  }

  if (isSSE && upstreamResp.body) {
    // v0.2.0.8: inline stats transform — pass content-encoding so compressed
    // streams skip SSE parsing (we'd only see gzip bytes, not SSE events).
    const contentEncoding = upstreamResp.headers.get("content-encoding");
    const stats = createStatsTransform(reqId, format, meta, upstreamResp.status, started, contentEncoding, currentCredentialStatsKey(), totalCaptchaMs, hadRetryAttempt);
    // v0.2.1.7: heartbeat AFTER stats — keeps the client connection alive
    // across CF's 100s Proxy Read Timeout when upstream is slow to TTFB
    // (e.g. GLM-5.2 thinking mode sitting silent for 60-180s).
    //
    // CRITICAL: heartbeat is DISABLED when the upstream response is
    // compressed (content-encoding: gzip/br/deflate). In passthrough mode
    // (decompress: false), upstreamResp.body is raw compressed bytes and
    // passthroughResponse preserves the content-encoding header — the
    // client decompresses on its end. Injecting plaintext ": keepalive\n\n"
    // into a compressed stream would corrupt the client's decompression
    // (Z_DATA_ERROR), destroying the entire response.
    //
    // translateMode branches above are unaffected: Bun auto-decompresses
    // (no decompress:false), translators output plaintext SSE, and
    // translatedSseResponse doesn't set content-encoding — so heartbeat
    // is always safe there.
    //
    // Trade-off: passthrough + compressed SSE loses CF 524 protection.
    // In practice z.ai/bigmodel SSE responses are rarely compressed (SSE
    // is streaming; compression introduces buffering latency), so this
    // is a rare edge case. If you hit it, the fix is to use stream:true
    // on the client (which may route through translation mode) or disable
    // compression on the upstream.
    const heartbeatInterval = isCompressedContentEncoding(contentEncoding) ? 0 : (config.server.sseHeartbeatMs ?? 0);
    return passthroughResponse(upstreamResp, withSseHeartbeat(observeStatsStream(upstreamResp.body, stats), heartbeatInterval));
  }

  // Non-streaming anthropic passthrough — try to extract usage from a bounded
  // clone preview for stats. The original response body remains untouched for
  // passthrough, so a huge JSON response is not fully materialized just to
  // count tokens.
  let passthroughInputTokens = 0;
  let passthroughOutputTokens = 0;
  const ct = upstreamResp.headers.get("content-type") ?? "";
  let passthroughCacheReadTokens = 0;
  if (ct.includes("application/json") && upstreamResp.body) {
    try {
      const split = splitResponseForPreview(upstreamResp);
      if (!split) throw new Error("response body is not readable");
      upstreamResp = split.passthrough;
      const preview = await readResponseTextPreview(split.preview, {
        maxBytes: PASSTHROUGH_USAGE_PREVIEW_BYTES,
        timeoutMs: 3_000,
        clone: false,
      });
      if (preview.complete && !preview.truncated && !preview.timedOut) {
        const usage = JSON.parse(preview.text)?.usage;
        if (usage) {
          passthroughInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
          passthroughOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
          // v0.2.0.6: extract cache_read_input_tokens for accurate input total
          passthroughCacheReadTokens = usage.cache_read_input_tokens ?? 0;
        }
      }
    } catch { /* non-JSON or parse error — leave as 0, fall back to original body */ }
  }
  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, passthroughOutputTokens, 0, 0, hadRetryAttempt, passthroughInputTokens, currentCredentialStatsKey(), totalCaptchaMs, passthroughCacheReadTokens);
  // Reconstruct the response with the read body so passthrough still has content.
  //
  // v0.2.2+ note: passthrough mode uses `decompress: false` on the upstream
  // fetch, so `upstreamResp.text()` returns the RAW bytes (still gzip/br/
  // deflate compressed if the upstream sent them that way). The original
  // `content-encoding` header correctly describes the body, so we MUST
  // preserve it — stripping it would make the client receive compressed
  // bytes with no encoding hint, breaking decompression.
  //
  // The translation-format pipeline (body-transformer.ts alignZCodeRequestFormat)
  // is NOT touched here — this only affects the OUTBOUND response back to
  // the client, not the inbound request translation.
  return passthroughResponse(upstreamResp);
}

export async function _readResponseTextPreviewForTesting(
  resp: Response,
  opts: ResponseTextPreviewOptions,
): Promise<ResponseTextPreview> {
  return readResponseTextPreview(resp, opts);
}

/** Exported for focused transform tests. */
export const _testing = {
  withSseHeartbeat,
  createStatsTransform,
  observeStatsStream,
  readResponseTextLimited,
  readResponseTextPreview,
  printRow,
  wrapResponseBodyWithUpstreamTimeout,
  shouldEmitProxyLog,
};
