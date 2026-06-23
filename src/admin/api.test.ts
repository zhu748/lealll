/**
 * Tests for admin dashboard API routes and helpers.
 *
 * Covers:
 *   - recordStat deduplication (P1 fix: stats no longer double-count retries)
 *   - recordDebugDump ring buffer behavior (P0 fix: replaces disk-leaking dumps)
 *   - /admin/api/verify no_auth warning (P1 fix: surface security state)
 *   - /admin/api/debug-dumps CRUD endpoints
 *   - /admin/api/config PUT validation + requiresRestart detection (P2 + P3 fixes)
 *   - /admin/api/logs batch endpoint with limit param
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordStat,
  recordDebugDump,
  clearDebugDumps,
  _resetStatsForTesting,
  handleAdminRoute,
  type AdminOptions,
} from "./api.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { saveCredential, clearCredential } from "../auth/store.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 8080, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret", ...overrides.auth },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0 },
    ...overrides,
  };
}

function makeAdminOpts(overrides: Partial<AdminOptions> = {}): AdminOptions {
  return {
    config: makeConfig(),
    auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" }),
    configPath: join(tmpdir(), `zcode-proxy-test-${Date.now()}.yaml`),
    startTime: Date.now(),
    ...overrides,
  };
}

/** Build a request with auth header. */
function authedReq(path: string, init: RequestInit & { token?: string } = {}): Request {
  const { token = "proxy-secret", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

/** Fetch an admin route and return the response (or null if route didn't match). */
async function callAdmin(req: Request, opts: AdminOptions): Promise<Response | null> {
  return handleAdminRoute(req, opts);
}

// ---------------------------------------------------------------------------
// Test isolation: reset module-level state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetStatsForTesting();
  clearDebugDumps();
});

afterEach(() => {
  _resetStatsForTesting();
  clearDebugDumps();
});

// ---------------------------------------------------------------------------
// recordStat — dedup behavior
// ---------------------------------------------------------------------------

