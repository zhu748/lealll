import { describe, expect, it } from "bun:test";
import { fetchJsonWithDeadline } from "./fetch-json.js";

describe("bounded JSON requests", () => {
  it("reads a successful response", async () => {
    expect(await fetchJsonWithDeadline("https://offline.test", {}, (async () => Response.json({ ok: true })) as unknown as typeof fetch)).toEqual({ ok: true });
  });
  it("bounds a fetch that ignores abort", async () => {
    let signal!: AbortSignal;
    const transport = (async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init!.signal!; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
    await expect(fetchJsonWithDeadline("https://offline.test", {}, transport, 15)).rejects.toThrow("timeout");
    expect(signal.aborted).toBe(true);
  });
  it("cancels a stalled response body at the total deadline", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    await expect(fetchJsonWithDeadline("https://offline.test", {}, (async () => response) as unknown as typeof fetch, 15)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(response.body!.locked).toBe(false);
  });
  it("cancels a response arriving after the fetch deadline", async () => {
    let resolve!: (response: Response) => void;
    let cancelled = false;
    const pending = fetchJsonWithDeadline("https://offline.test", {}, (() => new Promise<Response>(r => { resolve = r; })) as unknown as typeof fetch, 10);
    await expect(pending).rejects.toThrow("timeout");
    resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await new Promise(r => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
  it("enforces the UTF-8 byte limit", async () => {
    const body = JSON.stringify({ text: "中".repeat(400_000) });
    await expect(fetchJsonWithDeadline("https://offline.test", {}, (async () => new Response(body)) as unknown as typeof fetch)).rejects.toThrow("byte limit");
  });
  it("forwards caller cancellation even if fetch ignores it", async () => {
    const controller = new AbortController();
    const pending = fetchJsonWithDeadline("https://offline.test", { signal: controller.signal }, (async () => new Promise<Response>(() => {})) as unknown as typeof fetch, 5000);
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toThrow("caller stopped");
  });
  it("does not dispatch an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await expect(fetchJsonWithDeadline("https://offline.test", { signal: controller.signal }, (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
