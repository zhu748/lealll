/**
 * Per-model ZCode thinking specifications — v0.3.10.0.
 *
 * The zcode client picks thinking tiers PER MODEL (official zcode docs,
 * zcode.z.ai/cn/docs/configuration "思考强度与第三方部署差异"):
 *
 *   | 模型        | 可选档位              | 默认   |
 *   |-------------|----------------------|--------|
 *   | GLM-5.3     | low / high / max     | max    |
 *   | GLM-5.2     | nothink / high / max | max    |
 *   | 其他自定义   | 「开启 / 关闭」两档    | —     |
 *
 * Wire evidence (Anthropic-compatible interface, thinking + effort fields):
 *   - glm-5.3 (captured 2026-08): max_tokens=128000;
 *     max→budget 32000, high→16000, low→8000 (output_config.effort mirrors tier)
 *   - glm-5.2 (captured 2026-06): max_tokens=64000;
 *     max→budget 32000, high→16000; nothink → no thinking field at all
 *   - Budget ladder is identical across captured models — only the AVAILABLE
 *     tiers and max_tokens differ per model.
 *
 * Official API docs (docs.z.ai/guides/capabilities/thinking, 2026-08):
 *   - reasoning_effort is supported by GLM-5.2 and above ONLY.
 *   - low tier is ONLY supported by GLM-5.3 / GLM-5.3-Flash.
 *   - GLM-5.3 / GLM-5.3-Flash NO LONGER SUPPORT disabling thinking
 *     (thinking.type=disabled returns an error). Official migration guidance:
 *     disabled → enabled + low effort.
 *   - GLM-5.2 Coding-Plan effort mapping: none/minimal → stop thinking;
 *     low/medium → high; xhigh → max.
 *
 * Models without tiers (glm-5-turbo / glm-4.7, and unknown ids) use the
 * zcode "开启 / 关闭" shape: thinking on/off only — NO output_config.effort,
 * NO forced budget_tokens — plus the legacy max_tokens=64000 cap the client
 * has sent since 2026-06 (gateway-accepted for every model for months).
 */

/** Thinking tiers offered by the zcode client UI (and our dashboard selector). */
export type ThinkingTier = "low" | "high" | "max";

/** Shared budget ladder (budget_tokens per tier), confirmed by both captures. */
export const TIER_BUDGETS: Record<ThinkingTier, number> = {
  low: 8000,
  high: 16000,
  max: 32000,
};

export interface ModelThinkingSpec {
  /** Effort tiers the zcode client offers for this model. Empty = on/off only. */
  tiers: readonly ThinkingTier[];
  /** max_tokens the real zcode client sends for this model. */
  maxTokens: number;
  /** Model rejects thinking.type=disabled (GLM-5.3 family). */
  forcedThinking: boolean;
  /** Model accepts output_config.effort (reasoning_effort-capable, GLM-5.2+). */
  effort: boolean;
}

/** Specs for the current zcode model lineup (captured / officially documented). */
export const MODEL_THINKING_SPECS: Record<string, ModelThinkingSpec> = {
  // GLM-5.3 — captured 2026-08: three tiers, max_tokens=128000, thinking always on.
  "glm-5.3": {
    tiers: ["low", "high", "max"],
    maxTokens: 128000,
    forcedThinking: true,
    effort: true,
  },
  // GLM-5.3-Flash — "text parameters are consistent with GLM-5.3" (official docs).
  "glm-5.3-flash": {
    tiers: ["low", "high", "max"],
    maxTokens: 128000,
    forcedThinking: true,
    effort: true,
  },
  // GLM-5.2 — captured 2026-06: nothink/high/max tiers, max_tokens=64000.
  // low tier NOT supported (official: low is 5.3-only); selected low maps to high.
  "glm-5.2": {
    tiers: ["high", "max"],
    maxTokens: 64000,
    forcedThinking: false,
    effort: true,
  },
  // GLM-5-Turbo / GLM-4.7 — no reasoning_effort support (GLM-5.2+ only).
  // zcode shows 「开启 / 关闭」 for these; legacy 64000 max_tokens cap.
  "glm-5-turbo": {
    tiers: [],
    maxTokens: 64000,
    forcedThinking: false,
    effort: false,
  },
  "glm-4.7": {
    tiers: [],
    maxTokens: 64000,
    forcedThinking: false,
    effort: false,
  },
};

/**
 * Fallback for models without a pinned spec (legacy glm-4.5/4.6/5/5.1, or ids
 * we have never seen): the pre-2026-08 client shape — on/off thinking,
 * max_tokens=64000, no effort. This exact shape has been gateway-accepted
 * for every model since v0.1.9.
 */
export const DEFAULT_THINKING_SPEC: ModelThinkingSpec = {
  tiers: [],
  maxTokens: 64000,
  forcedThinking: false,
  effort: false,
};

/** Case-insensitive spec lookup. Unknown ids get the default spec. */
export function getThinkingSpec(model: unknown): ModelThinkingSpec {
  if (typeof model !== "string" || model.length === 0) return DEFAULT_THINKING_SPEC;
  return MODEL_THINKING_SPECS[model.toLowerCase()] ?? DEFAULT_THINKING_SPEC;
}

/**
 * Normalize a selected tier against the model's supported tiers, following the
 * official GLM Coding-Plan effort mapping (docs.z.ai):
 *   - tier supported → used as-is
 *   - tier not supported → step UP to the nearest supported tier below max
 *     (official 5.2 mapping: low/medium → high)
 *   - model without tiers → returned tier is meaningless (caller must check
 *     `spec.tiers.length` before injecting effort fields)
 */
export function normalizeTier(spec: ModelThinkingSpec, tier: ThinkingTier): ThinkingTier {
  if (spec.tiers.includes(tier)) return tier;
  // Step up: low → high → max. Use the smallest supported tier that is >= selected.
  const ladder: ThinkingTier[] = ["low", "high", "max"];
  const idx = ladder.indexOf(tier);
  for (let i = idx; i < ladder.length; i++) {
    if (spec.tiers.includes(ladder[i]!)) return ladder[i]!;
  }
  // No supported tier at or above the selection (shouldn't happen — specs with
  // tiers always include max): fall back to the highest supported tier.
  return spec.tiers[spec.tiers.length - 1] ?? tier;
}
