/**
 * Regression test for retry body-reuse bug.
 *
 * Bug: When the proxy retried a failed request, it reused the same Request
 * object. fetch() consumes the body on first call, so every retry threw
 * "Request body already used" — which got caught and silently converted
 * to a synthetic 502. Net effect: retries NEVER worked, even though the
 * logs showed "retry 1/3, retry 2/3, retry 3/3".
 *
 * Fix: Each retry builds a FRESH Request via fetchUpstreamDetected().
 *
 * This test mocks an upstream that returns 529 twice then 200, and
 * verifies that:
 *   1. The proxy actually retries (doesn't bail on first 529)
 *   2. Each retry builds a fresh Request (no "body already used")
 *   3. The final 200 response is returned to the client
 *   4. The upstream received the same body on each attempt
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { _resetStatsForTesting } from "../admin/api.js";

function makeRetryConfig(): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },

    logging: { level: "info" },
    // Enable retries: 529 is retryable, use short delays for fast tests
    retry: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2, retryableStatuses: [529, 502], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };
}

describe("retry body-reuse regression", () => {
  it("retries an initial network error even when 502 is not listed as retryable", async () => {
    const config = makeRetryConfig();
    config.retry = {
      ...config.retry,
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoffFactor: 1,
      retryableStatuses: [529],
    };
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    let callCount = 0;
    const receivedBodies: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      receivedBodies.push(await req.text());
      if (callCount === 1) {
        throw new Error("ECONNRESET during first fetch");
      }
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Success after initial network retry" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    expect(callCount).toBe(2);
    expect(receivedBodies).toHaveLength(2);
    expect(resp.status).toBe(200);
    const respBody = await resp.json();
    expect(respBody.content[0].text).toBe("Success after initial network retry");
  });

  it("retries successfully after 529 by building fresh Request each time", async () => {
    const config = makeRetryConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    // Track each upstream call: count, body received, and any errors
    let callCount = 0;
    const receivedBodies: string[] = [];
    let bodyReadError: string | null = null;

    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      // Read the body — if the Request body was already consumed (the bug),
      // this throws "Request body already used" or returns empty body
      let bodyText: string;
      try {
        bodyText = await req.text();
        receivedBodies.push(bodyText);
      } catch (err) {
        bodyReadError = (err as Error).message;
        return new Response(
          JSON.stringify({ error: { type: "body_read_failed", message: bodyReadError } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // First 2 calls return 529, third returns 200
      if (callCount <= 2) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
          { status: 529, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Success after retry" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // Must have made 3 attempts (1 initial + 2 retries)
    expect(callCount).toBe(3);
    // Must NOT have hit the body-read error
    expect(bodyReadError).toBeNull();
    // Each attempt must have received the full body (proves fresh Request each time)
    expect(receivedBodies.length).toBe(3);
    for (const body of receivedBodies) {
      expect(body).toContain('"glm-4.6"');
      expect(body).toContain('"Hi"');
    }
    // Final response must be the 200 success
    expect(resp.status).toBe(200);
    const respBody = await resp.json();
    expect(respBody.content[0].text).toBe("Success after retry");
  });

  it("marks admin stats as retried when a retry succeeds", async () => {
    _resetStatsForTesting();
    try {
      const config = makeRetryConfig();
      config.auth.proxyApiKey = "proxy-secret";
      config.retry = {
        ...config.retry,
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        backoffFactor: 1,
        retryableStatuses: [529],
      };
      const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

      let callCount = 0;
      const mockFetch = (async (req: Request): Promise<Response> => {
        callCount++;
        await req.text();
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
            { status: 529, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "msg_retry_stats",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Stats retry success" }],
            model: "glm-4.6",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
      const resp = await handler(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: {
            "authorization": "Bearer proxy-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
        }),
      );

      expect(resp.status).toBe(200);
      expect(callCount).toBe(2);

      const statsResp = await handler(
        new Request("http://localhost/admin/api/stats", {
          headers: { "authorization": "Bearer proxy-secret" },
        }),
      );
      expect(statsResp.status).toBe(200);
      const stats = await statsResp.json();
      expect(stats.total).toBe(1);
      expect(stats.retried).toBe(1);
      expect(stats.requests[0].retried).toBe(true);
    } finally {
      _resetStatsForTesting();
    }
  });

  it("caps Retry-After retry sleeps to maxDelayMs", async () => {
    const config = makeRetryConfig();
    config.server = { ...config.server, upstreamTimeoutMs: 9_999 };
    config.retry = {
      ...config.retry,
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 5,
      backoffFactor: 1,
      retryableStatuses: [529],
    };
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    let callCount = 0;
    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      await req.text();
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
          { status: 529, headers: { "content-type": "application/json", "retry-after": "3600" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Success after capped retry" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const scheduledRetryDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (handler: any, timeout?: number, ...args: unknown[]) => {
      const delay = Number(timeout ?? 0);
      if (delay !== config.server.upstreamTimeoutMs) {
        scheduledRetryDelays.push(delay);
      }
      const actualDelay = delay > 1000 ? 0 : delay;
      return originalSetTimeout(handler as any, actualDelay as any, ...args as any);
    };

    try {
      const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
      const resp = await handler(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
        }),
      );

      expect(resp.status).toBe(200);
      expect(callCount).toBe(2);
      expect(scheduledRetryDelays.some(delay => delay > 0 && delay <= config.retry.maxDelayMs)).toBe(true);
      expect(scheduledRetryDelays.some(delay => delay >= 60_000)).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("cancels retryable response bodies and keeps the final success body readable", async () => {
    const config = makeRetryConfig();
    config.retry = {
      ...config.retry,
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoffFactor: 1,
      retryableStatuses: [529],
    };
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });
    const encoder = new TextEncoder();
    const canceledBodies: string[] = [];
    let finalBodyCanceled = false;
    let callCount = 0;

    const retryableBody = (label: string) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: label },
        })));
        // Intentionally leave the stream open. The retry loop must cancel it
        // before the next upstream attempt.
      },
      cancel() {
        canceledBodies.push(label);
      },
    });

    const finalBody = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Final body survived retries" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        })));
        controller.close();
      },
      cancel() {
        finalBodyCanceled = true;
      },
    });

    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      await req.text();
      if (callCount <= 2) {
        return new Response(retryableBody(`retry-body-${callCount}`), {
          status: 529,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(finalBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    for (let i = 0; i < 10 && canceledBodies.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    expect(callCount).toBe(3);
    expect(canceledBodies).toEqual(["retry-body-1", "retry-body-2"]);
    expect(resp.status).toBe(200);
    const respBody = await resp.json();
    expect(respBody.content[0].text).toBe("Final body survived retries");
    expect(finalBodyCanceled).toBe(false);
  });

  it("returns 502 after all retries exhausted when upstream keeps returning 529", async () => {
    const config = makeRetryConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    let callCount = 0;
    const receivedBodies: string[] = [];

    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      const bodyText = await req.text();
      receivedBodies.push(bodyText);

      // Always return 529
      return new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "always busy" } }),
        { status: 529, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // 1 initial + 3 retries = 4 total attempts
    expect(callCount).toBe(4);
    // Every attempt must have received the full body (proves fresh Request each time)
    expect(receivedBodies.length).toBe(4);
    for (const body of receivedBodies) {
      expect(body).toContain('"Hi"');
    }
    // Final response must be 529 (the exhausted retry status)
    expect(resp.status).toBe(529);
  });

  it("detects SSE errors hidden in 200 streams on retry attempts too", async () => {
    const config = makeRetryConfig();
    const auth = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "testkey.testsecret" });

    let callCount = 0;

    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      await req.text(); // consume body (fresh Request each time, so this is fine)

      // First attempt: return 200 + SSE with hidden 529 error
      if (callCount === 1) {
        const sseBody =
          `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"hidden 529"}}\n\n`;
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      // Second attempt: return real 200 success
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Success after SSE error retry" }],
          model: "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // 2 attempts: 1 initial (200+SSE error → 529) + 1 retry (real 200)
    expect(callCount).toBe(2);
    // Final response must be the real 200 success
    expect(resp.status).toBe(200);
    const respBody = await resp.json();
    expect(respBody.content[0].text).toBe("Success after SSE error retry");
  });
});
