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
 * Whitelist (sent in this exact wire order, mirroring the real ZCode client):
 *
 *   1.  content-type             : application/json
 *   2.  x-api-key | authorization : <upstream credential>     (format-dependent, mutually exclusive)
 *   3.  anthropic-version        : 2023-06-01                  (Anthropic upstream only)
 *   4.  User-Agent               : ZCode/{appVersion}
 *   5.  HTTP-Referer             : https://zcode.z.ai
 *   6.  X-Title                  : Z Code@electron
 *   7.  X-ZCode-App-Version      : {appVersion}
 *   8.  X-Platform               : {platform}-{arch}           (e.g. win32-x64)
 *   9.  X-Release-Channel        : {channel}                   (ONLY when non-empty)
 *   10. X-Client-Language        : {Intl locale}                (e.g. zh-CN)
 *   11. X-Client-Timezone        : {Intl timeZone}              (e.g. Asia/Shanghai)
 *   12. X-Os-Category            : macos | windows | linux
 *   13. X-Os-Version             : {os.version()}               (ONLY when non-empty)
 *   14. X-ZCode-Agent            : glm                           (start-plan only)
 *   15. x-request-id             : <fresh UUIDv4 per request>
 *   16. x-zcode-trace-id         : <stable UUIDv4 per credential>  (start-plan only)
 *   17. x-query-id               : <fresh UUIDv4 per request>      (start-plan only)
 *   18. x-session-id             : <stable UUIDv4 per credential>  (start-plan only)
 *
 * Auto-added by fetch/transport (do NOT set manually):
 *   - host (from URL)
 *   - content-length (from body)
 *   - accept-encoding (fetch picks `gzip, deflate, br` based on what the
 *     runtime supports — matches the real client's auto-added value)
 *
 * IMPORTANT CORRECTIONS vs v0.2.2 (verified against the 2026-06-28 unpacking):
 *
 *   1. WIRE ORDER: the real client sends content-type FIRST, then auth,
 *      then anthropic-version, THEN the identity block, then x-request-id.
 *      v0.2.2 sent the identity block first — that was wrong. We now match
 *      the real client's order exactly.
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
 *   4. X-RELEASE-CHANNEL: v0.2.2 did not emit this header at all. The real
 *      client emits it conditionally (only when channel is non-empty).
 *      We now mirror that via identity.releaseChannel.
 *
 *   5. X-OS-VERSION: v0.2.2 used `os.release()` (kernel version number).
 *      The real client uses `os.version()` (OS product name). Fixed in
 *      identity.ts.
 *
* `extraHeaders` is the ONLY way for trusted internal subsystems
* to inject headers upstream. It is reserved for proxy-internal use — never
* for passthrough of client headers. The start-plan captcha preflight uses
* this hook to mirror ZCode's provider-runtime-headers refresh, where the
* host responds with freshly solved runtime headers before each model attempt.
 *
 * CONFIRMED NOT SENT (real client wire capture, 2026-06-28):
 *   - anthropic-beta            ❌ (never; SDK/CC-CLI artifact)
 *   - x-session-id              ✅ start-plan only, dynamic attribution
 *   - x-query-id                ✅ start-plan only, dynamic attribution
 *   - x-zcode-trace-id          ✅ start-plan only, dynamic attribution
 *   - x-aliyun-captcha-*        ❌ from downstream clients; ✅ only when
 *                                  injected by our start-plan runtime-header
 *                                  refresh path with a freshly solved token
 *   - X-ZCode-Agent             ✅ start-plan only (official GLM agent provider)
 *   - accept                    ❌ (not on /v1/messages; was a v0.2.2 bug)
 *   - any x-stainless-*         ❌ (Anthropic SDK fingerprint)
 *   - any x-claude-* / x-claude-code-*  ❌ (Claude Code CLI fingerprint)
 */
import type { Format } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildIdentityHeaders } from "./identity.js";

const ANTHROPIC_VERSION = "2023-06-01";

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

const startPlanAttributionByCredential = new Map<string, StartPlanAttributionContext>();

function startPlanCredentialKey(cred: Credential): string {
  return `${cred.provider}:${cred.userId ?? cred.email ?? cred.jwt ?? cred.apiKey}`;
}

function getStartPlanAttributionContext(cred: Credential): StartPlanAttributionContext {
  const key = startPlanCredentialKey(cred);
  let cached = startPlanAttributionByCredential.get(key);
  if (!cached) {
    cached = {
      sessionId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
    };
    startPlanAttributionByCredential.set(key, cached);
  }
  return cached;
}

