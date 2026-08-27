/**
 * Tests for the global proxy pool module.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  normalizeProxyLine,
  parseProxyText,
  importFromText,
  importFromUrl,
  refreshFromSources,
  removeProxy,
  removeProxies,
  clearProxies,
  getPoolState,
  updatePoolConfig,
  pickProxy,
  markProxyFailed,
  getMaxRotations,
  getCurrentWorkingProxy,
  setCurrentWorkingProxy,
  startTestJob,
  getTestJobState,
  cancelTestJob,
  scheduleAutoRefresh,
  resolvePoolMtimeCheckIntervalMs,
  resolveProxySourceMaxBytes,
  resolveSourceFetchConcurrency,
  resolveTestJobResultTtlMs,
  validateProxySourceUrl,
  _readProxySourceTextForTesting,
  _testJobResultOrderLengthForTesting,
  _flushFailureCountersForTesting,
  _setFailureFlushBeforeWriteHookForTesting,
  _resetForTesting,
  _poolFilePath,
} from "./proxy-pool.js";
import { PROXY_POOL as PROXY_POOL_CONST } from "../utils/constants.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let testStoreDir: string | null = null;
let POOL_FILE = _poolFilePath();

function useIsolatedStoreDir(): void {
  testStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-pool-"));
  process.env.ZCODE_PROXY_STORE_DIR = testStoreDir;
  _resetForTesting();
  POOL_FILE = _poolFilePath();
}

function cleanupIsolatedStoreDir(): void {
  const dir = testStoreDir;
  testStoreDir = null;
  delete process.env.ZCODE_PROXY_STORE_DIR;
  _resetForTesting();
  POOL_FILE = _poolFilePath();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function ensureCleanState() {
  _resetForTesting();
  POOL_FILE = _poolFilePath();
  if (existsSync(POOL_FILE)) {
    try { rmSync(POOL_FILE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

beforeEach(() => {
  useIsolatedStoreDir();
  ensureCleanState();
});

afterEach(() => {
  ensureCleanState();
  cleanupIsolatedStoreDir();
});

test("resolvePoolMtimeCheckIntervalMs: clamps unsafe values to avoid hot stat loops", () => {
  expect(resolvePoolMtimeCheckIntervalMs(undefined)).toBe(1000);
  expect(resolvePoolMtimeCheckIntervalMs("")).toBe(1000);
  expect(resolvePoolMtimeCheckIntervalMs("1000")).toBe(1000);
  expect(resolvePoolMtimeCheckIntervalMs("0")).toBe(100);
  expect(resolvePoolMtimeCheckIntervalMs("99")).toBe(100);
  expect(resolvePoolMtimeCheckIntervalMs("60001")).toBe(60_000);
  expect(resolvePoolMtimeCheckIntervalMs("1.5")).toBe(1000);
  expect(resolvePoolMtimeCheckIntervalMs("100abc")).toBe(1000);
  expect(resolvePoolMtimeCheckIntervalMs("-1")).toBe(1000);
});

test("proxy source env limits reject partial values instead of flooring them", () => {
  expect(resolveProxySourceMaxBytes(undefined)).toBe(10 * 1024 * 1024);
  expect(resolveProxySourceMaxBytes("")).toBe(10 * 1024 * 1024);
  expect(resolveProxySourceMaxBytes("0")).toBe(0);
  expect(resolveProxySourceMaxBytes("1048576")).toBe(1_048_576);
  expect(resolveProxySourceMaxBytes("1.5")).toBe(10 * 1024 * 1024);
  expect(resolveProxySourceMaxBytes("1024abc")).toBe(10 * 1024 * 1024);
  expect(resolveProxySourceMaxBytes("-1")).toBe(10 * 1024 * 1024);

  expect(resolveSourceFetchConcurrency(undefined)).toBe(5);
  expect(resolveSourceFetchConcurrency("3")).toBe(3);
  expect(resolveSourceFetchConcurrency("0")).toBe(1);
  expect(resolveSourceFetchConcurrency("99")).toBe(20);
  expect(resolveSourceFetchConcurrency("3.5")).toBe(5);
  expect(resolveSourceFetchConcurrency("3abc")).toBe(5);
  expect(resolveSourceFetchConcurrency("-1")).toBe(5);
});

test("resolveTestJobResultTtlMs: accepts only complete non-negative integers", () => {
  expect(resolveTestJobResultTtlMs(undefined)).toBe(30 * 60_000);
  expect(resolveTestJobResultTtlMs("")).toBe(30 * 60_000);
  expect(resolveTestJobResultTtlMs("0")).toBe(0);
  expect(resolveTestJobResultTtlMs("100")).toBe(100);
  expect(resolveTestJobResultTtlMs("0.5")).toBe(30 * 60_000);
  expect(resolveTestJobResultTtlMs("100abc")).toBe(30 * 60_000);
  expect(resolveTestJobResultTtlMs("-1")).toBe(30 * 60_000);
  expect(resolveTestJobResultTtlMs("2147483648")).toBe(2_147_483_647);
  expect(resolveTestJobResultTtlMs("999999999999999999999")).toBe(30 * 60_000);
});

test("validateProxySourceUrl: accepts http(s) and blocks unsafe source targets", () => {
  expect(validateProxySourceUrl(" https://example.com/list.txt ")).toEqual({
    ok: true,
    url: "https://example.com/list.txt",
  });
  expect(validateProxySourceUrl("ftp://example.com/list.txt").ok).toBe(false);
  expect(validateProxySourceUrl("http://169.254.169.254/latest").ok).toBe(false);
  expect(validateProxySourceUrl("http://0.0.0.0/list.txt").ok).toBe(false);
  expect(validateProxySourceUrl("http://[::]/list.txt").ok).toBe(false);
  expect(validateProxySourceUrl("http://[fe80::1]/list.txt").ok).toBe(false);
  expect(validateProxySourceUrl("http://127.0.0.1/list.txt").ok).toBe(true);
});

// --- normalizeProxyLine ---

test("normalizeProxyLine: returns null for empty / comment lines", () => {
  expect(normalizeProxyLine("")).toBeNull();
  expect(normalizeProxyLine("   ")).toBeNull();
  expect(normalizeProxyLine("# comment")).toBeNull();
  expect(normalizeProxyLine("  # indented comment")).toBeNull();
});

test("normalizeProxyLine: prepends http:// to bare host:port", () => {
  // Note: port 80 is the http default, so URL normalization strips it.
  expect(normalizeProxyLine("1.2.3.4:80")).toBe("http://1.2.3.4");
  expect(normalizeProxyLine("1.2.3.4:8080")).toBe("http://1.2.3.4:8080");
  expect(normalizeProxyLine("example.com:3128")).toBe("http://example.com:3128");
});

test("normalizeProxyLine: preserves explicit scheme", () => {
  // Default ports get normalized away (80 for http, 443 for https).
  expect(normalizeProxyLine("http://1.2.3.4:8080")).toBe("http://1.2.3.4:8080");
  expect(normalizeProxyLine("http://1.2.3.4:80")).toBe("http://1.2.3.4");
  expect(normalizeProxyLine("https://1.2.3.4:8080")).toBe("https://1.2.3.4:8080");
  expect(normalizeProxyLine("https://1.2.3.4:443")).toBe("https://1.2.3.4");
  expect(normalizeProxyLine("socks4://1.2.3.4:1080")).toBe("socks4://1.2.3.4:1080");
  expect(normalizeProxyLine("socks4a://1.2.3.4:1080")).toBe("socks4a://1.2.3.4:1080");
  expect(normalizeProxyLine("socks5://1.2.3.4:1080")).toBe("socks5://1.2.3.4:1080");
  expect(normalizeProxyLine("socks5h://1.2.3.4:1080")).toBe("socks5h://1.2.3.4:1080");
});

test("normalizeProxyLine: rejects invalid schemes", () => {
  expect(normalizeProxyLine("ftp://1.2.3.4:8080")).toBeNull();
  expect(normalizeProxyLine("javascript:alert(1)")).toBeNull();
  expect(normalizeProxyLine("file:///etc/passwd")).toBeNull();
});

test("normalizeProxyLine: rejects cloud metadata / unspecified IPs", () => {
  // normalizeProxyLine itself does NOT do SSRF filtering — that's done by
  // validateProxyUrl in importFromText. Here we just verify the URL parses
  // (default port 80 is stripped by URL normalization).
  expect(normalizeProxyLine("169.254.169.254:80")).toBe("http://169.254.169.254");
  expect(normalizeProxyLine("0.0.0.0:80")).toBe("http://0.0.0.0");
});

test("normalizeProxyLine: preserves credentials", () => {
  expect(normalizeProxyLine("user:pass@1.2.3.4:8080")).toBe("http://user:pass@1.2.3.4:8080");
  expect(normalizeProxyLine("http://user:pass@1.2.3.4:8080")).toBe("http://user:pass@1.2.3.4:8080");
});

// --- parseProxyText ---

test("parseProxyText: parses multi-line text, dedupes, skips comments", () => {
  const text = `
# This is a comment
1.2.3.4:8080
http://5.6.7.8:3128
socks5://9.10.11.12:1080

# Another comment
1.2.3.4:8080  # duplicate of line 2
`;
  const result = parseProxyText(text);
  expect(result).toEqual([
    "http://1.2.3.4:8080",
    "http://5.6.7.8:3128",
    "socks5://9.10.11.12:1080",
  ]);
});

test("parseProxyText: handles many lines in one import", () => {
  const text = Array.from({ length: 1000 }, (_, i) => `p${i}.example.com:8080`).join("\r\n");

  const result = parseProxyText(text);

  expect(result).toHaveLength(1000);
  expect(result[0]).toBe("http://p0.example.com:8080");
  expect(result[999]).toBe("http://p999.example.com:8080");
});

// --- importFromText (merge mode) ---

test("importFromText: merge mode adds new proxies without removing existing", async () => {
  const r1 = await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  expect(r1.added).toBe(2);
  expect(r1.total).toBe(2);

  const r2 = await importFromText("5.6.7.8:3128\n9.10.11.12:1080");
  // 5.6.7.8 already exists, 9.10.11.12 is new
  expect(r2.added).toBe(1);
  expect(r2.total).toBe(3);

  const state = await getPoolState();
  expect(state.proxies).toHaveLength(3);
  expect(state.proxies.map(p => p.url).sort()).toEqual([
    "http://1.2.3.4:8080",
    "http://5.6.7.8:3128",
    "http://9.10.11.12:1080",
  ]);
});

test("importFromText: skips proxy URLs with port 0", async () => {
  const r = await importFromText("socks5://1.2.3.4:0\nsocks5://5.6.7.8:1080");
  expect(r.added).toBe(1);
  expect(r.total).toBe(1);

  const state = await getPoolState();
  expect(state.proxies.map(p => p.url)).toEqual(["socks5://5.6.7.8:1080"]);
});

// --- importFromText (replace mode) ---

test("importFromText: replace mode wipes existing manual proxies", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  const r = await importFromText("9.10.11.12:1080", true);
  expect(r.added).toBe(1);
  expect(r.removed).toBe(2);
  expect(r.total).toBe(1);
  const state = await getPoolState();
  expect(state.proxies).toHaveLength(1);
  expect(state.proxies[0].url).toBe("http://9.10.11.12:1080");
});

test("importFromText: replace mode clears stale sticky proxy", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  setCurrentWorkingProxy("http://1.2.3.4:8080");
  expect(getCurrentWorkingProxy()).toBe("http://1.2.3.4:8080");

  await importFromText("9.10.11.12:1080", true);

  expect(getCurrentWorkingProxy()).toBeNull();
  expect((await getPoolState()).currentWorkingProxy).toBeNull();
});

test("importFromText: write failures are reported and do not leave fake cached proxies", async () => {
  mkdirSync(dirname(POOL_FILE), { recursive: true });
  mkdirSync(POOL_FILE, { recursive: true });

  try {
    await expect(
      importFromText("1.2.3.4:8080", true),
    ).rejects.toThrow(/Could not persist proxy pool/);

    const state = await getPoolState();
    expect(state.proxies).toEqual([]);
  } finally {
    rmSync(POOL_FILE, { recursive: true, force: true });
    _resetForTesting();
  }
});

// --- importFromUrl ---

test("importFromUrl: fetches and parses a remote list", async () => {
  const mockFetch = async (url: string) => {
    expect(url).toBe("https://example.com/proxies.txt");
    return new Response("1.2.3.4:8080\n5.6.7.8:3128\n# comment\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  const r = await importFromUrl("https://example.com/proxies.txt", mockFetch as unknown as typeof fetch);
  expect(r.error).toBeUndefined();
  expect(r.fetched).toBe(2);
  expect(r.added).toBe(2);
  expect(r.total).toBe(2);
});

test("importFromUrl: returns error on HTTP failure", async () => {
  const mockFetch = async () => new Response("Not Found", { status: 404 });
  const r = await importFromUrl("https://example.com/missing.txt", mockFetch as unknown as typeof fetch);
  expect(r.error).toBe("HTTP 404");
  expect(r.added).toBe(0);
});

test("importFromUrl: truncates oversized fetch error messages", async () => {
  const mockFetch = async () => {
    throw new Error("E".repeat(2_000));
  };
  const r = await importFromUrl("https://example.com/failing.txt", mockFetch as unknown as typeof fetch);
  expect(r.error!.length).toBeLessThan(600);
  expect(r.error).toContain("truncated");
});

test("importFromUrl: cancels failed HTTP response bodies", async () => {
  let canceled = false;
  const mockFetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("failure body"));
    },
    cancel() {
      canceled = true;
    },
  }), { status: 500 });

  const r = await importFromUrl("https://example.com/failing.txt", mockFetch as unknown as typeof fetch);

  expect(r.error).toBe("HTTP 500");
  expect(canceled).toBe(true);
});

test("importFromUrl: idempotent refresh replaces same-source proxies", async () => {
  const mockFetch1 = async () => new Response("1.2.3.4:8080\n5.6.7.8:3128", { status: 200 });
  await importFromUrl("https://example.com/list.txt", mockFetch1 as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(2);

  // Second fetch with a DIFFERENT list — old entries from this source are
  // removed, new ones are added.
  const mockFetch2 = async () => new Response("9.10.11.12:1080\n11.12.13.14:8888", { status: 200 });
  const r = await importFromUrl("https://example.com/list.txt", mockFetch2 as unknown as typeof fetch);
  expect(r.removed).toBe(2);
  expect(r.added).toBe(2);
  expect(r.total).toBe(2);
  const state = await getPoolState();
  expect(state.proxies.map(p => p.url).sort()).toEqual([
    "http://11.12.13.14:8888",
    "http://9.10.11.12:1080",
  ]);
});

test("importFromUrl: rejects oversized remote lists from Content-Length", async () => {
  let canceled = false;
  const mockFetch = async () => new Response(new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  }), {
    status: 200,
    headers: { "content-length": String(resolveProxySourceMaxBytes() + 1) },
  });
  const r = await importFromUrl("https://example.com/huge.txt", mockFetch as unknown as typeof fetch);
  expect(r.error).toContain("byte limit");
  expect(r.added).toBe(0);
  expect(canceled).toBe(true);
  expect((await getPoolState()).proxies).toHaveLength(0);
});

test("importFromUrl: rejects unsafe source URLs before fetch", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return new Response("1.2.3.4:8080", { status: 200 });
  };

  const r = await importFromUrl("http://169.254.169.254/latest", mockFetch as unknown as typeof fetch);

  expect(r.error).toContain("cloud metadata");
  expect(r.added).toBe(0);
  expect(fetchCalled).toBe(false);
});

test("importFromUrl: unrefs the remote source fetch timeout", async () => {
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
    const mockFetch = async () => new Response("1.2.3.4:8080", { status: 200 });
    const r = await importFromUrl("https://example.com/proxies.txt", mockFetch as unknown as typeof fetch);

    expect(r.error).toBeUndefined();
    expect(unrefDelays).toContain(PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS);
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }
});

test("readProxySourceText: rejects chunked remote lists after crossing the byte limit", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("12345"));
      controller.enqueue(encoder.encode("67890"));
      controller.close();
    },
  });
  await expect(_readProxySourceTextForTesting(new Response(stream), 8)).rejects.toThrow(/byte limit/);
});

test("readProxySourceText: times out stalled response bodies even when byte limit is disabled", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      canceled = true;
    },
  });
  const keepAlive = setInterval(() => {}, 1);
  try {
    await expect(_readProxySourceTextForTesting(new Response(stream), 0, 5))
      .rejects.toThrow(/proxy source response read timeout after 5ms/);
    expect(canceled).toBe(true);
  } finally {
    clearInterval(keepAlive);
  }
});

// --- refreshFromSources ---

test("refreshFromSources: aggregates multiple URLs and preserves manual entries", async () => {
  // Seed with manual entries (use non-default ports so normalization is stable).
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");

  // Configure two source URLs.
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: [
      "https://a.example/list.txt",
      "https://b.example/list.txt",
    ],
  });

  const mockFetch = async (url: string) => {
    if (url === "https://a.example/list.txt") {
      return new Response("3.3.3.3:8080\n4.4.4.4:8080", { status: 200 });
    }
    if (url === "https://b.example/list.txt") {
      return new Response("5.5.5.5:8080\n6.6.6.6:8080", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await refreshFromSources(mockFetch as unknown as typeof fetch);
  expect(result.total).toBe(6); // 2 manual + 4 from URLs
  expect(result.errors).toBeUndefined();

  const state = await getPoolState();
  const urls = state.proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://1.1.1.1:8080",
    "http://2.2.2.2:8080",
    "http://3.3.3.3:8080",
    "http://4.4.4.4:8080",
    "http://5.5.5.5:8080",
    "http://6.6.6.6:8080",
  ]);
});

test("refreshFromSources: bounds concurrent source fetches", async () => {
  const oldConcurrency = process.env.ZCODE_PROXY_POOL_SOURCE_CONCURRENCY;
  process.env.ZCODE_PROXY_POOL_SOURCE_CONCURRENCY = "3";
  try {
    const sourceUrls = Array.from({ length: 8 }, (_, i) => `https://source-${i}.example/list.txt`);
    await updatePoolConfig({
      enabled: true,
      refreshIntervalMin: 5,
      sourceUrls,
    });

    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const mockFetch = async (url: string) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise(r => setTimeout(r, 20));
        const idx = Number(url.match(/source-(\d+)/)?.[1] ?? "0") + 1;
        return new Response(`10.0.0.${idx}:8080`, { status: 200 });
      } finally {
        active--;
      }
    };

    const result = await refreshFromSources(mockFetch as unknown as typeof fetch);

    expect(calls).toBe(8);
    expect(maxActive).toBe(3);
    expect(result.total).toBe(8);
    expect(result.errors).toBeUndefined();
  } finally {
    if (oldConcurrency === undefined) delete process.env.ZCODE_PROXY_POOL_SOURCE_CONCURRENCY;
    else process.env.ZCODE_PROXY_POOL_SOURCE_CONCURRENCY = oldConcurrency;
  }
});

test("refreshFromSources: unrefs remote source fetch timeout timers", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: [
      "https://a.example/list.txt",
      "https://b.example/list.txt",
    ],
  });

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
    const mockFetch = async (url: string) => {
      if (url === "https://a.example/list.txt") return new Response("3.3.3.3:8080", { status: 200 });
      if (url === "https://b.example/list.txt") return new Response("4.4.4.4:8080", { status: 200 });
      return new Response("not found", { status: 404 });
    };

    const result = await refreshFromSources(mockFetch as unknown as typeof fetch);

    expect(result.errors).toBeUndefined();
    expect(unrefDelays.filter(delay => delay === PROXY_POOL_CONST.SOURCE_FETCH_TIMEOUT_MS).length).toBeGreaterThanOrEqual(2);
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }
});

test("refreshFromSources: coalesces concurrent refresh calls", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: [
      "https://a.example/list.txt",
      "https://b.example/list.txt",
    ],
  });

  let calls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>(resolve => {
    releaseFetch = resolve;
  });
  const mockFetch = async (url: string) => {
    calls++;
    await fetchGate;
    if (url === "https://a.example/list.txt") return new Response("3.3.3.3:8080", { status: 200 });
    if (url === "https://b.example/list.txt") return new Response("4.4.4.4:8080", { status: 200 });
    return new Response("not found", { status: 404 });
  };

  const first = refreshFromSources(mockFetch as unknown as typeof fetch);
  for (let i = 0; i < 20 && calls === 0; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
  expect(calls).toBe(2);

  const second = refreshFromSources(mockFetch as unknown as typeof fetch);
  await new Promise(r => setTimeout(r, 0));
  expect(calls).toBe(2);

  releaseFetch();
  const [r1, r2] = await Promise.all([first, second]);

  expect(calls).toBe(2);
  expect(r1.total).toBe(2);
  expect(r2.total).toBe(2);
  expect((await getPoolState()).proxies.map(p => p.url).sort()).toEqual([
    "http://3.3.3.3:8080",
    "http://4.4.4.4:8080",
  ]);
});

test("refreshFromSources: honors source URL config changes while fetch is in-flight", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: [
      "https://a.example/list.txt",
      "https://b.example/list.txt",
    ],
  });

  let calls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>(resolve => {
    releaseFetch = resolve;
  });
  const mockFetch = async (url: string) => {
    calls++;
    await fetchGate;
    if (url === "https://a.example/list.txt") return new Response("3.3.3.3:8080", { status: 200 });
    if (url === "https://b.example/list.txt") return new Response("4.4.4.4:8080", { status: 200 });
    return new Response("not found", { status: 404 });
  };

  const refresh = refreshFromSources(mockFetch as unknown as typeof fetch);
  for (let i = 0; i < 20 && calls < 2; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
  expect(calls).toBe(2);

  await updatePoolConfig({
    sourceUrls: ["https://b.example/list.txt"],
  });

  releaseFetch();
  const result = await refresh;
  const state = await getPoolState();

  expect(result.added).toBe(1);
  expect(result.total).toBe(1);
  expect(state.config.sourceUrls).toEqual(["https://b.example/list.txt"]);
  expect(state.proxies.map(p => p.url)).toEqual(["http://4.4.4.4:8080"]);
});

test("refreshFromSources: preserves concurrent manual edits while source fetch is in-flight", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
  });

  let fetchStarted = false;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>(resolve => {
    releaseFetch = resolve;
  });
  const mockFetch = async () => {
    fetchStarted = true;
    await fetchGate;
    return new Response("3.3.3.3:8080", { status: 200 });
  };

  const refreshPromise = refreshFromSources(mockFetch as unknown as typeof fetch);
  for (let i = 0; i < 50; i++) {
    if (fetchStarted) break;
    await new Promise(r => setTimeout(r, 10));
  }
  expect(fetchStarted).toBe(true);

  const staleManual = (await getPoolState()).proxies.find(p => p.url === "http://1.1.1.1:8080");
  expect(staleManual).toBeDefined();
  await removeProxy(staleManual!.id);
  await importFromText("2.2.2.2:8080");

  releaseFetch();
  const result = await refreshPromise;
  expect(result.total).toBe(2);

  const urls = (await getPoolState()).proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://2.2.2.2:8080",
    "http://3.3.3.3:8080",
  ]);
});

test("refreshFromSources: preserves existing proxies from FAILED sources (Bug 1)", async () => {
  // Seed with manual entries + do an initial successful refresh from URL1.
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
  });

  // Initial successful refresh.
  const mockFetchOk = async () => new Response("3.3.3.3:8080\n4.4.4.4:8080", { status: 200 });
  await refreshFromSources(mockFetchOk as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(3); // 1 manual + 2 from URL1

  // Now refresh again, but URL1 fails (network error). The existing URL1
  // proxies must be PRESERVED — not wiped.
  const mockFetchFail = async () => { throw new Error("ECONNREFUSED"); };
  const result = await refreshFromSources(mockFetchFail as unknown as typeof fetch);
  expect(result.errors).toBeDefined();
  expect(result.errors!["https://a.example/list.txt"]).toBe("ECONNREFUSED");

  const state = await getPoolState();
  // Manual entry + URL1's existing entries should still be there.
  expect(state.proxies).toHaveLength(3);
  const urls = state.proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://1.1.1.1:8080",
    "http://3.3.3.3:8080",
    "http://4.4.4.4:8080",
  ]);
});

test("refreshFromSources: preserves existing proxies when a source is oversized", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
  });

  const mockFetchOk = async () => new Response("3.3.3.3:8080\n4.4.4.4:8080", { status: 200 });
  await refreshFromSources(mockFetchOk as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(2);

  let canceled = false;
  const mockFetchHuge = async () => new Response(new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  }), {
    status: 200,
    headers: { "content-length": String(resolveProxySourceMaxBytes() + 1) },
  });
  const result = await refreshFromSources(mockFetchHuge as unknown as typeof fetch);
  expect(result.errors?.["https://a.example/list.txt"]).toContain("byte limit");
  expect(canceled).toBe(true);

  const state = await getPoolState();
  expect(state.proxies.map(p => p.url).sort()).toEqual([
    "http://3.3.3.3:8080",
    "http://4.4.4.4:8080",
  ]);
});

test("refreshFromSources: cancels failed HTTP source bodies", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
  });

  let canceled = false;
  const mockFetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("failure body"));
    },
    cancel() {
      canceled = true;
    },
  }), { status: 503 });

  const result = await refreshFromSources(mockFetch as unknown as typeof fetch);

  expect(result.errors?.["https://a.example/list.txt"]).toBe("HTTP 503");
  expect(canceled).toBe(true);
});

test("refreshFromSources: drops proxies from removed URL sources", async () => {
  // Configure with URL1 and URL2, do initial refresh.
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt", "https://b.example/list.txt"],
  });

  const mockFetchBoth = async (url: string) => {
    if (url === "https://a.example/list.txt") return new Response("3.3.3.3:8080", { status: 200 });
    if (url === "https://b.example/list.txt") return new Response("5.5.5.5:8080", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  await refreshFromSources(mockFetchBoth as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(3); // 1 manual + 1 URL1 + 1 URL2

  // Now remove URL2 from config and refresh again.
  await updatePoolConfig({
    sourceUrls: ["https://a.example/list.txt"],
  });
  await refreshFromSources(mockFetchBoth as unknown as typeof fetch);

  const state = await getPoolState();
  // URL2's proxy (5.5.5.5) should be dropped. Manual + URL1 remain.
  expect(state.proxies).toHaveLength(2);
  const urls = state.proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://1.1.1.1:8080",
    "http://3.3.3.3:8080",
  ]);
});

test("refreshFromSources: clears sticky proxy when its URL source is removed", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt", "https://b.example/list.txt"],
  });

  const mockFetchBoth = async (url: string) => {
    if (url === "https://a.example/list.txt") return new Response("3.3.3.3:8080", { status: 200 });
    if (url === "https://b.example/list.txt") return new Response("5.5.5.5:8080", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  await refreshFromSources(mockFetchBoth as unknown as typeof fetch);

  setCurrentWorkingProxy("http://5.5.5.5:8080");
  expect(getCurrentWorkingProxy()).toBe("http://5.5.5.5:8080");

  await updatePoolConfig({ sourceUrls: ["https://a.example/list.txt"] });
  await refreshFromSources(mockFetchBoth as unknown as typeof fetch);

  expect(getCurrentWorkingProxy()).toBeNull();
  expect((await getPoolState()).currentWorkingProxy).toBeNull();
});

test("refreshFromSources: counts proxies removed from a successfully refreshed source", async () => {
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
  });

  const mockFetchInitial = async () => new Response("3.3.3.3:8080\n4.4.4.4:8080", { status: 200 });
  await refreshFromSources(mockFetchInitial as unknown as typeof fetch);

  const mockFetchUpdated = async () => new Response("4.4.4.4:8080", { status: 200 });
  const result = await refreshFromSources(mockFetchUpdated as unknown as typeof fetch);

  expect(result.added).toBe(0);
  expect(result.removed).toBe(1);
  expect(result.total).toBe(1);

  const state = await getPoolState();
  expect(state.lastRefreshResult?.removed).toBe(1);
  expect(state.proxies.map(p => p.url)).toEqual(["http://4.4.4.4:8080"]);
});

// --- removeProxy ---

test("removeProxy: removes a single entry by id", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  const state = await getPoolState();
  const idToRemove = state.proxies[0].id;
  const ok = await removeProxy(idToRemove);
  expect(ok).toBe(true);
  const after = await getPoolState();
  expect(after.proxies).toHaveLength(1);
});

test("removeProxy: returns false for unknown id", async () => {
  await importFromText("1.2.3.4:8080");
  const ok = await removeProxy("nonexistent-id");
  expect(ok).toBe(false);
});

test("removeProxies: removes multiple entries and clears sticky state", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128\n9.9.9.9:9000");
  const state = await getPoolState();
  setCurrentWorkingProxy(state.proxies[1].url);

  const removed = await removeProxies([state.proxies[0].id, state.proxies[1].id, "missing-id"]);
  expect(removed).toBe(2);

  const after = await getPoolState();
  expect(after.proxies.map(p => p.url)).toEqual(["http://9.9.9.9:9000"]);
  expect(after.currentWorkingProxy).toBeNull();
  expect(getCurrentWorkingProxy()).toBeNull();
});

// --- clearProxies ---

test("clearProxies: empties the pool but preserves config", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  await updatePoolConfig({ enabled: true, refreshIntervalMin: 10, sourceUrls: ["https://x.example"] });
  const r = await clearProxies();
  expect(r.removed).toBe(2);
  const state = await getPoolState();
  expect(state.proxies).toHaveLength(0);
  expect(state.config.enabled).toBe(true);
  expect(state.config.refreshIntervalMin).toBe(10);
  expect(state.config.sourceUrls).toEqual(["https://x.example"]);
});

// --- pickProxy ---

test("pickProxy: returns null when pool is disabled", async () => {
  await importFromText("1.2.3.4:8080");
  // Default config: enabled=false
  const p = await pickProxy();
  expect(p).toBeNull();
});

test("pickProxy: sticky behavior — reuses the same proxy until it fails", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  // First pick returns one proxy and makes it sticky.
  const first = await pickProxy();
  expect(first).not.toBeNull();

  // Subsequent picks return the SAME sticky proxy (no round-robin).
  const second = await pickProxy();
  const third = await pickProxy();
  expect(second).toBe(first);
  expect(third).toBe(first);

  // After the sticky proxy fails, the next pick advances to a new one.
  await markProxyFailed(first!);
  const next = await pickProxy();
  expect(next).not.toBeNull();
  expect(next).not.toBe(first);
});

test("pickProxy: round-robins when sticky proxy is excluded", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  // First pick — becomes sticky.
  const first = await pickProxy();
  // Exclude the sticky proxy (simulating WAF rotation) — should get a different one.
  const exclude = new Set<string>([first!]);
  const second = await pickProxy(exclude);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  // The second proxy is now sticky.
  expect(getCurrentWorkingProxy()).toBe(second);
});

test("pickProxy: skips excluded URLs", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });
  const exclude = new Set<string>(["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
  const p = await pickProxy(exclude);
  expect(p).toBe("http://3.3.3.3:8080");
});

test("pickProxy: returns null when all are excluded", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  const exclude = new Set<string>(["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
  const p = await pickProxy(exclude);
  expect(p).toBeNull();
});

// --- markProxyFailed ---

test("markProxyFailed: increments failure counter", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });
  await markProxyFailed("http://1.1.1.1:8080");
  await markProxyFailed("http://1.1.1.1:8080");
  const state = await getPoolState();
  expect(state.proxies[0].failures).toBe(2);
});

test("markProxyFailed: persists debounced failure counters to disk", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });
  await markProxyFailed("http://1.1.1.1:8080");
  await markProxyFailed("http://1.1.1.1:8080");

  await _flushFailureCountersForTesting();
  _resetForTesting();

  const state = await getPoolState();
  expect(state.proxies[0].url).toBe("http://1.1.1.1:8080");
  expect(state.proxies[0].failures).toBe(2);
  expect(typeof state.proxies[0].lastFailedAt).toBe("number");
});

test("markProxyFailed: preserves failures recorded while a flush is writing", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  await markProxyFailed("http://1.1.1.1:8080");

  let injected = false;
  _setFailureFlushBeforeWriteHookForTesting(async () => {
    if (injected) return;
    injected = true;
    await markProxyFailed("http://2.2.2.2:8080");
  });
  try {
    await _flushFailureCountersForTesting();
  } finally {
    _setFailureFlushBeforeWriteHookForTesting(null);
  }

  // Force the follow-up flush scheduled by the in-flight markProxyFailed.
  await _flushFailureCountersForTesting();
  _resetForTesting();

  const state = await getPoolState();
  const byUrl = new Map(state.proxies.map(p => [p.url, p]));
  expect(byUrl.get("http://1.1.1.1:8080")?.failures).toBe(1);
  expect(byUrl.get("http://2.2.2.2:8080")?.failures).toBe(1);
});

test("markProxyFailed: clears sticky proxy when it fails", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  const first = await pickProxy();
  expect(getCurrentWorkingProxy()).toBe(first);
  // Fail the sticky proxy — sticky state should clear.
  await markProxyFailed(first!);
  expect(getCurrentWorkingProxy()).toBeNull();
  // Next pick should return a DIFFERENT proxy (the failed one is still in
  // the pool but not sticky).
  const next = await pickProxy();
  expect(next).not.toBe(first);
});

test("removeProxy: clears sticky proxy when it's removed", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  const first = await pickProxy();
  expect(getCurrentWorkingProxy()).toBe(first);
  const state = await getPoolState();
  const stickyEntry = state.proxies.find(p => p.url === first);
  // Remove the sticky proxy — sticky state should clear.
  await removeProxy(stickyEntry!.id);
  expect((await getPoolState()).currentWorkingProxy).toBeNull();
  expect(getCurrentWorkingProxy()).toBeNull();
});

test("setCurrentWorkingProxy: explicitly sets the sticky proxy", () => {
  setCurrentWorkingProxy("http://9.9.9.9:8080");
  expect(getCurrentWorkingProxy()).toBe("http://9.9.9.9:8080");
  setCurrentWorkingProxy(null);
  expect(getCurrentWorkingProxy()).toBeNull();
});

// --- updatePoolConfig ---

test("updatePoolConfig: partial updates merge with defaults", async () => {
  await updatePoolConfig({ enabled: true });
  let state = await getPoolState();
  expect(state.config.enabled).toBe(true);
  expect(state.config.refreshIntervalMin).toBe(5); // default
  expect(state.config.rotateOnGatewayBlock).toBe(true); // default

  await updatePoolConfig({ refreshIntervalMin: 15 });
  state = await getPoolState();
  expect(state.config.enabled).toBe(true); // preserved
  expect(state.config.refreshIntervalMin).toBe(15); // updated
});

test("updatePoolConfig: clones sourceUrls from the caller", async () => {
  const sourceUrls = ["https://a.example/list.txt"];
  await updatePoolConfig({ sourceUrls });
  sourceUrls.push("https://mutated.example/list.txt");

  const state = await getPoolState();
  expect(state.config.sourceUrls).toEqual(["https://a.example/list.txt"]);
});

test("updatePoolConfig: normalizes sourceUrls before storing", async () => {
  await updatePoolConfig({
    sourceUrls: [
      " https://a.example/list.txt ",
      123,
      "",
      "https://a.example/list.txt",
      "https://b.example/list.txt",
    ] as any,
  });

  const state = await getPoolState();
  expect(state.config.sourceUrls).toEqual([
    "https://a.example/list.txt",
    "https://b.example/list.txt",
  ]);
});

test("updatePoolConfig: normalizes scalar config fields before storing", async () => {
  await updatePoolConfig({
    enabled: "false" as any,
    refreshIntervalMin: "12" as any,
    rotateOnGatewayBlock: "true" as any,
    maxRotations: "999" as any,
  });

  let state = await getPoolState();
  expect(state.config.enabled).toBe(false);
  expect(state.config.refreshIntervalMin).toBe(12);
  expect(state.config.rotateOnGatewayBlock).toBe(true);
  expect(state.config.maxRotations).toBe(20);

  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 15,
    rotateOnGatewayBlock: false,
    maxRotations: 7,
  });
  await updatePoolConfig({
    enabled: "bad" as any,
    refreshIntervalMin: "1.5" as any,
    rotateOnGatewayBlock: "bad" as any,
    maxRotations: 7.5 as any,
  });

  state = await getPoolState();
  expect(state.config.enabled).toBe(true);
  expect(state.config.refreshIntervalMin).toBe(15);
  expect(state.config.rotateOnGatewayBlock).toBe(false);
  expect(state.config.maxRotations).toBe(7);
});

test("getPoolState: normalizes dirty scalar config fields from disk", async () => {
  mkdirSync(dirname(POOL_FILE), { recursive: true });
  writeFileSync(POOL_FILE, JSON.stringify({
    version: 1,
    config: {
      enabled: "false",
      refreshIntervalMin: "bad",
      sourceUrls: [
        " https://a.example/list.txt ",
        "https://a.example/list.txt",
        123,
      ],
      rotateOnGatewayBlock: "false",
      maxRotations: "999",
    },
    proxies: [],
  }), "utf-8");
  _resetForTesting();

  const state = await getPoolState();
  expect(state.config).toEqual({
    enabled: false,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
    rotateOnGatewayBlock: false,
    maxRotations: 20,
  });
});

test("getPoolState: detects external rewrites when mtime is unchanged but size differs", async () => {
  await importFromText("http://1.1.1.1:8080");

  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(POOL_FILE, fixedTime, fixedTime);
  _resetForTesting();

  const cached = await getPoolState();
  expect(cached.proxies).toHaveLength(1);
  const cachedStat = statSync(POOL_FILE);

  writeFileSync(POOL_FILE, JSON.stringify({
    version: 1,
    config: {
      enabled: true,
      refreshIntervalMin: 5,
      sourceUrls: [],
      rotateOnGatewayBlock: true,
      maxRotations: 3,
    },
    proxies: [
      { id: "external-1", url: "http://1.1.1.1:8080", source: "manual", addedAt: 1 },
      { id: "external-2", url: "http://2.2.2.2:8080", source: "manual", addedAt: 2 },
    ],
  }), "utf-8");
  utimesSync(POOL_FILE, fixedTime, fixedTime);

  const rewrittenStat = statSync(POOL_FILE);
  expect(rewrittenStat.mtimeMs).toBe(cachedStat.mtimeMs);
  expect(rewrittenStat.size).not.toBe(cachedStat.size);

  await new Promise(r => setTimeout(r, resolvePoolMtimeCheckIntervalMs() + 20));

  const refreshed = await getPoolState();
  expect(refreshed.proxies.map(p => p.url).sort()).toEqual([
    "http://1.1.1.1:8080",
    "http://2.2.2.2:8080",
  ]);
});

test("getPoolState: detects same-size external rewrites when mtime is unchanged", async () => {
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  mkdirSync(dirname(POOL_FILE), { recursive: true });

  const makePoolJson = (url: string) => JSON.stringify({
    version: 1,
    config: {
      enabled: true,
      refreshIntervalMin: 5,
      sourceUrls: [],
      rotateOnGatewayBlock: true,
      maxRotations: 3,
    },
    proxies: [
      { id: "external", url, source: "manual", addedAt: 1 },
    ],
  });

  const firstJson = makePoolJson("http://1.1.1.1:8080");
  const secondJson = makePoolJson("http://2.2.2.2:8080");
  expect(secondJson.length).toBe(firstJson.length);

  writeFileSync(POOL_FILE, firstJson, "utf-8");
  utimesSync(POOL_FILE, fixedTime, fixedTime);
  _resetForTesting();

  const cached = await getPoolState();
  expect(cached.proxies.map(p => p.url)).toEqual(["http://1.1.1.1:8080"]);
  const cachedStat = statSync(POOL_FILE);

  await new Promise(r => setTimeout(r, 20));
  writeFileSync(POOL_FILE, secondJson, "utf-8");
  utimesSync(POOL_FILE, fixedTime, fixedTime);

  const rewrittenStat = statSync(POOL_FILE);
  expect(rewrittenStat.mtimeMs).toBe(cachedStat.mtimeMs);
  expect(rewrittenStat.size).toBe(cachedStat.size);

  await new Promise(r => setTimeout(r, resolvePoolMtimeCheckIntervalMs() + 20));

  const refreshed = await getPoolState();
  expect(refreshed.proxies.map(p => p.url)).toEqual(["http://2.2.2.2:8080"]);
});

test("getPoolState: normalizes dirty proxy entries from disk", async () => {
  mkdirSync(dirname(POOL_FILE), { recursive: true });
  writeFileSync(POOL_FILE, JSON.stringify({
    version: 1,
    config: {
      enabled: true,
      refreshIntervalMin: 5,
      sourceUrls: [],
      rotateOnGatewayBlock: true,
      maxRotations: 3,
    },
    proxies: [
      null,
      {},
      { url: 123, source: "manual" },
      { url: "not a valid url with spaces", source: "manual" },
      {
        id: "wrong-id",
        url: " 1.2.3.4:8080 ",
        source: 123,
        addedAt: "bad",
        failures: "2",
        lastUsedAt: "3",
        lastFailedAt: "4",
        note: " recovered ",
      },
      {
        id: "also-wrong",
        url: "http://1.2.3.4:8080",
        source: "manual",
        addedAt: 1,
      },
      {
        url: "socks5://5.6.7.8:1080",
        source: "url:https://example.com/list.txt",
        addedAt: 10,
        failures: -1,
      },
    ],
  }), "utf-8");
  _resetForTesting();

  const state = await getPoolState();
  expect(state.proxies.map(p => p.url)).toEqual([
    "http://1.2.3.4:8080",
    "socks5://5.6.7.8:1080",
  ]);
  expect(state.proxies[0].id).toBeDefined();
  expect(state.proxies[0].id).not.toBe("wrong-id");
  expect(state.proxies[0].source).toBe("manual");
  expect(state.proxies[0].failures).toBe(2);
  expect(state.proxies[0].lastUsedAt).toBe(3);
  expect(state.proxies[0].lastFailedAt).toBe(4);
  expect(state.proxies[0].note).toBe("recovered");
  expect(state.proxies[1].source).toBe("url:https://example.com/list.txt");
  expect(state.proxies[1].failures).toBeUndefined();
  expect(await pickProxy()).toBe("http://1.2.3.4:8080");
});

test("getPoolState: normalizes dirty refresh metadata from disk", async () => {
  mkdirSync(dirname(POOL_FILE), { recursive: true });
  writeFileSync(POOL_FILE, JSON.stringify({
    version: 1,
    config: {
      enabled: false,
      refreshIntervalMin: 5,
      sourceUrls: [],
      rotateOnGatewayBlock: true,
      maxRotations: 3,
    },
    proxies: [],
    lastRefreshAt: "12345",
    lastRefreshResult: {
      added: "2",
      removed: -1,
      total: "bad",
      at: "67890",
      errors: {
        " https://a.example/list.txt ": "A".repeat(800),
        "not-a-url": "ignored",
        "https://b.example/list.txt": 123,
      },
    },
  }), "utf-8");
  _resetForTesting();

  const state = await getPoolState();
  expect(state.lastRefreshAt).toBe(12345);
  expect(state.lastRefreshResult?.added).toBe(2);
  expect(state.lastRefreshResult?.removed).toBe(0);
  expect(state.lastRefreshResult?.total).toBe(0);
  expect(state.lastRefreshResult?.at).toBe(67890);
  expect(Object.keys(state.lastRefreshResult?.errors ?? {})).toEqual(["https://a.example/list.txt"]);
  expect(state.lastRefreshResult?.errors?.["https://a.example/list.txt"]).toContain("truncated");
  expect(state.lastRefreshResult?.errors?.["https://a.example/list.txt"].length).toBeLessThan(800);
});

test("getPoolState: returns defensive copies of config arrays", async () => {
  await updatePoolConfig({ sourceUrls: ["https://a.example/list.txt"] });

  const state = await getPoolState();
  state.config.sourceUrls.push("https://mutated.example/list.txt");

  const after = await getPoolState();
  expect(after.config.sourceUrls).toEqual(["https://a.example/list.txt"]);
});

// --- getMaxRotations ---

test("getMaxRotations: returns default 3 when not set", async () => {
  const r = await getMaxRotations();
  expect(r).toBe(3);
});

test("getMaxRotations: returns configured value", async () => {
  await updatePoolConfig({ maxRotations: 7 });
  const r = await getMaxRotations();
  expect(r).toBe(7);
});

test("getMaxRotations: returns 0 when WAF rotation is disabled", async () => {
  await updatePoolConfig({ rotateOnGatewayBlock: false, maxRotations: 7 });
  const r = await getMaxRotations();
  expect(r).toBe(0);
});

// --- scheduleAutoRefresh ---

test("scheduleAutoRefresh: schedules timer when enabled + URLs configured", () => {
  // Just verify it doesn't throw and doesn't keep the process alive.
  scheduleAutoRefresh({
    enabled: true,
    refreshIntervalMin: 1,
    sourceUrls: ["https://example.com/list.txt"],
    rotateOnGatewayBlock: true,
    maxRotations: 3,
  });
  // The function returns void — just verify no throw.
  scheduleAutoRefresh({
    enabled: false,
    refreshIntervalMin: 0,
    sourceUrls: [],
    rotateOnGatewayBlock: true,
    maxRotations: 3,
  });
});

// --- Background test job ---

test("startTestJob: runs in background and updates state", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  // Mock fetch that succeeds for all proxies.
  const mockFetch = async () => new Response("", { status: 200 });

  const state = await startTestJob({
    batchSize: 2,
    autoRemove: false,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  expect(state.running).toBe(true);
  expect(state.total).toBe(3);
  expect(state.batchSize).toBe(2);

  // Wait for the job to finish (poll getTestJobState).
  let final = state;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 50));
  }

  expect(final.running).toBe(false);
  expect(final.tested).toBe(3);
  expect(final.okCount).toBe(3);
  expect(final.failCount).toBe(0);
  expect(Object.keys(final.results)).toHaveLength(3);
});

test("startTestJob: cancels successful response bodies after reading status", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });

  let canceled = 0;
  const mockFetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("unused"));
    },
    cancel() {
      canceled++;
    },
  }), { status: 204 });

  const state = await startTestJob({
    batchSize: 2,
    autoRemove: false,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  let final = state;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 50));
  }

  expect(final.running).toBe(false);
  expect(final.okCount).toBe(2);
  expect(canceled).toBe(2);
});

test("getTestJobState: supports incremental result polling by sequence", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  const mockFetch = async () => new Response("", { status: 200 });
  await startTestJob({
    batchSize: 1,
    autoRemove: false,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  let final = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 50));
  }

  expect(final.resultSeq).toBe(3);
  expect(Object.keys(final.results)).toHaveLength(3);
  const afterFirst = getTestJobState({ sinceSeq: 1 })!;
  expect(afterFirst.resultSeq).toBe(3);
  expect(Object.keys(afterFirst.results)).toHaveLength(2);
  expect(Object.values(afterFirst.results).every(r => (r.seq ?? 0) > 1)).toBe(true);
  const afterLatest = getTestJobState({ sinceSeq: final.resultSeq })!;
  expect(Object.keys(afterLatest.results)).toHaveLength(0);
});

test("getTestJobState: resets incremental result order between completed jobs", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });

  const mockFetch = async () => new Response("", { status: 200 });
  await startTestJob({
    batchSize: 2,
    autoRemove: false,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  let first = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    first = getTestJobState()!;
    if (!first.running) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect(first.resultSeq).toBe(2);
  expect(_testJobResultOrderLengthForTesting()).toBe(2);

  await startTestJob({
    batchSize: 1,
    autoRemove: false,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  let second = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    second = getTestJobState()!;
    if (!second.running) break;
    await new Promise(r => setTimeout(r, 50));
  }

  expect(second.resultSeq).toBe(2);
  expect(_testJobResultOrderLengthForTesting()).toBe(2);
  expect(Object.keys(getTestJobState({ sinceSeq: 0 })!.results)).toHaveLength(2);
  expect(Object.keys(getTestJobState({ sinceSeq: 1 })!.results)).toHaveLength(1);
  expect(Object.values(getTestJobState({ sinceSeq: 1 })!.results).every(r => (r.seq ?? 0) > 1)).toBe(true);
});

test("startTestJob: truncates oversized per-proxy error messages", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });

  const mockFetch = async () => {
    throw new Error("E".repeat(2_000));
  };
  await startTestJob({
    batchSize: 1,
    autoRemove: false,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  let final = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 50));
  }

  const result = Object.values(final.results)[0];
  expect(result.ok).toBe(false);
  expect(result.error!.length).toBeLessThan(600);
  expect(result.error).toContain("truncated");
});

test("startTestJob: autoRemove deletes failed proxies", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });

  // Mock fetch that fails for all proxies (throws).
  const mockFetch = async () => { throw new Error("ECONNREFUSED"); };

  const state = await startTestJob({
    batchSize: 5,
    autoRemove: true,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  expect(state.total).toBe(2);

  // Wait for the job to finish.
  let final = state;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 50));
  }

  expect(final.running).toBe(false);
  expect(final.failCount).toBe(2);
  expect(final.removedCount).toBe(2); // both failed proxies auto-removed

  // Verify the pool is now empty.
  const poolState = await getPoolState();
  expect(poolState.proxies).toHaveLength(0);
});

test("startTestJob: autoRemove does not delete a same-url proxy re-imported during the job", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });
  const initial = await getPoolState();
  const initialAddedAt = initial.proxies[0].addedAt;

  let releaseFetch!: () => void;
  const fetchStarted = new Promise<void>(resolveStarted => {
    const mockFetch = async () => {
      resolveStarted();
      await new Promise<void>(resolve => { releaseFetch = resolve; });
      throw new Error("ECONNREFUSED");
    };
    void startTestJob({
      batchSize: 1,
      autoRemove: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
      testTarget: "https://example.com",
    });
  });

  await fetchStarted;
  let reimported = await getPoolState();
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2));
    await importFromText("1.1.1.1:8080", true);
    reimported = await getPoolState();
    if (reimported.proxies[0]?.addedAt > initialAddedAt) break;
  }
  expect(reimported.proxies).toHaveLength(1);
  expect(reimported.proxies[0].id).toBe(initial.proxies[0].id);
  expect(reimported.proxies[0].addedAt).toBeGreaterThan(initialAddedAt);

  releaseFetch();

  let final = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 10));
  }

  expect(final.running).toBe(false);
  expect(final.failCount).toBe(1);
  expect(final.removedCount).toBe(0);
  const poolState = await getPoolState();
  expect(poolState.proxies).toHaveLength(1);
  expect(poolState.proxies[0].id).toBe(initial.proxies[0].id);
});

test("startTestJob: idempotent — returns existing job if already running", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });

  // Mock fetch that takes a bit to resolve.
  const mockFetch = async () => {
    await new Promise(r => setTimeout(r, 100));
    return new Response("", { status: 200 });
  };

  const state1 = await startTestJob({
    batchSize: 1,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  // Immediately start again — should return the same running job.
  const state2 = await startTestJob({
    batchSize: 1,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  expect(state2.running).toBe(true);
  expect(state2.startedAt).toBe(state1.startedAt);

  // Wait for it to finish.
  for (let i = 0; i < 50; i++) {
    if (!getTestJobState()!.running) break;
    await new Promise(r => setTimeout(r, 50));
  }
});

test("startTestJob: normalizes invalid internal batchSize and autoRemove values", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });

  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return new Response("", { status: 204 });
  };

  const state = await startTestJob({
    batchSize: "not-a-number" as any,
    autoRemove: "true" as any,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });
  expect(state.batchSize).toBe(5);
  expect(state.autoRemove).toBe(false);

  let final = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (!final.running) break;
    await new Promise(r => setTimeout(r, 10));
  }

  expect(final.running).toBe(false);
  expect(final.tested).toBe(2);
  expect(final.okCount).toBe(2);
  expect(calls).toBe(2);
});

test("cancelTestJob: stops the running job", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  // Mock fetch that takes a bit to resolve.
  const mockFetch = async () => {
    await new Promise(r => setTimeout(r, 100));
    return new Response("", { status: 200 });
  };

  await startTestJob({
    batchSize: 1,
    fetchImpl: mockFetch as unknown as typeof fetch,
    testTarget: "https://example.com",
  });

  expect(getTestJobState()!.running).toBe(true);
  cancelTestJob();

  // Wait a moment for the job to notice the cancel.
  await new Promise(r => setTimeout(r, 200));
  // The job should have stopped (running=false) after the current batch.
  for (let i = 0; i < 50; i++) {
    if (!getTestJobState()!.running) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect(getTestJobState()!.running).toBe(false);
});

test("cancelTestJob: aborts in-flight fetches without auto-removing cancelled proxies", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });

  let started = 0;
  let aborted = 0;
  const mockFetch = (async (_url: string, init?: any): Promise<Response> => {
    started++;
    const signal = init?.signal as AbortSignal | undefined;
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        aborted++;
        reject(new Error("aborted by test"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as unknown as typeof fetch;

  await startTestJob({
    batchSize: 2,
    autoRemove: true,
    fetchImpl: mockFetch,
    testTarget: "https://example.com",
  });

  for (let i = 0; i < 50; i++) {
    if (started === 2) break;
    await new Promise(r => setTimeout(r, 10));
  }
  expect(started).toBe(2);

  cancelTestJob();

  let final = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (aborted === 2 && final.tested === 2) break;
    await new Promise(r => setTimeout(r, 10));
  }

  expect(final.running).toBe(false);
  expect(aborted).toBe(2);
  expect(final.tested).toBe(2);
  expect(final.failCount).toBe(0);
  expect(final.removedCount).toBe(0);
  expect(Object.values(final.results).every(r => r.error === "Test cancelled")).toBe(true);
  expect((await getPoolState()).proxies).toHaveLength(2);
});

test("cancelTestJob: does not auto-remove failures recorded before cancellation", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });

  let started = 0;
  let aborted = 0;
  const mockFetch = (async (_url: string, init?: any): Promise<Response> => {
    started++;
    const signal = init?.signal as AbortSignal | undefined;
    if (started === 1) {
      throw new Error("ECONNREFUSED");
    }
    return await new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        aborted++;
        reject(new Error("aborted by test"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as unknown as typeof fetch;

  await startTestJob({
    batchSize: 2,
    autoRemove: true,
    fetchImpl: mockFetch,
    testTarget: "https://example.com",
  });

  for (let i = 0; i < 50; i++) {
    const state = getTestJobState()!;
    if (started === 2 && state.failCount === 1) break;
    await new Promise(r => setTimeout(r, 10));
  }
  expect(started).toBe(2);
  expect(getTestJobState()!.failCount).toBe(1);

  cancelTestJob();

  let final = getTestJobState()!;
  for (let i = 0; i < 50; i++) {
    final = getTestJobState()!;
    if (aborted === 1 && final.tested === 2) break;
    await new Promise(r => setTimeout(r, 10));
  }

  expect(final.running).toBe(false);
  expect(final.failCount).toBe(1);
  expect(final.removedCount).toBe(0);
  expect(aborted).toBe(1);
  expect((await getPoolState()).proxies).toHaveLength(2);
});

test("getTestJobState: expires completed job results after TTL", async () => {
  const oldTtl = process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS;
  process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS = "100";
  try {
    await importFromText("1.1.1.1:8080");
    await updatePoolConfig({ enabled: true });

    const mockFetch = async () => new Response("", { status: 200 });
    await startTestJob({
      batchSize: 1,
      autoRemove: false,
      fetchImpl: mockFetch as unknown as typeof fetch,
      testTarget: "https://example.com",
    });

    let final = getTestJobState()!;
    for (let i = 0; i < 50; i++) {
      final = getTestJobState()!;
      if (!final.running) break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(final.running).toBe(false);
    expect(Object.keys(final.results)).toHaveLength(1);

    await new Promise(r => setTimeout(r, 120));
    expect(getTestJobState()).toBeNull();
    expect(_testJobResultOrderLengthForTesting()).toBe(0);
  } finally {
    if (oldTtl === undefined) delete process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS;
    else process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS = oldTtl;
  }
});

test("cancelTestJob: aborts before immediate TTL cleanup and ignores late results", async () => {
  const oldTtl = process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS;
  process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS = "0";
  try {
    await importFromText("1.1.1.1:8080");
    await updatePoolConfig({ enabled: true });

    let started = 0;
    let aborted = 0;
    const mockFetch = (async (_url: string, init?: any): Promise<Response> => {
      started++;
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          aborted++;
          reject(new Error("aborted by test"));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as unknown as typeof fetch;

    await startTestJob({
      batchSize: 1,
      autoRemove: true,
      fetchImpl: mockFetch,
      testTarget: "https://example.com",
    });

    for (let i = 0; i < 50; i++) {
      if (started === 1) break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(started).toBe(1);

    cancelTestJob();

    for (let i = 0; i < 50; i++) {
      if (aborted === 1) break;
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 0));

    expect(aborted).toBe(1);
    expect(getTestJobState()).toBeNull();
    expect(_testJobResultOrderLengthForTesting()).toBe(0);
    expect((await getPoolState()).proxies).toHaveLength(1);
  } finally {
    if (oldTtl === undefined) delete process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS;
    else process.env.ZCODE_PROXY_POOL_TEST_JOB_TTL_MS = oldTtl;
  }
});

test("startTestJob: unrefs per-proxy timeout timers", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });

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
    const mockFetch = async () => new Response("", { status: 200 });
    await startTestJob({
      batchSize: 1,
      autoRemove: false,
      fetchImpl: mockFetch as unknown as typeof fetch,
      testTarget: "https://example.com",
    });
    expect(unrefDelays).toContain(10_000);
    await new Promise(resolve => originalSetTimeout(resolve, 0));
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
    cancelTestJob();
  }
});

test("getTestJobState: returns null when no job has ever run", () => {
  expect(getTestJobState()).toBeNull();
});
