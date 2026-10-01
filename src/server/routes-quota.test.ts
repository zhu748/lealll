/**
 * Regression tests for the GET /quota billing snapshot (routes-quota.ts).
 *
 * Covers the review round for PR #41 commit 66959ae:
 *  - the platform/arch fingerprint must be built from real values with env
 *    overrides (never `identity.platform/arch` → "undefined-undefined");
 *  - empty/whitespace env overrides fall back instead of producing `-x64`;
 *  - both billing calls share the same fingerprint;
 *  - upstream snake_case and live-observed camelCase balance fields both map;
 *  - non-numeric / NaN values never leak into the JSON snapshot.
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";
import { collectQuotaSnapshot, handleQuota } from "./routes-quota.js";
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: {},
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
    async: {
      enabled: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 100,
      controlTimeoutMs: 1000,
      defaultModel: "",
    },
    claim: { enabled: false, auto: true, origin: "https://billing.example", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

/** Minimal valid start-plan JWT payload (iat only, no exp). */
const IAT = Math.floor(Date.now() / 1000) - 8 * 24 * 3600; // 8 days old, still valid per jwt-age.ts docs
function makeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ iat: IAT })).toString("base64url");
  return `h.${payload}.s`;
}

const fakeCred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt: makeJwt() };
const loadFake = async (): Promise<Credential> => fakeCred;
const loadNone = async (): Promise<Credential | null> => null;

interface BillingCall {
  url: string;
  headers: Record<string, string>;
}

/** Mock fetch that records billing/monitor calls and answers all three endpoints. */
function makeBillingFetch(opts: {
  code?: number;
  body?: unknown;
  /** Monitor-plane (coding) envelope data; defaults to an empty limits list. */
  codingBody?: unknown;
  codingCode?: number;
  /** Simulate monitor-endpoint network/HTTP failure. */
  codingFail?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: BillingCall[] } {
  const calls: BillingCall[] = [];
  const record = (u: string, init?: RequestInit): void => {
    calls.push({ url: u, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/monitor/usage/quota/limit")) {
      record(u, init);
      if (opts.codingFail) return new Response("upstream exploded", { status: 500 });
      const code = opts.codingCode ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.codingBody ?? { level: "max", limits: [] } }), { status: 200 });
    }
    if (u.includes("/api/v1/zcode-plan/billing/")) {
      record(u, init);
      const code = opts.code ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.body ?? { server_time: 1720000000, balances: [], plans: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", message: u } }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Calls to one plane, in request order. */
function planeCalls(calls: BillingCall[], plane: "billing" | "monitor"): BillingCall[] {
  return calls.filter((c) => c.url.includes(plane === "billing" ? "/api/v1/zcode-plan/billing/" : "/api/monitor/usage/quota/limit"));
}

/** Set/restore identity env overrides around a test body. */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["ZCODE_IDENTITY_PLATFORM", "ZCODE_IDENTITY_ARCH"]) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("collectQuotaSnapshot fingerprint", () => {
  it("no overrides → real platform/arch on billing calls, raw key auth on coding call", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: undefined, ZCODE_IDENTITY_ARCH: undefined }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      const billing = planeCalls(calls, "billing");
      const monitor = planeCalls(calls, "monitor");
      expect(billing.length).toBe(2);
      expect(monitor.length).toBe(1);
      const expected = `${process.platform}-${os.arch()}`;
      expect(snap.errors).toEqual([]);
      for (const c of billing) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe(expected);
        expect(url.searchParams.get("app_version")).toBe("test-1.0.0");
        expect(c.headers["X-Platform"]).toBe(expected);
      }
      expect(billing[0].url).toContain("/billing/balance?");
      expect(billing[1].url).toContain("/billing/preview?");
      // Coding plane mirror: bundle `wK` origin + `md` single raw-key header.
      expect(monitor[0].url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
      expect(monitor[0].headers["authorization"]).toBe("key-x.secret-y");
      expect(monitor[0].headers["accept"]).toBe("application/json");
      expect(monitor[0].headers["X-Platform"]).toBeUndefined();
      expect(snap.codingPlan).toEqual({ level: "max", limits: [] });
    });
  });

  it("valid overrides → billing calls use the overridden fingerprint (coding plane unaffected)", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "linux", ZCODE_IDENTITY_ARCH: "x64" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      for (const c of planeCalls(calls, "billing")) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe("linux-x64");
        expect(c.headers["X-Platform"]).toBe("linux-x64");
      }
    });
  });

  it("empty/whitespace overrides fall back to real values (no `-x64` / `linux-`)", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "  ", ZCODE_IDENTITY_ARCH: "" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      const expected = `${process.platform}-${os.arch()}`;
      for (const c of planeCalls(calls, "billing")) {
        expect(new URL(c.url).searchParams.get("platform")).toBe(expected);
      }
    });
  });

  it("no JWT credential → handleQuota returns 503 quota_unavailable envelope", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    const resp = await handleQuota(makeConfig(), fetchImpl, loadNone);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("quota_unavailable");
    expect(calls.length).toBe(0);
  });

  it("upstream nonzero code surfaces in errors, snapshot still 200", async () => {
    const { fetchImpl } = makeBillingFetch({ code: 3012 });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.errors.length).toBe(2);
    expect(snap.errors[0]).toContain("3012");
  });
});

