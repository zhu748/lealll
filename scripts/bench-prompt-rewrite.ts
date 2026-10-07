/** Offline prompt-rewrite benchmark; an optional module path selects a baseline. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { defaultPromptRewriteConfig } from "../src/config/prompt-rewrite.js";
import type { PromptRewriteConfig } from "../src/config/types.js";

const { rewriteSystemPrompt } = await import(resolve(process.argv[2] ?? "src/proxy/prompt-rewrite.ts"));
const defaults = defaultPromptRewriteConfig();
const unchanged = "Keep this unrelated system instruction and all of its surrounding text.\n".repeat(4000);
const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const workloads: Array<{ name: string; text: string; config: PromptRewriteConfig; iterations: number; matches: number }> = [
  { name: "unmatchedLines", text: unchanged, config: defaults, iterations: 100, matches: 0 },
  { name: "matchedLines", text: ("before\n" + identity + "\nafter\n").repeat(1000), config: defaults, iterations: 50, matches: 1000 },
  { name: "denseLiteralDeletes", text: "x".repeat(256 * 1024), iterations: 10, matches: 256 * 1024,
    config: { enabled: true, rules: [{ id: "delete", name: "delete", enabled: true, action: "delete", matchMode: "text", match: "x", replacement: "" }] } },
  { name: "denseMixedLiteralDeletes", text: "xy".repeat(128 * 1024), iterations: 10, matches: 128 * 1024,
    config: { enabled: true, rules: [{ id: "delete", name: "delete", enabled: true, action: "delete", matchMode: "text", match: "x", replacement: "" }] } },
];
const medianMs: Record<string, number> = {};
for (const workload of workloads) {
  const run = () => {
    for (let iteration = 0; iteration < workload.iterations; iteration++) {
      const body = { system: workload.text };
      const result = rewriteSystemPrompt(body, workload.config);
      assert.equal(result.matches, workload.matches);
      if (workload.matches === 0) assert.equal(body.system, workload.text);
      else if (workload.name === "matchedLines") assert.equal(body.system, ("before\nYou are ZCode model working in Claude Code.\nafter\n").repeat(1000));
      else if (workload.name === "denseMixedLiteralDeletes") assert.equal(body.system, "y".repeat(128 * 1024));
      else assert.equal("system" in body, false);
    }
  };
  run();
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  medianMs[workload.name] = Number(samples[2].toFixed(3));
}
console.log(JSON.stringify({ runtime: Bun.version, medianMs }, null, 2));
