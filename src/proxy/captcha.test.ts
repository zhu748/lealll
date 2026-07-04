import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _captchaConfigCacheSizeForTesting,
  _clearCaptchaConfigCacheForTesting,
  _closeChromeSessionForTesting,
  _cleanupChromeSessionAfterUnexpectedCloseForTesting,
  _enqueueChromeSessionSolveForTesting,
  buildCaptchaConfigUrl,
  buildChromeDebugPortCandidates,
  extractAliyunCaptchaVerifyParam,
  getCaptchaToken,
  isAliyunCaptchaDeferredInteractive,
  isAliyunCaptchaTerminalPass,
  resolveCaptchaLanguage,
  resolveCaptchaRetryCount,
  resolveCaptchaTimeoutMs,
  resolveChromeIdleTimeoutMs,
  resolveChromeKeepAliveEnabled,
  resolveChromeStopGraceMs,
  resolveCaptchaSolverStrategy,
  resolveClientPlatformKey,
} from "./captcha.js";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("Aliyun captcha SDK result parsing", () => {
  it("extracts verify params from official lower-case and upper-case fields", () => {
    expect(extractAliyunCaptchaVerifyParam({ captchaVerifyParam: "  lower-token  " })).toBe("lower-token");
    expect(extractAliyunCaptchaVerifyParam({ CaptchaVerifyParam: "  upper-token  " })).toBe("upper-token");
    expect(extractAliyunCaptchaVerifyParam({ captchaVerifyParam: "   " })).toBeUndefined();
    expect(extractAliyunCaptchaVerifyParam("not-object")).toBeUndefined();
  });

  it("recognizes terminal pass states used by the official client", () => {
    expect(isAliyunCaptchaTerminalPass({ success: true, verifyResult: true })).toBe(true);
    expect(isAliyunCaptchaTerminalPass({ verifyCode: "T006" })).toBe(true);
    expect(isAliyunCaptchaTerminalPass({ VerifyCode: "T006" })).toBe(true);
    expect(isAliyunCaptchaTerminalPass({ success: true, verifyResult: false })).toBe(false);
  });

  it("detects deferred interactive states only when no verify param is available", () => {
    expect(isAliyunCaptchaDeferredInteractive({ success: true, verifyResult: false })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ success: true, verifyResult: true })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ success: true, verifyResult: true, captchaVerifyParam: "token" })).toBe(false);
    expect(isAliyunCaptchaDeferredInteractive({ VerifyCode: "T006" })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ VerifyCode: "T006", CaptchaVerifyParam: "token" })).toBe(false);
  });

  it("keeps the existing F001 interactive fallback classification", () => {
    expect(isAliyunCaptchaDeferredInteractive({ verifyCode: "F001" })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ code: "F001" })).toBe(true);
  });
});

describe("captcha solver strategy", () => {
  it("normalizes unsupported values to auto", () => {
    expect(resolveCaptchaSolverStrategy(undefined)).toBe("auto");
    expect(resolveCaptchaSolverStrategy("")).toBe("auto");
    expect(resolveCaptchaSolverStrategy("bogus")).toBe("auto");
  });

  it("accepts chrome and jsdom case-insensitively", () => {
    expect(resolveCaptchaSolverStrategy("chrome")).toBe("chrome");
    expect(resolveCaptchaSolverStrategy(" CHROME ")).toBe("chrome");
    expect(resolveCaptchaSolverStrategy("jsdom")).toBe("jsdom");
    expect(resolveCaptchaSolverStrategy(" JSDOM ")).toBe("jsdom");
  });
});

