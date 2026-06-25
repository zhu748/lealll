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
  it("aggregates remaining + plan name + expiry when both billing calls succeed", async () => {
    const captured: { headers: Record<string, string>; url: string }[] = [];
    const fetchImpl = mockFetch(
      {
        "billing/current": () =>
          jsonResp({
            plans: [
              { name: "Coding Pro", plan_id: "pro", status: "active" },
              { name: "Start Plan", plan_id: "start", status: "active", ends_at: 1799000000 },
            ],
          }),
        "billing/balance": () =>
          jsonResp({
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
    // start-plan auth = raw jwt, no Bearer; app_version query must be present
    expect(captured.every((c) => c.headers["Authorization"] === "theJwtToken")).toBe(true);
    expect(captured.every((c) => c.url.includes("app_version=2.1.0"))).toBe(true);
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
      "billing/current": () => jsonResp({ plans: [{ name: "Start Plan", status: "active", ends_at: "2026-07-01" }] }),
      "billing/balance": () => jsonResp({ unused: true }, 5000),
    });
    const result = await queryQuota(START_PLAN_CRED, fetchImpl);
    expect(result.unavailableReason).toBe("unavailable");
    // current still resolved, so plan name/expiry are surfaced
    expect(result.planName).toBe("Start Plan");
    expect(result.expireTime).toBe("2026-07-01");
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
});