describe("collectQuotaSnapshot response mapping", () => {
  it("snake_case balance fields map (live-observed shape)", async () => {
    const body = {
      server_time: 1720000100,
      balances: [{ show_name: "Free", total_units: 1000, used_units: 250, remaining_units: 750, unit_type: "token", expires_at: 1735689600 }],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.balances).toEqual([{ showName: "Free", remainingUnits: 750, totalUnits: 1000, usedUnits: 250, unitType: "token", expiresAt: 1735689600 }]);
    expect(snap.serverTime).toBe(1720000100);
  });

  it("camelCase aliases (unitType/expiresAt) map — not silently dropped", async () => {
    const body = {
      server_time: 1720000100,
      balances: [{ show_name: "Free", total_units: 100, used_units: 10, remaining_units: 90, unitType: "token", expiresAt: 1735689600 }],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.balances[0].unitType).toBe("token");
    expect(snap.balances[0].expiresAt).toBe(1735689600);
  });

  it("numeric-string timestamps/units coerce; NaN/garbage never reach the JSON", async () => {
    const body = {
      server_time: "1720000100",
      balances: [
        { show_name: "Free", total_units: "100", used_units: "x", remaining_units: "50", expires_at: "1735689600" },
        { show_name: "Bad", total_units: NaN, used_units: null, remaining_units: 7 },
      ],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.serverTime).toBe(1720000100);
    expect(snap.balances[0].totalUnits).toBe(100);
    expect(snap.balances[0].usedUnits).toBe(0);
    expect(snap.balances[0].expiresAt).toBe(1735689600);
    expect(snap.balances[1].totalUnits).toBe(0); // NaN → undefined → 0, JSON.stringify would emit null
    expect(snap.balances[1].usedUnits).toBe(0);
    expect(snap.balances[1].expiresAt).toBeUndefined();
  });
});

