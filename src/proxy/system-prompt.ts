/**
 * ZCode system prompt blocks required by zcode.z.ai start-plan gateway.
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 *
 * Block definitions live in zcode_system.json for easy maintenance without
 * code changes. Source: extracted from ZCode Electron app's `orderSectionsForInjection`
 * (CLI Prefix + Agent Identity with Harness).
 *
 * @see zcode_system.json
 * @see PROMPT.md for the full prompt structure
 */
import blocks from "./zcode_system.json" with { type: "json" };

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export const ZCODE_SYSTEM_BLOCKS = blocks as SystemBlock[];

/**
 * Pre-frozen snapshot of the official blocks.
 *
 * `buildStartPlanSystem` previously called `structuredClone(b)` per request
 * (~1ms for a multi-KB object) defensively in case downstream transforms
 * mutated the constant. Body-transformer.ts already wraps these in a new
 * outer array via spread, and downstream transforms never mutate the inner
 * block fields. The per-request clone is wasteful — freeze once at module
 * load instead.
 */
const OFFICIAL_BLOCKS_FROZEN: readonly SystemBlock[] = Object.freeze(
  ZCODE_SYSTEM_BLOCKS.map(b => Object.freeze({ ...b })) as SystemBlock[],
);

/**
 * Prepend official ZCode gateway blocks to the request's `system` field.
 * Client system blocks (if any) are preserved after position 1.
 */
export function buildStartPlanSystem(existingSystem: unknown): unknown[] {
  const official: SystemBlock[] = OFFICIAL_BLOCKS_FROZEN.map((b) => ({ ...b }));
  const userBlocks = normalizeUserSystem(existingSystem);
  return [...official, ...userBlocks];
}

function normalizeUserSystem(system: unknown): SystemBlock[] {
  if (system == null) return [];
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(system)) return [];
  const out: SystemBlock[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
    } else if (item && typeof item === "object") {
      const b = item as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({
          type: "text",
          text: b.text,
          ...(typeof b.cache_control === "object" && b.cache_control !== null ? { cache_control: b.cache_control as { type: "ephemeral" } } : {}),
        });
      }
    }
  }
  return out;
}
