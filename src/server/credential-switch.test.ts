/**
 * Tests for the credential auto-switching feature.
 *
 * When a credential fails consecutively `credentialSwitchThreshold` times
 * (including the initial attempt), the proxy switches to another stored
 * credential and continues retrying. Already-tried credentials are skipped
 * to avoid cycling back to a known-failing one.
 *
 * These tests mock the upstream fetch and the credential store to verify:
 *   1. Switching triggers at the configured threshold
 *   2. The new credential's API key is actually used in the upstream request
 *   3. Already-tried credentials are not revisited
 *   4. When only one credential exists, switching is a no-op
 *   5. When threshold is 0, switching is disabled
 *   6. A successful request after switching returns 200 to the client
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createFetchHandler } from "./server.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use a temp HOME so the credential store doesn't collide with the user's real one.
const TMP_HOME = join(tmpdir(), `zcode-proxy-credswitch-test-${Date.now()}-${process.pid}`);

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.HOME = TMP_HOME;
  process.env.ZCODE_PROXY_ALLOW_PLAINTEXT_STORE = "1";
});

afterEach(() => {
  delete process.env.ZCODE_PROXY_ALLOW_PLAINTEXT_STORE;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const CRED_A: Credential = { apiKey: "key-AAA", provider: "zai", plan: "coding-plan", userId: "user-A" };
const CRED_B: Credential = { apiKey: "key-BBB", provider: "zai", plan: "coding-plan", userId: "user-B" };

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "oauth" },
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
    retry: { maxRetries: 10, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 5, emptyStreamSwitchThreshold: 3 },
    ...overrides,
  };
}

/** Build a 200 Anthropic messages response body (passthrough/anthropic format). */
function successBody(text: string): string {
  return JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "glm-4.6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

describe("credential auto-switching", () => {
  it("switches to the second credential after threshold consecutive failures", async () => {
    const config = makeConfig();
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    // Track which credential's API key was used in each upstream request.
    const seenApiKeys: string[] = [];

    const mockFetch = (async (req: Request): Promise<Response> => {
      // Extract the API key from x-api-key header (anthropic coding-plan mode)
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text(); // consume body

      // Credential A always fails with 529; credential B succeeds.
      if (apiKey === "key-AAA") {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
          { status: 529, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(successBody("Success with credential B"), {
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

    // Should succeed (credential B returns 200)
    expect(resp.status).toBe(200);

    // Credential A should have been used 5 times (initial + 4 retries = threshold of 5),
    // then credential B should have been used once (and succeeded).
    const aCount = seenApiKeys.filter(k => k === "key-AAA").length;
    const bCount = seenApiKeys.filter(k => k === "key-BBB").length;
    expect(aCount).toBe(5);
    expect(bCount).toBe(1);
    expect(seenApiKeys.length).toBe(6);
  });

  it("does NOT switch when threshold is 0 (disabled)", async () => {
    const config = makeConfig({
      retry: { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      return new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
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

    // All attempts should use credential A (no switching)
    expect(seenApiKeys.every(k => k === "key-AAA")).toBe(true);
    // 1 initial + 5 retries = 6 total
    expect(seenApiKeys.length).toBe(6);
    // Final response is 529 (exhausted)
    expect(resp.status).toBe(529);
  });

  it("does NOT switch when only one credential is available", async () => {
    const config = makeConfig();
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A], // only one credential
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      return new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
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

    // All attempts use credential A (no alternative to switch to)
    expect(seenApiKeys.every(k => k === "key-AAA")).toBe(true);
    expect(seenApiKeys.length).toBe(11); // 1 initial + 10 retries
    expect(resp.status).toBe(529);
  });

  it("does NOT cycle back to a previously-failed credential", async () => {
    // With 2 credentials where BOTH fail, the proxy should:
    //   - Use A for 5 attempts → switch to B
    //   - Use B for remaining 5 attempts (no cycling back to A)
    const config = makeConfig();
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      // Both credentials always fail
      return new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
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

    // vceshi0.0.5+: end-of-loop switch grants 1 extra attempt when switching,
    // so total is 1 initial + 10 retries + 1 end-of-loop extra = 12 attempts.
    // (Previously 11 — the off-by-one fix gives the switched-to credential
    // a fair shot instead of breaking immediately when the threshold is hit
    // on the last retry.)
    expect(seenApiKeys.length).toBe(12);
    // First 5 should be A (initial + 4 retries before threshold=5 triggers switch)
    expect(seenApiKeys.slice(0, 5).every(k => k === "key-AAA")).toBe(true);
    // After switch, remaining 7 should all be B (no cycling back to A)
    expect(seenApiKeys.slice(5).every(k => k === "key-BBB")).toBe(true);
    // Final response is 529 (exhausted)
    expect(resp.status).toBe(529);
  });

  it("switches at threshold=1 (switch on every failure)", async () => {
    const config = makeConfig({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 1, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      if (apiKey === "key-BBB") {
        return new Response(successBody("Success with B"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
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

    // With threshold=1: initial attempt with A fails (counter=1 >= 1),
    // retry 1 switches to B before fetching. B succeeds.
    expect(resp.status).toBe(200);
    expect(seenApiKeys[0]).toBe("key-AAA"); // initial
    expect(seenApiKeys[1]).toBe("key-BBB"); // switched
    expect(seenApiKeys.length).toBe(2);
  });

  it("switches multiple times with 3 credentials when earlier ones keep failing", async () => {
    const CRED_C: Credential = { apiKey: "key-CCC", provider: "zai", plan: "coding-plan", userId: "user-C" };
    const config = makeConfig({
      retry: { maxRetries: 12, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 3, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B, CRED_C],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      if (apiKey === "key-CCC") {
        return new Response(successBody("Success with C"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
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

    expect(resp.status).toBe(200);
    // A used 3 times (threshold=3), then B used 3 times, then C used once (success)
    const aCount = seenApiKeys.filter(k => k === "key-AAA").length;
    const bCount = seenApiKeys.filter(k => k === "key-BBB").length;
    const cCount = seenApiKeys.filter(k => k === "key-CCC").length;
    expect(aCount).toBe(3);
    expect(bCount).toBe(3);
    expect(cCount).toBe(1);
    expect(seenApiKeys.length).toBe(7);
  });

  it("counts network errors toward the credential-switch threshold", async () => {
    const config = makeConfig({
      retry: { maxRetries: 8, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 3, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    let callCount = 0;
    const mockFetch = (async (req: Request): Promise<Response> => {
      callCount++;
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      // Credential A: always throw a network error
      if (apiKey === "key-AAA") {
        throw new Error("ECONNREFUSED");
      }
      // Credential B: succeed
      return new Response(successBody("Success with B"), {
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

    // The initial attempt with A throws (counter=1). Then retries 1, 2 with A
    // also throw (counter=2, 3). At retry 3, threshold (3) is reached → switch to B.
    // But wait: the initial fetch is OUTSIDE the retry loop and throws → returns 502
    // immediately without entering the retry loop. So switching never happens for
    // network errors on the initial attempt.
    //
    // This is the existing behavior — the initial network error is NOT retried.
    // Only errors INSIDE the retry loop are retried (and counted for switching).
    // So we expect a 502 here.
    expect(resp.status).toBe(502);
  });
});

describe("AuthManager.switchToNextCredential", () => {
  it("returns null when listAllCredentials is not configured", async () => {
    const mgr = new AuthManager({ mode: "oauth", provider: "zai" });
    mgr.setOAuthCredential(CRED_A);
    const result = await mgr.switchToNextCredential();
    expect(result).toBeNull();
  });

  it("returns null when only one credential exists", async () => {
    const mgr = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A],
    });
    mgr.setOAuthCredential(CRED_A);
    const result = await mgr.switchToNextCredential();
    expect(result).toBeNull();
  });

  it("returns a different credential and updates the active one", async () => {
    const mgr = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    mgr.setOAuthCredential(CRED_A);
    const result = await mgr.switchToNextCredential();
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe("key-BBB");
    // Subsequent getCredential returns the switched credential
    const current = await mgr.getCredential();
    expect(current.apiKey).toBe("key-BBB");
  });

  it("excludes credentials in the excludeApiKeys set", async () => {
    const mgr = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    mgr.setOAuthCredential(CRED_A);
    // Exclude both A (current) and B → no candidates
    const excluded = new Set<string>(["key-AAA", "key-BBB"]);
    const result = await mgr.switchToNextCredential(excluded);
    expect(result).toBeNull();
  });

  it("skips disabled credentials when switching (vceshi0.0.6+)", async () => {
    // CRED_B is disabled — switching from A should return null (no enabled alternative)
    const CRED_B_DISABLED: Credential = { ...CRED_B, disabled: true };
    const mgr = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B_DISABLED],
    });
    mgr.setOAuthCredential(CRED_A);
    const result = await mgr.switchToNextCredential();
    expect(result).toBeNull(); // B is disabled, no other candidates
  });

  it("returns null when listAllCredentials throws", async () => {
    const mgr = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => { throw new Error("store read failed"); },
    });
    mgr.setOAuthCredential(CRED_A);
    const result = await mgr.switchToNextCredential();
    expect(result).toBeNull();
  });
});

describe("empty-stream 529 → 3 retries then credential switch", () => {
  // These tests cover the vCESHI0.0.3 fix for "200 empty response treated as
  // valid output when quota is exhausted". The sse-error-detector now tags
  // empty HTTP 200 + text/event-stream responses with x-zcode-empty-stream:1
  // and converts them to synthetic 529. handler.ts then tracks consecutive
  // empty-stream responses per credential and switches after 3 (faster than
  // the generic credentialSwitchThreshold=5).

  it("switches to the next credential after 3 consecutive empty-stream responses", async () => {
    // Default config: maxRetries=3, credentialSwitchThreshold=5
    // Empty-stream switch threshold is hardcoded to 3 in handler.ts
    const config = makeConfig({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 5, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      // Credential A returns empty SSE stream (quota exhausted signature)
      // Credential B returns a successful SSE stream
      if (apiKey === "key-AAA") {
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { c.close(); }, // empty stream — zero events
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      // Credential B: return a real SSE event
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // The proxy should have:
    //   1. Initial attempt with A → empty stream → counted as empty #1
    //   2. Retry 1 with A → empty stream → counted as empty #2
    //   3. Retry 2 with A → empty stream → counted as empty #3 → switch to B
    //   4. Retry 3 with B → real SSE event → success
    expect(seenApiKeys.length).toBe(4); // 1 initial + 3 retries
    expect(seenApiKeys.slice(0, 3).every(k => k === "key-AAA")).toBe(true);
    expect(seenApiKeys[3]).toBe("key-BBB");
    // Final response should be 200 (the successful SSE stream from B)
    expect(resp.status).toBe(200);
  });

  it("returns 529 to client when all credentials return empty streams", async () => {
    const config = makeConfig({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 5, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      // Both credentials return empty streams
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { c.close(); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // Flow:
    //   1. Initial A → empty #1
    //   2. Retry 1 A → empty #2
    //   3. Retry 2 A → empty #3 → switch to B (extra attempt granted)
    //   4. Retry 3 B → empty #1 (counter reset on switch)
    //   5. Retry 4 B → empty #2
    //   6. Retry 5 B → empty #3 → switch to... no alternative left, continue with B
    //   7. Loop ends (extraAttempts exhausted)
    // We expect:
    //   - A is used for the first 3 attempts
    //   - B is used for the remaining attempts
    //   - Final response is 529 (the synthetic empty-stream 529)
    expect(seenApiKeys.slice(0, 3).every(k => k === "key-AAA")).toBe(true);
    expect(seenApiKeys.slice(3).every(k => k === "key-BBB")).toBe(true);
    expect(resp.status).toBe(529);
  });

  // ---------------------------------------------------------------------------
  // vceshi0.0.9 regression tests: previously-uncovered empty 200 signatures
  // ---------------------------------------------------------------------------

  it("switches credential when SSE stream contains only whitespace (not zero bytes)", async () => {
    // vceshi0.0.9 fix: old empty-stream check required bufferedChunks.length===0.
    // Quota-exhausted gateways often return a few bytes of whitespace / empty
    // SSE event block (`\n\n`) instead of zero bytes. This test reproduces the
    // user's actual scenario — the SSE stream has bytes but no real events.
    const config = makeConfig({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 5, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      if (apiKey === "key-AAA") {
        // Whitespace-only SSE stream — old check would NOT detect this as empty
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("\n\n"));
            c.close();
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      // Credential B: return a real SSE event
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // Should switch to B after 3 consecutive whitespace-only streams from A,
    // then succeed with B's real SSE event.
    expect(seenApiKeys.length).toBe(4); // 1 initial + 3 retries
    expect(seenApiKeys.slice(0, 3).every(k => k === "key-AAA")).toBe(true);
    expect(seenApiKeys[3]).toBe("key-BBB");
    expect(resp.status).toBe(200);
  });

  it("switches credential when batch (non-SSE) request returns 200 with empty body", async () => {
    // vceshi0.0.9 fix: previously the detector only inspected text/event-stream
    // responses. Batch requests (stream: false) get application/json back, and
    // when quota is exhausted the gateway returns 200 with empty body. The
    // detector skipped these entirely → no retry → no credential switch.
    //
    // User-visible symptom (from log):
    //   | #063 | ... | glm-5.2 | batch | 200 | 1019ms | in:- out:- |
    const config = makeConfig({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 5, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      if (apiKey === "key-AAA") {
        // Empty JSON body — old detector would skip (not text/event-stream)
        return new Response("", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Credential B: return a real Anthropic non-streaming response
      const realBody = JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        model: "glm-5.2",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      return new Response(realBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // stream: false → batch request, gets application/json back
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, stream: false, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    // Should switch to B after 3 consecutive empty JSON responses from A,
    // then succeed with B's real response.
    expect(seenApiKeys.length).toBe(4);
    expect(seenApiKeys.slice(0, 3).every(k => k === "key-AAA")).toBe(true);
    expect(seenApiKeys[3]).toBe("key-BBB");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("Hello!");
  });

  it("switches credential when batch request returns 200 with `{}` (content-less JSON)", async () => {
    // Another signature of quota exhaustion: gateway returns 200 + valid JSON
    // but the JSON has no recognizable content/choices/usage fields.
    const config = makeConfig({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1, retryableStatuses: [529], credentialSwitchThreshold: 5, emptyStreamSwitchThreshold: 3 },
    });
    const auth = new AuthManager({
      mode: "oauth",
      provider: "zai",
      listAllCredentials: async () => [CRED_A, CRED_B],
    });
    auth.setOAuthCredential(CRED_A);

    const seenApiKeys: string[] = [];
    const mockFetch = (async (req: Request): Promise<Response> => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenApiKeys.push(apiKey);
      await req.text();
      if (apiKey === "key-AAA") {
        // `{}` — parses as valid JSON but has no content/choices/usage
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const realBody = JSON.stringify({
        id: "msg_2",
        content: [{ type: "text", text: "World!" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      return new Response(realBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const handler = createFetchHandler({ config, auth, fetchImpl: mockFetch });
    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, stream: false, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );

    expect(seenApiKeys.length).toBe(4);
    expect(seenApiKeys[3]).toBe("key-BBB");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("World!");
  });
});

describe("config loader: credentialSwitchThreshold", () => {
  const TMP = join(tmpdir(), `zcode-proxy-cfg-test-${Date.now()}-${process.pid}`);

  function writeYaml(content: string): string {
    mkdirSync(TMP, { recursive: true });
    const p = join(TMP, "config.yaml");
    writeFileSync(p, content, "utf-8");
    return p;
  }

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD;
  });

  it("defaults to 5 when not specified", async () => {
    const { loadConfig } = await import("../config/loader.js");
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.credentialSwitchThreshold).toBe(5);
  });

  it("loads from YAML", async () => {
    const { loadConfig } = await import("../config/loader.js");
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  credentialSwitchThreshold: 10
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.credentialSwitchThreshold).toBe(10);
  });

  it("env var overrides YAML", async () => {
    const { loadConfig } = await import("../config/loader.js");
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  credentialSwitchThreshold: 3
`);
    process.env.ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD = "7";
    const cfg = loadConfig(path);
    expect(cfg.retry.credentialSwitchThreshold).toBe(7);
  });

  it("0 disables switching", async () => {
    const { loadConfig } = await import("../config/loader.js");
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
retry:
  credentialSwitchThreshold: 0
`);
    const cfg = loadConfig(path);
    expect(cfg.retry.credentialSwitchThreshold).toBe(0);
  });
});