describe("collectQuotaSnapshot coding plane", () => {
  const bigmodelCred: Credential = { apiKey: "bm-key-123", provider: "bigmodel", jwt: makeJwt() };
  const loadBigmodel = async (): Promise<Credential> => bigmodelCred;
  const jwtLessCred: Credential = { apiKey: "key-x.secret-y", provider: "zai" };
  const loadJwtLess = async (): Promise<Credential> => jwtLessCred;

  it("maps level + limits (numeric coercion, snake alias, rows without numbers dropped)", async () => {
    const { fetchImpl } = makeBillingFetch({
      codingBody: {
        level: "max",
        limits: [
          { type: "TIME_LIMIT", number: 120, usage: 84, remaining: 36, percentage: 70, next_reset_time: "1720000000", unit: "prompt" },
          { type: "no-numbers" }, // no numeric fields → display noise, dropped
          { number: 5 }, // no type → dropped (bundle `E_` keeps typed rows only)
          { type: "WEEK_LIMIT", remaining: 500 },
        ],
      },
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.codingPlan).toEqual({
      level: "max",
      limits: [
        { type: "TIME_LIMIT", unit: "prompt", total: 120, used: 84, remaining: 36, percentage: 70, nextResetTime: 1720000000 },
        { type: "WEEK_LIMIT", remaining: 500 },
      ],
    });
  });

  it("code 200 envelope counts as success (bundle `$_` semantics)", async () => {
    const { fetchImpl } = makeBillingFetch({ codingCode: 200, codingBody: { level: "pro", limits: [] } });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.errors).toEqual([]);
    expect(snap.codingPlan).toEqual({ level: "pro", limits: [] });
  });

  it("bigmodel credential → open.bigmodel.cn monitor origin with the raw key", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    await collectQuotaSnapshot(makeConfig({ provider: "bigmodel" }), fetchImpl, loadBigmodel);
    const monitor = planeCalls(calls, "monitor");
    expect(monitor[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(monitor[0].headers["authorization"]).toBe("bm-key-123");
  });

  it("monitor endpoint failure degrades to codingPlan null + errors entry, credits data intact", async () => {
    const { fetchImpl } = makeBillingFetch({
      body: { server_time: 1, balances: [{ show_name: "Free", total_units: 10, remaining_units: 5 }] },
      codingFail: true,
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("coding: 500");
    expect(snap.balances).toHaveLength(1);
  });

  it("nonzero monitor envelope code surfaces in errors, snapshot still resolves", async () => {
    const { fetchImpl } = makeBillingFetch({ codingCode: 3012 });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("coding: 3012");
  });

  it("jwt-less credential still serves the coding plane (billing skipped with a note)", async () => {
    const { fetchImpl, calls } = makeBillingFetch({
      codingBody: { level: null, limits: [{ type: "TIME_LIMIT", remaining: 36, number: 120 }] },
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadJwtLess);
    expect(planeCalls(calls, "billing").length).toBe(0);
    expect(planeCalls(calls, "monitor").length).toBe(1);
    expect(snap.jwt).toBeNull();
    expect(snap.balances).toEqual([]);
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("no plan JWT");
    expect(snap.codingPlan).toEqual({ level: null, limits: [{ type: "TIME_LIMIT", remaining: 36, total: 120 }] });
  });

  it("unusable coding origin → coding plane silently skipped (fail-open)", async () => {
    const cfg = makeConfig();
    cfg.providers.zai.openaiBase = "not a url";
    const { fetchImpl, calls } = makeBillingFetch();
    const snap = await collectQuotaSnapshot(cfg, fetchImpl, loadFake);
    expect(planeCalls(calls, "monitor").length).toBe(0);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /quota/reset — coding-plan reset entitlements (desktop 3.14.4 alignment)
// ---------------------------------------------------------------------------

import { collectResetSnapshot, handleQuotaReset } from "./routes-quota.js";

describe("quota reset snapshot (collectResetSnapshot)", () => {
  // Local jwt-less loader (the coding-plane describe block keeps its own copy).
  const resetJwtLessCred: Credential = { apiKey: "key-x.secret-y", provider: "zai" };
  const loadJwtLessReset = async (): Promise<Credential> => resetJwtLessCred;

  // Dual-token credential: the reset endpoints need jwt + maasToken.
  const resetCred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt: makeJwt(), maasToken: "maas-token" };
  const loadResetCred = async (): Promise<Credential> => resetCred;

  it("maps a successful status envelope to the reset snapshot", async () => {
    const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.endsWith("/api/v1/coding-plan/reset/status")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              available_five_hour_resets: [{ expire_at: 1000 }],
              available_week_resets: [],
              latest_five_hour_reset_history: null,
              latest_week_reset_history: { used_at: 700 },
              has_unread_history: false,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 404 });
    }) as typeof fetch;
    const snap = await collectResetSnapshot(makeConfig(), fetchImpl, loadResetCred);
    expect(snap.available).toBe(true);
    expect(snap.status?.availableFiveHourResets).toEqual([{ expireAt: 1000 }]);
    expect(snap.status?.latestWeekResetHistory).toEqual({ usedAt: 700 });
    expect(snap.reason).toBeUndefined();
  });

  it("credential without dual reset tokens degrades to available:false with a re-login hint", async () => {
    // jwt-less account: the reset client throws ResetAuthMissingError before
    // any network call; the snapshot layer converts it into a soft failure.
    const fetchImpl = (async (_url: string | URL | Request) => {
      throw new Error("network must not be reached");
    }) as unknown as typeof fetch;
    const snap = await collectResetSnapshot(makeConfig(), fetchImpl, loadJwtLessReset);
    expect(snap.available).toBe(false);
    expect(snap.status).toBeNull();
    expect(snap.reason).toBeTruthy();
  });

  it("upstream failure degrades to available:false, reason carries the message", async () => {
    const fetchImpl: typeof fetch = (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ code: 3103, msg: "quota exhausted" }), { status: 200 })) as unknown as typeof fetch;
    const snap = await collectResetSnapshot(makeConfig(), fetchImpl, loadResetCred);
    expect(snap.available).toBe(false);
    // Upstream error reader prefers the server msg over the raw code string.
    expect(snap.reason).toContain("quota exhausted");
  });

  it("handleQuotaReset returns the proxy error envelope when not logged in", async () => {
    const resp = await handleQuotaReset(makeConfig(), fetch, loadNone);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("quota_reset_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Manual claim plan (desktop 3.14.4 alignment): GET /quota/claim snapshot and
// POST /quota/claim submit — backed by the campaign-proven src/claim client.
// ---------------------------------------------------------------------------

import { collectClaimSnapshot, handleQuotaClaim, handleQuotaClaimSubmit } from "./routes-quota.js";

describe("quota claim routes (collectClaimSnapshot / handleQuotaClaim*)", () => {
  const claimCred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt: makeJwt() };
  const loadClaimCred = async (): Promise<Credential> => claimCred;

  /** Upstream billing/preview mock serving one wk-campaign plan. */
  const previewBody = {
    code: 0,
    data: {
      server_time: 1759000000,
      plans: [
        {
          plan_id: "wk-campaign",
          name: "Weekend 100M",
          description: "Limited trial",
          priority: 10,
          starts_at: 1759000000,
          ends_at: 1759100000,
          entitlements: [
            {
              entitlement_id: "ent-1",
              show_name: "GLM-4.6 daily bonus",
              meter: "glm-4.6",
              unit_type: "token",
              capabilities: ["chat"],
              grant_units: 100000000,
              period: "daily",
              priority: 1,
            },
          ],
        },
      ],
    },
  };

  it("collectClaimSnapshot maps the preview envelope to the claim snapshot", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
      calls.push(String(url instanceof Request ? url.url : url));
      return new Response(JSON.stringify(previewBody), { status: 200 });
    }) as unknown as typeof fetch;
    const snap = await collectClaimSnapshot(makeConfig(), fetchImpl, loadClaimCred);
    expect(snap.available).toBe(true);
    expect(snap.plans).toHaveLength(1);
    expect(snap.plans[0]?.planId).toBe("wk-campaign");
    expect(snap.plans[0]?.entitlements[0]?.period).toBe("daily");
    expect(snap.plans[0]?.entitlements[0]?.grantUnits).toBe(100000000);
    // app_version + platform query params (desktop preview contract).
    expect(calls[0]).toContain("/api/v1/zcode-plan/billing/preview?");
    expect(calls[0]).toContain("app_version=test-1.0.0");
    expect(calls[0]).toContain("platform=linux-");
    // X-Device-Mid rides along (campaign gateway requirement).
    const init = (fetchImpl as any).mock;
    void init;
  });

  it("preview 404 (off-season) degrades to available:false with an empty list", async () => {
    const fetchImpl: typeof fetch = (async (_url: string | URL | Request) =>
      new Response("404 page not found", { status: 404 })) as unknown as typeof fetch;
    const snap = await collectClaimSnapshot(makeConfig(), fetchImpl, loadClaimCred);
    expect(snap.available).toBe(false);
    expect(snap.plans).toEqual([]);
    expect(snap.reason).toContain("404");
  });

  it("handleQuotaClaim returns 503 quota_claim_unavailable when not logged in", async () => {
    const resp = await handleQuotaClaim(makeConfig(), fetch, loadNone);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("quota_claim_unavailable");
  });

  it("POST /quota/claim without a JWT returns 401 claim_login_required", async () => {
    const jwtLess: Credential = { apiKey: "key-x.secret-y", provider: "zai" };
    const resp = await handleQuotaClaimSubmit(
      new Request("http://x/quota/claim", { method: "POST", body: "{}" }),
      makeConfig(),
      fetch,
      async () => jwtLess,
      async () => ({ verifyParam: "cap", region: "cn" }),
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("claim_login_required");
  });

  it("POST /quota/claim with invalid JSON returns 400 claim_invalid_body", async () => {
    const resp = await handleQuotaClaimSubmit(
      new Request("http://x/quota/claim", { method: "POST", body: "not-json" }),
      makeConfig(),
      fetch,
      loadClaimCred,
      async () => ({ verifyParam: "cap", region: "cn" }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("claim_invalid_body");
  });

  it("POST /quota/claim submits the captcha headers and returns the 3.14.4 outcome fields", async () => {
    const postCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("/billing/preview")) {
        return new Response(JSON.stringify(previewBody), { status: 200 });
      }
      postCalls.push({ url: u, init });
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            server_time: 1759000100,
            plan: {
              user_plan_id: "up-77",
              plan_id: "wk-campaign",
              status: "active",
              starts_at: 1759000100,
              ends_at: 1759100100,
              entitlements: [{ entitlement_id: "ent-1", show_name: "GLM-4.6 daily bonus", effective_at: 1759000500 }],
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const resp = await handleQuotaClaimSubmit(
      new Request("http://x/quota/claim", { method: "POST", body: JSON.stringify({ plan_id: "wk-campaign" }) }),
      makeConfig(),
      fetchImpl,
      loadClaimCred,
      async () => ({ verifyParam: "captcha-token", region: "cn-gd" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.planId).toBe("wk-campaign");
    expect(body.userPlanId).toBe("up-77");
    expect(body.status).toBe("active");
    expect(body.entitlements[0].entitlementId).toBe("ent-1");
    // Claim request carries the Aliyun captcha headers + billing fingerprint.
    const headers = postCalls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("captcha-token");
    expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("cn-gd");
    expect(headers["X-ZCode-App-Version"]).toBe("test-1.0.0");
    expect(headers["X-Platform"]).toContain("linux-");
  });

  it("POST /quota/claim surfaces upstream business failures verbatim (code 1005)", async () => {
    const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("/billing/preview")) return new Response(JSON.stringify(previewBody), { status: 200 });
      return new Response(
        JSON.stringify({ code: 1005, msg: "quota exhausted", data: { plan: { ends_at: 1759100000 } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const resp = await handleQuotaClaimSubmit(
      new Request("http://x/quota/claim", { method: "POST", body: JSON.stringify({ plan_id: "wk-campaign" }) }),
      makeConfig(),
      fetchImpl,
      loadClaimCred,
      async () => ({ verifyParam: "cap", region: "cn" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.failureKind).toBe("quota_exhausted");
    expect(body.failureEndsAt).toBe(1759100000);
  });
});

// ---------------------------------------------------------------------------
// POST /quota/reset — spend a stockpiled reset / request an automatic grant
// (dashboard "用量窗口重置" card actions; mirrors the CLI's --use/--opportunity).
// ---------------------------------------------------------------------------
import { handleQuotaResetAction } from "./routes-quota.js";

describe("POST /quota/reset (handleQuotaResetAction)", () => {
  const resetCred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt: makeJwt(), maasToken: "maas-token-1" };
  const loadResetCred = async (): Promise<Credential> => resetCred;

  it("returns 401 not_logged_in without a stored credential", async () => {
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: "{}" }),
      makeConfig(),
      fetch,
      loadNone,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("not_logged_in");
  });

  it("returns 400 reset_invalid_body on invalid JSON", async () => {
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: "not-json" }),
      makeConfig(),
      fetch,
      loadResetCred,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("reset_invalid_body");
  });

  it("returns 400 reset_invalid_action on an unknown action", async () => {
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "nope" }) }),
      makeConfig(),
      fetch,
      loadResetCred,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("reset_invalid_action");
  });

  it("returns 400 reset_invalid_type on a bad use type without calling upstream", async () => {
    let upstreamCalls = 0;
    const fetchImpl: typeof fetch = (async () => {
      upstreamCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "use", type: "yearly" }) }),
      makeConfig(),
      fetchImpl,
      loadResetCred,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("reset_invalid_type");
    expect(upstreamCalls).toBe(0);
  });

  it("action=use normalizes the type, posts the idempotency key and returns ok:true", async () => {
    const postCalls: Array<string | undefined> = [];
    const fetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      postCalls.push(typeof init?.body === "string" ? init.body : undefined);
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { used: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "use", type: "five_hour", idempotency_key: " key-1 " }) }),
      makeConfig(),
      fetchImpl,
      loadResetCred,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok?: boolean; action?: string; used?: boolean; type?: string };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("use");
    expect(body.used).toBe(true);
    expect(body.type).toBe("FIVE_HOUR");
    // The user-supplied idempotency key is honored (trimmed, verbatim on the wire).
    const sent = JSON.parse(postCalls[0] ?? "{}") as { idempotency_key?: string; reset_type?: string };
    expect(sent.idempotency_key).toBe("key-1");
    expect(sent.reset_type).toBe("FIVE_HOUR");
  });

  it("action=use generates a UUID idempotency key when the body omits one", async () => {
    const postCalls: Array<string | undefined> = [];
    const fetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      postCalls.push(typeof init?.body === "string" ? init.body : undefined);
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { used: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "use", type: "week" }) }),
      makeConfig(),
      fetchImpl,
      loadResetCred,
    );
    expect(resp.status).toBe(200);
    const sent = JSON.parse(postCalls[0] ?? "{}") as { idempotency_key?: string };
    // UUID v4 shape (36 chars, 4 hyphens) — retries without a key stay idempotent-safe.
    expect(sent.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("action=opportunity maps business 3301 to granted:false with nextTryAt", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ code: 3301, msg: "no opportunity", data: { next_try_at: 1759009999 } }), { status: 200 })) as unknown as typeof fetch;
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "opportunity" }) }),
      makeConfig(),
      fetchImpl,
      loadResetCred,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok?: boolean; granted?: boolean; nextTryAt?: number | null };
    expect(body.ok).toBe(true);
    expect(body.granted).toBe(false);
    expect(body.nextTryAt).toBe(1759009999);
  });

  it("action=opportunity maps a grant to granted:true", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ code: 0, msg: "ok", data: { granted: true } }), { status: 200 })) as unknown as typeof fetch;
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "opportunity" }) }),
      makeConfig(),
      fetchImpl,
      loadResetCred,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok?: boolean; granted?: boolean };
    expect(body.ok).toBe(true);
    expect(body.granted).toBe(true);
  });

  it("ResetApiError business verdicts come back as 200 {ok:false} with the upstream message", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ code: 1204, msg: "no available reset stock" }), { status: 200 })) as unknown as typeof fetch;
    const resp = await handleQuotaResetAction(
      new Request("http://x/quota/reset", { method: "POST", body: JSON.stringify({ action: "use", type: "week" }) }),
      makeConfig(),
      fetchImpl,
      loadResetCred,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("no available reset stock");
  });
});
