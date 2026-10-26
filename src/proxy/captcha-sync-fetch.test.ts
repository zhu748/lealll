import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Worker } from "node:worker_threads";
import { syncFetchBlocking, shutdownSyncFetchWorker } from "./captcha-sync-fetch.js";
import {
  readSyncFetchResult,
  resolveSyncFetchTimeoutMs,
  SYNC_FETCH_DEFAULT_TIMEOUT_MS,
  SYNC_FETCH_HEADER_BYTES,
  SYNC_FETCH_PAYLOAD_BYTES,
} from "./captcha-sync-protocol.js";

// A separate event loop must serve HTTP: the caller deliberately blocks its
// own thread with Atomics.wait. This fixture makes no external requests.
const HTTP_FIXTURE = `
  const { parentPort } = require("node:worker_threads");
  const http = require("node:http");
  let closedStalls = 0;
  let largeStreamBytes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/large-stream-bytes") { res.end(String(largeStreamBytes)); return; }
    if (req.url === "/streaming-large") {
      largeStreamBytes = 0;
      const chunk = Buffer.alloc(256 * 1024, 120);
      const timer = setInterval(() => {
        largeStreamBytes += chunk.length;
        res.write(chunk);
        if (largeStreamBytes >= 64 * 1024 * 1024) { clearInterval(timer); res.end(); }
      }, 1);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/stall") {
      req.on("close", () => { closedStalls++; });
      return;
    }
    if (req.url === "/closed-stalls") { res.end(String(closedStalls)); return; }
    if (req.url === "/large") { res.end(Buffer.alloc(9 * 1024 * 1024, 120)); return; }
    if (req.url === "/chunked-large") {
      res.writeHead(200);
      res.write(Buffer.alloc(4 * 1024 * 1024, 120));
      res.end(Buffer.alloc(5 * 1024 * 1024, 120));
      return;
    }
    if (req.url === "/empty") { res.writeHead(204); res.end(); return; }
    if (req.url === "/http-error") { res.writeHead(503); res.end("upstream busy"); return; }
    if (req.url === "/buffer-boundary") {
      res.end(Buffer.alloc(${SYNC_FETCH_PAYLOAD_BYTES} - 1024, 120));
      return;
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1; HttpOnly", "b=2; Secure"] });
      res.end(JSON.stringify({ text: "中文🙂", method: req.method, body: Buffer.concat(chunks).toString(), marker: req.headers["x-test"] }));
    });
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage("http://127.0.0.1:" + server.address().port));
`;

