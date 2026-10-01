/**
 * Tests for the subscription availability client (auth/subscription.ts).
 *
 * Covers:
 *  - start-plan shortcut: returns {kind:"unknown"} without any network call;
 *  - coding-plan without maasToken: returns {kind:"unknown"} without any
 *    network call (fail-open for pre-4.7.2 accounts);
 *  - header shape: `X-Bigmodel-Authorization: <maasToken>` + identity
 *    fingerprint, X-ZCode-Agent stripped;
 *  - happy path: non-empty data array → {kind:"available", count};
 *  - happy path: empty data array → {kind:"unavailable", count:0};
 *  - non-zero business code → {kind:"unknown"} (fail-open);
 *  - HTTP non-2xx → {kind:"unknown"};
 *  - non-JSON → {kind:"unknown"};
 *  - network error → {kind:"unknown"};
 *  - timeout abort (short timeoutMs aborts a hung server).
 */
import { describe, it, expect } from "bun:test";
import {
  fetchSubscriptionAvailability,
  DEFAULT_SUBSCRIPTION_ORIGIN,
} from "./subscription.js";
import type { Credential } from "./types.js";

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    apiKey: "key-x.secret-y",
    provider: "zai",
    plan: "coding-plan",
    jwt: "zcode-jwt",
    maasToken: "maas-token",
    ...overrides,
  };
}

type Json = Record<string, unknown>;

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

const BASE = `${DEFAULT_SUBSCRIPTION_ORIGIN}/api/biz/subscription/list`;

describe("subscription — auth gate shortcuts", () => {
  it("start-plan returns {kind:'unknown'} without any network call", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchSubscriptionAvailability(
      makeCred({ plan: "start-plan" }),
      { fetchImpl },
    );
    expect(result).toEqual({ kind: "unknown", count: 0 });
    expect(called).toBe(0);
  });

  it("coding-plan without maasToken returns {kind:'unknown'} without any network call", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchSubscriptionAvailability(
      makeCred({ maasToken: undefined }),
      { fetchImpl },
    );
    expect(result).toEqual({ kind: "unknown", count: 0 });
    expect(called).toBe(0);
  });
});

describe("subscription — headers", () => {
  it("sends X-Bigmodel-Authorization + identity fingerprint, drops X-ZCode-Agent", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = makeFetch(
      { "/api/biz/subscription/list": { body: { code: 0, data: [{ id: "sub1" }] } } },
      { seen },
    );
    await fetchSubscriptionAvailability(makeCred(), {
      fetchImpl,
      identity: { appVersion: "test-1", sourceTitle: "cli", refererOrigin: "https://api.z.ai" },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe(BASE);
    const headers = new Headers(seen[0].init?.headers as HeadersInit);
    expect(headers.get("x-bigmodel-authorization")).toBe("maas-token");
    expect(headers.get("x-zcode-agent")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });
});

describe("subscription — happy path", () => {
  it("non-empty data array → {kind:'available', count}", async () => {
    const fetchImpl = makeFetch({
      "/api/biz/subscription/list": {
        body: { code: 0, data: [{ id: "sub1" }, { id: "sub2" }] },
      },
    });
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "available", count: 2 });
  });

  it("empty data array → {kind:'unavailable', count:0}", async () => {
    const fetchImpl = makeFetch({
      "/api/biz/subscription/list": { body: { code: 0, data: [] } },
    });
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unavailable", count: 0 });
  });

  it("null data treated as empty → {kind:'unavailable'}", async () => {
    const fetchImpl = makeFetch({
      "/api/biz/subscription/list": { body: { code: 0, data: null } },
    });
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unavailable", count: 0 });
  });
});

describe("subscription — failure tolerance (all fail-open to 'unknown')", () => {
  it("non-zero business code → {kind:'unknown'}", async () => {
    const fetchImpl = makeFetch({
      "/api/biz/subscription/list": { body: { code: 3103, msg: "unauthorized" } },
    });
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unknown", count: 0 });
  });

  it("HTTP 4xx → {kind:'unknown'}", async () => {
    const fetchImpl = makeFetch({
      "/api/biz/subscription/list": { status: 429, body: { msg: "throttled" } },
    });
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unknown", count: 0 });
  });

  it("non-JSON → {kind:'unknown'}", async () => {
    const fetchImpl = (async () => new Response("oops", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unknown", count: 0 });
  });

  it("envelope missing code → {kind:'unknown'}", async () => {
    const fetchImpl = makeFetch({
      "/api/biz/subscription/list": { body: { msg: "no code" } },
    });
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unknown", count: 0 });
  });

  it("network error → {kind:'unknown'}", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl });
    expect(result).toEqual({ kind: "unknown", count: 0 });
  });
});

describe("subscription — timeout", () => {
  it("short timeout aborts a hung server and returns {kind:'unknown'}", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (sig) sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        else setTimeout(reject, 30000);
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchSubscriptionAvailability(makeCred(), { fetchImpl, timeoutMs: 50 });
    expect(result).toEqual({ kind: "unknown", count: 0 });
  });
});
