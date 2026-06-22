/**
 * Tests for anthropic-to-responses translator (batch + SSE).
 */
import { describe, it, expect } from "bun:test";
import {
  translateResponseAnthropicToResponses,
  anthropicSseToResponsesSse,
  buildResponsesOutput,
} from "./anthropic-to-responses.js";
import type { AnthropicMessagesResponse } from "./types.js";

function makeAnthropicResp(overrides: Partial<AnthropicMessagesResponse> = {}): AnthropicMessagesResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    model: "glm-4.6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

describe("translateResponseAnthropicToResponses", () => {
  it("wraps a text response into a Responses-format message item", () => {
    const result = translateResponseAnthropicToResponses(makeAnthropicResp());
    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(result.model).toBe("glm-4.6");
    expect(result.output.length).toBe(1);
    expect(result.output[0].type).toBe("message");
    const item = result.output[0] as Extract<typeof result.output[0], { type: "message" }>;
    expect(item.role).toBe("assistant");
    expect(item.content).toEqual([{ type: "output_text", text: "Hello world", annotations: [] }]);
  });

  it("maps max_tokens stop_reason to incomplete status", () => {
    const result = translateResponseAnthropicToResponses(makeAnthropicResp({ stop_reason: "max_tokens" }));
    expect(result.status).toBe("incomplete");
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("translates tool_use blocks into function_call items", () => {
    const resp = makeAnthropicResp({
      content: [
        { type: "text", text: "Calling tool" },
        { type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } },
      ],
      stop_reason: "tool_use",
    });
    const result = translateResponseAnthropicToResponses(resp);
    expect(result.output.length).toBe(2);
    expect(result.output[0].type).toBe("message");
    expect(result.output[1].type).toBe("function_call");
    const fc = result.output[1] as Extract<typeof result.output[1], { type: "function_call" }>;
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe(JSON.stringify({ cmd: "ls" }));
  });

  it("carries usage stats and total_tokens", () => {
    const result = translateResponseAnthropicToResponses(makeAnthropicResp());
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("echoes previous_response_id when provided", () => {
    const result = translateResponseAnthropicToResponses(makeAnthropicResp(), "glm-4.6", "resp_prev_id");
    expect(result.previous_response_id).toBe("resp_prev_id");
  });
});

describe("buildResponsesOutput", () => {
  it("skips thinking blocks (no reasoning output for v1)", () => {
    const resp = makeAnthropicResp({
      content: [
        { type: "thinking", thinking: "internal reasoning" } as any,
        { type: "text", text: "Final answer" },
      ],
    });
    const out = buildResponsesOutput(resp);
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("message");
  });
});

describe("anthropicSseToResponsesSse", () => {
  /** Read a stream into a single string. */
  async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  it("emits the full event sequence for a text-only stream", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"glm-4.6","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(
      new Response(anthropicSse).body!,
      "glm-4.6",
    );
    const out = await readStream(stream);

    // Required event sequence
    expect(out).toContain("event: response.created");
    expect(out).toContain("event: response.in_progress");
    expect(out).toContain("event: response.output_item.added");
    expect(out).toContain("event: response.content_part.added");
    expect(out).toContain('event: response.output_text.delta');
    expect(out).toContain('"delta":"Hello"');
    expect(out).toContain('"delta":" world"');
    expect(out).toContain("event: response.output_text.done");
    expect(out).toContain('"text":"Hello world"');
    expect(out).toContain("event: response.content_part.done");
    expect(out).toContain("event: response.output_item.done");
    expect(out).toContain("event: response.completed");
  });

  it("emits function_call events for tool_use blocks", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"glm-4.6","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"shell","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(
      new Response(anthropicSse).body!,
      "glm-4.6",
    );
    const out = await readStream(stream);

    expect(out).toContain("event: response.output_item.added");
    expect(out).toContain('"type":"function_call"');
    expect(out).toContain('"call_id":"call_1"');
    expect(out).toContain('"name":"shell"');
    expect(out).toContain("event: response.function_call_arguments.delta");
    expect(out).toContain("event: response.function_call_arguments.done");
    expect(out).toContain("event: response.output_item.done");
    expect(out).toContain("event: response.completed");
  });

  it("emits max_tokens incomplete status when stop_reason is max_tokens", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"glm-4.6"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(
      new Response(anthropicSse).body!,
      "glm-4.6",
    );
    const out = await readStream(stream);
    expect(out).toContain('"status":"incomplete"');
    expect(out).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
  });
});