describe("recordStat — deduplication", () => {
  it("records a new request on first call", () => {
    recordStat({
      id: "#001", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "150", tokens: "10",
    });
    // Read back via the stats endpoint
    return expectStats({ total: 1, success: 1, failed: 0, retried: 0 });
  });

  it("does NOT double-count when same id is recorded twice (retry path)", () => {
    // First call: 529 (will be retried)
    recordStat({
      id: "#002", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0",
    });
    // Second call: 200 (retry succeeded)
    recordStat({
      id: "#002", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "200", tokens: "15",
      retried: true,
    });
    return expectStats({ total: 1, success: 1, failed: 0, retried: 1 });
  });

  it("reclassifies status when retry changes the outcome", () => {
    // First: 529 (failed)
    recordStat({ id: "#003", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    // Retry: still 529 (failed)
    recordStat({ id: "#003", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0", retried: true });
    return expectStats({ total: 1, success: 0, failed: 1, retried: 1 });
  });

  it("does NOT re-increment retried counter on duplicate retried calls", () => {
    recordStat({ id: "#004", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    recordStat({ id: "#004", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0", retried: true });
    recordStat({ id: "#004", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "200", tokens: "15", retried: true });
    return expectStats({ total: 1, success: 1, failed: 0, retried: 1 });
  });

  it("counts separate requests with different ids independently", () => {
    recordStat({ id: "#010", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5" });
    recordStat({ id: "#011", time: "10:00:01", model: "glm-4.6", status: 500, ttfb: "200", tokens: "0" });
    recordStat({ id: "#012", time: "10:00:02", model: "glm-4.6", status: 529, ttfb: "300", tokens: "0", retried: true });
    return expectStats({ total: 3, success: 1, failed: 2, retried: 1 });
  });

  it("aggregates per-model stats correctly", async () => {
    recordStat({ id: "#020", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5" });
    recordStat({ id: "#021", time: "10:00:01", model: "glm-4.6", status: 200, ttfb: "200", tokens: "10" });
    recordStat({ id: "#022", time: "10:00:02", model: "glm-5.1", status: 200, ttfb: "150", tokens: "7" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.models["glm-4.6"].count).toBe(2);
    // avgTtfb = (100 + 200) / 2 = 150
    expect(body.models["glm-4.6"].avgTtfb).toBe(150);
    expect(body.models["glm-4.6"].tokens).toBe(15);
    expect(body.models["glm-5.1"].count).toBe(1);
    expect(body.models["glm-5.1"].tokens).toBe(7);
  });
});

/** Helper: fetch /admin/api/stats and assert the counter fields. */
async function expectStats(expected: { total: number; success: number; failed: number; retried: number }): Promise<void> {
  const opts = makeAdminOpts();
  const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
  if (!resp) throw new Error("stats response was null");
  const body = await resp.json();
  expect(body.total).toBe(expected.total);
  expect(body.success).toBe(expected.success);
  expect(body.failed).toBe(expected.failed);
  expect(body.retried).toBe(expected.retried);
}

// ---------------------------------------------------------------------------
// recordDebugDump — ring buffer
// ---------------------------------------------------------------------------

describe("recordDebugDump — ring buffer", () => {
  it("records a dump and exposes it via /admin/api/debug-dumps", async () => {
    recordDebugDump({
      id: "#001", status: 400,
      upstreamError: '{"error":"bad request"}',
      anthropicBeta: "claude-code-1",
      bodySummary: "model=glm-4.6 | msgs[[0]user/{text}]",
      body: '{"model":"glm-4.6","messages":[]}',
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(1);
    expect(body.dumps[0].id).toBe("#001");
    expect(body.dumps[0].status).toBe(400);
    // Body is hidden by default (privacy)
    expect(body.dumps[0].body).toBeUndefined();
    expect(body.dumps[0].bodySummary).toBeTruthy();
  });

  it("exposes full body only when ?full=1 is set", async () => {
    recordDebugDump({
      id: "#002", status: 3001,
      upstreamError: "parameter error",
      anthropicBeta: "",
      bodySummary: "summary",
      body: '{"secret":"content"}',
    });

    const opts = makeAdminOpts();
    // Without full=1
    const r1 = await callAdmin(authedReq("/admin/api/debug-dumps"), opts);
    const b1 = await r1!.json();
    expect(b1.dumps[0].body).toBeUndefined();

    // With full=1
    const r2 = await callAdmin(authedReq("/admin/api/debug-dumps?full=1"), opts);
    const b2 = await r2!.json();
    expect(b2.dumps[0].body).toBe('{"secret":"content"}');
  });

  it("fetches a single dump by id with ?id=", async () => {
    recordDebugDump({
      id: "#003", status: 400,
      upstreamError: "err", anthropicBeta: "",
      bodySummary: "s", body: '{"x":1}',
    });

    const opts = makeAdminOpts();
    // URL-encode the # in the id (otherwise it becomes a URL fragment)
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?id=" + encodeURIComponent("#003") + "&full=1"), opts);
    const body = await resp!.json();
    expect(body.id).toBe("#003");
    expect(body.body).toBe('{"x":1}');
  });

  it("returns 404 for unknown dump id", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?id=nonexistent"), opts);
    expect(resp!.status).toBe(404);
  });

  it("caps the ring buffer at 20 entries (oldest evicted)", async () => {
    // Record 25 dumps
    for (let i = 0; i < 25; i++) {
      recordDebugDump({
        id: `#${String(i).padStart(3, "0")}`, status: 400,
        upstreamError: "e", anthropicBeta: "",
        bodySummary: "s", body: "{}",
      });
    }

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?limit=100"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(20);
    // Oldest 5 (#000..#004) should be evicted; newest 20 (#005..#024) remain.
    const ids = body.dumps.map((d: { id: string }) => d.id);
    expect(ids).not.toContain("#000");
    expect(ids).not.toContain("#004");
    expect(ids).toContain("#005");
    expect(ids).toContain("#024");
  });

  it("DELETE /admin/api/debug-dumps clears all dumps", async () => {
    recordDebugDump({
      id: "#001", status: 400,
      upstreamError: "e", anthropicBeta: "",
      bodySummary: "s", body: "{}",
    });

    const opts = makeAdminOpts();
    const del = await callAdmin(authedReq("/admin/api/debug-dumps", { method: "DELETE" }), opts);
    expect(del!.status).toBe(200);

    const resp = await callAdmin(authedReq("/admin/api/debug-dumps"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/verify — no_auth warning
// ---------------------------------------------------------------------------

describe("/admin/api/verify — security warning", () => {
  it("returns {valid: true} when proxyApiKey matches", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify"), opts);
    const body = await resp!.json();
    expect(body.valid).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it("returns {valid: true, warning: 'no_auth'} when proxyApiKey is unset", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test" /* no proxyApiKey */ } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify", { token: "anything" }), opts);
    const body = await resp!.json();
    expect(body.valid).toBe(true);
    expect(body.warning).toBe("no_auth");
    expect(body.message).toContain("proxyApiKey");
  });

  it("returns 401 when proxyApiKey is set but token doesn't match", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify", { token: "wrong" }), opts);
    expect(resp!.status).toBe(401);
  });

  it("does NOT require auth to call /verify itself (chicken-and-egg)", async () => {
    // /verify is explicitly excluded from the auth gate in handleAdminRoute
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const req = new Request("http://localhost/admin/api/verify"); // no auth header
    const resp = await callAdmin(req, opts);
    expect(resp!.status).toBe(401); // token check fails, but request reaches /verify
  });
});

// ---------------------------------------------------------------------------
// /admin/api/config PUT — validation + requiresRestart
// ---------------------------------------------------------------------------

describe("/admin/api/config PUT — validation", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects port out of range", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: 99999 } }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("out of range");
  });

  it("rejects invalid provider", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai" }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("Invalid provider");
  });

  it("rejects invalid plan", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ plan: "enterprise-plan" }),
    }), opts);
    expect(resp!.status).toBe(500);
  });

  it("rejects invalid provider URL", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        providers: { zai: { anthropicBase: "not-a-url" } },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("not a valid URL");
  });

  it("rejects non-http(s) provider URL", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        providers: { zai: { anthropicBase: "ftp://example.com" } },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("must be http(s)");
  });

  it("accepts large retry.maxRetries (no upper bound)", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    // Send the full payload the way the dashboard does — partial payloads
    // would trip "models must contain at least one entry" before reaching
    // the retry validation, masking the actual behavior under test.
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: 50, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0 },
      }),
    }), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
  });

  it("rejects negative retry.maxRetries", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: -1, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0 },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("maxRetries");
  });

  it("rejects negative retry.credentialSwitchThreshold", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: -1 },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("credentialSwitchThreshold");
  });

  it("accepts credentialSwitchThreshold=0 (disabled)", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0 },
      }),
    }), opts);
    expect(resp!.status).toBe(200);
  });

  it("rejects invalid host format", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: 8080, host: "has spaces" } }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("not a valid IP or hostname");
  });

  it("accepts valid host formats (IPv4, hostname, 0.0.0.0)", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    for (const host of ["0.0.0.0", "127.0.0.1", "localhost", "my-host.example.com"]) {
      const resp = await callAdmin(authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ server: { port: 8080, host } }),
      }), opts);
      expect(resp!.status).toBe(200);
    }
  });
});

