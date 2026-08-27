/**
 * Host-realm timer quarantine (v0.3.7.1).
 *
 * WHY THIS EXISTS — the 429-retry permanent hang (user-visible symptom:
 * `upstream returned 429, retry 1/20 in 247ms..` and then the request hangs
 * forever with no further log output):
 *
 * Under Bun, captcha guest scripts execute in the HOST realm, so
 * captcha-happy.ts `installGlobalWindowAlias()` shadows the global
 * `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` with the solving
 * happy-dom window's timer registry (guest timers must die with their
 * window). The poison: while ANY solve epoch is active — background pool
 * refill waves run almost continuously under load — HOST code resolving the
 * bare `setTimeout` identifier gets the WINDOW's registry instead. Timers
 * registered there are silently CANCELLED when that window is closed
 * (`happyDOM.close()` aborts the window's TimerManager). Empirically
 * (scripts/probe_timer_cancel.ts, real happy-dom Window):
 *
 *   1. `sleep(247)` registered mid-epoch → window destroyed → never fires
 *      → the retry loop hangs forever right after logging
 *      "retry 1/20 in 247ms..".
 *   2. With concurrent solves, the alias points at the LAST-installed
 *      window; a sibling window finishing first cancels timers it never
 *      owned, and leaves the alias aimed at a dead registry (new timers
 *      silently no-op).
 *   3. solveTraceless's own 30s timeout guard and the token-pool's 25s
 *      take deadline were registered the same way — both got cancelled,
 *      so NOTHING in the chain could ever recover.
 *
 * FIX: host code never resolves timers through a captcha-aliased
 * globalThis. Each host*() call resolves its binding as follows:
 *
 *   - ACCESSOR descriptor on the global name → captcha alias epoch is
 *     active (installGlobalWindowAlias only ever installs getters) → use
 *     the NATIVE binding captured at module load (guaranteed pre-alias:
 *     captcha-happy.ts, the only alias installer, imports this module at
 *     its top).
 *   - DATA descriptor → the global is either the untouched native timer or
 *     a test stub (tests stub via plain assignment, which produces data
 *     descriptors) → use the CURRENT global value. This keeps the existing
 *     test suite's `globalThis.setTimeout = wrapper` interception pattern
 *     working unchanged.
 *
 * RULE: new host code must NEVER reference bare setTimeout/setInterval/
 * clearTimeout/clearInterval — import from here instead. Guest-facing
 * polyfills inside captcha-happy.ts that want window-scoped timers must
 * reference them as `w.setTimeout(...)` on their OWN window, never bare.
 */

interface NativeTimerBindings {
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
}

/** Native host timers, captured at module load (pre-alias by construction). */
const NATIVE: NativeTimerBindings = {
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearTimeout: clearTimeout,
  clearInterval: clearInterval,
};

/**
 * Resolve the effective binding for a timer name. Accessor descriptor ⇒
 * captcha alias epoch ⇒ quarantined native binding. Data descriptor ⇒
 * native or test stub ⇒ current global value (function-typed), else native.
 */
function resolveBinding<K extends keyof NativeTimerBindings>(name: K): NativeTimerBindings[K] {
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(globalThis, name);
  } catch {
    desc = undefined;
  }
  if (desc && desc.get) return NATIVE[name];
  if (desc && desc.writable) {
    const current = (globalThis as Record<string, unknown>)[name];
    if (typeof current === "function") return current as NativeTimerBindings[K];
  }
  return NATIVE[name];
}

/** Host-safe setTimeout — immune to the captcha window alias. */
export function hostSetTimeout(
  handler: TimerHandler,
  timeout?: number,
  ...rest: unknown[]
): ReturnType<typeof setTimeout> {
  return resolveBinding("setTimeout")(handler as never, timeout as never, ...rest as never[]) as ReturnType<typeof setTimeout>;
}

/** Host-safe setInterval — immune to the captcha window alias. */
export function hostSetInterval(
  handler: TimerHandler,
  timeout?: number,
  ...rest: unknown[]
): ReturnType<typeof setInterval> {
  return resolveBinding("setInterval")(handler as never, timeout as never, ...rest as never[]) as ReturnType<typeof setInterval>;
}

/** Host-safe clearTimeout — immune to the captcha window alias. */
export function hostClearTimeout(id: Parameters<typeof clearTimeout>[0]): void {
  resolveBinding("clearTimeout")(id as never);
}

/** Host-safe clearInterval — immune to the captcha window alias. */
export function hostClearInterval(id: Parameters<typeof clearInterval>[0]): void {
  resolveBinding("clearInterval")(id as never);
}

/**
 * Host-safe sleep. Identical semantics to utils/sleep.ts's sleep(), but
 * guaranteed to resolve even while captcha solve epochs are aliasing (or
 * have poisoned) the global timer names.
 */
export function hostSleep(ms: number): Promise<void> {
  return new Promise((resolve) => hostSetTimeout(resolve, ms));
}

/** @internal re-exported for tests asserting the capture predates aliasing. */
export function _nativeTimerBindingsForTesting(): Readonly<NativeTimerBindings> {
  return NATIVE;
}
