/**
 * Tests for coding plan key resolver.
 * @see .omo/plans/zcode-proxy.md Task 10
 */
import { describe, it, expect } from "bun:test";
import { KeyResolver } from "./resolver.js";

function bizResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(responses: Record<string, (body?: string) => Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body as string | undefined;
    for (const [pattern, handler] of Object.entries(responses)) {
      if (url.includes(pattern)) return handler(body);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function hangingFetch(): typeof fetch {
  return ((_: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
}

describe("KeyResolver", () => {
  it("resolveZaiBizToken exchanges access token for biz token", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({
        access_token: "biz_token_123",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const bizToken = await resolver.resolveZaiBizToken("access_abc");
    expect(bizToken).toBe("biz_token_123");
  });

  it("resolveZaiBizToken rejects a successful response without a usable token", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({
        data: { access_token: "   " },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const resolver = new KeyResolver(fetchImpl);
    await expect(resolver.resolveZaiBizToken("access_abc"))
      .rejects.toThrow(/missing access_token/);
  });

  it("resolveZaiBizToken times out instead of hanging forever", async () => {
    const resolver = new KeyResolver(hangingFetch(), 5);
    const keepAlive = setInterval(() => {}, 1);
    try {
      await expect(resolver.resolveZaiBizToken("access_abc")).rejects.toThrow(/timeout after 5ms/);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("resolveZaiBizToken times out when the response body stalls after headers", async () => {
    let canceled = false;
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(new ReadableStream<Uint8Array>({
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
    const resolver = new KeyResolver(fetchImpl, 5);
    const keepAlive = setInterval(() => {}, 1);
    try {
      await expect(resolver.resolveZaiBizToken("access_abc"))
        .rejects.toThrow(/JSON response read timeout after 5ms/);
      expect(canceled).toBe(true);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("resolveZaiBizToken unrefs the Biz API request timeout timer", async () => {
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
        "/auth/z/login": () => new Response(JSON.stringify({
          access_token: "biz_token_123",
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
      const resolver = new KeyResolver(fetchImpl, 1234);
      await resolver.resolveZaiBizToken("access_abc");
      expect(unrefDelays).toContain(1234);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("resolveZaiBizToken normalizes pathological request timeout values before scheduling timers", async () => {
    const originalSetTimeout = globalThis.setTimeout as any;
    const scheduledDelays: number[] = [];
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledDelays.push(Number(timeout));
      return originalSetTimeout(handler, timeout, ...args);
    };

    try {
      const fetchImpl = mockFetch({
        "/auth/z/login": () => new Response(JSON.stringify({
          access_token: "biz_token_123",
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
      const resolver = new KeyResolver(fetchImpl, Number.POSITIVE_INFINITY);
      await resolver.resolveZaiBizToken("access_abc");
      expect(scheduledDelays.every((delay) => Number.isFinite(delay) && delay >= 1)).toBe(true);
      expect(scheduledDelays).toContain(15_000);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("resolveCustomerInfo picks default org using bundle field names", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({
        organizations: [
          { organizationId: "org1", organizationName: "Some Org", projects: [] },
          { organizationId: "org2", organizationName: "默认机构", projects: [
            { projectId: "proj1", projectName: "默认项目" },
            { projectId: "proj2", projectName: "Other" },
          ]},
        ],
      }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const { orgId, projectId } = await resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok");
    expect(orgId).toBe("org2");
    expect(projectId).toBe("proj1");
  });

  it("resolveCustomerInfo falls back to first org when no default", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({
        organizations: [
          { organizationId: "orgA", organizationName: "Org A", projects: [{ projectId: "projA", projectName: "Proj A" }] },
        ],
      }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const { orgId, projectId } = await resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok");
    expect(orgId).toBe("orgA");
    expect(projectId).toBe("projA");
  });

  it("resolveCustomerInfo throws when no orgs", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({ organizations: [] }),
    });
    const resolver = new KeyResolver(fetchImpl);
    expect(resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok")).rejects.toThrow(/No organizations/);
  });

  it("resolveCustomerInfo rejects oversized JSON responses before reading the body", async () => {
    let canceled = false;
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => new Response(new ReadableStream<Uint8Array>({
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
    const resolver = new KeyResolver(fetchImpl);
    await expect(resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok"))
      .rejects.toThrow(/byte limit/);
    expect(canceled).toBe(true);
  });

  it("findOrCreateApiKey finds existing key named zcode-api-key", async () => {
    const fetchImpl = mockFetch({
      "api_keys": () => bizResponse([
        { name: "other-key", apiKey: "xxx" },
        { name: "zcode-api-key", apiKey: "existingApiKey" },
      ]),
    });
    const resolver = new KeyResolver(fetchImpl);
    const result = await resolver.findOrCreateApiKey("https://api.z.ai", "Bearer tok", "org1", "proj1");
    expect(result.apiKey).toBe("existingApiKey");
  });

  it("findOrCreateApiKey creates new key when not found", async () => {
    let createdKey = false;
    const fetchImpl = mockFetch({
      "api_keys": (body) => {
        if (body) {
          createdKey = true;
          return bizResponse({ apiKey: "newApiKey123" });
        }
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const result = await resolver.findOrCreateApiKey("https://api.z.ai", "Bearer tok", "org1", "proj1");
    expect(createdKey).toBe(true);
    expect(result.apiKey).toBe("newApiKey123");
  });

  it("getSecretKey retrieves secret via apiKey value", async () => {
    const fetchImpl = mockFetch({
      "copy/": () => bizResponse({ secretKey: "theSecretKey" }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const secret = await resolver.getSecretKey("https://api.z.ai", "Bearer tok", "org1", "proj1", "myApiKey123");
    expect(secret).toBe("theSecretKey");
  });

  it("resolveCodingPlanCredential returns Z.AI credential with secret", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ access_token: "bizTok" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      "getCustomerInfo": () => bizResponse({
        organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
      }),
      "api_keys/copy": () => bizResponse({ secretKey: "mySecret" }),
      "api_keys": (body) => {
        if (body) return bizResponse({ apiKey: "myApiKey" });
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCodingPlanCredential("accessTok", "zai");
    expect(cred.apiKey).toBe("myApiKey");
    expect(cred.secret).toBe("mySecret");
    expect(cred.provider).toBe("zai");
  });
});

describe("KeyResolver.resolveCredential — start-plan graceful fallback", () => {
  // biz API answers normally → full credential (apiKey+secret) + jwt attached.
  it("start-plan: keeps the biz-API apiKey/secret when the exchange succeeds, and attaches jwt", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ access_token: "bizTok" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      "getCustomerInfo": () => bizResponse({
        organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
      }),
      "api_keys/copy": () => bizResponse({ secretKey: "mySecret" }),
      "api_keys": (body) => body ? bizResponse({ apiKey: "myApiKey" }) : bizResponse([]),
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCredential("accessTok", "zai", "u1", "start-plan", "planJWT");
    expect(cred.apiKey).toBe("myApiKey");
    expect(cred.secret).toBe("mySecret");
    expect(cred.plan).toBe("start-plan");
    expect(cred.jwt).toBe("planJWT");
  });

  it("start-plan: falls back to JWT-only when z/login omits access_token", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ data: {} }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCredential(
      "accessTok",
      "zai",
      "user-start",
      "start-plan",
      "jwt-start-token",
      "user@example.com",
    );
    expect(cred).toEqual({
      apiKey: "jwt-start-token",
      provider: "zai",
      plan: "start-plan",
      jwt: "jwt-start-token",
      userId: "user-start",
      email: "user@example.com",
    });
  });

  // biz API fails → start-plan MUST fall back to a JWT-only credential instead
  // of throwing away the whole login (the jwt is what start-plan actually sends).
  it("start-plan: falls back to JWT-only credential when biz exchange fails", async () => {
    // Every biz endpoint 404s → resolveCodingPlanCredential throws.
    const fetchImpl = mockFetch({ "/auth/z/login": () => new Response("nope", { status: 404 }) });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCredential("accessTok", "zai", "u1", "start-plan", "planJWT");
    expect(cred.apiKey).toBe("planJWT"); // apiKey mirrors the JWT (fallback shape)
    expect(cred.jwt).toBe("planJWT");
    expect(cred.plan).toBe("start-plan");
    expect(cred.provider).toBe("zai");
    expect(cred.userId).toBe("u1");
  });

  // start-plan failure with NO jwt → nothing to fall back to → must throw.
  it("start-plan: throws when biz fails and no jwt is available", async () => {
    const fetchImpl = mockFetch({ "/auth/z/login": () => new Response("nope", { status: 404 }) });
    const resolver = new KeyResolver(fetchImpl);
    expect(resolver.resolveCredential("accessTok", "zai", "u1", "start-plan")).rejects.toThrow();
  });

  // coding-plan: NO fallback — biz failure must propagate.
  it("coding-plan: does not fall back, propagates biz exchange failure", async () => {
    const fetchImpl = mockFetch({ "/auth/z/login": () => new Response("nope", { status: 404 }) });
    const resolver = new KeyResolver(fetchImpl);
    expect(resolver.resolveCredential("accessTok", "zai", "u1", "coding-plan", "planJWT"))
      .rejects.toThrow();
  });

  // coding-plan success still attaches jwt (parity with the old explicit attach).
  it("coding-plan: attaches jwt on success", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ access_token: "bizTok" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      "getCustomerInfo": () => bizResponse({
        organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
      }),
      "api_keys/copy": () => bizResponse({ secretKey: "mySecret" }),
      "api_keys": (body) => body ? bizResponse({ apiKey: "myApiKey" }) : bizResponse([]),
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCredential("accessTok", "zai", "u1", "coding-plan", "planJWT");
    expect(cred.apiKey).toBe("myApiKey");
    expect(cred.plan).toBe("coding-plan");
    expect(cred.jwt).toBe("planJWT");
  });
});
