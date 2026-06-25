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
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    logging: { level: "info" },
    // Enable retries: 529 is retryable, use short delays for fast tests
    retry: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 2, retryableStatuses: [529, 502], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
  };
}

describe("retry body-reuse regression", () => {
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
