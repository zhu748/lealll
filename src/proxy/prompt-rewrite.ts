import type { PromptRewriteConfig, PromptRewriteRule } from "../config/types.js";

export interface PromptRuleResult {
  id: string;
  name: string;
  enabled: boolean;
  action: "replace" | "delete";
  matches: number;
  changes: number;
  error?: string;
}

export interface PromptRewriteResult {
  enabled: boolean;
  modified: boolean;
  matches: number;
  changes: number;
  rules: PromptRuleResult[];
}

export interface PromptTextSnapshot {
  text: string;
  chars: number;
  blocks: number;
  truncated: boolean;
}

const MAX_SNAPSHOT_CHARS = 128 * 1024;
const MAX_REPLACEMENT_GROWTH = 1024 * 1024;

function systemTexts(body: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const collect = (content: unknown): void => {
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string") texts.push(block);
        else if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
  };
  collect(body.system);
  collect(body.instructions);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === "object" && message.role === "system") collect(message.content);
    }
  }
  if (Array.isArray(body.input)) {
    for (const message of body.input) {
      if (message && typeof message === "object" && (message.role === "system" || message.role === "developer")) {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block?.type === "input_text" && typeof block.text === "string") texts.push(block.text);
          }
        } else collect(message.content);
      }
    }
  }
  return texts;
}

/** Bounded display copy; truncation never changes the forwarded prompt. */
export function captureSystemPrompt(body: Record<string, unknown> | undefined): PromptTextSnapshot {
  const texts = body ? systemTexts(body) : [];
  let text = "";
  let chars = 0;
  for (const [index, part] of texts.entries()) {
    if (index > 0) { chars += 2; if (text.length < MAX_SNAPSHOT_CHARS) text += "\n\n".slice(0, MAX_SNAPSHOT_CHARS - text.length); }
    chars += part.length;
    if (text.length < MAX_SNAPSHOT_CHARS) text += part.slice(0, MAX_SNAPSHOT_CHARS - text.length);
  }
  return { text, chars, blocks: texts.length, truncated: chars > MAX_SNAPSHOT_CHARS };
}

function applyRule(text: string, rule: PromptRewriteRule, result: PromptRuleResult, budget: { remaining: number }): string {
  const replacement = rule.action === "delete" ? "" : rule.replacement;
  if (rule.matchMode === "line") {
    const keywords = rule.match.split(/\r\n|\n|\r/).map((keyword) => keyword.trim()).filter(Boolean);
    let growth = 0;
    let count = 0;
    for (const [line] of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
      if (!keywords.some((keyword) => line.includes(keyword))) continue;
      count++;
      growth += replacement.length - line.replace(/[\r\n]+$/, "").length;
    }
    if (growth > budget.remaining) {
      result.matches += count;
      result.error = "新增内容超过 1 Mi 字符预算，已跳过部分匹配";
      return text;
    }
    budget.remaining -= Math.max(0, growth);
    return text.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/g, (line) => {
      if (!keywords.some((keyword) => line.includes(keyword))) return line;
      result.matches++;
      const newline = line.match(/(?:\r\n|\n|\r)$/)?.[0] ?? "";
      const next = replacement ? replacement + newline : "";
      if (next !== line) result.changes++;
      return next;
    });
  }
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(rule.match, offset)) !== -1) { count++; offset += rule.match.length; }
  result.matches += count;
  if (!count || replacement === rule.match) return text;
  const growth = count * (replacement.length - rule.match.length);
  if (growth > budget.remaining) {
    result.error = "新增内容超过 1 Mi 字符预算，已跳过部分匹配";
    return text;
  }
  budget.remaining -= Math.max(0, growth);
  result.changes += count;
  // Literal replacement: '$&', '$1', backslashes and HTML stay ordinary text.
  return text.split(rule.match).join(replacement);
}

/** Ordered edits touch system text only, retaining block metadata and all user/tool content. */
export function rewriteSystemPrompt(body: Record<string, unknown>, config: PromptRewriteConfig): PromptRewriteResult {
  const rules = config.rules.map((rule): PromptRuleResult => ({ id: rule.id, name: rule.name, enabled: rule.enabled, action: rule.action, matches: 0, changes: 0 }));
  let modified = false;
  const budget = { remaining: MAX_REPLACEMENT_GROWTH };
  const rewrite = (text: string): string => {
    let output = text;
    if (config.enabled) {
      config.rules.forEach((rule, index) => { if (rule.enabled) output = applyRule(output, rule, rules[index], budget); });
    }
    modified = modified || output !== text;
    return output;
  };
  const rewriteContent = (content: unknown): unknown => {
    if (typeof content === "string") return rewrite(content);
    if (!Array.isArray(content)) return content;
    return content.flatMap((block) => {
      if (typeof block === "string") { const text = rewrite(block); return text === block || text.trim() ? [text] : []; }
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        const text = rewrite(block.text);
        if (text === block.text) return [block];
        return text.trim() ? [{ ...block, text }] : [];
      }
      return [block];
    });
  };
  if (config.enabled) {
    if ("system" in body) {
      const system = rewriteContent(body.system);
      if (modified && (typeof system === "string" && !system.trim() || Array.isArray(system) && system.length === 0)) delete body.system;
      else body.system = system;
    }
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (message && typeof message === "object" && message.role === "system") message.content = rewriteContent(message.content);
      }
    }
  }
  const matches = rules.reduce((sum, rule) => sum + rule.matches, 0);
  const changes = rules.reduce((sum, rule) => sum + rule.changes, 0);
  return { enabled: config.enabled, modified, matches, changes, rules };
}