describe("synchronous HTTP bridge", () => {
  let server: Worker;
  let origin = "";
  beforeAll(async () => {
    server = new Worker(HTTP_FIXTURE, { eval: true });
    origin = await new Promise<string>((resolve, reject) => {
      server.once("message", resolve);
      server.once("error", reject);
    });
  });
  afterEach(shutdownSyncFetchWorker);
  afterAll(async () => { await server.terminate(); });

  it("preserves status, UTF-8, cookies, request body and headers", () => {
    const result = syncFetchBlocking(origin, { method: "POST", headers: { "x-test": "kept" }, body: "request🙂" }, 3000);
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe(201);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.setCookie).toEqual(["a=1; HttpOnly", "b=2; Secure"]);
    expect(JSON.parse(result.body.toString())).toEqual({ text: "中文🙂", method: "POST", body: "request🙂", marker: "kept" });
  });

  it("preserves empty and HTTP error responses", () => {
    const empty = syncFetchBlocking(origin + "/empty", {}, 3000);
    if ("error" in empty) throw new Error(empty.error);
    expect(empty.status).toBe(204);
    expect(empty.body.byteLength).toBe(0);
    const error = syncFetchBlocking(origin + "/http-error", {}, 3000);
    if ("error" in error) throw new Error(error.error);
    expect(error.status).toBe(503);
    expect(error.body.toString()).toBe("upstream busy");
  });

  it.each(["/large", "/chunked-large"])("bounds streamed bytes for %s", (path) => {
    expect(syncFetchBlocking(origin + path, {}, 3000)).toEqual({ error: "sync fetch response exceeds buffer capacity" });
    const recovered = syncFetchBlocking(origin + "/empty", {}, 3000);
    expect("error" in recovered).toBe(false);
  });

  it("accepts a large response that fits after reserving metadata", () => {
    const result = syncFetchBlocking(origin + "/buffer-boundary", {}, 3000);
    if ("error" in result) throw new Error(result.error);
    expect(result.body.byteLength).toBe(SYNC_FETCH_PAYLOAD_BYTES - 1024);
    expect(result.body[0]).toBe(120);
    expect(result.body[result.body.byteLength - 1]).toBe(120);
  });

  it("cancels an oversized stream before downloading its entire 64 MiB body", () => {
    expect(syncFetchBlocking(origin + "/streaming-large", {}, 3000)).toEqual({ error: "sync fetch response exceeds buffer capacity" });
    const observed = syncFetchBlocking(origin + "/large-stream-bytes", {}, 3000);
    if ("error" in observed) throw new Error(observed.error);
    expect(Number(observed.body.toString())).toBeGreaterThanOrEqual(SYNC_FETCH_PAYLOAD_BYTES);
    expect(Number(observed.body.toString())).toBeLessThan(16 * 1024 * 1024);
  });

  it("terminates timed-out work and recovers without an old exit clearing the new worker", async () => {
    syncFetchBlocking(origin + "/empty", {}, 3000); // warm the bridge before timing the stalled fetch
    const start = performance.now();
    expect(syncFetchBlocking(origin + "/stall", {}, 50)).toEqual({ error: "sync fetch timeout" });
    expect(performance.now() - start).toBeLessThan(1000);
    for (let i = 0; i < 2; i++) {
      const recovered = syncFetchBlocking(origin + "/empty", {}, 3000);
      expect("error" in recovered).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const closed = syncFetchBlocking(origin + "/closed-stalls", {}, 3000);
    if ("error" in closed) throw new Error(closed.error);
    expect(Number(closed.body.toString())).toBeGreaterThan(0);
  });

  it("handles malformed URLs and allows explicit, repeated shutdown", () => {
    expect("error" in syncFetchBlocking("not-a-url", {}, 3000)).toBe(true);
    shutdownSyncFetchWorker();
    shutdownSyncFetchWorker();
    expect("error" in syncFetchBlocking(origin + "/empty", {}, 3000)).toBe(false);
  });

  it("does not retain a reference to shared memory in returned bodies", () => {
    const first = syncFetchBlocking(origin + "/http-error", {}, 3000);
    if ("error" in first) throw new Error(first.error);
    syncFetchBlocking(origin + "/buffer-boundary", {}, 3000);
    expect(first.body.toString()).toBe("upstream busy");
    expect(first.body.buffer instanceof SharedArrayBuffer).toBe(false);
  });
});

describe("sync bridge protocol", () => {
  it.each([undefined, "", "bad", "NaN", "Infinity", Infinity, NaN, 0, -1])("bounds invalid timeout %s", (value) => {
    expect(resolveSyncFetchTimeoutMs(value)).toBe(SYNC_FETCH_DEFAULT_TIMEOUT_MS);
  });
  it("preserves valid overrides and caps platform timer overflow", () => {
    expect(resolveSyncFetchTimeoutMs("250")).toBe(250);
    expect(resolveSyncFetchTimeoutMs(0.5)).toBe(1);
    expect(resolveSyncFetchTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });
  it.each([[0, 0, 0], [3, 0, 0], [1, -1, 0], [1, 0, -1], [1, 513, 0], [1, 500, 13]])(
    "rejects unpublished or invalid lengths (%j)", (state, metadata, body) => {
      const buffer = new SharedArrayBuffer(SYNC_FETCH_HEADER_BYTES + 512);
      const header = new Int32Array(buffer, 0, 3);
      header.set([state, metadata, body]);
      expect(() => readSyncFetchResult(buffer)).toThrow("layout");
    },
  );
  it("rejects malformed metadata and decodes bounded errors", () => {
    const buffer = new SharedArrayBuffer(SYNC_FETCH_HEADER_BYTES + 512);
    const header = new Int32Array(buffer, 0, 3);
    const payload = new Uint8Array(buffer, SYNC_FETCH_HEADER_BYTES);
    const text = new TextEncoder().encode('{"status":200,"statusText":"OK","headers":[],"setCookie":[]}');
    payload.set(text); header.set([1, text.byteLength, 0]);
    expect(() => readSyncFetchResult(buffer)).toThrow("metadata");
    payload.set(new TextEncoder().encode("bounded failure")); header.set([2, 15, 0]);
    expect(readSyncFetchResult(buffer)).toEqual({ error: "bounded failure" });
  });
});
