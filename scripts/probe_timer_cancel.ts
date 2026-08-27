/**
 * PROBE (v0.3.7.1 fixed-behavior verification): host timers must survive
 * captcha window destruction.
 *
 * The pre-fix failure modes (all reproduced empirically, see worklog):
 *   1. `sleep(247)` registered mid-epoch → window destroyed → timer
 *      cancelled → retry loop hung forever after "retry 1/20 in 247ms..".
 *   2. Concurrent solves: sibling window destroyed mid-epoch → alias aims
 *      at a dead registry → pending AND new host timers silently no-op.
 *   3. solveTraceless's 30s timeout guard + the pool's 25s take deadline
 *      registered on the solving window's registry → cancelled on close →
 *      nothing in the chain could ever recover.
 *
 * This probe replays the same destruction sequences against the PRODUCTION
 * code paths (utils/sleep.ts, utils/host-timers.ts) and expects all PASS.
 *
 * Run: bun scripts/probe_timer_cancel.ts
 */
import { installGlobalWindowAlias, removeGlobalWindowAlias } from "../src/proxy/captcha-happy.js";
import { Window } from "happy-dom";
import { sleep } from "../src/utils/sleep.js";
import { hostSetTimeout, hostSleep } from "../src/utils/host-timers.js";

function makeWindow(): any {
  return new Window({
    url: "https://zcode.z.ai/",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
}

const t0 = Date.now();
const log = (m: string) => console.log(`[${String(Date.now() - t0).padStart(5)}ms] ${m}`);

async function scenario1_singleWindowDeath() {
  log("── scenario 1: retry-backoff sleep registered mid-epoch, window destroyed ──");
  const w = makeWindow();
  installGlobalWindowAlias(globalThis as any, w);
  const p = sleep(300); // the exact retry-loop backoff path
  let resolved = false;
  p.then(() => { resolved = true; });
  w.happyDOM.close();
  removeGlobalWindowAlias(globalThis as any, w);
  log("window destroyed while 300ms sleep pending");
  const outcome = await Promise.race([
    p.then(() => "resolved"),
    hostSleep(1200).then(() => (resolved ? "resolved" : "HUNG-FOREVER")),
  ]);
  log(`sleep outcome: ${outcome}   ${outcome === "resolved" ? "✅ retry backoff survives" : "❌ STILL HANGS"}`);
  return outcome === "resolved";
}

async function scenario2_siblingDeathMidEpoch() {
  log("── scenario 2: sibling window destroyed mid-epoch (concurrent solves) ──");
  const w1 = makeWindow();
  const w2 = makeWindow();
  installGlobalWindowAlias(globalThis as any, w1);
  installGlobalWindowAlias(globalThis as any, w2); // alias aims at w2

  let fired = false;
  hostSetTimeout(() => { fired = true; }, 300);
  w2.happyDOM.close();
  removeGlobalWindowAlias(globalThis as any, w2); // refcount 2→1, alias still installed on a CLOSED w2
  log("w2 destroyed mid-epoch while a 300ms host timer is pending");

  let newTimerFired = false;
  hostSetTimeout(() => { newTimerFired = true; }, 100);

  await hostSleep(900);
  log(`pending timer fired: ${fired}   ${fired ? "✅" : "❌ CANCELLED"}`);
  log(`new timer fired: ${newTimerFired}   ${newTimerFired ? "✅" : "❌ registry dead"}`);
  w1.happyDOM.close();
  removeGlobalWindowAlias(globalThis as any, w1);
  return fired && newTimerFired;
}

async function scenario3_solveTimeoutDeath() {
  log("── scenario 3: solveTraceless-style timeout guard vs own window destruction ──");
  const w = makeWindow();
  installGlobalWindowAlias(globalThis as any, w);
  let rejected = false;
  const guard = new Promise<never>((_, reject) => {
    hostSetTimeout(() => { rejected = true; reject(new Error("captcha solve timeout")); }, 400);
  });
  const race = Promise.race([
    new Promise<string>(() => { /* the solve itself — never settles (pe-VM stall) */ }),
    guard,
  ]).catch(() => "rejected-in-time");

  await hostSleep(150);
  w.happyDOM.close();
  removeGlobalWindowAlias(globalThis as any, w);
  log("window destroyed while solve promise still pending (stall/abort path)");

  const outcome = await Promise.race([
    race,
    hostSleep(1500).then(() => "HUNG-FOREVER"),
  ]);
  log(`guard outcome: ${outcome}   ${outcome === "HUNG-FOREVER" ? "❌ takeToken/solveTraceless still hang" : "✅ guard fires, chain recovers"}`);
  return outcome !== "HUNG-FOREVER";
}

async function scenario4_doubleDestroyRecovery() {
  log("── scenario 4: double destroyDom → refcount clamp, host-critical globals protected ──");
  const w = makeWindow();
  installGlobalWindowAlias(globalThis as any, w);
  removeGlobalWindowAlias(globalThis as any, w);
  removeGlobalWindowAlias(globalThis as any, w); // double destroy
  w.happyDOM.close();

  const w2 = makeWindow();
  installGlobalWindowAlias(globalThis as any, w2);
  const consoleShadowed = !!Object.getOwnPropertyDescriptor(globalThis, "console")?.get;
  const fetchShadowed = !!Object.getOwnPropertyDescriptor(globalThis, "fetch")?.get;
  log(`after recovery epoch — console shadowed: ${consoleShadowed}, fetch shadowed: ${fetchShadowed}`);
  removeGlobalWindowAlias(globalThis as any, w2);
  w2.happyDOM.close();
  const ok = !consoleShadowed && !fetchShadowed;
  log(ok ? "✅ host-critical globals stay protected" : "❌ host-critical globals shadowed (fail-open)");
  return ok;
}

const ok1 = await scenario1_singleWindowDeath();
const ok2 = await scenario2_siblingDeathMidEpoch();
const ok3 = await scenario3_solveTimeoutDeath();
const ok4 = await scenario4_doubleDestroyRecovery();
console.log("\n──────────────────────────────────────────────");
console.log(`scenario1 (retry backoff vs window death):  ${ok1 ? "PASS" : "FAIL"}`);
console.log(`scenario2 (sibling death mid-epoch):        ${ok2 ? "PASS" : "FAIL"}`);
console.log(`scenario3 (solve guard vs stall):           ${ok3 ? "PASS" : "FAIL"}`);
console.log(`scenario4 (double-destroy recovery):        ${ok4 ? "PASS" : "FAIL"}`);
console.log(ok1 && ok2 && ok3 && ok4 ? "\nALL SCENARIOS PASS — the 429-retry permanent hang is fixed." : "\nSOME SCENARIOS STILL FAIL");
process.exit(0);
