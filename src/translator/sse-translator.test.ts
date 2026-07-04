/**
 * Tests for SSE event translator.
 * @see .omo/plans/zcode-proxy.md Task 12
 *
 * v0.2.2+: the deprecated `openaiSseToAnthropicSse` function was removed
 * as dead code (never used in production, had a known spec-violation bug).
 * Its test section was removed alongside.
 */
import { describe, it, expect } from "bun:test";
import { anthropicSseToOpenaiSse } from "./sse-translator.js";
import { SSE as SSE_CONST } from "../utils/constants.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"glm-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

describe("anthropicSseToOpenaiSse", () => {
  it("translates message_start to first chunk with role", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"role":"assistant"');
  });

  it("translates text_delta to delta.content", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"content":"Hello"');
    expect(output).toContain('"content":" world"');
  });

  it("handles CRLF SSE line endings", async () => {
    const input = makeStream([
      'event: message_start\r\n',
      'data: {"type":"message_start","message":{"id":"msg_crlf","model":"glm-4.6","usage":{"input_tokens":1,"output_tokens":0}}}\r\n\r\n',
      'event: content_block_delta\r\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"CRLF ok"}}\r\n\r\n',
      'event: message_stop\r\n',
      'data: {"type":"message_stop"}\r\n\r\n',
    ].join(""));

    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));

    expect(output).toContain('"content":"CRLF ok"');
    expect(output).toContain("data: [DONE]");
  });

  it("translates many complete events from one merged upstream chunk", async () => {
    const deltas = Array.from({ length: 300 }, (_, i) => [
      "event: content_block_delta",
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part-${i}"}}`,
      "",
    ].join("\n")).join("\n");
    const input = makeStream([
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_merged","model":"glm-4.6","usage":{"input_tokens":1,"output_tokens":0}}}',
      "",
      deltas,
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n"));

    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));

    expect(output.match(/"content":"part-/g)?.length).toBe(300);
    expect(output).toContain('"content":"part-0"');
    expect(output).toContain('"content":"part-299"');
    expect(output).toContain("data: [DONE]");
  });

  it("translates message_delta stop_reason to finish_reason", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"stop"');
  });

  it("emits [DONE] at the end", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain("data: [DONE]");
  });

  it("emits usage on final chunk from input_tokens + output_tokens", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"usage"');
    expect(output).toContain('"prompt_tokens":10');
    expect(output).toContain('"completion_tokens":5');
    expect(output).toContain('"total_tokens":15');
  });

  it("emits only one terminal finish chunk when message_delta is followed by message_stop", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output.match(/"finish_reason":"[^"]+"/g)?.length).toBe(1);
    expect(output).toContain('"finish_reason":"stop"');
    expect(output.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("handles max_tokens stop reason", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"length"');
  });

  it("translates streaming tool_use blocks to OpenAI tool_calls", async () => {
    // Reproduces the bug where streaming tool_use was completely dropped:
    // content_block_start with tool_use type was skipped, and
    // input_json_delta returned null. The OpenAI client never saw the
    // tool_call id/name/arguments — only the finish_reason="tool_calls"
    // at the end, with no way to know what the tool call actually was.
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_t1","model":"glm-4.6","usage":{"input_tokens":5,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"SF\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    // The tool_call id + name should reach the OpenAI client.
    expect(output).toContain('"tool_calls"');
    expect(output).toContain('"id":"toolu_abc"');
    expect(output).toContain('"name":"get_weather"');
    expect(output).toContain('"type":"function"');
    // The initial arguments should be an empty string.
    expect(output).toContain('"arguments":""');
    // The input_json_delta content should be forwarded as arguments deltas.
    expect(output).toContain('"arguments":"{\\"city\\""');
    expect(output).toContain('"arguments":":\\"SF\\"}"');
    // The finish_reason should be tool_calls (mapped from stop_reason=tool_use).
    expect(output).toContain('"finish_reason":"tool_calls"');
  });

  it("translates streaming tool_use blocks with text content preceding them", async () => {
    // Common case: the model first emits a text block ("Let me check..."),
    // then a tool_use block. Both should be translated correctly and the
    // OpenAI tool_calls index should be 0 (text blocks don't consume an
    // OpenAI tool_calls slot).
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_t2","model":"glm-4.6","usage":{"input_tokens":5,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking up..."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_xyz","name":"search","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"cats\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    // Text content should be present.
    expect(output).toContain('"content":"Looking up..."');
    // Tool call should be present with id/name.
    expect(output).toContain('"id":"toolu_xyz"');
    expect(output).toContain('"name":"search"');
    // Tool call arguments should be forwarded.
    expect(output).toContain('"arguments":"{\\"q\\":\\"cats\\"}"');
    // The OpenAI tool_calls index should be 0 (first tool call).
    expect(output).toContain('"index":0');
  });

  // v0.2.0.10: regression tests for cache_read_input_tokens + thinking_delta
  // forwarding. Without these, the proxy dashboard under-reports token
  // counts by ~35x when prompt caching is active, and never shows the
  // "(th:M)" thinking indicator for OpenAI Chat Completions streaming clients.
  it("v0.2.0.10: forwards cache_read_input_tokens in the final usage chunk", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_c","model":"glm-4.6","usage":{"input_tokens":1152,"output_tokens":0,"cache_read_input_tokens":40000}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    // The final usage chunk must carry cache_read_input_tokens so the proxy
    // stats observer can compute "in: 41152 (c:40000)".
    expect(output).toContain('"cache_read_input_tokens":40000');
  });

  it("v0.2.0.10: counts thinking_delta chunks and forwards reasoning_tokens", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_th","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 2"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 3"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    // The thinking_delta events should NOT appear as OpenAI content chunks
    // (we don't pollute the OpenAI protocol with reasoning content).
    expect(output).not.toContain('"thinking"');
    // But the final usage chunk must carry reasoning_tokens so the proxy
    // can show "out: 5 (th:3)".
    expect(output).toContain('"reasoning_tokens":3');
  });

  it("v0.2.0.10: prefers upstream-provided reasoning_tokens over chunk count", async () => {
    // If GLM provides an authoritative reasoning_tokens in message_delta.usage,
    // we should use that instead of our chunk count (which is approximate).
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_at","model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":0}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"x"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5,"reasoning_tokens":1234}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    // The authoritative value (1234) should win, not the chunk count (1).
    expect(output).toContain('"reasoning_tokens":1234');
    // Check that no usage chunk carries the chunk-count value (1). We match
    // `reasoning_tokens":1` followed by `,` or `}` to avoid false positives
    // from `reasoning_tokens":1234` (which contains the substring `:1`).
    expect(output).not.toMatch(/"reasoning_tokens":1[},]/);
  });

  it("errors when an unfinished SSE event exceeds the stream buffer limit", async () => {
    const input = makeStream("data: " + "x".repeat(SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES + 1));
    let err: unknown;
    try {
      await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain("SSE buffered event exceeded");
  });

  it("counts unfinished SSE event limits by UTF-8 bytes", async () => {
    const input = makeStream("data: " + "汉".repeat(Math.floor(SSE_CONST.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES / 3) + 1));
    let err: unknown;
    try {
      await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain("SSE buffered event exceeded");
  });

  it("rejects out-of-range content block indices in translated streams", async () => {
    const input = makeStream([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_idx","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      `data: {"type":"content_block_start","index":${SSE_CONST.MAX_TO_BATCH_CONTENT_BLOCK_INDEX + 1},"content_block":{"type":"tool_use","id":"call_1","name":"shell"}}`,
      '',
    ].join('\n'));
    let err: unknown;
    try {
      await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
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
        ].join('\n')));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });

    let err: unknown;
    try {
      await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
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

    const reader = anthropicSseToOpenaiSse(input, "glm-4.6").getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("client disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCancelled).toBe(true);
  });
});
