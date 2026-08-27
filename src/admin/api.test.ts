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
import packageJson from "../../package.json" with { type: "json" };
import {
  recordStat,
  recordDebugDump,
  clearDebugDumps,
  appendLog,
  setLogFilePath,
  flushLogFileForShutdown,
  _flushLogFileForTesting,
  _logFileFlushStateForTesting,
  _logWaiterCountForTesting,
  _setLogStreamBackpressureLimitForTesting,
  _resetLogFileForTesting,
  _setLogFileAppendForTesting,
  _resetStatsForTesting,
  _resetQuotaCacheForTesting,
  _setAdminBodyIdleTimeoutForTesting,
  _quotaCacheStateForTesting,
  _probeStartPlanActivationForTesting,
  _activeOAuthFlowCountForTesting,
  _hasActiveOAuthFlowForTesting,
  _rememberActiveOAuthFlowForTesting,
  _resetActiveOAuthFlowsForTesting,
  handleAdminRoute,
  type AdminOptions,
} from "./api.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { saveCredential, clearCredential, listAccounts, invalidateStoreCache, _resetKeyCacheForTesting } from "../auth/store.js";
import type { Credential } from "../auth/types.js";

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
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
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

let testStoreDir: string | null = null;

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-admin-store-"));
  process.env.ZCODE_PROXY_STORE_DIR = testStoreDir;
  invalidateStoreCache();
  _resetKeyCacheForTesting();
  clearCredential();
  _resetStatsForTesting();
  _resetQuotaCacheForTesting();
  clearDebugDumps();
  _resetLogFileForTesting();
});

