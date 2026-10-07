import { describe, expect, it } from "bun:test";
import { SSEFramer, SSEFrameTooLargeError } from "./sse-framer.js";
import { extractSSEData, parseSSEChunk } from "./sse.js";

describe("incremental SSE framing", () => {
  const raw = '\ufeff: keepalive\r\n\r\nevent: text\rdata: {\rdata: "text":"中文😀"}\r\rdata: {"last":true}';
  const expected = [{ event: "text", data: { text: "中文😀" } }, { event: "", data: { last: true } }];

  it("preserves mixed line endings and multi-line data at every byte boundary", () => {
    const bytes = new TextEncoder().encode(raw);
    for (let width = 1; width <= bytes.length; width++) {
      const framer = new SSEFramer();
      const decoder = new TextDecoder();
      const frames: string[] = [];
      for (let i = 0; i < bytes.length; i += width) {
        frames.push(...framer.push(decoder.decode(bytes.subarray(i, i + width), { stream: true })));
      }
      frames.push(...framer.finish(decoder.decode()));
      expect(frames.flatMap(parseSSEChunk)).toEqual(expected);
      expect(frames[0]).toContain(": keepalive");
      expect(extractSSEData(frames[1])).toBe('{\n"text":"中文😀"}');
    }
  });

  it("accepts all blank-line combinations across separate network reads", () => {
    for (const first of ["\n", "\r", "\r\n"]) {
      for (const second of ["\n", "\r", "\r\n"]) {
        // CR+LF is a single CRLF ending, so it needs another blank line.
        if (first === "\r" && second === "\n") continue;
        const framer = new SSEFramer();
        const frames: string[] = [];
        for (const char of `data: 1${first}${second}data: 2\n\n`) frames.push(...framer.push(char));
        expect(frames.map(extractSSEData)).toEqual(["1", "2"]);
      }
    }
  });

  it("enforces a UTF-8 byte limit on an unfinished event", () => {
    const framer = new SSEFramer(12);
    expect([...framer.push("data: 中")]).toEqual([]);
    expect(() => [...framer.push("中文")]).toThrow(SSEFrameTooLargeError);
  });

  it("bounds each frame rather than rejecting a large merged chunk", () => {
    const framer = new SSEFramer(16);
    const raw = Array.from({ length: 1000 }, (_, i) => `data: ${i}\n\n`).join("");
    expect([...framer.push(raw)]).toHaveLength(1000);
    expect([...framer.finish()]).toEqual([]);
  });

  it("rejects an oversized event even when its complete frame arrives in one read", () => {
    expect(() => [...new SSEFramer(12).push('data: {"text":"too large"}\n\n')]).toThrow(SSEFrameTooLargeError);
  });

  it("flushes once and can then frame a new stream", () => {
    const framer = new SSEFramer();
    expect([...framer.push("data: 1")]).toEqual([]);
    expect([...framer.finish()]).toEqual(["data: 1"]);
    expect([...framer.finish()]).toEqual([]);
    expect([...framer.push("data: 2\r\r")].map(extractSSEData)).toEqual(["2"]);
  });
});
