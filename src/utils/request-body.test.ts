import { describe, expect, it } from "bun:test";
import { readRequestBytes, RequestBodyLimitError } from "./request-body.js";
import { readBody, RequestBodyTooLargeError } from "../proxy/request-body.js";

function request(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  return new Request("http://localhost/test", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("bounded request bodies", () => {
  it("reads a fragmented Unicode body up to the exact byte limit and unlocks it", async () => {
    const bytes = new TextEncoder().encode("中文😀");
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2, 7));
      controller.enqueue(bytes.subarray(7));
      controller.close();
    } });
    expect(await readRequestBytes(request(body), bytes.byteLength)).toEqual(bytes);
    expect(body.locked).toBe(false);
  });

  it("rejects declared oversized bodies without locking or cancelling them", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(readRequestBytes(request(body, { "content-length": "100" }), 10)).rejects.toBeInstanceOf(RequestBodyLimitError);
    expect(body.locked).toBe(false);
    expect(cancelled).toBe(false);
  });

  it("unlocks an oversized chunked body without the cancellation that hides a 413", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    }, cancel() { cancelled = true; } });
    await expect(readBody(request(body), 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(body.locked).toBe(false);
    expect(cancelled).toBe(false);
  });

  it("releases the reader when the source fails", async () => {
    const error = new Error("broken source");
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(error); } });
    await expect(readRequestBytes(request(body), 10)).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });
});
