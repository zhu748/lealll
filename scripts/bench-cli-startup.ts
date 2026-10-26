/** Node CLI startup benchmark: bun scripts/bench-cli-startup.ts [/path/to/baseline]. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";

const repository = resolve(process.argv[2] ?? process.cwd());
const temporary = mkdtempSync(join(tmpdir(), "zcode-cli-bench-"));
const bundle = join(temporary, "cli.cjs");
const node = process.env.NODE_BINARY ?? "node";
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ZCODE")));
environment.ZCODE_PROXY_CONFIG = join(temporary, "absent", "config.yaml");
environment.ZCODE_PROXY_STORE_DIR = join(temporary, "absent", "store");
environment.ZCODE_UPDATE_CHECK = "off";

function measure(flag: string) {
  const run = () => {
    const start = performance.now();
    const result = spawnSync(node, [bundle, flag], { env: environment, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(flag === "--help" ? "Usage:" : "zcode-proxy"));
    return Number((performance.now() - start).toFixed(3));
  };
  run();
  const samplesMs = Array.from({ length: 5 }, run);
  return { medianMs: [...samplesMs].sort((a, b) => a - b)[2], samplesMs };
}

try {
  buildSync({
    entryPoints: [join(repository, "src/index.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["./captcha-worker-asset.js"],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  console.log(JSON.stringify({
    runtime: spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(),
    method: "One warmup, five fresh Node processes per command; median wall time, build excluded.",
    scenarios: { version: measure("--version"), help: measure("--help") },
  }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