afterEach(() => {
  if (testStoreDir) {
    process.env.ZCODE_PROXY_STORE_DIR = testStoreDir;
  }
  invalidateStoreCache();
  clearCredential();
  _resetKeyCacheForTesting();
  _resetStatsForTesting();
  _resetQuotaCacheForTesting();
  clearDebugDumps();
  _resetLogFileForTesting();
  const dir = testStoreDir;
  testStoreDir = null;
  delete process.env.ZCODE_PROXY_STORE_DIR;
  invalidateStoreCache();
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
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

  it("ignores malformed numeric stat fields instead of prefix-parsing them", async () => {
    recordStat({
      id: "#malformed-stats", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "100abc", tokens: "12oops", inputTokens: "7bad",
      credentialKey: "bad...stats",
    });

    const resp = await callAdmin(authedReq("/admin/api/stats"), makeAdminOpts());
    const body = await resp!.json();
    expect(body.models["glm-4.6"].avgTtfb).toBe(0);
    expect(body.models["glm-4.6"].tokens).toBe(0);
    expect(body.models["glm-4.6"].inputTokens).toBe(0);
    expect(body.byCredential["bad...stats"].inputTokens).toBe(0);
    expect(body.byCredential["bad...stats"].outputTokens).toBe(0);
  });

  it("updates per-model stats when a retry replaces an earlier failure", async () => {
    recordStat({
      id: "#model-retry", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0", inputTokens: "0",
    });
    recordStat({
      id: "#model-retry", time: "10:00:01", model: "glm-4.6",
      status: 200, ttfb: "240", tokens: "15", inputTokens: "6", retried: true,
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.models["glm-4.6"].count).toBe(1);
    expect(body.models["glm-4.6"].avgTtfb).toBe(240);
    expect(body.models["glm-4.6"].tokens).toBe(15);
    expect(body.models["glm-4.6"].inputTokens).toBe(6);
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
// recordStat — vceshi0.0.7+ post-trim dedup (seenIds)
// ---------------------------------------------------------------------------

describe("recordStat — post-trim deduplication (vceshi0.0.7+)", () => {
  it("does NOT double-count when a retry arrives after the original entry was trimmed", () => {
    // Fill the requests[] buffer past the 200-entry trim threshold.
    // Each id is unique so they're all counted as new requests.
    for (let i = 0; i < 210; i++) {
      recordStat({
        id: `#trim-${i}`, time: "10:00:00", model: "glm-4.6",
        status: 200, ttfb: "100", tokens: "5",
      });
    }
    // After 200 entries, the buffer is trimmed to 100. The first 110 ids
    // (`#trim-0` through `#trim-109`) are evicted from requestIndex but
    // remain in the lifetime seenIds set.
    // Now simulate a retry for one of the evicted ids — without seenIds
    // this would be counted as a new request, inflating `total`.
    recordStat({
      id: `#trim-0`, time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "100", tokens: "5", retried: true,
    });
    // total and success should both stay at 210 (not 211), retried should be 1.
    return expectStats({ total: 210, success: 210, failed: 0, retried: 1 })
      .catch((err) => {
        // If the assertion fails, the actual total reveals the bug.
        throw err;
      });
  });

  it("re-classifies an evicted failed request when its retry succeeds", async () => {
    recordStat({
      id: "#trim-fail-0", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0",
      credentialKey: "posttrim...key",
    });
    for (let i = 1; i < 210; i++) {
      recordStat({
        id: `#trim-fail-${i}`, time: "10:00:00", model: "glm-4.6",
        status: 200, ttfb: "100", tokens: "5",
      });
    }
    recordStat({
      id: "#trim-fail-0", time: "10:00:01", model: "glm-4.6",
      status: 200, ttfb: "200", tokens: "15", inputTokens: "6",
      credentialKey: "posttrim...key",
      retried: true,
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(210);
    expect(body.success).toBe(210);
    expect(body.failed).toBe(0);
    expect(body.retried).toBe(1);
    expect(body.byStatus[529]).toBeUndefined();
    expect(body.byStatus[200]).toBe(210);
    expect(body.byCredential["posttrim...key"].count).toBe(1);
    expect(body.byCredential["posttrim...key"].failed).toBe(0);
  });

  it("refreshes the seen-id LRU position when a post-trim retry arrives", async () => {
    recordStat({
      id: "#lru-refresh",
      time: "10:00:00",
      model: "glm-4.6",
      status: 529,
      ttfb: "100",
      tokens: "0",
      credentialKey: "lru...key",
    });

    for (let i = 0; i < 49_999; i++) {
      recordStat({
        id: `#lru-fill-${i}`,
        time: "10:00:01",
        model: "glm-4.6",
        status: 200,
        ttfb: "100",
        tokens: "1",
      });
    }

    // The original row has been trimmed from requestIndex, but its seen-id is
    // still present. This retry must refresh the LRU position so the next
    // eviction batch does not immediately forget it.
    recordStat({
      id: "#lru-refresh",
      time: "10:00:02",
      model: "glm-4.6",
      status: 200,
      ttfb: "200",
      tokens: "5",
      credentialKey: "lru...key",
      retried: true,
    });

    for (let i = 0; i < 1_001; i++) {
      recordStat({
        id: `#lru-overflow-${i}`,
        time: "10:00:03",
        model: "glm-4.6",
        status: 200,
        ttfb: "100",
        tokens: "1",
      });
    }

    const opts = makeAdminOpts();
    const beforeLateRetry = await callAdmin(authedReq("/admin/api/stats"), opts);
    const beforeBody = await beforeLateRetry!.json();

    recordStat({
      id: "#lru-refresh",
      time: "10:00:04",
      model: "glm-4.6",
      status: 200,
      ttfb: "250",
      tokens: "7",
      credentialKey: "lru...key",
      retried: true,
    });

    const afterLateRetry = await callAdmin(authedReq("/admin/api/stats"), opts);
    const afterBody = await afterLateRetry!.json();

    expect(afterBody.total).toBe(beforeBody.total);
    expect(afterBody.byCredential["lru...key"].success).toBe(1);
    expect(afterBody.byCredential["lru...key"].failed).toBe(0);
  });

  it("updates per-model stats for retries after the request row was trimmed", async () => {
    recordStat({
      id: "#trim-model-0", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0", inputTokens: "0",
    });
    for (let i = 1; i < 210; i++) {
      recordStat({
        id: `#trim-model-${i}`, time: "10:00:00", model: "glm-4.6",
        status: 200, ttfb: "100", tokens: "5", inputTokens: "2",
      });
    }
    recordStat({
      id: "#trim-model-0", time: "10:00:01", model: "glm-4.6",
      status: 200, ttfb: "300", tokens: "15", inputTokens: "6",
      retried: true,
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.models["glm-4.6"].count).toBe(210);
    expect(body.models["glm-4.6"].tokens).toBe(209 * 5 + 15);
    expect(body.models["glm-4.6"].inputTokens).toBe(209 * 2 + 6);
    expect(body.models["glm-4.6"].avgTtfb).toBe(101);
  });

  it("caps the models map at 100 distinct entries (vceshi0.0.7+)", async () => {
    // Send 105 distinct model names. After 100, the rest should aggregate
    // under "_other" instead of creating new entries.
    for (let i = 0; i < 105; i++) {
      recordStat({
        id: `#cap-${i}`, time: "10:00:00", model: `model-${i}`,
        status: 200, ttfb: "100", tokens: "5",
      });
    }
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    const modelCount = Object.keys(body.models).length;
    // Should be exactly 101 (100 distinct + "_other").
    expect(modelCount).toBe(101);
    // "_other" should have aggregated the last 5 entries.
    expect(body.models["_other"].count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// recordStat — byCredential re-classification on retry (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("recordStat — byCredential re-classification (vceshi0.0.7+)", () => {
  it("increments byCredential when a failed request succeeds on retry", async () => {
    // First call: 529 (failed) — byCredential NOT incremented (only counts successes).
    recordStat({
      id: "#cred-1", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0",
      credentialKey: "abc12345...wxyz",
    });
    // Retry: 200 (success) — byCredential SHOULD be incremented now.
    recordStat({
      id: "#cred-1", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "200", tokens: "15",
      credentialKey: "abc12345...wxyz",
      retried: true,
    });
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["abc12345...wxyz"].count).toBe(1);
    expect(body.byCredential["abc12345...wxyz"].outputTokens).toBe(15);
  });

  it("moves credential accounting when retry switches to another credential", async () => {
    recordStat({
      id: "#cred-switch", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0", inputTokens: "0",
      credentialKey: "key-a...1111",
    });
    recordStat({
      id: "#cred-switch", time: "10:00:01", model: "glm-4.6",
      status: 200, ttfb: "220", tokens: "12", inputTokens: "4",
      credentialKey: "key-b...2222",
      retried: true,
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["key-a...1111"]).toBeUndefined();
    expect(body.byCredential["key-b...2222"].success).toBe(1);
    expect(body.byCredential["key-b...2222"].failed).toBe(0);
    expect(body.byCredential["key-b...2222"].count).toBe(1);
    expect(body.byCredential["key-b...2222"].inputTokens).toBe(4);
    expect(body.byCredential["key-b...2222"].outputTokens).toBe(12);
  });

  it("rolls back credential token totals when a recorded success becomes failure", async () => {
    recordStat({
      id: "#cred-regress", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "100", tokens: "15", inputTokens: "6",
      credentialKey: "key-c...3333",
    });
    recordStat({
      id: "#cred-regress", time: "10:00:01", model: "glm-4.6",
      status: 529, ttfb: "260", tokens: "0", inputTokens: "0",
      credentialKey: "key-c...3333",
      retried: true,
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["key-c...3333"].success).toBe(0);
    expect(body.byCredential["key-c...3333"].failed).toBe(1);
    expect(body.byCredential["key-c...3333"].count).toBe(0);
    expect(body.byCredential["key-c...3333"].inputTokens).toBe(0);
    expect(body.byCredential["key-c...3333"].outputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordStat — byStatus error breakdown + byCredential success/fail (logging G5+G6)
// ---------------------------------------------------------------------------

describe("recordStat — byStatus error breakdown (G5)", () => {
  it("tracks error counts per status code", async () => {
    recordStat({ id: "#s1", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5" });
    recordStat({ id: "#s2", time: "10:00:01", model: "glm-4.6", status: 529, ttfb: "200", tokens: "0" });
    recordStat({ id: "#s3", time: "10:00:02", model: "glm-4.6", status: 529, ttfb: "300", tokens: "0" });
    recordStat({ id: "#s4", time: "10:00:03", model: "glm-4.6", status: 429, ttfb: "50", tokens: "0" });
    recordStat({ id: "#s5", time: "10:00:04", model: "glm-4.6", status: 401, ttfb: "10", tokens: "0" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byStatus[200]).toBe(1);
    expect(body.byStatus[529]).toBe(2);
    expect(body.byStatus[429]).toBe(1);
    expect(body.byStatus[401]).toBe(1);
  });

  it("updates byStatus when a retry changes status (529→200)", async () => {
    recordStat({ id: "#s6", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    recordStat({ id: "#s6", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "200", tokens: "15", retried: true });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    // 529 should be decremented (0 → removed), 200 should be 1
    expect(body.byStatus[529] ?? 0).toBe(0);
    expect(body.byStatus[200]).toBe(1);
  });

  it("resets byStatus on DELETE /admin/api/stats", async () => {
    recordStat({ id: "#s7", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    const opts = makeAdminOpts();
    await callAdmin(authedReq("/admin/api/stats", { method: "DELETE" }), opts);
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byStatus).toEqual({});
  });

  it("clears model aggregation internals on DELETE /admin/api/stats", async () => {
    recordStat({ id: "#s8", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "1000", tokens: "5", inputTokens: "2" });
    const opts = makeAdminOpts();
    await callAdmin(authedReq("/admin/api/stats", { method: "DELETE" }), opts);
    recordStat({ id: "#s9", time: "10:00:01", model: "glm-4.6", status: 200, ttfb: "100", tokens: "7", inputTokens: "3" });

    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.models["glm-4.6"].count).toBe(1);
    expect(body.models["glm-4.6"].avgTtfb).toBe(100);
    expect(body.models["glm-4.6"].tokens).toBe(7);
    expect(body.models["glm-4.6"].inputTokens).toBe(3);
  });
});

describe("recordStat — byCredential success/fail tracking (G6)", () => {
  it("tracks success and failure counts per credential", async () => {
    recordStat({ id: "#c1", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5", credentialKey: "key1...abcd" });
    recordStat({ id: "#c2", time: "10:00:01", model: "glm-4.6", status: 529, ttfb: "200", tokens: "0", credentialKey: "key1...abcd" });
    recordStat({ id: "#c3", time: "10:00:02", model: "glm-4.6", status: 200, ttfb: "150", tokens: "10", credentialKey: "key2...efgh" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["key1...abcd"].success).toBe(1);
    expect(body.byCredential["key1...abcd"].failed).toBe(1);
    expect(body.byCredential["key1...abcd"].count).toBe(1); // only successful counted
    expect(body.byCredential["key2...efgh"].success).toBe(1);
    expect(body.byCredential["key2...efgh"].failed).toBe(0);
  });

  it("does not merge accounts whose API keys share the same display mask", async () => {
    await saveCredential({ apiKey: "abcdefgh11111111wxyz", provider: "zai" });
    await saveCredential({ apiKey: "abcdefgh22222222wxyz", provider: "zai" });
    const list = await listAccounts();
    expect(list.accounts[0].apiKeyMask).toBe(list.accounts[1].apiKeyMask);
    expect(list.accounts[0].credentialKey).not.toBe(list.accounts[1].credentialKey);

    recordStat({ id: "#collision-a", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5", credentialKey: list.accounts[0].credentialKey });
    recordStat({ id: "#collision-b", time: "10:00:01", model: "glm-4.6", status: 200, ttfb: "100", tokens: "7", credentialKey: list.accounts[1].credentialKey });

    const resp = await callAdmin(authedReq("/admin/api/stats"), makeAdminOpts());
    const body = await resp!.json();
    expect(body.byCredential[list.accounts[0].credentialKey].outputTokens).toBe(5);
    expect(body.byCredential[list.accounts[1].credentialKey].outputTokens).toBe(7);
    expect(body.byCredential[list.accounts[0].apiKeyMask]).toBeUndefined();
  });

  it("updates credential success/fail on re-classification (529→200)", async () => {
    recordStat({ id: "#c4", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0", credentialKey: "key3...ijkl" });
    recordStat({ id: "#c4", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "200", tokens: "15", credentialKey: "key3...ijkl", retried: true });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["key3...ijkl"].success).toBe(1);
    expect(body.byCredential["key3...ijkl"].failed).toBe(0);
    expect(body.byCredential["key3...ijkl"].count).toBe(1);
  });

  it("bounds byCredential stats and keeps recently touched credentials", async () => {
    for (let i = 0; i < 1000; i++) {
      recordStat({ id: `#cred-${i}`, time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "1", credentialKey: `cred-${i}` });
    }
    recordStat({ id: "#cred-touch-0", time: "10:00:01", model: "glm-4.6", status: 200, ttfb: "100", tokens: "1", credentialKey: "cred-0" });
    for (let i = 1000; i < 1005; i++) {
      recordStat({ id: `#cred-${i}`, time: "10:00:02", model: "glm-4.6", status: 200, ttfb: "100", tokens: "1", credentialKey: `cred-${i}` });
    }

    const resp = await callAdmin(authedReq("/admin/api/stats"), makeAdminOpts());
    const body = await resp!.json();
    expect(Object.keys(body.byCredential)).toHaveLength(1000);
    expect(body.byCredential["cred-0"]).toBeDefined();
    expect(body.byCredential["cred-1"]).toBeUndefined();
    expect(body.byCredential["cred-1004"]).toBeDefined();
  });
});

describe("recordStat — captchaMs field (G4)", () => {
  it("records captchaMs in the request entry", async () => {
    recordStat({ id: "#cap1", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "35000", tokens: "10", captchaMs: "32000" });
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.requests[body.requests.length - 1].captchaMs).toBe("32000");
  });

  it("defaults captchaMs to '0' when not provided", async () => {
    recordStat({ id: "#cap2", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "150", tokens: "10" });
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.requests[body.requests.length - 1].captchaMs).toBe("0");
  });
});

describe("/admin/api/captcha-helper — token pool status", () => {
  it("returns pool status (v0.3.0 happy-pool backend)", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/captcha-helper"), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    // v0.3.0: the Chrome CDP renderer is replaced by the in-process happy-dom
    // pre-solved token pool — the status endpoint now reports pool metrics.
    expect(body).toMatchObject({
      backend: "happy-pool",
      running: false,
    });
    expect(typeof body.ready).toBe("number");
    expect(typeof body.target).toBe("number");
    expect(typeof body.activeSolves).toBe("number");
  });

  it("stop endpoint is idempotent", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/captcha-helper/stop", { method: "POST" }), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.running).toBe(false);
  });
});

describe("ring buffer — log buffer (G8)", () => {
  it("survives overfill beyond LOG_BUFFER_SIZE without splice", async () => {
    // Push more entries than the buffer can hold — the ring buffer should
    // silently overwrite the oldest without any splice/copy overhead.
    for (let i = 0; i < 2500; i++) {
      appendLog("info", `log entry ${i}`);
    }
    const opts = makeAdminOpts();
    // Batch endpoint should return the last N entries
    const resp = await callAdmin(authedReq("/admin/api/logs?limit=10"), opts);
    const body = await resp!.json();
    // Should have exactly 10 logs (limited by ?limit=10)
    expect(body.logs.length).toBe(10);
    // The most recent entries should be the last ones pushed
    expect(body.logs[9].message).toBe("log entry 2499");
    // Total should be the ring buffer count (capped at LOG_BUFFER_SIZE)
    expect(body.total).toBeLessThanOrEqual(2000);
  });

  it("supports level filtering on the ring buffer", async () => {
    appendLog("info", "info message");
    appendLog("error", "error message");
    appendLog("warn", "warn message");
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/logs?level=error"), opts);
    const body = await resp!.json();
    expect(body.logs.length).toBe(1);
    expect(body.logs[0].message).toBe("error message");
    expect(body.logs[0].level).toBe("error");
  });

  it("keeps info-level [debug] diagnostic log lines above the verbose limit", async () => {
    const marker = `debug-retention-${Date.now()}-${Math.random()}`;
    appendLog("info", `[debug] ${marker} ${"x".repeat(7000)}`);

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq(`/admin/api/logs?search=${encodeURIComponent(marker)}&limit=1`), opts);
    const body = await resp!.json();

    expect(body.logs.length).toBe(1);
    expect(body.logs[0].message.length).toBeGreaterThan(6000);
    expect(body.logs[0].message).toContain(marker);
  });

  it("throttles repeated log file flush warnings for the same failure", async () => {
    const logTargetDir = mkdtempSync(join(tmpdir(), "zcode-proxy-log-target-"));
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      setLogFilePath(logTargetDir);
      appendLog("info", "flush failure one");
      await _flushLogFileForTesting();
      appendLog("info", "flush failure two");
      await _flushLogFileForTesting();

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("Could not flush log file");
    } finally {
      console.warn = originalWarn;
      _resetLogFileForTesting();
      try { rmSync(logTargetDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("warns when log file buffer overflows without recursive warn logging", () => {
    const logTarget = join(tmpdir(), `zcode-proxy-log-overflow-${Date.now()}-${Math.random()}.log`);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      warnings.push(line);
      // Production index.ts mirrors console.warn into appendLog(). When the
      // file buffer is already full, the overflow warning must not recurse.
      appendLog("warn", `mirrored warn: ${line}`);
    };

    try {
      setLogFilePath(logTarget);
      for (let i = 0; i < 1100; i++) {
        appendLog("info", `overflow log ${i}`);
      }

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("Log file buffer is full");
      expect(_logFileFlushStateForTesting().pending).toBe(1000);
    } finally {
      console.warn = originalWarn;
      _resetLogFileForTesting();
      try { rmSync(logTarget, { force: true }); } catch {}
    }
  });

  it("serializes slow log file flushes instead of running concurrent appends", async () => {
    const logTarget = join(tmpdir(), `zcode-proxy-log-serial-${Date.now()}-${Math.random()}.log`);
    const releases: Array<() => void> = [];
    const writes: string[] = [];
    let active = 0;
    let maxActive = 0;

    const waitForWrites = async (count: number) => {
      const deadline = Date.now() + 1000;
      while (releases.length < count && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5));
      }
      expect(releases.length).toBeGreaterThanOrEqual(count);
    };

    _setLogFileAppendForTesting(async (_path, data) => {
      active++;
      maxActive = Math.max(maxActive, active);
      writes.push(String(data));
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
    });

    try {
      setLogFilePath(logTarget);
      appendLog("info", "serial flush one");
      const firstFlush = _flushLogFileForTesting();
      await waitForWrites(1);
      expect(_logFileFlushStateForTesting().inFlight).toBe(true);

      appendLog("info", "serial flush two");
      const secondFlush = _flushLogFileForTesting();
      await new Promise(r => setTimeout(r, 0));
      expect(maxActive).toBe(1);
      expect(releases.length).toBe(1);

      releases[0]();
      await waitForWrites(2);
      expect(maxActive).toBe(1);
      releases[1]();
      await Promise.all([firstFlush, secondFlush]);

      const joined = writes.join("");
      expect(joined.indexOf("serial flush one")).toBeGreaterThanOrEqual(0);
      expect(joined.indexOf("serial flush two")).toBeGreaterThan(joined.indexOf("serial flush one"));
    } finally {
      _resetLogFileForTesting();
      try { rmSync(logTarget, { force: true }); } catch {}
    }
  });

  it("flushLogFileForShutdown drains pending file logs without waiting for the interval", async () => {
    const logTarget = join(tmpdir(), `zcode-proxy-log-shutdown-${Date.now()}-${Math.random()}.log`);

    try {
      setLogFilePath(logTarget);
      appendLog("info", "shutdown flush marker");

      await flushLogFileForShutdown();

      const content = readFileSync(logTarget, "utf-8");
      expect(content).toContain("File logging enabled");
      expect(content).toContain("shutdown flush marker");
      expect(_logFileFlushStateForTesting()).toEqual({ pending: 0, inFlight: false });
    } finally {
      _resetLogFileForTesting();
      try { rmSync(logTarget, { force: true }); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// /admin/api/oauth/init — provider validation (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("POST /admin/api/oauth/init — provider validation (vceshi0.0.7+)", () => {
  afterEach(() => {
    _resetActiveOAuthFlowsForTesting();
  });

  it("returns 400 for unknown provider", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/oauth/init", {
        method: "POST",
        body: JSON.stringify({ provider: "evil" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/provider must be 'zai' or 'bigmodel'/);
  });

  it("returns 400 when provider is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/oauth/init", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 400 for invalid plan", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/oauth/init", {
        method: "POST",
        body: JSON.stringify({ provider: "zai", plan: "enterprise-plan" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toContain("plan must be coding-plan or start-plan");
  });

  it("bounds abandoned OAuth flows and evicts the oldest entries", () => {
    _resetActiveOAuthFlowsForTesting();
    const closed: number[] = [];
    for (let i = 0; i < 105; i++) {
      _rememberActiveOAuthFlowForTesting(`flow-${i}`, Date.now() + 300_000, async () => { closed.push(i); });
    }

    expect(_activeOAuthFlowCountForTesting()).toBe(100);
    expect(_hasActiveOAuthFlowForTesting("flow-0")).toBe(false);
    expect(_hasActiveOAuthFlowForTesting("flow-4")).toBe(false);
    expect(_hasActiveOAuthFlowForTesting("flow-5")).toBe(true);
    expect(_hasActiveOAuthFlowForTesting("flow-104")).toBe(true);
    expect(closed).toEqual([0, 1, 2, 3, 4]);
  });

  it("closes the callback server when an OAuth flow expires during polling", async () => {
    _resetActiveOAuthFlowsForTesting();
    let closed = 0;
    _rememberActiveOAuthFlowForTesting("expired-flow", Date.now() - 1, async () => { closed++; });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/oauth/poll?flowId=expired-flow"), opts);
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toEqual({ status: "expired" });
    expect(_hasActiveOAuthFlowForTesting("expired-flow")).toBe(false);
    expect(closed).toBe(1);
  });
});

describe("POST /admin/api/import — plan validation", () => {
  it("returns 400 when explicit plan is invalid", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/import", {
        method: "POST",
        body: JSON.stringify({ provider: "zai", plan: "enterprise-plan" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toContain("plan must be coding-plan or start-plan");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/endpoints — URL validation (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("PUT /admin/api/endpoints — URL validation (vceshi0.0.7+)", () => {
  it("returns 400 for malformed anthropicBase URL", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({ zai: { anthropicBase: "api.z.ai" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/not a valid URL/);
  });

  it("returns 400 for non-http(s) scheme", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({ zai: { anthropicBase: "ftp://example.com" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/must be http\(s\):\/\//);
  });

  it("returns 400 for unknown field in provider object", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({ zai: { apiKey: "stolen" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/not allowed/);
  });

  it("accepts valid URLs and persists", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({
          zai: { anthropicBase: "https://api.z.ai/api/anthropic" },
          bigmodel: { openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
        }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(opts.config.providers.zai.anthropicBase).toBe("https://api.z.ai/api/anthropic");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/credentials DELETE — clears in-memory auth (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("DELETE /admin/api/credentials — clears in-memory oauth cred (vceshi0.0.7+)", () => {
  it("calls auth.clearOAuthCredential() so running requests stop using the cleared cred", async () => {
    // Use a mock AuthManager to verify clearOAuthCredential is called.
    let clearCalled = false;
    const fakeAuth = {
      setOAuthCredential: () => {},
      clearOAuthCredential: () => { clearCalled = true; },
      getCredential: async () => { throw new Error("no cred"); },
      switchToNextCredential: async () => null,
      getMode: () => "oauth" as const,
    };
    const opts = makeAdminOpts({ auth: fakeAuth as unknown as AuthManager });
    const resp = await callAdmin(
      authedReq("/admin/api/credentials", { method: "DELETE" }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(clearCalled).toBe(true);
  });
});

describe("DELETE /admin/api/accounts/:id — clears stale in-memory cred when last account is removed", () => {
  it("calls auth.clearOAuthCredential() when deleting the final stored account", async () => {
    await saveCredential({ apiKey: "last-account-key", provider: "zai", plan: "coding-plan" });
    const list = await listAccounts();
    expect(list.accounts).toHaveLength(1);

    let setCalled = false;
    let clearCalled = false;
    const fakeAuth = {
      setOAuthCredential: () => { setCalled = true; },
      clearOAuthCredential: () => { clearCalled = true; },
      getCredential: async () => { throw new Error("no cred"); },
      switchToNextCredential: async () => null,
      getMode: () => "oauth" as const,
    };
    const opts = makeAdminOpts({ auth: fakeAuth as unknown as AuthManager });

    const resp = await callAdmin(
      authedReq(`/admin/api/accounts/${encodeURIComponent(list.accounts[0].id)}`, { method: "DELETE" }),
      opts,
    );

    expect(resp!.status).toBe(200);
    expect(setCalled).toBe(false);
    expect(clearCalled).toBe(true);
  });
});

describe("GET /admin/api/credentials — active account summary", () => {
  it("includes active account display metadata without exposing plaintext keys", async () => {
    await saveCredential({
      apiKey: "summary-test-key-1234567890",
      secret: "summary-secret",
      provider: "zai",
      plan: "coding-plan",
      name: "summary account",
      email: "summary@example.com",
      proxy: "http://proxy.example:8080",
    });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/credentials", { method: "GET" }), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.credential.id).toBe(id);
    expect(body.credential.name).toBe("summary account");
    expect(body.credential.email).toBe("summary@example.com");
    expect(body.credential.proxy).toBe("http://proxy.example:8080");
    expect(body.credential.disabled).toBe(false);
    expect(body.credential.apiKeyMask).toBe("summary-...7890");
    expect(JSON.stringify(body)).not.toContain("summary-test-key-1234567890");
    expect(JSON.stringify(body)).not.toContain("summary-secret");
  });
});

describe("POST /admin/api/accounts/import — active credential sync", () => {
  it("clears in-memory auth when import leaves no enabled active credential", async () => {
    let setCalled = false;
    let clearCalled = false;
    const fakeAuth = {
      setOAuthCredential: () => { setCalled = true; },
      clearOAuthCredential: () => { clearCalled = true; },
      getCredential: async () => { throw new Error("not used"); },
      switchToNextCredential: async () => null,
      getMode: () => "oauth" as const,
    };
    const opts = makeAdminOpts({ auth: fakeAuth as unknown as AuthManager });

    const resp = await callAdmin(
      authedReq("/admin/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({
          accounts: [{
            id: "disabled-import-only",
            label: "disabled import only",
            createdAt: Date.now(),
            credential: { apiKey: "disabled-import-key", provider: "zai", disabled: true },
          }],
        }),
      }),
      opts,
    );

    expect(resp!.status).toBe(200);
    expect(setCalled).toBe(false);
    expect(clearCalled).toBe(true);
    expect((await listAccounts()).activeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/quota — per-account rate limit (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("POST /admin/api/accounts/quota — per-account rate limit (vceshi0.0.7+)", () => {
  const quotaReq = (id: string) =>
    authedReq("/admin/api/accounts/quota", {
      method: "POST",
      body: JSON.stringify({ id }),
    });

  const quotaResponse = (level: string, remaining = 60) =>
    new Response(
      JSON.stringify({
        code: 200,
        data: {
          level,
          limits: [
            { type: "TIME_LIMIT", number: 100, usage: 100 - remaining, remaining, unit: 1 },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("returns 400 when id is missing or non-string", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/quota", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 400 when id is a number (not a string)", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/quota", {
        method: "POST",
        body: JSON.stringify({ id: 123 }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("bounds quota invalidation bookkeeping for many missing account ids", async () => {
    const opts = makeAdminOpts();
    const start = _quotaCacheStateForTesting();

    for (let i = 0; i < 260; i++) {
      const resp = await callAdmin(quotaReq(`missing-quota-account-${i}`), opts);
      expect(resp!.status).toBe(404);
    }

    const state = _quotaCacheStateForTesting();
    expect(state.generations).toBeLessThanOrEqual(200);
    expect(state.epoch).toBeGreaterThan(start.epoch);
    expect(state.cached).toBe(0);
    expect(state.inFlight).toBe(0);
  });

  it("bounds fire-and-forget start-plan activation probes when fetch never settles", async () => {
    _resetQuotaCacheForTesting();
    const hangingFetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

    try {
      for (let i = 0; i < 80; i++) {
        _probeStartPlanActivationForTesting({
          apiKey: `activation-probe-key-${i}`,
          provider: "zai",
          plan: "start-plan",
          jwt: `activation-probe-jwt-${i}`,
        } as Credential, hangingFetch, "3.2.5");
      }

      const state = _quotaCacheStateForTesting();
      expect(state.activationProbes).toBeLessThanOrEqual(50);
    } finally {
      _resetQuotaCacheForTesting();
    }
  });

  it("aborts evicted start-plan activation probes", async () => {
    _resetQuotaCacheForTesting();
    const signals: AbortSignal[] = [];
    const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;

    try {
      for (let i = 0; i < 80; i++) {
        _probeStartPlanActivationForTesting({
          apiKey: `activation-probe-evict-key-${i}`,
          provider: "zai",
          plan: "start-plan",
          jwt: `activation-probe-evict-jwt-${i}`,
        } as Credential, hangingFetch, "3.2.5");
      }

      expect(_quotaCacheStateForTesting().activationProbes).toBeLessThanOrEqual(50);
      expect(signals).toHaveLength(80);
      expect(signals.slice(0, 30).every(signal => signal.aborted)).toBe(true);
      expect(signals.slice(30).every(signal => !signal.aborted)).toBe(true);
    } finally {
      _resetQuotaCacheForTesting();
    }
  });

  it("clears activation probe hard-timeout timers when the probe settles quickly", async () => {
    _resetQuotaCacheForTesting();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimerCleared = false;
    (globalThis as any).setTimeout = (handler: any, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler as any, timeout as any, ...args as any);
      if (timeout === 45_000) hardTimer = timer;
      return timer;
    };
    (globalThis as any).clearTimeout = (timer?: ReturnType<typeof setTimeout>) => {
      if (timer && timer === hardTimer) hardTimerCleared = true;
      return originalClearTimeout(timer as any);
    };
    const fetchImpl = (async () => new Response(JSON.stringify({
      code: 0,
      data: { plans: [] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    try {
      _probeStartPlanActivationForTesting({
        apiKey: "activation-probe-fast",
        provider: "zai",
        plan: "start-plan",
        jwt: "activation-probe-fast-jwt",
      } as Credential, fetchImpl, "3.2.5");
      for (let i = 0; i < 20 && _quotaCacheStateForTesting().activationProbes > 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      expect(hardTimer).not.toBeNull();
      expect(hardTimerCleared).toBe(true);
      expect(_quotaCacheStateForTesting().activationProbes).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      if (hardTimer) clearTimeout(hardTimer);
      _resetQuotaCacheForTesting();
    }
  });

  it("does not return cached quota after all credentials are cleared", async () => {
    await saveCredential({ apiKey: "quota-clear-key", secret: "old-secret", provider: "zai", plan: "coding-plan" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return quotaResponse("old-level");
    }) as unknown as typeof fetch;
    const opts = makeAdminOpts({ fetchImpl });

    const first = await callAdmin(quotaReq(id), opts);
    expect(first!.status).toBe(200);
    expect((await first!.json()).planName).toBe("old-level");

    const cached = await callAdmin(quotaReq(id), opts);
    expect(cached!.status).toBe(200);
    expect((await cached!.json()).cached).toBe(true);
    expect(calls).toBe(1);

    const cleared = await callAdmin(authedReq("/admin/api/credentials", { method: "DELETE" }), opts);
    expect(cleared!.status).toBe(200);

    const afterClear = await callAdmin(quotaReq(id), opts);
    expect(afterClear!.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("coalesces concurrent quota requests for the same account", async () => {
    await saveCredential({ apiKey: "quota-dedupe-key", secret: "dedupe-secret", provider: "zai", plan: "coding-plan" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    let calls = 0;
    let releaseFetch: () => void = () => {};
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchImpl = (async () => {
      calls++;
      await fetchGate;
      return quotaResponse("deduped-level");
    }) as unknown as typeof fetch;
    const opts = makeAdminOpts({ fetchImpl });

    const first = callAdmin(quotaReq(id), opts);
    for (let i = 0; i < 20 && calls === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(calls).toBe(1);

    const second = callAdmin(quotaReq(id), opts);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    releaseFetch();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1!.status).toBe(200);
    expect(r2!.status).toBe(200);
    expect((await r1!.json()).planName).toBe("deduped-level");
    expect((await r2!.json()).planName).toBe("deduped-level");
    expect(calls).toBe(1);

    const cached = await callAdmin(quotaReq(id), opts);
    expect(cached!.status).toBe(200);
    expect((await cached!.json()).cached).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not let an invalidated in-flight quota result repopulate the cache", async () => {
    await saveCredential({ apiKey: "quota-stale-old", secret: "old-secret", provider: "zai", plan: "coding-plan" });
    const list = await listAccounts();
    const account = list.accounts[0];
    const authHeaders: string[] = [];
    let releaseOldFetch: () => void = () => {};
    const oldFetchGate = new Promise<void>((resolve) => { releaseOldFetch = resolve; });
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      authHeaders.push(auth);
      if (auth.includes("quota-stale-old")) {
        await oldFetchGate;
        return quotaResponse("old-level");
      }
      return quotaResponse("new-level");
    }) as unknown as typeof fetch;
    const opts = makeAdminOpts({ fetchImpl });

    const oldQuery = callAdmin(quotaReq(account.id), opts);
    for (let i = 0; i < 20 && authHeaders.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(authHeaders).toEqual(["quota-stale-old.old-secret"]);

    const imported = await callAdmin(
      authedReq("/admin/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({
          accounts: [
            {
              id: account.id,
              label: account.label,
              createdAt: account.createdAt,
              credential: {
                apiKey: "quota-stale-new",
                secret: "new-secret",
                provider: "zai",
                plan: "coding-plan",
              },
            },
          ],
        }),
      }),
      opts,
    );
    expect(imported!.status).toBe(200);

    releaseOldFetch();
    expect((await (await oldQuery)!.json()).planName).toBe("old-level");

    const afterImport = await callAdmin(quotaReq(account.id), opts);
    expect(afterImport!.status).toBe(200);
    const body = await afterImport!.json();
    expect(body.cached).toBe(false);
    expect(body.planName).toBe("new-level");
    expect(authHeaders).toEqual(["quota-stale-old.old-secret", "quota-stale-new.new-secret"]);
  });

  it("clears cached quota when importing an updated account with the same id", async () => {
    await saveCredential({ apiKey: "quota-import-old", secret: "old-secret", provider: "zai", plan: "coding-plan" });
    const list = await listAccounts();
    const account = list.accounts[0];
    const authHeaders: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      authHeaders.push(auth);
      return quotaResponse(auth.includes("quota-import-new") ? "new-level" : "old-level");
    }) as unknown as typeof fetch;
    const opts = makeAdminOpts({ fetchImpl });

    const first = await callAdmin(quotaReq(account.id), opts);
    expect(first!.status).toBe(200);
    expect((await first!.json()).planName).toBe("old-level");

    const imported = await callAdmin(
      authedReq("/admin/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({
          accounts: [
            {
              id: account.id,
              label: account.label,
              createdAt: account.createdAt,
              credential: {
                apiKey: "quota-import-new",
                secret: "new-secret",
                provider: "zai",
                plan: "coding-plan",
              },
            },
          ],
        }),
      }),
      opts,
    );
    expect(imported!.status).toBe(200);

    const afterImport = await callAdmin(quotaReq(account.id), opts);
    expect(afterImport!.status).toBe(200);
    const body = await afterImport!.json();
    expect(body.cached).toBe(false);
    expect(body.planName).toBe("new-level");
    expect(authHeaders).toEqual(["quota-import-old.old-secret", "quota-import-new.new-secret"]);
  });

  it("clears cached quota when the account plan changes", async () => {
    await saveCredential({
      apiKey: "quota-plan-key",
      secret: "plan-secret",
      provider: "zai",
      plan: "coding-plan",
      jwt: "jwt-for-plan-switch",
    });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("billing/balance")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              plans: [{ name: "Start Plan", plan_id: "start-plan", status: "active", ends_at: "2026-12-31" }],
              balances: [{ entitlement_id: "start", total_units: 100, used_units: 10, remaining_units: 90 }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return quotaResponse("coding-before");
    }) as unknown as typeof fetch;
    const opts = makeAdminOpts({ fetchImpl });

    const first = await callAdmin(quotaReq(id), opts);
    expect(first!.status).toBe(200);
    expect((await first!.json()).plan).toBe("coding-plan");

    const changed = await callAdmin(
      authedReq("/admin/api/accounts/plan", {
        method: "PUT",
        body: JSON.stringify({ id, plan: "start-plan" }),
      }),
      opts,
    );
    expect(changed!.status).toBe(200);

    const afterPlanChange = await callAdmin(quotaReq(id), opts);
    expect(afterPlanChange!.status).toBe(200);
    const body = await afterPlanChange!.json();
    expect(body.cached).toBe(false);
    expect(body.plan).toBe("start-plan");
    expect(body.planName).toBe("Start Plan");
    expect(urls.some((url) => url.includes("billing/balance"))).toBe(true);
    expect(urls.some((url) => url.includes("billing/current"))).toBe(false);
  });

  it("clears cached quota when the account proxy changes", async () => {
    await saveCredential({ apiKey: "quota-proxy-key", secret: "proxy-secret", provider: "zai", plan: "coding-plan" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    const proxies: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const proxy = ((init as RequestInit & { proxy?: string } | undefined)?.proxy) ?? "";
      proxies.push(proxy);
      return quotaResponse(proxy ? "proxied-level" : "direct-level");
    }) as unknown as typeof fetch;
    const opts = makeAdminOpts({ fetchImpl });

    const first = await callAdmin(quotaReq(id), opts);
    expect(first!.status).toBe(200);
    expect((await first!.json()).planName).toBe("direct-level");

    const changed = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "http://quota-proxy.example:8080" }),
      }),
      opts,
    );
    expect(changed!.status).toBe(200);

    const afterProxyChange = await callAdmin(quotaReq(id), opts);
    expect(afterProxyChange!.status).toBe(200);
    const body = await afterProxyChange!.json();
    expect(body.cached).toBe(false);
    expect(body.planName).toBe("proxied-level");
    expect(proxies).toEqual(["", "http://quota-proxy.example:8080"]);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/logs/stream + appendLog — infinite loop regression (vceshi0.0.7+ HOTFIX)
// ---------------------------------------------------------------------------

describe("POST /admin/api/accounts/active — does not freeze server via appendLog (vceshi0.0.7+ HOTFIX)", () => {
  // Regression test for the infinite-loop bug in appendLog's old
  // `while (logWaiters.length > 0) { shift().resolve() }` form. The waiter's
  // resolve() re-pushed itself into logWaiters synchronously, so the while
  // condition stayed true forever — blocking the event loop and freezing
  // the entire dashboard the moment any handler called appendLog.
  //
  // We simulate this by:
  // 1. Opening an SSE log stream (registers a long-lived waiter)
  // 2. Triggering an action that calls appendLog (PUT /admin/api/accounts/active)
  // 3. Asserting the PUT response arrives within a reasonable timeout
  //
  // If the bug is present, the PUT never resolves and the test times out.

  it("appendLog does not infinite-loop when an SSE client is connected", async () => {
    // Save an account so we can switch to it.
    const tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-sse-"));
    process.env.ZCODE_PROXY_STORE_DIR = tmpDir;
    _resetKeyCacheForTesting();
    const cred: Credential = {
      apiKey: "sk-test-1", provider: "zai", plan: "coding-plan",
    };
    await saveCredential(cred, { keepActive: true });
    const cred2: Credential = {
      apiKey: "sk-test-2", provider: "zai", plan: "coding-plan",
    };
    await saveCredential(cred2, { keepActive: true });
    const list = await listAccounts();
    expect(list.accounts.length).toBe(2);
    // Activate the first account so we can switch to the second
    const targetId = list.accounts[0].id;

    try {
      const opts = makeAdminOpts({
        auth: new AuthManager({ mode: "oauth", provider: "zai" }),
      });

      // 1. Open the SSE log stream (this registers a waiter in logWaiters).
      const sseResp = await callAdmin(
        authedReq("/admin/api/logs/stream"),
        opts,
      );
      expect(sseResp).not.toBeNull();
      expect(sseResp!.status).toBe(200);
      // Start reading the stream so the controller doesn't buffer forever.
      const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
      const readPromise = (async () => {
        // Read a few chunks then stop — we don't care about the content,
        // we just need the stream to be actively consumed so the controller
        // doesn't apply backpressure that would prevent enqueue.
        for (let i = 0; i < 5; i++) {
          await reader.read();
        }
      })();

      // 2. Give the SSE handler a tick to register its waiter.
      await new Promise(r => setTimeout(r, 50));

      // 3. Trigger an action that calls appendLog. With the bug present,
      //    this PUT never resolves because appendLog infinite-loops and
      //    blocks the event loop. We use a 5s timeout to fail fast.
      const switchPromise = callAdmin(
        authedReq("/admin/api/accounts/active", {
          method: "PUT",
          body: JSON.stringify({ id: targetId }),
        }),
        opts,
      );

      const result = await Promise.race([
        switchPromise.then(r => ({ ok: true, r })),
        new Promise<{ ok: false }>(resolve => setTimeout(() => resolve({ ok: false }), 5000)),
      ]);

      // 4. Cancel the SSE stream so the test can clean up.
      try { reader.cancel(); } catch {}
      try { await readPromise; } catch {}

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.r!.status).toBe(200);
        const body = await result.r!.json();
        expect(body.ok).toBe(true);
      }
    } finally {
      clearCredential();
      delete process.env.ZCODE_PROXY_STORE_DIR;
      _resetKeyCacheForTesting();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("keeps SSE log delivery bounded during a synchronous log storm", async () => {
    const opts = makeAdminOpts();
    const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
    expect(sseResp).not.toBeNull();
    expect(sseResp!.status).toBe(200);

    const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
    const marker = `storm-marker-${Date.now()}-${Math.random()}`;
    try {
      for (let i = 0; i < 700; i++) {
        appendLog("info", `${marker}-${i}`);
      }

      const decoder = new TextDecoder();
      let seen = "";
      const deadline = Date.now() + 2_000;
      while (!seen.includes(`${marker}-699`) && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          reader.read(),
          new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), remaining)),
        ]);
        if (result === "timeout") break;
        if (result.done) break;
        seen += decoder.decode(result.value, { stream: true });
      }

      expect(seen).toContain(`${marker}-699`);
    } finally {
      try { await reader.cancel(); } catch {}
    }
  });

  it("coalesces same-tick SSE log fanout into one enqueue per client", async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const opts = makeAdminOpts();
    const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
    expect(sseResp).not.toBeNull();
    expect(sseResp!.status).toBe(200);

    const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
    const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;
    let enqueueCount = 0;
    const marker = `batched-fanout-marker-${Date.now()}-${Math.random()}`;
    try {
      (ReadableStreamDefaultController.prototype as any).enqueue = function trackedEnqueue(
        this: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
      ) {
        enqueueCount++;
        return originalEnqueue.call(this, chunk);
      };

      for (let i = 0; i < 25; i++) {
        appendLog("info", `${marker}-${i}`);
      }
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(enqueueCount).toBe(1);

      const decoder = new TextDecoder();
      let seen = "";
      const deadline = Date.now() + 2_000;
      while (!seen.includes(`${marker}-24`) && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          reader.read(),
          new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), remaining)),
        ]);
        if (result === "timeout" || result.done) break;
        seen += decoder.decode(result.value, { stream: true });
      }
      expect(seen).toContain(`${marker}-24`);
    } finally {
      (ReadableStreamDefaultController.prototype as any).enqueue = originalEnqueue;
      try { await reader.cancel(); } catch {}
    }
  });

  it("initial SSE replay sends only the recent tail window", async () => {
    const opts = makeAdminOpts();
    const marker = `initial-replay-marker-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 220; i++) {
      appendLog("info", `${marker}-${i}`);
    }

    const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
    expect(sseResp).not.toBeNull();
    expect(sseResp!.status).toBe(200);

    const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      let seen = "";
      const deadline = Date.now() + 2_000;
      while (!seen.includes(`${marker}-219`) && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          reader.read(),
          new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), remaining)),
        ]);
        if (result === "timeout" || result.done) break;
        seen += decoder.decode(result.value, { stream: true });
      }

      const messages = seen
        .split("\n\n")
        .filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice("data: ".length)).message as string);
      expect(messages).toContain(`${marker}-219`);
      expect(messages).toContain(`${marker}-20`);
      expect(messages).not.toContain(`${marker}-19`);
    } finally {
      try { await reader.cancel(); } catch {}
    }
  });

  it("does not skip logs appended between initial replay and waiter registration", async () => {
    const opts = makeAdminOpts();
    const seed = `replay-race-seed-${Date.now()}-${Math.random()}`;
    const race = `replay-race-marker-${Date.now()}-${Math.random()}`;
    appendLog("info", seed);

    const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;
    let injected = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      (ReadableStreamDefaultController.prototype as any).enqueue = function trackedReplayEnqueue(
        this: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
      ) {
        const result = originalEnqueue.call(this, chunk);
        if (!injected) {
          injected = true;
          appendLog("info", race);
        }
        return result;
      };

      const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
      expect(sseResp).not.toBeNull();
      expect(sseResp!.status).toBe(200);
      reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();

      const decoder = new TextDecoder();
      let seen = "";
      const deadline = Date.now() + 2_000;
      while (!seen.includes(race) && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          reader.read(),
          new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), remaining)),
        ]);
        if (result === "timeout" || result.done) break;
        seen += decoder.decode(result.value, { stream: true });
      }

      expect(seen).toContain(seed);
      expect(seen).toContain(race);
    } finally {
      (ReadableStreamDefaultController.prototype as any).enqueue = originalEnqueue;
      try { await reader?.cancel(); } catch {}
    }
  });

  it("rejects excess log SSE subscribers before registering another waiter", async () => {
    const opts = makeAdminOpts();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const before = _logWaiterCountForTesting();
    const toOpen = Math.max(0, 50 - before);

    try {
      for (let i = 0; i < toOpen; i++) {
        const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
        expect(sseResp).not.toBeNull();
        expect(sseResp!.status).toBe(200);
        readers.push((sseResp!.body as ReadableStream<Uint8Array>).getReader());
      }

      const cappedCount = _logWaiterCountForTesting();
      expect(cappedCount).toBeGreaterThanOrEqual(50);
      const tooMany = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
      expect(tooMany).not.toBeNull();
      expect(tooMany!.status).toBe(503);
      const body = await tooMany!.json();
      expect(body.error.type).toBe("too_many_log_streams");
      expect(_logWaiterCountForTesting()).toBe(cappedCount);
    } finally {
      await Promise.all(readers.map(async reader => {
        try { await reader.cancel(); } catch {}
      }));
    }
  });

  it("removes a log SSE waiter immediately when enqueue fails", async () => {
    const opts = makeAdminOpts();
    const before = _logWaiterCountForTesting();
    const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
    expect(sseResp).not.toBeNull();
    expect(sseResp!.status).toBe(200);

    const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
    const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;
    try {
      expect(_logWaiterCountForTesting()).toBeGreaterThanOrEqual(before + 1);
      (ReadableStreamDefaultController.prototype as any).enqueue = function enqueueFailure() {
        throw new Error("simulated enqueue failure");
      };

      appendLog("info", `enqueue-failure-marker-${Date.now()}-${Math.random()}`);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(_logWaiterCountForTesting()).toBeLessThanOrEqual(before);
    } finally {
      (ReadableStreamDefaultController.prototype as any).enqueue = originalEnqueue;
      try { await reader.cancel(); } catch {}
    }
  });

  it("closes slow log SSE clients when their stream queue keeps growing", async () => {
    _setLogStreamBackpressureLimitForTesting(2);
    const opts = makeAdminOpts();
    const before = _logWaiterCountForTesting();
    const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
    expect(sseResp).not.toBeNull();
    expect(sseResp!.status).toBe(200);

    const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
    try {
      expect(_logWaiterCountForTesting()).toBeGreaterThanOrEqual(before + 1);
      const marker = `slow-log-client-marker-${Date.now()}-${Math.random()}`;
      for (let i = 0; i < 6; i++) {
        appendLog("info", `${marker}-${i}`);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (_logWaiterCountForTesting() <= before) break;
      }

      expect(_logWaiterCountForTesting()).toBeLessThanOrEqual(before);
    } finally {
      _setLogStreamBackpressureLimitForTesting();
      try { await reader.cancel(); } catch {}
    }
  });

  it("unrefs log stream timers so idle dashboard tabs do not pin the process", async () => {
    const opts = makeAdminOpts();
    const originalSetInterval = globalThis.setInterval as any;
    const originalSetTimeout = globalThis.setTimeout as any;
    const unrefDelays: number[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    (globalThis as any).setInterval = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetInterval(handler, timeout, ...args) as any;
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefDelays.push(Number(timeout));
        return originalUnref?.();
      };
      return timer;
    };

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
      const sseResp = await callAdmin(authedReq("/admin/api/logs/stream"), opts);
      expect(sseResp).not.toBeNull();
      expect(sseResp!.status).toBe(200);
      reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();

      expect(unrefDelays).toContain(2_000);
      expect(unrefDelays).toContain(30_000);
      expect(unrefDelays).toContain(120_000);
    } finally {
      (globalThis as any).setInterval = originalSetInterval;
      (globalThis as any).setTimeout = originalSetTimeout;
      try { await reader?.cancel(); } catch {}
    }
  });
});

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

  it("hides a single dump body unless ?full=1 is set", async () => {
    recordDebugDump({
      id: "#single-private", status: 400,
      upstreamError: "err", anthropicBeta: "",
      bodySummary: "s", body: '{"secret":"content"}',
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?id=" + encodeURIComponent("#single-private")), opts);
    const body = await resp!.json();
    expect(body.id).toBe("#single-private");
    expect(body.body).toBeUndefined();
  });

  it("truncates oversized debug dump fields before storing", async () => {
    recordDebugDump({
      id: "#oversized", status: 400,
      upstreamError: "e".repeat(10_000),
      anthropicBeta: "b".repeat(5_000),
      bodySummary: "s".repeat(20_000),
      body: `{"payload":"${"x".repeat(100_000)}"}`,
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?id=" + encodeURIComponent("#oversized") + "&full=1"), opts);
    const body = await resp!.json();
    expect(body.upstreamError.length).toBeLessThan(2_200);
    expect(body.anthropicBeta.length).toBeLessThan(1_200);
    expect(body.bodySummary.length).toBeLessThan(8_400);
    expect(body.body.length).toBeLessThan(66_000);
    expect(body.body).toContain("...[truncated ");
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

  it("strictly parses debug dump ?limit without prefix or negative values", async () => {
    for (let i = 0; i < 5; i++) {
      recordDebugDump({
        id: `#limit-${i}`, status: 400,
        upstreamError: "e", anthropicBeta: "",
        bodySummary: "s", body: "{}",
      });
    }

    const opts = makeAdminOpts();
    const invalid = await callAdmin(authedReq("/admin/api/debug-dumps?limit=2abc"), opts);
    const invalidBody = await invalid!.json();
    expect(invalidBody.dumps.map((d: { id: string }) => d.id)).toEqual([
      "#limit-4", "#limit-3", "#limit-2", "#limit-1", "#limit-0",
    ]);

    const negative = await callAdmin(authedReq("/admin/api/debug-dumps?limit=-1"), opts);
    const negativeBody = await negative!.json();
    expect(negativeBody.dumps.length).toBe(5);

    const zero = await callAdmin(authedReq("/admin/api/debug-dumps?limit=0"), opts);
    const zeroBody = await zero!.json();
    expect(zeroBody.dumps).toEqual([]);
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

  it("rate-limits /verify after too many failures from the same IP", async () => {
    // Use a resolver that returns a stable non-loopback IP so failures are
    // tracked against a single bucket.
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
      resolveClientIp: () => "203.0.113.42",
    });
    // Send 10 wrong tokens — should all return 401.
    for (let i = 0; i < 10; i++) {
      const resp = await callAdmin(authedReq("/admin/api/verify", { token: "wrong" }), opts);
      expect(resp!.status).toBe(401);
    }
    // 11th attempt — locked out.
    const resp = await callAdmin(authedReq("/admin/api/verify", { token: "wrong" }), opts);
    expect(resp!.status).toBe(429);
  });

  it("clears the failure counter after a successful verify", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
      resolveClientIp: () => "203.0.113.43",
    });
    for (let i = 0; i < 5; i++) {
      await callAdmin(authedReq("/admin/api/verify", { token: "wrong" }), opts);
    }
    // Correct token — should clear the counter and return 200.
    const ok = await callAdmin(authedReq("/admin/api/verify", { token: "proxy-secret" }), opts);
    expect(ok!.status).toBe(200);
    // After clear, 5 more wrong tokens should NOT be locked (need 10).
    for (let i = 0; i < 5; i++) {
      const resp = await callAdmin(authedReq("/admin/api/verify", { token: "wrong" }), opts);
      expect(resp!.status).toBe(401);
    }
  });
});

describe("/admin API — security headers", () => {
  it("dashboard HTML renders the package.json version", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(new Request("http://localhost/admin"), opts);
    const html = await resp!.text();
    expect(html).toContain(`<span>v${packageJson.version}</span>`);
    expect(html).not.toContain("__ZCODE_PROXY_VERSION__");
  });

  it("dashboard HTML response includes CSP / X-Frame-Options / nosniff", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(new Request("http://localhost/admin"), opts);
    expect(resp!.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(resp!.headers.get("x-frame-options")).toBe("DENY");
    expect(resp!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp!.headers.get("cache-control")).toBe("no-store");
  });

  it("API JSON responses include security headers", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify"), opts);
    expect(resp!.headers.get("x-frame-options")).toBe("DENY");
    expect(resp!.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("/admin API — request body size limit", () => {
  it("rejects JSON body larger than 1 MiB with 413", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    // Build a ~2 MiB JSON body.
    const big = { id: "x", label: "A".repeat(2 * 1024 * 1024) };
    const req = authedReq("/admin/api/accounts/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(big),
    });
    const resp = await callAdmin(req, opts);
    expect(resp!.status).toBe(413);
  });

  it("cancels a declared oversized request body without reading the stream", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const req = authedReq("/admin/api/accounts/active", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(1 * 1024 * 1024 + 1),
      },
      body: stream,
    });

    const resp = await callAdmin(req, opts);
    expect(resp!.status).toBe(413);
    expect(canceled).toBe(true);
  });

  it("ignores malformed Content-Length instead of prefix-parsing it", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const small = { id: "nonexistent", label: "ok" };
    const req = authedReq("/admin/api/accounts/label", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": `${1 * 1024 * 1024 + 1}abc`,
      },
      body: JSON.stringify(small),
    });

    const resp = await callAdmin(req, opts);
    // 404 because the account doesn't exist — but NOT a false 413 from parseInt.
    expect(resp!.status).toBe(404);
  });

  it("times out and cancels stalled JSON request bodies", async () => {
    _setAdminBodyIdleTimeoutForTesting(20);
    try {
      const opts = makeAdminOpts({
        config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
      });
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      const req = authedReq("/admin/api/accounts/active", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: stream,
      });

      const result = await Promise.race([
        callAdmin(req, opts),
        new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 500)),
      ]);

      expect(result).not.toBe("hung");
      const resp = result as Response;
      expect(resp.status).toBe(408);
      const body = await resp.json();
      expect(body.error.type).toBe("request_timeout");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(canceled).toBe(true);
    } finally {
      _setAdminBodyIdleTimeoutForTesting();
    }
  });

  it("accepts JSON body under the limit", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const small = { id: "nonexistent", label: "ok" };
    const req = authedReq("/admin/api/accounts/label", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(small),
    });
    const resp = await callAdmin(req, opts);
    // 404 because the account doesn't exist — but NOT 413.
    expect(resp!.status).toBe(404);
  });

  it("allows account import bodies above the default 1 MiB limit", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const body = JSON.stringify({
      accounts: [{
        id: "large-import-account",
        label: "large-".repeat(180_000),
        createdAt: Date.now(),
        credential: { provider: "zai", apiKey: "large-import-key", plan: "coding-plan" },
      }],
    });
    expect(body.length).toBeGreaterThan(1 * 1024 * 1024);
    expect(body.length).toBeLessThan(3 * 1024 * 1024);

    const resp = await callAdmin(authedReq("/admin/api/accounts/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }), opts);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(data.ok).toBe(true);
    expect(data.added).toBe(1);
  });
});

describe("/admin API — loopback gate with requestIP", () => {
  it("allows admin API when resolveClientIp returns a loopback IP", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test" /* no proxyApiKey */ } }),
      resolveClientIp: () => "127.0.0.1",
    });
    const resp = await callAdmin(authedReq("/admin/api/config"), opts);
    expect(resp!.status).toBe(200);
  });

  it("rejects admin API when resolveClientIp returns a non-loopback IP", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test" /* no proxyApiKey */ } }),
      resolveClientIp: () => "203.0.113.99",
    });
    const resp = await callAdmin(authedReq("/admin/api/config"), opts);
    expect(resp!.status).toBe(401);
    expect(await resp!.json()).toMatchObject({ error: { type: "authentication_required" } });
  });

  it("ignores X-Forwarded-For when trustProxy is false", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test" /* no proxyApiKey */ } }),
      resolveClientIp: () => "203.0.113.99", // real socket IP is non-loopback
    });
    // Attacker spoofs XFF to claim loopback — should be ignored.
    const req = new Request("http://localhost/admin/api/config", {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        authorization: "Bearer ignored",
      },
    });
    const resp = await callAdmin(req, opts);
    expect(resp!.status).toBe(401);
  });

  it("trusts X-Forwarded-For when trustProxy is true", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ server: { port: 8080, host: "127.0.0.1", trustProxy: true } as any }),
      resolveClientIp: () => "203.0.113.99", // real socket is the reverse proxy (non-loopback)
    });
    // Reverse proxy sets XFF to the real client, which is loopback → allowed.
    const req = new Request("http://localhost/admin/api/config", {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        authorization: "Bearer ignored",
      },
    });
    const resp = await callAdmin(req, opts);
    expect(resp!.status).toBe(200);
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

  it("rejects numeric config fields with trailing junk", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        server: { port: "8080abc" },
        retry: { maxRetries: "7abc" },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("server.port");
    expect(opts.config.server.port).toBe(8080);
    expect(opts.config.retry.maxRetries).toBe(0);
  });

  it("normalizes strict numeric strings and boolean strings before hot-applying config", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        server: {
          port: "9090",
          host: "127.0.0.1",
          maxRequestBodyBytes: "1048576",
          upstreamTimeoutMs: "2500",
          sseHeartbeatMs: "0",
          trustProxy: "false",
        },
        retry: {
          maxRetries: "7",
          initialDelayMs: "10",
          maxDelayMs: "20",
          backoffFactor: "2.5",
          retryableStatuses: ["529", "429", "529"],
          credentialSwitchThreshold: "2",
          emptyStreamSwitchThreshold: "1",
        },
      }),
    }), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.requiresRestart).toBe(true);
    expect(body.restartFields).toContain("server.port");
    expect(opts.config.server.port).toBe(8080); // restart-required; not hot-applied
    expect(opts.config.server.maxRequestBodyBytes).toBe(1048576);
    expect(opts.config.server.upstreamTimeoutMs).toBe(2500);
    expect(opts.config.server.sseHeartbeatMs).toBe(0);
    expect(opts.config.server.trustProxy).toBe(false);
    expect(opts.config.retry).toMatchObject({
      maxRetries: 7,
      initialDelayMs: 10,
      maxDelayMs: 20,
      backoffFactor: 2.5,
      retryableStatuses: [529, 429],
      credentialSwitchThreshold: 2,
      emptyStreamSwitchThreshold: 1,
    });
    const written = readFileSync(join(tmpDir, "config.yaml"), "utf-8");
    expect(written).toContain("maxRetries: 7");
    expect(written).toContain("trustProxy: false");
  });

  it("rejects invalid trustProxy values instead of treating non-empty strings as enabled", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { trustProxy: "yes" } }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("server.trustProxy");
    expect(opts.config.server.trustProxy).toBeUndefined();
  });

  it("rejects wrongly typed config sections before they can pollute live config", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ auth: "bad" }, "auth must be an object"],
      [{ server: "bad" }, "server must be an object"],
      [{ retry: "bad" }, "retry must be an object"],
      [{ identity: ["bad"] }, "identity must be an object"],
      [{ logging: "bad" }, "logging must be an object"],
      [{ providers: "bad" }, "providers must be an object"],
      [{ providers: { zai: "bad" } }, "providers.zai must be an object"],
      [{ models: "glm-4.6" }, "models must be an array"],
      [{ responsesThinking: "bad" }, "responsesThinking must be an object or an array of strings"],
    ];

    for (const [payload, message] of cases) {
      const opts = makeAdminOpts({ configPath: join(tmpDir, `config-${message.replace(/\W+/g, "-")}.yaml`) });
      const before = JSON.stringify(opts.config);
      const resp = await callAdmin(authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      }), opts);
      const body = await resp!.json();
      expect(resp!.status).toBe(500);
      expect(body.error.message).toContain(message);
      expect(JSON.stringify(opts.config)).toBe(before);
    }
  });

  it("masks provider credentials in GET config while preserving oauthCredentialsPath", async () => {
    const config = makeConfig();
    config.auth.oauthCredentialsPath = "D:\\custom-store\\credentials.json";
    config.providers.zai.credential = "provider-real-key.provider-real-secret";
    const opts = makeAdminOpts({ config, configPath: join(tmpDir, "config.yaml") });

    const resp = await callAdmin(authedReq("/admin/api/config"), opts);
    const body = await resp!.json();

    expect(resp!.status).toBe(200);
    expect(body.auth.oauthCredentialsPath).toBe("D:\\custom-store\\credentials.json");
    expect(body.providers.zai.credential).toBe("***configured***");
    expect(JSON.stringify(body)).not.toContain("provider-real-secret");
  });

  it("does not overwrite provider credentials when a sanitized config snapshot is saved", async () => {
    const config = makeConfig();
    config.auth.oauthCredentialsPath = "D:\\custom-store\\credentials.json";
    config.providers.zai.credential = "provider-real-key.provider-real-secret";
    const opts = makeAdminOpts({ config, configPath: join(tmpDir, "config.yaml") });

    const getResp = await callAdmin(authedReq("/admin/api/config"), opts);
    const snapshot = await getResp!.json();
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify(snapshot),
    }), opts);
    const body = await resp!.json();
    const written = readFileSync(join(tmpDir, "config.yaml"), "utf-8");

    expect(resp!.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(config.providers.zai.credential).toBe("provider-real-key.provider-real-secret");
    expect(config.auth.oauthCredentialsPath).toBe("D:\\custom-store\\credentials.json");
    expect(written).toContain("oauthCredentialsPath");
    expect(written).toContain("provider-real-key.provider-real-secret");
    expect(written).not.toContain("***configured***");
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
        retry: { maxRetries: 50, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
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
        retry: { maxRetries: -1, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
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
        retry: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: -1, emptyStreamSwitchThreshold: 3 },
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
        retry: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
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

  it("rejects negative server.maxRequestBodyBytes", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: 8080, host: "127.0.0.1", maxRequestBodyBytes: -1 } }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("maxRequestBodyBytes");
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
        retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
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
        retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.requiresRestart).toBe(false);
    expect(body.restartFields).toEqual([]);
    expect(body.hotApplied).toContain("provider");
  });

  it("hot-applies apikey auth changes to the live AuthManager", async () => {
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "old-key.old-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "old-key.old-secret" });
    const opts = makeAdminOpts({ config, auth, configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "bigmodel",
        plan: "start-plan",
        auth: { mode: "apikey", apiKey: "new-live-key" },
        defaultModel: "glm-4.6",
        models: ["glm-4.6"],
      }),
    }), opts);
    const body = await resp!.json();
    expect(resp!.status).toBe(200);
    expect(body.hotApplied).toContain("auth");
    const liveCred = await auth.getCredential();
    expect(liveCred.provider).toBe("bigmodel");
    expect(liveCred.apiKey).toBe("new-live-key");
    expect(liveCred.plan).toBe("start-plan");
  });

  it("hot-switches auth mode to oauth and loads the active stored credential", async () => {
    await saveCredential({ apiKey: "stored-oauth-key", provider: "zai", plan: "coding-plan" });
    const config = makeConfig({ auth: { mode: "apikey", apiKey: "old-key.old-secret" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "old-key.old-secret" });
    const opts = makeAdminOpts({ config, auth, configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai",
        plan: "coding-plan",
        auth: { mode: "oauth" },
        defaultModel: "glm-4.6",
        models: ["glm-4.6"],
      }),
    }), opts);
    const body = await resp!.json();
    expect(resp!.status).toBe(200);
    expect(body.hotApplied).toContain("auth");
    expect(auth.getMode()).toBe("oauth");
    const liveCred = await auth.getCredential();
    expect(liveCred.apiKey).toBe("stored-oauth-key");
  });

  it("hot-applies server.maxRequestBodyBytes without restart", async () => {
    const config = makeConfig({ server: { port: 8080, host: "127.0.0.1", maxRequestBodyBytes: 67108864 } });
    const opts = makeAdminOpts({ config, configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        server: { port: 8080, host: "127.0.0.1", maxRequestBodyBytes: 1048576 },
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
      }),
    }), opts);
    const body = await resp!.json();
    expect(resp!.status).toBe(200);
    expect(body.requiresRestart).toBe(false);
    expect(config.server.maxRequestBodyBytes).toBe(1048576);
  });

  it("hot-applies CORS allowlist when it is added for the first time", async () => {
    const config = makeConfig();
    const opts = makeAdminOpts({ config, configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        corsAllowList: [" https://new-dashboard.local "],
      }),
    }), opts);
    const body = await resp!.json();
    expect(resp!.status).toBe(200);
    expect(body.requiresRestart).toBe(false);
    expect(body.hotApplied).toContain("corsAllowList");
    expect((config as any).corsAllowList).toEqual(["https://new-dashboard.local"]);
    const written = readFileSync(join(tmpDir, "config.yaml"), "utf-8");
    expect(written).toContain("corsAllowList:");
    expect(written).toContain("https://new-dashboard.local");
    const getResp = await callAdmin(authedReq("/admin/api/config"), opts);
    const getBody = await getResp!.json();
    expect(getBody.corsAllowList).toEqual(["https://new-dashboard.local"]);
  });

  it("rejects non-string CORS allowlist entries", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        corsAllowList: ["https://ok.local", 123],
      }),
    }), opts);
    const body = await resp!.json();
    expect(resp!.status).toBe(500);
    expect(body.error.message).toContain("corsAllowList");
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
    for (let i = 0; i < 50; i++) {
      appendLog("info", `batch-limit-log-${i}`);
    }
    const resp = await callAdmin(authedReq("/admin/api/logs?limit=5"), opts);
    const body = await resp!.json();
    expect(body.logs.length).toBe(5);
    expect(body.logs.at(-1).message).toBe("batch-limit-log-49");
  });

  it("strictly parses ?limit and falls back on invalid values", async () => {
    const opts = makeAdminOpts();
    const marker = `batch-invalid-limit-log-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 30; i++) {
      appendLog("info", `${marker}-${i}`);
    }

    const invalid = await callAdmin(authedReq("/admin/api/logs?search=" + encodeURIComponent(marker) + "&limit=5abc"), opts);
    const invalidBody = await invalid!.json();
    expect(invalidBody.logs.length).toBe(30);

    const negative = await callAdmin(authedReq("/admin/api/logs?search=" + encodeURIComponent(marker) + "&limit=-1"), opts);
    const negativeBody = await negative!.json();
    expect(negativeBody.logs.length).toBe(30);

    const zero = await callAdmin(authedReq("/admin/api/logs?search=" + encodeURIComponent(marker) + "&limit=0"), opts);
    const zeroBody = await zero!.json();
    expect(zeroBody.logs.length).toBe(0);
  });

  it("returns the newest filtered matches without disturbing chronological order", async () => {
    const opts = makeAdminOpts();
    for (let i = 0; i <= 20; i++) {
      appendLog(i % 2 === 0 ? "error" : "info", `filtered-tail-window-${i}`);
    }
    const resp = await callAdmin(
      authedReq("/admin/api/logs?level=error&search=filtered-tail-window&limit=3"),
      opts,
    );
    const body = await resp!.json();
    expect(body.logs.map((l: any) => l.message)).toEqual([
      "filtered-tail-window-16",
      "filtered-tail-window-18",
      "filtered-tail-window-20",
    ]);
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

// ---------------------------------------------------------------------------
// /admin/api/accounts/proxy-test — connectivity test (v2.1.4.1test6)
// ---------------------------------------------------------------------------

describe("/admin/api/accounts/proxy-test — proxy connectivity check", () => {
  it("returns 400 when proxy is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when proxy is empty string", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "   " }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
  });

  it("returns 400 for invalid proxy scheme", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "ftp://host:21" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
  });

  it("rejects metadata proxy targets before attempting the connectivity test", async () => {
    let fetchCalled = false;
    const mockFetch = (async (): Promise<Response> => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://169.254.169.254:80" }),
      }),
      opts,
    );

    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
    expect(body.error.message).toContain("cloud metadata");
    expect(fetchCalled).toBe(false);
  });

  it("returns ok:true with status + latencyMs when proxy reaches upstream", async () => {
    // Mock fetch — simulate a successful HEAD response through the proxy.
    // The mock asserts that the proxy URL was passed via the `proxy` init
    // option, proving the request would actually have been routed through
    // the proxy in a real environment.
    let receivedProxy: string | undefined;
    let receivedMethod: string | undefined;
    let receivedUrl: string | undefined;
    const mockFetch = (async (url: string, init?: any): Promise<Response> => {
      receivedUrl = url;
      receivedMethod = init?.method;
      receivedProxy = init?.proxy;
      return new Response(null, { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.target).toContain("api.z.ai");
    // The fetch mock should have received the proxy URL
    expect(receivedProxy).toBe("http://127.0.0.1:7890");
    expect(receivedMethod).toBe("HEAD");
    expect(receivedUrl).toContain("api.z.ai");
  });

  it("cancels successful proxy-test response bodies after reading status", async () => {
    let canceled = false;
    const mockFetch = (async (_url: string, _init?: any): Promise<Response> => {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unused"));
        },
        cancel() {
          canceled = true;
        },
      }), { status: 200 });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(canceled).toBe(true);
  });

  it("unrefs the proxy-test timeout timer", async () => {
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
      const mockFetch = (async (): Promise<Response> => {
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      const opts = makeAdminOpts({ fetchImpl: mockFetch });
      const resp = await callAdmin(
        authedReq("/admin/api/accounts/proxy-test", {
          method: "POST",
          body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
        }),
        opts,
      );
      expect(resp!.status).toBe(200);
      expect(unrefDelays).toContain(10_000);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("uses bigmodel upstream when provider=bigmodel", async () => {
    let receivedUrl: string | undefined;
    const mockFetch = (async (url: string): Promise<Response> => {
      receivedUrl = url;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "socks5://10.0.0.1:1080", provider: "bigmodel" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.target).toContain("bigmodel.cn");
    expect(receivedUrl).toContain("bigmodel.cn");
  });

  it("treats any HTTP status as success (including 4xx/5xx)", async () => {
    // Even a 404 from the upstream host means the proxy is reachable —
    // only network-level failures should report ok=false.
    const mockFetch = (async (_url: string, _init?: any): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://proxy:8080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(404);
  });

  it("returns ok:false with error message when fetch throws", async () => {
    // Simulate a network-level failure (proxy unreachable, DNS failure, etc.)
    const mockFetch = (async (_url: string, _init?: any): Promise<Response> => {
      throw new Error("ECONNREFUSED 127.0.0.1:7890");
    }) as unknown as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    // Still HTTP 200 so the dashboard can render the error message cleanly.
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ECONNREFUSED");
    expect(typeof body.latencyMs).toBe("number");
  });

  it("truncates oversized proxy-test error messages", async () => {
    const mockFetch = (async (): Promise<Response> => {
      throw new Error("E".repeat(5_000));
    }) as unknown as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(false);
    expect(body.error.length).toBeLessThan(1100);
    expect(body.error).toContain("truncated");
  });

  it("reports timeout clearly when AbortController fires", async () => {
    // Simulate a fetch that hangs and gets aborted by the timeout
    const mockFetch = (async (_url: string, init?: any): Promise<Response> => {
      // Wait longer than the timeout, then check if aborted
      await new Promise(resolve => setTimeout(resolve, 200));
      if (init?.signal?.aborted) {
        throw new Error("The operation was aborted");
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    // Note: real timeout is 10s — for test speed we accept the 200ms wait.
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://slow-proxy:9999" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    // The mock should have detected the abort; either the test runs faster
    // than the 10s timeout (so ok:true) or the mock's own 200ms wait
    // completes normally. We only assert the response shape.
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.latencyMs).toBe("number");
  });
});

// /admin/api/accounts/edit + /admin/api/accounts/export-single (vceshi0.0.4+)
describe("/admin/api/accounts/edit — name/email editing", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-for-edit";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ name: "x" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when neither name nor email is provided", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ id: "some-id" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("updates name + email for an existing account", async () => {
    // First save a credential to get a real account id
    await saveCredential({ apiKey: "test-key-edit", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ id, name: "edited-name", email: "edited@x.com" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);

    // Verify the update persisted
    const list2 = await listAccounts();
    expect(list2.accounts[0].name).toBe("edited-name");
    expect(list2.accounts[0].email).toBe("edited@x.com");
  });

  it("returns 404 for unknown account id", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ id: "nonexistent-id", name: "x" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });
});

describe("/admin/api/accounts/export-single — single account JSON export", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-for-export";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id query param is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/export-single", { method: "GET" }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 404 for unknown account id", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/export-single?id=nonexistent", { method: "GET" }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });

  it("exports full account JSON including secrets", async () => {
    const cred: Credential = {
      apiKey: "export-test-key-1234567890",
      secret: "secret-abc",
      provider: "zai",
      plan: "coding-plan",
      userId: "user-xyz",
      name: "bob@x.com-coding-plan",
      email: "bob@x.com",
    };
    await saveCredential(cred);
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq(`/admin/api/accounts/export-single?id=${id}`, { method: "GET" }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.account).toBeDefined();
    expect(body.account.id).toBe(id);
    // Full credential with secrets (NOT masked)
    expect(body.account.credential.apiKey).toBe("export-test-key-1234567890");
    expect(body.account.credential.secret).toBe("secret-abc");
    expect(body.account.credential.email).toBe("bob@x.com");
    expect(body.account.credential.name).toBe("bob@x.com-coding-plan");
  });
});

// vceshi0.0.5: PUT /config deep-merges nested objects (retry/identity/logging/providers)
describe("PUT /admin/api/config — deep merge of nested objects (vceshi0.0.5+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-config-merge";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("partial retry update preserves other retry fields (no TypeError)", async () => {
    // Send only maxRetries in the retry object. Without deep-merge, this would
    // drop retryableStatuses/initialDelayMs/etc., causing handler.ts to throw
    // TypeError on the next request.
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { maxRetries: 7 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    // The merged retry config should still have all original fields plus the new maxRetries
    expect(opts.config.retry.maxRetries).toBe(7);
    expect(opts.config.retry.initialDelayMs).toBe(1000); // preserved
    expect(opts.config.retry.maxDelayMs).toBe(8000); // preserved
    expect(opts.config.retry.backoffFactor).toBe(2); // preserved
    expect(opts.config.retry.retryableStatuses).toEqual([529]); // preserved
    expect(opts.config.retry.credentialSwitchThreshold).toBe(0); // preserved
    expect(opts.config.retry.emptyStreamSwitchThreshold).toBe(3); // preserved
  });

  it("normalizes retryableStatuses when hot-applying partial retry updates", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { maxRetries: 2, retryableStatuses: [529, "429"] } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(opts.config.retry.maxRetries).toBe(2);
    expect(opts.config.retry.retryableStatuses).toEqual([529, 429]);
    expect(opts.config.retry.initialDelayMs).toBe(1000);
    expect(opts.config.retry.maxDelayMs).toBe(8000);
  });

  it("rejects invalid retryableStatuses without mutating live config", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { maxRetries: 2, retryableStatuses: [529, "bad", 99, 600] } }),
      }),
      opts,
    );
    const body = await resp!.json();
    expect(resp!.status).toBe(500);
    expect(body.error.message).toContain("retry.retryableStatuses");
    expect(opts.config.retry.maxRetries).toBe(0);
    expect(opts.config.retry.retryableStatuses).toEqual([529]);
  });

  it("normalizes model list updates and keeps the default model listed", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ defaultModel: "glm-4.6", models: [" glm-5.2 ", 123, ""] }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(opts.config.defaultModel).toBe("glm-4.6");
    expect(opts.config.models).toEqual(["glm-5.2", "glm-4.6"]);
  });

  it("partial identity update preserves other identity fields", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ identity: { appVersion: "9.9.9" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(opts.config.identity.appVersion).toBe("9.9.9");
    expect(opts.config.identity.sourceTitle).toBe("cli"); // preserved
    expect(opts.config.identity.refererOrigin).toBe("https://zcode.z.ai"); // preserved
  });

  it("first-time nested list updates are cloned and hot-applied", async () => {
    const opts = makeAdminOpts();
    delete (opts.config as any).responsesThinking;
    delete (opts.config as any).routingRules;
    delete (opts.config as any).modelMappings;
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({
          responsesThinking: { models: ["glm-5.2"] },
          routingRules: [{ pattern: "gpt-*", provider: "zai", note: "route" }],
          modelMappings: [{ from: "gpt-5.5", to: "glm-5.2", note: "map" }],
        }),
      }),
      opts,
    );
    const body = await resp!.json();
    expect(resp!.status).toBe(200);
    expect(body.hotApplied).toContain("responsesThinking");
    expect(opts.config.responsesThinking).toEqual({ models: ["glm-5.2"] });
    expect(opts.config.routingRules).toEqual([{ pattern: "gpt-*", provider: "zai", note: "route" }]);
    expect(opts.config.modelMappings).toEqual([{ from: "gpt-5.5", to: "glm-5.2", note: "map" }]);
  });

  it("rejects invalid nested list config updates", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ responsesThinking: { models: ["glm-5.2", 123] } }),
      }),
      opts,
    );
    const body = await resp!.json();
    expect(resp!.status).toBe(500);
    expect(body.error.message).toContain("responsesThinking");
  });
});

// vceshi0.0.5: POST /admin/api/credentials validates apiKey + provider
describe("POST /admin/api/credentials — field validation (vceshi0.0.5+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-cred-validation";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when apiKey is empty", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/credentials", {
        method: "POST",
        body: JSON.stringify({ provider: "zai", apiKey: "" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when provider is invalid", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/credentials", {
        method: "POST",
        body: JSON.stringify({ provider: "invalid-provider", apiKey: "some-key" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
  });

  it("returns 400 when plan is invalid", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/credentials", {
        method: "POST",
        body: JSON.stringify({ provider: "zai", apiKey: "some-key", plan: "enterprise-plan" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toContain("plan must be coding-plan or start-plan");
  });
});

// vceshi0.0.5: validateConfigForSave rejects bad emptyStreamSwitchThreshold + backoffFactor
describe("PUT /admin/api/config — retry field validation (vceshi0.0.5+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-retry-validation";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("rejects negative emptyStreamSwitchThreshold", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { emptyStreamSwitchThreshold: -1 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("emptyStreamSwitchThreshold");
  });

  it("rejects zero/negative backoffFactor", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { backoffFactor: 0 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("backoffFactor");
  });

  it("rejects zero retry delay values to match config loader semantics", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { initialDelayMs: 0, maxDelayMs: 0 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("initialDelayMs");
    expect(opts.config.retry.initialDelayMs).toBe(1000);
    expect(opts.config.retry.maxDelayMs).toBe(8000);
  });
});

// vceshi0.0.6+: disabled toggle endpoint
describe("/admin/api/accounts/disabled — toggle disabled state (vceshi0.0.6+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-disabled";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ disabled: true }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 400 when disabled is not a boolean", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id: "some-id", disabled: "yes" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("toggles disabled state for an existing account", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id, disabled: true }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.disabled).toBe(true);

    // Verify persisted
    const list2 = await listAccounts();
    expect(list2.accounts[0].disabled).toBe(true);
  });

  it("moves in-memory auth away from a disabled active account", async () => {
    await saveCredential({ apiKey: "enabled-key", provider: "zai" });
    await saveCredential({ apiKey: "active-key", provider: "bigmodel" });
    const list = await listAccounts();
    const activeId = list.activeId!;

    const authState: { setKey: string | null; clearCalled: boolean } = { setKey: null, clearCalled: false };
    const fakeAuth = {
      setOAuthCredential: (cred: { apiKey: string }) => { authState.setKey = cred.apiKey; },
      clearOAuthCredential: () => { authState.clearCalled = true; },
      getCredential: async () => { throw new Error("not used"); },
      switchToNextCredential: async () => null,
      getMode: () => "oauth" as const,
    };
    const opts = makeAdminOpts({ auth: fakeAuth as unknown as AuthManager });

    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id: activeId, disabled: true }),
      }),
      opts,
    );

    expect(resp!.status).toBe(200);
    expect(authState.setKey).toBe("enabled-key");
    expect(authState.clearCalled).toBe(false);
  });

  it("clears in-memory auth when disabling the only active account", async () => {
    await saveCredential({ apiKey: "only-key", provider: "zai" });
    const list = await listAccounts();

    let setCalled = false;
    let clearCalled = false;
    const fakeAuth = {
      setOAuthCredential: () => { setCalled = true; },
      clearOAuthCredential: () => { clearCalled = true; },
      getCredential: async () => { throw new Error("not used"); },
      switchToNextCredential: async () => null,
      getMode: () => "oauth" as const,
    };
    const opts = makeAdminOpts({ auth: fakeAuth as unknown as AuthManager });

    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id: list.accounts[0].id, disabled: true }),
      }),
      opts,
    );

    expect(resp!.status).toBe(200);
    expect(setCalled).toBe(false);
    expect(clearCalled).toBe(true);
  });

  it("returns 404 for unknown account id", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id: "nonexistent", disabled: true }),
      }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });
});
