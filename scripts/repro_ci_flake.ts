/**
 * Repro for the v0.3.7.1 Release-pipeline test flake (CI run 33099284175).
 *
 * Mechanism: bun test runs ALL test files in ONE process. A leftover
 * self-re-arming timer from an earlier file (keepalive/heartbeat style)
 * calls bare `setTimeout` — which lands on whatever global is installed.
 * The old test kept the poison accessor installed for a 120ms await window
 * and asserted `poisonCalled === false` AFTER the window: the stray call
 * tripped the poison on CI's slower runners -> false failure.
 *
 * This script reproduces exactly that and shows the hermetic sync-snapshot
 * assertion (the fix) stays clean while still catching a broken
 * implementation that resolves through the accessor.
 */
import { hostSetTimeout } from "../lealll/src/utils/host-timers.js";

// ── Simulated leftover keepalive from an earlier test file ──────────────────
const noise = setInterval(() => {
  setTimeout(() => {}, 1); // bare setTimeout — resolves through the global
}, 10);

// ── The fixed test's logic ──────────────────────────────────────────────────
const nativeSetTimeout = globalThis.setTimeout;
let getterInvoked = false;
let poisonCalled = false;

const desc = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
Object.defineProperty(globalThis, "setTimeout", {
  get() {
    getterInvoked = true;
    return () => {
      poisonCalled = true;
    };
  },
  configurable: true,
});

let fired = false;
let caughtBrokenImpl = false;

try {
  // (a) quarantined implementation — must NOT touch the accessor
  hostSetTimeout(() => {
    fired = true;
  }, 20);

  // hermetic sync snapshot (the fix): assert BEFORE any await
  const syncPoison = poisonCalled;
  const syncGetter = getterInvoked;

  // (b) broken implementation control — resolves through the accessor, the
  // sync snapshot MUST catch it
  const broken = (globalThis as Record<string, unknown>)["setTimeout"] as (cb: () => void, ms: number) => void;
  broken(() => {}, 5); // this is what a non-quarantined call site would do
  caughtBrokenImpl = poisonCalled === true;

  // observation window with the accessor still installed (stray noise hits it)
  await new Promise((r) => (nativeSetTimeout as (cb: () => void) => void)(r as never as () => void, 200));

  console.log("sync poisonCalled (must be false):        ", syncPoison === false ? "PASS" : "FAIL");
  console.log("sync getterInvoked (must be false):       ", syncGetter === false ? "PASS" : "FAIL");
  console.log("callback fired on native registry:       ", fired ? "PASS" : "FAIL");
  console.log("sync snapshot catches a BROKEN impl:     ", caughtBrokenImpl ? "PASS" : "FAIL");
  console.log("poison tripped during await window (the old flaky assertion):", poisonCalled ? "yes — old assertion would FAIL (flake reproduced)" : "no");
} finally {
  Object.defineProperty(globalThis, "setTimeout", desc);
  clearInterval(noise);
}
