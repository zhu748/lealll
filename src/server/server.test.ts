/**
 * Tests for server routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret", ...overrides.auth },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3, totalDeadlineMs: 0 },
    ...overrides,
  };
}

function mockUpstream(): typeof fetch {
  return (async (req: Request): Promise<Response> => {
    const url = req.url;
    if (url.includes("/v1/models") || req.method === "GET") {
      return new Response('{"object":"list","data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = await req.text();
    const parsed = JSON.parse(body);
    if (url.includes("/anthropic/") || url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from upstream" }],
          model: parsed.model ?? "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: parsed.model ?? "glm-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello from upstream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("server routing", () => {
  it("GET /v1/models returns model list", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].object).toBe("model");
  });

  it("POST /v1/chat/completions forwards to upstream", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("Hello from upstream");
  });

  it("POST /v1/messages forwards to Anthropic upstream", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("GET /health returns ok status", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  it("unknown route returns 404", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/unknown", { method: "GET" }));
    expect(resp.status).toBe(404);
  });

  it("returns structured 500 when an unexpected route error escapes", async () => {
    const config = makeConfig();
    const auth = {
      getCredential: async () => ({ apiKey: "testkey", secret: "testsecret", provider: "zai" }),
      getMode: () => { throw new Error("mode exploded"); },
    } as unknown as AuthManager;
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });
    const originalError = console.error;
    console.error = () => {};
    try {
      const resp = await handler(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
        }),
      );
      expect(resp.status).toBe(500);
      expect(resp.headers.get("content-type")).toContain("application/json");
      expect(resp.headers.get("access-control-allow-origin")).toBe("*");
      const body = await resp.json();
      expect(body.error.type).toBe("internal_server_error");
      expect(body.error.message).toContain("mode exploded");
    } finally {
      console.error = originalError;
    }
  });
});

describe("proxy API key auth", () => {
  it("rejects request without proxy API key when configured", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(401);
  });

  it("accepts request with correct Bearer proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("accepts request with correct x-api-key proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { "x-api-key": "proxy-secret" },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("rejects request with wrong proxy key", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong-key" },
      }),
    );
    expect(resp.status).toBe(401);
  });

  it("does not require proxy key when proxyApiKey is unset", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "test" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(200);
  });
});

describe("CORS", () => {
  it("OPTIONS returns 204 with CORS headers", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 'null' for unknown Origin when no allowlist is configured (secure default)", async () => {
    // M23 fix: previously the proxy echoed any Origin back when no allowlist
    // was configured, which defeated the purpose of CORS. The secure default
    // is now to deny cross-origin browser access unless the operator has
    // explicitly opted in via ZCODE_PROXY_CORS_ALLOWLIST.
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(resp.headers.get("access-control-allow-origin")).toBe("null");
    expect(resp.headers.get("vary")).toBe("origin");
  });

  it("echoes Origin when it's in the allowlist", async () => {
    const config = makeConfig({ corsAllowList: ["https://my-dashboard.local"] } as any);
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://my-dashboard.local" },
      }),
    );
    expect(resp.headers.get("access-control-allow-origin")).toBe("https://my-dashboard.local");
  });

  it("returns 'null' for Origin NOT in the allowlist", async () => {
    const config = makeConfig({ corsAllowList: ["https://my-dashboard.local"] } as any);
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(resp.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("falls back to '*' when no Origin header is present (server-to-server)", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("OPTIONS returns 'null' for unknown Origin", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("OPTIONS echoes Origin when in allowlist", async () => {
    const config = makeConfig({ corsAllowList: ["https://my-dashboard.local"] } as any);
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        method: "OPTIONS",
        headers: { origin: "https://my-dashboard.local" },
      }),
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("https://my-dashboard.local");
  });

  it("uses the current CORS allowlist after config hot-swap", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth });

    const before = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://hot.example.com" },
      }),
    );
    expect(before.headers.get("access-control-allow-origin")).toBe("null");

    (config as any).corsAllowList = ["https://hot.example.com"];
    const after = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://hot.example.com" },
      }),
    );
    expect(after.headers.get("access-control-allow-origin")).toBe("https://hot.example.com");
  });
});

describe("route handler exports", () => {
  it("handleListModels returns model list", () => {
    const resp = handleListModels();
    expect(resp.status).toBe(200);
  });

  it("handleMessages is a function", () => {
    expect(typeof handleMessages).toBe("function");
  });
});

describe("async (off-peak) bridge routes", () => {
  it("returns 404 when async is disabled (default)", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(404);
  });

  it("returns 400 async_credentials_unavailable when the active credential lacks a JWT", async () => {
    const config = makeConfig();
    (config.async as any).enabled = true;
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("async_credentials_unavailable");
  });

  it("GET /async/v1/health proxies ticket availability with a JWT-bearing credential", async () => {
    const config = makeConfig();
    (config.async as any).enabled = true;
    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    auth.setOAuthCredential({
      apiKey: "ak", secret: "sec", provider: "zai", plan: "coding-plan", userId: "u1",
      jwt: "the-jwt",
    });

    // Mock the off-peak control plane: availability probe returns can_take_number.
    const offPeakFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/off-peak/ticket/availability")) {
        return new Response(JSON.stringify({ code: 0, data: { can_take_number: true } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: offPeakFetch });
    const resp = await handler(new Request("http://localhost/async/v1/health", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { canTakeNumber?: boolean };
    expect(body.canTakeNumber).toBe(true);
  });

  it("unknown /async/* path returns 404", async () => {
    const config = makeConfig();
    (config.async as any).enabled = true;
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" });
    const handler = createFetchHandler({ config, auth, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/async/v1/unknown", { method: "POST" }));
    expect(resp.status).toBe(404);
  });
});
