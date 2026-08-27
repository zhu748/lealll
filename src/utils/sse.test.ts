import { expect, test } from "bun:test";
import { _resetSseWarningStateForTesting, parseSSEChunk, waitForBackpressure } from "./sse.js";

test("parseSSEChunk rate-limits malformed JSON warnings", () => {
  _resetSseWarningStateForTesting();
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    const raw = Array.from({ length: 20 }, (_, i) => `data: {bad-${i}\n\n`).join("");
    const parsed = parseSSEChunk(raw);
    expect(parsed).toHaveLength(20);
    expect(warnings).toBeLessThanOrEqual(6);
  } finally {
    console.warn = originalWarn;
    _resetSseWarningStateForTesting();
  }
});

test("parseSSEChunk parses many events from one merged chunk", () => {
  const raw = Array.from({ length: 250 }, (_, i) =>
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${i}"}}\n\n`
  ).join("");

  const parsed = parseSSEChunk(raw);

  expect(parsed).toHaveLength(250);
  expect(parsed[0].event).toBe("content_block_delta");
  expect((parsed[0].data as { delta: { text: string } }).delta.text).toBe("0");
  expect((parsed[249].data as { delta: { text: string } }).delta.text).toBe("249");
});

test("parseSSEChunk parses a final event without a trailing delimiter", () => {
  const parsed = parseSSEChunk(
    `event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
  );

  expect(parsed).toHaveLength(1);
  expect(parsed[0].event).toBe("message_delta");
  expect((parsed[0].data as { type: string }).type).toBe("message_delta");
});

test("waitForBackpressure keeps yielding until desiredSize recovers or the wait cap is hit", async () => {
  let reads = 0;
  const controller = {
    get desiredSize() {
      reads++;
      return reads < 3 ? 0 : 1;
    },
  } as ReadableStreamDefaultController;

  await waitForBackpressure(controller, 1, 50);

  expect(reads).toBeGreaterThanOrEqual(3);
});

test("waitForBackpressure clamps pathological timer inputs", async () => {
  const originalSetTimeout = globalThis.setTimeout as any;
  const delays: number[] = [];
  let reads = 0;
  const controller = {
    get desiredSize() {
      reads++;
      return reads < 3 ? 0 : 1;
    },
  } as ReadableStreamDefaultController;

  (globalThis as any).setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    delays.push(Number(timeout));
    return originalSetTimeout(handler as any, 0 as any, ...args as any);
  };

  try {
    await waitForBackpressure(controller, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }

  expect(delays.length).toBeGreaterThan(0);
  expect(delays.every(Number.isFinite)).toBe(true);
  expect(Math.max(...delays)).toBeLessThanOrEqual(100);
});
