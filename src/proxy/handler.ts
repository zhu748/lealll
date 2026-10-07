/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 *
 * **v2.6 upstream reality (post-PR #34)**: BOTH plan tiers post an
 * Anthropic-format upstream — coding-plan mirrors the real ZCode client
 * (api.z.ai/api/anthropic → ultra via endpoint routing); start-plan posts to
 * zcode.z.ai's Anthropic gateway with the plan JWT. Consequently:
 * - OpenAI clients are translated OpenAI→Anthropic on the way up and
 *   Anthropic→OpenAI on the way down ("translation" mode).
 * - Anthropic clients speak the upstream's native format — requests are
 *   forwarded with body transforms only ("passthrough" mode,
 *   `decompress: false`).
 *
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { OpenAIChatRequest, Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamHeaderPairs, buildUpstreamRequest } from "./upstream.js";
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { credentialString } from "../auth/types.js";
import { pickProxy, markProxyFailed, getMaxRotations } from "./proxy-pool.js";
import { transformRequestBody, transformParsedBody } from "./body-transformer.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge } from "./captcha-retry.js";
import { resolveSessionContext } from "./session-context.js";
// --- fork multi-account resilience layer ---
import { switchAccount, exportAccounts } from "../auth/store.js";
import { maskApiKey, credentialStatsKey } from "../auth/account-view.js";
import { sleep } from "../utils/sleep.js";
import type { Credential } from "../auth/types.js";

import { translateRequestOpenAIToAnthropic } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import { dumpPhase, dumpHeaders, dumpBody, dumpEnabled } from "./dump.js";
import { createStatsTransform, observeStatsStream } from "./stats.js";
import { recordHeaders } from "../utils/header-debug.js";
import { readBody, RequestBodyTooLargeError, InflatedBodyTooLargeError } from "./request-body.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";
import {
  shouldUseOrderedTransport, capOrderedAcceptEncoding, dispatchWithConnectRetry,
  sendUpstreamRequest, MAX_CONNECT_ATTEMPTS,
} from "./upstream-dispatch.js";
import { clientAcceptsGzip, passthroughResponse, translatedBatchResponse, translatedSseResponse } from "./response-builder.js";
import {
  createRequestLogger, nextReqId, debugLine, debugError,
  formatHeaderPairs, formatResponseHeaders, previewBody, type RequestMeta,
} from "./request-log.js";
import { errorResponse } from "./translated-response.js";

export { shouldUseOrderedTransport, capOrderedAcceptEncoding, MAX_CONNECT_ATTEMPTS, dispatchWithConnectRetry, stripAutoDecodedEncoding } from "./upstream-dispatch.js";
export { errorResponse } from "./translated-response.js";
export { readBody, RequestBodyTooLargeError, InflatedBodyTooLargeError } from "./request-body.js";

// captcha.ts is loaded lazily inside the `startPlan` branch (only path that
// touches it). The solver itself (captcha-happy.ts) is dynamically imported
// by captcha-solver.ts, so non-start-plan processes never pay its startup
// cost. Desktop Bun keeps the same code path; the dynamic import resolves
// synchronously enough on Bun's warm cache.
type CaptchaModule = typeof import("./captcha.js");
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("./captcha.js");
  return captchaModule;
}

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * When true, emit additional per-request diagnostic lines: upstream URL,
   * redacted request headers, body preview, upstream response status and
   * selected response headers. Activated by `zcode-proxy serve debug`.
   */
  debug?: boolean;
  /** Override the process-wide endpoint routing service (for testing). `null` disables. */
  endpointRouting?: EndpointRoutingService | null;
  /** Override the process-wide client signing manager (for testing). `null` disables. */
  clientSigning?: ClientSigningManager | null;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Upstream fetch options differ by mode:
 * - **Passthrough** (Anthropic client): `{ decompress: false }` — preserve raw
 *   upstream bytes and content encoding, decompressing gzip only when needed
 *   for a client that did not accept it.
 * - **Translation** (OpenAI client): read the decoded Anthropic response and
 *   translate it to OpenAI; gzip batch output when accepted by the client.
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
  const hasCustomFetchImpl = opts.fetchImpl !== undefined;
  const debug = opts.debug === true;
  const started = Date.now();
  const reqId = nextReqId();

  let body: string | undefined;
  try {
    body = await readBody(clientReq, config.server?.maxRequestBodyBytes);
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError || err instanceof RequestBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message);
    }
    return errorResponse(400, "invalid_request_error", (err as Error).message);
  }

  // ---- single-parse contract ----
  // The raw body is parsed EXACTLY ONCE here and the resulting object is
  // threaded to every consumer (peek/session-resolution/translation/transform).
  // Previously each site re-parsed independently (4-5 parses per request on
  // the default path, each O(body)). Invalid or non-object JSON leaves
  // parsedBody undefined and every consumer falls back to its legacy
  // string-path behavior — same outcomes, one parse.
  let parsedBody: Record<string, unknown> | undefined;
  if (body !== undefined && body.length > 0) {
    try {
      const raw = JSON.parse(body) as unknown;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        parsedBody = raw as Record<string, unknown>;
      }
    } catch { /* consumers see undefined and fall back */ }
  }

  const meta = peekBody(parsedBody);
  const logResult = createRequestLogger({ reqId, format, meta, started });

  if (dumpEnabled()) {
    dumpPhase(reqId, "client_in", {
      method: clientReq.method,
      url: clientReq.url,
      headers: dumpHeaders(clientReq.headers),
      body: dumpBody(body),
    });
  }

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  let cred: Credential;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    if (debug) debugError(reqId, "credential_unavailable", (err as Error).message);
    logResult({ status: 503, headersAt: Date.now() });
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  // ---- fork multi-account retry layer: config fallbacks (field-by-field,
  // matching admin RETRY_DEFAULTS so hand-built configs still retry sanely).
  const retryCfg = {
    maxRetries: config.retry?.maxRetries ?? 3,
    initialDelayMs: config.retry?.initialDelayMs ?? 1000,
    maxDelayMs: config.retry?.maxDelayMs ?? 8000,
    backoffFactor: config.retry?.backoffFactor ?? 2,
    retryableStatuses: config.retry?.retryableStatuses ?? [529, 429],
    credentialSwitchThreshold: config.retry?.credentialSwitchThreshold ?? 2,
    emptyStreamSwitchThreshold: config.retry?.emptyStreamSwitchThreshold ?? 3,
    totalDeadlineMs: config.retry?.totalDeadlineMs ?? 300000,
  };

  // fork: credential-driven plan resolution. A credential's own plan (or its
  // start-plan JWT) wins over config.yaml — switching accounts mid-retry may
  // also switch plans (coding-plan ↔ start-plan), which changes the upstream
  // URL, auth headers, and captcha behavior.
  // 4.8.0 harden: a start-plan tag WITHOUT a JWT can never authenticate on the
  // zcode.z.ai plane (Bearer JWT + captcha) — legacy store rows or manual keys
  // mis-tagged before the add-key guard degrade to coding-plan instead of
  // failing every request with 401.
  const effectivePlanForCred = (c: Credential): "coding-plan" | "start-plan" => {
    const plan = c.plan ?? (c.jwt ? "start-plan" : config.plan);
    return plan === "start-plan" && !c.jwt ? "coding-plan" : plan;
  };
  let currentPlan = effectivePlanForCred(cred);
  if (currentPlan !== config.plan) {
    // Request-local only: do NOT write back to config.plan. The config object is
    // shared by every in-flight request plus the /async + /mcp plan gates and
    // the dashboard — mutating it here let one credential's plan flip the
    // globally visible plan mid-flight (nondeterministic gating for
    // concurrently dispatched requests).
    if (debug) debugLine(reqId, `plan ${config.plan} → ${currentPlan} (from credential, request-local)`);
  }

  // v2.6: both plans use the Anthropic upstream. coding-plan mirrors the real
  // ZCode client (api.z.ai/api/anthropic → ultra via endpoint routing);
  // start-plan's old OpenAI gateway (/api/v1/zcode-plan/chat/completions) was
  // retired server-side (404 as of 2026-08-28) — the live desktop client now
  // posts Anthropic messages to /api/v1/zcode-plan/anthropic/v1/messages with
  // the start-plan JWT, so we do the same (no OpenAI translation either way).
  let startPlan = currentPlan === "start-plan";
  const translateMode = format === "openai";
  const upstreamFormat: Format = "anthropic";
  const clientSession = resolveSessionContext({ clientReq, body, parsedBody, upstreamFormat, model: meta.model, config });
  if (debug && clientSession) {
    const shortSession = clientSession.sessionId ? clientSession.sessionId.slice(0, 10) : "-";
    debugLine(reqId, `clientIdentity source=${clientSession.source} action=${clientSession.action} confidence=${clientSession.confidence.toFixed(2)} session=${shortSession}`);
  }

  let upstreamBody = body;
  // Object form matching `upstreamBody` (undefined when the body isn't a
  // JSON object or is empty) — lets the transformer mutate in place instead
  // of a stringify→parse→stringify round trip.
  let upstreamParsed = parsedBody;
  if (translateMode) {
    const translated = translateOpenAIBody(parsedBody, body);
    if (translated instanceof Response) return translated;
    upstreamParsed = translated;
    upstreamBody = JSON.stringify(translated);
    if (debug) debugLine(reqId, `translated OpenAI→Anthropic (bytes=${upstreamBody?.length ?? 0})`);
  }

  // Bundle `E2e` fires for EVERY anthropic-kind request (both plans) — the
  // injected user_id is the device/session blob, never the account uuid.
  const metadataUserId = buildAnthropicMetadataUserId(config.identity.deviceMid, clientSession?.sessionId);
  // fork: rebuildable — a mid-retry credential switch can flip startPlan,
  // which changes the injected system-prompt block / metadata shape.
  const applyBodyTransform = (startPlanFlag: boolean): string | undefined => {
    if (upstreamParsed) {
      // Object path: mutate the already-parsed body, re-serialize only when
      // something changed. NOTE: mutations accumulate on upstreamParsed —
      // rebuilds (plan flips) must pass a FRESH copy (see below).
      return transformParsedBody(upstreamParsed, { format: upstreamFormat, metadataUserId, startPlan: startPlanFlag, provider: config.provider }) ?? upstreamBody;
    }
    return transformRequestBody(upstreamBody, { format: upstreamFormat, metadataUserId, startPlan: startPlanFlag, provider: config.provider });
  };
  const rebuildTransformedBody = (): void => {
    if (upstreamParsed) {
      // Plan flip re-injects the start-plan system block — rebuild from a
      // fresh copy so the first transform's mutations aren't applied twice.
      // Rare path (credential switch mid-retry): the clone cost is fine.
      const fresh = structuredClone(upstreamParsed) as Record<string, unknown>;
      transformedBody = transformParsedBody(fresh, { format: upstreamFormat, metadataUserId, startPlan, provider: config.provider }) ?? upstreamBody;
      return;
    }
    transformedBody = transformRequestBody(upstreamBody, { format: upstreamFormat, metadataUserId, startPlan, provider: config.provider });
  };
  let transformedBody = applyBodyTransform(startPlan);
  if (debug && transformedBody !== upstreamBody) {
    debugLine(reqId, `body transformed (upstreamFormat=${upstreamFormat}, startPlan=${startPlan}, bytes=${transformedBody?.length ?? 0})`);
  }

  // ---- fork retry-loop state ----
  let consecutiveCredFailures = 0;
  // Credentials already tried in this request — prevents cycling back to a
  // known-failing credential when multiple alternatives exist.
  const triedApiKeys = new Set<string>([cred.apiKey]);
  let totalAvailableCredentials = 1;
  try {
    totalAvailableCredentials = Math.max(1, await auth.getAvailableCredentialCount());
  } catch { /* ignore — fall back to 1 */ }
  // Set ONLY when we actually had multiple credentials AND all failed; the
  // post-loop check then returns 503 (non-retryable) instead of forwarding
  // the retryable upstream status — tells well-behaved clients to STOP.
  let allCredentialsExhausted = false;
  // Hard cap on total attempts (fork v0.2.2+): maxRetries*4+10, capped at 20.
  const MAX_TOTAL_ATTEMPTS = Math.min(retryCfg.maxRetries * 4 + 10, 20);
  const retryLoopStartedAt = Date.now();
  let hadRetryAttempt = false;

  const useOrderedTransport = shouldUseOrderedTransport(config, clientSession, hasCustomFetchImpl);

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(config);
  const signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);

  // ---- egress proxy wiring (per-credential override → global pool) ----
  // Previously the pool's pickProxy/markProxyFailed/setCurrentWorkingProxy
  // had no consumer on the LLM egress path: main traffic always connected
  // directly, defeating the documented per-account proxy feature and the
  // whole SOCKS-bridge/rotation design. Now every dispatch resolves an
  // egress proxy: the credential's own `proxy` override wins; otherwise the
  // global pool is consulted (null when disabled/empty → direct connection,
  // byte-for-byte unchanged behavior and zero overhead for unconfigured
  // setups — including every test with an injected fetchImpl).
  const poolExcluded = new Set<string>();
  let poolRotationsExhausted = false;
  // The pool-served proxy of the most recent dispatch (per-cred overrides
  // never rotate). Read by the 405-rotation / connect-failure hooks below.
  let lastPoolProxy: string | null = null;

  // ---- header-debug wiring ----
  // logging.headerDebug promises "two files per request" in the dashboard,
  // but recordHeaders had zero production callers (dead code). Record the
  // FIRST dispatch attempt only — retries/re-solves stay unrecorded so the
  // output stays one pair per request (diff-friendly), per the module docs.
  const headerDebugOn = config.logging?.headerDebug === true;
  let headerDebugRecorded = false;

  /** Start-plan captcha preflight: a fresh one-shot Aliyun verify param.
   * Failure falls back to the 403-challenge solve path downstream. */
  const buildCaptchaHeaders = async (): Promise<Record<string, string> | undefined> => {
    if (!startPlan) return undefined;
    try {
      const captcha = await loadCaptcha();
      const token = await captcha.getCaptchaToken(config.identity.appVersion);
      return { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region };
    } catch {
      // Will solve on 403 fallback below
      return undefined;
    }
  };

  /** Dispatch with the CURRENT credential (fork: parameterized so the retry
   * loop can re-dispatch with a switched account). Body/headers rebuilt per
   * call — a reused Request has its body stream marked used after the first
   * fetch. */
  const dispatch = async (credNow: Credential, captchaHeaders: Record<string, string> | undefined): Promise<Response> => {
    // Egress resolution per dispatch: per-credential override → pool pick
    // (sticky via pickProxy; excluded proxies are skipped during rotation).
    const perCredProxy = credNow.proxy?.trim() || null;
    let egressProxy: string | null = perCredProxy;
    if (!egressProxy && !poolRotationsExhausted && !useOrderedTransport) {
      try {
        egressProxy = await pickProxy(poolExcluded.size > 0 ? poolExcluded : undefined);
      } catch { /* pool unreadable → direct */ }
    }
    lastPoolProxy = egressProxy && !perCredProxy ? egressProxy : null;
    let pairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, credNow, config.identity, currentPlan, captchaHeaders, clientSession);
    // When the ordered transport must READ the upstream body (translate mode),
    // it has to inflate whatever coding the upstream picks — cap the advertised
    // accept-encoding (see capOrderedAcceptEncoding for the CDN brotli war story).
    if (useOrderedTransport && translateMode) {
      pairs = capOrderedAcceptEncoding(pairs);
    }
    const req = buildUpstreamRequest(clientReq, upstreamFormat, provider, credNow, transformedBody, config.identity, currentPlan, captchaHeaders, clientSession);
    let sendUrl = req.url;
    if (routing) {
      const routed = await routing.resolve(req.url, credentialString(credNow));
      if (routed.routed) {
        sendUrl = routed.url;
        if (debug) debugLine(reqId, `endpoint routing: ${req.url} -> ${routed.url}`);
      }
    }
    // Signing decisions (exempt-path, handshake origin, bypass keying) run
    // against the PRE-routing provider URL — the client's signer wraps the
    // routing transport, so its checks see the original URL too.
    return sendWithClientSigning(signer, {
      url: req.url,
      headerPairs: pairs,
      credential: credentialString(credNow),
      appVersion: config.identity.appVersion,
      debug: debug ? (message) => debugLine(reqId, message) : undefined,
      send: (finalPairs) => {
        if (dumpEnabled()) {
          dumpPhase(reqId, "wire_out", {
            url: sendUrl,
            signed: finalPairs.some(([k]) => k.toLowerCase() === "x-client-sig"),
            headers: dumpHeaders(new Headers(Object.fromEntries(finalPairs))),
          });
        }
        const sendReq = sendUrl === req.url && finalPairs === pairs
          ? req
          : new Request(sendUrl, {
              method: req.method,
              headers: Object.fromEntries(finalPairs),
              body: transformedBody ?? undefined,
            });
        if (headerDebugOn && !headerDebugRecorded) {
          headerDebugRecorded = true;
          recordHeaders(clientReq, req, reqId, format, transformedBody, body);
        }
        return sendUpstreamRequest({
          request: sendReq,
          headerPairs: finalPairs,
          body: transformedBody,
          translateMode,
          useOrderedTransport,
          fetchImpl,
          abortSignal: clientReq.signal,
          hasCustomFetchImpl,
          egressProxy,
        });
      },
    });
  };

  /**
   * fork multi-account core: on repeated failures with the current credential,
   * switch to the next stored account (skipping already-tried keys), sync the
   * plan, rebuild the body, and persist the new active account (best-effort).
   * Returns true when the request should be retried with the new credential.
   */
  const maybeSwitchCredential = async (): Promise<boolean> => {
    if (!(retryCfg.credentialSwitchThreshold > 0 && consecutiveCredFailures >= retryCfg.credentialSwitchThreshold)) {
      return false;
    }
    // Refresh the available count so a credential added mid-request can be picked up.
    if (totalAvailableCredentials <= 1 || triedApiKeys.size >= totalAvailableCredentials) {
      try { totalAvailableCredentials = Math.max(1, await auth.getAvailableCredentialCount()); } catch { /* keep last */ }
    }
    if (!(totalAvailableCredentials > 1 && triedApiKeys.size < totalAvailableCredentials)) {
      if (totalAvailableCredentials > 1) {
        allCredentialsExhausted = true;
        console.log(`${reqId} no alternative credential left (tried ${triedApiKeys.size}/${totalAvailableCredentials}) — will return 503 after retries exhaust`);
      } else {
        console.log(`${reqId} no alternative credential available (single account) — continuing with current`);
      }
      return false;
    }
    const newCred = await auth.switchToNextCredential(triedApiKeys);
    if (!newCred) {
      if (totalAvailableCredentials > 1) allCredentialsExhausted = true;
      return false;
    }
    const fromKey = cred.apiKey;
    cred = newCred;
    triedApiKeys.add(newCred.apiKey);
    consecutiveCredFailures = 0;
    const newPlan = effectivePlanForCred(newCred);
    if (newPlan !== currentPlan) {
      console.log(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
      currentPlan = newPlan;
      // request-local: see the comment on the initial plan resolution above
      startPlan = newPlan === "start-plan";
      rebuildTransformedBody();
    }
    console.log(`${reqId} credential switched: ${maskApiKey(fromKey)} → ${maskApiKey(newCred.apiKey)}`);
    // Persist the switch so the dashboard reflects the new active account.
    // Non-fatal: if persistence fails, the in-memory switch still works for
    // the remainder of this request.
    try {
      const accounts = await exportAccounts();
      const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
      if (match) {
        const persistResult = await switchAccount(match.id);
        if (persistResult === true) {
          console.log(`${reqId} auto-switched active account to "${match.label}"`);
        }
        // null (store transiently unreadable) / false (race): in-memory switch
        // already applied — nothing actionable, skip logging noise.
      }
    } catch (e) {
      console.log(`${reqId} could not persist credential switch: ${(e as Error).message}`);
    }
    return true;
  };

  /** RFC 7231 §7.1.3 Retry-After (delta-seconds or HTTP-date), capped by maxDelayMs. */
  const computeRetryDelayMs = (attempt: number, retryAfter: string | null): number => {
    let delayMs = Math.min(
      retryCfg.initialDelayMs * Math.pow(retryCfg.backoffFactor, attempt - 1),
      retryCfg.maxDelayMs,
    );
    if (retryAfter) {
      const s = Number(retryAfter.trim());
      if (Number.isFinite(s) && s >= 0) {
        delayMs = Math.min(s * 1000, retryCfg.maxDelayMs);
      } else {
        const dateMs = Date.parse(retryAfter);
        if (Number.isFinite(dateMs)) {
          delayMs = Math.min(Math.max(0, dateMs - Date.now()), retryCfg.maxDelayMs);
        }
      }
    }
    return delayMs;
  };

  // Per-request stats context handed to request logger → recordStat (fork dashboard
  // stats collector): retry flag + per-credential usage bucket.
  const rowStats = (): { retried: boolean; credentialKey?: string } => {
    let credentialKey: string | undefined;
    try { credentialKey = credentialStatsKey(cred); } catch { /* best-effort */ }
    return { retried: hadRetryAttempt, ...(credentialKey ? { credentialKey } : {}) };
  };

  // Wire an SSE response body through the inline stats transform (see
  // createStatsTransform): per-chunk parsing runs on the client pump — this
  // replaces the old `body.tee()` + fire-and-forget observeStream pattern
  // whose shared queue buffered entire long streams in memory (≈2× peak) and
  // throttled the client branch to the stats reader's pace.
  const wireStats = (body: ReadableStream<Uint8Array>, status: number, contentEncoding: string | null): ReadableStream<Uint8Array> => {
    const dumpOn = dumpEnabled();
    let totalBytes = 0;
    let firstBytesSample = "";
    const dumpDecoder = dumpOn ? new TextDecoder() : null;
    const hooked = createStatsTransform(
      reqId, format, meta, status, started, contentEncoding,
      rowStats().credentialKey, 0, hadRetryAttempt,
      {
        ...(dumpOn
          ? {
              onChunk: (value: Uint8Array): void => {
                totalBytes += value.byteLength;
                if (dumpDecoder && firstBytesSample.length < 4096) {
                  firstBytesSample += dumpDecoder.decode(value.slice(0, 4096 - firstBytesSample.length), { stream: true });
                }
              },
            }
          : {}),
        onDone: (info): void => {
          if (dumpOn) {
            dumpPhase(reqId, "upstream_stream_summary", {
              status,
              contentEncoding,
              compressed: contentEncoding !== null,
              totalBytes,
              tokensObserved: info.tokens,
              ttfbMs: info.ttfbMs,
              totalMs: info.totalMs,
              firstBytesSample: firstBytesSample.length > 0 ? firstBytesSample.slice(0, 4096) : "(empty stream)",
            });
          }
          // emptyStreamSwitchThreshold (finally wired — was dead config since
          // vceshi0.0.5): a 200 SSE stream with ZERO content events is the
          // gateway's silent quota-exhaustion shape. Track the per-credential
          // streak; once it reaches the threshold (0 = off) with an
          // alternative account available, switch the active credential for
          // future requests.
          const isEmptyStream = status === 200 && info.tokens === 0 && info.thinkingTokens === 0 && info.inputTokens === 0;
          const emptyStreak = bumpEmptyStreamStreak(credentialStatsKey(cred), isEmptyStream);
          if (
            isEmptyStream &&
            retryCfg.emptyStreamSwitchThreshold > 0 &&
            emptyStreak === retryCfg.emptyStreamSwitchThreshold &&
            totalAvailableCredentials > 1
          ) {
            console.log(`${reqId} credential ${maskApiKey(cred.apiKey)} returned ${emptyStreak} consecutive empty 200 streams — rotating account for future requests`);
            auth.switchToNextCredential(new Set([cred.apiKey]))
              .then((next) => {
                if (next) console.log(`${reqId} empty-stream failover: active credential → ${maskApiKey(next.apiKey)}`);
              })
              .catch(() => { /* best-effort — streak persists for the next request */ });
          }
        },
      },
    );
    return observeStatsStream(body, hooked);
  };

  let upstreamResp!: Response;
  let headersAt = 0;
  let attempt = 0;

  // Dropped (undrained) upstream responses hold their socket open until GC —
  // on a 429-retry storm that's one leaked connection per retry cycle. Cancel
  // the body explicitly on every path that discards the response.
  const discardUpstreamBody = (): void => {
    try { void upstreamResp?.body?.cancel().catch(() => {}); } catch { /* best-effort */ }
  };

  // ============================================================
  // fork resilience loop: attempt → captcha-challenge replay →
  // retryable-status backoff → credential switch → re-dispatch.
  // The upstream 4.x handler forwarded 529/429 straight to the client;
  // the fork retries them in-process (backoff + multi-account failover)
  // and only surfaces the failure when every option is exhausted.
  // ============================================================
  retryLoop: while (true) {
    attempt++;

    if (debug) {
      debugLine(reqId, `→ attempt ${attempt} (cred ${maskApiKey(cred.apiKey)}, plan ${currentPlan})`);
    }

    // Start-plan captcha preflight: a fresh one-shot verify param per attempt
    // (Aliyun params cannot be reused across retries).
    const captchaHeaders = await buildCaptchaHeaders();

    if (debug) {
      const dbgReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, currentPlan, captchaHeaders, clientSession);
      debugLine(reqId, `→ POST ${dbgReq.url}`);
      debugLine(reqId, `  ${formatHeaderPairs(dbgReq.headers)}`);
      if (transformedBody) debugLine(reqId, `  body preview: ${previewBody(transformedBody)}`);
    }

    if (dumpEnabled()) {
      const dbgReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, currentPlan, captchaHeaders, clientSession);
      dumpPhase(reqId, "upstream_out", {
        method: dbgReq.method,
        url: dbgReq.url,
        headers: dumpHeaders(dbgReq.headers),
        body: dumpBody(transformedBody),
        upstreamFormat,
        translateMode,
        useOrderedTransport,
        startPlan,
      });
    }

    try {
      // Transient connect failures (DNS blip, TLS reset) are retried inside
      // dispatchWithConnectRetry — dispatch() rebuilds the Request per call
      // (a reused Request has its body stream marked used after the first
      // fetch).
      upstreamResp = await dispatchWithConnectRetry(
        () => dispatch(cred, captchaHeaders),
        {
          isAborted: () => clientReq.signal.aborted,
          onRetry: (connectAttempt, err) => {
            if (debug) debugError(reqId, "upstream_connect_retry", `attempt ${connectAttempt}/${MAX_CONNECT_ATTEMPTS - 1} failed (${err.message}), retrying in ${500 * connectAttempt}ms`);
            console.log(`${reqId} upstream connect failed (${err.message}), retry ${connectAttempt + 1}/${MAX_CONNECT_ATTEMPTS} in ${500 * connectAttempt}ms`);
          },
        },
      );
    } catch (err) {
      // Connect-level failure after the internal ladder while riding a pool
      // proxy: mark it failed so the cooldown skips it on the next pick (the
      // sticky state is cleared synchronously inside markProxyFailed).
      if (lastPoolProxy) {
        const failedUrl = lastPoolProxy;
        lastPoolProxy = null;
        void markProxyFailed(failedUrl).catch(() => {});
      }
      // fork behavior:
      // count it toward the credential-switch threshold and retry with a
      // different account when available — otherwise surface the 502.
      consecutiveCredFailures++;
      hadRetryAttempt = true;
      if (
        attempt < MAX_TOTAL_ATTEMPTS &&
        !(retryCfg.totalDeadlineMs > 0 && Date.now() - retryLoopStartedAt > retryCfg.totalDeadlineMs) &&
        (await maybeSwitchCredential())
      ) {
        continue;
      }
      if (debug) debugError(reqId, "upstream_unreachable", (err as Error).message);
      logResult({ status: 502, headersAt: Date.now(), stats: rowStats() });
      return errorResponse(502, "upstream_unreachable", (err as Error).message);
    }
    headersAt = Date.now();

    if (debug) {
      debugLine(reqId, `← ${upstreamResp.status} ${upstreamResp.statusText}`);
      debugLine(reqId, `  ${formatResponseHeaders(upstreamResp.headers)}`);
    }

    if (dumpEnabled()) {
      dumpPhase(reqId, "upstream_in", {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: dumpHeaders(upstreamResp.headers),
        isSSE: upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false,
        ttfbMs: headersAt - started,
        attempt,
      });
    }

    if (upstreamResp.status === 401 && startPlan) {
      if (debug) debugError(reqId, "start_plan_jwt_invalid", "JWT rejected upstream");
      discardUpstreamBody();
      logResult({ status: 401, headersAt, stats: rowStats() });
      return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
    }

    // start-plan: on explicit captcha challenge, retry once with a fresh
    // pooled token (the challenged token was already consumed by this request;
    // getCaptchaToken takes the next pre-solved one). Detection covers the
    // response-header variant AND the in-body `{"code":3007}` variant via the
    // shared captcha-retry seam (used by /v1/responses too).
    const captcha = startPlan ? await loadCaptcha() : null;
    const captchaChallenge = captcha ? await isCaptchaChallenged(upstreamResp, captcha) : false;
    if (captchaChallenge && captcha) {
      console.log(`${reqId} captcha challenge, re-solving...`);
      const outcome = await retryOnCaptchaChallenge({
        captcha,
        appVersion: config.identity.appVersion,
        challengedResp: upstreamResp,
        debug: debug ? (message) => debugLine(reqId, message) : undefined,
        solveAndRetry: (retryHeaders) => {
          console.log(`${reqId} captcha re-solved (token ${retryHeaders[captcha.RETRY_HEADERS.PARAM].length} chars), retrying...`);
          return dispatch(cred, retryHeaders).then((resp) => {
            if (debug) debugLine(reqId, `← retry ${resp.status} ${resp.statusText}`);
            return resp;
          });
        },
        mapError: (err, phase) => {
          if (phase === "solver") {
            if (debug) debugError(reqId, "captcha_solver_failed", err.message);
            logResult({ status: 503, headersAt: Date.now(), stats: rowStats() });
            return errorResponse(503, "captcha_solver_failed", err.message);
          }
          if (debug) debugError(reqId, "upstream_unreachable", err.message);
          logResult({ status: 502, headersAt: Date.now(), stats: rowStats() });
          return errorResponse(502, "upstream_unreachable", err.message);
        },
      });
      if (!outcome.ok) {
        discardUpstreamBody();
        return outcome.resp;
      }
      upstreamResp = outcome.resp;
    }

    // ---- pool rotation on gateway block (405): the proxy that got WAF-
    // intercepted is marked failed and the request is re-dispatched through
    // a different one while rotations remain (mirrors the proxy-pool.ts
    // header docs). Only pool-served proxies rotate — a per-credential
    // `proxy` override is user-pinned and never rotated here.
    if (lastPoolProxy && PROXY_ROTATE_STATUSES.has(upstreamResp.status)) {
      const failedUrl = lastPoolProxy;
      lastPoolProxy = null;
      void markProxyFailed(failedUrl).catch(() => {});
      const maxRotations = await getMaxRotations();
      if (
        maxRotations > 0 &&
        attempt < MAX_TOTAL_ATTEMPTS &&
        !(retryCfg.totalDeadlineMs > 0 && Date.now() - retryLoopStartedAt > retryCfg.totalDeadlineMs)
      ) {
        poolExcluded.add(failedUrl);
        hadRetryAttempt = true;
        discardUpstreamBody();
        if (poolExcluded.size >= maxRotations) {
          poolRotationsExhausted = true;
          console.log(`${reqId} proxy rotation exhausted (${poolExcluded.size}/${maxRotations}) — falling back to direct`);
        } else {
          console.log(`${reqId} proxy ${egressHost(failedUrl)} gateway-blocked (${upstreamResp.status}) — rotating (${poolExcluded.size}/${maxRotations})`);
        }
        continue;
      }
    }

    // ---- fork: retryable-status handling (529/429/…). Upstream 4.x simply
    // forwarded these; the fork backs off in-process, switches accounts when
    // the threshold hits, and only surfaces the failure at the end.
    if (retryCfg.maxRetries > 0 && retryCfg.retryableStatuses.includes(upstreamResp.status)) {
      consecutiveCredFailures++;
      hadRetryAttempt = true;

      // Wall-clock budget exceeded — stop retrying with a clean 503 so the
      // client can back off (forwarding the last status would invite an
      // immediate client retry against a still-overloaded upstream).
      if (retryCfg.totalDeadlineMs > 0 && Date.now() - retryLoopStartedAt > retryCfg.totalDeadlineMs) {
        console.log(`${reqId} retry total deadline (${retryCfg.totalDeadlineMs}ms) exceeded after ${attempt} attempt(s) — returning 503`);
        discardUpstreamBody();
        logResult({ status: 503, headersAt: Date.now(), stats: rowStats() });
        return new Response(
          JSON.stringify({
            error: {
              type: "retry_deadline_exceeded",
              message: `The upstream kept returning retryable errors for over ${Math.round(retryCfg.totalDeadlineMs / 1000)}s (last status: ${upstreamResp.status}). Please retry later.`,
            },
          }),
          { status: 503, headers: { "content-type": "application/json", "retry-after": "30" } },
        );
      }
      if (attempt >= MAX_TOTAL_ATTEMPTS) {
        console.log(`${reqId} hit MAX_TOTAL_ATTEMPTS cap (${MAX_TOTAL_ATTEMPTS}) — stopping retry loop`);
        break; // hand the last upstream response to the post-loop checks
      }

      // Respect Retry-After (delta-seconds or HTTP-date), capped by maxDelayMs.
      const delayMs = computeRetryDelayMs(attempt, upstreamResp.headers.get("retry-after"));
      console.log(`${reqId} upstream returned ${upstreamResp.status}, retry ${attempt} in ${delayMs}ms${totalAvailableCredentials > 1 ? ` (credential failover available: ${triedApiKeys.size}/${totalAvailableCredentials} tried)` : ""}...`);
      discardUpstreamBody();
      await sleep(delayMs);

      // Client disconnected during backoff — every further attempt is wasted.
      if (clientReq.signal.aborted) {
        console.log(`${reqId} client disconnected during retry backoff`);
        logResult({ status: 499, headersAt: Date.now(), stats: rowStats() });
        return errorResponse(499, "client_disconnected", "Client closed the connection before the response completed");
      }

      // Credential switching on threshold; otherwise retry the same account.
      await maybeSwitchCredential();
      continue;
    }

    // Success (or a non-retryable failure) — leave the retry loop; the
    // response continues to the translation / passthrough path below.
    break;
  }

  // fork: when every stored credential was tried and failed, return 503
  // (non-retryable) instead of forwarding the retryable upstream status —
  // tells clients to STOP hammering.
  if (allCredentialsExhausted && retryCfg.retryableStatuses.includes(upstreamResp.status)) {
    console.log(`${reqId} all credentials exhausted (${triedApiKeys.size}/${totalAvailableCredentials} tried) — returning 503 all_credentials_exhausted`);
    discardUpstreamBody();
    logResult({ status: 503, headersAt, stats: rowStats() });
    return errorResponse(
      503,
      "all_credentials_exhausted",
      `All ${totalAvailableCredentials} stored credential(s) were tried and failed (last upstream status: ${upstreamResp.status}). ` +
        `Add another account or wait for quota to reset — this response is NOT retryable by design.`,
    );
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (translateMode) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      logResult({ status: 502, headersAt, stats: rowStats() });
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      return translatedSseResponse(wireStats(translated, upstreamResp.status, null));
    }
    const { response, tokens } = await translatedBatchResponse(clientReq, upstreamResp, meta.model);
    logResult({ status: response.status, headersAt, tokens });
    return response;
  }

  if (isSSE && upstreamResp.body) {
    return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq), wireStats(upstreamResp.body, upstreamResp.status, upstreamResp.headers.get("content-encoding")));
  }

  logResult({ status: upstreamResp.status, headersAt, stats: rowStats() });
  return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq));
}

