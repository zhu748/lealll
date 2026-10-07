/** Offline microbenchmarks. Pass another checkout path to compare implementations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(process.argv[2] ?? process.cwd());
const storeDir = mkdtempSync(join(tmpdir(), "zcode-bench-"));
process.env.ZCODE_PROXY_STORE_DIR = storeDir;
process.env.ZCODE_PROXY_TEST_QUIET = "1";
const pool = await import(join(repository, "src/proxy/proxy-pool.ts"));
const stats = await import(join(repository, "src/admin/stats.ts"));
const { anthropicSseToOpenaiSse } = await import(join(repository, "src/translator/sse-translator.ts"));
const encoder = new TextEncoder();

async function measure(run: () => Promise<void> | void): Promise<number> {
  await run(); // Warm imports and JIT before collecting five measurements.
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return Number(samples[2].toFixed(3));
}

async function translate(bytes: Uint8Array, chunkSize: number): Promise<string> {
  let offset = 0;
  const input = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  } });
  return new Response(anthropicSseToOpenaiSse(input)).text();
}

try {
  const proxies = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i), url: `http://proxy-${i}.example:8080`, source: "manual", addedAt: 0,
  }));
  writeFileSync(join(storeDir, "proxy-pool.json"), JSON.stringify({
    version: 1,
    config: { enabled: true, sourceUrls: [], refreshIntervalMin: 0, rotateOnGatewayBlock: true, maxRotations: 3 },
    proxies,
  }));
  pool.setCurrentWorkingProxy(proxies[4999].url);
  assert.equal(await pool.pickProxy(), proxies[4999].url);
  const stickyMs = await measure(async () => {
    for (let i = 0; i < 5000; i++) assert.equal(await pool.pickProxy(), proxies[4999].url);
  });

  const statsMs = await measure(() => {
    stats._resetStatsForTesting();
    for (let i = 0; i < 10_000; i++) stats.recordStat({
      id: `request-${i}`, time: "00:00:00", model: "glm-test", status: 200,
      ttfb: "1", tokens: "1", inputTokens: "1", credentialKey: `credential-${i % 1000}`,
    });
  });

  const largeText = "x".repeat(512 * 1024);
  const fragmented = encoder.encode(`data: ${JSON.stringify({
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: largeText },
  })}\n\n`);
  const fragmentedMs = await measure(async () => {
    const output = await translate(fragmented, 256);
    assert.ok(output.includes(largeText));
    assert.ok(output.endsWith("data: [DONE]\n\n"));
  });

  const typical = encoder.encode(Array.from({ length: 10_000 }, () =>
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n'
  ).join(""));
  const typicalMs = await measure(async () => {
    const output = await translate(typical, 16 * 1024);
    assert.equal(output.match(/"content":"hello"/g)?.length, 10_000);
  });
  console.log(JSON.stringify({
    runtime: Bun.version,
    medianMs: { sticky5000: stickyMs, stats10000: statsMs, fragmentedSse512KiB: fragmentedMs, typicalSse10000: typicalMs },
  }, null, 2));
} finally {
  pool._resetForTesting();
  rmSync(storeDir, { recursive: true, force: true });
}
