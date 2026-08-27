import { listModelIds } from "../provider/models.js";
import type { RequestMeta } from "./stats.js";

export function peekParsedBody(parsed: unknown): RequestMeta {
  if (!parsed || typeof parsed !== "object") return { model: "-", stream: false };
  const p = parsed as Record<string, unknown>;
  return {
    model: typeof p.model === "string" ? p.model : "-",
    stream: p.stream === true,
  };
}

/**
 * Shell-glob style matcher supporting `*` (any chars) and `?` (single char).
 * Case-insensitive — model ids often differ only in case ("GLM-5" vs "glm-5").
 * Implemented as a non-backtracking DP so pathological patterns do not blow up.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return false;
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === "*") return true;
  if (!p.includes("*") && !p.includes("?")) return p === v;

  const dp = new Uint8Array(v.length + 1);
  dp[0] = 1;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    if (ch === "*") {
      for (let j = 1; j <= v.length; j++) dp[j] = dp[j]! || dp[j - 1]! ? 1 : 0;
    } else {
      for (let j = v.length; j >= 1; j--) {
        dp[j] = dp[j - 1]! && (ch === "?" || ch === v[j - 1]) ? 1 : 0;
      }
      dp[0] = 0;
    }
  }
  return dp[v.length] === 1;
}

const knownGlmModelSet = new Set(listModelIds());

export function isKnownGlmModel(model: string): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  if (normalized.startsWith("glm-")) return true;
  return knownGlmModelSet.has(normalized);
}

export function lookupModelMapping(
  clientModel: string,
  mappings: { from: string; to: string }[] | undefined,
): string | undefined {
  if (!mappings || mappings.length === 0) return undefined;
  const lower = clientModel.toLowerCase();
  return mappings.find((m) => m.from === lower)?.to;
}
