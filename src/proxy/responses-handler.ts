import { createBackpressuredStream } from "../utils/stream.js";
import { extractSSEData, waitForBackpressure } from "../utils/sse.js";
import { SSEFramer } from "../utils/sse-framer.js";
/**
 * POST /v1/responses request handler.
 *
 * Pipeline:
 *   1. Parse body + credential.
 *   2. Resolve `previous_response_id` via `ResponseStore` (prepend stored history).
 *   3. Translate Responses → Chat Completions (`responsesToChatCompletions`):
 *        - function / custom / namespace / tool_search tools → Chat tools.
 *        - web_search / web_search_preview / file_search / code_interpreter /
 *          computer_use / image_generation / mcp → stripped silently.
 *   4. Apply the standard body transform (stream_options, user_id, start-plan system).
 *   5. POST to the GLM Chat Completions upstream (reuse `buildUpstreamRequest`).
 *   6. Translate the Chat response → Responses (`chatCompletionsToResponses`
 *      or `chatChunkToResponsesEvents` for streaming).
 *   7. Store the new response under its id (unless `store:false`).
 *
 * State management: in-memory only (process restart clears the store); see
 * `responses/store.ts`.
 */
import { transformParsedBody } from "./body-transformer.js";
import { defaultPromptRewriteConfig } from "../config/prompt-rewrite.js";
import { captureSystemPrompt, type PromptRewriteResult } from "./prompt-rewrite.js";
import { beginPromptObservation, recordPromptDispatch } from "./prompt-observation.js";
import { nextReqId } from "./request-log.js";
import { getProvider } from "../provider/providers.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { buildUpstreamRequest, buildUpstreamHeaderPairs, type UpstreamHeaderPair } from "./upstream.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge } from "./captcha-retry.js";
import { dispatchWithConnectRetry } from "./upstream-dispatch.js";
import type * as CaptchaExports from "./captcha.js";

// Lazy, runtime-gated module load (exception to the static-import rule, same
// as handler.ts): pulling captcha.ts eagerly drags in the happy-dom solver, so
// only start-plan — the one plan whose upstream is captcha-gated — pays for it.
type CaptchaModule = typeof CaptchaExports;
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("./captcha.js");
  return captchaModule;
}
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { pickProxy } from "./proxy-pool.js";
import { makeProxiedFetcher } from "./proxied-fetch.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";
import { recordHeaders } from "../utils/header-debug.js";
import { credentialString } from "../auth/types.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse, AnthropicStreamError } from "../translator/sse-translator.js";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import {
  responsesToChatCompletions,
  ToolTranslationError,
} from "../translator/responses-to-chat.js";
import {
  chatCompletionsToResponses,
  chatChunkToResponsesEvents,
  finalizeResponsesStream,
  failResponsesStream,
  newResponsesStreamState,
  responsesEventToSse,
} from "../translator/chat-to-responses.js";
import {
  generateResponsesId,
  type ResponsesInputItem,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  type ResponsesOutputItem,
} from "../translator/responses-types.js";
import { ResponseStore, type StoredResponse } from "../responses/store.js";
import { errorResponse } from "./translated-response.js";
import { readBody, InflatedBodyTooLargeError, RequestBodyTooLargeError } from "./request-body.js";

export interface ResponsesHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Response store; if absent, `previous_response_id` always 404s. */
  responseStore?: ResponseStore;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Verbose per-request diagnostics. */
  debug?: boolean;
  /** Override the process-wide endpoint routing service (for testing). `null` disables. */
  endpointRouting?: EndpointRoutingService | null;
  /** Override the process-wide client signing manager (for testing). `null` disables. */
  clientSigning?: ClientSigningManager | null;
  /** Override the lazily-imported captcha module (for testing). */
  captcha?: CaptchaModule;
}

