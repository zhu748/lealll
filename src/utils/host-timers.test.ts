/**
 * host-timers quarantine unit tests (v0.3.7.1).
 *
 * Locks in the descriptor-based resolution rule that makes host code immune
 * to the captcha solver's globalThis window alias while keeping the test
 * suite's `globalThis.setTimeout = wrapper` interception pattern working:
 *
 *   - ACCESSOR descriptor on a timer name (the only shape
 *     installGlobalWindowAlias installs) ⇒ quarantined NATIVE binding.
 *   - DATA descriptor (Bun's native timers, and test stubs via plain
 *     assignment) ⇒ the CURRENT global value.
 */
import { describe, expect, it } from "bun:test";
import {
  hostClearInterval,
  hostClearTimeout,
  hostSetInterval,
  hostSetTimeout,
  hostSleep,
  _nativeTimerBindingsForTesting,
} from "./host-timers.js";

type AnyFn = (...args: never[]) => unknown;

function withAccessorGlobal(name: string, getter: () => unknown, fn: () => Promise<void>): Promise<void> {
  const desc = Object.getOwnPropertyDescriptor(globalThis, name)!;
  Object.defineProperty(globalThis, name, { get: getter, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(globalThis, name, desc);
  });
}

function withDataGlobal(name: string, value: unknown, fn: () => Promise<void>): Promise<void> {
  const desc = Object.getOwnPropertyDescriptor(globalThis, name)!;
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
  return fn().finally(() => {
    Object.defineProperty(globalThis, name, desc);
  });
}

describe("host-timers quarantine (v0.3.7.1 — 429-retry permanent hang)", () => {
  it("captured native bindings are real functions distinct from any later global mutation", () => {
    const nat = _nativeTimerBindingsForTesting();
    expect(typeof nat.setTimeout).toBe("function");
    expect(typeof nat.setInterval).toBe("function");
    expect(typeof nat.clearTimeout).toBe("function");
    expect(typeof nat.clearInterval).toBe("function");
    // The capture must not be an accessor-based wrapper — it is the direct
    // native reference captured at module load.
    expect(nat.setTimeout).not.toHaveProperty("__capWindowFor");
  });

  it("hostSetTimeout bypasses accessor-shadowed globals (the captcha alias shape) and still fires", async () => {
    let getterInvoked = false;
    let poisonCalled = false;
    await withAccessorGlobal("setTimeout", () => {
      getterInvoked = true;
      return () => {
        poisonCalled = true;
      };
    }, async () => {
      let fired = false;
      hostSetTimeout(() => {
        fired = true;
      }, 20);
      // Hermetic synchronous snapshot: hostSetTimeout has ALREADY returned,
      // so if it had resolved through the accessor, the getter would have
      // been EVALUATED and the poison function CALLED by now — both happen
      // synchronously at registration time. Asserting BEFORE any await keeps
      // this immune to unrelated timer activity elsewhere in the shared
      // bun-test process (leftover self-re-arming timers from earlier test
      // files — exactly what made this test flake on CI's slower runners:
      // a stray call inside the 120ms observation window tripped the poison
      // even though hostSetTimeout itself never touched the accessor).
      expect(poisonCalled).toBe(false);
      expect(getterInvoked).toBe(false);
      // Observation window on the native timer: the registered callback must
      // actually fire on the NATIVE registry.
      await new Promise((r) => _nativeTimerBindingsForTesting().setTimeout(r as never, 120) as never);
      expect(fired).toBe(true);
    });
  });

  it("hostSleep resolves while the global setTimeout is accessor-shadowed", async () => {
    let hung = true;
    await withAccessorGlobal("setTimeout", () => () => {}, async () => {
      const outcome = await Promise.race([
        hostSleep(30).then(() => "resolved"),
        new Promise((r) => _nativeTimerBindingsForTesting().setTimeout(() => r("HUNG"), 500) as never),
      ]);
      expect(outcome).toBe("resolved");
      hung = false;
    });
    expect(hung).toBe(false);
  });

  it("hostSetInterval bypasses accessor-shadowed globals", async () => {
    let ticks = 0;
    await withAccessorGlobal("setInterval", () => () => 0, async () => {
      const id = hostSetInterval(() => {
        ticks += 1;
      }, 20) as unknown as Parameters<typeof clearInterval>[0];
      await new Promise((r) => _nativeTimerBindingsForTesting().setTimeout(() => r(undefined), 120) as never);
      hostClearInterval(id);
      expect(ticks).toBeGreaterThan(0);
    });
  });

  it("hostClearTimeout accepts the id shape hostSetTimeout returns", () => {
    const id = hostSetTimeout(() => {}, 10_000);
    hostClearTimeout(id as Parameters<typeof hostClearTimeout>[0]);
    // Reaching here without throwing is the contract.
  });

  it("data-property globals are used as-is (native identity when untouched)", () => {
    const nat = _nativeTimerBindingsForTesting();
    const desc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
    expect(desc.get).toBeUndefined(); // native: data property
    expect(desc.writable).toBe(true);
    // Identity: with no stub and no alias, hostSetTimeout delegates to the
    // same native function the runtime exposes.
    expect((globalThis as Record<string, unknown>)["setTimeout"]).toBe(nat.setTimeout);
  });

  it("data-property test stubs remain interceptable (existing test-suite pattern)", async () => {
    const nat = _nativeTimerBindingsForTesting();
    let stubbed = false;
    await withDataGlobal("setTimeout", ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      stubbed = true;
      return (nat.setTimeout as AnyFn)(fn as never, ms as never, ...rest as never[]);
    }) as unknown, async () => {
      let fired = false;
      hostSetTimeout(() => {
        fired = true;
      }, 20);
      await new Promise((r) => (nat.setTimeout as AnyFn)(r as never, 120 as never) as never);
      expect(stubbed).toBe(true);
      expect(fired).toBe(true);
    });
  });

  it("non-function data globals fall back to the captured native binding", async () => {
    let fired = false;
    // Install the pathological global ONLY around the synchronous
    // hostSetTimeout call: if it stayed installed during the await window,
    // any unrelated timer call elsewhere in the shared test process would
    // crash on `setTimeout is not a function` (same shared-process hazard
    // the first test guards against).
    const desc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
    Object.defineProperty(globalThis, "setTimeout", { value: "not-a-function", writable: true, configurable: true, enumerable: true });
    try {
      hostSetTimeout(() => {
        fired = true;
      }, 20);
    } finally {
      Object.defineProperty(globalThis, "setTimeout", desc);
    }
    // Global restored — the wait is safe for third-party timer callers. The
    // callback must have been registered on the NATIVE registry.
    await new Promise((r) => _nativeTimerBindingsForTesting().setTimeout(r as never, 120) as never);
    expect(fired).toBe(true);
  });
});
