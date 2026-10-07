import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthManager } from "../auth/manager.js";
import { invalidateStoreCache } from "../auth/store.js";
import { loadConfig } from "../config/loader.js";
import { defaultPromptRewriteConfig } from "../config/prompt-rewrite.js";
import type { PromptRewriteRule } from "../config/types.js";
import { proxyRequest } from "../proxy/handler.js";
import { handleResponses } from "../proxy/responses-handler.js";
import { beginPromptObservation, clearPromptObservation, latestPromptObservation, recordPromptDispatch } from "../proxy/prompt-observation.js";
import { captureSystemPrompt } from "../proxy/prompt-rewrite.js";
import type { Format } from "../translator/types.js";
import { handleAdminRoute } from "./router.js";
import type { AdminOptions } from "./types.js";

const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
let dir: string, opts: AdminOptions, previousStoreDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prompt-admin-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, "{}");
  const config = loadConfig(configPath);
  config.plan = "coding-plan";
  config.auth = { mode: "apikey", apiKey: "test-upstream", proxyApiKey: "test-admin" };
  config.clientIdentity.mode = "off";
  config.endpointRouting.enabled = false;
  config.clientSigning.enabled = false;
  config.retry = { ...config.retry!, maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 };
  opts = { config, configPath, auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test-upstream" }), startTime: Date.now() };
  previousStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
  process.env.ZCODE_PROXY_STORE_DIR = dir;
  invalidateStoreCache();
});

