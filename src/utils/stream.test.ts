import { describe, expect, it } from "bun:test";
import { createBackpressuredStream } from "./stream.js";
import { waitForBackpressure } from "./sse.js";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse } from "../translator/sse-translator.js";
import { anthropicSseToOpenaiSseWithKeepalive } from "../async/openai-stream-adapter.js";

describe("stream pressure and cancellation", () => {
  it("keeps an unread byte queue bounded until the consumer drains it", async () => {
    let produced = 0;
    const stream = createBackpressuredStream({ async start(controller) {
      for (let i = 0; i < 10; i++) { await waitForBackpressure(controller); controller.enqueue(new Uint8Array(1024)); produced++; }
      controller.close();
    } }, 2048);
    await new Promise(r => setTimeout(r, 40));
    expect(produced).toBe(2); // Waiting longer never bypasses the byte budget.
    const reader = stream.getReader(); let received = 0;
    while (!(await reader.read()).done) received++;
    expect(received).toBe(10);
  });
  it("wakes a pressure-blocked writer on consumer cancellation", async () => {
    let finished = false;
    const stream = createBackpressuredStream({ async start(controller) {
      try { controller.enqueue(new Uint8Array(2048)); await waitForBackpressure(controller); controller.enqueue(new Uint8Array(1)); }
      finally { finished = true; }
    } }, 1024);
    await new Promise(r => setTimeout(r, 0)); await stream.cancel();
    await new Promise(r => setTimeout(r, 0)); expect(finished).toBe(true);
  });
  for (const [name, translate] of [
    ["Anthropic → OpenAI", anthropicSseToOpenaiSse],
    ["OpenAI → Anthropic", openaiSseToAnthropicSse],
    ["async OpenAI adapter", anthropicSseToOpenaiSseWithKeepalive],
  ] as const) {
    it(`cancels a pending upstream read and unlocks it: ${name}`, async () => {
      let cancelled = false;
      const upstream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
      const output = translate(upstream);
      await new Promise(r => setTimeout(r, 0));
      await output.cancel("disconnected"); await new Promise(r => setTimeout(r, 0));
      expect(cancelled).toBe(true); expect(upstream.locked).toBe(false);
    });
  }
});
