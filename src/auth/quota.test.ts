/**
 * Tests for upstream quota / balance query.
 * @see src/auth/quota.ts
 */
import { describe, it, expect, mock } from "bun:test";
import { queryQuota } from "./quota.js";
import type { Credential } from "./types.js";

function jsonResp(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Build a mock fetch that routes by URL substring, capturing the auth header. */
function mockFetch(
  routes: Record<string, (req?: { headers: Record<string, string> }) => Response>,
  captured?: { headers: Record<string, string>; url: string }[],
) {
  return (mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    captured?.push({ url, headers });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler({ headers });
    }
    return new Response("not found", { status: 404 });
  }) as unknown) as typeof fetch;
}

const START_PLAN_CRED: Credential = {
  apiKey: "ignored-for-start-plan",
  provider: "zai",
  plan: "start-plan",
  jwt: "theJwtToken",
  userId: "u1",
};

const ZAI_CODING_CRED: Credential = {
  apiKey: "ak",
  secret: "sec",
  provider: "zai",
  plan: "coding-plan",
};

const BIGMODEL_CODING_CRED: Credential = {
  apiKey: "bm-key",
  provider: "bigmodel",
  plan: "coding-plan",
};

describe("queryQuota — start-plan", () => {
  it("sends the real-client identity header set (UA + X-ZCode-App-Version) on billing calls", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "billing/balance": () =>
          jsonResp({
            plans: [{ name: "Start Plan", plan_id: "start-plan", status: "active" }],
            balances: [{ entitlement_id: "ent1", total_units: 10, remaining_units: 5 }],
          }),
      },
      captured,
    );

    await queryQuota(START_PLAN_CRED, fetchImpl, "3.9.2");
    expect(captured.length).toBeGreaterThan(0);
    // v0.3.1: billing requests must never go out bare — the desktop client
    // always presents its identity headers (anti-WAF fingerprint).
    expect(captured.every((c) => c.headers["User-Agent"] === "ZCode/3.9.2")).toBe(true);
    expect(captured.every((c) => c.headers["X-ZCode-App-Version"] === "3.9.2")).toBe(true);
    expect(captured.every((c) => typeof c.headers["X-Title"] === "string" && c.headers["X-Title"].length > 0)).toBe(true);
    expect(captured.every((c) => c.headers["Authorization"] === "Bearer theJwtToken")).toBe(true);
  });

  it("uses the passed identity (not just appVersion) for header construction", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "billing/balance": () =>
          jsonResp({
            plans: [{ name: "Start Plan", plan_id: "start-plan", status: "active" }],
            balances: [],
          }),
      },
      captured,
    );

    await queryQuota(START_PLAN_CRED, fetchImpl, "3.9.2", {
      appVersion: "3.9.2",
      sourceTitle: "custom-title",
      refererOrigin: "https://zcode.z.ai",
    });
    expect(captured[0].headers["X-Title"]).toBe("Z Code@custom-title");
  });

  it("aggregates remaining + plan name + expiry from the ZCode 3.2.5 billing/balance envelope", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "billing/balance": () =>
          jsonResp({
            plans: [
              { name: "Coding Pro", plan_id: "pro", status: "active" },
              { name: "Start Plan", plan_id: "start-plan", status: "active", ends_at: 1799000000 },
            ],
            balances: [
              { entitlement_id: "ent1", show_name: "时长", total_units: 100, used_units: 30, remaining_units: 70 },
              { entitlement_id: "ent2", show_name: "请求", total_units: 200, used_units: 50, remaining_units: 150 },
            ],
          }),
      },
      captured,
    );

    const result = await queryQuota(START_PLAN_CRED, fetchImpl, "2.1.0");
    expect(result.plan).toBe("start-plan");
    expect(result.remaining).toEqual({ count: 220, total: 300, percentage: 73.3 });
    expect(result.planName).toBe("Start Plan");
    expect(result.expireTime).toBe(1799000000);
    expect(result.limits).toHaveLength(2);
    // start-plan billing auth mirrors current ZCode desktop: Bearer JWT.
    expect(captured.every((c) => c.headers["Authorization"] === "Bearer theJwtToken")).toBe(true);
    expect(captured.every((c) => c.url.includes("app_version=2.1.0"))).toBe(true);
    expect(captured.some((c) => c.url.includes("billing/current"))).toBe(false);
  });

  it("falls back to billing/current when an old billing/balance response has no plans", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "billing/balance": () =>
          jsonResp({
            balances: [
              { entitlement_id: "ent1", show_name: "时长", total_units: 100, used_units: 30, remaining_units: 70 },
            ],
          }),
        "billing/current": () =>
          jsonResp({
            plans: [
              { name: "Start Plan", plan_id: "start-plan", status: "active", ends_at: 1799000000 },
            ],
          }),
      },
      captured,
    );

    const result = await queryQuota(START_PLAN_CRED, fetchImpl, "2.1.0");
    expect(result.planName).toBe("Start Plan");
    expect(result.remaining).toEqual({ count: 70, total: 100, percentage: 70 });
    expect(captured.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v1/zcode-plan/billing/balance",
      "/api/v1/zcode-plan/billing/current",
    ]);
  });

  it("returns no_plan when no active start plan is present", async () => {
    const fetchImpl = mockFetch({
      "billing/current": () => jsonResp({ plans: [{ name: "Other", status: "expired" }] }),
      "billing/balance": () => jsonResp({ balances: [] }),
    });
    const result = await queryQuota(START_PLAN_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("no_plan");
    expect(result.remaining).toBeNull();
  });

  it("returns unavailable when balance call returns non-zero code", async () => {
    const fetchImpl = mockFetch({
      "billing/balance": () => jsonResp({ unused: true }, 5000),
    });
    const result = await queryQuota(START_PLAN_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("unavailable");
    expect(result.planName).toBeNull();
  });

  it("returns unavailable when current call throws (network)", async () => {
    const fetchImpl = mockFetch({
      "billing/current": () => new Response("boom", { status: 502 }),
      "billing/balance": () => jsonResp({ balances: [] }),
    });
    const result = await queryQuota(START_PLAN_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("unavailable");
  });

  it("falls back to coding-plan path when start-plan has no jwt", async () => {
    const noJwt: Credential = { ...START_PLAN_CRED, jwt: undefined };
    const fetchImpl = mockFetch({
      "quota/limit": () => new Response(JSON.stringify({ code: 200, data: { level: "free", limits: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const result = await queryQuota(noJwt, fetchImpl);
    // routed through the coding-plan path (api.z.ai), not zcode.z.ai, so the
    // reported plan reflects the path actually queried.
    expect(result.plan).toBe("coding-plan");
    expect(result.planName).toBe("free");
    expect(result.unavailableReason).toBeUndefined();
  });

  it("treats a blank start-plan jwt as missing and avoids billing calls", async () => {
    const blankJwt: Credential = { ...START_PLAN_CRED, jwt: "   " };
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch({
      "quota/limit": () => new Response(JSON.stringify({ code: 200, data: { level: "free", limits: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "billing/current": () => {
        throw new Error("billing should not be called");
      },
    }, captured);
    const result = await queryQuota(blankJwt, fetchImpl);
    expect(result.plan).toBe("coding-plan");
    expect(result.planName).toBe("free");
    expect(captured.some((c) => c.url.includes("billing/current"))).toBe(false);
  });
});

describe("queryQuota — coding-plan", () => {
  it("maps limits + level and uses apiKey.secret auth for zai", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "api.z.ai/api/monitor/usage/quota/limit": () =>
          new Response(
            JSON.stringify({
              code: 200,
              data: {
                level: "team",
                limits: [
                  { type: "TIME_LIMIT", number: 1000, usage: 400, remaining: 600, unit: 1, nextResetTime: 1800000000 },
                  { type: "COUNT", number: 500, usage: 100, remaining: 400 },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
      captured,
    );

    const result = await queryQuota(ZAI_CODING_CRED, fetchImpl);
    expect(result.planName).toBe("team");
    expect(result.limits).toHaveLength(2);
    // zai auth = apiKey.secret (the credentialString)
    expect(captured[0].headers["authorization"]).toBe("ak.sec");
    // TIME_LIMIT is the primary limit
    const timeLimit = result.limits.find((l) => l.type === "TIME_LIMIT");
    expect(timeLimit?.remaining).toBe(600);
    // aggregate uses both entries with total/remaining
    expect(result.remaining).toEqual({ count: 1000, total: 1500, percentage: 66.7 });
  });

  it("uses bare apiKey auth for bigmodel and the bigmodel host", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "bigmodel.cn/api/monitor/usage/quota/limit": () =>
          new Response(JSON.stringify({ code: 200, data: { level: "pro", limits: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      captured,
    );
    const result = await queryQuota(BIGMODEL_CODING_CRED, fetchImpl);
    expect(result.planName).toBe("pro");
    expect(captured[0].headers["authorization"]).toBe("bm-key");
    expect(captured[0].url).toContain("open.bigmodel.cn");
  });

  it("maps a coding-plan 'no plan' message to no_plan", async () => {
    const fetchImpl = mockFetch({
      "quota/limit": () =>
        new Response(JSON.stringify({ code: 400, msg: "不存在coding plan" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await queryQuota(ZAI_CODING_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("no_plan");
    expect(result.remaining).toBeNull();
  });

  it("returns unavailable on a non-200 upstream code with data", async () => {
    const fetchImpl = mockFetch({
      "quota/limit": () =>
        new Response(JSON.stringify({ code: 401, msg: "unauthorized" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await queryQuota(ZAI_CODING_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("unavailable");
  });

  it("returns unavailable when the request throws", async () => {
    const fetchImpl = (mock(async () => {
      throw new Error("network down");
    }) as unknown) as typeof fetch;
    const result = await queryQuota(ZAI_CODING_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("unavailable");
  });

  it("returns unavailable for oversized JSON without reading the body", async () => {
    let canceled = false;
    const fetchImpl = mockFetch({
      "quota/limit": () =>
        new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            canceled = true;
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024 + 1),
          },
        }),
    });

    const result = await queryQuota(ZAI_CODING_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("unavailable");
    expect(canceled).toBe(true);
  });

  it("returns unavailable when the quota response body stalls after headers", async () => {
    const originalSetTimeout = globalThis.setTimeout as any;
    let canceled = false;
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      return originalSetTimeout(handler, timeout === 15_000 ? 5 : timeout, ...args);
    };
    const keepAlive = setInterval(() => {}, 1);

    try {
      const fetchImpl = mockFetch({
        "quota/limit": () =>
          new Response(new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {});
            },
            cancel() {
              canceled = true;
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });

      const result = await queryQuota(ZAI_CODING_CRED, fetchImpl);
      expect(result.unavailableReason).toBe("unavailable");
      expect(canceled).toBe(true);
    } finally {
      clearInterval(keepAlive);
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("unrefs quota request timeout timers", async () => {
    const originalSetTimeout = globalThis.setTimeout as any;
    const unrefDelays: number[] = [];
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args) as any;
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefDelays.push(Number(timeout));
        return originalUnref?.();
      };
      return timer;
    };

    try {
      const fetchImpl = mockFetch({
        "quota/limit": () =>
          new Response(JSON.stringify({ code: 200, data: { level: "team", limits: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
      await queryQuota(ZAI_CODING_CRED, fetchImpl);
      expect(unrefDelays).toContain(15_000);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });
});
