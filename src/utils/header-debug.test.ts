import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordHeaders,
  resolveHeaderDebugMaxConcurrentWrites,
  resolveHeaderDebugMaxPendingRecords,
  _headerDebugQueuedPreviewBytesForTesting,
  _headerDebugQueueStatsForTesting,
  _resetHeaderDebugForTesting,
  _setHeaderDebugWriteGateForTesting,
} from "./header-debug.js";

let tempDir = "";
let oldDebugDir: string | undefined;
let oldMaxPending: string | undefined;
let oldConcurrency: string | undefined;
const utf8Encoder = new TextEncoder();

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function waitForHeaderDebugDrain(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const stats = _headerDebugQueueStatsForTesting();
    if (stats.pending === 0 && stats.active === 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`header-debug queue did not drain: ${JSON.stringify(_headerDebugQueueStatsForTesting())}`);
}

function makeRequest(url: string, headers: Record<string, string>): Request {
  return new Request(url, { method: "POST", headers });
}

beforeEach(() => {
  oldDebugDir = process.env.ZCODE_PROXY_HEADER_DEBUG_DIR;
  oldMaxPending = process.env.ZCODE_PROXY_HEADER_DEBUG_MAX_PENDING;
  oldConcurrency = process.env.ZCODE_PROXY_HEADER_DEBUG_CONCURRENCY;
  tempDir = mkdtempSync(join(tmpdir(), "zcode-header-debug-"));
  process.env.ZCODE_PROXY_HEADER_DEBUG_DIR = tempDir;
  delete process.env.ZCODE_PROXY_HEADER_DEBUG_MAX_PENDING;
  delete process.env.ZCODE_PROXY_HEADER_DEBUG_CONCURRENCY;
  _resetHeaderDebugForTesting();
});

