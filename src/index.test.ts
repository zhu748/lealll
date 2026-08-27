import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureConfigFile, parseServeConfigArg, runShutdownCleanup, shouldAppendConsoleLog } from "./index.js";

describe("CLI entry helpers", () => {
  it("parses serve config arguments without treating --config as a path", () => {
    expect(parseServeConfigArg(["--config", "custom.yaml"])).toBe("custom.yaml");
    expect(parseServeConfigArg(["--config=custom.yaml"])).toBe("custom.yaml");
    expect(parseServeConfigArg(["--verbose", "positional.yaml"])).toBe("positional.yaml");
    expect(parseServeConfigArg(["--verbose"])).toBeUndefined();
  });

  it("creates a missing config file in a nested directory without overwriting existing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-proxy-index-"));
    try {
      const path = join(dir, "nested", "config.yaml");
      expect(await ensureConfigFile(path)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toContain("provider: zai");

      writeFileSync(path, "provider: bigmodel\n", "utf-8");
      expect(await ensureConfigFile(path)).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe("provider: bigmodel\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evaluates console log filtering against the current config level", () => {
    expect(shouldAppendConsoleLog("error", 1)).toBe(false);
    expect(shouldAppendConsoleLog("error", 3)).toBe(true);
    expect(shouldAppendConsoleLog("debug", 0)).toBe(true);
    expect(shouldAppendConsoleLog("unknown", 1)).toBe(true);
  });

  it("runs captcha shutdown and log flush even when server stop rejects", async () => {
    const calls: string[] = [];
    const errors: string[] = [];

    await runShutdownCleanup(
      {
        stopServer: async () => {
          calls.push("stop");
          throw new Error("stop failed");
        },
        shutdownCaptchaHelper: async () => {
          calls.push("captcha");
        },
        flushLogs: async () => {
          calls.push("logs");
        },
      },
      (message, err) => {
        errors.push(`${message} ${(err as Error).message}`);
      },
    );

    expect(calls).toEqual(["stop", "captcha", "logs"]);
    expect(errors).toEqual(["[shutdown] server.stop() rejected: stop failed"]);
  });

  it("continues shutdown cleanup after synchronous task failures", async () => {
    const calls: string[] = [];
    const errors: string[] = [];

    await runShutdownCleanup(
      {
        stopServer: () => {
          calls.push("stop");
        },
        shutdownCaptchaHelper: () => {
          calls.push("captcha");
          throw new Error("captcha close failed");
        },
        flushLogs: () => {
          calls.push("logs");
        },
      },
      (message, err) => {
        errors.push(`${message} ${(err as Error).message}`);
      },
    );

    expect(calls).toEqual(["stop", "captcha", "logs"]);
    expect(errors).toEqual(["[shutdown] captcha helper shutdown failed: captcha close failed"]);
  });
});
