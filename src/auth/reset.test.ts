/**
 * Tests for the coding-plan reset client (auth/reset.ts) — the desktop
 * 3.14.4 alignment feature (4.7.2-fork.1).
 *
 * Covers:
 *  - dual-token auth: missing `jwt` / `maasToken` throw ResetAuthMissingError
 *    with a re-login hint, and no request escapes (the pre-maasToken account
 *    class must fail closed, not send a broken request);
 *  - header shape: `Authorization: Bearer <jwt>` + `X-Bigmodel-Authorization:
 *    <maasToken>` + `Bigmodel-Target-Type: PERSONAL` + no X-ZCode-Agent
 *    (control-plane precedent);
 *  - `/status` parsing: resets lists, history entries, has_unread_history;
 *  - `/use`: happy path, idempotency validation (trim, >64 → error, no call),
 *    envelope `used !== true` → invalid response;
 *  - `/opportunity`: granted, code 3301 → {granted:false, next_try_at},
 *    HTTP 429 → ResetApiError(429), invalid 3301 data → error;
 *  - `/history/read` fire-and-forget;
 *  - reset-type normalization: CLI spellings → wire `FIVE_HOUR`/`WEEK`;
 *  - non-zero business codes throw ResetApiError with the code attached;
 *  - timeout abort (short timeoutMs aborts a hung server).
 */
import { describe, it, expect } from "bun:test";
import {
  createResetClient,
  normalizeIdempotencyKey,
  normalizeResetType,
  ResetApiError,
  ResetAuthMissingError,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./reset.js";
import type { Credential } from "./types.js";

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    apiKey: "key-x.secret-y",
    provider: "zai",
    jwt: "zcode-jwt",
    maasToken: "maas-token",
    ...overrides,
  };
}

type Json = Record<string, unknown>;

/** Route table over paths: "/reset/status" → response. Paths include the base. */
function makeFetch(
  routes: Record<string, { status?: number; body: Json }>,
  opts: { seen?: Array<{ url: string; init?: RequestInit }> } = {},
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    opts.seen?.push({ url: u, init });
    const path = u.replace(/^https:\/\/[^/]+/, "");
    const route = routes[path] ?? routes[u.replace(/^https?:\/\/[^/]+/, "")];
    if (!route) return new Response("no route", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const BASE = "https://zcode.z.ai/api/v1/coding-plan/reset";

function makeConfigLike() {
  return { appVersion: "test-1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" };
}

describe("reset client — auth", () => {
  it("missing maasToken throws ResetAuthMissingError without any network call", async () => {
    let called = 0;
    const fetchImpl = (async (_url: string | URL | Request) => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createResetClient(makeCred({ maasToken: undefined }), { fetchImpl });
    await expect(client.getStatus()).rejects.toBeInstanceOf(ResetAuthMissingError);
    expect(called).toBe(0);
  });

  it("missing jwt throws ResetAuthMissingError (re-login hint)", async () => {
    const client = createResetClient(makeCred({ jwt: undefined }), {
      fetchImpl: makeFetch({}),
    });
    await expect(client.getStatus()).rejects.toThrow(/re-login/);
  });
});

describe("reset client — headers", () => {
  it("sends dual auth headers, PERSONAL target, and drops X-ZCode-Agent", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = makeFetch(
      { ["/api/v1/coding-plan/reset/status"]: { body: { code: 0, data: {} } } },
      { seen },
    );
    const client = createResetClient(makeCred(), { fetchImpl, identity: makeConfigLike() });
    await client.getStatus();
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe(`${BASE}/status`);
    const headers = new Headers(seen[0].init?.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer zcode-jwt");
    expect(headers.get("x-bigmodel-authorization")).toBe("maas-token");
    expect(headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(headers.get("x-zcode-agent")).toBeNull();
    expect(headers.get("content-type")).toBeNull(); // GET carries no JSON body
  });
});

describe("reset client — status", () => {
  it("parses resets, history, and has_unread_history", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/coding-plan/reset/status"]: {
        body: {
          code: 0,
          data: {
            available_five_hour_resets: [{ expire_at: 1000 }, { expire_at: 2000 }],
            available_week_resets: [{ expire_at: 3000 }],
            latest_five_hour_reset_history: { used_at: 500 },
            latest_week_reset_history: null,
            has_unread_history: true,
          },
        },
      },
    });
    const client = createResetClient(makeCred(), { fetchImpl });
    const status = await client.getStatus();
    expect(status.availableFiveHourResets).toEqual([{ expireAt: 1000 }, { expireAt: 2000 }]);
    expect(status.availableWeekResets).toEqual([{ expireAt: 3000 }]);
    expect(status.latestFiveHourResetHistory).toEqual({ usedAt: 500 });
    expect(status.latestWeekResetHistory).toBeNull();
    expect(status.hasUnreadHistory).toBe(true);
  });

  it("non-zero business code throws ResetApiError with the code", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/coding-plan/reset/status"]: { body: { code: 3103, msg: "quota exhausted" } },
    });
    const client = createResetClient(makeCred(), { fetchImpl });
    const err = await client.getStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResetApiError);
    expect((err as ResetApiError).code).toBe(3103);
    expect((err as Error).message).toBe("quota exhausted");
    expect((err as ResetApiError).businessCode).toBe("coding_plan_reset_api_error:3103");
  });

  it("non-JSON and missing-code responses are invalid_response", async () => {
    const bad = (async (_url: string | URL | Request) => new Response("oops", { status: 200 })) as unknown as typeof fetch;
    const clientA = createResetClient(makeCred(), { fetchImpl: bad });
    await expect(clientA.getStatus()).rejects.toThrow(/invalid_response/);

    const noCode = (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ msg: "no code" }), { status: 200 })) as unknown as typeof fetch;
    const clientB = createResetClient(makeCred(), { fetchImpl: noCode });
    await expect(clientB.getStatus()).rejects.toBeInstanceOf(ResetApiError);
  });
});

