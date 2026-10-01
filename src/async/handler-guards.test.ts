/**
 * Regression tests for the async handler's request-shape guards (R3 hardening):
 * - `handleAsyncChat` on a literal `null` JSON body must return 400
 *   invalid_request_error (previously the null slipped past the try/catch and
 *   surfaced as a 500 internal_error via the server's catch-all).
 * - Same-object guard for arrays / scalars.
 *
 * resolveCredential is stubbed with a minimal AuthManager-shaped object so the
 * test reaches the body-parse guard without a stored credential.
 */
import { describe, expect, test } from "bun:test";
import { handleAsyncChat, type AsyncHandlerOptions } from "./handler.js";
import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";

function makeOpts(): AsyncHandlerOptions {
  const auth = {
    getCredential: async () => ({
      apiKey: "k",
      jwt: "jwt",
      provider: "zai",
    }),
  } as unknown as AuthManager;
  const config = {
    provider: "zai",
    plan: "coding-plan",
    models: ["glm-4.6"],
    identity: { appVersion: "test", deviceMid: "mid", refererOrigin: "https://x", sourceTitle: "t" },
    claim: {},
    async: { enabled: true },
  } as unknown as ProxyConfig;
  return { config, auth };
}

function reqWithBody(body: string): Request {
  return new Request("http://127.0.0.1/async/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("handleAsyncChat body-shape guards", () => {
  test("literal null body → 400 invalid_request_error (not 500)", async () => {
    const resp = await handleAsyncChat(reqWithBody("null"), makeOpts());
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("array body → 400 invalid_request_error", async () => {
    const resp = await handleAsyncChat(reqWithBody("[]"), makeOpts());
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("malformed JSON → 400 invalid_request_error", async () => {
    const resp = await handleAsyncChat(reqWithBody("{nope"), makeOpts());
    expect(resp.status).toBe(400);
  });
});
