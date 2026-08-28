import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const solveMock = mock(async (_scene: string, _region: string, _prefix: string) => {
  return "x".repeat(64);
});

mock.module("./captcha-solver.js", () => ({
  runCaptchaSolve: solveMock,
  shutdownCaptchaSolver: () => {},
  setCaptchaSolverConcurrency: () => {},
  captchaSolverConcurrency: () => 2,
  CAPTCHA_NODE_DIR: "/tmp",
}));

const { CaptchaTokenPool } = await import("./captcha-pool.js");

const CFG = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "sgp",
};

let pool: InstanceType<typeof CaptchaTokenPool>;

describe("CaptchaTokenPool", () => {
  beforeEach(() => {
    process.env.ZCODE_CAPTCHA_SKIP_DEPS = "1";
    solveMock.mockClear();
    pool = new CaptchaTokenPool({
      poolSizeMin: 3,
      poolSizeMax: 3,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 2,
      scaleDownIdleMs: 60_000,
    });
  });

  afterEach(() => {
    delete process.env.ZCODE_CAPTCHA_SKIP_DEPS;
    pool.stopBackgroundRefill();
  });

  it("prefill adds tokens without consuming on take", async () => {
    await pool.prefill(CFG, 2);
    expect(pool.stats().ready).toBe(2);
    expect(solveMock).toHaveBeenCalledTimes(2);
  });

  it("takeToken uses prefetched token and triggers background refill", async () => {
    await pool.prefill(CFG, 2);
    solveMock.mockClear();

    const param = await pool.takeToken(CFG);
    expect(param.length).toBeGreaterThan(20);
    expect(pool.stats().ready).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(solveMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("concurrent takes use parallel solves when pool is empty", async () => {
    const [a, b] = await Promise.all([pool.takeToken(CFG), pool.takeToken(CFG)]);
    expect(a.length).toBeGreaterThan(20);
    expect(b.length).toBeGreaterThan(20);
    expect(solveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidate clears the pool", async () => {
    await pool.prefill(CFG, 2);
    pool.invalidate();
    expect(pool.stats().ready).toBe(0);
  });

  it("does not re-bank an in-flight mint wave after invalidation", async () => {
    // Keep the invalidated prefill from immediately starting a fresh
    // generation; this test isolates whether the old in-flight result leaks
    // back into the bank.
    (pool as unknown as { opts: { staggerMs: number } }).opts.staggerMs = 60_000;
    let started = 0;
    let releaseWave!: () => void;
    const waveGate = new Promise<void>((resolve) => { releaseWave = resolve; });
    solveMock.mockImplementation(async () => {
      const id = ++started;
      await waveGate;
      return `old-wave-${id}:${"x".repeat(48)}`;
    });

    const fill = pool.prefill(CFG, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(1);
    pool.invalidate();
    releaseWave();
    await fill;

    expect(pool.stats().ready).toBe(0);
  });

  it("pushToken rejects duplicate certifyId", async () => {
    const payload = Buffer.from(
      JSON.stringify({ certifyId: "dup-test-id", sceneId: "11xygtvd", isSign: true, securityToken: "x" }),
    ).toString("base64");
    const poolAny = pool as unknown as {
      pushToken: (p: string) => void;
      stats: () => { ready: number };
    };
    poolAny.pushToken(payload);
    poolAny.pushToken(payload);
    expect(poolAny.stats().ready).toBe(1);
  });

  it("takeToken prefers newest token (LIFO)", async () => {
    let n = 0;
    solveMock.mockImplementation(async () => {
      n += 1;
      return `token-${n}:${"x".repeat(48)}`;
    });
    await pool.prefill(CFG, 3);
    solveMock.mockClear();

    const taken = await pool.takeToken(CFG);
    expect(taken.startsWith("token-3:")).toBe(true);
  });

  // v0.3.10.9 regression tests: the "two 429 requests then stuck for many
  // minutes" report traced to retry-path takes waiting the full default
  // deadline (25s) + grace (10s) per retry iteration, plus late-minted
  // tokens being silently dropped after a deadline miss.
  describe("retry-path take deadline + late-mint banking (v0.3.10.9)", () => {
    const originalGrace = process.env.CAPTCHA_TAKE_GRACE_MS;
    const originalDeadline = process.env.CAPTCHA_SOLVE_RACE_DEADLINE_MS;

    beforeEach(() => {
      // Fast grace exit so the deadline rejection surfaces quickly in tests.
      process.env.CAPTCHA_TAKE_GRACE_MS = "30";
      delete process.env.CAPTCHA_SOLVE_RACE_DEADLINE_MS;
    });
    afterEach(() => {
      if (originalGrace === undefined) delete process.env.CAPTCHA_TAKE_GRACE_MS;
      else process.env.CAPTCHA_TAKE_GRACE_MS = originalGrace;
      if (originalDeadline === undefined) delete process.env.CAPTCHA_SOLVE_RACE_DEADLINE_MS;
      else process.env.CAPTCHA_SOLVE_RACE_DEADLINE_MS = originalDeadline;
      // Restore the module-default solver implementation — this describe's
      // tests override it with gated/never-resolving promises, and later
      // describes (deep idle etc.) rely on the default fast solver.
      solveMock.mockImplementation(async () => "x".repeat(64));
    });

    it("takeToken honors a caller-provided maxWaitMs shorter than the env default", async () => {
      solveMock.mockImplementation(async (): Promise<string> => {
        await new Promise(() => {}); // mint never lands
        return "unreachable";
      });
      const started = Date.now();
      let err: unknown = null;
      try {
        await pool.takeToken(CFG, 1_100);
      } catch (e) {
        err = e;
      }
      const elapsed = Date.now() - started;
      // Rejects with the deadline error after ~1.1s (env default is 25s —
      // the shorter caller cap must win), NOT after the full default.
      expect(String((err as Error)?.message)).toMatch(/deadline/);
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      expect(elapsed).toBeLessThan(1_800);
    });

    it("a take that misses its deadline banks the late-minted token for the next take", async () => {
      let calls = 0;
      solveMock.mockImplementation(async (): Promise<string> => {
        calls += 1;
        if (calls === 1) {
          // First mint is slower than the 1s caller cap but eventually lands.
          await new Promise((r) => setTimeout(r, 1_600));
          return `late-token-1:${"x".repeat(48)}`;
        }
        // Any later mint (background refill etc.) never lands, so the ONLY
        // servable token is the banked late one.
        await new Promise(() => {});
        return "unreachable";
      });

      let deadlineErr: unknown = null;
      try {
        await pool.takeToken(CFG, 1_000);
      } catch (e) {
        deadlineErr = e;
      }
      expect(String((deadlineErr as Error)?.message)).toMatch(/deadline/);

      // Wait past the late mint's 1.6s landing time so the banking .then runs.
      await new Promise((r) => setTimeout(r, 900));

      // The next take must serve the BANKED late token instantly — without
      // the fix the late mint was silently dropped and this take would hang
      // until its own deadline (and mint yet another token upstream).
      const t2Start = Date.now();
      const second = await pool.takeToken(CFG, 1_000);
      const t2Elapsed = Date.now() - t2Start;
      expect(second.startsWith("late-token-1:")).toBe(true);
      expect(t2Elapsed).toBeLessThan(500);
      // NOTE: no "calls === 1" assertion here — a successful take legitimately
      // fires an urgent background refill, which invokes the solver again
      // (asynchronously). The served token's marker already proves the late
      // mint was banked rather than dropped.
    });

    it("v0.3.10.11: caller maxWaitMs bounds the WHOLE take — default 10s grace cannot stack on top", async () => {
      // The describe's beforeEach pins grace to 30ms for speed; this test
      // needs the DEFAULT (10s) grace to prove the caller cap cuts the grace
      // window down to whatever budget remains inside maxWaitMs.
      delete process.env.CAPTCHA_TAKE_GRACE_MS;
      try {
        solveMock.mockImplementation(async (): Promise<string> => {
          await new Promise(() => {}); // mint never lands
          return "unreachable";
        });
        const started = Date.now();
        let err: unknown = null;
        try {
          await pool.takeToken(CFG, 1_200);
        } catch (e) {
          err = e;
        }
        const elapsed = Date.now() - started;
        // The race deadline fires at 1.2s. LEGACY behavior: the grace loop
        // then created a FRESH 10s deadline → rejection at ~11.2s. FIXED
        // behavior: grace is capped to the remaining maxWaitMs budget (≈0
        // here) → rejection at ~1.2s.
        expect(String((err as Error)?.message)).toMatch(/deadline/);
        expect(elapsed).toBeGreaterThanOrEqual(1_100);
        expect(elapsed).toBeLessThan(2_500);
      } finally {
        process.env.CAPTCHA_TAKE_GRACE_MS = "30"; // restore describe-level pin
      }
    });

    it("v0.3.10.11: a FAST-failing mint still gets its grace window inside maxWaitMs (early failure can recover)", async () => {
      delete process.env.CAPTCHA_TAKE_GRACE_MS;
      try {
        // The mint itself rejects quickly (storm), but a rescue token lands
        // at 700ms via the grace polling loop. Caller cap is 1500ms, so the
        // grace window has ~1450ms of remaining budget — the rescue MUST be
        // served. This pins the "grace shrinks but does not vanish" half of
        // the fix.
        solveMock.mockImplementation(async (): Promise<string> => {
          throw new Error("captcha solve stall pe=pe.099.storm.js");
        });
        const takePromise = pool.takeToken(CFG, 1_500);
        const pushTimer = setTimeout(() => {
          const p = pool as unknown as { pushToken: (s: string) => void };
          p.pushToken(`cap-rescue:${"h".repeat(48)}`);
        }, 700);
        const param = await takePromise;
        clearTimeout(pushTimer);
        expect(param).toContain("cap-rescue");
      } finally {
        process.env.CAPTCHA_TAKE_GRACE_MS = "30"; // restore describe-level pin
      }
    });
  });

  // v0.3.10.10 regression tests: empty-pool takes used to immediately start
  // their own live solve even while a background refill wave was mid-mint.
  // The live solve then serialized behind the wave's solve on the global
  // solver lock, so the caller paid two back-to-back solves (~6-10s per
  // 429-retry preflight) while the wave's freshly banked token sat unused in
  // the pool.
  describe("empty-pool take serves in-flight background mints (v0.3.10.10)", () => {
    afterEach(() => {
      // Restore the default fast solver for later describes.
      solveMock.mockImplementation(async () => "x".repeat(64));
    });

    it("waits for the in-flight wave's token instead of minting redundantly", async () => {
      let started = 0;
      let releaseWave!: () => void;
      const waveGate = new Promise<void>((resolve) => { releaseWave = resolve; });
      solveMock.mockImplementation(async () => {
        started += 1;
        await waveGate;
        return `wave-token-${started}:${"x".repeat(48)}`;
      });

      // Background wave: one gated solve, banked on completion.
      const fill = pool.prefill(CFG, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toBe(1); // wave is minting (gated)

      // The take arrives mid-wave on an empty pool.
      const take = pool.takeToken(CFG, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Core assertion: while the wave was still minting, the take did NOT
      // start its own redundant live solve.
      expect(started).toBe(1);

      releaseWave();
      const param = await take;
      await fill;
      // The take served the wave's BANKED token (marker 1), not a fresh mint.
      expect(param.startsWith("wave-token-1:")).toBe(true);
    });

    it("starts its own live solve immediately when nothing is minting in the background", async () => {
      let solveStartedAt = 0;
      solveMock.mockImplementation(async () => {
        if (!solveStartedAt) solveStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return `live-token:${"x".repeat(48)}`;
      });
      const takeStart = Date.now();
      const param = await pool.takeToken(CFG, 5_000);
      expect(param.startsWith("live-token:")).toBe(true);
      // No bg-wait poll rounds: the solve began within a fraction of one poll
      // interval (a spurious poll round would add ~120ms here).
      expect(solveStartedAt - takeStart).toBeLessThan(100);
    });

    it("falls back to its own live solve when the in-flight background mint fails", async () => {
      let calls = 0;
      let gateReleased = false;
      let releaseFailure!: () => void;
      const failGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
      solveMock.mockImplementation(async () => {
        calls += 1;
        if (!gateReleased) {
          // Any solve that started while the wave was mid-flight fails once
          // the gate opens (wave-size agnostic — the CPU governor caps the
          // urgent wave at one solve by default).
          await failGate;
          throw new Error("mint storm: F008");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        return `own-token:${"x".repeat(48)}`;
      });

      // Prime cfg + start an urgent background wave of gated-failing mints.
      await pool.prefill(CFG, 0);
      pool.requestUrgentRefill();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toBeGreaterThanOrEqual(1); // wave in flight

      const takeStart = Date.now();
      const take = pool.takeToken(CFG, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseFailure();
      gateReleased = true;
      const param = await take;
      const elapsed = Date.now() - takeStart;
      // The poll gave up once the wave failed (in-flight dropped to 0), the
      // take minted its own token and still succeeded — bounded wait.
      expect(param.startsWith("own-token:")).toBe(true);
      expect(elapsed).toBeLessThan(2_500);
    });
  });
});

describe("CaptchaTokenPool deep idle", () => {
  beforeEach(() => {
    process.env.ZCODE_CAPTCHA_SKIP_DEPS = "1";
    solveMock.mockClear();
  });
  afterEach(() => {
    delete process.env.ZCODE_CAPTCHA_SKIP_DEPS;
    pool?.stopBackgroundRefill?.();
  });

  it("decays target to idleFloor after sustained zero traffic", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    expect(pool.stats().target).toBe(5);
    // Simulate 61s of idle: lastTakeAt far in the past.
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 61_000;
    const decayed = pool as unknown as { maybeScaleDown: () => void; applyGovernorCaps: () => void };
    decayed.maybeScaleDown();
    decayed.applyGovernorCaps();
    expect(pool.stats().target).toBeLessThanOrEqual(1);
    expect(pool.stats().ready).toBeLessThanOrEqual(1);
  });

  it("restores full floor on the next token take", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 61_000;
    const decayed = pool as unknown as { maybeScaleDown: () => void };
    decayed.maybeScaleDown();
    expect(pool.stats().target).toBeLessThanOrEqual(1);
    await pool.takeToken(CFG);
    expect(pool.stats().target).toBe(5);
  });

  it("decays floor to 0 after deepIdleAfterMs (no background mints)", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      deepIdleAfterMs: 120_000,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    const p = pool as unknown as { lastTakeAt: number };
    // Past scaleDownIdleMs but before deepIdleAfterMs → keeper floor.
    p.lastTakeAt = Date.now() - 61_000;
    let decayed = pool as unknown as { maybeScaleDown: () => void };
    decayed.maybeScaleDown();
    expect(pool.stats().target).toBe(1);
    // Past deepIdleAfterMs → floor 0.
    p.lastTakeAt = Date.now() - 121_000;
    decayed.maybeScaleDown();
    expect(pool.stats().target).toBe(0);
  });

  it("keeps one banked token through decay for instant wake-up serves", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 0,
      deepIdleAfterMs: 120_000,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 121_000;
    const decayed = pool as unknown as { maybeScaleDown: () => void };
    decayed.maybeScaleDown();
    // Target is 0 but the last banked token survives trimming.
    expect(pool.stats().target).toBe(0);
    expect(pool.stats().ready).toBe(1);
    // …and a take right after deep idle still gets served instantly.
    solveMock.mockClear();
    const param = await pool.takeToken(CFG);
    expect(param.length).toBeGreaterThan(20);
  });

  it("races parallel solves on an empty-pool take and banks extras", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 2,
      poolSizeMax: 10,
      emptyTakeRace: 3,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 60_000,
    });
    let n = 0;
    let active = 0;
    let peak = 0;
    solveMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      n += 1;
      return `race-token-${n}:${"y".repeat(48)}`;
    });
    const param = await pool.takeToken(CFG);
    expect(param).toContain("race-token-");
    // Racers overlap: peak concurrent solves equals the race width instead
    // of stacking sequentially.
    expect(peak).toBe(3);
    // Extra successes are banked into the pool once they settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.stats().ready).toBeGreaterThanOrEqual(2);
  });

  it("grace-waits for refill when all raced solves fail before surfacing the error", async () => {
    process.env.CAPTCHA_TAKE_GRACE_MS = "1500";
    try {
      pool = new CaptchaTokenPool({
        poolSizeMin: 1,
        poolSizeMax: 10,
        emptyTakeRace: 2,
        tokenTtlMs: 60_000,
        refillIntervalMs: 60_000,
        staggerMs: 0,
        solveRetries: 1,
        solveConcurrency: 4,
        scaleDownIdleMs: 600_000,
        deepIdleAfterMs: 600_000,
      });
      // Every solve fails at first — a full storm.
      solveMock.mockImplementation(async () => {
        throw new Error("captcha solve stall pe=pe.099.storm.js");
      });
      const takePromise = pool.takeToken(CFG);
      // Mid-storm, a refill wave succeeds and banks a token.
      const pushTimer = setTimeout(() => {
        const p = pool as unknown as { pushToken: (s: string) => void };
        p.pushToken(`storm-rescue:${"g".repeat(48)}`);
      }, 400);
      const param = await takePromise;
      clearTimeout(pushTimer);
      expect(param).toContain("storm-rescue");
    } finally {
      delete process.env.CAPTCHA_TAKE_GRACE_MS;
    }
  });

  it("fires the IP reset once when a mint storm is detected (no successes)", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 10,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 600_000,
    });
    const fired: string[] = [];
    (pool as unknown as { opts: { onCaptchaIpBlock?: (r: string) => void } }).opts.onCaptchaIpBlock =
      (reason) => fired.push(reason);

    const p = pool as unknown as {
      noteMintFailure: (r: string) => void;
      noteMintSuccess: () => void;
    };
    // 7 failures: below threshold — no fire.
    for (let i = 0; i < 7; i++) p.noteMintFailure("captcha solve stall pe=x.js");
    expect(fired.length).toBe(0);
    // 8th failure crosses the threshold with zero successes — fires.
    p.noteMintFailure("captcha solve stall pe=x.js");
    expect(fired.length).toBe(1);
    expect(fired[0]).toContain("mint storm");
    // Cooldown: more failures do not re-fire immediately.
    for (let i = 0; i < 5; i++) p.noteMintFailure("captcha solve stall pe=x.js");
    expect(fired.length).toBe(1);

    // A success inside the window suppresses the trigger entirely.
    const poolB = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 10,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 600_000,
    });
    const fired2: string[] = [];
    (poolB as unknown as { opts: { onCaptchaIpBlock?: (r: string) => void } }).opts.onCaptchaIpBlock =
      (reason) => fired2.push(reason);
    const p2 = poolB as unknown as {
      noteMintFailure: (r: string) => void;
      noteMintSuccess: () => void;
    };
    p2.noteMintSuccess();
    for (let i = 0; i < 10; i++) p2.noteMintFailure("stall");
    expect(fired2.length).toBe(0);
  });
});

