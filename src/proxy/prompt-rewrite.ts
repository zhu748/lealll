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

interface CompiledRule {
  rule: PromptRewriteRule;
  keywords: string[];
  replacement: string;
  escapedReplacement: string;
}

function compileRule(rule: PromptRewriteRule): CompiledRule {
  const replacement = rule.action === "delete" ? "" : rule.replacement;
  return {
    rule,
    keywords: rule.matchMode === "line" ? rule.match.split(/\r\n|\n|\r/).map(keyword => keyword.trim()).filter(Boolean) : [],
    replacement,
    // Escape dollar substitutions once, rather than calling a replacement
    // function at every match or allocating a split array for dense deletes.
    escapedReplacement: replacement.replaceAll("$", () => "$$"),
  };
}

function applyRule(text: string, { rule, keywords, replacement, escapedReplacement }: CompiledRule, result: PromptRuleResult, budget: { remaining: number }): string {
  if (rule.matchMode === "line") {
    // Most system blocks do not contain a default keyword. Avoid allocating
    // regex matches and scanning every line twice on that common path.
    if (!keywords.some(keyword => text.includes(keyword))) return text;
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
  if (!rule.match) return text;
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
  if (!replacement && count * rule.match.length === text.length) return "";
  // Literal replacement: '$&', '$1', backslashes and HTML stay ordinary text.
  return text.replaceAll(rule.match, escapedReplacement);
}

/** Ordered edits touch system text only, retaining block metadata and all user/tool content. */
export function rewriteSystemPrompt(body: Record<string, unknown>, config: PromptRewriteConfig): PromptRewriteResult {
  const rules = config.rules.map((rule): PromptRuleResult => ({ id: rule.id, name: rule.name, enabled: rule.enabled, action: rule.action, matches: 0, changes: 0 }));
  // Compile once per logical rewrite, shared by all system blocks. Do not
  // cache mutable rule objects across requests: edits must apply immediately.
  const compiled = config.enabled ? config.rules.map(compileRule) : [];
  let modified = false;
  const budget = { remaining: MAX_REPLACEMENT_GROWTH };
  const rewrite = (text: string): string => {
    let output = text;
    if (config.enabled) {
      compiled.forEach((entry, index) => { if (entry.rule.enabled) output = applyRule(output, entry, rules[index], budget); });
    }
    modified = modified || output !== text;
    return output;
  };
  const rewriteContent = (content: unknown): unknown => {
    if (typeof content === "string") return rewrite(content);
    if (!Array.isArray(content)) return content;
    let output: unknown[] | undefined;
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      let next = block, removed = false;
      if (typeof block === "string") {
        next = rewrite(block);
        removed = next !== block && !next.trim();
      }
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        const text = rewrite(block.text);
        if (text !== block.text) {
          removed = !text.trim();
          if (!removed) next = { ...block, text };
        }
      }
      if (next !== block || removed) output ??= content.slice(0, index);
      if (output && !removed) output.push(next);
    }
    return output ?? content;
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
