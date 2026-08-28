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
