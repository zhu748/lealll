/**
 * Tests for Anthropic SSE → batch Message JSON reassembler.
 *
 * Verifies the reassembler correctly rebuilds a complete Anthropic Message
 * object from a stream of SSE events. This is the "buffer SSE → batch JSON"
 * path used when the proxy forces stream:true upstream (for ZCode wire-shape
 * alignment) but the original client requested non-streaming.
 */
import { describe, it, expect } from "bun:test";
import { anthropicSseToBatchMessage } from "./sse-to-batch.js";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("anthropicSseToBatchMessage", () => {
  it("reassembles a simple text-only SSE stream", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback-model");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const msg = result.message;
    expect(msg.id).toBe("msg_1");
    expect(msg.model).toBe("glm-4.6");
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.stop_sequence).toBe(null);
    expect(msg.content.length).toBe(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(msg.usage.input_tokens).toBe(10);
    expect(msg.usage.output_tokens).toBe(5);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it("reassembles a tool_use block with input_json_delta", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_t","model":"glm-4.6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"SF\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    const msg = result.message;
    expect(msg.content.length).toBe(1);
    expect(msg.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_abc",
      name: "get_weather",
      input: { city: "SF" },
    });
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.usage.output_tokens).toBe(12);
  });

  it("handles mixed text + tool_use blocks", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_m","model":"glm-4.6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking up..."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_xyz","name":"search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"cats\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    const msg = result.message;
    expect(msg.content.length).toBe(2);
    expect(msg.content[0]).toEqual({ type: "text", text: "Looking up..." });
    expect(msg.content[1]).toEqual({
      type: "tool_use",
      id: "toolu_xyz",
      name: "search",
      input: { q: "cats" },
    });
  });

  it("auto-creates text block when content_block_start is missing (tolerant)", async () => {
    // Some GLM impls omit content_block_start — delta should auto-create the block.
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"glm-4.6"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    const msg = result.message;
    expect(msg.content.length).toBe(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Hi" });
  });

  it("handles chunked SSE delivery (multiple reads)", async () => {
    const full = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_c","model":"glm-4.6","usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunked"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    // Split into 3 arbitrary chunks (mid-event boundaries)
    const c1 = full.slice(0, 80);
    const c2 = full.slice(80, 200);
    const c3 = full.slice(200);
    const result = await anthropicSseToBatchMessage(makeStream([c1, c2, c3]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.message.content[0]).toEqual({ type: "text", text: "chunked" });
    expect(result.message.id).toBe("msg_c");
  });

  it("handles ping events (keepalive)", async () => {
    const sse = [
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","model":"glm-4.6"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"P"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.message.content[0]).toEqual({ type: "text", text: "P" });
  });

  it("returns error result on error event", async () => {
    const sse = [
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Server is overloaded"}}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("Server is overloaded");
  });

  it("ignores malformed JSON data lines", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_b","model":"glm-4.6"}}\n\n',
      'data: {malformed json\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.message.content[0]).toEqual({ type: "text", text: "OK" });
  });

  it("uses fallback model when message_start omits model", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_nm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback-glm-4.6");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.message.model).toBe("fallback-glm-4.6");
  });

  it("produces a well-formed message even for empty SSE stream", async () => {
    const result = await anthropicSseToBatchMessage(makeStream([""]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    const msg = result.message;
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.model).toBe("fallback");
    expect(msg.content).toEqual([]);
    expect(msg.stop_reason).toBe(null);
    expect(msg.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("finalizes unfinished tool_use input on stream end without content_block_stop", async () => {
    // Network drop scenario: stream ends after deltas but before content_block_stop.
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_drop","model":"glm-4.6"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_d","name":"fn","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
      // No content_block_stop, no message_stop — stream just ends.
    ].join("");
    const result = await anthropicSseToBatchMessage(makeStream([sse]), "fallback");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.message.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_d",
      name: "fn",
      input: { a: 1 },
    });
  });
});
