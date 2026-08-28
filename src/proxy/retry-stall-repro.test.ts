/**
 * Regression tests for the "two concurrent 429 requests, then stuck for many
 * minutes" scenario reported against v0.3.10.8.
 *
 * User-visible symptom (log excerpt):
 *   #001 >>> POST /v1/messages (anthropic)
 *   #001 start-plan captcha preflight enabled: refreshing runtime headers...
 *   #002 >>> POST /v1/messages (anthropic)
 *   #002 start-plan captcha preflight enabled: refreshing runtime headers...
 *   #001 upstream returned 429, retry 1/20 in 1136ms...
 *   #002 upstream returned 429, retry 1/20 in 1226ms...
 *   #001 upstream returned 429, retry 2/20 in 2471ms...
 *   ... (silence — client hangs for many minutes)
 *
 * Root causes fixed by v0.3.10.9 (asserted here):
 *   A. No wall-clock budget on the retry loop — maxRetries=20 plus per-retry
 *      captcha takes (25s race + 10s grace when the pool is starved) could
 *      hold a client silent for 10+ minutes. Fix: retry.totalDeadlineMs.
 *   B. Retry-path captcha preflight failures were misclassified as transient
 *      network errors, so the loop burned EVERY remaining attempt waiting on
 *      a dead mint. Fix: fail fast with 503 captcha_failed (mirrors the
 *      initial-preflight path).
 */
import { describe, it, expect, mock } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

function makeStartPlanConfig(overrides: Partial<ProxyConfig["retry"]> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "oauth" },
    provider: "zai",
    plan: "start-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    logging: { level: "info" },
    retry: {
      maxRetries: 20,
      initialDelayMs: 1,
      maxDelayMs: 2,
      backoffFactor: 1,
      retryableStatuses: [529, 429],
      credentialSwitchThreshold: 0,
      emptyStreamSwitchThreshold: 3,
      totalDeadlineMs: 0,
      ...overrides,
    },
  };
}

function makeClientReq(): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-4.6",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
    }),
  });
}

function makeAuth(): AuthManager {
  const auth = new AuthManager({ mode: "oauth", provider: "zai" });
  auth.setOAuthCredential({ apiKey: "dummy", provider: "zai", jwt: "jwt-mock" });
  return auth;
}

