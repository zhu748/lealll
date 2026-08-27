/**
 * Pinned model catalog for GLM coding plan.
 *
 * v0.3.10.0: aligned with the CURRENT zcode client lineup (2026-08) — the
 * zcode model picker now offers exactly five models (GLM-5.3-Flash / GLM-5.3 /
 * GLM-5.2 / GLM-5-Turbo / GLM-4.7). Legacy ids (glm-4.5-air, glm-4.6,
 * glm-4.6v, glm-5, glm-5v-turbo, glm-5.1) were removed from the advertised
 * catalog but keep working when requested explicitly: model routing accepts
 * any `glm-*` id (see model-routing.ts), and thinking injection falls back to
 * the default on/off spec (thinking-specs.ts).
 *
 * Specs below from docs.z.ai model pages (2026-08):
 *   - glm-5.3 / glm-5.3-flash: 1M context, 128K max output (Flash is the
 *     natively multimodal sibling — "text parameters consistent with GLM-5.3")
 *   - glm-5.2: 1M context, 128K max output
 *   - glm-5-turbo / glm-4.7: 200K context, 128K max output
 *
 * @see thinking-specs.ts for the per-model THINKING tier table.
 */
import type { ModelDef } from "./types.js";

/** Models offered by the current zcode client (pinned with verified specs). */
export const MODELS: ModelDef[] = [
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.3", name: "GLM 5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
];

/** Look up a model by id. Returns `undefined` for unknown models. */
export function getModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

/** All model ids. */
export function listModelIds(): string[] {
  return MODELS.map((m) => m.id);
}