/**
 * Upstream statuses treated as a gateway/WAF block for proxy-pool rotation.
 * A 405 from the CDN edge is the documented interception signature (see
 * proxy-pool.ts header docs).
 */
const PROXY_ROTATE_STATUSES = new Set([405]);

/** Host-only rendering of a proxy URL for logs (userinfo never logged). */
function egressHost(proxyUrl: string): string {
  try { return new URL(proxyUrl).host; } catch { return "proxy"; }
}

// ---- emptyStreamSwitchThreshold runtime state ----
// Per-credential streak of consecutive "200 + zero content events" SSE
// streams — the gateway's silent quota-exhaustion shape. Module-level so the
// count survives across requests; cleared on any stream that produced
// content. Bounded: one entry per credential ever seen (pruned at 256).
const emptyStreamStreak = new Map<string, number>();

function bumpEmptyStreamStreak(credKey: string, isEmpty: boolean): number {
  if (!isEmpty) {
    emptyStreamStreak.delete(credKey);
    return 0;
  }
  const next = (emptyStreamStreak.get(credKey) ?? 0) + 1;
  emptyStreamStreak.set(credKey, next);
  if (emptyStreamStreak.size > 256) {
    const oldest = emptyStreamStreak.keys().next().value;
    if (oldest !== undefined) emptyStreamStreak.delete(oldest);
  }
  return next;
}

/** Translate a parsed OpenAI request object to Anthropic. Returns error Response on
 * failure. `parsed` comes from the caller's single parse; `rawBody` is only
 * used for the empty-body check and error text. */
function translateOpenAIBody(parsed: Record<string, unknown> | undefined, rawBody: string | undefined): Response | Record<string, unknown> {
  if (rawBody === undefined || rawBody.length === 0) {
    return errorResponse(400, "translation_failed", "OpenAI request body is empty; cannot translate.");
  }
  if (!parsed) {
    return errorResponse(400, "translation_failed", "OpenAI request body is not valid JSON");
  }
  try {
    return translateRequestOpenAIToAnthropic(parsed as unknown as OpenAIChatRequest) as unknown as Record<string, unknown>;
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI→Anthropic translation failed: ${(err as Error).message}`);
  }
}

function peekBody(parsed: Record<string, unknown> | undefined): RequestMeta {
  if (!parsed) return { model: "-", stream: false };
  return {
    model: typeof parsed.model === "string" ? parsed.model : "-",
    stream: parsed.stream === true,
  };
}
