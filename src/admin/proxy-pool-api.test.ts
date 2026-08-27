/**
 * Integration tests for the proxy pool admin API endpoints.
 *
 * These tests exercise the full HTTP route path (server → admin/api.ts →
 * proxy-pool.ts) for the new /admin/api/proxy-pool/* endpoints.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createFetchHandler } from "../server/server.js";
import { loadConfig } from "../config/loader.js";
import { AuthManager } from "../auth/manager.js";
import { _resetForTesting, _poolFilePath } from "../proxy/proxy-pool.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Use a temp store dir for tests so we don't touch the user's real store.
const TEST_STORE_DIR = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
process.env.ZCODE_PROXY_STORE_DIR = TEST_STORE_DIR;

// Build a minimal config for the test server.
const config = loadConfig("./config.example.yaml");
config.auth.proxyApiKey = "test-key";
const auth = new AuthManager({
  mode: "apikey",
  apiKey: "test-api-key.test-secret",
  provider: "zai",
});

const handler = createFetchHandler({
  config,
  auth,
  configPath: TEST_STORE_DIR + "/config.yaml",
});

const authHeaders = { Authorization: "Bearer test-key", "Content-Type": "application/json" };

function cleanupPoolFile() {
  const poolFile = _poolFilePath();
  if (existsSync(poolFile)) {
    try { unlinkSync(poolFile); } catch { /* ignore */ }
  }
  _resetForTesting();
}

beforeEach(() => {
  cleanupPoolFile();
});

afterEach(() => {
  cleanupPoolFile();
});

test("GET /admin/api/proxy-pool returns default config + empty pool", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.config.enabled).toBe(false);
  expect(data.config.refreshIntervalMin).toBe(5);
  expect(data.config.sourceUrls).toEqual([]);
  expect(data.proxies).toEqual([]);
});

test("PUT /admin/api/proxy-pool/config updates config", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      enabled: true,
      refreshIntervalMin: 10,
      sourceUrls: ["https://example.com/list.txt"],
    }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.config.enabled).toBe(true);
  expect(data.config.refreshIntervalMin).toBe(10);
  expect(data.config.sourceUrls).toEqual(["https://example.com/list.txt"]);
});

test("PUT /admin/api/proxy-pool/config trims and dedupes source URLs", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      sourceUrls: [
        " https://example.com/list.txt ",
        "https://example.com/list.txt",
        "https://example.com/other.txt",
      ],
    }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.config.sourceUrls).toEqual([
    "https://example.com/list.txt",
    "https://example.com/other.txt",
  ]);
});

test("PUT /admin/api/proxy-pool/config rejects invalid source URL", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      sourceUrls: ["not-a-url"],
    }),
  }));
  expect(resp.status).toBe(400);
});

test("PUT /admin/api/proxy-pool/config rejects unsafe source URLs", async () => {
  for (const sourceUrl of [
    "ftp://example.com/list.txt",
    "http://169.254.169.254/latest",
    "http://[::]/list.txt",
  ]) {
    const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ sourceUrls: [sourceUrl] }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_param");
  }
});

test("PUT /admin/api/proxy-pool/config rejects non-object bodies", async () => {
  for (const body of [null, []]) {
    const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(body),
    }));
    expect(resp.status).toBe(400);
  }
});

test("PUT /admin/api/proxy-pool/config rejects invalid scalar fields without mutating config", async () => {
  const goodResp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      enabled: true,
      refreshIntervalMin: 10,
      rotateOnGatewayBlock: false,
      maxRotations: 7,
      sourceUrls: ["https://example.com/list.txt"],
    }),
  }));
  expect(goodResp.status).toBe(200);

  const invalidBodies = [
    { enabled: "true" },
    { refreshIntervalMin: 1.5 },
    { refreshIntervalMin: -1 },
    { refreshIntervalMin: 999999 },
    { sourceUrls: "https://example.com/list.txt" },
    { sourceUrls: [123] },
    { rotateOnGatewayBlock: "false" },
    { maxRotations: 1.5 },
    { maxRotations: 21 },
  ];
  for (const body of invalidBodies) {
    const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(body),
    }));
    expect(resp.status).toBe(400);
  }

  const stateResp = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  expect(stateResp.status).toBe(200);
  const state = await stateResp.json();
  expect(state.config).toEqual({
    enabled: true,
    refreshIntervalMin: 10,
    sourceUrls: ["https://example.com/list.txt"],
    rotateOnGatewayBlock: false,
    maxRotations: 7,
  });
});

test("POST /admin/api/proxy-pool/import-text imports proxies", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      // "not a url" is rejected (contains space). Comment is skipped.
      text: "1.2.3.4:8080\n5.6.7.8:3128\n# comment\nnot a valid url with space",
    }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.added).toBe(2);
  expect(data.total).toBe(2);
});

test("POST /admin/api/proxy-pool/import-text allows dashboard-sized text bodies", async () => {
  const body = JSON.stringify({
    // A large comment block should parse to zero proxies, but it must not be
    // rejected by the ordinary 1 MiB admin JSON cap because the dashboard
    // allows 5 MiB proxy text imports.
    text: "#" + "x".repeat(1 * 1024 * 1024 + 128 * 1024),
  });
  expect(body.length).toBeGreaterThan(1 * 1024 * 1024);
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body,
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.added).toBe(0);
});

test("POST /admin/api/proxy-pool/import-text requires text field", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({}),
  }));
  expect(resp.status).toBe(400);
});

