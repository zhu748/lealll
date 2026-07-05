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
 * === HEADER WHITELIST (v0.2.3+, verified 2026-06-28 vs app.asar
 *     Mf() offset 886853 + SDK literal offset 1085109 + yU offset 887429) ===
 *
 * The upstream request carries ONLY headers the real ZCode desktop client
 * actually sends — nothing else. We do NOT passthrough ANY header from the
 * downstream client (Claude Code, Codex, Cherry Studio, curl, browser, …).
 * This is a strict whitelist: anything not on the list is dropped by
 * construction (we never read it from the inbound request in the first place).
 *
 * Whitelist (explicit model-provider headers; transport may reorder them on
 * the actual wire):
 *
 *   1.  content-type             : application/json
 *   2.  x-api-key | authorization : <upstream credential>     (format-dependent, mutually exclusive)
 *   3.  anthropic-beta           : mid-conversation-system-2026-04-07 (Anthropic upstream only)
 *   4.  anthropic-version        : 2023-06-01                  (Anthropic upstream only)
 *   5.  User-Agent               : ZCode/{appVersion} ai-sdk/provider-utils/4.0.27 runtime/node.js/24
 *   6.  HTTP-Referer             : https://zcode.z.ai
 *   7.  X-ZCode-App-Version      : {appVersion}                 (ONLY when printable)
 *   8.  X-Title                  : Z Code@electron
 *   9.  X-ZCode-Agent            : glm
 *   10. X-Platform               : {platform}-{arch}             (e.g. win32-x64)
 *   11. X-Os-Category            : macos | windows | linux
 *   12. X-Os-Version             : {os.release()}                (ONLY when non-empty)
 *   13. x-request-id             : <fresh UUIDv4 per request attempt>
 *   14. x-zcode-trace-id         : <stable UUIDv4 per credential>  (start-plan only)
 *   15. x-query-id               : <fresh UUIDv4 per user query>   (start-plan only)
 *   16. x-session-id             : <stable UUIDv4 per credential>  (start-plan only)
 *
 * Auto-added by fetch/transport (do NOT set manually):
 *   - host (from URL)
 *   - content-length (from body)
 *   - accept-encoding (fetch picks `gzip, deflate, br` based on what the
 *     runtime supports — matches the real client's auto-added value)
 *
 * IMPORTANT CORRECTIONS vs v0.2.2 (verified against the 2026-06-28 unpacking):
 *
 *   1. MODEL PROVIDER IDENTITY: model requests are built by the GLM agent
 *      `$yo() + WOr()` path, not by the desktop host's full
 *      buildZCodeSourceHeaders() path. Do not send host-only language,
 *      timezone, release channel, or device-mid headers on /v1/messages.
 *
 *   2. ACCEPT HEADER: v0.2.2 explicitly set `accept: text/event-stream`.
 *      The real client DOES NOT send this header at all on /v1/messages
 *      traffic. Sending it was itself a fingerprint mismatch. Removed.
 *
 *   3. ACCEPT-ENCODING: v0.2.2 explicitly set `accept-encoding: gzip`.
 *      The real client lets the runtime auto-add this (fetch picks
 *      `gzip, deflate, br` based on what the runtime supports). Hardcoding
 *      `gzip` overrode the runtime default and was a fingerprint mismatch.
 *      We no longer set it; fetch adds it automatically.
 *
 *   4. X-OS-VERSION: desktop host source headers use os.version(), but the
 *      GLM model-provider path uses os.release() via WOr(). Upstream model
 *      requests now use that agent-specific value.
 *
 * `extraHeaders` is the ONLY way for trusted internal subsystems
 * to inject headers upstream. It is reserved for proxy-internal use — never
 * for passthrough of client headers. The start-plan captcha challenge path uses
 * this hook only after upstream returns an explicit Aliyun 3007 response, unless
 * the operator has not explicitly disabled preflight with
 * ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT=0.
 *
 * PASSTHROUGH / POLICY NOTES (real client wire capture, 2026-06-28):
 *   - anthropic-beta            ✅ fixed ZCode value only; downstream values are never passed through
 *   - x-session-id              ✅ start-plan only, dynamic attribution
 *   - x-query-id                ✅ start-plan only, dynamic attribution
 *   - x-zcode-trace-id          ✅ start-plan only, dynamic attribution
 *   - x-aliyun-captcha-*        ❌ from downstream clients; ✅ only after
 *                                  an explicit start-plan 3007 challenge, or
 *                                  during ZCode-aligned preflight
 *   - X-ZCode-Agent             ✅ official GLM agent provider marker
 *   - accept                    ❌ (not on /v1/messages; was a v0.2.2 bug)
 *   - any x-stainless-*         ❌ (Anthropic SDK fingerprint)
 *   - any x-claude-* / x-claude-code-*  ❌ (Claude Code CLI fingerprint)
 */
import type { Format } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildAgentIdentityHeaders } from "./identity.js";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "mid-conversation-system-2026-04-07";

