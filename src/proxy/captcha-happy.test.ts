// Regression tests for the v0.3.6.0 alias-machinery fixes in captcha-happy.ts.
//
// Background (bugs reported against the v0.3.5.0 Windows exe):
//   1. `print` was listed in HOST_CRITICAL_GLOBALS on the assumption Bun
//      exposes a host print() global — it does not. Under Bun, guest script
//      tags execute in the HOST realm, so FeiLin's bare `print()` references
//      resolved against globalThis and threw "ReferenceError: print is not
//      defined" on every solve (the user saw a wall of [WINDOW-ERROR] spam).
//   2. removeGlobalWindowAlias blindly deleted every aliased name — including
//      host globals happy-dom's window also owns (setTimeout and friends).
//      After the last solve's destroyDom, host-side setTimeout(...) threw
//      "setTimeout is not defined", breaking every server-side timer.
//   3. The __capWindowFor getter leaked (kept the destroyed window alive).
//
// These tests are network-free: they exercise the alias install/remove pair
// with a fake window and the guest-realm patch with a real (offline)
// happy-dom Window.
import { describe, it, expect } from "bun:test";
import {
  installGlobalWindowAlias,
  removeGlobalWindowAlias,
  GUEST_EVAL_PATCH,
} from "./captcha-happy.js";

/** Bare-identifier resolution exactly as guest <script> tags get under Bun
 * (host realm): indirect eval evaluates against globalThis. */
const guestEval = (expr: string): unknown => (0, eval)(expr);

/** Fake polyfilled window mirroring the post-applyPolyfills shape: a
 * non-enumerable print stub (the pre-v0.3.6.0 creation shape), enumerable
 * alert, and host-delegating timers so the test runner keeps working while
 * the alias epoch hijacks globalThis.setTimeout. */
function makeFakeWindow(): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  Object.defineProperty(w, "print", { value: () => {}, configurable: true, writable: true });
  w.alert = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  w.setTimeout = g.setTimeout;
  w.setInterval = g.setInterval;
  w.clearTimeout = g.clearTimeout;
  w.clearInterval = g.clearInterval;
  return w;
}

describe("installGlobalWindowAlias / removeGlobalWindowAlias (v0.3.6.0)", () => {
  it("aliases print for guest scripts when the host does not define it", () => {
    const w = makeFakeWindow();
    installGlobalWindowAlias(globalThis, w);
    try {
      // The exact user-visible bug: FeiLin calls print() via a bare identifier.
      expect(guestEval("typeof print")).toBe("function");
      expect(guestEval("print()")).toBe(undefined);
      // Non-critical window methods keep resolving as before.
      expect(guestEval("typeof alert")).toBe("function");
      expect(guestEval("typeof window")).toBe("object");
      // Host-defined host-critical globals stay unshadowed (no getter).
      const consoleDesc = Object.getOwnPropertyDescriptor(globalThis, "console");
      expect(consoleDesc?.get).toBeUndefined();
    } finally {
      removeGlobalWindowAlias(globalThis, w);
    }
    // Cleanup: the host never defined print, so it must be gone again.
    expect(guestEval("typeof print")).toBe("undefined");
    expect(guestEval("typeof window")).toBe("undefined");
  });

  it("restores host timer globals after the last window is destroyed (no more setTimeout deletion)", () => {
    const w = makeFakeWindow();
    const beforeDesc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
    expect(beforeDesc?.get).toBeUndefined(); // host data property before the epoch

    installGlobalWindowAlias(globalThis, w);
    try {
      const duringDesc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
      expect(typeof duringDesc?.get).toBe("function"); // aliased getter during solves
      expect(typeof setTimeout).toBe("function"); // and still callable
    } finally {
      removeGlobalWindowAlias(globalThis, w);
    }

    // THE regression: the old cleanup DELETED setTimeout here.
    expect(typeof setTimeout).toBe("function");
    expect(typeof setInterval).toBe("function");
    expect(typeof clearTimeout).toBe("function");
    expect(typeof clearInterval).toBe("function");
    const afterDesc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
    expect(afterDesc?.get).toBeUndefined(); // original host data property restored
  });

  it("cleans up the __capWindowFor getter (previously leaked with the destroyed window)", () => {
    const w = makeFakeWindow();
    installGlobalWindowAlias(globalThis, w);
    try {
      expect(guestEval("typeof __capWindowFor")).toBe("object");
    } finally {
      removeGlobalWindowAlias(globalThis, w);
    }
    expect(guestEval("typeof __capWindowFor")).toBe("undefined");
  });

  it("keeps aliases alive until the LAST concurrent window is destroyed, then restores", () => {
    const w1 = makeFakeWindow();
    const w2 = makeFakeWindow();
    installGlobalWindowAlias(globalThis, w1);
    installGlobalWindowAlias(globalThis, w2);
    try {
      expect(guestEval("typeof print")).toBe("function");
      removeGlobalWindowAlias(globalThis, w1);
      // w2 still holds the epoch open — a sibling destroy must not pull the
      // alias out from under the in-flight solve.
      expect(guestEval("typeof print")).toBe("function");
    } finally {
      removeGlobalWindowAlias(globalThis, w2);
    }
    expect(guestEval("typeof print")).toBe("undefined");
    expect(typeof setTimeout).toBe("function");
  });

  it("survives sequential alias epochs (pool refills reuse install/remove cycles)", () => {
    for (let i = 0; i < 3; i++) {
      const w = makeFakeWindow();
      installGlobalWindowAlias(globalThis, w);
      expect(guestEval("typeof print")).toBe("function");
      removeGlobalWindowAlias(globalThis, w);
      expect(guestEval("typeof print")).toBe("undefined");
      expect(typeof setTimeout).toBe("function");
    }
  });
});

