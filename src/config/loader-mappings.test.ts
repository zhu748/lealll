/**
 * Tests for config loader's modelMappings parsing.
 */
import { describe, it, expect } from "bun:test";
import { loadConfig } from "./loader.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function writeTempConfig(content: string): string {
  const path = join(tmpdir(), `zcode-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("config loader: modelMappings", () => {
  it("parses modelMappings array from YAML", () => {
    const path = writeTempConfig(`
server:
  port: 8080
auth:
  mode: apikey
  apiKey: "test.key"
provider: zai
defaultModel: glm-4.6
modelMappings:
  - from: gpt-5.5
    to: glm-5.2
    note: Codex CLI default
  - from: Claude-Sonnet-4
    to: glm-4.7
`);
    try {
      const config = loadConfig(path);
      expect(config.modelMappings).toHaveLength(2);
      // `from` should be lowercased for case-insensitive lookup
      expect(config.modelMappings![0]).toEqual({
        from: "gpt-5.5",
        to: "glm-5.2",
        note: "Codex CLI default",
      });
      expect(config.modelMappings![1]).toEqual({
        from: "claude-sonnet-4",
        to: "glm-4.7",
        note: undefined,
      });
    } finally {
      unlinkSync(path);
    }
  });

  it("returns empty array when modelMappings is absent", () => {
    const path = writeTempConfig(`
server:
  port: 8080
auth:
  mode: apikey
  apiKey: "test.key"
provider: zai
defaultModel: glm-4.6
`);
    try {
      const config = loadConfig(path);
      expect(config.modelMappings).toEqual([]);
    } finally {
      unlinkSync(path);
    }
  });

  it("skips invalid entries (missing from or to)", () => {
    const path = writeTempConfig(`
server:
  port: 8080
auth:
  mode: apikey
  apiKey: "test.key"
provider: zai
defaultModel: glm-4.6
modelMappings:
  - from: gpt-5.5
    to: glm-5.2
  - from: ""
    to: glm-4.6
  - from: claude
    to: ""
  - not_a_mapping: true
`);
    try {
      const config = loadConfig(path);
      expect(config.modelMappings).toHaveLength(1);
      expect(config.modelMappings![0].from).toBe("gpt-5.5");
    } finally {
      unlinkSync(path);
    }
  });
});
