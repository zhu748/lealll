/**
 * Tests for config loader.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveDefaultIdentity } from "./loader.js";

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
  delete process.env.ZCODE_RELEASE_CHANNEL;
  delete process.env.ZCODE_DEVICE_MID;
  delete process.env.ZCODE_DATA_BASE_DIR;
  delete process.env.ZCODE_AGENT;
  delete process.env.ZCODE_RETRY_MAX;
  delete process.env.ZCODE_RETRY_INITIAL_DELAY_MS;
  delete process.env.ZCODE_RETRY_MAX_DELAY_MS;
  delete process.env.ZCODE_RETRY_BACKOFF_FACTOR;
  delete process.env.ZCODE_RETRY_STATUSES;
  delete process.env.ZCODE_UPSTREAM_TIMEOUT_MS;
  delete process.env.ZCODE_PROXY_SSE_HEARTBEAT_MS;
  delete process.env.ZCODE_PROXY_MAX_REQUEST_BODY_BYTES;
  delete process.env.ZCODE_PROXY_CORS_ALLOWLIST;
  delete process.env.ZCODE_PROXY_THINKING_LEVEL;
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

  it("returns an isolated default retryableStatuses array", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const first = loadConfig(path);
    first.retry.retryableStatuses.push(599);

    const second = loadConfig(path);
    expect(second.retry.retryableStatuses).toEqual([529, 429]);
  });

  it("normalizes models to trimmed strings and isolates the returned array", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
defaultModel: glm-4.6
models:
  - " glm-5.2 "
  - 123
  - ""
`);
    const first = loadConfig(path);
    expect(first.models).toEqual(["glm-5.2", "glm-4.6"]);
    first.models.push("mutated-model");

    const second = loadConfig(path);
    expect(second.models).toEqual(["glm-5.2", "glm-4.6"]);
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

  it("throws when port has trailing junk", () => {
    const path = writeYaml(`
server:
  port: "8080abc"
auth:
  mode: apikey
  apiKey: "abc"
`);
    expect(() => loadConfig(path)).toThrow(/server\.port must be a valid number/);
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

  it("throws on invalid plan instead of silently falling back", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
plan: enterprise-plan
`);
    expect(() => loadConfig(path)).toThrow(/Invalid plan/);
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
    expect(cfg.identity.appVersion).toBe("3.9.2");
    expect(cfg.identity.sourceTitle).toBe("cli");
    expect(cfg.identity.refererOrigin).toBe("https://zcode.z.ai");
    expect(cfg.identity.releaseChannel).toBe("production");
    expect(cfg.identity.zcodeAgent).toBe("glm");
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
  releaseChannel: "test"
  deviceMid: "yaml-device-mid"
  zcodeAgent: "custom-agent"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("9.9.9");
    expect(cfg.identity.sourceTitle).toBe("electron");
    expect(cfg.identity.refererOrigin).toBe("https://example.com");
    expect(cfg.identity.releaseChannel).toBe("test");
    expect(cfg.identity.deviceMid).toBe("yaml-device-mid");
    expect(cfg.identity.zcodeAgent).toBe("custom-agent");
  });

  it("identity: ZCODE_DEVICE_MID env overrides YAML", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  deviceMid: "from-yaml"
`);
    process.env.ZCODE_DEVICE_MID = "from-env";
    const cfg = loadConfig(path);
    expect(cfg.identity.deviceMid).toBe("from-env");
  });

  it("identity: reads existing ZCode telemetry deviceMid when not configured", () => {
    const base = join(TMP, "zcode-data");
    mkdirSync(join(base, ".zcode", "v2"), { recursive: true });
    writeFileSync(join(base, ".zcode", "v2", "telemetry-state.json"), JSON.stringify({ deviceMid: "telemetry-device-mid" }), "utf-8");
    process.env.ZCODE_DATA_BASE_DIR = base;
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.deviceMid).toBe("telemetry-device-mid");
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
    expect(cfg.identity.appVersion).toBe("3.9.2");
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
    expect(cfg.retry.retryableStatuses).toEqual([529, 429]);
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

  it("retry: strictly normalizes retryableStatuses from YAML", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  retryableStatuses:
    - 529
    - "429"
    - "503abc"
    - 99
    - 600
    - 429
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.retryableStatuses).toEqual([529, 429]);
  });

  it("retry: strictly normalizes retryableStatuses from env and falls back when none are valid", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  retryableStatuses:
    - 503
`);
    process.env.ZCODE_RETRY_STATUSES = "529, 429, 503abc, 99, 600, 529";
    let cfg = loadConfig(path);
    expect(cfg.retry.retryableStatuses).toEqual([529, 429]);

    process.env.ZCODE_RETRY_STATUSES = "bad, 99, 600";
    cfg = loadConfig(path);
    expect(cfg.retry.retryableStatuses).toEqual([529, 429]);
  });

  it("retry: rejects numeric env values with trailing junk instead of prefix-parsing them", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  maxRetries: 4
  initialDelayMs: 2000
  maxDelayMs: 9000
  backoffFactor: 3
`);
    process.env.ZCODE_RETRY_MAX = "7abc";
    process.env.ZCODE_RETRY_INITIAL_DELAY_MS = "2500ms";
    process.env.ZCODE_RETRY_MAX_DELAY_MS = "12000x";
    process.env.ZCODE_RETRY_BACKOFF_FACTOR = "2x";

    const cfg = loadConfig(path);
    expect(cfg.retry.maxRetries).toBe(3);
    expect(cfg.retry.initialDelayMs).toBe(1000);
    expect(cfg.retry.maxDelayMs).toBe(8000);
    expect(cfg.retry.backoffFactor).toBe(2);
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

  it("server.sseHeartbeatMs: defaults to 15000 when not set", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.sseHeartbeatMs).toBe(15000);
  });

  it("server.sseHeartbeatMs: YAML override works", () => {
    const path = writeYaml(`
server:
  sseHeartbeatMs: 30000
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.sseHeartbeatMs).toBe(30000);
  });

  it("server.sseHeartbeatMs: env var overrides YAML", () => {
    process.env.ZCODE_PROXY_SSE_HEARTBEAT_MS = "5000";
    try {
      const path = writeYaml(`
server:
  sseHeartbeatMs: 30000
auth:
  mode: apikey
  apiKey: "abc"
`);
      const cfg = loadConfig(path);
      expect(cfg.server.sseHeartbeatMs).toBe(5000);
    } finally {
      delete process.env.ZCODE_PROXY_SSE_HEARTBEAT_MS;
    }
  });

  it("server.sseHeartbeatMs: 0 disables heartbeat", () => {
    const path = writeYaml(`
server:
  sseHeartbeatMs: 0
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.sseHeartbeatMs).toBe(0);
  });

  it("server.upstreamTimeoutMs: defaults to 0 so stream/batch handler defaults apply", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.upstreamTimeoutMs).toBe(0);
  });

  it("server.upstreamTimeoutMs: YAML override works", () => {
    const path = writeYaml(`
server:
  upstreamTimeoutMs: 900000
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.upstreamTimeoutMs).toBe(900000);
  });

  it("server.upstreamTimeoutMs: env var overrides YAML", () => {
    process.env.ZCODE_UPSTREAM_TIMEOUT_MS = "1200000";
    const path = writeYaml(`
server:
  upstreamTimeoutMs: 900000
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.upstreamTimeoutMs).toBe(1200000);
  });

  it("timer-like millisecond config values are clamped to the JS timer ceiling", () => {
    process.env.ZCODE_UPSTREAM_TIMEOUT_MS = "2147483648";
    process.env.ZCODE_PROXY_SSE_HEARTBEAT_MS = "2147483648";
    process.env.ZCODE_RETRY_INITIAL_DELAY_MS = "2147483648";
    process.env.ZCODE_RETRY_MAX_DELAY_MS = "2147483648";
    const path = writeYaml(`
server:
  maxRequestBodyBytes: 3000000000
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.upstreamTimeoutMs).toBe(2_147_483_647);
    expect(cfg.server.sseHeartbeatMs).toBe(2_147_483_647);
    expect(cfg.retry.initialDelayMs).toBe(2_147_483_647);
    expect(cfg.retry.maxDelayMs).toBe(2_147_483_647);
    expect(cfg.server.maxRequestBodyBytes).toBe(3_000_000_000);
  });

  it("server.maxRequestBodyBytes: defaults to 64MiB when not set", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.maxRequestBodyBytes).toBe(67108864);
  });

  it("server.maxRequestBodyBytes: YAML override works", () => {
    const path = writeYaml(`
server:
  maxRequestBodyBytes: 1048576
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.maxRequestBodyBytes).toBe(1048576);
  });

  it("server.maxRequestBodyBytes: env var overrides YAML", () => {
    process.env.ZCODE_PROXY_MAX_REQUEST_BODY_BYTES = "2097152";
    try {
      const path = writeYaml(`
server:
  maxRequestBodyBytes: 1048576
auth:
  mode: apikey
  apiKey: "abc"
`);
      const cfg = loadConfig(path);
      expect(cfg.server.maxRequestBodyBytes).toBe(2097152);
    } finally {
      delete process.env.ZCODE_PROXY_MAX_REQUEST_BODY_BYTES;
    }
  });

  it("server.maxRequestBodyBytes: 0 disables request body guard", () => {
    const path = writeYaml(`
server:
  maxRequestBodyBytes: 0
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.maxRequestBodyBytes).toBe(0);
  });

  it("corsAllowList: loads YAML array and trims empty entries", () => {
    const path = writeYaml(`
corsAllowList:
  - " https://dashboard.local "
  - ""
  - "https://chat.local"
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.corsAllowList).toEqual(["https://dashboard.local", "https://chat.local"]);
  });

  it("corsAllowList: env var overrides YAML array", () => {
    process.env.ZCODE_PROXY_CORS_ALLOWLIST = "https://env-one.local, https://env-two.local";
    try {
      const path = writeYaml(`
corsAllowList:
  - "https://yaml.local"
auth:
  mode: apikey
  apiKey: "abc"
`);
      const cfg = loadConfig(path);
      expect(cfg.corsAllowList).toEqual(["https://env-one.local", "https://env-two.local"]);
    } finally {
      delete process.env.ZCODE_PROXY_CORS_ALLOWLIST;
    }
  });

  it("corsAllowList: rejects non-string YAML entries", () => {
    const path = writeYaml(`
corsAllowList:
  - "https://ok.local"
  - 123
auth:
  mode: apikey
  apiKey: "abc"
`);
    expect(() => loadConfig(path)).toThrow("corsAllowList");
  });

  // v0.3.5.0: the hard 8-char minimum on proxyApiKey was REMOVED at user
  // request — any non-empty key (even 1-7 chars) must load without throwing.
  // A soft advisory is printed at serve startup instead (see index.ts).
  it("accepts short proxyApiKey values (8-char minimum removed, v0.3.5.0)", () => {
    for (const key of ["abc", "12345", "x"]) {
      const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "upstream-key"
  proxyApiKey: "${key}"
`);
      const cfg = loadConfig(path);
      expect(cfg.auth.proxyApiKey).toBe(key);
    }
  });

  // The shipped template (bundled into the binary AND packed into release
  // zips as config.yaml) must default to oauth + zai and include glm-5.3.
  // Regression guard for the v0.3.4.0 packaging gap: the example model list
  // was missing glm-5.3, so fresh installs only saw 9 models.
  it("config.example.yaml: defaults to oauth mode, provider zai, 10 models incl. glm-5.3", () => {
    const cfg = loadConfig("./config.example.yaml");
    expect(cfg.auth.mode).toBe("oauth");
    expect(cfg.provider).toBe("zai");
    expect(cfg.models).toHaveLength(10);
    expect(cfg.models).toContain("glm-5.3");
    expect(cfg.defaultModel).toBe("glm-4.6");
    // v0.3.9: template ships the three-tier thinkingLevel explicitly.
    expect(cfg.thinkingLevel).toBe("max");
  });

  it("thinkingLevel: three tiers from YAML, env override, and invalid fallback (v0.3.9)", () => {
    const low = writeYaml("auth:\n  mode: oauth\nanthropic:\n  thinkingLevel: low\n");
    expect(loadConfig(low).thinkingLevel).toBe("low");
    const high = writeYaml("auth:\n  mode: oauth\nanthropic:\n  thinkingLevel: high\n");
    expect(loadConfig(high).thinkingLevel).toBe("high");
    // Invalid YAML value → falls back to max
    const bogus = writeYaml("auth:\n  mode: oauth\nanthropic:\n  thinkingLevel: ultra\n");
    expect(loadConfig(bogus).thinkingLevel).toBe("max");
    // Env var overrides YAML
    const yamlMax = writeYaml("auth:\n  mode: oauth\nanthropic:\n  thinkingLevel: max\n");
    process.env.ZCODE_PROXY_THINKING_LEVEL = "low";
    try {
      expect(loadConfig(yamlMax).thinkingLevel).toBe("low");
    } finally {
      delete process.env.ZCODE_PROXY_THINKING_LEVEL;
    }
  });
});

describe("resolveDefaultIdentity", () => {
  it("returns the built-in default identity without a config file (v0.3.2)", () => {
    const identity = resolveDefaultIdentity();
    // Same defaults the YAML path lands on when nothing is set.
    expect(identity.appVersion).toBe("3.9.2");
    expect(identity.sourceTitle).toBe("cli");
    expect(identity.refererOrigin).toBe("https://zcode.z.ai");
    expect(identity.zcodeAgent).toBe("glm");
  });

  it("ZCODE_APP_VERSION env overrides the default appVersion", () => {
    process.env.ZCODE_APP_VERSION = "9.9.9";
    try {
      expect(resolveDefaultIdentity().appVersion).toBe("9.9.9");
    } finally {
      delete process.env.ZCODE_APP_VERSION;
    }
  });
});