describe("Chrome captcha helper configuration", () => {
  it("keeps Chrome CDP helper enabled by default", () => {
    expect(resolveChromeKeepAliveEnabled(undefined)).toBe(true);
    expect(resolveChromeKeepAliveEnabled("")).toBe(true);
    expect(resolveChromeKeepAliveEnabled("1")).toBe(true);
    expect(resolveChromeKeepAliveEnabled("true")).toBe(true);
  });

  it("accepts explicit keepalive opt-out values", () => {
    expect(resolveChromeKeepAliveEnabled("0")).toBe(false);
    expect(resolveChromeKeepAliveEnabled("false")).toBe(false);
    expect(resolveChromeKeepAliveEnabled("OFF")).toBe(false);
    expect(resolveChromeKeepAliveEnabled(" never ")).toBe(false);
  });

  it("normalizes Chrome idle timeout values", () => {
    expect(resolveChromeIdleTimeoutMs(undefined)).toBe(600000);
    expect(resolveChromeIdleTimeoutMs("1234")).toBe(1234);
    expect(resolveChromeIdleTimeoutMs("0")).toBe(0);
    expect(resolveChromeIdleTimeoutMs("1.5")).toBe(600000);
    expect(resolveChromeIdleTimeoutMs("100ms")).toBe(600000);
    expect(resolveChromeIdleTimeoutMs("-1")).toBe(600000);
    expect(resolveChromeIdleTimeoutMs("NaN")).toBe(600000);
    expect(resolveChromeIdleTimeoutMs("2147483648")).toBe(2_147_483_647);
    expect(resolveChromeIdleTimeoutMs("999999999999999999999")).toBe(600000);
  });

  it("normalizes Chrome manual stop grace values", () => {
    expect(resolveChromeStopGraceMs(undefined)).toBe(2000);
    expect(resolveChromeStopGraceMs("")).toBe(2000);
    expect(resolveChromeStopGraceMs("0")).toBe(0);
    expect(resolveChromeStopGraceMs("1500")).toBe(1500);
    expect(resolveChromeStopGraceMs("1.5")).toBe(2000);
    expect(resolveChromeStopGraceMs("-1")).toBe(2000);
    expect(resolveChromeStopGraceMs("2147483648")).toBe(2_147_483_647);
  });

  it("strictly normalizes captcha retry and timeout env values", () => {
    expect(resolveCaptchaRetryCount(undefined)).toBe(3);
    expect(resolveCaptchaRetryCount("4")).toBe(4);
    expect(resolveCaptchaRetryCount(" 5 ")).toBe(5);
    expect(resolveCaptchaRetryCount("1abc")).toBe(3);
    expect(resolveCaptchaRetryCount("0")).toBe(3);
    expect(resolveCaptchaRetryCount("-1")).toBe(3);
    expect(resolveCaptchaRetryCount("101")).toBe(100);

    expect(resolveCaptchaTimeoutMs(undefined, 40_000)).toBe(40_000);
    expect(resolveCaptchaTimeoutMs("120000", 40_000)).toBe(120_000);
    expect(resolveCaptchaTimeoutMs("100ms", 40_000)).toBe(40_000);
    expect(resolveCaptchaTimeoutMs("0", 40_000)).toBe(40_000);
    expect(resolveCaptchaTimeoutMs("-1", 40_000)).toBe(40_000);
    expect(resolveCaptchaTimeoutMs("999999999999999999999", 40_000)).toBe(40_000);
    expect(resolveCaptchaTimeoutMs("2147483648", 40_000)).toBe(2_147_483_647);
    expect(resolveCaptchaTimeoutMs("10", Number.NaN)).toBe(10);
    expect(resolveCaptchaTimeoutMs(undefined, Number.NaN)).toBe(1);
  });

  it("uses an explicit Chrome debug port when configured", () => {
    expect(buildChromeDebugPortCandidates({ fixedPort: "9444" })).toEqual([9444]);
    expect(buildChromeDebugPortCandidates({ fixedPort: "0", base: "9500", span: "4", attempts: "3", randomSeed: 0 })).toEqual([9500, 9501, 9502]);
  });

  it("wraps Chrome debug port candidates inside the configured span", () => {
    expect(buildChromeDebugPortCandidates({ base: "9500", span: "4", attempts: "4", randomSeed: 0.75 })).toEqual([9503, 9500, 9501, 9502]);
  });

  it("waits for an active solve before closing the helper session", async () => {
    let resolveSolve!: () => void;
    const activeSolve = new Promise<void>(resolve => { resolveSolve = resolve; });
    let wsClosed = false;
    let procKilled = false;
    let hostStopped = false;
    const session = {
      activeSolve,
      closing: false,
      closePromise: null,
      closed: false,
      idleTimer: null,
      idleDeadline: Date.now() + 1000,
      rejectPendingCommands: null,
      ws: { close: () => { wsClosed = true; } },
      proc: { kill: () => { procKilled = true; } },
      hostServer: { stop: () => { hostStopped = true; } },
      ephemeral: false,
    } as any;

    const closePromise = _closeChromeSessionForTesting(session, "per-solve complete", 1000);
    await delay(20);

    expect(wsClosed).toBe(false);
    expect(procKilled).toBe(false);
    expect(hostStopped).toBe(false);

    resolveSolve();
    await closePromise;

    expect(session.closed).toBe(true);
    expect(wsClosed).toBe(true);
    expect(procKilled).toBe(true);
    expect(hostStopped).toBe(true);
    expect(session.ws).toBeNull();
    expect(session.proc).toBeNull();
    expect(session.hostServer).toBeNull();
    expect(session.rejectPendingCommands).toBeNull();
  });

  it("marks a helper session as closing immediately while waiting for an active solve", async () => {
    let resolveSolve!: () => void;
    const activeSolve = new Promise<void>(resolve => { resolveSolve = resolve; });
    const session = {
      activeSolve,
      closing: false,
      closePromise: null,
      closed: false,
      idleTimer: null,
      idleDeadline: null,
      rejectPendingCommands: null,
      ws: { close: () => {} },
      proc: { kill: () => {} },
      hostServer: { stop: () => {} },
      ephemeral: false,
    } as any;

    const closePromise = _closeChromeSessionForTesting(session, "per-solve complete", 1000);
    expect(session.closing).toBe(true);
    expect(session.closed).toBe(false);

    resolveSolve();
    await closePromise;

    expect(session.closed).toBe(true);
  });

  it("cleans up the helper session after the active-solve close wait expires", async () => {
    const activeSolve = new Promise<void>(() => {});
    let wsClosed = false;
    let procKilled = false;
    let hostStopped = false;
    let rejectedMessage = "";
    const session = {
      activeSolve,
      closing: false,
      closePromise: null,
      closed: false,
      idleTimer: null,
      idleDeadline: null,
      rejectPendingCommands: (err: Error) => { rejectedMessage = err.message; },
      ws: { close: () => { wsClosed = true; } },
      proc: { kill: () => { procKilled = true; } },
      hostServer: { stop: () => { hostStopped = true; } },
      ephemeral: false,
    } as any;

    const started = Date.now();
    await _closeChromeSessionForTesting(session, "manual stop", 20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(session.closed).toBe(true);
    expect(rejectedMessage).toContain("manual stop");
    expect(wsClosed).toBe(true);
    expect(procKilled).toBe(true);
    expect(hostStopped).toBe(true);
  });

  it("clears the active-solve close wait timer when the solve finishes first", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let trackedTimer: ReturnType<typeof setTimeout> | null = null;
    let trackedTimerCleared = false;
    (globalThis as any).setTimeout = (handler: any, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler as any, timeout as any, ...args as any);
      if (timeout === 1234) trackedTimer = timer;
      return timer;
    };
    (globalThis as any).clearTimeout = (timer?: ReturnType<typeof setTimeout>) => {
      if (timer && timer === trackedTimer) trackedTimerCleared = true;
      return originalClearTimeout(timer as any);
    };

    try {
      const session = {
        activeSolve: Promise.resolve(),
        closing: false,
        closePromise: null,
        closed: false,
        idleTimer: null,
        idleDeadline: null,
        rejectPendingCommands: null,
        ws: { close: () => {} },
        proc: { kill: () => {} },
        hostServer: { stop: () => {} },
        ephemeral: false,
      } as any;

      await _closeChromeSessionForTesting(session, "per-solve complete", 1234);

      expect(trackedTimer).not.toBeNull();
      expect(trackedTimerCleared).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it("rejects pending CDP commands when closing the helper session", async () => {
    let rejectedMessage = "";
    const session = {
      activeSolve: null,
      closing: false,
      closePromise: null,
      closed: false,
      idleTimer: null,
      idleDeadline: null,
      rejectPendingCommands: (err: Error) => { rejectedMessage = err.message; },
      ws: { close: () => {} },
      proc: { kill: () => {} },
      hostServer: { stop: () => {} },
      ephemeral: false,
    } as any;

    await _closeChromeSessionForTesting(session, "manual stop", 1000);

    expect(rejectedMessage).toContain("manual stop");
    expect(session.rejectPendingCommands).toBeNull();
  });

  it("cleans local resources when Chrome exits unexpectedly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "zcode-captcha-profile-"));
    writeFileSync(join(tempDir, "marker"), "x", "utf8");
    const idleTimer = setTimeout(() => {}, 10_000);
    idleTimer.unref?.();
    let wsClosed = false;
    let procKilled = false;
    let hostStopped = false;
    let rejectedMessage = "";
    const session = {
      activeSolve: null,
      closing: false,
      closePromise: null,
      closed: false,
      idleTimer,
      idleDeadline: Date.now() + 10_000,
      rejectPendingCommands: (err: Error) => { rejectedMessage = err.message; },
      ws: { close: () => { wsClosed = true; } },
      proc: { kill: () => { procKilled = true; } },
      hostServer: { stop: () => { hostStopped = true; } },
      ephemeral: true,
      userDataDir: tempDir,
      lastError: null,
    } as any;

    try {
      _cleanupChromeSessionAfterUnexpectedCloseForTesting(session, "Chrome process exited");

      expect(session.closed).toBe(true);
      expect(session.idleTimer).toBeNull();
      expect(session.idleDeadline).toBeNull();
      expect(rejectedMessage).toBe("Chrome process exited");
      expect(wsClosed).toBe(true);
      expect(procKilled).toBe(false);
      expect(hostStopped).toBe(true);
      expect(session.ws).toBeNull();
      expect(session.proc).toBeNull();
      expect(session.hostServer).toBeNull();
      expect(session.lastError).toBe("Chrome process exited");
      expect(existsSync(tempDir)).toBe(false);
    } finally {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves normal close cleanup in control when Chrome exits during close", () => {
    const idleTimer = setTimeout(() => {}, 10_000);
    idleTimer.unref?.();
    let wsClosed = false;
    let procKilled = false;
    let hostStopped = false;
    let rejectedMessage = "";
    const session = {
      activeSolve: null,
      closing: true,
      closePromise: Promise.resolve(),
      closed: false,
      idleTimer,
      idleDeadline: Date.now() + 10_000,
      rejectPendingCommands: (err: Error) => { rejectedMessage = err.message; },
      ws: { close: () => { wsClosed = true; } },
      proc: { kill: () => { procKilled = true; } },
      hostServer: { stop: () => { hostStopped = true; } },
      ephemeral: false,
      lastError: "manual close",
    } as any;

    try {
      _cleanupChromeSessionAfterUnexpectedCloseForTesting(session, "Chrome process exited");

      expect(session.closed).toBe(true);
      expect(session.idleTimer).toBeNull();
      expect(session.idleDeadline).toBeNull();
      expect(rejectedMessage).toBe("Chrome process exited");
      expect(wsClosed).toBe(false);
      expect(procKilled).toBe(false);
      expect(hostStopped).toBe(false);
      expect(session.lastError).toBe("manual close");
    } finally {
      if (session.idleTimer) clearTimeout(session.idleTimer);
    }
  });

  it("serializes concurrent solve work on one Chrome helper session", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const events: string[] = [];
    const session = {
      solveQueue: Promise.resolve(),
      closed: false,
      closing: false,
    } as any;

    const first = _enqueueChromeSessionSolveForTesting(session, async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return "first";
    });
    await delay(0);

    const second = _enqueueChromeSessionSolveForTesting(session, async () => {
      events.push("second-start");
      events.push("second-end");
      return "second";
    });
    await delay(20);

    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("rejects queued solve work if the Chrome helper closes before it starts", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const session = {
      solveQueue: Promise.resolve(),
      closed: false,
      closing: false,
    } as any;

    const first = _enqueueChromeSessionSolveForTesting(session, async () => {
      await firstGate;
      return "first";
    });
    await delay(0);

    const second = _enqueueChromeSessionSolveForTesting(session, async () => "second");
    const secondResult = second.then(
      value => ({ ok: true as const, value }),
      err => ({ ok: false as const, message: (err as Error).message }),
    );
    session.closing = true;
    releaseFirst();

    await expect(first).resolves.toBe("first");
    expect(await secondResult).toEqual({ ok: false, message: "Chrome CDP session is closed" });
  });

  it("cleans host server and ephemeral profile if Chrome spawn fails during startup", async () => {
    const originalSpawn = Bun.spawn;
    const originalServe = Bun.serve;
    const originalFetch = globalThis.fetch;
    const originalChromePath = process.env.ZCODE_CAPTCHA_CHROME_PATH;
    const originalEphemeral = process.env.ZCODE_CAPTCHA_CHROME_EPHEMERAL;
    const originalPortAttempts = process.env.ZCODE_CAPTCHA_CHROME_PORT_ATTEMPTS;
    let stopped = false;
    let userDataDir = "";
    _clearCaptchaConfigCacheForTesting();

    (Bun as any).serve = () => ({
      port: 19300,
      stop: () => { stopped = true; },
    });
    (Bun as any).spawn = (args: string[]) => {
      const arg = args.find(a => a.startsWith("--user-data-dir="));
      userDataDir = arg?.slice("--user-data-dir=".length) ?? "";
      throw new Error("spawn failed for test");
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        configs: {
          captcha: {
            enabled: true,
            prefix: "test-prefix",
            sceneId: "test-scene",
            region: "cn-shanghai",
          },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    process.env.ZCODE_CAPTCHA_CHROME_PATH = join(process.cwd(), "package.json");
    process.env.ZCODE_CAPTCHA_CHROME_EPHEMERAL = "1";
    process.env.ZCODE_CAPTCHA_CHROME_PORT_ATTEMPTS = "1";

    try {
      await expect(getCaptchaToken("chrome-spawn-fail", { solver: "chrome" }))
        .rejects.toThrow(/spawn failed for test/);
      expect(stopped).toBe(true);
      expect(userDataDir).not.toBe("");
      expect(existsSync(userDataDir)).toBe(false);
    } finally {
      _clearCaptchaConfigCacheForTesting();
      (Bun as any).spawn = originalSpawn;
      (Bun as any).serve = originalServe;
      globalThis.fetch = originalFetch;
      if (originalChromePath === undefined) delete process.env.ZCODE_CAPTCHA_CHROME_PATH;
      else process.env.ZCODE_CAPTCHA_CHROME_PATH = originalChromePath;
      if (originalEphemeral === undefined) delete process.env.ZCODE_CAPTCHA_CHROME_EPHEMERAL;
      else process.env.ZCODE_CAPTCHA_CHROME_EPHEMERAL = originalEphemeral;
      if (originalPortAttempts === undefined) delete process.env.ZCODE_CAPTCHA_CHROME_PORT_ATTEMPTS;
      else process.env.ZCODE_CAPTCHA_CHROME_PORT_ATTEMPTS = originalPortAttempts;
      if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

describe("ZCode captcha client config alignment", () => {
  it("builds the official client configs query with app version and platform", () => {
    const url = new URL(buildCaptchaConfigUrl({ appVersion: "3.2.0", platform: "linux-x64" }));
    expect(url.origin + url.pathname).toBe("https://zcode.z.ai/api/v1/client/configs");
    expect(url.searchParams.get("app_version")).toBe("3.2.0");
    expect(url.searchParams.get("platform")).toBe("linux-x64");
  });

  it("defaults client config platform to process.platform-process.arch", () => {
    expect(resolveClientPlatformKey()).toBe(`${process.platform}-${process.arch}`);
    const url = new URL(buildCaptchaConfigUrl());
    expect(url.searchParams.get("app_version")).toBe("3.2.5");
    expect(url.searchParams.get("platform")).toBe(resolveClientPlatformKey());
  });

  it("normalizes official captcha language values", () => {
    expect(resolveCaptchaLanguage("cn")).toBe("cn");
    expect(resolveCaptchaLanguage("zh-CN")).toBe("cn");
    expect(resolveCaptchaLanguage("en-US")).toBe("en");
    expect(resolveCaptchaLanguage("unknown")).toMatch(/^(cn|en)$/);
  });

  it("rejects oversized captcha config responses before solving", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let canceled = false;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          canceled = true;
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(256 * 1024 + 1),
        },
      });
    }) as unknown as typeof fetch;
    try {
      await expect(getCaptchaToken("captcha-test", {
        appVersion: `oversized-${Date.now()}`,
        platform: "test-platform",
        solver: "jsdom",
      })).rejects.toThrow(/captcha_config_fetch_failed: .*byte limit/);
      expect(calls).toBe(1);
      expect(canceled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("times out when the captcha config response body stalls after headers", async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout as any;
    let canceled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        canceled = true;
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      return originalSetTimeout(handler, timeout === 15_000 ? 5 : timeout, ...args);
    };
    const keepAlive = setInterval(() => {}, 1);

    try {
      await expect(getCaptchaToken("captcha-test", {
        appVersion: `stalled-${Date.now()}`,
        platform: "test-platform",
        solver: "jsdom",
      })).rejects.toThrow(/captcha_config_fetch_failed: .*read timeout after 15000ms/);
      expect(canceled).toBe(true);
    } finally {
      clearInterval(keepAlive);
      globalThis.fetch = originalFetch;
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("cancels failed captcha config response bodies", async () => {
    const originalFetch = globalThis.fetch;
    let canceled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("failure"));
      },
      cancel() {
        canceled = true;
      },
    }), { status: 500 })) as unknown as typeof fetch;

    try {
      await expect(getCaptchaToken("captcha-test", {
        appVersion: `failed-${Date.now()}`,
        platform: "test-platform",
        solver: "jsdom",
      })).rejects.toThrow(/captcha_config_fetch_failed: captcha config HTTP 500/);
      expect(canceled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("unrefs the captcha config fetch timeout timer", async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout as any;
    const unrefDelays: number[] = [];
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        data: {
          configs: {
            captcha: {
              enabled: false,
              prefix: "",
              sceneId: "",
              region: "cn-shanghai",
            },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args) as any;
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefDelays.push(Number(timeout));
        return originalUnref?.();
      };
      return timer;
    };

    try {
      await expect(getCaptchaToken("captcha-unref-test", {
        appVersion: `unref-${Date.now()}`,
        platform: "test-platform",
        solver: "jsdom",
      })).rejects.toThrow(/captcha_disabled_by_config/);
      expect(unrefDelays).toContain(15_000);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("bounds the captcha config cache when appVersion/platform vary", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    _clearCaptchaConfigCacheForTesting();
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({
        data: {
          configs: {
            captcha: {
              enabled: false,
              prefix: "",
              sceneId: "",
              region: "cn-shanghai",
            },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      for (let i = 0; i < 40; i++) {
        await expect(getCaptchaToken("captcha-cache-test", {
          appVersion: `cache-${i}-${Date.now()}`,
          platform: "test-platform",
          solver: "jsdom",
        })).rejects.toThrow(/captcha_disabled_by_config/);
      }
      expect(calls).toBe(40);
      expect(_captchaConfigCacheSizeForTesting()).toBeLessThanOrEqual(32);
    } finally {
      _clearCaptchaConfigCacheForTesting();
      globalThis.fetch = originalFetch;
    }
  });
});
