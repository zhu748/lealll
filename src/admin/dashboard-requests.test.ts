import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./dashboard.html.txt", import.meta.url), "utf8");
const helpers = html.slice(html.indexOf("let dashboardAbortController="), html.indexOf("// --- Login ---"));
function requests(fetchImpl: (input: unknown, init?: RequestInit) => Promise<any>) {
  return new Function("fetch", `let authToken='session-one',dashboardInitGeneration=1;
    const cloneJson=value=>structuredClone(value); const MUTATION_TIMEOUT_MS=8000;
    ${helpers}
    return {json:fetchJsonWithTimeout,abort:abortDashboardRequests,setSession:value=>{authToken=value;dashboardInitGeneration++}};`)(fetchImpl) as {
      json: (url: string, init?: RequestInit, timeout?: number) => Promise<any>;
      abort: () => void; setSession: (value: string) => void;
    };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("dashboard request behavior", () => {
  it("shares overlapping GETs and gives consumers independent JSON values", async () => {
    let calls = 0; const body = deferred<Response>();
    const api = requests(async () => { calls++; return (await body.promise).clone(); });
    const first = api.json("/accounts"); const second = api.json("/accounts"); expect(calls).toBe(1);
    body.resolve(Response.json({ accounts: [{ name: "original" }] }));
    const a = await first; const b = await second; a.accounts[0].name = "changed";
    expect(b.accounts[0].name).toBe("original");
    await api.json("/accounts"); expect(calls).toBe(2);
  });
  it("keeps requests with different authorization headers separate", async () => {
    let calls = 0; const api = requests(async () => { calls++; return Response.json({}); });
    await Promise.all([api.json("/accounts", { headers: { authorization: "one" } }), api.json("/accounts", { headers: { authorization: "two" } })]);
    expect(calls).toBe(2);
  });
  it("rejects stale responses after a session change", async () => {
    const response = deferred<Response>(); const api = requests(async () => response.promise);
    const pending = api.json("/accounts"); api.setSession("session-two"); response.resolve(Response.json({ old: true }));
    await expect(pending).rejects.toThrow("stale dashboard response");
  });
  it("cancels in-flight work even when fetch ignores AbortSignal", async () => {
    const api = requests(async () => new Promise(() => {})); const pending = api.json("/accounts"); api.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("bounds stalled JSON body consumption", async () => {
    const api = requests(async () => ({ ok: true, json: () => new Promise(() => {}) }));
    await expect(api.json("/accounts", {}, 10)).rejects.toThrow("timeout");
  });
  it("invalidates pending reads when a mutation succeeds", async () => {
    const response = deferred<Response>(); const api = requests(async (_url, init) => init?.method === "PUT" ? Response.json({ ok: true }) : response.promise);
    const pending = api.json("/config"); await api.json("/config", { method: "PUT" }); response.resolve(Response.json({ old: true }));
    await expect(pending).rejects.toThrow("stale dashboard response");
  });
});

describe("dashboard form drafts", () => {
  function form(snapshot: Promise<any>) {
    const nodes = new Map<string, any>(); const handlers: Record<string, (event: any) => void> = {};
    const document = { addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; }, getElementById: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { id, value: "", checked: false }); return nodes.get(id);
    } };
    const settings = html.slice(html.indexOf("let settingsDirty="), html.indexOf("function readSettingsNumberInput"));
    const endpoints = html.slice(html.indexOf("async function loadProxyEndpoints()"), html.indexOf("async function saveProxyEndpoints()"));
    const api = new Function("document", "fetchConfigSnapshot", `const authToken='test',dashboardInitGeneration=1;
      const dashboardCanUpdate=()=>true,dashboardActionCurrent=()=>true,toast=()=>{};
      ${settings}\n${endpoints}\nreturn {settings:loadSettings,endpoints:loadProxyEndpoints};`)(document, async () => snapshot);
    return { api, edit: (id: string, value: string) => { const node = document.getElementById(id); node.value = value; handlers.input({ target: node }); return node; } };
  }
  it("retains edits made while a settings refresh is awaiting the server", async () => {
    const snapshot = deferred<any>(); const { api, edit } = form(snapshot.promise);
    const pending = api.settings(); const port = edit("cfgPort", "9099"); snapshot.resolve({ server: { port: 8080 } }); await pending;
    expect(port.value).toBe("9099");
  });
  it("keeps an existing settings draft until an explicit forced reload", async () => {
    const { api, edit } = form(Promise.resolve({ server: { port: 8080 } })); const port = edit("cfgPort", "9099");
    await api.settings(); expect(port.value).toBe("9099"); await api.settings(true); expect(port.value).toBe(8080);
  });
  it("preserves endpoint drafts when background config loads finish", async () => {
    const snapshot = deferred<any>(); const { api, edit } = form(snapshot.promise);
    const pending = api.endpoints(); const endpoint = edit("proxyZaiOpenai", "https://draft.test/v4"); snapshot.resolve({ providers: { zai: { openaiBase: "https://server.test/v4" } } }); await pending;
    expect(endpoint.value).toBe("https://draft.test/v4");
  });
});