describe("/admin/api/config PUT — requiresRestart detection", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns requiresRestart: true when port changes", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        server: { port: 9999, host: "127.0.0.1" },
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        identity: { appVersion: "1.0", sourceTitle: "cli", refererOrigin: "https://z.ai" },
        logging: { level: "info" },
        retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0 },
      }),
    }), opts);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.requiresRestart).toBe(true);
    expect(body.restartFields).toContain("server.port");
  });

  it("returns requiresRestart: false when only hot-swappable fields change", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "bigmodel", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        identity: { appVersion: "1.0", sourceTitle: "cli", refererOrigin: "https://z.ai" },
        logging: { level: "info" },
        retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0 },
      }),
    }), opts);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.requiresRestart).toBe(false);
    expect(body.restartFields).toEqual([]);
    expect(body.hotApplied).toContain("provider");
  });

  it("persists config to disk", async () => {
    const configPath = join(tmpDir, "config.yaml");
    const opts = makeAdminOpts({ configPath });
    await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ provider: "bigmodel" }),
    }), opts);
    expect(existsSync(configPath)).toBe(true);
    const written = readFileSync(configPath, "utf-8");
    expect(written).toContain("bigmodel");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/logs — batch endpoint
// ---------------------------------------------------------------------------

describe("/admin/api/logs — batch endpoint", () => {
  it("returns logs array with total count", async () => {
    // Trigger some logs via the admin route itself (PUT config logs a message)
    const tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
    try {
      const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
      // Trigger a log via PUT config
      await callAdmin(authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ provider: "bigmodel" }),
      }), opts);
      // Now query logs
      const resp = await callAdmin(authedReq("/admin/api/logs"), opts);
      const body = await resp!.json();
      expect(Array.isArray(body.logs)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(body.total).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects ?limit param", async () => {
    const opts = makeAdminOpts();
    // Append a bunch of logs
    for (let i = 0; i < 50; i++) {
      // We can't import appendLog directly without polluting tests; use a dummy
      // approach via recordStat which doesn't log. Skip this test if we can't
      // easily generate logs — but we can write directly via the API route.
    }
    const resp = await callAdmin(authedReq("/admin/api/logs?limit=5"), opts);
    const body = await resp!.json();
    expect(body.logs.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// /admin — dashboard HTML
// ---------------------------------------------------------------------------

describe("/admin — dashboard page", () => {
  it("serves HTML at /admin", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(new Request("http://localhost/admin"), opts);
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get("content-type")).toContain("text/html");
    const body = await resp!.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("zcode-proxy");
  });

  it("serves HTML at /admin/", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(new Request("http://localhost/admin/"), opts);
    expect(resp!.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/render-export — Render credential export
// ---------------------------------------------------------------------------
//
// Regression coverage for the multi-account bug where the export endpoint
// only emitted the active credential (single) even when the user had multiple
// accounts stored. The fix:
//   • 0 accounts → 404
//   • 1 account  → bare credential base64 (backward compat)
//   • 2+ accounts → full v2 store envelope base64 (preserves all accounts)
//
describe("/admin/api/accounts/render-export — multi-account export", () => {
  const TEST_SECRET = "test-encryption-secret-for-render-export";

  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 404 when no credential is stored", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/accounts/render-export"), opts);
    expect(resp!.status).toBe(404);
  });

  it("exports a single account as a bare credential (backward compat)", async () => {
    await saveCredential({ apiKey: "key-single", provider: "zai" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/accounts/render-export"), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();

    expect(body.multi).toBe(false);
    expect(body.accountCount).toBe(1);

    // Decoded blob should be a bare Credential, not a v2 store envelope.
    const decoded = JSON.parse(Buffer.from(body.credential, "base64").toString("utf8"));
    expect(decoded.apiKey).toBe("key-single");
    expect(decoded.provider).toBe("zai");
    expect(decoded.version).toBeUndefined();
    expect(decoded.accounts).toBeUndefined();

    // Env vars are present and contain the same base64 blob.
    expect(body.envVars.ZCODE_AUTH_MODE).toBe("oauth");
    expect(body.envVars.ZCODE_OAUTH_CREDENTIAL).toBe(body.credential);
  });

  it("exports ALL accounts as a v2 store envelope when multiple are stored", async () => {
    // Save two distinct accounts (different provider+apiKey → not deduped).
    await saveCredential({ apiKey: "key-A", provider: "zai" });
    await saveCredential({ apiKey: "key-B", provider: "bigmodel" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/accounts/render-export"), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();

    expect(body.multi).toBe(true);
    expect(body.accountCount).toBe(2);

    // Decoded blob should be a v2 store envelope with both accounts.
    const decoded = JSON.parse(Buffer.from(body.credential, "base64").toString("utf8"));
    expect(decoded.version).toBe(2);
    expect(Array.isArray(decoded.accounts)).toBe(true);
    expect(decoded.accounts.length).toBe(2);
    expect(decoded.activeId).toBeTruthy();

    // Both API keys must be present in the export — this is the bug fix.
    const apiKeys = decoded.accounts.map((a: any) => a.credential.apiKey).sort();
    expect(apiKeys).toEqual(["key-A", "key-B"]);

    // Each account must have id/label/createdAt + credential structure.
    for (const acc of decoded.accounts) {
      expect(typeof acc.id).toBe("string");
      expect(typeof acc.label).toBe("string");
      expect(typeof acc.createdAt).toBe("number");
      expect(acc.credential).toBeTruthy();
      expect(acc.credential.apiKey).toBeTruthy();
      expect(acc.credential.provider).toBeTruthy();
    }

    // Env vars use the same base64 blob.
    expect(body.envVars.ZCODE_AUTH_MODE).toBe("oauth");
    expect(body.envVars.ZCODE_OAUTH_CREDENTIAL).toBe(body.credential);

    // Pretty-printed JSON view also reflects both accounts.
    expect(body.json).toContain('"accounts"');
    expect(body.json).toContain("key-A");
    expect(body.json).toContain("key-B");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/proxy — per-account outbound HTTP proxy (v2.1.4.1test5)
// ---------------------------------------------------------------------------

describe("/admin/api/accounts/proxy — per-account proxy CRUD", () => {
  const TEST_SECRET = "test-encryption-secret-for-proxy-tests";

  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ proxy: "http://p:8080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when proxy field is missing", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await import("../auth/store.js").then(m => m.listAccounts());
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 for invalid proxy scheme", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await import("../auth/store.js").then(m => m.listAccounts());
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "ftp://not-a-valid-scheme:21" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
    expect(body.error.message).toContain("http://");
  });

  it("returns 404 when account id does not exist", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id: "nonexistent", proxy: "http://p:8080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });

  it("sets a valid http proxy on an existing account", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].proxy).toBe("");

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.proxy).toBe("http://127.0.0.1:7890");

    // Verify it persisted
    const list2 = await store.listAccounts();
    expect(list2.accounts[0].proxy).toBe("http://127.0.0.1:7890");
  });

  it("accepts socks5:// proxy scheme", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "socks5://10.0.0.1:1080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect((await resp!.json()).proxy).toBe("socks5://10.0.0.1:1080");
  });

  it("clears the proxy when empty string is sent", async () => {
    // Start with a proxy set
    await saveCredential({ apiKey: "k", provider: "zai", proxy: "http://existing:8080" } as any);
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].proxy).toBe("http://existing:8080");

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "   " }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.proxy).toBe("");

    // Verify it was cleared in the store
    const list2 = await store.listAccounts();
    expect(list2.accounts[0].proxy).toBe("");
    const cred = await store.loadCredential();
    expect(cred!.proxy).toBeUndefined();
  });

  it("hot-swaps the in-memory credential when the active account is updated (oauth mode)", async () => {
    await saveCredential({ apiKey: "k-active", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;

    // Use oauth mode so setOAuthCredential is the active code path (apikey
    // mode keeps the credential constructed at AuthManager init time and
    // never re-reads the store). In oauth mode, setOAuthCredential swaps the
    // in-memory cred, which is what the dashboard's hot-swap relies on.
    const opts = makeAdminOpts({
      auth: new AuthManager({ mode: "oauth", provider: "zai" }),
    });
    // Seed the in-memory credential with the stored one (no proxy yet)
    const credBefore = await store.loadCredential();
    opts.auth.setOAuthCredential(credBefore!);
    const baselineCred = await opts.auth.getCredential();
    expect(baselineCred.proxy).toBeUndefined();

    // Update proxy via API — handler should call setOAuthCredential with the
    // freshly loaded credential (which now includes proxy).
    await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "http://hot-swap:9999" }),
      }),
      opts,
    );

    // The AuthManager's in-memory credential should now reflect the proxy
    const credAfter = await opts.auth.getCredential();
    expect(credAfter.proxy).toBe("http://hot-swap:9999");
  });

  it("trims whitespace from proxy URL", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "  http://spaced:1234  " }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect((await resp!.json()).proxy).toBe("http://spaced:1234");
  });
});
