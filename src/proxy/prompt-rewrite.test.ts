import { describe, expect, it } from "bun:test";
import { defaultPromptRewriteConfig, normalizePromptRewriteConfig } from "../config/prompt-rewrite.js";
import type { PromptRewriteRule } from "../config/types.js";
import { transformParsedBody } from "./body-transformer.js";
import { captureSystemPrompt, rewriteSystemPrompt } from "./prompt-rewrite.js";

const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const security = defaultPromptRewriteConfig().rules[2].match;
const sample = [
  "x-anthropic-billing-header: cc_version=2.1.292.428; cc_entrypoint=cli;",
  identity,
  "",
  "You are an interactive agent that helps users with software engineering tasks.",
  "",
  security,
  "",
  "# Harness",
  "- Prefer the dedicated file/search tools over shell commands when one fits.",
  "# Memory",
  String.raw`Persistent memory: C:\Users\Administrator\.claude\projects\example\memory`,
  "# Environment",
  "- The most recent Claude models are the Claude 5 family and Haiku 4.5. Model IDs — Fable 5.1: 'claude-fable-5-1', Opus 5.5: 'claude-opus-5-5', Sonnet 5.5: 'claude-sonnet-5-5', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.",
  "- Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).",
  "- Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast.",
  "# Context management",
  "When you have enough information to act, act.",
].join("\n");

function rule(overrides: Partial<PromptRewriteRule> = {}): PromptRewriteRule {
  return { id: "custom", name: "custom", enabled: true, action: "replace", matchMode: "text", match: "old", replacement: "new", ...overrides };
}

