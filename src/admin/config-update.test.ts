import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthManager } from "../auth/manager.js";
import { loadConfig } from "../config/loader.js";
import { synchronizeAccountConfig } from "./account-actions.js";
import { persistConfig, withConfigUpdate } from "./config.js";
import { handleAdminRoute } from "./router.js";
import type { AdminOptions } from "./types.js";

let dir: string;
let opts: AdminOptions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-update-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, "{}");
  const config = loadConfig(configPath);
  config.server.port = 8080;
  config.server.host = "127.0.0.1";
  config.auth = { mode: "apikey", apiKey: "local-test-key", proxyApiKey: "local-admin-key" };
  opts = { config, configPath, auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: "local-test-key" }), startTime: Date.now() };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function put(path: string, body: unknown): Promise<Response> {
  return (await handleAdminRoute(new Request("http://localhost/admin/api/" + path, {
    method: "PUT", headers: { authorization: "Bearer local-admin-key" }, body: JSON.stringify(body),
  }), opts))!;
}

describe("configuration updates", () => {
  it("retains independent fields from simultaneous partial saves", async () => {
    const responses = await Promise.all([
      put("config", { retry: { maxRetries: 7 } }),
      put("config", { logging: { level: "debug" }, promptRewrite: { enabled: false } }),
      put("endpoints", { zai: { anthropicBase: "https://new-endpoint.test/anthropic" } }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    for (const config of [opts.config, loadConfig(opts.configPath)]) {
      expect(config.retry!.maxRetries).toBe(7);
      expect(config.logging.level).toBe("debug");
      expect(config.promptRewrite!.enabled).toBe(false);
      expect(config.providers.zai.anthropicBase).toBe("https://new-endpoint.test/anthropic");
    }
  });

  it("serializes active-account plan changes with settings saves", async () => {
    opts.config.plan = "start-plan";
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const saving = withConfigUpdate(opts.config, opts.configPath, async (draft, save) => {
      draft.logging.level = "warn";
      entered();
      await gate;
      await save(draft);
      opts.config.logging = draft.logging;
    });
    await started;
    const switching = synchronizeAccountConfig(opts, { apiKey: "local-account-key", provider: "zai", plan: "coding-plan" });
    await Promise.resolve();
    expect(opts.config.plan).toBe("start-plan");
    release();
    await Promise.all([saving, switching]);
    for (const config of [opts.config, loadConfig(opts.configPath)]) {
      expect(config.plan).toBe("coding-plan");
      expect(config.logging.level).toBe("warn");
    }
  });

  it("lets other settings save while a request body is still uploading", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const slowBody = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const requestInit = {
      method: "PUT", headers: { authorization: "Bearer local-admin-key" }, body: slowBody, duplex: "half",
    };
    const slowSave = handleAdminRoute(new Request("http://localhost/admin/api/config", requestInit), opts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fastSave = await Promise.race([
        put("config", { logging: { level: "warn" } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("upload holds config save lock")), 500); }),
      ]);
      expect(fastSave.status).toBe(200);
    } finally {
      clearTimeout(timer);
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ retry: { maxRetries: 8 } })));
      controller.close();
      expect((await slowSave)!.status).toBe(200);
    }
    expect(loadConfig(opts.configPath).logging.level).toBe("warn");
    expect(loadConfig(opts.configPath).retry!.maxRetries).toBe(8);
  });

  it("keeps pending host and port through other saves, and shows the saved values on reload", async () => {
    expect((await put("config", { server: { port: 9090, host: "0.0.0.0" } })).status).toBe(200);
    const promptSave = await put("config", { promptRewrite: { enabled: false } });
    expect((await promptSave.json()).restartFields).toEqual(["server.port", "server.host"]);
    expect((await put("endpoints", { zai: { openaiBase: "https://endpoint.test/v4" } })).status).toBe(200);
    await persistConfig(opts.config, opts.configPath);
    expect(opts.config.server.port).toBe(8080);
    expect(opts.config.server.host).toBe("127.0.0.1");
    const loaded = loadConfig(opts.configPath);
    expect(loaded.server.port).toBe(9090);
    expect(loaded.server.host).toBe("0.0.0.0");
    const response = await handleAdminRoute(new Request("http://localhost/admin/api/config", {
      headers: { authorization: "Bearer local-admin-key" },
    }), opts);
    expect((await response!.json()).server).toMatchObject({ port: 9090, host: "0.0.0.0" });
    const reverted = await put("config", { server: { port: 8080, host: "127.0.0.1" } });
    expect((await reverted.json()).requiresRestart).toBe(false);
    expect(loadConfig(opts.configPath).server.port).toBe(8080);
  });

  it.each([
    ["endpoints", { zai: { anthropicBase: "https://failed.test/v1" } }],
    ["routing-rules", { rules: [{ pattern: "glm-*", provider: "bigmodel" }] }],
    ["model-mappings", { mappings: [{ from: "old-model", to: "new-model" }] }],
    ["responses-thinking", { models: ["glm-5.2"] }],
    ["config", { promptRewrite: { enabled: false } }],
  ] as const)("does not hot-apply %s when persistence fails", async (path, body) => {
    const before = structuredClone(opts.config);
    opts.configPath = dir; // Atomic rename over a directory fails on every supported platform.
    expect((await put(path, body)).status).toBe(500);
    expect(opts.config).toEqual(before);
  });

  it("recovers after a rejected save without losing a pending restart", async () => {
    await put("config", { server: { port: 9091 } });
    const before = readFileSync(opts.configPath, "utf8");
    expect((await put("config", { server: { port: 99999 } })).status).toBe(500);
    expect(readFileSync(opts.configPath, "utf8")).toBe(before);
    expect((await put("config", { logging: { level: "warn" } })).status).toBe(200);
    expect(loadConfig(opts.configPath).server.port).toBe(9091);
    expect(opts.config.logging.level).toBe("warn");
  });

  it.each([
    ["endpoints", { zai: "https://wrong-shape.test" }],
    ["endpoints", { zai: [] }],
    ["routing-rules", { rules: [null] }],
    ["model-mappings", { mappings: [null] }],
  ] as const)("rejects malformed %s entries before changing config", async (path, body) => {
    const before = structuredClone(opts.config);
    expect((await put(path, body)).status).toBe(400);
    expect(opts.config).toEqual(before);
  });
});
