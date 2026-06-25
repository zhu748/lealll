/**
 * Tests for config loader.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./loader.js";

const TMP = join(tmpdir(), `zcode-proxy-test-${Date.now()}`);

function writeYaml(content: string): string {
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, "config.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

beforeEach(() => {
  // Clean env overrides
  delete process.env.ZCODE_PROXY_PORT;
  delete process.env.ZCODE_PROXY_API_KEY;
  delete process.env.ZCODE_PROVIDER;
  delete process.env.ZCODE_API_KEY;
  delete process.env.ZCODE_APP_VERSION;
  delete process.env.ZCODE_SOURCE_TITLE;
  delete process.env.ZCODE_REFERER_ORIGIN;
  delete process.env.ZCODE_RETRY_MAX;
  delete process.env.ZCODE_RETRY_INITIAL_DELAY_MS;
  delete process.env.ZCODE_RETRY_MAX_DELAY_MS;
  delete process.env.ZCODE_RETRY_BACKOFF_FACTOR;
  delete process.env.ZCODE_RETRY_STATUSES;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a valid YAML config with all fields", () => {
    const path = writeYaml(`
server:
  port: 9090
  host: "127.0.0.1"
auth:
  mode: apikey
  apiKey: "testkey.testsecret"
  proxyApiKey: "proxy-secret"
provider: bigmodel
defaultModel: glm-4.6
models:
  - glm-4.6
  - glm-4.5
logging:
  level: debug
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(9090);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.auth.apiKey).toBe("testkey.testsecret");
    expect(cfg.auth.proxyApiKey).toBe("proxy-secret");
    expect(cfg.provider).toBe("bigmodel");
    expect(cfg.defaultModel).toBe("glm-4.6");
    expect(cfg.models).toEqual(["glm-4.6", "glm-4.5"]);
    expect(cfg.logging.level).toBe("debug");
  });

  it("applies defaults for missing optional fields", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.provider).toBe("zai");
    expect(cfg.defaultModel).toBe("glm-4.6");
    expect(cfg.logging.level).toBe("info");
    expect(cfg.providers.zai.anthropicBase).toBe("https://api.z.ai/api/anthropic");
    expect(cfg.providers.bigmodel.openaiBase).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
  });

  it("env vars override YAML values", () => {
    const path = writeYaml(`
server:
  port: 9090
auth:
  mode: apikey
  apiKey: "fromyaml"
provider: zai
`);
    process.env.ZCODE_PROXY_PORT = "3000";
    process.env.ZCODE_PROXY_API_KEY = "fromenv-proxy";
    process.env.ZCODE_API_KEY = "fromenv-key";
    process.env.ZCODE_PROVIDER = "bigmodel";

    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(3000);
    expect(cfg.auth.proxyApiKey).toBe("fromenv-proxy");
    expect(cfg.auth.apiKey).toBe("fromenv-key");
    expect(cfg.provider).toBe("bigmodel");
  });

  it("throws when port is out of range", () => {
    const path = writeYaml(`
server:
  port: 99999
auth:
  mode: apikey
  apiKey: "abc"
`);
    expect(() => loadConfig(path)).toThrow(/out of range/);
  });

  it("throws on invalid provider", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
provider: openai
`);
    expect(() => loadConfig(path)).toThrow(/Invalid provider/);
  });

  it("throws when auth.apiKey missing in apikey mode", () => {
    const path = writeYaml(`
auth:
  mode: apikey
`);
    expect(() => loadConfig(path)).toThrow(/auth\.apiKey is required/);
  });

  it("does not require apiKey in oauth mode", () => {
    const path = writeYaml(`
auth:
  mode: oauth
`);
    const cfg = loadConfig(path);
    expect(cfg.auth.mode).toBe("oauth");
    expect(cfg.auth.apiKey).toBeUndefined();
  });

  it("throws when config file not found", () => {
    expect(() => loadConfig("/nonexistent/path/config.yaml")).toThrow(/not found/);
  });

  it("auto-adds defaultModel to models list if missing", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
defaultModel: glm-5
models:
  - glm-4.6
`);
    const cfg = loadConfig(path);
    expect(cfg.models).toContain("glm-5");
    expect(cfg.models).toContain("glm-4.6");
  });

  it("identity defaults to current ZCode release when no field provided", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("3.1.5");
    expect(cfg.identity.sourceTitle).toBe("cli");
    expect(cfg.identity.refererOrigin).toBe("https://zcode.z.ai");
  });

  it("identity: YAML values override defaults", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  appVersion: "9.9.9"
  sourceTitle: "electron"
  refererOrigin: "https://example.com"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("9.9.9");
    expect(cfg.identity.sourceTitle).toBe("electron");
    expect(cfg.identity.refererOrigin).toBe("https://example.com");
  });

  it("identity: ZCODE_APP_VERSION env overrides YAML", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  appVersion: "from-yaml"
`);
    process.env.ZCODE_APP_VERSION = "from-env";
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("from-env");
  });

  it("identity: non-ASCII appVersion falls back to default", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  appVersion: "v3.1.1-中文"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("3.1.5");
  });

  it("retry: applies defaults when no retry section provided", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.maxRetries).toBe(3);
    expect(cfg.retry.initialDelayMs).toBe(1000);
    expect(cfg.retry.maxDelayMs).toBe(8000);
    expect(cfg.retry.backoffFactor).toBe(2);
    expect(cfg.retry.retryableStatuses).toEqual([529]);
  });

  it("retry: loads retry config from YAML", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  maxRetries: 5
  initialDelayMs: 2000
  maxDelayMs: 16000
  backoffFactor: 3
  retryableStatuses:
    - 529
    - 429
    - 503
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.maxRetries).toBe(5);
    expect(cfg.retry.initialDelayMs).toBe(2000);
    expect(cfg.retry.maxDelayMs).toBe(16000);
    expect(cfg.retry.backoffFactor).toBe(3);
    expect(cfg.retry.retryableStatuses).toEqual([529, 429, 503]);
  });

  it("retry: env vars override YAML values", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  maxRetries: 1
`);
    process.env.ZCODE_RETRY_MAX = "7";
    process.env.ZCODE_RETRY_STATUSES = "529,503";
    const cfg = loadConfig(path);
    expect(cfg.retry.maxRetries).toBe(7);
    expect(cfg.retry.retryableStatuses).toEqual([529, 503]);
  });

  it("retry: maxRetries=0 disables retries", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  maxRetries: 0
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.maxRetries).toBe(0);
  });

  // --- responsesThinking ---
  it("responsesThinking: defaults to empty models array when absent", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.responsesThinking).toBeDefined();
    expect(cfg.responsesThinking!.models).toEqual([]);
  });

  it("responsesThinking: loads canonical {models: [...]} shape", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
responsesThinking:
  models:
    - glm-5.2
    - glm-4.6
`);
    const cfg = loadConfig(path);
    expect(cfg.responsesThinking!.models).toEqual(["glm-5.2", "glm-4.6"]);
  });

  it("responsesThinking: accepts shorthand array form", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
responsesThinking:
  - glm-5.2
  - glm-4.6
`);
    const cfg = loadConfig(path);
    expect(cfg.responsesThinking!.models).toEqual(["glm-5.2", "glm-4.6"]);
  });

  it("responsesThinking: trims, dedupes case-insensitively, drops empty", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
responsesThinking:
  models:
    - "  glm-5.2  "
    - "GLM-5.2"
    - ""
    - "glm-4.6"
`);
    const cfg = loadConfig(path);
    expect(cfg.responsesThinking!.models).toEqual(["glm-5.2", "glm-4.6"]);
  });

  it("responsesThinking: ignores non-string entries gracefully", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
responsesThinking:
  models:
    - glm-5.2
    - 123
    - glm-4.6
`);
    const cfg = loadConfig(path);
    expect(cfg.responsesThinking!.models).toEqual(["glm-5.2", "glm-4.6"]);
  });
});