afterEach(() => {
  if (previousStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = previousStoreDir;
  invalidateStoreCache();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method = "GET", body?: unknown, token = "test-admin", extraHeaders: Record<string, string> = {}, path = "/admin/api/prompt-rewrite"): Promise<Response> {
  const response = await handleAdminRoute(new Request("http://localhost" + path, {
    method, headers: { authorization: "Bearer " + token, "content-type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), opts);
  return response!;
}

function ok(): Response {
  return Response.json({ id: "msg_prompt", type: "message", role: "assistant", model: "glm-4.6", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
}

function request(system: string, format: Format = "anthropic"): Request {
  const messages = format === "anthropic" ? [{ role: "user", content: "hello" }] : [{ role: "system", content: system }, { role: "user", content: "hello" }];
  return new Request("http://localhost/v1/" + (format === "anthropic" ? "messages" : "chat/completions"), {
    method: "POST", body: JSON.stringify({ model: "glm-4.6", max_tokens: 32, messages, ...(format === "anthropic" ? { system } : {}) }),
  });
}

describe("prompt rewrite admin and real dispatch", () => {
  it("requires admin authorization for both reads and deletion, and rejects cross-origin deletion", async () => {
    expect((await api("GET", undefined, "wrong")).status).toBe(401);
    expect((await api("DELETE", undefined, "wrong")).status).toBe(401);
    expect((await api("DELETE", undefined, "test-admin", { origin: "https://other.test" })).status).toBe(403);
    const response = await api();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).latest).toBeNull();
  });

  it("hot-applies and persists custom rules, retaining them on a partial master-toggle update", async () => {
    const rules: PromptRewriteRule[] = [{ id: "custom", name: "Literal custom rule", enabled: true, action: "replace", matchMode: "text", match: "old", replacement: "new\n$& <tag>" }];
    const response = await api("PUT", { promptRewrite: { enabled: true, rules } }, "test-admin", {}, "/admin/api/config");
    expect(response.status).toBe(200);
    expect((await response.json()).hotApplied).toContain("promptRewrite");
    expect(opts.config.promptRewrite!.rules).toEqual(rules);
    expect(loadConfig(opts.configPath).promptRewrite).toEqual(opts.config.promptRewrite);
    await api("PUT", { promptRewrite: { enabled: false } }, "test-admin", {}, "/admin/api/config");
    expect(opts.config.promptRewrite).toEqual({ enabled: false, rules });
    expect(loadConfig(opts.configPath).promptRewrite).toEqual({ enabled: false, rules });
  });

  it("rejects invalid saves without changing the live config or file", async () => {
    const before = structuredClone(opts.config.promptRewrite), saved = readFileSync(opts.configPath, "utf8");
    const response = await api("PUT", { promptRewrite: { enabled: true, rules: [{ id: "bad", match: "" }] } }, "test-admin", {}, "/admin/api/config");
    expect(response.status).toBe(500);
    expect(opts.config.promptRewrite).toEqual(before);
    expect(readFileSync(opts.configPath, "utf8")).toBe(saved);
  });

  it("persists an intentionally empty rule list without restoring the defaults at restart", async () => {
    await api("PUT", { promptRewrite: { rules: [] } }, "test-admin", {}, "/admin/api/config");
    expect(loadConfig(opts.configPath).promptRewrite!.rules).toEqual([]);
  });

  for (const format of ["anthropic", "openai"] as const) {
    it(`compares the received ${format} prompt with the exact system text sent upstream`, async () => {
      let wire: Record<string, unknown> = {};
      const response = await proxyRequest(request(identity, format), format, {
        config: opts.config, auth: opts.auth, endpointRouting: null, clientSigning: null,
        fetchImpl: Object.assign(async (input: RequestInfo | URL) => { wire = await (input as Request).json(); return ok(); }, { preconnect() {} }) as typeof fetch,
      });
      expect(response.status).toBe(200);
      await response.text();
      const latest = (await (await api()).json()).latest;
      expect(latest.received.text).toBe(identity);
      expect(latest.upstream).toEqual(captureSystemPrompt(wire));
      expect(latest.upstream.text).toBe("You are ZCode model working in Claude Code.");
      expect(latest.rewrite.matches).toBe(1);
      expect(latest.rewrite.modified).toBe(true);
      expect(latest.attempts).toBe(1);
      expect(latest.sentAt).toBeGreaterThanOrEqual(latest.receivedAt);
    });
  }

  it("still records an accurate comparison when the master switch is disabled", async () => {
    opts.config.promptRewrite = { ...defaultPromptRewriteConfig(), enabled: false };
    const response = await proxyRequest(request(identity), "anthropic", {
      config: opts.config, auth: opts.auth, endpointRouting: null, clientSigning: null,
      fetchImpl: Object.assign(async () => ok(), { preconnect() {} }) as typeof fetch,
    });
    await response.text();
    expect(latestPromptObservation(opts.config)!.received.text).toBe(identity);
    expect(latestPromptObservation(opts.config)!.upstream!.text).toBe(identity);
    expect(latestPromptObservation(opts.config)!.rewrite!.enabled).toBe(false);
  });

  it("applies the same rules and comparison to Responses instructions", async () => {
    let wire: Record<string, unknown> = {};
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "glm-4.6", input: "hello", instructions: identity, store: false }),
    }), {
      config: opts.config, auth: opts.auth, endpointRouting: null, clientSigning: null,
      fetchImpl: Object.assign(async (input: RequestInfo | URL) => { wire = await (input as Request).json(); return ok(); }, { preconnect() {} }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    await response.text();
    const latest = latestPromptObservation(opts.config)!;
    expect(latest.format).toBe("responses");
    expect(latest.received.text).toBe(identity);
    expect(latest.upstream).toEqual(captureSystemPrompt(wire));
    expect(latest.upstream!.text).toBe("You are ZCode model working in Claude Code.");
    expect(latest.rewrite!.changes).toBe(1);
  });

  it("rebuilds a retry that changes plans from pristine client input, without applying custom edits twice", async () => {
    opts.config.promptRewrite = { enabled: true, rules: [{ id: "append", name: "append once", enabled: true, action: "replace", matchMode: "text", match: "old", replacement: "old new" }] };
    opts.config.retry = { ...opts.config.retry!, maxRetries: 2, credentialSwitchThreshold: 1 };
    const first = { apiKey: "start-key", jwt: "start-jwt", provider: "zai" as const, plan: "start-plan" as const };
    const second = { apiKey: "coding-key", provider: "zai" as const, plan: "coding-plan" as const };
    const auth = new AuthManager({ listAllCredentials: async () => [first, second] });
    auth.setOAuthCredential(first);
    const wires: Record<string, unknown>[] = [];
    const response = await proxyRequest(request("old"), "anthropic", {
      config: opts.config, auth, endpointRouting: null, clientSigning: null,
      fetchImpl: Object.assign(async (input: RequestInfo | URL) => {
        wires.push(await (input as Request).json());
        return wires.length === 1 ? Response.json({ error: { message: "retry", type: "overloaded_error" } }, { status: 529 }) : ok();
      }, { preconnect() {} }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(wires).toHaveLength(2);
    expect(captureSystemPrompt(wires[0]).text).toContain("You are ZCode, an interactive coding agent");
    expect(captureSystemPrompt(wires[1]).text).toBe("old new");
    const latest = latestPromptObservation(opts.config)!;
    expect(latest.received.text).toBe("old");
    expect(latest.upstream).toEqual(captureSystemPrompt(wires[1]));
    expect(latest.attempts).toBe(2);
  });

  it("keeps the latest received request paired with its own dispatch, and ignores sends after a clear", async () => {
    const received = captureSystemPrompt({ system: "old" });
    const input = { id: "first", model: "glm-4.6", format: "anthropic" as const, receivedAt: Date.now(), received };
    const first = beginPromptObservation(opts.config, input);
    const second = beginPromptObservation(opts.config, { ...input, id: "second" });
    recordPromptDispatch(opts.config, first, captureSystemPrompt({ system: "first send" }), null);
    expect(latestPromptObservation(opts.config)!.id).toBe("second");
    expect(latestPromptObservation(opts.config)!.upstream).toBeNull();
    recordPromptDispatch(opts.config, second, captureSystemPrompt({ system: "second send" }), null);
    const otherConfig = structuredClone(opts.config);
    expect(latestPromptObservation(otherConfig)).toBeNull();
    await api("DELETE");
    recordPromptDispatch(opts.config, second, received, null);
    expect(latestPromptObservation(opts.config)).toBeNull();
    clearPromptObservation(opts.config);
  });
});
