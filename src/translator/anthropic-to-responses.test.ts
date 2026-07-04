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
import { SSE as SSE_CONST } from "../utils/constants.js";

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

  it("translates declared custom tool_use blocks into custom_tool_call items", () => {
    const resp = makeAnthropicResp({
      content: [
        { type: "tool_use", id: "call_patch", name: "apply_patch", input: { patch: "*** Begin Patch" } },
      ],
      stop_reason: "tool_use",
    });
    const result = translateResponseAnthropicToResponses(resp, "glm-4.6", null, {
      customToolNames: ["apply_patch"],
    });

    expect(result.output.length).toBe(1);
    expect(result.output[0].type).toBe("custom_tool_call");
    const ctc = result.output[0] as Extract<typeof result.output[0], { type: "custom_tool_call" }>;
    expect(ctc.call_id).toBe("call_patch");
    expect(ctc.name).toBe("apply_patch");
    expect(ctc.input).toBe("*** Begin Patch");
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

  // v0.2.0.10: regression tests for cache_read_input_tokens + reasoning_tokens
  // forwarding. Without these, the proxy dashboard under-reports token counts
  // by ~35x when prompt caching is active for Responses API batch clients.
  it("v0.2.0.10: forwards cache_read_input_tokens when present", () => {
    const resp = makeAnthropicResp({
      usage: { input_tokens: 1152, output_tokens: 5, cache_read_input_tokens: 40000 } as any,
    });
    const result = translateResponseAnthropicToResponses(resp);
    expect(result.usage).toMatchObject({
      input_tokens: 1152,
      output_tokens: 5,
      total_tokens: 1157,
      cache_read_input_tokens: 40000,
    });
  });

  it("v0.2.0.10: omits cache_read_input_tokens when not present (no zero-pollution)", () => {
    const result = translateResponseAnthropicToResponses(makeAnthropicResp());
    expect(result.usage).not.toHaveProperty("cache_read_input_tokens");
  });

  it("v0.2.0.10: forwards upstream reasoning_tokens from usage", () => {
    const resp = makeAnthropicResp({
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 1234 } as any,
    });
    const result = translateResponseAnthropicToResponses(resp);
    expect(result.usage?.output_tokens_details?.reasoning_tokens).toBe(1234);
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

  it("emits a terminal response.completed when upstream ends without message_stop", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_short","model":"glm-4.6","usage":{"input_tokens":3}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);

    expect(out).toContain("event: response.output_text.done");
    expect(out).toContain('"text":"partial answer"');
    expect(out).toContain("event: response.completed");
    expect(out.match(/event: response\.completed/g)).toHaveLength(1);
  });

  it("handles CRLF SSE line endings", async () => {
    const anthropicSse = [
      'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_crlf","model":"glm-4.6","usage":{"input_tokens":1,"output_tokens":0}}}\r\n\r\n',
      'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"CRLF ok"}}\r\n\r\n',
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);

    expect(out).toContain("event: response.output_text.delta");
    expect(out).toContain('"delta":"CRLF ok"');
    expect(out).toContain("event: response.completed");
  });

  it("translates many complete events from one merged upstream chunk", async () => {
    const deltas = Array.from({ length: 300 }, (_, i) =>
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part-${i}"}}\n\n`
    ).join("");
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_merged","model":"glm-4.6","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      deltas,
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);

    expect(out.match(/event: response\.output_text\.delta/g)?.length).toBe(300);
    expect(out).toContain('"delta":"part-0"');
    expect(out).toContain('"delta":"part-299"');
    expect(out).toContain("event: response.completed");
  });

  it("ignores non-output blocks without corrupting the open text output index", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"glm-4.6","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hidden"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);

    expect(out).toContain('"text":"Hello world"');
    expect(out.match(/event: response\.output_item\.added/g)?.length).toBe(1);
    expect(out).toContain('"output_index":0');
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

  it("emits custom_tool_call events for declared custom tools", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"glm-4.6","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_patch","name":"apply_patch","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"patch\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"*** Begin Patch\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(
      new Response(anthropicSse).body!,
      "glm-4.6",
      { customToolNames: ["apply_patch"] },
    );
    const out = await readStream(stream);

    expect(out).toContain('"type":"custom_tool_call"');
    expect(out).toContain('"call_id":"call_patch"');
    expect(out).toContain('"name":"apply_patch"');
    expect(out).toContain("event: response.custom_tool_call_input.delta");
    expect(out).toContain("event: response.custom_tool_call_input.done");
    expect(out).toContain('"input":"*** Begin Patch"');
    expect(out).not.toContain("event: response.function_call_arguments.delta");
    expect(out).not.toContain("event: response.function_call_arguments.done");
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

  // v0.2.0.10: regression tests for cache_read_input_tokens + thinking_delta
  // forwarding through the Responses API streaming path.
  it("v0.2.0.10: forwards cache_read_input_tokens in response.completed usage", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_c","model":"glm-4.6","usage":{"input_tokens":1152,"output_tokens":0,"cache_read_input_tokens":40000}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);
    // The final response.completed event must carry cache_read_input_tokens
    // so the proxy stats observer can show "in: 41152 (c:40000)".
    expect(out).toContain('"cache_read_input_tokens":40000');
  });

  it("v0.2.0.10: counts thinking_delta chunks as reasoning_tokens in response.completed", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_th","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 2"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);
    // The thinking_delta events should be counted (2 chunks) and surfaced
    // as reasoning_tokens in the final response.completed usage payload.
    expect(out).toContain('"reasoning_tokens":2');
  });

  it("v0.2.0.10: prefers upstream-provided reasoning_tokens over chunk count", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_at","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"x"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5,"reasoning_tokens":1234}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    const out = await readStream(stream);
    expect(out).toContain('"reasoning_tokens":1234');
    expect(out).not.toMatch(/"reasoning_tokens":1[},]/);
  });

  it("errors when an unfinished SSE event exceeds the stream buffer limit", async () => {
    const stream = anthropicSseToResponsesSse(
      new Response("data: " + "x".repeat(SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES + 1)).body!,
      "glm-4.6",
    );
    let err: unknown;
    try {
      await readStream(stream);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain("SSE buffered event exceeded");
  });

  it("counts unfinished SSE event limits by UTF-8 bytes", async () => {
    const stream = anthropicSseToResponsesSse(
      new Response("data: " + "汉".repeat(Math.floor(SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES / 3) + 1)).body!,
      "glm-4.6",
    );
    let err: unknown;
    try {
      await readStream(stream);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain("SSE buffered event exceeded");
  });

  it("rejects out-of-range content block indices in Responses streams", async () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_idx","model":"glm-4.6"}}\n\n',
      `event: content_block_start\ndata: {"type":"content_block_start","index":${SSE_CONST.MAX_TO_BATCH_CONTENT_BLOCK_INDEX + 1},"content_block":{"type":"text","text":""}}\n\n`,
    ].join("");
    const stream = anthropicSseToResponsesSse(new Response(anthropicSse).body!, "glm-4.6");
    let err: unknown;
    try {
      await readStream(stream);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain("Invalid SSE content block index");
  });

  it("cancels the upstream reader when translation errors", async () => {
    const encoder = new TextEncoder();
    let upstreamCancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_error","model":"glm-4.6"}}',
          '',
          'event: content_block_start',
          `data: {"type":"content_block_start","index":${SSE_CONST.MAX_TO_BATCH_CONTENT_BLOCK_INDEX + 1},"content_block":{"type":"text","text":""}}`,
          '',
          '',
        ].join("\n")));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });

    let err: unknown;
    try {
      await readStream(anthropicSseToResponsesSse(input, "glm-4.6"));
    } catch (e) {
      err = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((err as Error)?.message).toContain("Invalid SSE content block index");
    expect(upstreamCancelled).toBe(true);
  });

  it("cancels the upstream reader when downstream cancels", async () => {
    const encoder = new TextEncoder();
    let upstreamCancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cancel","model":"glm-4.6"}}\n\n',
        ));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });

    const reader = anthropicSseToResponsesSse(input, "glm-4.6").getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("client disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCancelled).toBe(true);
  });
});