const ALIYUN_CAPTCHA_HEADERS = new Set([
  "x-aliyun-captcha-verify-param",
  "x-aliyun-captcha-verify-region",
]);

const STARTPLAN_ANTHROPIC_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

function normalizeBearerHeader(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

interface StartPlanAttributionContext {
  sessionId: string;
  traceId: string;
}

export interface StartPlanRequestAttributionContext {
  queryId: string;
}

export function createStartPlanRequestAttributionContext(): StartPlanRequestAttributionContext {
  return { queryId: crypto.randomUUID() };
}

const MAX_STARTPLAN_ATTRIBUTION_CONTEXTS = 512;
const startPlanAttributionByCredential = new Map<string, StartPlanAttributionContext>();

function startPlanCredentialKey(cred: Credential): string {
  return `${cred.provider}:${cred.userId ?? cred.email ?? cred.jwt ?? cred.apiKey}`;
}

function getStartPlanAttributionContext(cred: Credential): StartPlanAttributionContext {
  const key = startPlanCredentialKey(cred);
  let cached = startPlanAttributionByCredential.get(key);
  if (cached) {
    startPlanAttributionByCredential.delete(key);
    startPlanAttributionByCredential.set(key, cached);
    return cached;
  }

  while (startPlanAttributionByCredential.size >= MAX_STARTPLAN_ATTRIBUTION_CONTEXTS) {
    const oldest = startPlanAttributionByCredential.keys().next().value;
    if (oldest === undefined) break;
    startPlanAttributionByCredential.delete(oldest);
  }

  cached = {
    sessionId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  };
  startPlanAttributionByCredential.set(key, cached);
  return cached;
}

export function _clearStartPlanAttributionContextsForTesting(): void {
  startPlanAttributionByCredential.clear();
}

export function _startPlanAttributionContextCountForTesting(): number {
  return startPlanAttributionByCredential.size;
}

function buildStartPlanAttributionHeaders(
  cred: Credential,
  requestContext?: StartPlanRequestAttributionContext,
): Record<string, string> {
  const ctx = getStartPlanAttributionContext(cred);
  return {
    "x-zcode-trace-id": ctx.traceId,
    "x-query-id": requestContext?.queryId ?? crypto.randomUUID(),
    "x-session-id": ctx.sessionId,
  };
}

/**
 * Derive the client IP for logging/diagnostics only. It is never used to
 * derive upstream attribution headers.
 *
 * vceshi0.0.8+ SECURITY: previously this read X-Forwarded-For unconditionally
 * to key a session-ID cache; any client could spoof XFF to share/pollute
 * another user's upstream session. The session cache is gone now, but the IP
 * resolution is retained for diagnostics and (if re-introduced) should honor:
 *   1. The TCP socket peer address (via resolveClientIp, wired to Bun's
 *      server.requestIP) — un-spoofable, the default in production.
 *   2. X-Forwarded-For / X-Real-IP ONLY when the operator has explicitly
 *      opted in via `config.server.trustProxy = true`.
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
 * The `format` parameter is the *upstream* format — callers in handler.ts
 * pass the format the upstream will receive, which may differ from the
 * client's inbound format when the proxy is in translation mode.
 */
export function buildUpstreamURL(format: Format, provider: ProviderDef, plan: "coding-plan" | "start-plan" = "coding-plan"): string {
  if (plan === "start-plan") {
    return `${STARTPLAN_ANTHROPIC_BASE}/v1/messages`;
  }
  if (format === "anthropic") {
    return `${provider.anthropicBaseURL}/v1/messages`;
  }
  return `${provider.openaiBaseURL}/chat/completions`;
}

/**
 * Build the COMPLETE upstream header set (content-type + auth + GLM agent
 * model-provider identity + trace).
 *
 * This is a strict whitelist — no client header is read or passthrough'd.
 * See the module-level header comment for the full whitelist rationale.
 *
 * `extraHeaders` is layered LAST so trusted internal subsystems can override
 * transport headers if needed; it is never used for client passthrough.
 */
export function buildUpstreamHeaders(
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
  startPlanRequestContext?: StartPlanRequestAttributionContext,
): Record<string, string> {
  const credStr = credentialString(cred);
  const startPlanAuthorization = plan === "start-plan"
    ? normalizeBearerHeader(cred.jwt ?? credStr)
    : undefined;
  const id = buildAgentIdentityHeaders(identity);

  // Build the explicit whitelist. The set matches the GLM agent model
  // provider path from zcode.cjs ($yo + WOr + model attribution headers).
  //
  //   content-type → auth → anthropic-version → agent identity block → x-request-id
  //
  // We construct the object key-by-key rather than spreading, so the
  // insertion order is stable for tests and for transports that preserve it.
  //
  // NOTE on header name case: HTTP/2 (which z.ai uses via Cloudflare) forces
  // lowercase on the wire regardless of what we set. We use the real
  // client's case (mixed case for identity headers, lowercase for transport
  // headers) so that an HTTP/1.1 connection would match byte-for-byte;
  // under HTTP/2 the case is normalized away by the protocol.
  const headers: Record<string, string> = {};

  // === 1. content-type (FIRST — matches real client wire order) ===
  headers["content-type"] = "application/json";

  // === 2. auth (x-api-key OR authorization, mutually exclusive) ===
  if (format === "anthropic") {
    if (plan === "start-plan") {
      // Official start-plan providers store the JWT in provider.apiKey and the
      // runtime converts it to Authorization: Bearer <jwt>. Our imported OAuth
      // credentials keep the same value in cred.jwt; manual/API-key mode may
      // only have it as apiKey, so normalize either source here.
      if (startPlanAuthorization) headers["authorization"] = startPlanAuthorization;
    } else {
      headers["x-api-key"] = credStr;
    }
    // === 3. anthropic-beta (Anthropic upstream only) ===
    // Real ZCode 3.1.8/3.2.5 sends exactly this beta flag on /v1/messages.
    // Never pass through downstream beta lists (Claude Code sends many
    // claude-code-* flags that are a fingerprint mismatch).
    headers["anthropic-beta"] = ANTHROPIC_BETA;

    // === 4. anthropic-version (Anthropic upstream only) ===
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    // OpenAI upstream: auth via Bearer, no anthropic-version
    headers["authorization"] = `Bearer ${credStr}`;
  }

  // === 4-12. GLM agent model-provider identity block ===
  // This intentionally differs from the desktop host/source headers used for
  // /api/v1/client/configs. Real model requests do not carry language,
  // timezone, release-channel, or deviceMid headers.
  headers["http-referer"] = id["HTTP-Referer"];
  headers["user-agent"] = id["User-Agent"];
  if (id["X-ZCode-App-Version"]) {
    headers["x-zcode-app-version"] = id["X-ZCode-App-Version"];
  }
  headers["x-title"] = id["X-Title"];
  headers["x-zcode-agent"] = id["X-ZCode-Agent"];
  headers["x-platform"] = id["X-Platform"];
  headers["x-os-category"] = id["X-Os-Category"];
  if (id["X-Os-Version"]) {
    headers["x-os-version"] = id["X-Os-Version"];
  }

  // === 16. x-request-id (LAST — fresh UUIDv4 per request attempt) ===
  headers["x-request-id"] = crypto.randomUUID();

  // === 17-19. Start-plan attribution headers ===
  // The current ZCode GLM adapter merges createModelRequestAttributionHeaders()
  // into every model request. It always includes x-request-id and
  // x-zcode-trace-id, plus session/query when a ZCode task context exists.
  // Official ZCode creates session ids as `sess_${uuid}` and query ids as
  // `query_${uuid}`, then strips those prefixes before sending headers. We
  // mirror the observable wire shape: stable session/trace IDs per upstream
  // credential, a query id that is stable for one user request, and a fresh
  // request id for each retry attempt (matches the bundle's Fde() behavior).
  if (plan === "start-plan") {
    Object.assign(headers, buildStartPlanAttributionHeaders(cred, startPlanRequestContext));
  }

  // NOTE: accept-encoding and host and content-length are NOT set here —
  // they are auto-added by fetch/transport. Hardcoding accept-encoding:gzip
  // (as v0.2.2 did) overrode the runtime default `gzip, deflate, br` and
  // was itself a fingerprint mismatch.

  // === Trusted internal subsystems ===
  // Layered LAST so they can override anything above if explicitly needed.
  // Never used for client passthrough — that path does not exist.
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      const lower = k.toLowerCase();
      // Aliyun captcha headers are never passed through from the downstream
      // client. For start-plan only, handler.ts may inject freshly solved
      // runtime headers during ZCode-aligned preflight, or after a 3007
      // challenge when preflight is explicitly disabled.
      // The verify param is one-shot, so callers must pass a fresh value for
      // every attempt that includes these headers.
      if (ALIYUN_CAPTCHA_HEADERS.has(lower) && plan !== "start-plan") continue;
      headers[lower] = v;
    }
  }

  return headers;
}

