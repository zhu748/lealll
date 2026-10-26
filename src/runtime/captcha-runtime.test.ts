import { describe, expect, it } from "bun:test";
import { createCaptchaRuntime, type CaptchaPoolRuntime } from "./captcha-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("captcha runtime ownership", () => {
  it("does not load a service until started and discards a load completed after stop", async () => {
    const loaded = deferred<CaptchaPoolRuntime>();
    const entered = deferred<void>();
    let loads = 0, starts = 0, stops = 0;
    const runtime = createCaptchaRuntime(() => { loads++; entered.resolve(); return loaded.promise; });
    expect(loads).toBe(0);
    const pending = runtime.start("v1");
    await entered.promise;
    runtime.stop();
    loaded.resolve({ startCaptchaPool: async () => { starts++; }, shutdownCaptcha() { stops++; } });
    await pending;
    expect(starts).toBe(0);
    expect(stops).toBe(0);
  });

  it("stops immediately and cleans up work created by a late startup continuation", async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    let running = false, stops = 0;
    const runtime = createCaptchaRuntime(async () => ({
      async startCaptchaPool() { entered.resolve(); await finish.promise; running = true; },
      shutdownCaptcha() { running = false; stops++; },
    }));
    const pending = runtime.start("v1");
    await entered.promise;
    runtime.stop();
    expect(stops).toBe(1);
    finish.resolve();
    await pending;
    expect(running).toBe(false);
    expect(stops).toBe(2);
  });

  it("finishes old cleanup before starting a replacement pool", async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const events: string[] = [];
    const service: CaptchaPoolRuntime = {
      async startCaptchaPool(version) {
        events.push("start " + version);
        if (version === "old") { entered.resolve(); await finish.promise; }
      },
      shutdownCaptcha() { events.push("stop"); },
    };
    const runtime = createCaptchaRuntime(async () => service);
    const first = runtime.start("old");
    await entered.promise;
    runtime.stop();
    const second = runtime.start("new");
    finish.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["start old", "stop", "stop", "start new"]);
    runtime.stop();
    expect(events[events.length - 1]).toBe("stop");
  });

  it("cleans up a failed startup and keeps the queue usable", async () => {
    let attempts = 0, stops = 0;
    const runtime = createCaptchaRuntime(async () => ({
      async startCaptchaPool() { if (++attempts === 1) throw new Error("startup failed"); },
      shutdownCaptcha() { stops++; },
    }));
    await expect(runtime.start("v1")).rejects.toThrow("startup failed");
    await runtime.start("v2");
    expect(attempts).toBe(2);
    expect(stops).toBe(1);
    runtime.stop(); runtime.stop();
    expect(stops).toBe(2);
  });

  it("rejects a current load failure and ignores a stopped load's late failure", async () => {
    const first = createCaptchaRuntime(async () => { throw new Error("load failed"); });
    await expect(first.start("v1")).rejects.toThrow("load failed");
    const load = deferred<CaptchaPoolRuntime>();
    const entered = deferred<void>();
    const second = createCaptchaRuntime(() => { entered.resolve(); return load.promise; });
    const pending = second.start("v2");
    await entered.promise;
    second.stop();
    load.reject(new Error("obsolete failure"));
    await pending;
  });

  it("coalesces starts still queued before loading and keeps shutdown errors contained", async () => {
    const versions: string[] = [];
    const runtime = createCaptchaRuntime(async () => ({
      async startCaptchaPool(version) { versions.push(version); },
      shutdownCaptcha() { throw new Error("already closed"); },
    }));
    await Promise.all([runtime.start("old"), runtime.start("latest")]);
    expect(versions).toEqual(["latest"]);
    expect(() => runtime.stop()).not.toThrow();
  });

  it("disposes the previous active service before replacing it", async () => {
    const events: string[] = [];
    let nextId = 0;
    const runtime = createCaptchaRuntime(async () => {
      const id = ++nextId;
      return {
        async startCaptchaPool() { events.push("start " + id); },
        shutdownCaptcha() { events.push("stop " + id); },
      };
    });
    await runtime.start("v1");
    await runtime.start("v2");
    runtime.stop();
    expect(events).toEqual(["start 1", "stop 1", "start 2", "stop 2"]);
  });
});
