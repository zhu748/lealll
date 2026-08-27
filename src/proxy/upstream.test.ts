/**
 * Tests for upstream request builder and proxy handler.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpstreamRequest,
  buildUpstreamURL,
  buildAuthHeaders,
  buildUpstreamHeaders,
} from "./upstream.js";
import { proxyRequest, errorResponse, startPlanCaptchaPreflightEnabled, _readResponseTextPreviewForTesting, _setRequestBodyIdleTimeoutForTesting } from "./handler.js";
import { importFromText, updatePoolConfig, _resetForTesting as resetProxyPoolForTesting } from "./proxy-pool.js";
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

describe("start-plan captcha preflight switch", () => {
  it("defaults to ZCode-aligned captcha preflight and can be explicitly disabled", () => {
    const original = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    try {
      delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      expect(startPlanCaptchaPreflightEnabled()).toBe(true);

      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
      expect(startPlanCaptchaPreflightEnabled()).toBe(false);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "false";
      expect(startPlanCaptchaPreflightEnabled()).toBe(false);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "off";
      expect(startPlanCaptchaPreflightEnabled()).toBe(false);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "never";
      expect(startPlanCaptchaPreflightEnabled()).toBe(false);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "no";
      expect(startPlanCaptchaPreflightEnabled()).toBe(false);

      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "1";
      expect(startPlanCaptchaPreflightEnabled()).toBe(true);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "true";
      expect(startPlanCaptchaPreflightEnabled()).toBe(true);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "on";
      expect(startPlanCaptchaPreflightEnabled()).toBe(true);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "yes";
      expect(startPlanCaptchaPreflightEnabled()).toBe(true);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "always";
      expect(startPlanCaptchaPreflightEnabled()).toBe(true);
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "unexpected";
      expect(startPlanCaptchaPreflightEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = original;
    }
  });
});

describe("response body preview guard", () => {
  it("does not consume the original response when Content-Length exceeds the preview cap", async () => {
    const resp = new Response("abcdef", {
      status: 400,
      headers: {
        "content-type": "text/plain",
        "content-length": "100",
      },
    });

    const preview = await _readResponseTextPreviewForTesting(resp, { maxBytes: 8, timeoutMs: 1000 });

    expect(preview.truncated).toBe(true);
    expect(preview.complete).toBe(false);
    expect(preview.text).toBe("");
    expect(await resp.text()).toBe("abcdef");
  });
});

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

  it("injects the full pio identity header set (upstream v2.6.0 alignment)", () => {
    // v0.3.0: model requests carry the FULL `pio` header set — the June-2026
    // narrow agent split is obsolete (refreshed 2026-08 bundle RE).
    const h = buildAuthHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["User-Agent"]).toBe("ZCode/test-1.0.0");
    expect(h["X-ZCode-App-Version"]).toBe("test-1.0.0");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(h["X-Platform"]).toMatch(/^[a-z0-9]+-[a-z0-9]+$/i);
    expect(h["X-Release-Channel"]).toBe("production");
    expect(typeof h["X-Client-Language"]).toBe("string");
    expect(typeof h["X-Client-Timezone"]).toBe("string");

    // Trace/attribution headers are part of the auth-header assembly now
    // (coding-plan synthetic path: request-id + session-type + trace-id +
    // query-id + session-id).
    expect(typeof h["x-request-id"]).toBe("string");
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(typeof h["x-zcode-trace-id"]).toBe("string");
    expect(typeof h["x-query-id"]).toBe("string");
    expect(typeof h["x-session-id"]).toBe("string");

    // pio wire order: HTTP-Referer → User-Agent → [App-Version] → X-Title →
    // X-ZCode-Agent → X-Platform → … → auth last.
    const keys = Object.keys(h);
    const refererIdx = keys.indexOf("HTTP-Referer");
    const uaIdx = keys.indexOf("User-Agent");
    const appVerIdx = keys.indexOf("X-ZCode-App-Version");
    const titleIdx = keys.indexOf("X-Title");
    const agentIdx = keys.indexOf("X-ZCode-Agent");
    const platformIdx = keys.indexOf("X-Platform");
    const authIdx = keys.indexOf("x-api-key");
    expect(refererIdx).toBeLessThan(uaIdx);
    expect(uaIdx).toBeLessThan(appVerIdx);
    expect(appVerIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(platformIdx);
    expect(platformIdx).toBeLessThan(authIdx);
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
    expect(upstream.headers.get("x-title")).toBe("Z Code@cli");
    expect(upstream.headers.get("x-zcode-agent")).toBe("glm");
    expect(upstream.headers.get("http-referer")).toBe("https://zcode.z.ai");
    // v0.3.0: coding-plan now emits the full synthetic attribution set
    // (x-request-id / x-zcode-session-type / x-zcode-trace-id / x-query-id /
    // x-session-id) — ZCode 3.9.1 attributes every model request.
    expect(upstream.headers.get("x-zcode-session-type")).toBe("main");
    expect(typeof upstream.headers.get("x-session-id")).toBe("string");
    expect(typeof upstream.headers.get("x-query-id")).toBe("string");
    expect(typeof upstream.headers.get("x-zcode-trace-id")).toBe("string");
    // v0.2.3+: real ZCode client does NOT send `accept` on /v1/messages.
    expect(upstream.headers.get("accept")).toBeNull();

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

  it("replaces downstream anthropic-beta with the fixed ZCode beta", () => {
    // Real ZCode 3.1.8/3.2.5 sends exactly mid-conversation-system-2026-04-07
    // on /v1/messages. Claude Code sends a long beta list with claude-code-*
    // flags; those must never leak upstream.
    const clientReq = makeClientReq("{}", {
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24",
    });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBe("mid-conversation-system-2026-04-07");
  });

  it("does not pass through non-ZCode anthropic-beta values", () => {
    const clientReq = makeClientReq("{}", {
      "anthropic-beta": "prompt-caching-2024-07-31,some-other-flag",
    });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBe("mid-conversation-system-2026-04-07");
  });

  it("replaces a lone claude-code-* anthropic-beta flag too", () => {
    const clientReq = makeClientReq("{}", { "anthropic-beta": "claude-code-20250219" });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("anthropic-beta")).toBe("mid-conversation-system-2026-04-07");
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
    // v0.3.0: coding-plan emits the synthetic attribution set (not derived
    // from client IP — random UUIDs). The resolver args remain accepted for
    // API stability but never influence header values.
    expect(typeof upstream.headers.get("x-session-id")).toBe("string");
    expect(typeof upstream.headers.get("x-query-id")).toBe("string");
    expect(typeof upstream.headers.get("x-zcode-trace-id")).toBe("string");
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
  // ZCode client never sends it on /v1/messages). `accept-encoding` is the
  // proxy's own value (v0.3.8.1: identity default — matches the real client;
  // the client's value is never forwarded).
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

    // === The whitelist (matches real ZCode client wire capture): ===
    //   content-type, x-api-key/auth, anthropic-beta, anthropic-version,
    //   http-referer, user-agent, x-zcode-app-version, x-title,
    //   x-zcode-agent, x-platform, x-os-category, [x-os-version],
    //   x-request-id
    // Plus transport-level (auto-added by fetch/HTTP):
    //   host, content-length, accept-encoding
    const EXPECTED_HEADERS = new Set([
      // Whitelist (explicit) — v0.3.0 full pio set + synthetic attribution
      "content-type",
      "x-api-key",            // anthropic coding-plan uses x-api-key
      "anthropic-beta",
      "anthropic-version",
      "user-agent",
      "http-referer",
      "x-zcode-app-version",
      "x-title",
      "x-zcode-agent",
      "x-platform",
      "x-release-channel",
      "x-client-language",
      "x-client-timezone",
      "x-os-category",
      "x-os-version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "x-query-id",
      "x-session-id",
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
    expect(upstream.headers.get("accept")).toBeNull();                      // not explicitly set
    expect(upstream.headers.get("content-type")).toBe("application/json");  // not text/plain
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");   // not client-key
    expect(upstream.headers.get("authorization")).toBeNull();               // anthropic coding-plan uses x-api-key
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");   // not 9999-01-01
    expect(upstream.headers.get("anthropic-beta")).toBe("mid-conversation-system-2026-04-07");

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
  // internal callers. Aliyun captcha verification headers are stripped outside
  // start-plan so downstream clients cannot spoof them into normal provider
  // traffic.
  it("allows trusted extraHeaders but strips Aliyun captcha headers outside start-plan", () => {
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
    // Non-start-plan chat requests do not carry Aliyun captcha headers.
    expect(upstream.headers.get("x-aliyun-captcha-verify-param")).toBeNull();
    expect(upstream.headers.get("x-aliyun-captcha-verify-region")).toBeNull();
    // The client's custom header should NOT be present (whitelist blocks it).
    expect(upstream.headers.get("x-client-leak")).toBeNull();
  });

  it("allows trusted start-plan runtime Aliyun captcha headers", () => {
    const clientReq = makeClientReq("{}", {
      "x-aliyun-captcha-verify-param": "client-spoof-ignored",
    });
    const upstream = buildUpstreamRequest(
      clientReq, "anthropic", ZAI_PROVIDER,
      { apiKey: "jwt-in-api-key", jwt: "jwt-for-start-plan", provider: "zai", plan: "start-plan" },
      "{}",
      IDENTITY,
      "start-plan",
      {
        "x-aliyun-captcha-verify-param": "fresh-runtime-token",
        "x-aliyun-captcha-verify-region": "cn-shanghai",
      },
    );

    expect(upstream.headers.get("x-aliyun-captcha-verify-param")).toBe("fresh-runtime-token");
    expect(upstream.headers.get("x-aliyun-captcha-verify-region")).toBe("cn-shanghai");
    expect(upstream.headers.get("authorization")).toBe("Bearer jwt-for-start-plan");
  });

  // v0.2.3+: COMPLETE WIRE ORDER test — verifies the exact header sequence
  // matches the real ZCode desktop client's wire shape (2026-06-28 unpacking
  // of app.asar Mf() at offset 886853 + SDK literal at 1085109 + yU at 887429).
  //
  // Real client wire order:
  it("emits the full header set in stable construction order (coding-plan)", () => {
    const h = buildUpstreamHeaders("anthropic", ZAI_CRED, IDENTITY);

    // v0.3.0 order: content-type → [accept-encoding] → anthropic-beta →
    // identity (pio) → trace (synthetic) → anthropic-version → auth.
    // v0.3.8.1: accept-encoding is now the proxy's own value (identity
    // default — the real ZCode Tauri client's encoding), not a client value.
    const expectedOrder = [
      "content-type",
      "accept-encoding",
      "anthropic-beta",
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-Os-Category",
      "X-Os-Version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "x-query-id",
      "x-session-id",
      "x-api-key",
      "anthropic-version",
    ];

    expect(Object.keys(h)).toEqual(expectedOrder);
    expect(h["User-Agent"]).toBe("ZCode/test-1.0.0");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-Agent"]).toBe("glm");
  });

  it("emits host source headers on model requests (v0.3.0 full pio set)", () => {
    // v0.3.0: the refreshed bundle RE (2026-08) shows model requests carry the
    // FULL pio set — language/timezone/channel are no longer host-only.
    const h = buildUpstreamHeaders("anthropic", ZAI_CRED, {
      ...IDENTITY,
      releaseChannel: "stable",
      deviceMid: "device-mid-test",
    });

    expect(h["X-Release-Channel"]).toBe("stable");
    expect(typeof h["X-Client-Language"]).toBe("string");
    expect(typeof h["X-Client-Timezone"]).toBe("string");
    expect(h["X-Device-Mid"]).toBe("device-mid-test");
  });

  it("emits headers in stable construction order (start-plan, Anthropic mirror — v0.3.7 default)", () => {
    // v0.3.7: start-plan routes through the zcode.z.ai Anthropic mirror —
    // authorization: Bearer <jwt> + anthropic-version + anthropic-beta. The
    // trace block uses the exact path (ZCode attribution): without a client
    // session it carries request-id / session-type / trace-id only (no
    // x-query-id / x-session-id — those are coding-plan observe-mode only).
    const jwtCred: Credential = { apiKey: "k", secret: "s", jwt: "jwt-token-xyz", provider: "zai" };
    const h = buildUpstreamHeaders("anthropic", jwtCred, IDENTITY, "start-plan");

    const expectedOrder = [
      "content-type",
      "accept-encoding",
      "anthropic-beta",
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-Os-Category",
      "X-Os-Version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "authorization",
      "anthropic-version",
    ];

    const actualOrder = Object.keys(h);
    expect(actualOrder).toEqual(expectedOrder);

    // Bearer JWT auth, never x-api-key, on the start-plan mirror path.
    expect(h["authorization"]).toBe("Bearer jwt-token-xyz");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(h["x-zcode-trace-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(h["x-query-id"]).toBeUndefined();
    expect(h["x-session-id"]).toBeUndefined();
  });

  it("emits headers in stable construction order (start-plan with JWT, legacy OpenAI upstream)", () => {
    // Legacy ZCODE_STARTPLAN_UPSTREAM=openai path: authorization: Bearer <jwt>,
    // NO anthropic-beta/anthropic-version.
    // The trace block uses the exact path (ZCode attribution): without a
    // client session it carries request-id / session-type / trace-id only.
    const jwtCred: Credential = { apiKey: "k", secret: "s", jwt: "jwt-token-xyz", provider: "zai" };
    const h = buildUpstreamHeaders("openai", jwtCred, IDENTITY, "start-plan");

    const expectedOrder = [
      "content-type",
      "accept-encoding",
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-Os-Category",
      "X-Os-Version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "authorization",
    ];

    const actualOrder = Object.keys(h);
    expect(actualOrder).toEqual(expectedOrder);

    // Verify the JWT auth value.
    expect(h["authorization"]).toBe("Bearer jwt-token-xyz");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(h["x-zcode-trace-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // x-api-key / anthropic-* must NOT be present on the OpenAI gateway path.
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["anthropic-version"]).toBeUndefined();
    expect(h["anthropic-beta"]).toBeUndefined();
  });

  it("uses start-plan apiKey as Bearer auth when jwt field is absent", () => {
    // The real ZCode provider stores zcodejwttoken in provider.apiKey and then
    // normalizes that value into Authorization: Bearer <jwt>. Support the same
    // shape for manual/API-key mode credentials that do not have a separate jwt field.
    const h = buildUpstreamHeaders(
      "anthropic",
      { apiKey: "jwt-from-api-key", provider: "zai" },
      IDENTITY,
      "start-plan",
    );

    expect(h["authorization"]).toBe("Bearer jwt-from-api-key");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["x-zcode-trace-id"]).toBeTruthy();
    expect(h["x-api-key"]).toBeUndefined();
  });

  it("does not double-prefix start-plan Bearer auth", () => {
    const h = buildUpstreamHeaders(
      "anthropic",
      { apiKey: "dummy", jwt: "Bearer jwt-already-prefixed", provider: "zai" },
      IDENTITY,
      "start-plan",
    );

    expect(h["authorization"]).toBe("Bearer jwt-already-prefixed");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["x-zcode-trace-id"]).toBeTruthy();
    expect(h["x-api-key"]).toBeUndefined();
  });

  it("emits headers in stable construction order (OpenAI format)", () => {
    // v0.3.0: OpenAI upstream — identity block first, then trace, then
    // authorization Bearer. NO anthropic-version/beta.
    const h = buildUpstreamHeaders("openai", ZAI_CRED, IDENTITY);

    const expectedOrder = [
      "content-type",
      "accept-encoding",
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-Os-Category",
      "X-Os-Version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "x-query-id",
      "x-session-id",
      "authorization",
    ];
    expect(Object.keys(h)).toEqual(expectedOrder);
    expect(h["authorization"]).toBe("Bearer testkey.testsecret");
  });

  // v0.3.8.1: accept-encoding is the proxy's OWN fingerprint decision — the
  // real ZCode Tauri client sends `accept-encoding: identity` (upstream
  // zcode-api wire captures), and forwarding client gzip values made the
  // zcode.z.ai ESA edge compress SSE passthrough bodies, silently killing
  // token stats / heartbeat (the "in:- out:-" regression). Env escape hatch:
  // ZCODE_UPSTREAM_ACCEPT_ENCODING.
  it("advertises identity by default (v0.3.8.1+: real ZCode Tauri client value)", () => {
    const h = buildUpstreamHeaders("anthropic", ZAI_CRED, IDENTITY);
    expect(h["accept-encoding"]).toBe("identity");
  });

  it("does NOT forward the client's accept-encoding (v0.3.8.1+)", () => {
    const clientReq = makeClientReq("{}", { "accept-encoding": "gzip, deflate, br, zstd" });
    const upstream = buildUpstreamRequest(clientReq, "anthropic", ZAI_PROVIDER, ZAI_CRED, "{}", IDENTITY);
    expect(upstream.headers.get("accept-encoding")).toBe("identity");
  });

  it("ZCODE_UPSTREAM_ACCEPT_ENCODING overrides the advertised value", () => {
    const original = process.env.ZCODE_UPSTREAM_ACCEPT_ENCODING;
    try {
      process.env.ZCODE_UPSTREAM_ACCEPT_ENCODING = "gzip";
      const h = buildUpstreamHeaders("anthropic", ZAI_CRED, IDENTITY);
      expect(h["accept-encoding"]).toBe("gzip");
    } finally {
      if (original === undefined) delete process.env.ZCODE_UPSTREAM_ACCEPT_ENCODING;
      else process.env.ZCODE_UPSTREAM_ACCEPT_ENCODING = original;
    }
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
    identity: IDENTITY,    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

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

  it("times out and cancels stalled client request bodies before upstream fetch", async () => {
    _setRequestBodyIdleTimeoutForTesting(20);
    try {
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          canceled = true;
        },
      });
      const fetchMock = mock(async (): Promise<Response> => {
        throw new Error("fetch should not be called");
      });
      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const clientReq = new Request("http://localhost:8080/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
      });

      const result = await Promise.race([
        proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any }),
        new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 500)),
      ]);

      expect(result).not.toBe("hung");
      const resp = result as Response;
      expect(resp.status).toBe(408);
      const body = await resp.json();
      expect(body.error.type).toBe("request_timeout");
      expect(fetchMock).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(canceled).toBe(true);
    } finally {
      _setRequestBodyIdleTimeoutForTesting();
    }
  });

  it("unrefs the upstream request timeout timer", async () => {
    const originalSetTimeout = globalThis.setTimeout as any;
    const unrefDelays: number[] = [];
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args) as any;
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefDelays.push(Number(timeout));
        return originalUnref?.();
      };
      return timer;
    };

    try {
      const config: ProxyConfig = {
        ...testConfig,
        server: { ...testConfig.server, upstreamTimeoutMs: 1234 },
      };
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(
          '{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Hello"}],"model":"glm-4.6","stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}',
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

      const resp = await proxyRequest(clientReq, "anthropic", { config, auth, fetchImpl: fetchMock as any });

      expect(resp.status).toBe(200);
      await resp.text();
      expect(unrefDelays).toContain(1234);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
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

  // v0.3.4: client-disconnect propagation. The server adapter aborts the
  // inbound Request's signal when the TCP client disappears; proxyRequest
  // must cancel the in-flight upstream fetch (not let it run to completion)
  // and return 499 instead of retrying.
  it("aborts the upstream fetch and returns 499 when the client disconnects mid-batch", async () => {
    const ac = new AbortController();
    let upstreamAborted = false;
    const fetchMock = mock(async (_req: Request, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(new Error("upstream aborted"));
        });
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}',
      signal: ac.signal,
    });

    const pending = proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });
    // Give the fetch a tick to start, then kill the client connection.
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    const resp = await pending;
    expect(resp.status).toBe(499);
    const body = await resp.json() as { error: { type: string } };
    expect(body.error.type).toBe("client_disconnected");
    // The upstream fetch WAS cancelled (quota no longer burns for dead clients).
    expect(upstreamAborted).toBe(true);
    // ...and exactly one upstream call happened (no retries for a dead client).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the retry loop entirely when the client disconnects during backoff", async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetchMock = mock(async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify({ error: { type: "overloaded_error" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      });
    });

    const retryConfig: ProxyConfig = {
      ...testConfig,
      retry: { maxRetries: 5, initialDelayMs: 60, maxDelayMs: 1000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
    };
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}',
      signal: ac.signal,
    });

    const pending = proxyRequest(clientReq, "anthropic", { config: retryConfig, auth, fetchImpl: fetchMock as any });
    // First attempt returns 529 → retry loop sleeps 60ms. Abort mid-sleep.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    const resp = await pending;
    expect(resp.status).toBe(499);
    const body = await resp.json() as { error: { type: string } };
    expect(body.error.type).toBe("client_disconnected");
    // Only the FIRST attempt ran — the loop exited before attempt #2.
    expect(calls).toBe(1);
  });

  it("decompresses gzip passthrough bodies and strips the encoding header (v0.3.8.1)", async () => {
    // v0.3.7 forwarded the raw gzip bytes + content-encoding header, which
    // silently killed the token-stats observer ("in:- out:-" regression).
    // v0.3.8.1 decompresses in-stream: the client receives plaintext and the
    // stale content-encoding/content-length headers are stripped.
    const payload = '{"id":"msg_1","usage":{"input_tokens":11,"output_tokens":7},"content":[{"text":"Hello"}]}';
    const gz = gzipSync(Buffer.from(payload, "utf-8")) as unknown as Uint8Array;
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response(gz as Uint8Array<ArrayBuffer>, {
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
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(await resp.text()).toBe(payload);
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

  it("rejects oversized request bodies from Content-Length before upstream fetch", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("unexpected"));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const config: ProxyConfig = {
      ...testConfig,
      server: { ...testConfig.server, maxRequestBodyBytes: 8 },
    };
    const clientReq = makeClientReq("{}", { "content-length": "128" });

    const resp = await proxyRequest(clientReq, "anthropic", { config, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.type).toBe("request_body_too_large");
  });

  it("cancels declared oversized request bodies without reading them", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("unexpected"));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const config: ProxyConfig = {
      ...testConfig,
      server: { ...testConfig.server, maxRequestBodyBytes: 8 },
    };
    let bodyCancelled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "128" },
      body: stream,
    } as RequestInit);

    const resp = await proxyRequest(clientReq, "anthropic", { config, auth, fetchImpl: fetchMock as any });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resp.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bodyCancelled).toBe(true);
    expect(pullCount).toBe(0);
  });

  it("rejects oversized streamed request bodies while reading", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("unexpected"));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const config: ProxyConfig = {
      ...testConfig,
      server: { ...testConfig.server, maxRequestBodyBytes: 10 },
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("12345"));
        controller.enqueue(encoder.encode("678901"));
        controller.close();
      },
    });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
    } as RequestInit);

    const resp = await proxyRequest(clientReq, "anthropic", { config, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.message).toContain("limit 10 bytes");
  });

  it("logs request body size using UTF-8 bytes", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      const upstreamBody = JSON.stringify({
        id: "msg_utf8",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const fetchMock = mock(async (): Promise<Response> =>
        new Response(upstreamBody, { status: 200, headers: { "content-type": "application/json" } }),
      );
      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const requestBody = JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: [{ type: "text", text: "汉" }] }],
      });

      const resp = await proxyRequest(makeClientReq(requestBody), "anthropic", {
        config: testConfig,
        auth,
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const expectedBytes = new TextEncoder().encode(requestBody).byteLength;
      expect(logs.some(line => line.includes(`(${expectedBytes} bytes)`))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it("debug body preview truncates by UTF-8 bytes", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      const upstreamError = "汉".repeat(600);
      const expectedBytes = new TextEncoder().encode(upstreamError).byteLength;
      const fetchMock = mock(async (): Promise<Response> =>
        new Response(upstreamError, { status: 400, headers: { "content-type": "text/plain" } }),
      );
      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const config: ProxyConfig = {
        ...testConfig,
        logging: { ...testConfig.logging, debug: true },
      };

      const resp = await proxyRequest(makeClientReq('{"model":"glm-4.6","messages":[]}'), "anthropic", {
        config,
        auth,
        fetchImpl: fetchMock as any,
      });
      await resp.text();

      for (let i = 0; i < 20 && !logs.some(line => line.includes("[debug] body preview")); i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      const line = logs.find(item => item.includes("[debug] body preview")) ?? "";
      expect(line).toContain(`${expectedBytes} bytes`);
      expect(line).toContain(`truncated, total ${expectedBytes} bytes`);
      expect(line).not.toContain("chars");
      expect(line).not.toContain("\uFFFD");
    } finally {
      console.log = originalLog;
    }
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

  it("passes through large JSON bodies without consuming them for usage stats", async () => {
    const bigText = "x".repeat(2 * 1024 * 1024 + 64 * 1024);
    const upstreamBody = JSON.stringify({
      usage: { input_tokens: 10, output_tokens: 5 },
      payload: bigText,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(upstreamBody.slice(0, 1024 * 1024)));
        controller.enqueue(encoder.encode(upstreamBody.slice(1024 * 1024)));
        controller.close();
      },
    });
    const fetchMock = mock(async (): Promise<Response> => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(upstreamBody);
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
    identity: IDENTITY,    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

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

  it("rejects translated batch responses whose Content-Length exceeds the body limit without reading them", async () => {
    const originalLimit = process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES;
    process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES = String(1024 * 1024);
    let canceled = false;

    try {
      const upstreamBody = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(upstreamBody, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024 + 1),
          },
        });
      });

      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

      const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error.type).toBe("translation_failed");
      expect(body.error.message).toContain("Translated upstream response is too large");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(canceled).toBe(true);
    } finally {
      if (originalLimit === undefined) delete process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES;
      else process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES = originalLimit;
    }
  });

  it("rejects chunked translated batch responses once the body grows past the limit", async () => {
    const originalLimit = process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES;
    process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES = String(1024 * 1024);

    try {
      const chunk = new Uint8Array(512 * 1024);
      chunk.fill(65);
      let sent = 0;
      const upstreamBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          if (sent <= 6) {
            controller.enqueue(chunk);
            return;
          }
          controller.close();
        },
      });
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(upstreamBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

      const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error.type).toBe("translation_failed");
      expect(body.error.message).toContain("Translated upstream response is too large");
    } finally {
      if (originalLimit === undefined) delete process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES;
      else process.env.ZCODE_TRANSLATED_RESPONSE_MAX_BYTES = originalLimit;
    }
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

  it("returns 502 when SSE-to-batch reassembly exceeds the configured byte limit", async () => {
    const originalLimit = process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES;
    process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES = "512";
    try {
      const sseBody = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_big","model":"glm-4.6","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"',
        "x".repeat(2048),
        '"}}\n\n',
      ].join("");
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
      });

      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}],"stream":false}');

      const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error.type).toBe("upstream_stream_error");
      expect(body.error.message).toContain("SSE->batch response exceeded 512 byte limit");
    } finally {
      if (originalLimit === undefined) delete process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES;
      else process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES = originalLimit;
    }
  });

  it("ignores malformed SSE-to-batch byte limit env values instead of flooring them", async () => {
    const originalLimit = process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES;
    process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES = "512.9";
    try {
      const sseBody = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok","model":"glm-4.6","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"',
        "x".repeat(2048),
        '"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("");
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
      });

      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
      const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}],"stream":false}');

      const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.choices[0].message.content).toContain("x".repeat(128));
    } finally {
      if (originalLimit === undefined) delete process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES;
      else process.env.ZCODE_SSE_TO_BATCH_MAX_BYTES = originalLimit;
    }
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

  it("preserves synthetic 529 when detector converts malformed JSON 200 in translation mode", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(529);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_error");
  });

  it("preserves upstream status when upstream returns non-2xx in translation mode", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"error":"bad request"}', { status: 400, headers: { "content-type": "application/json" } });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_error");
  });

  it("cancels non-2xx upstream bodies after previewing them in translation mode", async () => {
    let canceled = false;
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }), {
        status: 400,
        headers: {
          "content-type": "application/json",
          "content-length": String(128 * 1024),
        },
      });
    });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_error");
    expect(canceled).toBe(true);
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
    identity: IDENTITY,    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };

  it("Anthropic client request uses decompress:false passthrough and inflates compressed bodies", async () => {
    const payload = '{"id":"msg_1","content":[{"type":"text","text":"Hi"}]}';
    const gz = gzipSync(Buffer.from(payload, "utf-8")) as unknown as Uint8Array;
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response(gz as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    });

    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, auth, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(await resp.text()).toBe(payload);
  });

  it("start-plan request routes through the zcode.z.ai Anthropic mirror (v0.3.7)", async () => {
    // v0.3.7: the OpenAI gateway path (/api/v1/zcode-plan/chat/completions)
    // was removed server-side (404); start-plan routes through the Anthropic
    // mirror with Bearer JWT auth. OpenAI-format clients are translated
    // OpenAI→Anthropic on the request and Anthropic→OpenAI on the response.
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalUpstreamStyle = process.env.ZCODE_STARTPLAN_UPSTREAM;
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    delete process.env.ZCODE_STARTPLAN_UPSTREAM;
    const captchaTokenProvider = mock(async () => {
      return { verifyParam: "fresh-preflight-param", region: "cn-shanghai", solveMs: 11 };
    });

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        // v0.3.7: start-plan hits the Anthropic mirror — NOT the removed
        // OpenAI gateway path.
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
        expect(req.headers.get("x-api-key")).toBeNull();
        expect(req.headers.get("anthropic-beta")).toBeTruthy();
        expect(req.headers.get("x-zcode-trace-id")).toMatch(/^[0-9a-f-]{36}$/i);
        expect(req.headers.get("x-zcode-session-type")).toBe("main");
        expect(req.headers.get("x-aliyun-captcha-verify-param")).toBe("fresh-preflight-param");
        expect(req.headers.get("x-aliyun-captcha-verify-region")).toBe("cn-shanghai");
        const reqBody = JSON.parse(await req.text());
        // OpenAI client translated to the Anthropic wire shape: messages[],
        // max_tokens, stream forced on (alignZCodeRequestFormat).
        expect(Array.isArray(reqBody.messages)).toBe(true);
        expect(reqBody.messages[0].role).toBe("user");
        // start-plan system blocks injected into top-level system[]
        // (applyStartPlanSystem — the gateway 3012 content check requires them).
        expect(Array.isArray(reqBody.system)).toBe(true);
        expect(reqBody.system[0].text).toBe("You are ZCode, an interactive coding agent");
        expect(reqBody.stream).toBe(true);
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

      const resp = await proxyRequest(clientReq, "openai", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captchaTokenProvider).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("application/json");
      const body = await resp.json();
      // Anthropic upstream response translated back to OpenAI chat.completion.
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("start-plan reply");
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalUpstreamStyle === undefined) delete process.env.ZCODE_STARTPLAN_UPSTREAM;
      else process.env.ZCODE_STARTPLAN_UPSTREAM = originalUpstreamStyle;
    }
  });

  it("start-plan anthropic client passes through to the mirror untranslated (v0.3.7 user regression)", async () => {
    // The exact user-reported scenario: Claude Code (anthropic /v1/messages)
    // on a start-plan account — previously 404 "404 page not found" from the
    // removed OpenAI gateway; now the Anthropic mirror with passthrough body.
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalUpstreamStyle = process.env.ZCODE_STARTPLAN_UPSTREAM;
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    delete process.env.ZCODE_STARTPLAN_UPSTREAM;
    const captchaTokenProvider = mock(async () => {
      return { verifyParam: "fresh-preflight-param", region: "cn-shanghai", solveMs: 11 };
    });

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
        expect(req.headers.get("x-api-key")).toBeNull();
        expect(req.headers.get("x-aliyun-captcha-verify-param")).toBe("fresh-preflight-param");
        const reqBody = JSON.parse(await req.text());
        // Anthropic client → NO request translation; the body keeps the
        // Anthropic wire shape (messages[] + top-level system[] + max_tokens).
        expect(Array.isArray(reqBody.messages)).toBe(true);
        expect(reqBody.messages[0].role).toBe("user");
        expect(Array.isArray(reqBody.system)).toBe(true);
        expect(reqBody.system[0].text).toBe("You are ZCode, an interactive coding agent");
        expect(typeof reqBody.max_tokens).toBe("number");
        return new Response(JSON.stringify({
          id: "msg_sp_ant",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "mirror passthrough reply" }],
          model: "glm-5.3",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-5.3","max_tokens":1024,"thinking":{"type":"adaptive"},"messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "anthropic", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      // Anthropic upstream + anthropic client → response passthrough.
      expect(body.type).toBe("message");
      expect(body.content[0].text).toBe("mirror passthrough reply");
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalUpstreamStyle === undefined) delete process.env.ZCODE_STARTPLAN_UPSTREAM;
      else process.env.ZCODE_STARTPLAN_UPSTREAM = originalUpstreamStyle;
    }
  });

  it("ZCODE_STARTPLAN_UPSTREAM=openai restores the legacy gateway pipeline (escape hatch)", async () => {
    // The server flipped endpoints once already — this guards the escape
    // hatch so users can flip back without a new release if the OpenAI
    // gateway endpoint ever returns.
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalUpstreamStyle = process.env.ZCODE_STARTPLAN_UPSTREAM;
    process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
    process.env.ZCODE_STARTPLAN_UPSTREAM = "openai";

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/chat/completions");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        expect(req.headers.get("anthropic-version")).toBeNull();
        const reqBody = JSON.parse(await req.text());
        // Legacy gateway pipeline: OpenAI body + gateway system blocks as
        // leading system messages.
        expect(reqBody.messages[0].role).toBe("system");
        expect(reqBody.messages[0].content).toContain("You are ZCode");
        return new Response(JSON.stringify({
          id: "chatcmpl-legacy",
          object: "chat.completion",
          created: 1750000000,
          model: "glm-4.6",
          choices: [{ index: 0, message: { role: "assistant", content: "legacy gateway reply" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.choices[0].message.content).toBe("legacy gateway reply");
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalUpstreamStyle === undefined) delete process.env.ZCODE_STARTPLAN_UPSTREAM;
      else process.env.ZCODE_STARTPLAN_UPSTREAM = originalUpstreamStyle;
    }
  });

  it("keeps the explicit client session id stable across start-plan retry attempts", async () => {
    // v0.3.0 (upstream v2.6.0 session-context): when the client identifies its
    // session (Claude Code's x-claude-code-session-id), the proxy reuses the
    // SAME upstream session id across retry attempts — replicating ZCode's
    // single-user-identity UUID generation. Without an explicit session every
    // attempt gets fresh synthetic ids.
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
      // Session inference must be ON for the explicit-session path.
      clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
      retry: {
        ...testConfig.retry,
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        retryableStatuses: [529],
      },
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
    const successBody = JSON.stringify({
      id: "msg_sp_retry",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok after retry" }],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4 },
    });
    const seen: Array<{
      requestId: string | null;
      traceId: string | null;
      sessionId: string | null;
    }> = [];

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        seen.push({
          requestId: req.headers.get("x-request-id"),
          traceId: req.headers.get("x-zcode-trace-id"),
          sessionId: req.headers.get("x-session-id"),
        });
        await req.text();
        if (seen.length === 1) {
          return new Response(JSON.stringify({ error: { type: "overloaded" } }), {
            status: 529,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(successBody, { status: 200, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": "3aeca633-bcc3-48be-b175-49cc0a4fad1e" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Both attempts carry a UUID request id; retry gets a FRESH one.
      expect(seen[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(seen[1].requestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(seen[0].requestId).not.toBe(seen[1].requestId);
      // Explicit client session → the SAME upstream session id on both attempts.
      expect(seen[0].sessionId).toBeTruthy();
      expect(seen[0].sessionId).toBe(seen[1].sessionId);
      const body = await resp.json();
      expect(body.choices[0].message.content).toBe("ok after retry");
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
    }
  });

  it("refreshes start-plan captcha preflight headers again after WAF proxy rotation", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
    const tempStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-upstream-pool-"));
    const wafHtml = '<html><body><img src="https://errors.aliyun.com/error.png">blocked</body></html>';
    const successBody = JSON.stringify({
      id: "msg_rotated_preflight",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok after preflight rotation" }],
      model: "glm-5.2",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4 },
    });
    const seenProxies: Array<string | undefined> = [];
    const seenCaptchaHeaders: Array<string | null> = [];
    let captchaSeq = 0;

    try {
      process.env.ZCODE_PROXY_STORE_DIR = tempStoreDir;
      delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      resetProxyPoolForTesting();
      await importFromText("1.1.1.1:8080\n2.2.2.2:8080", true);
      await updatePoolConfig({ enabled: true, maxRotations: 2, rotateOnGatewayBlock: true });

      const fetchMock = mock(async (req: Request, init?: RequestInit & { proxy?: string }): Promise<Response> => {
        seenProxies.push(init?.proxy);
        seenCaptchaHeaders.push(req.headers.get("x-aliyun-captcha-verify-param"));
        if (seenProxies.length === 1) {
          return new Response(wafHtml, {
            status: 405,
            headers: { "content-type": "text/html", server: "Tengine" },
          });
        }
        return new Response(successBody, { status: 200, headers: { "content-type": "application/json" } });
      });
      const captchaTokenProvider = mock(async () => {
        captchaSeq++;
        return { verifyParam: `fresh-preflight-${captchaSeq}`, region: "cn-shanghai", solveMs: 7 };
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider,
      });

      expect(resp.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(captchaTokenProvider).toHaveBeenCalledTimes(2);
      expect(seenProxies).toEqual(["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
      expect(seenCaptchaHeaders).toEqual(["fresh-preflight-1", "fresh-preflight-2"]);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
      else process.env.ZCODE_PROXY_STORE_DIR = originalStoreDir;
      resetProxyPoolForTesting();
      rmSync(tempStoreDir, { recursive: true, force: true });
    }
  });

  it("cancels captcha-failed 403 response bodies before solving and retrying", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalFetch = globalThis.fetch;
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
    const captchaConfigFetchMock = mock(async (): Promise<Response> => {
      return new Response("config unavailable", { status: 500 });
    });
    globalThis.fetch = captchaConfigFetchMock as unknown as typeof fetch;
    let canceled = false;
    const captchaFailurePayload = JSON.stringify({ code: 3007, msg: "captcha verify failed" })
      + "x".repeat(70 * 1024);

    try {
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(captchaFailurePayload));
          },
          cancel() {
            canceled = true;
          },
        }), { status: 403, headers: { "content-type": "application/json" } });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });
      expect(resp.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captchaConfigFetchMock).toHaveBeenCalledTimes(1);
      expect(canceled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
    }
  });

  it("checks start-plan captcha after WAF proxy rotation instead of returning 3007", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalFetch = globalThis.fetch;
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
    const tempStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-upstream-pool-"));
    const captchaConfigFetchMock = mock(async (): Promise<Response> => {
      return new Response("config unavailable", { status: 500 });
    });
    const wafHtml = '<html><body><img src="https://errors.aliyun.com/error.png">blocked</body></html>';
    const captchaFailurePayload = JSON.stringify({ code: 3007, msg: "captcha verify failed" });
    const seenProxies: Array<string | undefined> = [];

    try {
      process.env.ZCODE_PROXY_STORE_DIR = tempStoreDir;
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
      resetProxyPoolForTesting();
      await importFromText("1.1.1.1:8080\n2.2.2.2:8080", true);
      await updatePoolConfig({ enabled: true, maxRotations: 2, rotateOnGatewayBlock: true });
      globalThis.fetch = captchaConfigFetchMock as unknown as typeof fetch;

      const fetchMock = mock(async (_req: Request, init?: RequestInit & { proxy?: string }): Promise<Response> => {
        seenProxies.push(init?.proxy);
        if (seenProxies.length === 1) {
          return new Response(wafHtml, {
            status: 405,
            headers: { "content-type": "text/html", server: "Tengine" },
          });
        }
        return new Response(captchaFailurePayload, {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, auth, fetchImpl: fetchMock as any });

      expect(resp.status).toBe(503);
      const body = await resp.json();
      expect(body.error.type).toBe("captcha_failed");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(captchaConfigFetchMock).toHaveBeenCalledTimes(1);
      expect(seenProxies).toEqual(["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
      else process.env.ZCODE_PROXY_STORE_DIR = originalStoreDir;
      resetProxyPoolForTesting();
      rmSync(tempStoreDir, { recursive: true, force: true });
    }
  });

  it("returns captcha_failed when captcha retry is rejected with another 3007", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
    const tempStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-upstream-pool-"));
    const captchaFailurePayload = JSON.stringify({ code: 3007, msg: "captcha verify failed" });
    const seenCaptchaHeaders: Array<string | null> = [];

    try {
      process.env.ZCODE_PROXY_STORE_DIR = tempStoreDir;
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
      resetProxyPoolForTesting();

      const fetchMock = mock(async (req: Request): Promise<Response> => {
        seenCaptchaHeaders.push(req.headers.get("x-aliyun-captcha-verify-param"));
        return new Response(captchaFailurePayload, {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      });
      const captchaTokenProvider = mock(async (_reqId: string | undefined, _opts?: { solver?: string }) => {
        // v0.3.0: pool-based take — no solver strategy parameter anymore.
        return { verifyParam: "fake-captcha-param", region: "cn-shanghai", solveMs: 7 };
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider,
      });

      expect(resp.status).toBe(503);
      const body = await resp.json();
      expect(body.error.type).toBe("captcha_failed");
      expect(body.error.message).toContain("after solving once");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(captchaTokenProvider).toHaveBeenCalledTimes(1);
      expect(seenCaptchaHeaders).toEqual([null, "fake-captcha-param"]);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
      else process.env.ZCODE_PROXY_STORE_DIR = originalStoreDir;
      resetProxyPoolForTesting();
      rmSync(tempStoreDir, { recursive: true, force: true });
    }
  });

  it("continues WAF rotation when captcha retry after rotation is WAF-blocked", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      plan: "start-plan",
    };
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    const originalStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
    const tempStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-upstream-pool-"));
    const wafHtml = '<html><body><img src="https://errors.aliyun.com/error.png">blocked</body></html>';
    const captchaFailurePayload = JSON.stringify({ code: 3007, msg: "captcha verify failed" });
    // v0.3.7: start-plan upstream is the Anthropic mirror — success body is
    // an anthropic message, translated back to the OpenAI client.
    const successBody = JSON.stringify({
      id: "msg_rotated",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok after third proxy" }],
      model: "glm-5.2",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4 },
    });
    const seenProxies: Array<string | undefined> = [];
    const seenCaptchaHeaders: Array<string | null> = [];

    try {
      process.env.ZCODE_PROXY_STORE_DIR = tempStoreDir;
      process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
      resetProxyPoolForTesting();
      await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080", true);
      await updatePoolConfig({ enabled: true, maxRotations: 3, rotateOnGatewayBlock: true });

      const fetchMock = mock(async (req: Request, init?: RequestInit & { proxy?: string }): Promise<Response> => {
        seenProxies.push(init?.proxy);
        seenCaptchaHeaders.push(req.headers.get("x-aliyun-captcha-verify-param"));
        if (seenProxies.length === 1) {
          return new Response(wafHtml, {
            status: 405,
            headers: { "content-type": "text/html", server: "Tengine" },
          });
        }
        if (seenProxies.length === 2) {
          return new Response(captchaFailurePayload, {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        if (seenProxies.length === 3) {
          return new Response(wafHtml, {
            status: 405,
            headers: { "content-type": "text/html", server: "Tengine" },
          });
        }
        return new Response(successBody, { status: 200, headers: { "content-type": "application/json" } });
      });
      const captchaTokenProvider = mock(async () => {
        return { verifyParam: "fake-captcha-param", region: "cn-shanghai", solveMs: 7 };
      });

      const auth = new AuthManager({ mode: "oauth", provider: "zai" });
      auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", plan: "start-plan", jwt: "jwt-mock" });
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", {
        config: startPlanConfig,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider,
      });

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.choices[0].message.content).toBe("ok after third proxy");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(captchaTokenProvider).toHaveBeenCalledTimes(1);
      expect(seenProxies).toEqual([
        "http://1.1.1.1:8080",
        "http://2.2.2.2:8080",
        "http://2.2.2.2:8080",
        "http://3.3.3.3:8080",
      ]);
      expect(seenCaptchaHeaders).toEqual([null, null, "fake-captcha-param", null]);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
      else process.env.ZCODE_PROXY_STORE_DIR = originalStoreDir;
      resetProxyPoolForTesting();
      rmSync(tempStoreDir, { recursive: true, force: true });
    }
  });

  it("uses the active credential plan even when config.plan is stale", async () => {
    const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = "0";
    const staleConfig: ProxyConfig = {
      ...testConfig,
      // Simulates config.yaml still saying coding-plan after a start-plan account
      // became active. The request must follow the credential, not the stale config.
      plan: "coding-plan",
    };

    const fetchMock = mock(async (req: Request): Promise<Response> => {
      // v0.3.7: start-plan routes through the zcode.z.ai Anthropic mirror.
      expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
      expect(req.headers.get("authorization")).toBe("Bearer jwt-from-active-account");
      expect(req.headers.get("x-api-key")).toBeNull();
      const reqBody = JSON.parse(await req.text());
      // OpenAI client translated to the Anthropic wire shape; start-plan
      // system blocks in top-level system[].
      expect(Array.isArray(reqBody.messages)).toBe(true);
      expect(Array.isArray(reqBody.system)).toBe(true);
      expect(reqBody.system[0].text).toBe("You are ZCode, an interactive coding agent");
      return new Response(JSON.stringify({
        id: "msg_plan",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "credential plan wins" }],
        model: "glm-4.6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({
      apiKey: "dummy",
      provider: "zai",
      plan: "start-plan",
      jwt: "jwt-from-active-account",
    });
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    try {
      const resp = await proxyRequest(clientReq, "openai", { config: staleConfig, auth, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.choices[0].message.content).toBe("credential plan wins");
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
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
    identity: IDENTITY,    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

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