function buildStartPlanAttributionHeaders(cred: Credential): Record<string, string> {
  const ctx = getStartPlanAttributionContext(cred);
  return {
    "x-zcode-trace-id": ctx.traceId,
    "x-query-id": crypto.randomUUID(),
    "x-session-id": ctx.sessionId,
  };
}

/**
 * Derive the client IP for logging/diagnostics (NOT for session IDs — see
 * the note in buildAuthHeaders: the real client sends no session header).
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
 * Build the COMPLETE upstream header set (content-type + auth + identity +
 * trace) in the exact wire order the real ZCode desktop client uses.
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
): Record<string, string> {
  const credStr = credentialString(cred);
  const startPlanAuthorization = plan === "start-plan"
    ? normalizeBearerHeader(cred.jwt ?? credStr)
    : undefined;
  const id = buildIdentityHeaders(identity);

  // Build the ordered whitelist. Order matches the real ZCode desktop
  // client's wire shape (reverse-engineered 2026-06-28 from app.asar
  // Mf() offset 886853 + SDK literal offset 1085109 + yU offset 887429):
  //
  //   content-type → auth → anthropic-version → identity block → x-request-id
  //
  // We construct the object key-by-key rather than spreading, so the
  // insertion order is the wire order (JavaScript engines preserve object
  // key insertion order for non-integer string keys, and Headers
  // construction in Bun/whatwg-fetch iterates the record in order).
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
    // === 3. anthropic-version (Anthropic upstream only) ===
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    // OpenAI upstream: auth via Bearer, no anthropic-version
    headers["authorization"] = `Bearer ${credStr}`;
  }

  // === 4-13. Identity block (in real client wire order) ===
  // Insert each identity header in order. Optional headers (X-Release-Channel,
  // X-Os-Version) are already absent from `id` when their value was empty
  // (buildIdentityHeaders handles that), so they simply don't appear in the
  // output map — preserving the wire order of the headers that ARE present.
  headers["user-agent"] = id["User-Agent"];
  headers["http-referer"] = id["HTTP-Referer"];
  headers["x-title"] = id["X-Title"];
  headers["x-zcode-app-version"] = id["X-ZCode-App-Version"];
  headers["x-platform"] = id["X-Platform"];
  if (id["X-Release-Channel"]) {
    headers["x-release-channel"] = id["X-Release-Channel"];
  }
  headers["x-client-language"] = id["X-Client-Language"];
  headers["x-client-timezone"] = id["X-Client-Timezone"];
  headers["x-os-category"] = id["X-Os-Category"];
  if (id["X-Os-Version"]) {
    headers["x-os-version"] = id["X-Os-Version"];
  }

  // === 14. X-ZCode-Agent (start-plan only) ===
  // The official desktop GLM agent provider attaches this marker to its
  // provider headers. Keep coding-plan unchanged, but mirror the start-plan
  // agent path because zcode.z.ai applies a stricter gateway policy there.
  if (plan === "start-plan") {
    const agent = identity.zcodeAgent?.trim() || "glm";
    headers["x-zcode-agent"] = agent;
  }

  // === 15. x-request-id (LAST — fresh UUIDv4 per request) ===
  headers["x-request-id"] = crypto.randomUUID();

  // === 16-18. Start-plan attribution headers ===
  // The current ZCode GLM adapter merges createModelRequestAttributionHeaders()
  // into every model request. It always includes x-request-id and
  // x-zcode-trace-id, plus session/query when a ZCode task context exists.
  // Official ZCode creates session ids as `sess_${uuid}` and query ids as
  // `query_${uuid}`, then strips those prefixes before sending headers. We
  // mirror the observable wire shape: stable session/trace IDs per upstream
  // credential, plus a fresh query id for each request attempt.
  if (plan === "start-plan") {
    Object.assign(headers, buildStartPlanAttributionHeaders(cred));
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
      // runtime headers during preflight or after a 3007 challenge, matching
      // the official provider-runtime-headers refresh path. The verify param
      // is one-shot, so callers must pass a fresh value for every attempt.
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
   * a session ID (the real client sends no session header — see module header)
   * AND no longer used to read client headers (the whitelist ignores them
   * entirely). Kept in the signature for API stability; the value is
   * intentionally unused for header construction.
   */
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
): Request {
  // Resolve and discard — kept for API symmetry, no session header is built
  // and no client header is read for the upstream request.
  void clientIp(clientReq, resolveClientIp, trustProxy);
  const url = buildUpstreamURL(format, provider, plan);
  // Strict whitelist — does NOT read clientReq.headers.
  const headers = buildUpstreamHeaders(format, cred, identity, plan, extraHeaders);

  const init: RequestInit = {
    method: "POST",
    headers,
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
