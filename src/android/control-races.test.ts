import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlDispatcher, startControlListener, LogBuffer, type ControlState } from "./control.js";
import { loadCredential, invalidateStoreCache } from "../auth/store.js";
import type { Credential } from "../auth/types.js";
import type { OAuthFlowClient, OAuthFlowStart } from "../auth/oauth.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const started = { authorizeUrl: "https://offline.test/authorize", callbackUrl: "", state: "offline-state" } as OAuthFlowStart;
const credential: Credential = { apiKey: "offline-login-key", provider: "zai" };
function state(): ControlState { return { provider: "zai", plan: "coding-plan", proxyPort: 0 }; }
const tick = () => new Promise(r => setTimeout(r, 0));
let dir: string; let previous: string | undefined;
beforeEach(() => { previous = process.env.ZCODE_PROXY_STORE_DIR; dir = mkdtempSync(join(tmpdir(), "control-races-")); process.env.ZCODE_PROXY_STORE_DIR = dir; invalidateStoreCache(); });
afterEach(() => { if (previous === undefined) delete process.env.ZCODE_PROXY_STORE_DIR; else process.env.ZCODE_PROXY_STORE_DIR = previous; invalidateStoreCache(); rmSync(dir, { recursive: true, force: true }); });

describe("control command races", () => {
  it("closes a starting OAuth client when logout arrives", async () => {
    const ready = deferred<OAuthFlowStart>(); let closes = 0;
    const client = { start: () => ready.promise, close: async () => { closes++; }, complete: () => new Promise(() => {}) } as unknown as OAuthFlowClient;
    const dispatch = createControlDispatcher(state(), { logBuffer: new LogBuffer(), createLoginClient: () => client });
    const login = dispatch({ cmd: "startOAuth", provider: "zai" }); await tick();
    const logout = dispatch({ cmd: "logout" }); expect(closes).toBeGreaterThan(0);
    ready.resolve(started); expect(await login).toEqual({ ok: false, error: "oauth_cancelled" });
    expect((await logout).ok).toBe(true); expect(await loadCredential()).toBeNull();
  });
  it("does not save a credential resolved after logout", async () => {
    const resolving = deferred<void>(); const resolved = deferred<Credential>();
    const client = { start: async () => started, close: async () => {}, complete: async () => ({ accessToken: "offline" }) } as unknown as OAuthFlowClient;
    const dispatch = createControlDispatcher(state(), { logBuffer: new LogBuffer(), createLoginClient: () => client,
      resolveLoginCredential: async () => { resolving.resolve(); return resolved.promise; } });
    await dispatch({ cmd: "startOAuth", provider: "zai" }); await resolving.promise;
    await dispatch({ cmd: "logout" }); resolved.resolve(credential); await tick(); await tick();
    expect(await loadCredential()).toBeNull();
  });
  it("serializes overlapping start and stop commands", async () => {
    const ready = deferred<void>(); const events: string[] = []; const runtime = state();
    const dispatch = createControlDispatcher(runtime, { logBuffer: new LogBuffer(),
      onStartProxy: async () => { events.push("start"); await ready.promise; return { ok: true, port: 4321 }; },
      onStopProxy: async () => { expect(runtime.proxyPort).toBe(4321); events.push("stop"); return { ok: true }; } });
    const starting = dispatch({ cmd: "startProxy" }); const stopping = dispatch({ cmd: "stopProxy" });
    await tick(); expect(events).toEqual(["start"]); ready.resolve();
    await starting; await stopping; expect(events).toEqual(["start", "stop"]); expect(runtime.proxyPort).toBe(0);
  });
  it("uses the configured credential source for status", async () => {
    const dispatch = createControlDispatcher(state(), { logBuffer: new LogBuffer(), getCredential: async () => credential });
    expect(await dispatch({ cmd: "status" })).toMatchObject({ ok: true, loggedIn: true });
  });
  it("flushes the shutdown reply before closing the listener", async () => {
    const previousToken = process.env.ZCODE_CONTROL_TOKEN;
    process.env.ZCODE_CONTROL_TOKEN = "offline-test-control-token-123456789";
    const stopped = deferred<void>();
    const listener = await startControlListener({ port: 0, state: state(), onShutdown: async () => { await listener.close(); stopped.resolve(); } });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/control`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.ZCODE_CONTROL_TOKEN }, body: JSON.stringify({ cmd: "shutdown" }), signal: AbortSignal.timeout(1000) });
      expect(await response.json()).toEqual({ ok: true, event: "shuttingDown" }); await stopped.promise;
    } finally { await listener.close(); if (previousToken === undefined) delete process.env.ZCODE_CONTROL_TOKEN; else process.env.ZCODE_CONTROL_TOKEN = previousToken; }
  });
});
