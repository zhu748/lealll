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

describe("guest console-noise filter (v0.3.6.1)", () => {
  // FeiLin probes the whole console surface from guest frames:
  //   [log, dir, dirxml, table, count, ...].forEach(fn => fn(...))
  // which printed stray "%c%d" / NaN / undefined lines to the user's terminal
  // (bare `console` under Bun resolves to the HOST console). The alias epoch
  // swaps globalThis.console for a delegating wrapper that drops guest-frame
  // calls and passes host calls through, restoring the original at epoch end.
  it("drops guest-frame console calls and passes host calls through during the epoch", () => {
    const w = makeFakeWindow();
    const realConsole = console;
    const calls: string[] = [];
    // Spy BEFORE the epoch: the wrapper captures origFn at install time.
    const origLog = console.log;
    (console as { log: (...a: unknown[]) => void }).log = (...a: unknown[]) => {
      calls.push(a.map(String).join(" "));
    };
    try {
      installGlobalWindowAlias(globalThis, w);
      // console is swapped for a delegating wrapper (prototype = original).
      expect(globalThis.console).not.toBe(realConsole);
      expect(Object.getPrototypeOf(globalThis.console)).toBe(realConsole);
      // Host-frame call passes through to the ORIGINAL log (the spy).
      console.log("host-line");
      expect(calls).toEqual(["host-line"]);
      // Wrapped methods present as native (console.log.toString() is a known
      // headless fingerprint probe).
      expect(String(console.log)).toContain("[native code]");
      // Guest-frame call (alicdn URL in the caller stack) is DROPPED: use
      // Error.prepareStackTrace to fabricate the guest caller frame exactly
      // like a feilin chunk would produce.
      const prevPrepare = Error.prepareStackTrace;
      Error.prepareStackTrace = () =>
        "Error: x\n    at __capConsoleFilter (captcha-happy.ts:1:1)\n    at <anonymous> (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.js:1:421938)";
      try {
        console.log("%c%d font-size:0;color:transparent", "Error");
        console.dir({ probe: 1 });
      } finally {
        Error.prepareStackTrace = prevPrepare;
      }
      // Neither probe reached the original console.
      expect(calls).toEqual(["host-line"]);
    } finally {
      removeGlobalWindowAlias(globalThis, w);
      (console as { log: (...a: unknown[]) => void }).log = origLog;
    }
    // Epoch end restores the true console object.
    expect(globalThis.console).toBe(realConsole);
  });

  it("wraps the full console output surface, not just log/warn/error (FeiLin probes dir/table/count)", () => {
    const w = makeFakeWindow();
    installGlobalWindowAlias(globalThis, w);
    try {
      const c = globalThis.console as unknown as Record<string, unknown>;
      for (const m of ["log", "warn", "error", "info", "debug", "trace", "dir", "dirxml", "table", "count"]) {
        expect(typeof c[m]).toBe("function");
        // Own wrapped prop (not prototype-delegated) for every output method.
        expect(Object.prototype.hasOwnProperty.call(c, m)).toBe(true);
      }
      // Class-like props stay on the prototype untouched.
      expect(Object.prototype.hasOwnProperty.call(c, "Console")).toBe(false);
    } finally {
      removeGlobalWindowAlias(globalThis, w);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v0.3.7.1 — host timer quarantine during solve epochs (429-retry permanent
// hang). Empirical failure modes (scripts/probe_timer_cancel.ts, real
// happy-dom windows): a host timer registered through the aliased global
// lands on the solving window's registry and is silently CANCELLED when
// that window is closed. The retry backoff sleep, the pool's 25s take
// deadline, and solveTraceless's 30s guard all died this way — the request
// hung forever right after "upstream returned 429, retry 1/20 in 247ms..".
// These tests use REAL happy-dom windows (their timer registries abort on
// close, unlike makeFakeWindow's host-delegating stubs).
// ─────────────────────────────────────────────────────────────────────────────
describe("host timer quarantine during solve epochs (v0.3.7.1)", () => {
  async function makeRealWindow(): Promise<{
    w: Record<string, unknown> & { happyDOM: { close: () => void } };
    close: () => void;
  }> {
    const { GlobalWindow } = await import("happy-dom");
    const w = new GlobalWindow({ url: "https://zcode.z.ai/" }) as unknown as
      Record<string, unknown> & { happyDOM: { close: () => void } };
    return {
      w,
      close: () => {
        try { w.happyDOM.close(); } catch { /* best effort */ }
      },
    };
  }

  it("the alias really does redirect bare setTimeout onto the window registry (hazard precondition)", async () => {
    const { w, close } = await makeRealWindow();
    const native = globalThis.setTimeout;
    installGlobalWindowAlias(globalThis, w);
    try {
      // The alias getter is the ONLY thing standing between host code and
      // the window's registry — this is the precondition for every hang
      // scenario below, asserted so a future happy-dom or alias refactor
      // that changes the shape invalidates these tests loudly.
      const desc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
      expect(typeof desc.get).toBe("function");
      const viaGlobal = (0, eval)("setTimeout");
      expect(viaGlobal).not.toBe(native);
    } finally {
      removeGlobalWindowAlias(globalThis, w);
      close();
    }
    expect(globalThis.setTimeout).toBe(native);
  });

  it("sleep() registered mid-epoch survives window destruction (THE retry-backoff hang)", async () => {
    const { sleep } = await import("../utils/sleep.js");
    const { hostSleep } = await import("../utils/host-timers.js");
    const { w, close } = await makeRealWindow();
    installGlobalWindowAlias(globalThis, w);
    let removed = false;
    try {
      let resolved = false;
      const p = sleep(150).then(() => {
        resolved = true;
      });
      // The solve owning this window finishes while the 150ms backoff is
      // still pending — destroyDom closes the window mid-sleep.
      close();
      removeGlobalWindowAlias(globalThis, w);
      removed = true;
      const outcome = await Promise.race([
        p.then(() => "resolved"),
        hostSleep(900).then(() => (resolved ? "resolved" : "HUNG-FOREVER")),
      ]);
      expect(outcome).toBe("resolved");
    } finally {
      if (!removed) removeGlobalWindowAlias(globalThis, w);
      close();
    }
  });

  it("host timers keep working after a sibling window is destroyed mid-epoch (concurrent solves)", async () => {
    const { hostSetTimeout, hostSleep } = await import("../utils/host-timers.js");
    const s1 = await makeRealWindow();
    const s2 = await makeRealWindow();
    installGlobalWindowAlias(globalThis, s1.w);
    installGlobalWindowAlias(globalThis, s2.w); // alias now aims at s2's registry
    let s2Removed = false;
    try {
      // s2's solve finishes first: refcount 2→1, aliases stay installed but
      // aimed at a CLOSED window. New host timers must bypass the corpse.
      s2.close();
      removeGlobalWindowAlias(globalThis, s2.w);
      s2Removed = true;
      let fired = false;
      hostSetTimeout(() => {
        fired = true;
      }, 50);
      await hostSleep(400);
      expect(fired).toBe(true);
    } finally {
      removeGlobalWindowAlias(globalThis, s1.w);
      if (!s2Removed) removeGlobalWindowAlias(globalThis, s2.w);
      s1.close();
      s2.close();
    }
    expect(typeof setTimeout).toBe("function");
  });

  it("a solveTraceless-style timeout guard survives its own window's destruction (stall path)", async () => {
    const { hostSetTimeout, hostSleep } = await import("../utils/host-timers.js");
    const { w, close } = await makeRealWindow();
    installGlobalWindowAlias(globalThis, w);
    let removed = false;
    try {
      const guard = new Promise<void>((resolve) => {
        hostSetTimeout(resolve, 120);
      });
      // The solve stalls; the caller tears the window down at 40ms — long
      // before the 120ms guard expires. The guard MUST still fire.
      await hostSleep(40);
      close();
      removeGlobalWindowAlias(globalThis, w);
      removed = true;
      const outcome = await Promise.race([
        guard.then(() => "fired"),
        hostSleep(900).then(() => "HUNG-FOREVER"),
      ]);
      expect(outcome).toBe("fired");
    } finally {
      if (!removed) removeGlobalWindowAlias(globalThis, w);
      close();
    }
  });

  it("recovers from a double destroyDom: refcount clamps at zero instead of failing open (host-critical shadowing)", async () => {
    // v0.3.7.1 hardening: a double remove used to drive the refcount to −1;
    // the NEXT install then ran with an EMPTY descriptor snapshot and the
    // HOST_CRITICAL_GLOBALS check failed open — console/process/fetch got
    // shadowed by window getters (observed as installGlobalWindowAlias
    // hanging once the aliased console was used). The clamp + self-heal must
    // keep the snapshot machinery sound.
    const { w, close } = await makeRealWindow();
    installGlobalWindowAlias(globalThis, w);
    removeGlobalWindowAlias(globalThis, w);
    removeGlobalWindowAlias(globalThis, w); // the double destroy — must clamp
    close();

    const w2 = await makeRealWindow();
    installGlobalWindowAlias(globalThis, w2);
    try {
      // Host-critical globals must stay protected: console is host-defined,
      // so the alias must NOT replace it with a window getter.
      const consoleDesc = Object.getOwnPropertyDescriptor(globalThis, "console")!;
      expect(typeof consoleDesc.get).toBe("undefined");
      // And the fresh epoch's timers alias as normal.
      const timerDesc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
      expect(typeof timerDesc.get).toBe("function");
      // console.log still works through the epoch (it was never shadowed).
      console.log("[v0.3.7.1 regression] console alive during post-double-destroy epoch");
    } finally {
      removeGlobalWindowAlias(globalThis, w2);
      close();
    }
    expect(typeof setTimeout).toBe("function");
    expect(typeof console.log).toBe("function");
  });
});
