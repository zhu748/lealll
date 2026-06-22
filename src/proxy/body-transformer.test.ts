/**
 * Tests for body transformer.
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import { transformRequestBody } from "./body-transformer.js";

describe("transformRequestBody — general", () => {
  it("returns undefined unchanged", () => {
    expect(transformRequestBody(undefined, { format: "openai" })).toBeUndefined();
  });

  it("returns empty string unchanged", () => {
    expect(transformRequestBody("", { format: "openai" })).toBe("");
  });

  it("returns original body on JSON parse failure", () => {
    const broken = "{not valid json";
    expect(transformRequestBody(broken, { format: "openai" })).toBe(broken);
  });

  it("returns original body when JSON is not an object", () => {
    expect(transformRequestBody("[1,2,3]", { format: "openai" })).toBe("[1,2,3]");
    expect(transformRequestBody("\"hello\"", { format: "openai" })).toBe("\"hello\"");
  });

  it("returns original body when no transformation applies", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });
});

describe("transformRequestBody — stream_options.include_usage (OpenAI)", () => {
  it("injects stream_options.include_usage when stream:true and missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: true });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options fields, only adds include_usage", () => {
    const body = JSON.stringify({ stream: true, stream_options: { some_other: "x" } });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ some_other: "x", include_usage: true });
  });

  it("does NOT touch body when stream_options.include_usage already true", () => {
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is false", () => {
    const body = JSON.stringify({ stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [] });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject for anthropic format (Anthropic API has no stream_options)", () => {
    const body = JSON.stringify({ stream: true });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — cache_control (Anthropic)", () => {
  it("adds cache_control to last user message with string content", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second question" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Last user msg content converted to array with cache_control on the block
    expect(parsed.messages[2].content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
    // Earlier messages untouched
    expect(parsed.messages[0].content).toBe("first question");
    expect(parsed.messages[1].content).toBe("answer");
  });

  it("adds cache_control to last content block when content is already array", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT overwrite existing cache_control on last block", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual(existing);
  });

  it("skips system messages — relocates them to system field and finds last non-system", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q1" },
        { role: "system", content: "sys-prompt" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // The user msg (index 0) is the last non-system; gets cache_control
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // System message relocated from messages to top-level system field
    expect(parsed.messages.length).toBe(1);
    expect(parsed.system).toEqual([{ type: "text", text: "sys-prompt" }]);
  });

  it("does nothing when messages array is empty", () => {
    const body = JSON.stringify({ messages: [] });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("relocates system-only messages to system field", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "sys" }] });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // System message moved out of messages array
    expect(parsed.messages).toEqual([]);
    expect(parsed.system).toEqual([{ type: "text", text: "sys" }]);
  });

  it("does NOT apply cache_control for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    expect(out).toBe(body);
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-4.6" });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — combined behavior", () => {
  it("OpenAI streaming body is only stream_options-modified (no cache_control)", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
    expect(parsed.messages[0].content).toBe("hi");
  });
});

describe("transformRequestBody — transform unsupported fields (Anthropic)", () => {
  it("converts thinking type 'adaptive' to 'enabled' for GLM", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.model).toBe("glm-4.6");
  });

  it("converts thinking type 'enabled' with budget_tokens to simple 'enabled' for GLM", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 10000 },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.thinking.budget_tokens).toBeUndefined();
  });

  it("passes thinking type 'disabled' through unchanged", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "disabled" });
  });

  it("removes context_management field", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.context_management).toBeUndefined();
  });

  it("removes output_config field", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.output_config).toBeUndefined();
  });

  it("handles all transformations at once", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "test" }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "low" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
    expect(parsed.model).toBe("glm-5.2");
  });

  it("does NOT transform fields for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      stream: true,
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // thinking is not transformed for openai format
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });
});

describe("transformRequestBody — relocate system messages (Anthropic)", () => {
  it("moves role:system messages from messages to system field", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.system).toEqual([{ type: "text", text: "you are helpful" }]);
  });

  it("appends to existing system array", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "existing sys" }],
      messages: [
        { role: "system", content: "injected sys" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2);
    expect(parsed.system[0].text).toBe("existing sys");
    expect(parsed.system[1].text).toBe("injected sys");
  });

  it("converts existing string system to array and appends", () => {
    const body = JSON.stringify({
      system: "string system",
      messages: [
        { role: "system", content: "array system" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2);
    expect(parsed.system[0]).toEqual({ type: "text", text: "string system" });
    expect(parsed.system[1]).toEqual({ type: "text", text: "array system" });
  });

  it("handles system message with array content", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: [{ type: "text", text: "block1" }, { type: "text", text: "block2" }] },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system).toEqual([
      { type: "text", text: "block1" },
      { type: "text", text: "block2" },
    ]);
  });

  it("does NOT relocate for openai format", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // For openai format, system messages stay in messages array
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("system");
  });
});

describe("transformRequestBody — strip thinking blocks from messages (Anthropic)", () => {
  it("removes thinking content blocks from assistant messages", () => {
    // Reproduces the exact Claude Code round-2 request that triggers 3001:
    // assistant history contains a thinking block (with empty signature)
    // echoed back from the previous turn's thinking_delta SSE events.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "你好啊" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户用中文打招呼...", signature: "" },
            { type: "text", text: "你好!👋..." },
          ],
        },
        { role: "user", content: "帮我看看这个项目是干嘛的" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[1].content).toEqual([
      { type: "text", text: "你好!👋..." },
    ]);
  });

  it("also strips redacted_thinking blocks", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "opaque-base64==" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "next" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // redacted_thinking stripped; text block kept
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops an assistant message entirely if it contained ONLY thinking blocks", () => {
    // An empty-content assistant turn would itself trigger 3001, so the
    // whole message must be removed.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal", signature: "x" }],
        },
        { role: "user", content: "follow-up" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Assistant message gone; only the two user messages remain.
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[1].role).toBe("user");
    expect(parsed.messages.find((m: any) => m.role === "assistant")).toBeUndefined();
  });

  it("preserves tool_use blocks alongside thinking blocks", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // thinking block gone, tool_use preserved
    // After v2.1.3.7beta0: empty text block inserted at front (gateway requires
    // assistant messages to have a text block)
    expect(parsed.messages[0].content.length).toBe(2);
    expect(parsed.messages[0].content[0].type).toBe("text");
    expect(parsed.messages[0].content[0].text).toBe("");
    expect(parsed.messages[0].content[1].type).toBe("tool_use");
    expect(parsed.messages[0].content[1].id).toBe("t1");
    expect(parsed.messages[0].content[1].name).toBe("Bash");
    expect(parsed.messages[0].content[1].input).toEqual({ cmd: "ls" });
    // tool_result preserved, cache_control NOT attached to it (gateway rejects)
    expect(parsed.messages[1].content[0].type).toBe("tool_result");
    expect(parsed.messages[1].content[0].tool_use_id).toBe("t1");
    expect(parsed.messages[1].content[0].cache_control).toBeUndefined();
  });

  it("does NOT touch string content (no thinking blocks possible)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "next" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // string content on assistant untouched (cache_control lands on last user msg, not assistant)
    expect(parsed.messages[1].content).toBe("hi there");
  });

  it("leaves messages without thinking blocks unchanged (apart from other transformations)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content.length).toBe(1);
    expect(parsed.messages[0].content[0].type).toBe("text");
  });

  it("does NOT strip thinking blocks for openai format", () => {
    // openai format is forwarded to /chat/completions which has its own
    // schema; thinking-block stripping is Anthropic-specific.
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content.length).toBe(2);
    expect(parsed.messages[0].content[0].type).toBe("thinking");
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-5.2" });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("strips thinking from multi-turn conversation (Claude Code regression case)", () => {
    // End-to-end shape: round-2 request from Claude Code with full history.
    // Verifies the fix unblocks multi-turn Claude Code sessions.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: [{ type: "text", text: "你好啊" }] },
        { role: "system", content: "agent types and skills..." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户用中文打招呼...", signature: "" },
            { type: "text", text: "你好!👋 我是 ZCode..." },
          ],
        },
        { role: "user", content: [{ type: "text", text: "帮我看看这个项目是干嘛的" }] },
      ],
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // Top-level Claude-Code-only fields are stripped/normalized
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();

    // System message relocated
    expect(parsed.system).toEqual([{ type: "text", text: "agent types and skills..." }]);
    expect(parsed.messages.find((m: any) => m.role === "system")).toBeUndefined();

    // Thinking block stripped from assistant history
    const assistant = parsed.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toEqual([{ type: "text", text: "你好!👋 我是 ZCode..." }]);
  });
});

describe("transformRequestBody — strip cache_control from tool_result (Anthropic)", () => {
  it("removes cache_control from tool_result blocks", () => {
    // Reproduces the v2.1.3.4beta0 start-plan 3001: Claude Code attaches
    // cache_control to the last block of the last user message. When that
    // message is a tool_result, cache_control lands ON the tool_result block,
    // which ZCode's start-plan gateway rejects with 3001.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "t1",
              type: "tool_result",
              content: "file1\nfile2",
              is_error: false,
              cache_control: { type: "ephemeral" },  // ← Claude Code adds this
            },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const toolResultMsg = parsed.messages[parsed.messages.length - 1];
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].cache_control).toBeUndefined();
    // Other fields on tool_result preserved
    expect(toolResultMsg.content[0].tool_use_id).toBe("t1");
    expect(toolResultMsg.content[0].content).toBe("file1\nfile2");
    expect(toolResultMsg.content[0].is_error).toBe(false);
  });

  it("preserves cache_control on text blocks", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        {
          role: "user",
          content: [
            { type: "text", text: "follow up", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // text block keeps its cache_control
    expect(parsed.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT re-add cache_control to tool_result via applyAnthropicCacheControl", () => {
    // After stripping, the proxy's applyAnthropicCacheControl runs and tries
    // to add cache_control to the last block of the last message. If that
    // block is a tool_result, it MUST skip it — otherwise we re-introduce
    // the 3001. This test verifies the skip logic.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "t1",
              type: "tool_result",
              content: "output",
              is_error: false,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    // tool_result block must NOT have cache_control after transform
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].cache_control).toBeUndefined();
  });

  it("handles tool_result-only user message: skips cache_control, no crash", () => {
    // If the last user message has ONLY tool_result blocks (no text), the
    // proxy can't attach cache_control anywhere on it. Should skip gracefully
    // and not attach to tool_result.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].cache_control).toBeUndefined();
  });

  it("start-plan full Claude Code round-3 regression (thinking + tool_result+cc)", () => {
    // Reproduces the EXACT structure from user's v2.1.3.4beta0 diagnostic:
    // msgs[[0]user/{text,text},[1]assistant/{text},[2]user/str,[3]assistant/{text,tool_use},[4]user/{tool_result}]
    // where [3] had a thinking block (now stripped) and [4] had cache_control
    // on the tool_result (now stripped).
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "system",
          content: "Available agent types...",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！我是 ZCode..." }],
        },
        { role: "user", content: "帮我看看当前项目是干嘛的" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户想了解...", signature: "" },
            { type: "text", text: "我来看看..." },
            { type: "tool_use", id: "call_x", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "call_x",
              type: "tool_result",
              content: "total 12",
              is_error: false,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [{ name: "Bash", description: "run bash", input_schema: { type: "object" } }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // Thinking block stripped from assistant [3]
    const assistant3 = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistant3.content.some((b: any) => b.type === "thinking")).toBe(false);
    expect(assistant3.content.map((b: any) => b.type)).toEqual(["text", "tool_use"]);

    // cache_control stripped from tool_result in [4]
    const toolResultMsg = parsed.messages[parsed.messages.length - 1];
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].cache_control).toBeUndefined();

    // System message relocated, start-plan blocks prepended
    expect(parsed.system.length).toBeGreaterThanOrEqual(3);  // 2 ZCode + 1 client
    expect(parsed.messages.find((m: any) => m.role === "system")).toBeUndefined();

    // Top-level fields normalized
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
  });

  it("strips cache_control from tool_use blocks (v2.1.3.5beta0 regression)", () => {
    // v2.1.3.5beta0 fixed tool_result+cc but applyAnthropicCacheControl then
    // attached cc to tool_use blocks when the last user message was all
    // tool_results. ZCode gateway ALSO rejects cc on tool_use blocks → 3001.
    // This reproduces the user's v2.1.3.5beta0 diagnostic:
    //   msgs[..., [3]assistant/{tool_use,tool_use+cc}, [4]user/{tool_result,tool_result}]
    // The assistant called 2 tools; proxy walked back and put cc on 2nd tool_use.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！我是 ZCode..." }],
        },
        { role: "user", content: "帮我看看当前项目是干嘛的" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_1", name: "Grep", input: { pattern: "x" } },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "result1", is_error: false },
            { tool_use_id: "call_2", type: "tool_result", content: "result2", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // The assistant message with tool_use blocks — NO block should have cc
    const assistantWithTools = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistantWithTools).toBeDefined();
    for (const block of assistantWithTools.content) {
      // No tool_use block should carry cache_control
      if (block.type === "tool_use") {
        expect(block.cache_control).toBeUndefined();
      }
    }
    // Thinking block should also be stripped
    expect(assistantWithTools.content.some((b: any) => b.type === "thinking")).toBe(false);

    // The last user message (tool_results) — NO block should have cc
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    for (const block of lastMsg.content) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it("attachable text block found when last msg is all tool_results", () => {
    // When the last user message is all tool_results and the previous
    // assistant has a text block, cache_control should land on that text
    // block — NOT on any tool_use block.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    // text block should get cache_control
    const textBlock = assistant.content.find((b: any) => b.type === "text");
    expect(textBlock.cache_control).toEqual({ type: "ephemeral" });
    // tool_use block should NOT have cache_control
    const toolUseBlock = assistant.content.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock.cache_control).toBeUndefined();
    // tool_result block should NOT have cache_control
    const toolResultBlock = parsed.messages[2].content[0];
    expect(toolResultBlock.cache_control).toBeUndefined();
  });

  it("skips cache_control entirely when no text block exists in any message", () => {
    // After v2.1.3.7beta0, assistant messages with only tool_use get an empty
    // text block inserted. So cache_control lands on that inserted text block
    // in the assistant message — NOT on tool_use, NOT on tool_result, NOT on
    // the first user message (which would have been the fallback before).
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },  // string content
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // First user message: string content stays as string (cache_control did
    // NOT land here, because the assistant's inserted text block was found first)
    const firstUser = parsed.messages[0];
    expect(typeof firstUser.content).toBe("string");
    expect(firstUser.content).toBe("你好");

    // Assistant message: empty text block inserted at front, cache_control
    // attached to that text block
    const assistant = parsed.messages[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe("");
    expect(assistant.content[0].cache_control).toEqual({ type: "ephemeral" });
    // tool_use block has NO cache_control
    expect(assistant.content[1].type).toBe("tool_use");
    expect(assistant.content[1].cache_control).toBeUndefined();

    // Last user message: tool_result, NO cache_control
    const lastUser = parsed.messages[2];
    expect(lastUser.content[0].type).toBe("tool_result");
    expect(lastUser.content[0].cache_control).toBeUndefined();
  });
});

describe("transformRequestBody — ensure assistant has text block (v2.1.3.7beta0)", () => {
  it("inserts empty text block when assistant has only tool_use (after thinking strip)", () => {
    // Reproduces the v2.1.3.6beta0 user report: rounds 3-5 had assistant
    // messages like [thinking, tool_use]; after thinking strip they became
    // [tool_use] only, which ZCode gateway rejects with 3001.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me check", signature: "" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    // After thinking strip + ensureAssistantTextBlock:
    // content should be [text(""), tool_use]
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe("");
    expect(assistant.content[1].type).toBe("tool_use");
    expect(assistant.content[1].id).toBe("t1");
  });

  it("inserts empty text block when assistant originally has only tool_use (no thinking)", () => {
    // Claude Code sometimes sends assistant messages with only tool_use
    // (no thinking, no text). ZCode gateway rejects these too.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe("");
    expect(assistant.content[1].type).toBe("tool_use");
  });

  it("does NOT modify assistant that already has a text block", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe("let me check");
  });

  it("does NOT modify user messages (user can be all tool_result)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [{ type: "text", text: "checking" }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // user message with only tool_result should NOT get a text block inserted
    const userMsg = parsed.messages[2];
    expect(userMsg.content.length).toBe(1);
    expect(userMsg.content[0].type).toBe("tool_result");
  });

  it("full Claude Code multi-round regression (v2.1.3.6beta0 round-7 scenario)", () => {
    // Reproduces the EXACT message structure from user's v2.1.3.6beta0 log:
    //   msgs[[0]user/{text,text},[1]assistant/{text},[2]user/str,
    //        [3]assistant/{tool_use},[4]user/{tool_result},
    //        [5]assistant/{tool_use},[6]user/{tool_result},
    //        [7]assistant/{tool_use},[8]user/{tool_result},
    //        [9]assistant/{text+cc,tool_use},[10]user/{tool_result}]
    // [3],[5],[7] had thinking blocks stripped → became [tool_use] only.
    // ZCode gateway 3001'd on round 7 because of these text-less assistant msgs.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！我是 ZCode..." }],
        },
        { role: "user", content: "帮我看看这个项目是干嘛的" },
        // Round 3: [thinking, tool_use] → after strip: [text(""), tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "out1", is_error: false },
          ],
        },
        // Round 4: [thinking, tool_use] → after strip: [text(""), tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls subdir" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_2", type: "tool_result", content: "out2", is_error: false },
          ],
        },
        // Round 5: [thinking, tool_use] → after strip: [text(""), tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_3", name: "Bash", input: { command: "ls subdir2" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_3", type: "tool_result", content: "out3", is_error: false },
          ],
        },
        // Round 6: [thinking, text, tool_use] → after strip: [text, tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "text", text: "让我再看几个关键文件确认细节。" },
            { type: "tool_use", id: "call_4", name: "Read", input: { file_path: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_4", type: "tool_result", content: "out4", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // Every assistant message MUST have at least one text block
    const assistants = parsed.messages.filter((m: any) => m.role === "assistant");
    for (const a of assistants) {
      const hasText = Array.isArray(a.content) &&
        a.content.some((b: any) => b.type === "text");
      expect(hasText).toBe(true);
    }

    // Specifically check the round-3,4,5 assistants (which had thinking stripped)
    // They should now be [text(""), tool_use]
    const round3Assistant = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.id === "call_1")
    );
    expect(round3Assistant.content.length).toBe(2);
    expect(round3Assistant.content[0].type).toBe("text");
    expect(round3Assistant.content[0].text).toBe("");
    expect(round3Assistant.content[1].type).toBe("tool_use");

    // No thinking blocks anywhere
    for (const m of parsed.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        expect(b.type).not.toBe("thinking");
        expect(b.type).not.toBe("redacted_thinking");
      }
    }
  });
});

describe("transformRequestBody — metadata.user_id (Anthropic)", () => {
  it("injects metadata.user_id when ctx.userId is set", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves existing metadata fields when adding user_id", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { existing_field: "keep" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_99" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ existing_field: "keep", user_id: "u_99" });
  });

  it("does NOT touch body when metadata.user_id already equals ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "u_x" },
    });
    expect(transformRequestBody(body, { format: "anthropic", userId: "u_x" })).toBe(body);
  });

  it("overwrites metadata.user_id when value differs from ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "client_set" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "oauth_resolved" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata.user_id).toBe("oauth_resolved");
  });

  it("does NOT inject metadata when ctx.userId is absent (apikey mode)", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("does NOT inject metadata for OpenAI format even if userId is set", () => {
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });
});
