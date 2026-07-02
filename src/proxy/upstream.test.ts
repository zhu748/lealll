/**
 * Tests for upstream request builder and proxy handler.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import { describe, it, expect, mock } from "bun:test";
import { buildUpstreamRequest, buildUpstreamURL, buildAuthHeaders, buildUpstreamHeaders } from "./upstream.js";
import { proxyRequest, errorResponse } from "./handler.js";
import { ZAI_PROVIDER, BIGMODEL_PROVIDER } from "../provider/providers.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

const ZAI_CRED: Credential = { apiKey: "testkey", secret: "testsecret", provider: "zai" };
const BIGMODEL_CRED: Credential = { apiKey: "bmkey", provider: "bigmodel" };

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

function makeClientReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("buildUpstreamURL", () => {
  it("builds Anthropic URL for Z.AI", () => {
    expect(buildUpstreamURL("anthropic", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
  });

  it("builds OpenAI URL for Z.AI", () => {
    expect(buildUpstreamURL("openai", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/coding/paas/v4/chat/completions",
    );
  });

  it("builds Anthropic URL for Bigmodel", () => {
    expect(buildUpstreamURL("anthropic", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });

  it("builds OpenAI URL for Bigmodel", () => {
    expect(buildUpstreamURL("openai", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    );
  });

  it("selects Anthropic upstream URL independent of client route (translation mode)", () => {
    expect(buildUpstreamURL("anthropic", ZAI_PROVIDER)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
    expect(buildUpstreamURL("anthropic", BIGMODEL_PROVIDER)).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });
});

describe("buildAuthHeaders", () => {
  it("injects x-api-key + anthropic-version for Anthropic", () => {
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["x-api-key"]).toBe("testkey.testsecret");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("injects Authorization Bearer for OpenAI", () => {
    const h = buildAuthHeaders("openai", ZAI_CRED, IDENTITY);
    expect(h["authorization"]).toBe("Bearer testkey.testsecret");
  });

  it("uses apiKey only (no secret) for Bigmodel Anthropic", () => {
    const h = buildAuthHeaders("anthropic", BIGMODEL_CRED, IDENTITY);
    expect(h["x-api-key"]).toBe("bmkey");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses apiKey only for Bigmodel OpenAI", () => {
    const h = buildAuthHeaders("openai", BIGMODEL_CRED, IDENTITY);
    expect(h["authorization"]).toBe("Bearer bmkey");
  });

  it("injects the ZCode identity header set (matches real ZCode client)", () => {
    // Real ZCode client sends `ZCode/{appVersion}` UA plus the full identity
    // set (verified 2026-06-28 against app.asar Mf() offset 886853).
    // v0.2.3+: headers are emitted in the EXACT wire order the real client
    // uses — content-type FIRST, then auth, then anthropic-version, THEN
    // the identity block, then x-request-id LAST.
    //
    // (buildAuthHeaders strips content-type and x-request-id, so we only
    // see auth + anthropic-version + identity block here. Within that
    // subset, the order is: auth → anthropic-version → identity block.)
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["user-agent"]).toBe("ZCode/test-1.0.0");
    expect(h["x-zcode-app-version"]).toBe("test-1.0.0");
    expect(h["x-title"]).toBe("cli");
    expect(h["http-referer"]).toBe("https://zcode.z.ai");
    expect(h["x-platform"]).toMatch(/^[a-z0-9]+-[a-z0-9]+$/i);

    // Verify wire order: auth FIRST, then anthropic-version, THEN identity
    // block (user-agent is the FIRST identity header).
    // This matches the real ZCode desktop client's wire shape (2026-06-28
    // unpacking of Mf() at offset 886853).
    const keys = Object.keys(h);
    const authIdx = keys.indexOf("x-api-key");
    const versionIdx = keys.indexOf("anthropic-version");
    const uaIdx = keys.indexOf("user-agent");
    expect(authIdx).toBeLessThan(versionIdx);
    expect(versionIdx).toBeLessThan(uaIdx);

    // Identity block internal order (verified 2026-06-28):
    //   user-agent → http-referer → x-title → x-zcode-app-version →
    //   x-platform → [x-release-channel] → x-client-language →
    //   x-client-timezone → x-os-category → [x-os-version]
    const uaIdxInBlock = keys.indexOf("user-agent");
    const refererIdx = keys.indexOf("http-referer");
    const titleIdx = keys.indexOf("x-title");
    const appVerIdx = keys.indexOf("x-zcode-app-version");
    const platformIdx = keys.indexOf("x-platform");
    const langIdx = keys.indexOf("x-client-language");
    const tzIdx = keys.indexOf("x-client-timezone");
    const osCatIdx = keys.indexOf("x-os-category");
    expect(uaIdxInBlock).toBeLessThan(refererIdx);
    expect(refererIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(appVerIdx);
    expect(appVerIdx).toBeLessThan(platformIdx);
    expect(platformIdx).toBeLessThan(langIdx);
    expect(langIdx).toBeLessThan(tzIdx);
    expect(tzIdx).toBeLessThan(osCatIdx);
  });

  it("does NOT send fabricated trace headers (real ZCode client omits them)", () => {
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY) as unknown as Record<string, string | undefined>;
    expect(h["x-session-id"]).toBeUndefined();
    expect(h["x-query-id"]).toBeUndefined();
    expect(h["x-zcode-trace-id"]).toBeUndefined();
  });

  it("does NOT emit Accept header (v0.2.3+: real ZCode client never sends it on /v1/messages)", () => {
    // Verified 2026-06-28 against app.asar: the real ZCode desktop client
    // does NOT send an `accept` header on /v1/messages traffic. The v0.2.2
    // behavior of forcing `accept: text/event-stream` was itself a fingerprint
    // mismatch — removed in v0.2.3.
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["accept"]).toBeUndefined();
  });

  it("x-request-id is a fresh UUID per call (real ZCode client behavior)", () => {
    // v0.2.3+: buildAuthHeaders no longer includes x-request-id (it strips
    // content-type AND x-request-id — those are only in buildUpstreamHeaders).
    // Test against buildUpstreamHeaders instead, which has the full whitelist.
    const h1 = buildUpstreamHeaders("openai", ZAI_CRED, IDENTITY);
    const h2 = buildUpstreamHeaders("openai", ZAI_CRED, IDENTITY);
    expect(h1["x-request-id"]).toBeTruthy();
    expect(h1["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
  });
});

describe("buildUpstreamRequest", () => {
  it("constructs full Anthropic request with correct URL + headers", async () => {
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, '{"model":"glm-4.6","messages":[]}', IDENTITY);

    expect(upstream.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.get("user-agent")).toBe("ZCode/test-1.0.0");
    expect(upstream.headers.get("x-zcode-app-version")).toBe("test-1.0.0");
    expect(upstream.headers.get("x-title")).toBe("cli");
    expect(upstream.headers.get("http-referer")).toBe("https://zcode.z.ai");
    // v0.2.3+: real ZCode client does NOT send `accept` on /v1/messages.
    expect(upstream.headers.get("accept")).toBeNull();
    // v0.2.3+: accept-encoding is auto-added by fetch (not set by us).
    // It may or may not appear depending on Bun's Headers behavior, but we
    // never set it to "gzip" anymore.
    // Fabricated trace headers must NOT be present on the wire.
    expect(upstream.headers.get("x-session-id")).toBeNull();
    expect(upstream.headers.get("x-query-id")).toBeNull();
    expect(upstream.headers.get("x-zcode-trace-id")).toBeNull();

    const body = await upstream.text();
    expect(body).toBe('{"model":"glm-4.6","messages":[]}');
  });

  it("constructs full OpenAI request with correct URL + headers", async () => {
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');
    const upstream = buildUpstreamRequest(clientReq, "openai", BIGMODEL_PROVIDER, BIGMODEL_CRED, '{"model":"glm-4.6","messages":[]}', IDENTITY);

    expect(upstream.url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
    expect(upstream.headers.get("authorization")).toBe("Bearer bmkey");
    expect(upstream.headers.get("content-type")).toBe("application/json");
  });

  it("strips anthropic-beta header entirely (real ZCode client sends none)", () => {
    // The real ZCode desktop client sends NO anthropic-beta header on normal
    // /v1/messages traffic (verified against app.asar buildZCodeSourceHeaders,
    // 2026-06). Beta flags are an Anthropic-SDK / Claude-Code-CLI artifact.
    // Forwarding them — even claude-code-* — is a fingerprint mismatch, so we
    // strip the header completely regardless of which flags it carries.
    const clientReq = makeClientReq("{}", {
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24",
    });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBeNull();
  });

  it("strips anthropic-beta header entirely when no claude-code-* flags present", () => {
    const clientReq = makeClientReq("{}", {
      "anthropic-beta": "prompt-caching-2024-07-31,some-other-flag",
    });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBeNull();
  });

  it("strips a lone claude-code-* anthropic-beta flag too (no exceptions)", () => {
    // Even when the ONLY flag is claude-code-*, we drop it — the real client
    // never emits this header at all.
    const clientReq = makeClientReq("{}", { "anthropic-beta": "claude-code-20250219" });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBeNull();
  });

  it("strips client Authorization header (prevents credential leak)", () => {
    const clientReq = makeClientReq("{}", { authorization: "Bearer client-token" });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    // Auth should be the injected credential, NOT the client's
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(upstream.headers.get("authorization")).toBeNull();
  });

  it("strips client x-api-key header", () => {
    const clientReq = makeClientReq("{}", { "x-api-key": "client-key" });
    const upstream = buildUpstreamRequest(clientReq, "openai", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    // For OpenAI format, auth goes in Authorization header; client's x-api-key should be stripped
    expect(upstream.headers.get("authorization")).toBe("Bearer testkey.testsecret");
    expect(upstream.headers.get("x-api-key")).toBeNull();
  });

  it("accepts resolveClientIp/trustProxy args for API compat without emitting trace headers", () => {
    // These args used to drive a session-id cache. Since the real ZCode client
    // sends no session/query/trace headers, they are now accepted-but-unused.
    // This test pins that contract: the signature stays stable and NO trace
    // header is produced regardless of these args.
    const clientReq = makeClientReq("{}", {
      "x-forwarded-for": "203.0.113.42",
      "x-real-ip": "203.0.113.42",
      authorization: "Bearer user-token",
    });
    const resolver = () => "198.51.100.1";
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY, "coding-plan", undefined, resolver, false);
    expect(upstream.headers.get("x-session-id")).toBeNull();
    expect(upstream.headers.get("x-query-id")).toBeNull();
    expect(upstream.headers.get("x-zcode-trace-id")).toBeNull();
    // Identity headers still present.
    expect(upstream.headers.get("user-agent")).toBe("ZCode/test-1.0.0");
  });

  // v0.2.1+: Claude Code CLI / Anthropic TypeScript SDK fingerprint headers
  // must NEVER leak upstream. The real ZCode desktop client (Electron + Vercel
  // AI SDK) does not emit any of these — they are 100% Stainless-SDK / CC-CLI
  // artifacts. Captured from a real Claude Code 2.1.195 request on 2026-06-28.
  it("strips Claude Code / Stainless SDK fingerprint headers (v0.2.1+)", () => {
    const clientReq = makeClientReq("{}", {
      "x-claude-code-session-id": "3aeca633-bcc3-48be-b175-49cc0a4fad1e",
      "x-stainless-arch": "x64",
      "x-stainless-lang": "js",
      "x-stainless-os": "Windows",
      "x-stainless-package-version": "0.94.0",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v26.3.0",
      "x-stainless-timeout": "600",
      "x-stainless-helper-method": "stream",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);

    // Every enumerated SDK fingerprint header must be stripped.
    expect(upstream.headers.get("x-claude-code-session-id")).toBeNull();
    expect(upstream.headers.get("x-stainless-arch")).toBeNull();
    expect(upstream.headers.get("x-stainless-lang")).toBeNull();
    expect(upstream.headers.get("x-stainless-os")).toBeNull();
    expect(upstream.headers.get("x-stainless-package-version")).toBeNull();
    expect(upstream.headers.get("x-stainless-retry-count")).toBeNull();
    expect(upstream.headers.get("x-stainless-runtime")).toBeNull();
    expect(upstream.headers.get("x-stainless-runtime-version")).toBeNull();
    expect(upstream.headers.get("x-stainless-timeout")).toBeNull();
    expect(upstream.headers.get("x-stainless-helper-method")).toBeNull();
    expect(upstream.headers.get("anthropic-dangerous-direct-browser-access")).toBeNull();
    expect(upstream.headers.get("x-app")).toBeNull();

    // Identity headers still win — we replaced the SDK fingerprint with the
    // real ZCode client's identity set.
    expect(upstream.headers.get("user-agent")).toBe("ZCode/test-1.0.0");
    expect(upstream.headers.get("x-zcode-app-version")).toBe("test-1.0.0");
  });

  // v0.2.1+: prefix-based strip — any future `x-stainless-*` or `x-claude-*`
  // header (even one we haven't enumerated) must be stripped. This protects
  // against new SDK fingerprint headers appearing in future Anthropic SDK /
  // Claude Code releases without requiring a code change here.
  it("strips any x-stainless-* / x-claude-* header by prefix (future-proof)", () => {
    const clientReq = makeClientReq("{}", {
      "x-stainless-new-future-header": "value",
      "x-claude-new-future-flag": "value",
      "x-claude-code-experimental": "value",
    });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);

    expect(upstream.headers.get("x-stainless-new-future-header")).toBeNull();
    expect(upstream.headers.get("x-claude-new-future-flag")).toBeNull();
    expect(upstream.headers.get("x-claude-code-experimental")).toBeNull();
  });

  // v0.2.2+: STRICT WHITELIST — no client header is ever passthrough'd to
  // upstream. Even headers we've never seen before (random custom headers,
  // browser sec-* headers, future SDK headers with no x-stainless-/x-claude-
  // prefix) are dropped by construction. This is the bulletproof approach:
  // the only way a header can appear upstream is if it's on the explicit
  // whitelist in buildUpstreamHeaders().
  //
  // v0.2.3+: whitelist updated to match the 2026-06-28 unpacking of app.asar
  // Mf() at offset 886853. `accept` is no longer in the whitelist (the real
  // ZCode client never sends it on /v1/messages). `accept-encoding` is auto-
  // added by fetch (we no longer hardcode "gzip").
  it("emits ONLY the whitelisted ZCode headers — no client header ever leaks (v0.2.3+ strict whitelist)", () => {
    // Throw every weird header we can think of at the proxy — including ones
    // with no fingerprint prefix that would have leaked through the old
    // blocklist approach.
    const clientReq = makeClientReq("{}", {
      // Claude Code / Anthropic SDK
      "x-claude-code-session-id": "abc",
      "x-stainless-arch": "x64",
      "anthropic-beta": "x,y,z",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      // Browser-style headers a browser-based client might send
      "origin": "https://evil.example.com",
      "referer": "https://evil.example.com/exploit",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
      "cookie": "session=stolen",
      // Random custom headers a future client might add — no prefix match
      "x-custom-trace": "leak?",
      "x-my-app-version": "1.0",
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "x-trace-id": "trace-leak",
      // Headers that should be OVERRIDDEN by the whitelist (not passthrough'd)
      "user-agent": "FakeClient/9.9",
      "accept": "text/html",
      "accept-encoding": "br, zstd",
      "content-type": "text/plain",
      "authorization": "Bearer client-token",
      "x-api-key": "client-key",
      "anthropic-version": "9999-01-01",
    });

    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);

    // === The whitelist (v0.2.3, matches real ZCode client wire capture): ===
    //   content-type, x-api-key/auth, anthropic-version, user-agent,
    //   http-referer, x-title, x-zcode-app-version, x-platform,
    //   [x-release-channel], x-client-language, x-client-timezone,
    //   x-os-category, [x-os-version], x-request-id
    // Plus transport-level (auto-added by fetch/HTTP):
    //   host, content-length, accept-encoding
    const EXPECTED_HEADERS = new Set([
      // Whitelist (explicit)
      "content-type",
      "x-api-key",            // anthropic coding-plan uses x-api-key
      "anthropic-version",
      "user-agent",
      "http-referer",
      "x-title",
      "x-zcode-app-version",
      "x-platform",
      "x-client-language",
      "x-client-timezone",
      "x-os-category",
      "x-os-version",
      "x-request-id",
      // Transport (auto-added by Bun's fetch / Headers)
      "host",
      "content-length",
      "accept-encoding",
    ]);

    // === Collect ALL headers actually sent ===
    const sentHeaders = new Set<string>();
    for (const [k] of upstream.headers.entries()) {
      sentHeaders.add(k.toLowerCase());
    }

    // === Verify NO unexpected header leaked ===
    const leaked = [...sentHeaders].filter(h => !EXPECTED_HEADERS.has(h));
    if (leaked.length > 0) {
      console.error("Leaked headers:", leaked);
    }
    expect(leaked).toEqual([]);

    // === Verify whitelist values are correct (not the client's) ===
    expect(upstream.headers.get("user-agent")).toBe("ZCode/test-1.0.0");    // not FakeClient/9.9
    expect(upstream.headers.get("accept")).toBeNull();                      // v0.2.3: NOT sent
    expect(upstream.headers.get("content-type")).toBe("application/json");  // not text/plain
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");   // not client-key
    expect(upstream.headers.get("authorization")).toBeNull();               // anthropic coding-plan uses x-api-key
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");   // not 9999-01-01
    expect(upstream.headers.get("anthropic-beta")).toBeNull();              // never sent

    // === Verify client fingerprint headers are ALL absent ===
    expect(upstream.headers.get("x-claude-code-session-id")).toBeNull();
    expect(upstream.headers.get("x-stainless-arch")).toBeNull();
    expect(upstream.headers.get("anthropic-dangerous-direct-browser-access")).toBeNull();
    expect(upstream.headers.get("x-app")).toBeNull();
    expect(upstream.headers.get("origin")).toBeNull();
    expect(upstream.headers.get("referer")).toBeNull();
    expect(upstream.headers.get("sec-fetch-site")).toBeNull();
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("x-custom-trace")).toBeNull();
    expect(upstream.headers.get("x-my-app-version")).toBeNull();
    expect(upstream.headers.get("x-forwarded-for")).toBeNull();
    expect(upstream.headers.get("x-trace-id")).toBeNull();
  });

  // v0.2.2+: extraHeaders still works on top of the whitelist for trusted
  // internal callers, but Aliyun captcha verification headers are explicitly
  // stripped to match the official ZCode desktop client start-plan path.
  it("allows trusted extraHeaders but strips Aliyun captcha headers", () => {
    const clientReq = makeClientReq("{}", { "x-client-leak": "should-not-passthrough" });
    const upstream = buildUpstreamRequest(
      clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY,
      "coding-plan",
      {
        "x-internal-debug": "debug-token-123",
        "x-aliyun-captcha-verify-param": "should-not-send",
        "x-aliyun-captcha-verify-region": "cn-shanghai",
      },
    );

    // Trusted internal header should be present (injected via extraHeaders).
    expect(upstream.headers.get("x-internal-debug")).toBe("debug-token-123");
    // Official ZCode chat requests do not carry Aliyun captcha headers.
    expect(upstream.headers.get("x-aliyun-captcha-verify-param")).toBeNull();
    expect(upstream.headers.get("x-aliyun-captcha-verify-region")).toBeNull();
    // The client's custom header should NOT be present (whitelist blocks it).
    expect(upstream.headers.get("x-client-leak")).toBeNull();
  });

  // v0.2.3+: COMPLETE WIRE ORDER test — verifies the exact header sequence
  // matches the real ZCode desktop client's wire shape (2026-06-28 unpacking
  // of app.asar Mf() at offset 886853 + SDK literal at 1085109 + yU at 887429).
  //
  // Real client wire order:
  //   1. content-type
  //   2. x-api-key | authorization
  //   3. anthropic-version
  //   4. user-agent
  //   5. http-referer
  //   6. x-title
  //   7. x-zcode-app-version
  //   8. x-platform
  //   9. [x-release-channel]   (only when set)
  //   10. x-client-language
  //   11. x-client-timezone
  //   12. x-os-category
  //   13. [x-os-version]       (only when non-empty)
  //   14. x-request-id
  it("emits headers in the EXACT real ZCode client wire order (v0.2.3+, coding-plan)", () => {
    // Use an identity WITH releaseChannel set to verify its position in the
    // wire order. Without it, the test would still pass even if
    // X-Release-Channel ended up at the wrong position when set.
    const identityWithChannel: ProxyIdentity = {
      ...IDENTITY,
      releaseChannel: "stable",
    };
    const h = buildUpstreamHeaders("anthropic", ZAI_CRED, identityWithChannel);

    // Expected wire order (just the headers we emit — fetch adds
    // host/content-length/accept-encoding later, which we don't control).
    const expectedOrder = [
      "content-type",
      "x-api-key",
      "anthropic-version",
      "user-agent",
      "http-referer",
      "x-title",
      "x-zcode-app-version",
      "x-platform",
      "x-release-channel",   // present because releaseChannel: "stable"
      "x-client-language",
      "x-client-timezone",
      "x-os-category",
      "x-os-version",        // present because os.version() returns non-empty
      "x-request-id",
    ];

    const actualOrder = Object.keys(h);
    expect(actualOrder).toEqual(expectedOrder);
  });

  it("emits headers in the EXACT real ZCode client wire order (v0.2.3+, start-plan with JWT)", () => {
    // Start-plan uses authorization: Bearer <jwt> instead of x-api-key.
    // Verify the wire order is the same except slot 2 swaps to authorization.
    const jwtCred: Credential = { apiKey: "k", secret: "s", jwt: "jwt-token-xyz", provider: "zai" };
    const h = buildUpstreamHeaders("anthropic", jwtCred, IDENTITY, "start-plan");

    const expectedOrder = [
      "content-type",
      "authorization",       // start-plan with jwt uses Bearer
      "anthropic-version",
      "user-agent",
      "http-referer",
      "x-title",
      "x-zcode-app-version",
      "x-platform",
      // x-release-channel absent (IDENTITY has no releaseChannel set)
      "x-client-language",
      "x-client-timezone",
      "x-os-category",
      "x-os-version",
      "x-request-id",
    ];

    const actualOrder = Object.keys(h);
    expect(actualOrder).toEqual(expectedOrder);

    // Verify the JWT auth value.
    expect(h["authorization"]).toBe("Bearer jwt-token-xyz");
    // x-api-key must NOT be present in start-plan+jwt mode.
    expect(h["x-api-key"]).toBeUndefined();
  });

  it("emits headers in the EXACT real ZCode client wire order (v0.2.3+, OpenAI format)", () => {
    // OpenAI upstream: auth via Bearer, NO anthropic-version.
    const h = buildUpstreamHeaders("openai", ZAI_CRED, IDENTITY);

    const expectedOrder = [
      "content-type",
      "authorization",       // OpenAI uses Bearer
      // NO anthropic-version for OpenAI upstream
      "user-agent",
      "http-referer",
      "x-title",
      "x-zcode-app-version",
      "x-platform",
      "x-client-language",
      "x-client-timezone",
      "x-os-category",
      "x-os-version",
      "x-request-id",
    ];

    const actualOrder = Object.keys(h);
    expect(actualOrder).toEqual(expectedOrder);
  });

  // v0.2.3: accept-encoding must NOT be hardcoded to "gzip" — the real
  // client lets fetch auto-add it (which picks `gzip, deflate, br` based
  // on runtime support). Hardcoding was a fingerprint mismatch.
  it("does NOT hardcode accept-encoding (v0.2.3+: let fetch auto-add it)", () => {
    const h = buildUpstreamHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["accept-encoding"]).toBeUndefined();
  });

  // v0.2.3: accept header must NOT be sent at all on /v1/messages traffic.
  // The v0.2.2 behavior of forcing `accept: text/event-stream` was itself
  // a fingerprint mismatch (the real client doesn't send accept here).
  it("does NOT emit accept header (v0.2.3+: real ZCode client never sends it)", () => {
    const h = buildUpstreamHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["accept"]).toBeUndefined();
  });
});

describe("proxyRequest", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };

  it("forwards request to upstream with injected auth", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response('{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Hello"}],"model":"glm-4.6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0].text).toBe("Hello");
  });

  it("streams response body through unchanged", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[],"stream":true}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("message_start");
    expect(text).toContain("text_delta");
    expect(text).toContain("message_stop");
  });

  it("forwards content-encoding from upstream response (decompress: false passthrough)", async () => {
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response('{"id":"msg_1","content":[{"text":"Hello"}]}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("returns 502 when upstream is unreachable", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
    expect(body.error.message).toContain("ECONNREFUSED");
  });

  it("returns 503 when credential unavailable", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.type).toBe("credential_unavailable");
  });

  it("forwards upstream error status codes", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"error":{"type":"invalid_request_error","message":"bad model"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"bad-model","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("proxyRequest — OpenAI translation mode (coding-plan)", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };

  function makeOpenAIReq(body: string, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  const ANTHROPIC_RESPONSE = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Translated hello" }],
    model: "glm-4.6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  it("routes OpenAI request to Anthropic upstream endpoint", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses x-api-key + anthropic-version on translated upstream request", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(req.headers.get("authorization")).toBeNull();
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
  });

  it("sends translated Anthropic request body upstream (not OpenAI body)", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const body = await req.text();
      const parsed = JSON.parse(body);
      expect(parsed.messages).toBeDefined();
      expect(parsed.max_tokens).toBe(4096);
      expect(parsed.messages[0].role).toBe("user");
      expect(Array.isArray(parsed.choices)).toBe(false);
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
  });

  it("translates batch Anthropic response back to OpenAI format", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Translated hello");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(13);
  });

  it("returns gzip-encoded response when client sends accept-encoding: gzip", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBe("gzip");
    const decompressed = Bun.gunzipSync(new Uint8Array(await resp.arrayBuffer()));
    const body = JSON.parse(new TextDecoder().decode(decompressed));
    expect(body.object).toBe("chat.completion");
  });

  it("translates SSE stream from Anthropic format to OpenAI format", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[],"stream":true}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("message_start");
    expect(text).not.toContain("text_delta");
    expect(text).toContain('"prompt_tokens":10');
    expect(text).toContain('"completion_tokens":5');
    expect(text).toContain('"total_tokens":15');
  });

  it("forwards x-request-id + anthropic ratelimit headers in translated batch response", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_abc123",
          "anthropic-ratelimit-requests-remaining": "99",
          "anthropic-ratelimit-tokens-reset": "2025-01-01T00:00:00Z",
        },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("x-request-id")).toBe("req_abc123");
    expect(resp.headers.get("anthropic-ratelimit-requests-remaining")).toBe("99");
    expect(resp.headers.get("anthropic-ratelimit-tokens-reset")).toBe("2025-01-01T00:00:00Z");
  });

  it("accepts gzip when client sends accept-encoding: gzip;q=0.5 (fractional q-value)", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip;q=0.5" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("rejects gzip when client sends accept-encoding: gzip;q=0 (explicitly disabled)", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip;q=0" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBeNull();
  });

  it("returns 400 invalid_json when OpenAI request body is malformed JSON", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq("not json");

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_json");
  });

  it("returns 502 translation_failed when upstream returns non-JSON in translation mode", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("returns 502 translation_failed when upstream returns non-2xx in translation mode", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"error":"bad request"}', { status: 400, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });
});

describe("proxyRequest — regression: Anthropic passthrough unchanged", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };

  it("Anthropic client request uses decompress:false passthrough", async () => {
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response('{"id":"msg_1","content":[{"type":"text","text":"Hi"}]}', {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("start-plan OpenAI request translates through zcode.z.ai gateway", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalFetch = globalThis.fetch;
    const globalFetchMock = mock(async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      throw new Error(`unexpected global fetch in test: ${url}`);
    });
    globalThis.fetch = globalFetchMock as unknown as typeof fetch;

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        expect(req.headers.get("x-aliyun-captcha-verify-param")).toBeNull();
        expect(req.headers.get("x-aliyun-captcha-verify-region")).toBeNull();
        const reqBody = JSON.parse(await req.text());
        expect(reqBody.messages).toBeDefined();
        // vceshi0.1.7+: injectZCodeThinkingFormat forces max_tokens=64000
        // on all Anthropic-format requests (matches ZCode's wire shape,
        // regardless of thinking on/off). The OpenAI→Anthropic translator
        // originally sets 4096, but the body-transformer overrides it.
        expect(reqBody.max_tokens).toBe(64000);
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "start-plan reply" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Official ZCode start-plan chat does not fetch client captcha config.
      expect(globalFetchMock).toHaveBeenCalledTimes(0);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("application/json");
      const body = await resp.json();
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("start-plan reply");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyRequest — per-account outbound proxy (v2.1.4.1test5)", () => {
  const testConfig: ProxyConfig = {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: IDENTITY,
    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };

  const successBody = JSON.stringify({
    id: "msg_1", type: "message", role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    model: "glm-4.6", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  it("passes cred.proxy as { proxy } option to fetch when set", async () => {
    let receivedProxy: string | undefined;
    const fetchMock = mock(async (_req: Request, init?: any): Promise<Response> => {
      receivedProxy = init?.proxy;
      return new Response(successBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({
      apiKey: "testkey", secret: "testsecret", provider: "zai",
      proxy: "http://127.0.0.1:7890",
    });

    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');
    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(200);
    expect(receivedProxy).toBe("http://127.0.0.1:7890");
  });

  it("does NOT pass proxy option when cred.proxy is unset", async () => {
    let receivedProxy: unknown = "sentinel";
    let initKeys: string[] | undefined;
    const fetchMock = mock(async (_req: Request, init?: any): Promise<Response> => {
      receivedProxy = init?.proxy;
      initKeys = init ? Object.keys(init) : undefined;
      return new Response(successBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');
    await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receivedProxy).toBeUndefined();
    expect(initKeys).not.toContain("proxy");
  });

  it("routes socks5:// proxy through the local SOCKS bridge", async () => {
    // Bun's native fetch throws UnsupportedProxyProtocol for SOCKS proxies.
    // The handler transparently wraps fetchImpl with wrapFetchWithSocksBridge,
    // so a SOCKS proxy URL is translated to http://127.0.0.1:<port> (a local
    // HTTP-CONNECT→SOCKS bridge) before reaching the underlying fetch.
    let receivedProxy: string | undefined;
    const fetchMock = mock(async (_req: Request, init?: any): Promise<Response> => {
      receivedProxy = init?.proxy;
      return new Response(successBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({
      apiKey: "testkey", secret: "testsecret", provider: "zai",
      proxy: "socks5://10.0.0.1:1080",
    });

    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');
    await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    // The original SOCKS URL must NOT be passed to fetch (that would trigger
    // UnsupportedProxyProtocol). Instead, fetch sees an http://127.0.0.1:<port>
    // bridge URL.
    expect(receivedProxy).toBeDefined();
    expect(receivedProxy).not.toBe("socks5://10.0.0.1:1080");
    expect(receivedProxy!.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("preserves decompress: false alongside proxy for Anthropic format", async () => {
    let receivedDecompress: unknown = "sentinel";
    let receivedProxy: string | undefined;
    const fetchMock = mock(async (_req: Request, init?: any): Promise<Response> => {
      receivedDecompress = init?.decompress;
      receivedProxy = init?.proxy;
      return new Response(successBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({
      apiKey: "testkey", secret: "testsecret", provider: "zai",
      proxy: "http://proxy:8080",
    });

    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');
    await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    // Anthropic format is NOT translation mode, so decompress: false should
    // be passed alongside proxy.
    expect(receivedDecompress).toBe(false);
    expect(receivedProxy).toBe("http://proxy:8080");
  });
});

describe("errorResponse", () => {
  it("builds JSON error with correct status", () => {
    const resp = errorResponse(401, "auth_error", "Invalid API key");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("content-type")).toBe("application/json");
  });
});