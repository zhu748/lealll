import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearStore, entryCount, getTurn, saveTurn, totalBytes } from "./responses-store.js";

const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 256;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const realDateNow = Date.now;
const utf8Encoder = new TextEncoder();

function mockNow(ms: number): void {
  Date.now = () => ms;
}

function utf8JsonBytes(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function storedTurnUtf8Bytes(turn: NonNullable<ReturnType<typeof getTurn>>): number {
  return utf8JsonBytes(turn.input) + utf8JsonBytes(turn.output);
}

describe("responses previous_response_id store", () => {
  beforeEach(() => {
    clearStore();
  });

  afterEach(() => {
    Date.now = realDateNow;
    clearStore();
  });

  it("caps a single oversized input item with a truncation marker", () => {
    saveTurn(
      "resp_big_input",
      [{ type: "message", role: "user", content: "x".repeat(400 * 1024) }],
      [{ type: "message", role: "assistant", content: "ok" }],
    );

    const turn = getTurn("resp_big_input")!;
    expect(entryCount()).toBe(1);
    expect(totalBytes()).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(turn.bytes).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(JSON.stringify(turn.input)).toContain("truncated oversized previous_response_id input history");
    expect(JSON.stringify(turn.output)).toContain("ok");
  });

  it("caps oversized non-ASCII input by UTF-8 bytes instead of UTF-16 length", () => {
    saveTurn(
      "resp_big_utf8_input",
      [{ type: "message", role: "user", content: "汉".repeat(100 * 1024) }],
      [{ type: "message", role: "assistant", content: "ok" }],
    );

    const turn = getTurn("resp_big_utf8_input")!;
    expect(totalBytes()).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(turn.bytes).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(storedTurnUtf8Bytes(turn)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(JSON.stringify(turn.input)).toContain("truncated oversized previous_response_id input history");
    expect(JSON.stringify(turn.output)).toContain("ok");
  });

  it("caps a single oversized output item instead of retaining it unbounded", () => {
    saveTurn(
      "resp_big_output",
      [{ type: "message", role: "user", content: "hello" }],
      [{ type: "message", role: "assistant", content: "y".repeat(400 * 1024) }],
    );

    const turn = getTurn("resp_big_output")!;
    expect(totalBytes()).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(turn.bytes).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(JSON.stringify(turn.output)).toContain("truncated oversized previous_response_id output history");
  });

  it("reserves the empty input array overhead when fitting a near-limit output item", () => {
    const baseOutput = { type: "message", role: "assistant", content: "" };
    const targetOutputArrayBytes = MAX_ENTRY_BYTES - 1;
    const contentBytes = targetOutputArrayBytes - utf8JsonBytes([baseOutput]);
    expect(contentBytes).toBeGreaterThan(0);

    saveTurn(
      "resp_output_boundary",
      [],
      [{ ...baseOutput, content: "x".repeat(contentBytes) }],
    );

    const turn = getTurn("resp_output_boundary")!;
    expect(turn.bytes).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(storedTurnUtf8Bytes(turn)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(JSON.stringify(turn.output)).toContain("truncated oversized previous_response_id output history");
  });

  it("trims long histories while preserving the newest input items", () => {
    const input = Array.from({ length: 4096 }, (_, i) => ({
      type: "message",
      role: "user",
      content: `msg-${i}-` + "x".repeat(80),
    }));

    saveTurn(
      "resp_many_inputs",
      input,
      [{ type: "message", role: "assistant", content: "ok" }],
    );

    const turn = getTurn("resp_many_inputs")!;
    const inputJson = JSON.stringify(turn.input);
    expect(totalBytes()).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(turn.bytes).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(turn.input.length).toBeLessThan(input.length);
    expect(inputJson).not.toContain("msg-0-");
    expect(inputJson).toContain("msg-4095-");
  });

  it("keeps the serializable suffix when older previous_response_id items are unstringifiable", () => {
    const circular: Record<string, unknown> = { role: "user", content: "bad" };
    circular.self = circular;

    saveTurn(
      "resp_circular_input",
      [
        { role: "user", content: "old" },
        circular,
        { role: "user", content: "new" },
      ],
      [],
    );

    const turn = getTurn("resp_circular_input")!;
    expect(turn.input).toEqual([{ role: "user", content: "new" }]);
    expect(turn.bytes).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
  });

  it("clones input and output when saving a turn", () => {
    const input = [{ role: "user", content: [{ type: "input_text", text: "original input" }] }];
    const output = [{ role: "assistant", content: [{ type: "output_text", text: "original output" }] }];

    saveTurn("resp_clone_save", input, output);
    (input[0].content[0] as any).text = "mutated input";
    (output[0].content[0] as any).text = "mutated output";

    const turn = getTurn("resp_clone_save")!;
    expect(JSON.stringify(turn.input)).toContain("original input");
    expect(JSON.stringify(turn.input)).not.toContain("mutated input");
    expect(JSON.stringify(turn.output)).toContain("original output");
    expect(JSON.stringify(turn.output)).not.toContain("mutated output");
  });

  it("returns defensive copies from getTurn", () => {
    saveTurn(
      "resp_clone_get",
      [{ role: "user", content: [{ type: "input_text", text: "stored input" }] }],
      [{ role: "assistant", content: [{ type: "output_text", text: "stored output" }] }],
    );

    const first = getTurn("resp_clone_get")!;
    ((first.input[0] as any).content[0] as any).text = "mutated input";
    ((first.output[0] as any).content[0] as any).text = "mutated output";

    const second = getTurn("resp_clone_get")!;
    expect(JSON.stringify(second.input)).toContain("stored input");
    expect(JSON.stringify(second.input)).not.toContain("mutated input");
    expect(JSON.stringify(second.output)).toContain("stored output");
    expect(JSON.stringify(second.output)).not.toContain("mutated output");
  });

  it("evicts the least recently used turn when capacity is reached", () => {
    for (let i = 0; i < MAX_ENTRIES; i++) {
      mockNow(1_000 + i);
      saveTurn(`resp_${i}`, [{ role: "user", content: `input ${i}` }], [{ role: "assistant", content: `output ${i}` }]);
    }

    mockNow(10_000);
    expect(getTurn("resp_0")).toBeDefined();

    mockNow(10_001);
    saveTurn("resp_new", [{ role: "user", content: "new" }], [{ role: "assistant", content: "ok" }]);

    expect(entryCount()).toBe(MAX_ENTRIES);
    expect(getTurn("resp_0")).toBeDefined();
    expect(getTurn("resp_1")).toBeUndefined();
    expect(getTurn("resp_new")).toBeDefined();
  });

  it("deletes expired turns on lookup", () => {
    mockNow(1_000);
    saveTurn("resp_old", [{ role: "user", content: "old" }], [{ role: "assistant", content: "ok" }]);

    mockNow(1_000 + ENTRY_TTL_MS + 1);

    expect(getTurn("resp_old")).toBeUndefined();
    expect(entryCount()).toBe(0);
  });

  it("prunes expired turns before evicting live turns on save", () => {
    mockNow(1_000);
    saveTurn("resp_expired", [{ role: "user", content: "expired" }], [{ role: "assistant", content: "old" }]);

    mockNow(2_000);
    for (let i = 0; i < MAX_ENTRIES - 1; i++) {
      saveTurn(`resp_live_${i}`, [{ role: "user", content: `live ${i}` }], [{ role: "assistant", content: "ok" }]);
    }

    mockNow(1_000 + ENTRY_TTL_MS + 1);
    saveTurn("resp_new", [{ role: "user", content: "new" }], [{ role: "assistant", content: "ok" }]);

    expect(entryCount()).toBe(MAX_ENTRIES);
    expect(getTurn("resp_expired")).toBeUndefined();
    expect(getTurn("resp_live_0")).toBeDefined();
    expect(getTurn("resp_new")).toBeDefined();
  });
});
