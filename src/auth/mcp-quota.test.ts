/**
 * Tests for the MCP usage-quota client (auth/mcp-quota.ts).
 *
 * Covers:
 *  - missing jwt → null without network call (start-plan-only credential
 *    is not eligible for the mcp usage plane);
 *  - header shape: `Authorization: Bearer <jwt>` + identity fingerprint,
 *    X-ZCode-Agent stripped (control-plane precedent);
 *  - happy path: parses server_time / next_refresh_at / level / total_usage;
 *  - non-zero business code → null (tolerant, matches desktop usage:null);
 *  - HTTP non-2xx → null;
 *  - non-JSON / missing code → null;
 *  - timeout abort (short timeoutMs aborts a hung server);
 *  - total_usage absent → defaults to 0 (not null — the dashboard still
 *    renders the level / serverTime row);
 */
import { describe, it, expect } from "bun:test";
import { fetchMcpUsage, DEFAULT_MCP_USAGE_ORIGIN } from "./mcp-quota.js";
import type { Credential } from "./types.js";

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    apiKey: "key-x.secret-y",
    provider: "zai",
    jwt: "zcode-jwt",
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

const BASE = `${DEFAULT_MCP_USAGE_ORIGIN}/api/v1/mcp/usage`;

describe("mcp-quota — auth gate", () => {
  it("missing jwt returns null without any network call", async () => {
    let called = 0;
    const fetchImpl = (async (_url: string | URL | Request) => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMcpUsage(makeCred({ jwt: undefined }), { fetchImpl });
    expect(result).toBeNull();
    expect(called).toBe(0);
  });

  it("empty-string jwt returns null without any network call", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMcpUsage(makeCred({ jwt: "   " }), { fetchImpl });
    expect(result).toBeNull();
    expect(called).toBe(0);
  });
});

describe("mcp-quota — headers", () => {
  it("sends Authorization Bearer + identity fingerprint, drops X-ZCode-Agent", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = makeFetch(
      { ["/api/v1/mcp/usage"]: { body: { code: 0, data: { server_time: 1000 } } } },
      { seen },
    );
    await fetchMcpUsage(makeCred(), {
      fetchImpl,
      identity: { appVersion: "test-1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe(BASE);
    const headers = new Headers(seen[0].init?.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer zcode-jwt");
    expect(headers.get("x-zcode-agent")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });
});

describe("mcp-quota — happy path", () => {
  it("parses total_usage + server_time + next_refresh_at + level", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/mcp/usage"]: {
        body: {
          code: 0,
          data: {
            server_time: 1700000000,
            next_refresh_at: 1700003600,
            level: "max",
            total_usage: { used: 12, limit: 100, remaining: 88 },
          },
        },
      },
    });
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toEqual({
      serverTime: 1700000000000,
      nextRefreshAt: 1700003600000,
      level: "max",
      used: 12,
      limit: 100,
      remaining: 88,
    });
  });

  it("total_usage absent defaults to zeros but serverTime is still set", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/mcp/usage"]: {
        body: { code: 0, data: { server_time: 1700000000 } },
      },
    });
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).not.toBeNull();
    expect(result!.serverTime).toBe(1700000000000);
    expect(result!.used).toBe(0);
    expect(result!.limit).toBe(0);
    expect(result!.remaining).toBe(0);
  });
});

describe("mcp-quota — failure tolerance", () => {
  it("non-zero business code returns null (does not throw)", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/mcp/usage"]: { body: { code: 3103, msg: "unauthorized" } },
    });
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toBeNull();
  });

  it("HTTP 4xx returns null (does not throw)", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/mcp/usage"]: { status: 429, body: { msg: "throttled" } },
    });
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toBeNull();
  });

  it("non-JSON response returns null", async () => {
    const fetchImpl = (async () => new Response("oops", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toBeNull();
  });

  it("envelope missing code returns null", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/mcp/usage"]: { body: { msg: "no code" } },
    });
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toBeNull();
  });

  it("data missing returns null", async () => {
    const fetchImpl = makeFetch({
      ["/api/v1/mcp/usage"]: { body: { code: 0 } },
    });
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toBeNull();
  });

  it("network error returns null (does not throw)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await fetchMcpUsage(makeCred(), { fetchImpl });
    expect(result).toBeNull();
  });
});

describe("mcp-quota — timeout", () => {
  it("short timeout aborts a hung server and returns null", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      // Wait forever, but respect abort signal
      await new Promise<void>((_resolve, reject) => {
        const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (sig) sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        else setTimeout(reject, 30000);
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMcpUsage(makeCred(), { fetchImpl, timeoutMs: 50 });
    expect(result).toBeNull();
  });
});