/** Handle POST /v1/responses. */
export async function handleResponses(
  clientReq: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const debug = opts.debug === true;
  const start = Date.now();

  // ── 1. parse body ──
  let rawBody: string;
  try {
    rawBody = (await readBody(clientReq, opts.config.server?.maxRequestBodyBytes)) ?? "";
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError || err instanceof RequestBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message);
    }
    return errorResponse(400, "invalid_request", `could not read request body: ${(err as Error).message}`);
  }
  let req: ResponsesRequest;
  try {
    req = JSON.parse(rawBody) as ResponsesRequest;
  } catch (err) {
    return errorResponse(400, "invalid_request", `request body is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    return errorResponse(400, "invalid_request", "`input` must be a string or an array");
  }
  if (typeof req.model !== "string" || req.model.length === 0) {
    return errorResponse(400, "invalid_request", "`model` is required");
  }

  const stream = req.stream === true;
  const promptObservation = beginPromptObservation(opts.config, {
    id: nextReqId(), model: req.model, format: "responses", receivedAt: start,
    received: captureSystemPrompt(req as unknown as Record<string, unknown>),
  });

  // ── 2. resolve previous_response_id ──
  let historyItems: ResponsesInputItem[] = [];
  let prevId: string | undefined;
  if (typeof req.previous_response_id === "string" && req.previous_response_id.length > 0) {
    if (!opts.responseStore) {
      return errorResponse(404, "response_store_disabled", "`previous_response_id` was supplied but the response store is not configured");
    }
    const prev = opts.responseStore.get(req.previous_response_id);
    if (!prev) {
      return errorResponse(404, "response_not_found", `previous_response_id ${req.previous_response_id} not found (response store is in-memory; entries are lost on restart and after the TTL)`);
    }
    prevId = req.previous_response_id;
    historyItems = [...prev.input, ...outputItemsAsInputItems(prev.output)];
  }

  // ── 3. translate Responses → Chat Completions ──
  const input: ResponsesInputItem[] = typeof req.input === "string"
    ? [...historyItems, { type: "message", role: "user", content: req.input }]
    : [...historyItems, ...req.input];
  const reqWithHistory: ResponsesRequest = {
    ...req,
    input,
  };
  let translated;
  try {
    translated = responsesToChatCompletions(reqWithHistory);
  } catch (err) {
    if (err instanceof ToolTranslationError) {
      return errorResponse(400, "tool_translation_error", err.message);
    }
    throw err;
  }
  const { chatRequest, customToolNames, namespaceMap, hasToolSearch } = translated;

  // ── 4. credential + provider ──
  let cred;
  try {
    cred = await opts.auth.getCredential();
  } catch (err) {
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }
  const providerDef = resolveProviderDef(opts.config);

  // ── 5. body transform (start-plan system / anthropic cache_control + user_id) ──
  // Both plans post Anthropic upstream (mirrors handler.ts): the start-plan
  // OpenAI gateway was retired server-side (404 as of 2026-08-28), so the
  // Responses → Chat → Anthropic translator chain runs unconditionally.
  // Plan resolution mirrors handler.ts effectivePlanForCred: the credential's
  // own plan (or a start-plan JWT) wins over config.plan — request-local,
  // never mutating the shared config object. `currentPlan` (not config.plan)
  // must feed buildUpstreamHeaderPairs/buildUpstreamRequest too, otherwise a
  // start-plan credential would carry start-plan body transforms but a
  // coding-plan URL/auth scheme.
  // 4.8.0 harden (mirrors handler.ts effectivePlanForCred): a start-plan tag
  // without a JWT degrades to coding-plan — the start-plan plane rejects
  // JWT-less credentials outright.
  const _resolvedPlan = cred.plan ?? (cred.jwt ? "start-plan" : opts.config.plan);
  const currentPlan = _resolvedPlan === "start-plan" && !cred.jwt ? "coding-plan" : _resolvedPlan;
  const startPlan = currentPlan === "start-plan";
  const upstreamFormat: "openai" | "anthropic" = "anthropic";
  let upstreamRequestBody: string;
  let promptRewriteResult: PromptRewriteResult | null = null;
  let upstreamPrompt = captureSystemPrompt(undefined);
  {
    let anthropicReq: AnthropicMessagesRequest;
    try {
      anthropicReq = translateRequestOpenAIToAnthropic(chatRequest);
    } catch (err) {
      return errorResponse(400, "translation_failed", `Chat→Anthropic translation failed: ${(err as Error).message}`);
    }
    // userId mirrors handler.ts for BOTH plans: the bundle's `E2e` is
    // provider-kind gated only (never plan-gated), so start-plan carries the
    // same device/session blob as coding-plan. The /v1/responses path has no
    // client-session resolution — session_id falls back to "" (a legal `bnt`
    // output in the bundle).
    // Object path: the translator just produced anthropicReq — mutate it in
    // place instead of the old stringify→parse→stringify round trip.
    // anthropicReq is not read after this block, so in-place mutation is safe.
    upstreamRequestBody = transformParsedBody(anthropicReq as unknown as Record<string, unknown>, {
      format: "anthropic",
      metadataUserId: buildAnthropicMetadataUserId(opts.config.identity.deviceMid, undefined),
      startPlan,
      provider: opts.config.provider,
      promptRewrite: opts.config.promptRewrite ?? defaultPromptRewriteConfig(),
      onPromptRewrite: (result) => { promptRewriteResult = result; },
    }) ?? JSON.stringify(anthropicReq);
    upstreamPrompt = captureSystemPrompt(anthropicReq as unknown as Record<string, unknown>);
  }
  const transformedBody = upstreamRequestBody;

  // ── 6. POST upstream ──
  // start-plan gates every upstream call behind an Aliyun captcha token. The
  // Anthropic/OpenAI routes mint one in handler.ts; /v1/responses did not, so
  // start-plan users got {"code":3007,"msg":"captcha verify failed"} surfaced
  // as HTTP 400 upstream_error on every request.
  let captchaHeaders: Record<string, string> | undefined;
  if (startPlan) {
    try {
      const captcha = opts.captcha ?? (await loadCaptcha());
      const token = await captcha.getCaptchaToken(opts.config.identity.appVersion);
      captchaHeaders = { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region };
    } catch {
      // Fall through: the 3007 retry below solves on demand.
    }
  }
  const upstreamHeaders = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, currentPlan, captchaHeaders, undefined);
  const upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, providerDef, cred, transformedBody, opts.config.identity, currentPlan, captchaHeaders, undefined);
  if (debug) console.log(`[responses] → POST ${upstreamReq.url}`);

  // Egress proxy wiring (mirrors handler.ts): per-credential override wins,
  // then the global pool. Null → direct fetch (unchanged behavior for
  // unconfigured setups).
  let egressProxy: string | null = cred.proxy?.trim() || null;
  if (!egressProxy) {
    try {
      egressProxy = await pickProxy();
    } catch { /* pool unreadable → direct */ }
  }
  const egressFetch = egressProxy ? makeProxiedFetcher(egressProxy, fetchImpl) : fetchImpl;

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(opts.config);
  const signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(opts.config);
  // header-debug wiring (mirrors handler.ts): first dispatch attempt only.
  const headerDebugOn = opts.config.logging?.headerDebug === true;
  let headerDebugRecorded = false;
  const dispatch = async (pairs: UpstreamHeaderPair[]): Promise<Response> => {
    const routed = routing ? await routing.resolve(upstreamReq.url, credentialString(cred)) : null;
    const sendUrl = routed?.routed ? routed.url : upstreamReq.url;
    if (debug && routed?.routed) console.log(`[responses] endpoint routing: ${upstreamReq.url} -> ${sendUrl}`);
    // signing decisions run against the PRE-routing provider URL (mirrors the
    // client, whose signer wraps the routing transport)
    return sendWithClientSigning(signer, {
      url: upstreamReq.url,
      headerPairs: pairs,
      credential: credentialString(cred),
      appVersion: opts.config.identity.appVersion,
      debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
      send: (finalPairs) => {
        const req = new Request(sendUrl, {
          method: "POST",
          headers: Object.fromEntries(finalPairs),
          body: transformedBody ?? undefined,
        });
        if (headerDebugOn && !headerDebugRecorded) {
          headerDebugRecorded = true;
          recordHeaders(clientReq, req, "responses", "openai-responses", transformedBody, rawBody);
        }
        recordPromptDispatch(opts.config, promptObservation, upstreamPrompt, promptRewriteResult);
        return egressFetch(req, { method: "POST", headers: Object.fromEntries(finalPairs), body: transformedBody ?? undefined, signal: clientReq.signal });
      },
    });
  };

  let upstreamResp: Response;
  try {
    // Connect-retry ladder mirrors the chat hot path (handler.ts): 3 attempts,
    // fresh Request per dispatch (built inside `dispatch`), 500ms×attempt
    // backoff, no retry once the client aborted.
    upstreamResp = await dispatchWithConnectRetry(() => dispatch(upstreamHeaders), {
      isAborted: () => clientReq.signal.aborted,
    });
  } catch (err) {
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }

  // Captcha challenge retry (mirrors handler.ts via the shared captcha-retry
  // seam): the gateway signals it either through the captcha response header
  // or as HTTP 400 with {"code":3007} in the body. The challenged token is
  // already spent, so retry once with a fresh pooled one.
  if (startPlan && !upstreamResp.ok) {
    const captcha = opts.captcha ?? (await loadCaptcha());
    if (await isCaptchaChallenged(upstreamResp, captcha)) {
      if (debug) console.log("[responses] captcha challenge — re-solving and retrying once");
      const outcome = await retryOnCaptchaChallenge({
        captcha,
        appVersion: opts.config.identity.appVersion,
        challengedResp: upstreamResp,
        debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
        solveAndRetry: (retryHeaders) => dispatch(
          buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, currentPlan, retryHeaders, undefined),
        ),
        mapError: (err, phase) =>
          phase === "solver"
            ? errorResponse(503, "captcha_solver_failed", err.message)
            : errorResponse(502, "upstream_unreachable", err.message),
      });
      if (!outcome.ok) return outcome.resp;
      upstreamResp = outcome.resp;
    }
  }

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    return errorResponse(upstreamResp.status, "upstream_error", errText.slice(0, 500) || `upstream returned ${upstreamResp.status}`);
  }

  if (upstreamFormat === "anthropic") {
    // normalize the Anthropic upstream response into the OpenAI Chat shape the
    // downstream Responses translators already consume (SSE + batch)
    if (stream) {
      if (!upstreamResp.body) {
        return errorResponse(502, "translation_failed", "upstream returned no body for stream");
      }
      upstreamResp = new Response(anthropicSseToOpenaiSse(upstreamResp.body, req.model), {
        status: upstreamResp.status,
        headers: { "content-type": "text/event-stream" },
      });
    } else {
      const rawAnthropic = await upstreamResp.text();
      let parsedAnthropic: AnthropicMessagesResponse;
      try {
        parsedAnthropic = JSON.parse(rawAnthropic) as AnthropicMessagesResponse;
      } catch (err) {
        return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
      }
      const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, req.model);
      upstreamResp = new Response(JSON.stringify(openaiResp), {
        status: upstreamResp.status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // ── 8. translate Chat → Responses ──
  const responseId = generateResponsesId();
  const meta = { customToolNames, namespaceMap, hasToolSearch };

  if (stream) {
    return streamResponse(upstreamResp, { responseId, model: req.model, meta, request: req, input, options: opts });
  }

  const rawChatResp = await upstreamResp.text();
  let chatRespJson;
  try {
    chatRespJson = JSON.parse(rawChatResp);
  } catch (err) {
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const responsesResp = chatCompletionsToResponses(chatRespJson, req.model, {
    responseId,
    meta,
    ...(typeof req.instructions === "string" ? { instructions: req.instructions } : {}),
    ...(prevId ? { previousResponseId: prevId } : {}),
  });

  // ── 9. store the response (unless `store:false`) ──
  if (req.store !== false && opts.responseStore) {
    const stored = buildStoredResponse(responsesResp, input, req.instructions);
    opts.responseStore.set(stored);
  }

  if (debug) console.log(`[responses] ← ${responsesResp.status} (${Date.now() - start}ms)`);

  return new Response(JSON.stringify(responsesResp), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ─────────────────────────────────────────────
// Streaming response
// ─────────────────────────────────────────────

interface StreamResponseContext {
  responseId: string;
  model: string;
  meta: { customToolNames: Set<string>; namespaceMap: Map<string, { namespace: string; name: string }>; hasToolSearch: boolean };
  request: ResponsesRequest;
  input: ResponsesInputItem[];
  options: ResponsesHandlerOptions;
}

function streamResponse(upstreamResp: Response, context: StreamResponseContext): Response {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream");
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });

  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const stream = createBackpressuredStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = async (evt: ResponsesStreamEvent) => {
        await waitForBackpressure(controller);
        if (cancelled) return;
        controller.enqueue(encoder.encode(responsesEventToSse(evt)));
      };
      try {
        if (cancelled) return;
        const reader = upstreamResp.body!.getReader();
        upstreamReader = reader;
        const decoder = new TextDecoder();
        const framer = new SSEFramer();
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          const frames = done ? framer.finish(decoder.decode()) : framer.push(decoder.decode(value, { stream: true }));
          for (const frame of frames) {
            const dataLine = extractSSEData(frame);
            if (!dataLine || dataLine === "[DONE]") continue;
            const chunk = JSON.parse(dataLine);
            for (const evt of chatChunkToResponsesEvents(chunk, state)) await send(evt);
          }
          if (done) break;
        }
        if (cancelled) return;
        const finalEvents = finalizeResponsesStream(state);
        for (const evt of finalEvents) await send(evt);
        if (cancelled) return;
        const finalEvent = finalEvents.find((evt) => evt.type === "response.completed" || evt.type === "response.incomplete");
        if (finalEvent && context.request.store !== false && context.options.responseStore) {
          context.options.responseStore.set(buildStoredResponse(finalEvent.response, context.input, context.request.instructions));
        }
        try { controller.close(); } catch {}
      } catch (err) {
        if (cancelled) return;
        try {
          for (const evt of failResponsesStream(state, {
            code: err instanceof AnthropicStreamError ? err.code : "upstream_error",
            message: err instanceof Error ? err.message : String(err),
          })) await send(evt);
          controller.close();
        } catch { try { controller.error(err); } catch {} }
      } finally {
        if (upstreamReader) {
          void upstreamReader.cancel().catch(() => {});
          try { upstreamReader.releaseLock(); } catch {}
          upstreamReader = undefined;
        }
      }
    },
    cancel(reason) {
      context.options.debug === true && console.log(`[responses] stream cancelled: ${String(reason)}`);
      cancelled = true;
      void (upstreamReader ? upstreamReader.cancel(reason) : upstreamResp.body?.cancel(reason))?.catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function resolveProviderDef(config: ProxyConfig): ProviderDef & { openaiBaseURL: string; anthropicBaseURL: string } {
  const base = getProvider(config.provider);
  const endpoints = config.providers[config.provider];
  return {
    ...base,
    anthropicBaseURL: endpoints.anthropicBase,
    openaiBaseURL: endpoints.openaiBase,
  };
}

/**
 * Cast stored output items back into input items so the next turn's history is
 * a flat list the translator can walk. Responses output and input item shapes
 * overlap enough that a structural cast is sound (the fields we read — `type`,
 * `call_id`, `name`, `arguments`, `content`, `role` — are shared).
 */
function outputItemsAsInputItems(outputs: ResponsesOutputItem[]): ResponsesInputItem[] {
  return outputs as unknown as ResponsesInputItem[];
}

function buildStoredResponse(
  resp: ResponsesResponse,
  input: ResponsesInputItem[],
  instructions: string | undefined,
): StoredResponse {
  return {
    id: resp.id,
    model: resp.model,
    status: (resp.status === "completed" || resp.status === "incomplete" || resp.status === "failed" ? resp.status : "completed"),
    input,
    output: resp.output,
    usage: resp.usage,
    instructions,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
}