describe("system-prompt rewrite", () => {
  it("applies the four requested edits while preserving harness, memory, billing and other environment text", () => {
    const body = { system: sample, messages: [{ role: "user", content: sample }], tools: [{ name: "test", description: sample }] };
    const messages = structuredClone(body.messages), tools = structuredClone(body.tools);
    const result = rewriteSystemPrompt(body, defaultPromptRewriteConfig());
    expect(result.matches).toBe(4);
    expect(result.changes).toBe(4);
    expect(body.system).toContain("You are ZCode model working in Claude Code.");
    expect(body.system).not.toContain(identity);
    expect(body.system).not.toContain("The most recent Claude models are");
    expect(body.system).not.toContain("Fast mode for Claude Code uses");
    expect(body.system).not.toContain(security);
    expect(body.system).toContain("# Harness");
    expect(body.system).toContain(String.raw`C:\Users\Administrator\.claude`);
    expect(body.system).toContain("x-anthropic-billing-header");
    expect(body.system).toContain("Claude Code is available as a CLI");
    expect(body.messages).toEqual(messages);
    expect(body.tools).toEqual(tools);
  });

  it("supports the SDK identity variant and CRLF without changing surrounding lines", () => {
    const body = { system: "before\r\n" + identity.slice(0, -1) + ", running within the Claude Agent SDK.\r\nafter\r\n" };
    const result = rewriteSystemPrompt(body, defaultPromptRewriteConfig());
    expect(body.system).toBe("before\r\nYou are ZCode model working in Claude Code.\r\nafter\r\n");
    expect(result.changes).toBe(1);
  });

  it("retains cache-control and custom block metadata, removing only blocks emptied by an edit", () => {
    const kept = { type: "text", text: identity, cache_control: { type: "ephemeral" }, custom: "kept" };
    const body = { system: [kept, { type: "text", text: security }, { type: "text", text: "", custom: "untouched" }] };
    const result = rewriteSystemPrompt(body, defaultPromptRewriteConfig());
    expect(result.changes).toBe(2);
    expect(body.system).toEqual([{ ...kept, text: "You are ZCode model working in Claude Code." }, { type: "text", text: "", custom: "untouched" }]);
  });

  it("omits system when the only text block is deleted", () => {
    const body = { system: [{ type: "text", text: security }] };
    rewriteSystemPrompt(body, defaultPromptRewriteConfig());
    expect("system" in body).toBe(false);
  });

  it("treats dollar substitutions, HTML and backslashes as literal replacement text", () => {
    const body = { system: "old old" };
    const replacement = "$& $1 $$ $` $' " + String.raw`</textarea><script>alert(1)</script> C:\temp`;
    const result = rewriteSystemPrompt(body, { enabled: true, rules: [rule({ replacement })] });
    expect(body.system).toBe(replacement + " " + replacement);
    expect(result.matches).toBe(2);
    expect(result.changes).toBe(2);
  });

  it("applies ordered rules once and distinguishes hits from a net content change", () => {
    const body = { system: "old" };
    const result = rewriteSystemPrompt(body, { enabled: true, rules: [rule(), rule({ id: "second", match: "new", replacement: "old" })] });
    expect(body.system).toBe("old");
    expect(result.matches).toBe(2);
    expect(result.changes).toBe(2);
    expect(result.modified).toBe(false);
    const noop = rewriteSystemPrompt(body, { enabled: true, rules: [rule({ replacement: "old" })] });
    expect(noop.matches).toBe(1);
    expect(noop.changes).toBe(0);
  });

  it("does not alter the input when disabled or when no rule matches", () => {
    for (const config of [{ enabled: false, rules: defaultPromptRewriteConfig().rules }, { enabled: true, rules: [rule({ enabled: false })] }, { enabled: true, rules: [rule({ match: "absent" })] }]) {
      const body = { system: [{ type: "text", text: sample }, { type: "text", text: "" }], messages: [{ role: "user", content: "old" }] };
      const original = JSON.stringify(body);
      expect(rewriteSystemPrompt(body, config).modified).toBe(false);
      expect(JSON.stringify(body)).toBe(original);
    }
  });

  it("rewrites OpenAI system messages while leaving user messages untouched", () => {
    const body = { messages: [{ role: "system", content: sample }, { role: "user", content: sample }] };
    rewriteSystemPrompt(body, defaultPromptRewriteConfig());
    expect(body.messages[0].content).not.toContain(security);
    expect(body.messages[1].content).toBe(sample);
  });

  it("runs after start-plan injection so deleted text cannot be reintroduced by official blocks", () => {
    const body: Record<string, unknown> = { model: "glm-4.6", system: sample, messages: [{ role: "user", content: "hello" }] };
    transformParsedBody(body, { format: "anthropic", startPlan: true, provider: "zai", promptRewrite: defaultPromptRewriteConfig() });
    const text = captureSystemPrompt(body).text;
    expect(text).toContain("You are ZCode, an interactive coding agent");
    expect(text).toContain("# Harness");
    expect(text).not.toContain(security);
    expect(text).toContain("You are ZCode model working in Claude Code.");
  });

  it("bounds expanding replacements in both matching modes and reports a skipped rule", () => {
    for (const matchMode of ["text", "line"] as const) {
      const body = { system: ("old\n").repeat(1000) };
      const original = body.system;
      const result = rewriteSystemPrompt(body, { enabled: true, rules: [rule({ matchMode, replacement: "x".repeat(16384) })] });
      expect(body.system).toBe(original);
      expect(result.rules[0].matches).toBe(1000);
      expect(result.rules[0].error).toContain("1 Mi");
      expect(result.modified).toBe(false);
    }
  });

  it("bounds the diagnostic copy without truncating the actual request", () => {
    const body = { system: "x".repeat(160000) };
    const snapshot = captureSystemPrompt(body);
    expect(snapshot.chars).toBe(160000);
    expect(snapshot.text.length).toBe(128 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(body.system.length).toBe(160000);
  });

  it("combines both marketing lines in one editable rule and counts both hits", () => {
    const rules = defaultPromptRewriteConfig().rules;
    expect(rules).toHaveLength(3);
    const body = { system: "before\n- The most recent Claude models are whatever\nkeep\n- Fast mode for Claude Code uses Claude Opus: /fast\nafter" };
    const result = rewriteSystemPrompt(body, { enabled: true, rules: [rules[1]] });
    expect(body.system).toBe("before\nkeep\nafter");
    expect(result.rules[0].matches).toBe(2);
    expect(result.rules[0].changes).toBe(2);
  });

  it("shares the replacement-growth budget across blocks instead of expanding each independently", () => {
    const body = { system: Array.from({ length: 100 }, () => ({ type: "text", text: "old" })) };
    const result = rewriteSystemPrompt(body, { enabled: true, rules: [rule({ replacement: "x".repeat(16384) })] });
    const snapshot = captureSystemPrompt(body);
    expect(snapshot.chars).toBeLessThan(1024 * 1024 + 1000);
    expect(result.rules[0].matches).toBe(100);
    expect(result.rules[0].changes).toBeLessThan(100);
    expect(result.rules[0].error).toBeDefined();
  });
});

describe("prompt rule validation", () => {
  it("distinguishes omitted rules from an intentionally empty list and rejects malformed rules", () => {
    expect(normalizePromptRewriteConfig({ enabled: false }).rules).toHaveLength(3);
    expect(normalizePromptRewriteConfig({ enabled: true, rules: [] }).rules).toEqual([]);
    for (const config of [null, { enabled: "true" }, { enabled: null }, { rules: [rule(), rule()] }, { rules: [rule({ match: "" })] }, { rules: [rule({ replacement: "x".repeat(16385) })] }, { rules: Array.from({ length: 65 }, (_, id) => rule({ id: String(id) })) }]) {
      expect(() => normalizePromptRewriteConfig(config)).toThrow();
    }
  });
});