describe("CaptchaTokenPool mint breaker + backoff (v0.3.6.2)", () => {
  beforeEach(() => {
    process.env.ZCODE_CAPTCHA_SKIP_DEPS = "1";
    solveMock.mockReset();
    solveMock.mockImplementation(async () => "x".repeat(64));
  });
  afterEach(() => {
    delete process.env.ZCODE_CAPTCHA_SKIP_DEPS;
    delete process.env.CAPTCHA_TAKE_GRACE_MS;
    pool?.stopBackgroundRefill?.();
  });

  it("parks background solving after consecutive all-failed waves", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 4,
      poolSizeMax: 4,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 2,
      scaleDownIdleMs: 600_000,
      // Fast-forward the breaker for the test.
      breakerStreak: 2,
      breakerCooldownsMs: [5_000, 10_000],
    });
    solveMock.mockImplementation(async () => {
      throw new Error("captcha solve stall pe=pe.099.storm.js");
    });
    await pool.prefill(CFG);
    // Two all-failed waves → breaker trips → prefill exits without spinning.
    const stats = pool.stats();
    expect(stats.ready).toBe(0);
    const p = pool as unknown as { pausedUntil: number };
    expect(p.pausedUntil).toBeGreaterThan(Date.now());
    // Wave solve count is bounded: 2 waves × wave size ≤ solveConcurrency×2.
    expect(solveMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("stops subsequent waves while parked (refill timer respected)", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 2,
      poolSizeMax: 2,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 600_000,
      breakerStreak: 1,
      breakerCooldownsMs: [60_000],
    });
    solveMock.mockImplementation(async () => {
      throw new Error("mint broken");
    });
    await pool.prefill(CFG);
    solveMock.mockClear();
    // A background refill tick during the park must not fire any solve.
    await (pool as unknown as { refill: (o: { urgent: boolean }) => Promise<void> }).refill({ urgent: false });
    expect(solveMock.mock.calls.length).toBe(0);
  });

  it("on-demand takeToken still solves while the breaker is parked", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 2,
      poolSizeMax: 2,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 1,
      emptyTakeRace: 1,
      scaleDownIdleMs: 600_000,
      breakerStreak: 1,
      breakerCooldownsMs: [60_000],
    });
    let fail = true;
    solveMock.mockImplementation(async () => {
      if (fail) throw new Error("mint broken");
      return "ondemand:" + "y".repeat(56);
    });
    await pool.prefill(CFG); // trips the breaker immediately
    fail = false;
    // A live user request must still be served by the direct raced solve.
    const param = await pool.takeToken(CFG);
    expect(param.startsWith("ondemand:")).toBe(true);
  });

  it("escalates the cooldown ladder on repeated trips and resets on success", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 2,
      poolSizeMax: 2,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 600_000,
      breakerStreak: 1,
      breakerCooldownsMs: [1_000, 5_000, 9_000],
    });
    solveMock.mockImplementation(async () => {
      throw new Error("mint broken");
    });
    const p = pool as unknown as {
      pausedUntil: number;
      failWaveStreak: number;
      breakerCooldownIdx: number;
      noteAllFailedWave: (r: string) => void;
      pushToken: (s: string) => void;
    };
    const t0 = Date.now();
    p.noteAllFailedWave("a");
    expect(p.pausedUntil).toBeGreaterThanOrEqual(t0 + 1_000);
    expect(p.pausedUntil).toBeLessThan(t0 + 5_000);
    p.noteAllFailedWave("b");
    expect(p.pausedUntil).toBeGreaterThanOrEqual(t0 + 5_000);
    p.noteAllFailedWave("c");
    expect(p.pausedUntil).toBeGreaterThanOrEqual(t0 + 9_000); // schedule cap
    p.noteAllFailedWave("d");
    expect(p.pausedUntil).toBeGreaterThanOrEqual(t0 + 9_000); // stays capped
    // A banked token resets the ladder for FUTURE trips.
    p.pushToken(Buffer.from(JSON.stringify({ certifyId: "brk-ok", sceneId: "s", isSign: true, securityToken: "x" })).toString("base64"));
    expect(p.failWaveStreak).toBe(0);
    expect(p.breakerCooldownIdx).toBe(0);
  });

  it("backs off exponentially between solve attempts inside one chain", async () => {
    process.env.CAPTCHA_TAKE_GRACE_MS = "1"; // skip the 10s empty-pool grace wait
    pool = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 3,
      solveConcurrency: 1,
      emptyTakeRace: 1,
      scaleDownIdleMs: 600_000,
      solveBackoffBaseMs: 60,
      solveBackoffCapMs: 200,
      breakerStreak: 99,
      breakerCooldownsMs: [60_000],
    });
    solveMock.mockImplementation(async () => {
      throw new Error("pe stall");
    });
    const t0 = Date.now();
    await expect(
      (pool as unknown as { solveFresh: (c: unknown) => Promise<string> }).solveFresh(CFG),
    ).rejects.toThrow();
    const elapsed = Date.now() - t0;
    // 3 attempts → waits of 60ms (attempt 2) + 120ms (attempt 3) ≥ 180ms.
    expect(elapsed).toBeGreaterThanOrEqual(170);
    expect(solveMock.mock.calls.length).toBe(3);
  });

  it("backoff 0 keeps retries immediate (opt-out preserved)", async () => {
    process.env.CAPTCHA_TAKE_GRACE_MS = "1"; // skip the 10s empty-pool grace wait
    pool = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 2,
      solveConcurrency: 1,
      emptyTakeRace: 1,
      scaleDownIdleMs: 600_000,
      solveBackoffBaseMs: 0,
      breakerStreak: 99,
      breakerCooldownsMs: [60_000],
    });
    solveMock.mockImplementation(async () => {
      throw new Error("pe stall");
    });
    const t0 = Date.now();
    await expect(
      (pool as unknown as { solveFresh: (c: unknown) => Promise<string> }).solveFresh(CFG),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(solveMock.mock.calls.length).toBe(2);
  });

  it("bounds both background and urgent refill to one wave", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 8,
      poolSizeMax: 8,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 8,
      bgSolveConcurrency: 2,
      cpuLimitPercent: 0, // disable the governor so the pool's own caps are observable
      scaleDownIdleMs: 600_000,
    });
    (pool as unknown as { cfg: unknown }).cfg = CFG; // refill() no-ops without a config
    let inFlight = 0;
    let maxInFlight = 0;
    solveMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return "bg:" + "z".repeat(60);
    });
    await (pool as unknown as { refill: (o: { urgent: boolean }) => Promise<void> }).refill({ urgent: false });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(pool.stats().ready).toBe(2);

    // Urgent means "schedule now", not "monopolize until the pool is full".
    (pool as unknown as { tokens: unknown[] }).tokens = [];
    inFlight = 0;
    maxInFlight = 0;
    await (pool as unknown as { refill: (o: { urgent: boolean }) => Promise<void> }).refill({ urgent: true });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(pool.stats().ready).toBe(2);
  });

  it("does not enqueue background refill while a live token solve is active", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 3,
      poolSizeMax: 3,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      solveRetries: 1,
      solveConcurrency: 1,
      bgSolveConcurrency: 1,
      cpuLimitPercent: 0,
      scaleDownIdleMs: 600_000,
    });
    (pool as unknown as { cfg: unknown }).cfg = CFG;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    solveMock.mockImplementation(async () => {
      await gate;
      return "live:" + "x".repeat(60);
    });

    const liveTake = pool.takeToken(CFG);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(solveMock).toHaveBeenCalledTimes(1);
    await (pool as unknown as { refill: (o: { urgent: boolean }) => Promise<void> }).refill({ urgent: false });
    expect(solveMock).toHaveBeenCalledTimes(1);
    release();
    await liveTake;
  });
});
