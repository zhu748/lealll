import { describe, expect, it } from "bun:test";
import { readResponseBytes, ResponseBodyLimitError } from "./response-body.js";

describe("bounded upstream response bytes", () => {
  it("reads UTF-8 bytes and releases the completed reader", async () => {
    const response = new Response("中文🙂");
    expect((await readResponseBytes(response, 10)).toString()).toBe("中文🙂");
    expect(response.body!.locked).toBe(false);
  });
  it("handles empty bodies and a zero-byte budget", async () => {
    expect(await readResponseBytes(new Response(null), 0)).toEqual(Buffer.alloc(0));
    await expect(readResponseBytes(new Response("x"), 0)).rejects.toBeInstanceOf(ResponseBodyLimitError);
  });
  it("rejects a declared oversize without reading and cancels the response", async () => {
    let reads = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { "content-length": "1000" } });
    await expect(readResponseBytes(response, 10)).rejects.toThrow("10 byte cap");
    expect(reads).toBe(0);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it("stops reading a chunked response as soon as it exceeds the byte budget", async () => {
    let reads = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(readResponseBytes(new Response(body), 10)).rejects.toBeInstanceOf(ResponseBodyLimitError);
    expect(reads).toBe(3);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it("does not trust a small content-length when streamed bytes are larger", async () => {
    const response = new Response("中文🙂", { headers: { "content-length": "1" } });
    await expect(readResponseBytes(response, 9)).rejects.toThrow("byte cap");
    expect(response.body!.locked).toBe(false);
  });
  it("accepts exactly the budget and does not cancel a complete response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); },
      cancel() { cancelled = true; },
    });
    expect(await readResponseBytes(new Response(body), 3)).toEqual(Buffer.from([1, 2, 3]));
    expect(cancelled).toBe(false);
  });
  it("unlocks an upstream response whose reader errors", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("disconnected")); } });
    await expect(readResponseBytes(new Response(body), 10)).rejects.toThrow("disconnected");
    expect(body.locked).toBe(false);
  });
  it.each([-1, NaN, Infinity, 1.5])("rejects an invalid byte budget (%s)", async (limit) => {
    await expect(readResponseBytes(new Response(null), limit)).rejects.toThrow("byte cap");
  });
});