test("POST /admin/api/proxy-pool/import-url rejects unsafe source URL before fetch", async () => {
  let fetchCalled = false;
  const mockFetch = (async () => {
    fetchCalled = true;
    return new Response("1.2.3.4:8080", { status: 200 });
  }) as unknown as typeof fetch;
  const localHandler = createFetchHandler({
    config,
    auth,
    configPath: TEST_STORE_DIR + "/config.yaml",
    fetchImpl: mockFetch,
  });

  const resp = await localHandler(new Request("http://x/admin/api/proxy-pool/import-url", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ url: "http://169.254.169.254/latest" }),
  }));

  expect(resp.status).toBe(400);
  const body = await resp.json();
  expect(body.error.type).toBe("invalid_param");
  expect(fetchCalled).toBe(false);
});

test("POST /admin/api/proxy-pool/clear empties the pool", async () => {
  // First add some proxies.
  await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: "1.2.3.4:8080\n5.6.7.8:3128" }),
  }));
  // Then clear.
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/clear", {
    method: "POST",
    headers: authHeaders,
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.removed).toBe(2);

  // Verify the pool is empty.
  const state = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData = await state.json();
  expect(stateData.proxies).toEqual([]);
});

test("DELETE /admin/api/proxy-pool/proxy removes a single entry", async () => {
  // Add 2 proxies.
  await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: "1.2.3.4:8080\n5.6.7.8:3128" }),
  }));
  // Get the pool state to find an id.
  const state = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData = await state.json();
  const idToRemove = stateData.proxies[0].id;

  // Delete it.
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/proxy", {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ id: idToRemove }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);

  // Verify the pool now has 1 entry.
  const state2 = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData2 = await state2.json();
  expect(stateData2.proxies).toHaveLength(1);
});

test("DELETE /admin/api/proxy-pool/proxy returns 404 for unknown id", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/proxy", {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ id: "nonexistent" }),
  }));
  expect(resp.status).toBe(404);
});

test("Proxy pool endpoints require auth", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool"));
  // Without auth (and with proxyApiKey configured), should be 401.
  expect(resp.status).toBe(401);
});

test("POST /admin/api/proxy-pool/test-one returns 404 for unknown id", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-one", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ id: "nonexistent" }),
  }));
  expect(resp.status).toBe(404);
});

test("POST /admin/api/proxy-pool/test-one requires id field", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-one", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({}),
  }));
  expect(resp.status).toBe(400);
});

test("POST /admin/api/proxy-pool/test-one cancels successful response body", async () => {
  let canceled = false;
  const mockFetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("unused"));
    },
    cancel() {
      canceled = true;
    },
  }), { status: 204 })) as unknown as typeof fetch;
  const localHandler = createFetchHandler({
    config,
    auth,
    configPath: TEST_STORE_DIR + "/config.yaml",
    fetchImpl: mockFetch,
  });

  await localHandler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: "1.2.3.4:8080" }),
  }));
  const state = await localHandler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData = await state.json();
  const id = stateData.proxies[0].id;

  const resp = await localHandler(new Request("http://x/admin/api/proxy-pool/test-one", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ id }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(canceled).toBe(true);
});

test("POST /admin/api/proxy-pool/test-one unrefs the timeout timer", async () => {
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
    const mockFetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const localHandler = createFetchHandler({
      config,
      auth,
      configPath: TEST_STORE_DIR + "/config.yaml",
      fetchImpl: mockFetch,
    });

    await localHandler(new Request("http://x/admin/api/proxy-pool/import-text", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "1.2.3.4:8080" }),
    }));
    const state = await localHandler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
    const stateData = await state.json();
    const id = stateData.proxies[0].id;

    const resp = await localHandler(new Request("http://x/admin/api/proxy-pool/test-one", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ id }),
    }));
    expect(resp.status).toBe(200);
    expect(unrefDelays).toContain(10_000);
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }
});

test("POST /admin/api/proxy-pool/test-one truncates oversized error messages", async () => {
  const mockFetch = (async () => {
    throw new Error("E".repeat(5_000));
  }) as unknown as typeof fetch;
  const localHandler = createFetchHandler({
    config,
    auth,
    configPath: TEST_STORE_DIR + "/config.yaml",
    fetchImpl: mockFetch,
  });

  await localHandler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: "1.2.3.4:8080" }),
  }));
  const state = await localHandler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData = await state.json();
  const id = stateData.proxies[0].id;

  const resp = await localHandler(new Request("http://x/admin/api/proxy-pool/test-one", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ id }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(false);
  expect(data.error.length).toBeLessThan(1100);
  expect(data.error).toContain("truncated");
});

test("POST /admin/api/proxy-pool/test-all rejects invalid batchSize", async () => {
  for (const batchSize of ["abc", 0, 1.5, 51]) {
    const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-all", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ batchSize }),
    }));
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error.message).toContain("batchSize");
  }
});

test("POST /admin/api/proxy-pool/test-all rejects invalid autoRemove", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-all", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ autoRemove: "true" }),
  }));
  expect(resp.status).toBe(400);
  const data = await resp.json();
  expect(data.error.message).toContain("autoRemove");
});

test("POST /admin/api/proxy-pool/test-all rejects invalid provider", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-all", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ provider: "openai" }),
  }));
  expect(resp.status).toBe(400);
  const data = await resp.json();
  expect(data.error.message).toContain("provider");
});

test("GET /admin/api/proxy-pool returns currentWorkingProxy field", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.currentWorkingProxy).toBeNull(); // no proxy picked yet
});