function rateLimited429(): Response {
  return new Response(
    JSON.stringify({ error: { type: "rate_limit_error", message: "model admission concurrency limit exceeded" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

describe("429 retry + starved captcha pool (fixed behavior)", () => {
  const originalPreflight = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
  const originalTakeMs = process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;

  it("B: retry-path captcha preflight failure fails fast with 503 instead of grinding all retries", async () => {
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = "1200"; // retry take wait cap

    try {
      const config = makeStartPlanConfig(); // maxRetries=20, deadline disabled
      const auth = makeAuth();

      let takes = 0;
      // Warm pool for the initial preflight, then the pool starves: every
      // retry-path take misses the (short) deadline and throws — this is what
      // the real pool does once its race deadline + grace window expire.
      const captchaTokenProvider = mock(async () => {
        takes += 1;
        if (takes === 1) {
          return { verifyParam: "warm-token", region: "sgp", solveMs: 1 };
        }
        throw new Error("captcha take deadline (1200ms)");
      });

      let fetches = 0;
      const fetchMock = mock(async (): Promise<Response> => {
        fetches += 1;
        return rateLimited429();
      });

      const started = Date.now();
      const resp = await proxyRequest(makeClientReq(), "anthropic", {
        config,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider: captchaTokenProvider as any,
      });
      const elapsedMs = Date.now() - started;

      // FIXED: the first retry's preflight failure ends the request with a
      // clean 503 + Retry-After — NOT 20 iterations of silent grinding.
      expect(resp.status).toBe(503);
      expect(resp.headers.get("retry-after")).toBe("10");
      const body = await resp.json();
      expect(body.error.type).toBe("captcha_failed");
      // 1 initial preflight + 1 failed retry preflight = 2 takes, not 21.
      expect(takes).toBe(2);
      expect(fetches).toBe(1); // only the initial model attempt fired
      // Bounded wait — no sleep-then-grind.
      expect(elapsedMs).toBeLessThan(2_500);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalTakeMs === undefined) delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;
      else process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = originalTakeMs;
    }
  });

  it("A: retry loop respects the total wall-clock deadline with a clean 503", async () => {
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;

    try {
      // Warm captcha pool (takes are instant) but a total deadline of 600ms:
      // every attempt 429s, so only the deadline can end the loop. Backoff of
      // 100ms/attempt means the 20-attempt budget would otherwise outlast
      // the deadline by ~2s — the deadline must fire first.
      const config = makeStartPlanConfig({ totalDeadlineMs: 600, initialDelayMs: 100, maxDelayMs: 100 });
      const auth = makeAuth();

      const captchaTokenProvider = mock(async () => ({
        verifyParam: "warm-token", region: "sgp", solveMs: 1,
      }));
      let fetches = 0;
      const fetchMock = mock(async (): Promise<Response> => {
        fetches += 1;
        return rateLimited429();
      });

      const started = Date.now();
      const resp = await proxyRequest(makeClientReq(), "anthropic", {
        config,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider: captchaTokenProvider as any,
      });
      const elapsedMs = Date.now() - started;

      expect(resp.status).toBe(503);
      expect(resp.headers.get("retry-after")).toBe("30");
      const body = await resp.json();
      expect(body.error.type).toBe("retry_deadline_exceeded");
      // The loop ran for at least the deadline, but did NOT grind through
      // all 20 attempts (which would need ~20 × 100ms + overheads ≈ 2s+).
      expect(elapsedMs).toBeGreaterThanOrEqual(550);
      expect(elapsedMs).toBeLessThan(1_500);
      expect(fetches).toBeLessThan(20);
      expect(fetches).toBeGreaterThan(1);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalTakeMs === undefined) delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;
      else process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = originalTakeMs;
    }
  });

  it("v0.3.10.11: captcha pre-take overlaps the backoff sleep — retry fires at max(backoff, take), not backoff+take", async () => {
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;

    try {
      // Backoff 700ms; the retry-path captcha take needs 1200ms (cold pool
      // mint). The OLD serial flow slept 700ms FIRST and only then started
      // the take: 700 + 1200 = 1900ms before the retried fetch could fire.
      // The parallel pre-take must run the mint DURING the backoff, so the
      // retry fires at ~max(700, 1200) = 1200ms.
      const config = makeStartPlanConfig({
        maxRetries: 1,
        initialDelayMs: 700,
        maxDelayMs: 700,
        backoffFactor: 1,
        totalDeadlineMs: 60_000,
      });
      const auth = makeAuth();

      let takes = 0;
      const captchaTokenProvider = mock(async () => {
        takes += 1;
        if (takes === 1) {
          // Initial preflight: warm token, instant.
          return { verifyParam: "warm-token", region: "sgp", solveMs: 1 };
        }
        // Retry pre-take: cold mint takes 1200ms.
        await new Promise((r) => setTimeout(r, 1_200));
        return { verifyParam: "cold-token", region: "sgp", solveMs: 1_200 };
      });

      let fetches = 0;
      const fetchMock = mock(async (): Promise<Response> => {
        fetches += 1;
        if (fetches === 1) return rateLimited429();
        return new Response(
          JSON.stringify({
            id: "msg_overlap_ok",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "recovered with overlapped take" }],
            model: "glm-4.6",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const started = Date.now();
      const resp = await proxyRequest(makeClientReq(), "anthropic", {
        config,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider: captchaTokenProvider as any,
      });
      const elapsedMs = Date.now() - started;

      expect(resp.status).toBe(200);
      expect(fetches).toBe(2); // initial 429 attempt + one retried attempt
      expect(takes).toBe(2); // initial preflight + one retry pre-take
      const body = await resp.json();
      expect(body.content[0].text).toBe("recovered with overlapped take");
      // The 1200ms mint dominates and the 700ms backoff overlapped it. The
      // pre-fix serial flow could not finish before ~1900ms; the parallel
      // flow lands shortly after the mint completes.
      expect(elapsedMs).toBeGreaterThanOrEqual(1_150);
      expect(elapsedMs).toBeLessThan(1_700);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalTakeMs === undefined) delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;
      else process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = originalTakeMs;
    }
  });

  it("v0.3.10.11: warm-pool retries fire at backoff expiry with zero added captcha wait", async () => {
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;

    try {
      // Warm pool: every take is instant. The retry must fire at (roughly)
      // exactly the backoff delay — the take adds no measurable wall time.
      // This is the user's expectation: "失败了就重试" without extra lag.
      const config = makeStartPlanConfig({
        maxRetries: 1,
        initialDelayMs: 600,
        maxDelayMs: 600,
        backoffFactor: 1,
        totalDeadlineMs: 60_000,
      });
      const auth = makeAuth();

      const captchaTokenProvider = mock(async () => ({
        verifyParam: "warm-token", region: "sgp", solveMs: 1,
      }));
      let fetches = 0;
      const fetchMock = mock(async (): Promise<Response> => {
        fetches += 1;
        if (fetches === 1) return rateLimited429();
        return new Response(
          JSON.stringify({
            id: "msg_warm_ok",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "warm retry ok" }],
            model: "glm-4.6",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const started = Date.now();
      const resp = await proxyRequest(makeClientReq(), "anthropic", {
        config,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider: captchaTokenProvider as any,
      });
      const elapsedMs = Date.now() - started;

      expect(resp.status).toBe(200);
      expect(fetches).toBe(2);
      // Backoff is 600ms + up to 25% jitter (≤750ms) + test overheads. The
      // take is instant, so nothing beyond the backoff window may accumulate.
      expect(elapsedMs).toBeGreaterThanOrEqual(550);
      expect(elapsedMs).toBeLessThan(1_100);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalTakeMs === undefined) delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;
      else process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = originalTakeMs;
    }
  });

  it("two concurrent 429 requests both return bounded failures (no infinite parallel grind)", async () => {
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = "1200";

    try {
      // Pool has exactly two warm tokens (one per request), then starves and
      // rejects takes immediately — the reported scenario shape.
      const config = makeStartPlanConfig({ totalDeadlineMs: 800 });
      const auth = makeAuth();

      let takes = 0;
      const captchaTokenProvider = mock(async () => {
        takes += 1;
        if (takes <= 2) {
          return { verifyParam: `warm-${takes}`, region: "sgp", solveMs: 1 };
        }
        throw new Error("captcha take deadline (1200ms)");
      });

      const fetchMock = mock(async (): Promise<Response> => rateLimited429());

      const started = Date.now();
      const [r1, r2] = await Promise.all([
        proxyRequest(makeClientReq(), "anthropic", { config, auth, fetchImpl: fetchMock as any, captchaTokenProvider: captchaTokenProvider as any }),
        proxyRequest(makeClientReq(), "anthropic", { config, auth, fetchImpl: fetchMock as any, captchaTokenProvider: captchaTokenProvider as any }),
      ]);
      const elapsedMs = Date.now() - started;

      // Both requests end with a bounded, actionable error (either the
      // captcha fast-fail or the deadline), never an endless grind.
      for (const r of [r1, r2]) {
        expect([503]).toContain(r.status);
        const body = await r.json();
        expect(["captcha_failed", "retry_deadline_exceeded"]).toContain(body.error.type);
      }
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalTakeMs === undefined) delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;
      else process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = originalTakeMs;
    }
  });

  it("healthy warm pool retries still succeed through to a 200 (fixes do not break the happy path)", async () => {
    delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
    delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;

    try {
      const config = makeStartPlanConfig({ totalDeadlineMs: 60_000 });
      const auth = makeAuth();

      const captchaTokenProvider = mock(async () => ({
        verifyParam: "warm-token", region: "sgp", solveMs: 1,
      }));
      let fetches = 0;
      const fetchMock = mock(async (): Promise<Response> => {
        fetches += 1;
        if (fetches <= 2) return rateLimited429();
        return new Response(
          JSON.stringify({
            id: "msg_ok",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "recovered after 429s" }],
            model: "glm-4.6",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const resp = await proxyRequest(makeClientReq(), "anthropic", {
        config,
        auth,
        fetchImpl: fetchMock as any,
        captchaTokenProvider: captchaTokenProvider as any,
      });

      expect(resp.status).toBe(200);
      expect(fetches).toBe(3); // initial + 2 retried attempts, then success
      const body = await resp.json();
      expect(body.content[0].text).toBe("recovered after 429s");
    } finally {
      if (originalPreflight === undefined) delete process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT;
      else process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT = originalPreflight;
      if (originalTakeMs === undefined) delete process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS;
      else process.env.ZCODE_STARTPLAN_RETRY_TAKE_MS = originalTakeMs;
    }
  });
});
