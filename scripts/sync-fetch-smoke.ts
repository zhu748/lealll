/** Verify serialized bridge workers in normal and minified Node bundles, offline. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

const fixture = new Worker(`
  const { parentPort } = require("node:worker_threads");
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/large") { res.end(Buffer.alloc(9 * 1024 * 1024)); return; }
    res.writeHead(201, { "set-cookie": ["a=1", "b=2"] });
    res.end("bridge 中文🙂");
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage("http://127.0.0.1:" + server.address().port));
`, { eval: true });

const child = `
  const assert = require("node:assert/strict");
  const { syncFetchBlocking, shutdownSyncFetchWorker } = require(process.argv[1]);
  const origin = process.argv[2];
  const response = syncFetchBlocking(origin, {}, 3000);
  assert.equal(response.status, 201, response.error);
  assert.equal(response.body.toString(), "bridge 中文🙂");
  assert.deepEqual(response.setCookie, ["a=1", "b=2"]);
  assert.equal(syncFetchBlocking(origin + "/large", {}, 3000).error, "sync fetch response exceeds buffer capacity");
  shutdownSyncFetchWorker();
  assert.equal(syncFetchBlocking(origin, {}, 3000).status, 201);
  // Deliberately leave the last worker idle: unref must allow a normal exit.
  console.log("bridge ok");
`;

const temporary = mkdtempSync(join(tmpdir(), "sync-fetch-smoke-"));
try {
  const origin = await new Promise<string>((yes, no) => {
    fixture.once("message", yes);
    fixture.once("error", no);
  });
  for (const minify of [false, true]) {
    const output = join(temporary, minify ? "bridge-min.cjs" : "bridge.cjs");
    await build({
      entryPoints: [resolve("src/proxy/captcha-sync-fetch.ts")],
      outfile: output, bundle: true, platform: "node", format: "cjs", minify, logLevel: "silent",
    });
    const result = spawnSync(process.env.NODE_BINARY ?? "node", ["-e", child, output, origin], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.stdout.trim(), "bridge ok");
  }
  console.log("Sync bridge: normal/minified bundles, bounded HTTP, restart and idle process exit passed");
} finally {
  await fixture.terminate();
  rmSync(temporary, { recursive: true, force: true });
}