afterEach(async () => {
  await waitForHeaderDebugDrain().catch(() => {});
  _resetHeaderDebugForTesting();
  restoreEnv("ZCODE_PROXY_HEADER_DEBUG_DIR", oldDebugDir);
  restoreEnv("ZCODE_PROXY_HEADER_DEBUG_MAX_PENDING", oldMaxPending);
  restoreEnv("ZCODE_PROXY_HEADER_DEBUG_CONCURRENCY", oldConcurrency);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

test("header debug env bounds reject partial values and clamp huge queues", () => {
  expect(resolveHeaderDebugMaxPendingRecords(undefined)).toBe(100);
  expect(resolveHeaderDebugMaxPendingRecords("")).toBe(100);
  expect(resolveHeaderDebugMaxPendingRecords("250")).toBe(250);
  expect(resolveHeaderDebugMaxPendingRecords("0")).toBe(100);
  expect(resolveHeaderDebugMaxPendingRecords("1.5")).toBe(100);
  expect(resolveHeaderDebugMaxPendingRecords("100abc")).toBe(100);
  expect(resolveHeaderDebugMaxPendingRecords("999999")).toBe(10_000);

  expect(resolveHeaderDebugMaxConcurrentWrites(undefined)).toBe(2);
  expect(resolveHeaderDebugMaxConcurrentWrites("4")).toBe(4);
  expect(resolveHeaderDebugMaxConcurrentWrites("0")).toBe(2);
  expect(resolveHeaderDebugMaxConcurrentWrites("2.5")).toBe(2);
  expect(resolveHeaderDebugMaxConcurrentWrites("8junk")).toBe(2);
  expect(resolveHeaderDebugMaxConcurrentWrites("999")).toBe(16);
});

test("recordHeaders writes paired inbound/upstream files and masks secrets", async () => {
  recordHeaders(
    makeRequest("http://client.test/v1/messages", {
      authorization: "Bearer proxy-secret-token-1234567890",
      "content-type": "application/json",
    }),
    makeRequest("https://api.z.ai/v1/messages", {
      authorization: "Bearer upstream-secret-token-1234567890",
      "x-api-key": "short",
    }),
    "#001",
    "anthropic",
    '{"model":"glm-4.6"}',
    '{"messages":[]}',
  );

  await waitForHeaderDebugDrain();

  const files = readdirSync(tempDir).sort();
  expect(files).toHaveLength(2);
  const inboundFile = files.find(f => f.endsWith("_inbound.json"))!;
  const upstreamFile = files.find(f => f.endsWith("_upstream.json"))!;
  const inbound = JSON.parse(readFileSync(join(tempDir, inboundFile), "utf-8"));
  const upstream = JSON.parse(readFileSync(join(tempDir, upstreamFile), "utf-8"));

  expect(inbound.side).toBe("inbound");
  expect(upstream.side).toBe("upstream");
  expect(inbound.headers.authorization).not.toContain("proxy-secret-token");
  expect(upstream.headers.authorization).not.toContain("upstream-secret-token");
  expect(upstream.headers["x-api-key"]).toBe("***");
  expect(inbound.bodyPreview).toBe('{"messages":[]}');
  expect(upstream.bodyPreview).toBe('{"model":"glm-4.6"}');
});

test("recordHeaders truncates body previews by UTF-8 bytes", async () => {
  const nonAsciiBody = "汉".repeat(7000);
  recordHeaders(
    makeRequest("http://client.test/v1/messages", {}),
    makeRequest("https://api.z.ai/v1/messages", {}),
    "#utf8",
    "anthropic",
    nonAsciiBody,
    nonAsciiBody,
  );

  await waitForHeaderDebugDrain();

  const inboundFile = readdirSync(tempDir).find(f => f.endsWith("_inbound.json"))!;
  const inbound = JSON.parse(readFileSync(join(tempDir, inboundFile), "utf-8"));
  const [previewOnly] = inbound.bodyPreview.split("...(truncated");

  expect(inbound.bodyPreview).toContain("truncated, total 21000 bytes");
  expect(utf8Encoder.encode(previewOnly).byteLength).toBeLessThanOrEqual(16 * 1024);
  expect(inbound.bodyPreview).not.toContain("\uFFFD");
});

test("recordHeaders truncates body previews before queueing", async () => {
  process.env.ZCODE_PROXY_HEADER_DEBUG_MAX_PENDING = "5";
  process.env.ZCODE_PROXY_HEADER_DEBUG_CONCURRENCY = "1";
  _resetHeaderDebugForTesting();

  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => {
    releaseGate = resolve;
  });
  _setHeaderDebugWriteGateForTesting(gate);

  const bigBody = "x".repeat(1024 * 1024);
  try {
    recordHeaders(
      makeRequest("http://client.test/v1/messages?active=1", {}),
      makeRequest("https://api.z.ai/v1/messages?active=1", {}),
      "#active",
      "anthropic",
      "{}",
      "{}",
    );
    recordHeaders(
      makeRequest("http://client.test/v1/messages?queued=1", {}),
      makeRequest("https://api.z.ai/v1/messages?queued=1", {}),
      "#queued",
      "anthropic",
      bigBody,
      bigBody,
    );

    expect(_headerDebugQueueStatsForTesting()).toMatchObject({ active: 1, pending: 1 });
    const queued = _headerDebugQueuedPreviewBytesForTesting();
    expect(queued).toHaveLength(1);
    expect(queued[0].inbound).toBeGreaterThan(0);
    expect(queued[0].upstream).toBeGreaterThan(0);
    expect(queued[0].inbound).toBeLessThan(17 * 1024);
    expect(queued[0].upstream).toBeLessThan(17 * 1024);
    expect(queued[0].inbound).toBeLessThan(utf8Encoder.encode(bigBody).byteLength);
    expect(queued[0].upstream).toBeLessThan(utf8Encoder.encode(bigBody).byteLength);
  } finally {
    _setHeaderDebugWriteGateForTesting(null);
    releaseGate();
  }

  await waitForHeaderDebugDrain();
});

test("recordHeaders bounds queued debug writes during request storms", async () => {
  process.env.ZCODE_PROXY_HEADER_DEBUG_MAX_PENDING = "2";
  process.env.ZCODE_PROXY_HEADER_DEBUG_CONCURRENCY = "1";
  _resetHeaderDebugForTesting();

  const oldWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    for (let i = 0; i < 10; i++) {
      recordHeaders(
        makeRequest(`http://client.test/v1/messages?i=${i}`, {}),
        makeRequest(`https://api.z.ai/v1/messages?i=${i}`, {}),
        `#${String(i).padStart(3, "0")}`,
        "anthropic",
      );
    }

    const statsDuringStorm = _headerDebugQueueStatsForTesting();
    expect(statsDuringStorm.active).toBe(1);
    expect(statsDuringStorm.pending).toBeLessThanOrEqual(2);
    expect(statsDuringStorm.dropped).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes("dropping records"))).toBe(true);

    await waitForHeaderDebugDrain();
    const files = readdirSync(tempDir);
    expect(files.length).toBeLessThanOrEqual(6);
  } finally {
    console.warn = oldWarn;
  }
});

test("recordHeaders drains large queues after internal compaction", async () => {
  process.env.ZCODE_PROXY_HEADER_DEBUG_MAX_PENDING = "200";
  process.env.ZCODE_PROXY_HEADER_DEBUG_CONCURRENCY = "8";
  _resetHeaderDebugForTesting();

  for (let i = 0; i < 150; i++) {
    recordHeaders(
      makeRequest(`http://client.test/v1/messages?compact=${i}`, {}),
      makeRequest(`https://api.z.ai/v1/messages?compact=${i}`, {}),
      `#compact-${String(i).padStart(3, "0")}`,
      "anthropic",
    );
  }

  await waitForHeaderDebugDrain();

  expect(_headerDebugQueueStatsForTesting()).toEqual({ pending: 0, active: 0, dropped: 0 });
  expect(readdirSync(tempDir)).toHaveLength(300);
});
