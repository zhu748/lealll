/**
 * Tests for the Z.AI OAuth client (auth-code/callback flow).
 * @see .omo/plans/zcode-proxy.md Task 9
 *
 * The client spins up a real localhost HTTP server to receive the provider
 * redirect, so these tests drive it by firing an HTTP GET at the callback URL
 * it returns (simulating the browser redirect) and mocking only the
 * zcode.z.ai token exchange.
 */
import { describe, it, expect } from "bun:test";
import { ZaiOAuthClient, normalizeCallbackWaitTimeoutMs } from "./oauth.js";
import { once } from "node:events";
import { connect } from "node:net";

/**
 * Wrap response data in the Z.AI / zcode.z.ai {code, data, msg} envelope.
 * The real token endpoint always wraps responses this way.
 */
function zaiEnvelope(data: Record<string, unknown>): string {
  return JSON.stringify({ code: 0, data, msg: "success" });
}

/**
 * Mock fetch that only handles the token exchange POST. Everything else is
 * the real localhost HTTP traffic (callback redirect), which must NOT be
 * intercepted — so the mock returns null and the real fetch runs.
 */
function tokenExchangeMock(
  responder: (body: { provider: string; code: string; redirect_uri: string; state: string }) => Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/oauth/token") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      return responder(body);
    }
    // Fall through to the real fetch for the localhost callback request.
    return fetch(input as any, init);
  }) as typeof fetch;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("ZaiOAuthClient", () => {
  it("normalizes callback wait timeouts to safe timer values", () => {
    expect(normalizeCallbackWaitTimeoutMs()).toBe(300_000);
    expect(normalizeCallbackWaitTimeoutMs(Number.POSITIVE_INFINITY)).toBe(300_000);
    expect(normalizeCallbackWaitTimeoutMs(Number.NaN)).toBe(300_000);
    expect(normalizeCallbackWaitTimeoutMs(0)).toBe(1);
    expect(normalizeCallbackWaitTimeoutMs(-500)).toBe(1);
    expect(normalizeCallbackWaitTimeoutMs(1.9)).toBe(1);
    expect(normalizeCallbackWaitTimeoutMs(999_999_999)).toBe(300_000);
  });

  it("start() builds the authorize URL with the documented query params and binds a localhost callback", async () => {
    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));
    const init = await client.start();
    try {
      // authorize URL points at chat.z.ai/api/oauth/authorize
      expect(init.authorizeUrl).toContain("https://chat.z.ai/api/oauth/authorize?");
      const u = new URL(init.authorizeUrl);
      expect(u.searchParams.get("response_type")).toBe("code");
      expect(u.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
      // redirect_uri is the localhost callback the server is actually listening on
      expect(u.searchParams.get("redirect_uri")).toBe(init.callbackUrl);
      expect(init.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/zai$/);
      // state is 32-byte hex and is echoed as flowId/pollToken under the auth-code model
      expect(init.state).toMatch(/^[0-9a-f]{64}$/);
      expect(init.flowId).toBe(init.state);
      expect(init.pollToken).toBe(init.state);
    } finally {
      await client.close();
    }
  });

  it("close() force-closes stalled localhost callback sockets", async () => {
    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));
    const init = await client.start();
    const port = Number(new URL(init.callbackUrl).port);
    const socket = connect({ host: "127.0.0.1", port });
    let socketClosed = false;
    socket.once("close", () => { socketClosed = true; });
    try {
      await once(socket, "connect");
      const result = await Promise.race([
        client.close().then(() => "closed"),
        new Promise<string>(resolve => setTimeout(() => resolve("timeout"), 1500)),
      ]);
      expect(result).toBe("closed");
      expect(await waitUntil(() => socketClosed || socket.destroyed)).toBe(true);
    } finally {
      socket.destroy();
      await client.close().catch(() => {});
    }
  });

  it("exchangeCode() sends provider=zai + code/redirect_uri/state and unwraps zai.access_token + jwt + userId", async () => {
    let captured: { provider: string; code: string; redirect_uri: string; state: string } | null = null;
    const mock = tokenExchangeMock((body) => {
      captured = body;
      return new Response(zaiEnvelope({
        token: "zcode_jwt_xyz",
        zai: { access_token: "zai_access_123" },
        user: { user_id: "u1", name: "test" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const client = new ZaiOAuthClient(mock);
    const result = await client.exchangeCode("auth_code_abc", "http://127.0.0.1:1/oauth/callback/zai", "state_hex");
    expect(captured!.provider).toBe("zai");
    expect(captured!.code).toBe("auth_code_abc");
    expect(captured!.redirect_uri).toBe("http://127.0.0.1:1/oauth/callback/zai");
    expect(captured!.state).toBe("state_hex");
    expect(result.accessToken).toBe("zai_access_123");
    expect(result.jwt).toBe("zcode_jwt_xyz");
    expect(result.userId).toBe("u1");
  });

  it("exchangeCode() unrefs the token request timeout timer", async () => {
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
      const mock = tokenExchangeMock(() =>
        new Response(zaiEnvelope({ zai: { access_token: "zai_access_123" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const client = new ZaiOAuthClient(mock);
      await client.exchangeCode("auth_code_abc", "http://127.0.0.1:1/oauth/callback/zai", "state_hex");
      expect(unrefDelays).toContain(30_000);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("exchangeCode() normalizes pathological token request timeout values before scheduling timers", async () => {
    const originalSetTimeout = globalThis.setTimeout as any;
    const scheduledDelays: number[] = [];
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledDelays.push(Number(timeout));
      return originalSetTimeout(handler, timeout, ...args);
    };

    try {
      const mock = tokenExchangeMock(() =>
        new Response(zaiEnvelope({ zai: { access_token: "zai_access_123" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const client = new ZaiOAuthClient(
        mock,
        "https://chat.z.ai/api/oauth/authorize",
        "client_P8X5CMWmlaRO9gyO-KSqtg",
        Number.POSITIVE_INFINITY,
      );
      await client.exchangeCode("auth_code_abc", "http://127.0.0.1:1/oauth/callback/zai", "state_hex");
      expect(scheduledDelays.every((delay) => Number.isFinite(delay) && delay >= 1)).toBe(true);
      expect(scheduledDelays).toContain(30_000);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("exchangeCode() times out when the token response body stalls after headers", async () => {
    let canceled = false;
    const mock = tokenExchangeMock(() =>
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
    );
    const client = new ZaiOAuthClient(
      mock,
      "https://chat.z.ai/api/oauth/authorize",
      "client_P8X5CMWmlaRO9gyO-KSqtg",
      5,
    );
    const keepAlive = setInterval(() => {}, 1);
    try {
      await expect(client.exchangeCode("auth_code_abc", "http://127.0.0.1:1/oauth/callback/zai", "state_hex"))
        .rejects.toThrow(/OAuth token response read timeout after 5ms/);
      expect(canceled).toBe(true);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("exchangeCode() throws when the envelope reports a non-zero business code", async () => {
    const mock = tokenExchangeMock(() =>
      new Response(JSON.stringify({ code: 3004, msg: "redirect_uri_mismatch" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ZaiOAuthClient(mock);
    expect(client.exchangeCode("c", "http://127.0.0.1:1/oauth/callback/zai", "s"))
      .rejects.toThrow(/Z\.AI token exchange failed|redirect_uri_mismatch/);
  });

  it("exchangeCode() throws when zai.access_token is missing", async () => {
    const mock = tokenExchangeMock(() =>
      new Response(zaiEnvelope({ token: "jwt_only" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ZaiOAuthClient(mock);
    expect(client.exchangeCode("c", "http://127.0.0.1:1/oauth/callback/zai", "s"))
      .rejects.toThrow(/zai\.access_token/);
  });

  it("exchangeCode() rejects oversized token responses before reading the body", async () => {
    let canceled = false;
    const mock = tokenExchangeMock(() =>
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
    );

    const client = new ZaiOAuthClient(mock);
    await expect(client.exchangeCode("c", "http://127.0.0.1:1/oauth/callback/zai", "s"))
      .rejects.toThrow(/OAuth token response exceeds/);
    expect(canceled).toBe(true);
  });

  it("exchangeCode() releases the response reader when a chunked token response is oversized", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const mock = tokenExchangeMock(() =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new ZaiOAuthClient(mock);
    await expect(client.exchangeCode("c", "http://127.0.0.1:1/oauth/callback/zai", "s"))
      .rejects.toThrow(/OAuth token response exceeds/);
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("authorize() drives the full loop: authorize URL -> callback redirect -> token exchange", async () => {
    const mock = tokenExchangeMock(() =>
      new Response(zaiEnvelope({
        token: "jwt_token",
        zai: { access_token: "resolved_token" },
        user: { user_id: "user_42" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const client = new ZaiOAuthClient(mock);
    const seenUrl: string[] = [];

    // Kick off authorize() and, once we have the authorize URL, simulate the
    // browser redirecting to the localhost callback with code+state.
    const authPromise = client.authorize((url) => {
      seenUrl.push(url);
      const authorize = new URL(url);
      const redirect = authorize.searchParams.get("redirect_uri")!;
      const state = authorize.searchParams.get("state")!;
      const callback = new URL(redirect);
      callback.searchParams.set("code", "real_auth_code");
      callback.searchParams.set("state", state);
      // fire-and-forget; the server resolves the waiter
      fetch(callback.toString()).catch(() => {});
    });

    const result = await authPromise;
    expect(result.accessToken).toBe("resolved_token");
    expect(result.provider).toBe("zai");
    expect(result.userId).toBe("user_42");
    expect(result.jwt).toBe("jwt_token");
    expect(seenUrl[0]).toContain("chat.z.ai/api/oauth/authorize");
  });

  it("authorize() rejects on a state mismatch in the callback redirect", async () => {
    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));

    const authPromise = client.authorize((url) => {
      const authorize = new URL(url);
      const redirect = authorize.searchParams.get("redirect_uri")!;
      const callback = new URL(redirect);
      callback.searchParams.set("code", "c");
      callback.searchParams.set("state", "wrong_state"); // mismatch
      fetch(callback.toString()).catch(() => {});
    });

    expect(authPromise).rejects.toThrow(/state mismatch/);
    await client.close().catch(() => {});
  });

  it("waitForCallback() times out when no redirect arrives", async () => {
    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));
    await client.start();
    try {
      // 1ms timeout — should reject almost immediately
      expect(client.waitForCallback(1)).rejects.toThrow(/timed out/);
      // let the rejection settle so it doesn't surface as an unhandled error
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      await client.close();
    }
  });

  it("waitForCallback() clamps invalid timeout values before scheduling timers", async () => {
    const originalSetTimeout = globalThis.setTimeout as any;
    const delays: number[] = [];
    (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      delays.push(Number(timeout));
      return originalSetTimeout(handler, timeout, ...args);
    };

    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));
    const init = await client.start();
    try {
      const callbackPromise = client.waitForCallback(Number.POSITIVE_INFINITY);
      const callback = new URL(init.callbackUrl);
      callback.searchParams.set("code", "valid_code_after_invalid_timeout");
      callback.searchParams.set("state", init.state!);
      await fetch(callback.toString());
      await expect(callbackPromise).resolves.toBe("valid_code_after_invalid_timeout");
      expect(delays).toContain(300_000);
      expect(delays).not.toContain(Number.POSITIVE_INFINITY);
    } finally {
      await client.close();
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it("close() rejects a pending waitForCallback immediately", async () => {
    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));
    await client.start();
    const waitPromise = client.waitForCallback(300_000);
    await client.close();
    await expect(waitPromise).rejects.toThrow(/callback server closed/);
  });

  it("waitForCallback() cleans up timed-out waiters and still accepts a later valid callback", async () => {
    const client = new ZaiOAuthClient(tokenExchangeMock(() => new Response("{}", { status: 200 })));
    const init = await client.start();
    try {
      await expect(client.waitForCallback(1)).rejects.toThrow(/timed out/);

      const callback = new URL(init.callbackUrl);
      callback.searchParams.set("code", "late_valid_code");
      callback.searchParams.set("state", init.state!);
      await fetch(callback.toString());

      await expect(client.waitForCallback(100)).resolves.toBe("late_valid_code");
    } finally {
      await client.close();
    }
  });
});