/**
 * Backwards-compatible auth-headers builder. Returns the identity + auth +
 * anthropic-version headers (NO content-type, NO request/trace attribution,
 * NO transport headers). Kept for callers (and tests) that only need the auth
 * + identity portion. Returned key order matches buildUpstreamHeaders (within
 * the subset returned).
 */
export function buildAuthHeaders(
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  /**
   * Retained for API stability (callers in handler.ts pass it) but no longer
   * used by this legacy helper. Full upstream requests add start-plan
   * attribution in buildUpstreamHeaders().
   */
  clientFingerprintStr?: string,
): Record<string, string> {
  void clientFingerprintStr;
  // Delegate to the full whitelist builder, then strip the headers this
  // legacy helper doesn't include (content-type, x-request-id, transport).
  const full = buildUpstreamHeaders(format, cred, identity, plan);
  const stripped: Record<string, string> = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === "content-type" || k === "x-request-id" || k === "x-zcode-trace-id" || k === "x-query-id" || k === "x-session-id") continue;
    stripped[k] = v;
  }
  return stripped;
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
   * NOTE: as of the whitelist rework (v0.2.2+) it is no longer used to derive
   * any upstream attribution header AND no longer used to read client headers
   * (the whitelist ignores them entirely). Kept in the signature for API
   * stability; the value is intentionally unused for header construction.
   */
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
  startPlanRequestContext?: StartPlanRequestAttributionContext,
): Request {
  // Resolve and discard — kept for API symmetry. No client IP/header value is
  // used to derive upstream attribution; start-plan session/query/trace are
  // generated from ZCode-like runtime context instead.
  void clientIp(clientReq, resolveClientIp, trustProxy);
  const url = buildUpstreamURL(format, provider, plan);
  // Strict whitelist — does NOT read clientReq.headers.
  const headers = buildUpstreamHeaders(format, cred, identity, plan, extraHeaders, startPlanRequestContext);

  const init: RequestInit = {
    method: "POST",
    headers,
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