describe("GUEST_EVAL_PATCH guest-error collection (v0.3.6.0)", () => {
  it("collects window errors silently instead of console.error spam, bounded at 40", async () => {
    const { GlobalWindow } = await import("happy-dom");
    const w = new GlobalWindow() as unknown as Record<string, unknown>;
    // The patch resolves bare `window` — under Bun that needs the alias live.
    installGlobalWindowAlias(globalThis, w);
    // The patch also defines isTrusted=true on Event.prototype — under Bun
    // bare `Event` resolves to the HOST Event. Snapshot + restore it so this
    // test doesn't pollute the process.
    const evProto = (globalThis as { Event?: { prototype?: object } }).Event?.prototype;
    const isTrustedDesc = evProto
      ? Object.getOwnPropertyDescriptor(evProto, "isTrusted")
      : undefined;
    try {
      w.__capGuestDebug = false;
      (w.eval as (code: string) => unknown)(GUEST_EVAL_PATCH);
      expect(Array.isArray(w.__capGuestErrors)).toBe(true);

      // Dispatch error events exactly like happy-dom does when a guest
      // listener throws (the path that produced [WINDOW-ERROR] spam).
      const wWin = w as unknown as {
        ErrorEvent: new (type: string, init: { message: string; error: Error }) => object;
        dispatchEvent: (ev: object) => boolean;
      };
      for (let i = 0; i < 50; i++) {
        wWin.dispatchEvent(
          new wWin.ErrorEvent("error", { message: `boom ${i}`, error: new Error(`boom ${i}`) }),
        );
      }
      const errs = w.__capGuestErrors as string[];
      expect(errs.length).toBe(40); // bounded, tail-kept
      expect(errs[0]).toContain("WINDOW-ERROR");
      expect(errs[0]).toContain("boom 10"); // first 10 evicted (tail semantics)
      expect(errs[39]).toContain("boom 49"); // most recent kept
    } finally {
      if (evProto && isTrustedDesc) {
        Object.defineProperty(evProto, "isTrusted", isTrustedDesc);
      } else if (evProto) {
        delete (evProto as Record<string, unknown>).isTrusted;
      }
      removeGlobalWindowAlias(globalThis, w);
      try {
        (w.happyDOM as { close: () => void }).close();
      } catch {
        /* best effort */
      }
    }
  });
});
