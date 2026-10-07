import type { PromptRewriteConfig, PromptRewriteRule } from "./types.js";

export const MAX_PROMPT_RULES = 64;
export const MAX_PROMPT_RULE_TEXT = 16384;

const SECURITY_PARAGRAPH = "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** Fresh objects so editing one configuration never changes another's defaults. */
export function defaultPromptRewriteConfig(): PromptRewriteConfig {
  return {
    enabled: true,
    rules: [
      { id: "claude-identity", name: "Claude Code 身份", enabled: true, action: "replace", matchMode: "line", match: "You are Claude Code, Anthropic's official CLI for Claude", replacement: "You are ZCode model working in Claude Code." },
      { id: "claude-promotion", name: "Claude 模型与 Fast 模式营销", enabled: true, action: "delete", matchMode: "line", match: "The most recent Claude models are\nFast mode for Claude Code uses Claude Opus", replacement: "" },
      { id: "claude-security-paragraph", name: "指定 IMPORTANT 段落", enabled: true, action: "delete", matchMode: "text", match: SECURITY_PARAGRAPH, replacement: "" },
    ],
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Shared by YAML loading and admin saves; rejects malformed rules before activation. */
export function normalizePromptRewriteConfig(raw: unknown): PromptRewriteConfig {
  if (raw === undefined) return defaultPromptRewriteConfig();
  const value = object(raw, "promptRewrite");
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") throw new Error("promptRewrite.enabled must be a boolean");
  const rules = value.rules === undefined ? defaultPromptRewriteConfig().rules : value.rules;
  if (!Array.isArray(rules) || rules.length > MAX_PROMPT_RULES) {
    throw new Error(`promptRewrite.rules must be an array with at most ${MAX_PROMPT_RULES} entries`);
  }
  const ids = new Set<string>();
  return {
    enabled,
    rules: rules.map((rawRule, index): PromptRewriteRule => {
      const field = `promptRewrite.rules[${index}]`;
      const rule = object(rawRule, field);
      if (typeof rule.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id)) {
        throw new Error(`${field}.id must be unique and contain 1-80 letters, digits, underscores or hyphens`);
      }
      ids.add(rule.id);
      if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 120) {
        throw new Error(`${field}.name must contain 1-120 characters`);
      }
      if (typeof rule.enabled !== "boolean") throw new Error(`${field}.enabled must be a boolean`);
      if (rule.action !== "replace" && rule.action !== "delete") throw new Error(`${field}.action must be replace or delete`);
      if (rule.matchMode !== "text" && rule.matchMode !== "line") throw new Error(`${field}.matchMode must be text or line`);
      if (typeof rule.match !== "string" || !rule.match.trim() || rule.match.length > MAX_PROMPT_RULE_TEXT) {
        throw new Error(`${field}.match must contain 1-${MAX_PROMPT_RULE_TEXT} characters`);
      }
      if (rule.replacement !== undefined && (typeof rule.replacement !== "string" || rule.replacement.length > MAX_PROMPT_RULE_TEXT)) {
        throw new Error(`${field}.replacement must be a string of at most ${MAX_PROMPT_RULE_TEXT} characters`);
      }
      return { id: rule.id, name: rule.name.trim(), enabled: rule.enabled, action: rule.action, matchMode: rule.matchMode, match: rule.match, replacement: rule.action === "delete" ? "" : (rule.replacement as string | undefined) ?? "" };
    }),
  };
}
