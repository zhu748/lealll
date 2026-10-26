/** Offline comparison: bun scripts/bench-response-paths.ts [/path/to/baseline]. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

const repository = resolve(process.argv[2] ?? process.cwd());
const { ResponseStore } = await import(join(repository, "src/responses/store.ts"));
const { transformParsedBody } = await import(join(repository, "src/proxy/body-transformer.ts"));

function measure(run: () => void): { medianMs: number; samplesMs: number[] } {
  run();
  const samplesMs = Array.from({ length: 5 }, () => {
    const start = performance.now();
    run();
    return Number((performance.now() - start).toFixed(3));
  });
  const ordered = [...samplesMs].sort((a, b) => a - b);
  return { medianMs: ordered[2], samplesMs };
}

function history(id: string) {
  return { id, model: "glm-5.3", status: "completed" as const, input: [], output: [], createdAt: 0, lastAccessedAt: 0 };
}

function cacheWrites(capacity: number) {
  const store = new ResponseStore({ maxEntries: capacity });
  for (let i = 0; i < capacity; i++) store.set(history(`response-${i}`));
  const timing = measure(() => {
    for (let i = 0; i < 10_000; i++) store.set(history(`response-${i % capacity}`));
  });
  assert.equal(store.size(), capacity);
  assert.equal(store.get("response-0")?.id, "response-0");
  return timing;
}

const canonical = {
  model: "glm-5.3",
  messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(512 * 1024), cache_control: { type: "ephemeral" } }] }],
};
const serialized = JSON.stringify(canonical);
const canonicalBody = measure(() => {
  for (let i = 0; i < 200; i++) {
    const result = transformParsedBody(canonical, { format: "anthropic" });
    if (result !== undefined) assert.equal(result, serialized);
  }
});

console.log(JSON.stringify({
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
  scenarios: {
    writes10000With1000Histories: cacheWrites(1000),
    writes10000With10000Histories: cacheWrites(10_000),
    canonicalBody512KiB200Transforms: canonicalBody,
  },
}, null, 2));
