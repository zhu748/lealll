/**
 * ZCode system prompt blocks required by zcode.z.ai start-plan gateway.
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 *
 * v0.3.10.4 — MINIMAL IDENTITY-ONLY MODE.
 *
 * The official desktop client (3.9.2, `assembleSystemMessages`) sends three
 * large system blocks (~7.7KB total):
 *
 *   block 1  cli_prefix          "You are ZCode, an interactive coding agent"
 *   block 2  stable sections     Agent Identity + ZCode Desktop Context
 *   block 3  dynamic sections    Dynamic Behavior + Environment Info
 *                                (with model line) + Context Management
 *
 * This proxy fronts third-party coding tools (Claude Code, Codex, ...) that
 * carry their own complete system prompts, so re-sending the official
 * Desktop Context / Dynamic Behavior / Context Management sections only
 * burns prompt-cache misses and can fight the client's own instructions.
 * Empirically the gateway's 3012 check passes with the identity blocks alone
 * — the identity-only 2-block shape shipped from vceshi0.1.2 (2026-06)
 * through v0.2.2.5 (2026-07) against the live gateway, so the minimal shape
 * below keeps that structure using the latest 3.9.2 identity text:
 *
 *   block 1  cli_prefix   "You are ZCode, an interactive coding agent"
 *   block 2  identity     Agent Identity section (latest 3.9.2 text)
 *
 * All full-mode section texts still live verbatim in zcode_system.json
 * (sections schema v2, extracted from the official 3.9.2 bundle by
 * /home/z/my-project/scripts/extract_zcode_sections.mjs) — restoring the
 * official 3-block assembly is a one-function change (see v0.3.10.3 history).
 *
 * FULL-MODE WIRE SHAPE REFERENCE (official 3.9.2 `assembleSystemMessages`,
 * for a future restoration):
 *   block 2 = identity + "\n\n" + Desktop Context (stable merge);
 *   block 3 = "\n\n" + Dynamic Behavior + "\n\n" + Environment Info +
 *             "\n\n" + Context Management (dynamic merge), where Environment
 *   Info's trailing line is `- You are powered by the model named
 *   ${providerId}/${modelId}.` (ref = `builtin:zai-start-plan` etc., see
 *   buildZCodeProviderModelRef).
 *
 * @see zcode_system.json
 * @see PROMPT.md for the older (v2.6.0-era) prompt structure documentation
 */
import sections from "./zcode_system.json" with { type: "json" };

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** OAuth provider flavor — mirrors src/provider/types.ts ProviderId. */
export type ProviderFlavor = "zai" | "bigmodel";

/** Which zcode plan gateway the request targets. */
export type PlanKind = "start-plan" | "coding-plan";

interface ZCodeSystemSections {
  $schema?: string;
  /** Block 1 — cli_prefix section (stable). */
  cliPrefix: string;
  /** Block 2 part 1 — Agent Identity text (stable). */
  identity: string;
  /** Block 2 part 2 — ZCode Desktop Context text (stable). */
  desktopContext: string;
  /** Block 3 part 1 — Dynamic Behavior section (dynamic). */
  dynamicBehavior: string;
  /** Block 3 part 2 — Environment Info WITHOUT the trailing model line. */
  environment: string;
  /** Block 3 part 3 — Context Management section (dynamic). */
  contextManagement: string;
  /** Model-line provider ref prefix, zai flavor (start-plan). */
  providerRefStartPlan: string;
  /** Model-line provider ref prefix, zai flavor (coding-plan). */
  providerRefCodingPlan: string;
}

const S = sections as unknown as ZCodeSystemSections;

const EPHEMERAL: { type: "ephemeral" } = { type: "ephemeral" };

/**
 * Provider-ref helper for the FULL-mode model line, e.g. `builtin:zai-start-plan`.
 * Unused by the minimal identity-only injection (v0.3.10.4) — kept for tests
 * and for a potential full-mode restoration.
 *
 * Official bundle (`$n`): `currentModel = \`${providerId}/${modelId}\`` where
 * providerId comes from the provider enum (`be` in main/chunk-UANQQ3DL.js):
 * `builtin:zai-start-plan` / `builtin:bigmodel-start-plan` /
 * `builtin:zai-coding-plan` / `builtin:bigmodel-coding-plan`.
 */
export function buildZCodeProviderModelRef(flavor?: ProviderFlavor, plan: PlanKind = "start-plan"): string {
  const base = plan === "coding-plan" ? S.providerRefCodingPlan : S.providerRefStartPlan;
  return flavor === "bigmodel" ? base.replace(":zai-", ":bigmodel-") : base;
}

/**
 * Build the injected system array — MINIMAL identity-only mode (v0.3.10.4).
 *
 * Emits exactly TWO blocks (gateway-identity only):
 *   block 1  cli_prefix  "You are ZCode, an interactive coding agent"
 *   block 2  identity    Agent Identity section (latest 3.9.2 text)
 *
 * The Desktop Context / Dynamic Behavior / Environment Info (model line) /
 * Context Management sections are intentionally NOT sent — downstream coding
 * tools bring their own system prompts and the identity-only shape is
 * empirically gateway-accepted (see file header).
 *
 * Parameters are accepted for call-site compatibility and IGNORED — the
 * minimal shape carries no model line, so model/flavor/plan don't apply.
 * To restore the full official 3-block assembly, see v0.3.10.3 git history
 * or the section texts in zcode_system.json.
 */
export function buildOfficialSystemBlocks(
  _currentModel?: string,
  _flavor?: ProviderFlavor,
  _plan: PlanKind = "start-plan",
): SystemBlock[] {
  return [
    { type: "text", text: S.cliPrefix, cache_control: { ...EPHEMERAL } },
    { type: "text", text: S.identity, cache_control: { ...EPHEMERAL } },
  ];
}

/**
 * Canonical official blocks WITHOUT the dynamic model line (legacy export
 * shape, kept for tests/diagnostics). Frozen at module load.
 */
export const ZCODE_SYSTEM_BLOCKS: readonly SystemBlock[] = Object.freeze(
  buildOfficialSystemBlocks().map(b => Object.freeze({ ...b })),
);

/**
 * Prepend the gateway-identity blocks to the request's `system` field.
 * Client system blocks (if any) are preserved after the identity blocks.
 *
 * v0.3.10.4: minimal 2-block identity-only shape (see file header). The
 * `currentModel`/`flavor` parameters are accepted for call-site compatibility
 * and ignored — no model line is injected in minimal mode.
 */
export function buildStartPlanSystem(existingSystem: unknown, _currentModel?: string, _flavor?: ProviderFlavor): unknown[] {
  const official = buildOfficialSystemBlocks();
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
