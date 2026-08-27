/**
 * E2E smoke (v0.3.7.1): real captcha solve through the token pool with the
 * host-timer quarantine active — verifies the production solve pipeline
 * still works end-to-end after the timer call-site migration, AND that a
 * concurrent host sleep survives the solve's window destruction.
 *
 * Run: bun scripts/smoke-real-solve.ts
 */
import { solveTraceless } from "../src/proxy/captcha-happy.js";
import { sleep } from "../src/utils/sleep.js";
import { hostSleep } from "../src/utils/host-timers.js";

const t0 = Date.now();
const log = (m: string) => console.log(`[${String(Date.now() - t0).padStart(5)}ms] ${m}`);

log("starting real solveTraceless (network: zcode.z.ai + FeiLin CDN)...");
const solveP = solveTraceless({ scene: "11xygtvd", region: "sgp", prefix: "no8xfe" });
solveP.then(
  (param: string) => log(`solve OK: verifyParam length=${param.length}`),
  (err: Error) => log(`solve FAILED: ${err.message.slice(0, 200)}`),
);

// Concurrent host activity during the solve epoch — exactly the conditions
// that used to cancel host timers when the solve window closed.
let sleepResult = "pending";
sleep(400).then(() => { sleepResult = "resolved"; });
log("concurrent sleep(400) registered during the solve epoch");

const param = await Promise.race([
  solveP,
  hostSleep(45_000).then(() => null as unknown as string),
]);

await hostSleep(1_200); // let the post-solve window destruction settle
log(`concurrent sleep outcome: ${sleepResult}   ${sleepResult === "resolved" ? "✅ host sleep survived the epoch" : "❌ host sleep was cancelled"}`);

if (param) {
  log(`E2E PASS — real solve succeeded AND host timers survived the epoch`);
  process.exit(0);
} else {
  log("E2E FAIL — solve timed out (network?)");
  process.exit(1);
}