describe("reset client — use", () => {
  it("posts idempotency_key + reset_type and returns used:true", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = makeFetch(
      { ["/api/v1/coding-plan/reset/use"]: { body: { code: 0, data: { used: true } } } },
      { seen },
    );
    const client = createResetClient(makeCred(), { fetchImpl, identity: makeConfigLike() });
    const result = await client.use("FIVE_HOUR", " abc-123 ");
    expect(result.used).toBe(true);
    const body = JSON.parse(String(seen[0].init?.body)) as Json;
    expect(body).toEqual({ idempotency_key: "abc-123", reset_type: "FIVE_HOUR" });
    const headers = new Headers(seen[0].init?.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("rejects idempotency keys over 64 chars client-side without calling the server", async () => {
    let called = 0;
    const fetchImpl = (async (_url: string | URL | Request) => {
      called += 1;
      return new Response(JSON.stringify({ code: 0, data: { used: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createResetClient(makeCred(), { fetchImpl });
    await expect(client.use("WEEK", "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).rejects.toThrow(
      /idempotency/,
    );
    expect(called).toBe(0);
  });

  it("used !== true is an invalid response", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/coding-plan/reset/use"]: { body: { code: 0, data: { used: false } } },
    });
    const client = createResetClient(makeCred(), { fetchImpl });
    await expect(client.use("WEEK", "k")).rejects.toThrow(/invalid_response/);
  });
});

describe("reset client — opportunity", () => {
  it("granted:true maps through", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/coding-plan/reset/opportunity"]: { body: { code: 0, data: { granted: true } } },
    });
    const client = createResetClient(makeCred(), { fetchImpl });
    expect(await client.requestOpportunity("k")).toEqual({ granted: true, nextTryAt: null });
  });

  it("code 3301 resolves to {granted:false, nextTryAt}", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/coding-plan/reset/opportunity"]: {
        body: { code: 3301, data: { granted: false, next_try_at: 1758889200000 } },
      },
    });
    const client = createResetClient(makeCred(), { fetchImpl });
    expect(await client.requestOpportunity("k")).toEqual({ granted: false, nextTryAt: 1758889200000 });
  });

  it("HTTP 429 surfaces as ResetApiError(429) for caller backoff", async () => {
    const fetchImpl = (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ msg: "throttled" }), { status: 429 })) as unknown as typeof fetch;
    const client = createResetClient(makeCred(), { fetchImpl });
    const err = await client.requestOpportunity("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResetApiError);
    expect((err as ResetApiError).code).toBe(429);
  });

  it("3301 without next_try_at data is invalid", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/coding-plan/reset/opportunity"]: { body: { code: 3301, data: {} } },
    });
    const client = createResetClient(makeCred(), { fetchImpl });
    await expect(client.requestOpportunity("k")).rejects.toThrow(/invalid_response/);
  });
});

describe("reset client — history/read", () => {
  it("posts with auth headers and tolerates an empty envelope", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = makeFetch(
      { ["/api/v1/coding-plan/reset/history/read"]: { body: { code: 0 } } },
      { seen },
    );
    const client = createResetClient(makeCred(), { fetchImpl, identity: makeConfigLike() });
    await expect(client.markHistoryRead()).resolves.toBeUndefined();
    expect(seen[0].url).toBe(`${BASE}/history/read`);
  });
});

describe("reset client — helpers", () => {
  it("normalizes reset type spellings to the wire enum", () => {
    expect(normalizeResetType("five_hour")).toBe("FIVE_HOUR");
    expect(normalizeResetType("FIVE_HOUR")).toBe("FIVE_HOUR");
    expect(normalizeResetType("Five-Hour")).toBe("FIVE_HOUR");
    expect(normalizeResetType("week")).toBe("WEEK");
    expect(normalizeResetType(" weekly ")).toBe("WEEK");
    expect(() => normalizeResetType("month")).toThrow(/invalid reset type/);
    expect(() => normalizeResetType("")).toThrow(/invalid reset type/);
  });

  it("normalizes idempotency keys with the desktop's trim rule", () => {
    expect(normalizeIdempotencyKey("  x  ")).toBe("x");
    expect(() => normalizeIdempotencyKey("   ")).toThrow(/idempotency/);
  });
});

describe("reset client — timeout", () => {
  it("aborts a hung server after timeoutMs", async () => {
    const fetchImpl: typeof fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted by timeout test")),
        );
      })) as typeof fetch;
    const client = createResetClient(makeCred(), { fetchImpl, timeoutMs: 25 });
    await expect(client.getStatus()).rejects.toThrow(/abort|timeout|reset/i);
  });
});
