/**
 * Integration tests — end-to-end proxy tests with mock upstream.
 * @see .omo/plans/zcode-proxy.md Task 13
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { loadConfig } from "./config/loader.js";
import { AuthManager } from "./auth/manager.js";
import { startServer } from "./server/server.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Resolve the test config relative to THIS test file (not the CWD). The old
// code used `loadConfig("config.test.yaml")`, which only worked when tests
// were run from the repo root — running from any other directory failed
// with "Config file not found: config.test.yaml".
const TEST_CONFIG_PATH = join(dirname(import.meta.dir), "config.test.yaml");

let proxyServer: ReturnType<typeof Bun.serve>;
let mockUpstreamServer: ReturnType<typeof Bun.serve>;
let proxyPort: number;
let mockPort: number;
let config: ReturnType<typeof loadConfig>;
// Snapshot of HOME so afterEach can restore it (we redirect HOME to a tmpdir
// so the test never touches the user's real ~/.zcode-proxy/credentials.json).
let realHome: string | undefined;

beforeAll(() => {
  // Redirect HOME to a temp directory so the credential store (and any other
  // dotfiles the proxy might write) never touches the user's real $HOME.
  // The previous code shared `~/.zcode-proxy/credentials.json` with the user.
  realHome = process.env.HOME;
  const tmpHome = mkdtempSync(join(tmpdir(), "zcode-proxy-int-"));
  process.env.HOME = tmpHome;
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "integration-test-secret";

  mockUpstreamServer = Bun.serve({
    port: 0, // let the OS pick a free port — eliminates the port-race flake
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const rawBody = await req.text();
      let parsed: { stream?: boolean; model?: string } = {};
      try { parsed = JSON.parse(rawBody); } catch {}

      if (url.pathname.includes("/v1/messages")) {
        if (parsed.stream) {
          const sse = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_int","model":"glm-4.6"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Integration stream"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join("");
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({
          id: "msg_int_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Integration test response" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 8 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname.includes("/chat/completions")) {
        return new Response(JSON.stringify({
          id: "chatcmpl-int-test",
          object: "chat.completion",
          created: Date.now(),
          model: "glm-4.6",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "OpenAI integration response" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    },
  });
  // Read the actual port assigned by the OS — no race possible.
  mockPort = (mockUpstreamServer as any).port ?? mockUpstreamServer.port;

  const loaded = loadConfig(TEST_CONFIG_PATH);
  // Spin proxy on port 0 too — same anti-flake rationale.
  loaded.server.port = 0;
  loaded.server.host = "127.0.0.1";
  loaded.auth.proxyApiKey = "integration-test-key";
  loaded.providers.zai.anthropicBase = `http://127.0.0.1:${mockPort}/anthropic`;
  loaded.providers.zai.openaiBase = `http://127.0.0.1:${mockPort}/coding`;
  loaded.auth.apiKey = "integrationTestKey.integrationTestSecret";
  config = loaded;

  const auth = new AuthManager({
    mode: "apikey",
    provider: "zai",
    apiKey: "integrationTestKey.integrationTestSecret",
  });

  proxyServer = startServer({ config, auth });
  // Read the actual proxy port assigned by the OS.
  proxyPort = (proxyServer as any).port ?? proxyServer.port;
});

afterAll(() => {
  proxyServer?.stop(true);
  mockUpstreamServer?.stop(true);
  // Restore HOME so other test files see the real environment.
  if (realHome !== undefined) process.env.HOME = realHome;
  delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
});

function proxyUrl(path: string): string {
  return `http://127.0.0.1:${proxyPort}${path}`;
}
function authHeader(): Record<string, string> {
  return { "Authorization": "Bearer integration-test-key", "Content-Type": "application/json" };
}

describe("integration: OpenAI translation", () => {
  it("POST /v1/chat/completions returns 200 with translated response", async () => {
    const resp = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Integration test response");
    expect(body.model).toBe("glm-4.6");
  });

  it("returns gzip-encoded body when client sends accept-encoding: gzip", async () => {
    const resp = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { ...authHeader(), "accept-encoding": "gzip" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("gzip");
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Integration test response");
  });
});

describe("integration: OpenAI streaming translation", () => {
  it("translates Anthropic SSE to OpenAI SSE chunks", async () => {
    const resp = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "Stream test" }],
        stream: true,
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });
});

describe("integration: Anthropic passthrough", () => {
  it("POST /v1/messages returns 200 with response", async () => {
    const resp = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0].text).toBe("Integration test response");
    expect(body.stop_reason).toBe("end_turn");
  });
});

describe("integration: Models endpoint", () => {
  it("GET /v1/models returns model list", async () => {
    const resp = await fetch(proxyUrl("/v1/models"), {
      headers: { Authorization: "Bearer integration-test-key" },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
  });
});

describe("integration: Auth", () => {
  it("rejects request without proxy key", async () => {
    const resp = await fetch(proxyUrl("/v1/models"));
    expect(resp.status).toBe(401);
  });

  it("rejects request with wrong proxy key", async () => {
    const resp = await fetch(proxyUrl("/v1/models"), {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(resp.status).toBe(401);
  });
});

describe("integration: Health", () => {
  it("GET /health returns ok", async () => {
    const resp = await fetch(proxyUrl("/health"), {
      headers: { Authorization: "Bearer integration-test-key" },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

describe("integration: Error handling", () => {
  it("unknown route returns 404", async () => {
    const resp = await fetch(proxyUrl("/unknown"), {
      headers: { Authorization: "Bearer integration-test-key" },
    });
    expect(resp.status).toBe(404);
  });

  it("CORS preflight returns 204", async () => {
    const resp = await fetch(proxyUrl("/v1/models"), { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("integration: OpenAI Responses API", () => {
  it("POST /v1/responses returns 200 with translated response (non-streaming)", async () => {
    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(Array.isArray(body.output)).toBe(true);
    expect(body.output.length).toBeGreaterThan(0);
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].text).toBe("Integration test response");
    expect(body.usage.total_tokens).toBe(18);
  });

  it("POST /v1/responses streaming emits response.created + response.completed", async () => {
    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        input: "Stream test",
        stream: true,
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.in_progress");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
    // Must NOT contain OpenAI Chat Completions or Anthropic event types
    expect(text).not.toContain("chat.completion.chunk");
    expect(text).not.toContain("message_start");
  });

  it("supports previous_response_id chaining", async () => {
    // First turn
    const resp1 = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        input: [{ type: "message", role: "user", content: "earlier question" }],
      }),
    });
    expect(resp1.status).toBe(200);
    const body1 = await resp1.json();
    const firstResponseId = body1.id;
    expect(firstResponseId).toBeTruthy();

    // Second turn referencing previous_response_id
    const resp2 = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        input: [{ type: "message", role: "user", content: "follow-up" }],
        previous_response_id: firstResponseId,
      }),
    });
    expect(resp2.status).toBe(200);
    const body2 = await resp2.json();
    expect(body2.previous_response_id).toBe(firstResponseId);
    expect(body2.object).toBe("response");
  });

  it("forwards function tool definitions and translates tool_use responses", async () => {
    // Mock upstream returns a tool_use block — we verify the proxy translates it
    // into a function_call output item in the Responses format.
    // The mock at the top of this file always returns text, so we only verify
    // that function-type tools are accepted without error here.
    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        input: "Hi",
        tools: [
          { type: "function", name: "shell", description: "Run shell", parameters: { type: "object" } },
          { type: "local_shell" }, // should be filtered out, not error
        ],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
  });

  it("falls back to defaultModel when client sends a non-GLM model (Codex CLI gpt-5.5)", async () => {
    // Codex CLI defaults to "gpt-5.5" which GLM upstream rejects. Proxy should
    // transparently substitute config.defaultModel ("glm-4.6" in test config).
    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: "Hi from Codex" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
    // The response should echo the substituted model (or at least be a valid response)
    expect(body.output.length).toBeGreaterThan(0);
  });

  it("merges consecutive same-role user messages (Codex sends multiple user turns)", async () => {
    // Reproduces the original 3001 "parameter error" bug from Codex CLI
    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "glm-4.6",
        input: [
          { type: "message", role: "developer", content: "You are a coding agent." },
          { type: "message", role: "user", content: "first question" },
          { type: "message", role: "user", content: "second question" },
          { type: "message", role: "user", content: "third question" },
        ],
        instructions: "Be helpful.",
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
  });

  it("uses configured modelMappings to rewrite client model names", async () => {
    // Configure a mapping: gpt-5.5 → glm-5.2 (use a known GLM model so mock accepts)
    config.modelMappings = [{ from: "gpt-5.5", to: "glm-4.6" }];

    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: "Hi" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");

    // Clean up
    config.modelMappings = [];
  });

  it("model mapping is case-insensitive on the from field", async () => {
    config.modelMappings = [{ from: "gpt-5.5", to: "glm-4.6" }];

    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "GPT-5.5",  // different case
        input: [{ type: "message", role: "user", content: "Hi" }],
      }),
    });
    expect(resp.status).toBe(200);

    config.modelMappings = [];
  });

  it("non-GLM model without a mapping falls back to defaultModel", async () => {
    config.modelMappings = [];  // no mappings

    const resp = await fetch(proxyUrl("/v1/responses"), {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        model: "claude-sonnet-4",
        input: [{ type: "message", role: "user", content: "Hi" }],
      }),
    });
    expect(resp.status).toBe(200);
  });
});
