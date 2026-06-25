/**
 * Tests for responses-to-anthropic request translator.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { translateRequestResponsesToAnthropic } from "./responses-to-anthropic.js";
import { clearStore, saveTurn } from "./responses-store.js";
import type { OpenAIResponseRequest } from "./types.js";

describe("translateRequestResponsesToAnthropic", () => {
  beforeEach(() => clearStore());

  it("translates a simple string input", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: "Hello",
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.model).toBe("glm-4.6");
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(result.max_tokens).toBe(4096);
  });

  it("translates a message array with user/assistant roles", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello there" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "How are you?" }] },
      ],
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello there" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("relocates system/developer messages to system field, appends to instructions", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      instructions: "Base system prompt",
      input: [
        { type: "message", role: "system", content: "Extra system note" },
        { type: "message", role: "developer", content: "Dev hint" },
        { type: "message", role: "user", content: "Hi" },
      ],
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.system).toBe("Base system prompt\n\nExtra system note\n\nDev hint");
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("maps max_output_tokens → max_tokens", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: "Hi",
      max_output_tokens: 8192,
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.max_tokens).toBe(8192);
  });

  it("injects thinking enabled from reasoning.effort (unconditional, honors client intent)", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: "Hi",
      reasoning: { effort: "high" },
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("injects thinking enabled even for non-reasoning models (user intent overrides catalog)", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6v",  // reasoning: false in catalog, but client wants thinking
      input: "Hi",
      reasoning: { effort: "high" },
    };
    const result = translateRequestResponsesToAnthropic(req);
    // Per user policy: if client sent reasoning.effort, honor it. GLM will
    // ignore thinking on models that don't support it; we don't second-guess.
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("does NOT inject thinking when reasoning is absent", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: "Hi",
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.thinking).toBeUndefined();
  });

  // --- Codex fallback: forceThinkingModels ---
  it("forceThinkingModels: injects thinking when model matches (even without reasoning.effort)", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-5.2",
      input: "Hi",
      // Codex CLI sends reasoning: null in the wire payload
    };
    const result = translateRequestResponsesToAnthropic(req, {
      forceThinkingModels: ["glm-5.2", "glm-4.6"],
    });
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("forceThinkingModels: matches case-insensitively", () => {
    const req: OpenAIResponseRequest = {
      model: "GLM-5.2",
      input: "Hi",
    };
    const result = translateRequestResponsesToAnthropic(req, {
      forceThinkingModels: ["glm-5.2"],
    });
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("forceThinkingModels: does NOT inject thinking when model is not in the list", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.5-air",
      input: "Hi",
    };
    const result = translateRequestResponsesToAnthropic(req, {
      forceThinkingModels: ["glm-5.2"],
    });
    expect(result.thinking).toBeUndefined();
  });

  it("forceThinkingModels: empty/undefined list does not inject thinking", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-5.2",
      input: "Hi",
    };
    expect(translateRequestResponsesToAnthropic(req).thinking).toBeUndefined();
    expect(translateRequestResponsesToAnthropic(req, {}).thinking).toBeUndefined();
    expect(translateRequestResponsesToAnthropic(req, { forceThinkingModels: [] }).thinking).toBeUndefined();
  });

  it("forceThinkingModels: reasoning.effort still wins even when model is NOT in the list", () => {
    // Client explicitly requested reasoning → always honor, regardless of force-list.
    const req: OpenAIResponseRequest = {
      model: "glm-4.5-air",
      input: "Hi",
      reasoning: { effort: "medium" },
    };
    const result = translateRequestResponsesToAnthropic(req, {
      forceThinkingModels: ["glm-5.2"],
    });
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("forceThinkingModels: reasoning.effort + matching model both produce thinking", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-5.2",
      input: "Hi",
      reasoning: { effort: "high" },
    };
    const result = translateRequestResponsesToAnthropic(req, {
      forceThinkingModels: ["glm-5.2"],
    });
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("filters to only function-type tools, dropping built-ins", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: "Hi",
      tools: [
        { type: "function", name: "shell", description: "Run shell", parameters: { type: "object" } },
        { type: "local_shell" },
        { type: "web_search" },
      ],
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.tools).toEqual([
      { name: "shell", description: "Run shell", input_schema: { type: "object" } },
    ]);
  });

  it("translates function_call + function_call_output items to tool_use/tool_result blocks", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: [
        { type: "message", role: "user", content: "list files" },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_1", output: "file1\nfile2" },
        { type: "message", role: "user", content: "now cat file1" },
      ],
    };
    const result = translateRequestResponsesToAnthropic(req);
    // tool_result (user) and the following user message get merged into one user
    // message because Anthropic requires strict role alternation.
    expect(result.messages).toEqual([
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_1", content: "file1\nfile2" },
        { type: "text", text: "now cat file1" },
      ] },
    ]);
  });

  it("merges consecutive same-role messages (Codex sends multiple user turns in one input)", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: [
        { type: "message", role: "user", content: "first question" },
        { type: "message", role: "user", content: "second question" },
        { type: "message", role: "user", content: "third question" },
      ],
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("first question\n\nsecond question\n\nthird question");
  });

  it("merges mixed string and block content across consecutive same-role messages", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "block text" }] },
        { type: "message", role: "user", content: "plain string" },
      ],
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.messages.length).toBe(1);
    // All text → collapse to a single string
    expect(result.messages[0].content).toBe("block text\n\nplain string");
  });

  it("replays previous_response_id history before current input", () => {
    saveTurn("resp_prev", [
      { type: "message", role: "user", content: "earlier question" },
    ], [
      { type: "message", id: "msg_prev", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "earlier answer", annotations: [] }] },
    ]);

    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: [{ type: "message", role: "user", content: "follow-up" }],
      previous_response_id: "resp_prev",
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.messages).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "follow-up" },
    ]);
  });

  it("drops previous_response_id silently when not found in store", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: [{ type: "message", role: "user", content: "fresh start" }],
      previous_response_id: "resp_does_not_exist",
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.messages).toEqual([{ role: "user", content: "fresh start" }]);
  });

  it("translates tool_choice auto / required / function", () => {
    const req1: OpenAIResponseRequest = {
      model: "glm-4.6", input: "Hi",
      tools: [{ type: "function", name: "f", parameters: {} }],
      tool_choice: "auto",
    };
    expect(translateRequestResponsesToAnthropic(req1).tool_choice).toEqual({ type: "auto" });

    const req2: OpenAIResponseRequest = {
      model: "glm-4.6", input: "Hi",
      tools: [{ type: "function", name: "f", parameters: {} }],
      tool_choice: "required",
    };
    expect(translateRequestResponsesToAnthropic(req2).tool_choice).toEqual({ type: "any" });

    const req3: OpenAIResponseRequest = {
      model: "glm-4.6", input: "Hi",
      tools: [{ type: "function", name: "f", parameters: {} }],
      tool_choice: { type: "function", name: "f" },
    };
    expect(translateRequestResponsesToAnthropic(req3).tool_choice).toEqual({ type: "tool", name: "f" });
  });

  it("forwards stream / temperature / top_p / stop fields", () => {
    const req: OpenAIResponseRequest = {
      model: "glm-4.6",
      input: "Hi",
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      stop: ["END"],
    };
    const result = translateRequestResponsesToAnthropic(req);
    expect(result.stream).toBe(true);
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.stop_sequences).toEqual(["END"]);
  });
});
