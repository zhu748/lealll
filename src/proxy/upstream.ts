/**
 * Upstream request builder — constructs the forwarded HTTP request.
 *
 * **`format` semantics**: This is the *upstream* format — the format used to
 * talk to the upstream LLM provider, not the client's inbound format. When
 * `handler.ts` translates an OpenAI client request to Anthropic upstream in
 * coding-plan mode, it passes `"anthropic"` here even though the client
 * originally spoke OpenAI. The route's format is tracked separately in
 * `handler.ts` for response translation decisions.
 *
 * === v0.3.7 (zcode.z.ai gateway endpoint removal, 2026-08-27) ===
 *
 *   1. START-PLAN ENDPOINT: the OpenAI gateway path
 *      `/api/v1/zcode-plan/chat/completions` was REMOVED server-side —
 *      every request returns Go's default "404 page not found" (verified
 *      live). start-plan now routes through the Anthropic mirror
 *      `/api/v1/zcode-plan/anthropic/v1/messages` (verified live: 401
 *      without auth = registered, auth-gated route). This is the pre-v0.3.0
 *      behavior, restored. ZCODE_STARTPLAN_UPSTREAM=openai restores the
 *      legacy gateway URL/pipeline if the endpoint ever returns.
 *
 * === v0.3.0 (upstream zcode-api v2.6.0 alignment, ZCode 3.9.x wire shape) ===
 *
 *   1. START-PLAN ENDPOINT: start-plan switched to the zcode.z.ai OpenAI
 *      gateway (`/api/v1/zcode-plan/chat/completions`) — superseded by the
 *      v0.3.7 restoration above (endpoint removed server-side).
 *
 *   2. IDENTITY BLOCK: model requests carry the FULL `pio` header set
 *      (see identity.ts) — the June-2026 narrow agent set is obsolete.
 *
 *   3. TRACE/ATTRIBUTION HEADERS: the per-credential LRU attribution cache is
 *      replaced by the upstream session-context system (client-session.ts +
 *      trace-headers.ts) which replicates ZCode's single-user-identity UUID
 *      generation and emits `x-zcode-session-type` on every model request.
 *
 *   4. ACCEPT-ENCODING: v0.3.8.1 — model requests advertise `identity`
 *      (the real ZCode Tauri client's value, per upstream wire captures)
 *      instead of forwarding the client's value. Forwarding gzip made the
 *      zcode.z.ai ESA edge compress SSE passthrough bodies, silently killing
 *      the token-stats observer, the SSE heartbeat, and in-stream error
 *      detection (see runtime-options.ts upstreamAcceptEncoding). Env
 *      escape hatch: ZCODE_UPSTREAM_ACCEPT_ENCODING.
 *
 * === HEADER WHITELIST (local fork policy, kept from v0.2.3+) ===
 *
 * The upstream request carries ONLY headers the real ZCode desktop client
 * actually sends — nothing else. We do NOT passthrough ANY header from the
 * downstream client (Claude Code, Codex, Cherry Studio, curl, browser, …)
 * except `accept-encoding` (see above). This is a strict whitelist: anything
 * not on the list is dropped by construction (we never read it from the
 * inbound request in the first place).
 *
 * Whitelist (explicit model-provider headers; transport may reorder them on
 * the actual wire):
 *
 *   1.  content-type             : application/json
 *   2.  accept-encoding          : identity (ZCODE_UPSTREAM_ACCEPT_ENCODING override)
 *   3.  anthropic-beta           : mid-conversation-system-2026-04-07 (Anthropic upstream only, fixed ZCode value)
 *   4.  anthropic-version        : 2023-06-01                       (Anthropic upstream only)
 *   5.  x-api-key | authorization: <upstream credential>            (format/plan dependent)
 *   6.  HTTP-Referer → User-Agent → [X-ZCode-App-Version] → X-Title → X-ZCode-Agent →
 *       X-Platform → [X-Release-Channel] → X-Client-Language → X-Client-Timezone →
 *       X-Os-Category → [X-Os-Version] → [X-Device-Mid]                (identity block, pio order)
 *   7.  x-request-id / x-zcode-session-type / x-zcode-trace-id / [x-query-id / x-session-id]
 *                                                               (attribution block — synthetic or
 *                                                                session-context exact)
 *   8.  x-aliyun-captcha-verify-param / x-aliyun-captcha-verify-region (start-plan only,
 *       injected via extraHeaders by the captcha pool)
 *
 * PASSTHROUGH / POLICY NOTES (real client wire captures):
 *   - anthropic-beta            ✅ fixed ZCode value only; downstream values are never passed through
 *   - accept                    ❌ (not on model requests; was a v0.2.2 bug)
 *   - any x-stainless-*         ❌ (Anthropic SDK fingerprint)
 *   - any x-claude-* / x-claude-code-*  ❌ (Claude Code CLI fingerprint)
 *   - any x-client-*            ❌ (V4 signing headers are proxy-generated only; inbound
 *                                  copies must never reach the upstream — spoofed values would
 *                                  either fail verification or silently disable proxy signing)
 *
 * `extraHeaders` is the ONLY way for trusted internal subsystems to inject
 * headers upstream. It is reserved for proxy-internal use — never for
 * passthrough of client headers. The start-plan captcha path uses this hook
 * with pool-pre-solved tokens.
 */
