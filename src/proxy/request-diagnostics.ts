/**
 * Recursively strip fields whose value is exactly the string "[undefined]".
 *
 * Some clients serialize JavaScript `undefined` as the literal string
 * "[undefined]" instead of omitting the field. These values get forwarded as
 * bogus request parameters and are a strong WAF fingerprint.
 */
export function stripUndefinedStringFields(node: unknown): number {
  if (Array.isArray(node)) {
    let removed = 0;
    for (const item of node) {
      if (item && typeof item === "object") {
        removed += stripUndefinedStringFields(item);
      }
    }
    return removed;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    let removed = 0;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === "[undefined]") {
        delete obj[key];
        removed++;
      } else if (v && typeof v === "object") {
        removed += stripUndefinedStringFields(v);
      }
    }
    return removed;
  }
  return 0;
}

export function countThinkingBlocks(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as Record<string, unknown>).type;
        if (t === "thinking" || t === "redacted_thinking") count++;
      }
    }
  }
  return count;
}

export function countToolResultCacheControl(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && b.cache_control !== undefined) count++;
      }
    }
  }
  return count;
}

/**
 * Build a one-line summary of the transformed request body for diagnostic
 * logging on upstream 4xx. The full body can be large; this summary surfaces
 * the fields that commonly explain upstream parameter errors.
 */
export function summarizeBody(body: unknown): string {
  if (!body || typeof body !== "object") return "(empty)";
  const b = body as Record<string, unknown>;
  const parts: string[] = [];

  if (b.model) parts.push(`model=${b.model}`);
  parts.push(`thinking=${JSON.stringify(b.thinking)}`);
  if (b.context_management) parts.push("context_management=present");
  if (b.output_config) parts.push("output_config=present");
  if (b.metadata) parts.push(`metadata=${JSON.stringify(b.metadata).slice(0, 80)}`);

  const messages = b.messages;
  if (Array.isArray(messages)) {
    const msgSummary = messages.map((m: unknown, i: number) => {
      if (!m || typeof m !== "object") return `[${i}]?`;
      const msg = m as Record<string, unknown>;
      const role = msg.role ?? "?";
      const content = msg.content;
      if (typeof content === "string") return `[${i}]${role}/str`;
      if (!Array.isArray(content)) return `[${i}]${role}/?`;
      const types = content.map((c: unknown) => {
        if (!c || typeof c !== "object") return "?";
        const blk = c as Record<string, unknown>;
        const t = blk.type ?? "?";
        const cc = blk.cache_control ? "+cc" : "";
        let suffix = "";
        if (t === "tool_result") {
          if (typeof blk.content === "string") suffix = "/str";
          else if (Array.isArray(blk.content)) suffix = "/arr";
          if ("is_error" in blk) suffix += "/+err";
        }
        return `${t}${cc}${suffix}`;
      });
      return `[${i}]${role}/{${types.join(",")}}`;
    });
    parts.push(`msgs[${msgSummary.join(",")}]`);
  }

  if (Array.isArray(b.system)) {
    parts.push(`system=${b.system.length} blocks`);
  } else if (typeof b.system === "string") {
    parts.push("system=string");
  }

  if (Array.isArray(b.tools)) {
    parts.push(`tools=${b.tools.length}`);
  }

  return parts.join(" | ");
}
