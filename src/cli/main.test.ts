import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "./main.js";
import { VERSION } from "../version.js";

describe("lightweight CLI commands", () => {
  const originalLog = console.log;
  const originalConfig = process.env.ZCODE_PROXY_CONFIG;
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete process.env.ZCODE_PROXY_CONFIG;
    else process.env.ZCODE_PROXY_CONFIG = originalConfig;
  });

  it.each([
    { args: ["--version"] }, { args: ["version"] }, { args: ["-v"] }, { args: ["--cli", "--version"] },
  ])(
    "prints version without reading config or initializing a transport (%j)",
    async ({ args }) => {
      const lines: unknown[][] = [];
      console.log = (...values: unknown[]) => { lines.push(values); };
      process.env.ZCODE_PROXY_CONFIG = "/nonexistent-config-for-version/config.yaml";
      const transport = (() => { throw new Error("version must not fetch"); }) as unknown as typeof fetch;
      globalThis.fetch = transport;
      await runCli([...args]);
      expect(lines).toEqual([[`zcode-proxy ${VERSION}`]]);
      expect(globalThis.fetch).toBe(transport);
    },
  );

  it("prints help without starting a runtime", async () => {
    const lines: unknown[][] = [];
    console.log = (...values: unknown[]) => { lines.push(values); };
    process.env.ZCODE_PROXY_CONFIG = "/nonexistent-config-for-help/config.yaml";
    await runCli(["--help"]);
    expect(lines.length).toBe(1);
    expect(lines[0]![0]).toContain("Usage:");
    expect(lines[0]![0]).toContain("--cli");
  });
});