import type { Format } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildIdentityHeaders } from "./identity.js";
import { buildZcodeTraceHeaders } from "./trace-headers.js";
import { sessionIdForHeader, shouldUseExactTraceHeaders, type SessionHeaderContext } from "./session-context.js";
import { startPlanUpstreamStyle, upstreamAcceptEncoding } from "./runtime-options.js";

export interface UpstreamClientSession {
  source?: "none" | "explicit" | "lineage";
  action: "off" | "observe" | "enforce";
  sessionId?: string;
  upstreamSessionId?: string;
  requestId?: string;
  traceId?: string;
  queryId?: string;
}

export type UpstreamHeaderPair = [string, string];

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "mid-conversation-system-2026-04-07";

const ALIYUN_CAPTCHA_HEADERS = new Set([
  "x-aliyun-captcha-verify-param",
  "x-aliyun-captcha-verify-region",
]);

const STARTPLAN_ANTHROPIC_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
const STARTPLAN_OPENAI_BASE = "https://zcode.z.ai/api/v1/zcode-plan";

function normalizeBearerHeader(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/**
 * Derive the client IP for logging/diagnostics only. It is never used to
 * derive upstream attribution headers.
 *
 * SECURITY: previously this read X-Forwarded-For unconditionally. The
 * resolution honors: (1) the TCP socket peer address (via resolveClientIp,
 * wired to Bun's server.requestIP) — un-spoofable, the default in production;
 * (2) X-Forwarded-For / X-Real-IP ONLY when the operator has explicitly
 * opted in via `config.server.trustProxy = true`.
 */
function clientIp(
  req: Request,
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
): string {
  if (resolveClientIp) {
    try {
      const ip = resolveClientIp(req);
      if (ip) return ip;
    } catch { /* ignore */ }
  }
  if (trustProxy) {
    const xRealIp = req.headers.get("x-real-ip");
    if (xRealIp) return xRealIp;
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return "";
}

/**
 * Build the upstream URL based on format + plan + provider.
 *
 * v0.3.7: start-plan uses the zcode.z.ai Anthropic mirror — the OpenAI
 * gateway path was removed server-side (404) around 2026-08-27.
 * coding-plan mirrors the real ZCode client — Anthropic upstream
 * (api.z.ai/api/anthropic, possibly remapped to the ultra endpoint by
 * endpoint-routing.ts at dispatch time). ZCODE_STARTPLAN_UPSTREAM=openai
 * restores the legacy v0.3.0 gateway URL.
 */
export function buildUpstreamURL(format: Format, provider: ProviderDef, plan: "coding-plan" | "start-plan" = "coding-plan"): string {
  if (plan === "start-plan") {
    return startPlanUpstreamStyle() === "openai"
      ? `${STARTPLAN_OPENAI_BASE}/chat/completions`
      : `${STARTPLAN_ANTHROPIC_BASE}/v1/messages`;
  }
  if (format === "anthropic") {
    return `${provider.anthropicBaseURL}/v1/messages`;
  }
  return `${provider.openaiBaseURL}/chat/completions`;
}

/**
 * Attribution/trace headers.
 *
 * Exact path (start-plan, or explicit/enforced client session): mirrors the
 * bundle's `Bdt` ("createModelRequestAttributionHeaders") — strips the
 * `query_`/`sess_`/`subagent_agent_` internal prefixes and infers
 * `x-zcode-session-type` (main/subagent) from the session id.
 *
 * Synthetic path (coding-plan observe mode): fresh UUIDs per request plus
 * `x-zcode-session-type: main` — ZCode 3.9.1 attributes every model request.
 */
function buildTraceHeaders(plan: "coding-plan" | "start-plan", clientSession?: UpstreamClientSession): Record<string, string> {
  if (shouldUseExactTraceHeaders(plan, clientSession as SessionHeaderContext | undefined)) {
    return buildZcodeTraceHeaders({
      requestId: clientSession?.requestId,
      traceId: clientSession?.traceId,
      queryId: clientSession?.queryId,
      sessionId: sessionIdForHeader(clientSession as SessionHeaderContext | undefined),
    });
  }

  const headers: Record<string, string> = {
    "x-request-id": crypto.randomUUID(),
    // ZCode 3.9.1 attributes every model request; a forwarded conversation turn is the main-agent loop.
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": crypto.randomUUID(),
  };
  if (plan !== "start-plan") {
    headers["x-query-id"] = crypto.randomUUID();
    headers["x-session-id"] = crypto.randomUUID();
  }
  return headers;
}

/**
 * Build auth + identity + trace headers for the upstream request.
 *
 * Auth scheme selection:
 * - Anthropic upstream, coding-plan → `x-api-key: {cred}` + `anthropic-version`
 * - Anthropic upstream, start-plan  → `Authorization: Bearer {jwt}` + `anthropic-version`
 *                                         (v0.3.7 default — zcode.z.ai mirror)
 * - OpenAI upstream, coding-plan    → `Authorization: Bearer {cred}`
 * - OpenAI upstream, start-plan     → `Authorization: Bearer {jwt}`
 *                                         (legacy ZCODE_STARTPLAN_UPSTREAM=openai)
 */
export function buildAuthHeaders(
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  clientSession?: UpstreamClientSession,
): Record<string, string> {
  const credStr = plan === "start-plan" && cred.jwt ? cred.jwt : credentialString(cred);
  const startPlanAuthorization = plan === "start-plan"
    ? normalizeBearerHeader(cred.jwt ?? credentialString(cred))
    : undefined;

  // Identity block first (pio order), then attribution/trace headers, then
  // auth — matches the current bundle's assembly order.
  const headers: Record<string, string> = {
    ...buildIdentityHeaders(identity),
    ...buildTraceHeaders(plan, clientSession),
  };

  if (format === "anthropic") {
    if (plan === "start-plan") {
      // Official start-plan providers store the JWT in provider.apiKey and the
      // runtime converts it to Authorization: Bearer <jwt>. Imported OAuth
      // credentials keep the same value in cred.jwt; manual/API-key mode may
      // only have it as apiKey, so normalize either source here.
      if (startPlanAuthorization) headers["authorization"] = startPlanAuthorization;
    } else {
      headers["x-api-key"] = credStr;
    }
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    headers["authorization"] = `Bearer ${credStr}`;
  }

  return headers;
}

/**
 * Build the COMPLETE upstream header set as ordered pairs.
 *
 * This is a strict whitelist — no client header is read at all. In
 * particular `accept-encoding` is NOT forwarded from the client: the value
 * sent upstream is the proxy's own fingerprint decision (identity by
 * default — matches the real ZCode desktop client; see
 * runtime-options.ts upstreamAcceptEncoding).
 *
 * `extraHeaders` is layered LAST so trusted internal subsystems can override
 * transport headers if needed; it is never used for client passthrough.
 */
export function buildUpstreamHeaderPairs(
  clientReq: Request,
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
  clientSession?: UpstreamClientSession,
): UpstreamHeaderPair[] {
  void clientReq; // kept in the signature for call-site stability
  const pairs: UpstreamHeaderPair[] = [
    ["content-type", "application/json"],
    ["accept-encoding", upstreamAcceptEncoding()],
  ];

  // Fixed ZCode beta flag on Anthropic upstream only. Never pass through
  // downstream beta lists (Claude Code sends many claude-code-* flags that
  // are a fingerprint mismatch).
  if (format === "anthropic") {
    pairs.push(["anthropic-beta", ANTHROPIC_BETA]);
  }

  for (const [k, v] of Object.entries(buildAuthHeaders(format, cred, identity, plan, clientSession))) {
    pairs.push([k, v]);
  }

  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    const lower = k.toLowerCase();
    // Aliyun captcha headers are never passed through from the downstream
    // client. For start-plan only, handler.ts injects freshly pool-solved
    // runtime headers. The verify param is one-shot, so callers must pass a
    // fresh value for every attempt that includes these headers.
    if (ALIYUN_CAPTCHA_HEADERS.has(lower) && plan !== "start-plan") continue;
    pairs.push([lower, v]);
  }

  return pairs;
}

/**
 * Back-compat entry: returns the header pairs as a plain record. Kept for
 * callers and tests that want the map form (insertion order preserved).
 */
export function buildUpstreamHeaders(
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
  clientSession?: UpstreamClientSession,
): Record<string, string> {
  const pairs = buildUpstreamHeaderPairs(
    // buildUpstreamHeaders historically did not read the client request; the
    // accept-encoding passthrough needs one, so synthesize a bare request
    // carrying no accept-encoding header (falls back to the "gzip" default).
    new Request("http://internal.invalid/", { method: "POST" }),
    format,
    cred,
    identity,
    plan,
    extraHeaders,
    clientSession,
  );
  return Object.fromEntries(pairs);
}

export function buildUpstreamRequest(
  clientReq: Request,
  format: Format,
  provider: ProviderDef,
  cred: Credential,
  body: string | undefined,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
  /**
   * vceshi0.0.8+: socket-aware client IP resolver, retained for diagnostics.
   * Not used to derive any upstream attribution header (the whitelist ignores
   * client headers entirely). Kept in the signature for API stability.
   */
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
  clientSession?: UpstreamClientSession,
): Request {
  // Resolve and discard — kept for API symmetry. No client IP/header value is
  // used to derive upstream attribution; attribution comes from the
  // session-context system instead.
  void clientIp(clientReq, resolveClientIp, trustProxy);
  const url = buildUpstreamURL(format, provider, plan);
  const headerPairs = buildUpstreamHeaderPairs(clientReq, format, cred, identity, plan, extraHeaders, clientSession);

  const init: RequestInit = {
    method: "POST",
    headers: Object.fromEntries(headerPairs),
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
