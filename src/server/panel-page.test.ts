import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./panel-page.txt", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
function panel(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const nodes = new Map<string, any>();
  const document = { hidden: false, getElementById: (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", checked: true, scrollTop: 0, scrollHeight: 0, clientHeight: 200 });
    return nodes.get(id);
  } };
  const source = script.slice(0, script.indexOf('      if (token) {\n        $("token").value = token;'));
  const api = new Function("fetch", "document", "localStorage", `${source}
    return {cmd,refreshStatus,setToken:value=>{token=value;commandEpoch++}};`)(fetchImpl, document, { getItem: () => "offline-token" }) as {
      cmd: (payload: unknown) => Promise<any>; refreshStatus: () => Promise<void>; setToken: (value: string) => void;
    };
  return { ...api, document };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("standalone panel polling", () => {
  it("contains syntactically valid browser code", () => { expect(() => new Function(script)).not.toThrow(); });
  it("coalesces overlapping status polls", async () => {
    let calls = 0; const response = deferred<Response>(); const api = panel(async () => { calls++; return response.promise; });
    const one = api.cmd({ cmd: "status" }); const two = api.cmd({ cmd: "status" }); expect(calls).toBe(1);
    response.resolve(Response.json({ ok: true })); expect(await one).toEqual(await two);
  });
  it("discards replies from the previous token", async () => {
    const response = deferred<Response>(); const api = panel(async () => response.promise);
    const pending = api.cmd({ cmd: "status" }); api.setToken("new-token"); response.resolve(Response.json({ ok: true, loggedIn: true }));
    expect(await pending).toEqual({ ok: false, stale: true }); expect(api.document.getElementById("raw").textContent).toBe("");
  });
  it("retains edited provider and plan values across status polls", async () => {
    const api = panel(async () => Response.json({ ok: true, provider: "zai", plan: "coding-plan", loggedIn: true, proxyPort: 0 }));
    const provider = api.document.getElementById("cfg-provider"); provider.value = "bigmodel"; provider.onchange();
    const plan = api.document.getElementById("cfg-plan"); plan.value = "start-plan"; plan.onchange();
    await api.refreshStatus(); expect(provider.value).toBe("bigmodel"); expect(plan.value).toBe("start-plan");
  });
  it("pauses automatic status polling in a hidden tab", async () => {
    let calls = 0; const api = panel(async () => { calls++; return Response.json({}); }); api.document.hidden = true;
    await api.refreshStatus(); expect(calls).toBe(0);
  });
});
