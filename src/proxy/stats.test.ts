import { afterEach, describe, expect, it } from "bun:test";
import { createStatsTransform, observeStatsStream } from "./stats.js";
import { _resetStatsForTesting } from "../admin/stats.js";
import { SSE } from "../utils/constants.js";

afterEach(_resetStatsForTesting);

async function collect(chunks: Uint8Array[], contentEncoding: string | null = null) {
  let info: { tokens: number; inputTokens: number } | undefined;
  const stats = createStatsTransform("stats-test", "openai", { model: "test", stream: true }, 200,
    Date.now(), contentEncoding, undefined, 0, false, { onDone(value) { info = value; } });
  const upstream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
  const output = new Uint8Array(await new Response(observeStatsStream(upstream, stats)).arrayBuffer());
  await stats.done;
  return { output, info };
}

describe("stream statistics", () => {
  it("reads multi-line usage with CRLF split at every byte, preserving the wire bytes", async () => {
    const input = new TextEncoder().encode('data: {"usage":\r\ndata: {"prompt_tokens":3,"completion_tokens":9}}\r\n\r\n');
    const result = await collect(Array.from(input, byte => Uint8Array.of(byte)));
    expect(result.output).toEqual(input);
    expect(result.info).toMatchObject({ tokens: 9, inputTokens: 3 });
  });

  it("observes a final usage event without its blank-line terminator", async () => {
    const input = new TextEncoder().encode('data: {"usage":{"completion_tokens":7}}');
    const result = await collect([input]);
    expect(result.output).toEqual(input);
    expect(result.info?.tokens).toBe(7);
  });

  it("disables parsing after overflow without discarding or changing the response", async () => {
    const input = new TextEncoder().encode("data: " + "x".repeat(SSE.MAX_STATS_BUFFERED_EVENT_BYTES) + '\n\ndata: {"usage":{"completion_tokens":9}}\n\n');
    const result = await collect([input.subarray(0, 100), input.subarray(100)]);
    expect(result.output).toEqual(input);
    expect(result.info?.tokens).toBe(0);
  });

  it("passes compressed bytes through without interpreting them as SSE", async () => {
    const input = new TextEncoder().encode('data: {"usage":{"completion_tokens":9}}\n\n');
    const result = await collect([input], "gzip");
    expect(result.output).toEqual(input);
    expect(result.info?.tokens).toBe(0);
  });
});
