/**
 * Tests for the per-model thinking spec table (v0.3.10.0).
 * @see thinking-specs.ts — sources: zcode.z.ai/docs/configuration tier table,
 * docs.z.ai/guides/capabilities/thinking parameter matrix, and real client
 * captures (glm-5.2 2026-06, glm-5.3 2026-08).
 */
import { describe, it, expect } from "bun:test";
import {
  MODEL_THINKING_SPECS,
  DEFAULT_THINKING_SPEC,
  TIER_BUDGETS,
  getThinkingSpec,
  normalizeTier,
} from "./thinking-specs.js";

describe("getThinkingSpec", () => {
  it("returns the glm-5.3 spec (three tiers, forced thinking, 128000)", () => {
    const s = getThinkingSpec("glm-5.3");
    expect(s.tiers).toEqual(["low", "high", "max"]);
    expect(s.maxTokens).toBe(128000);
    expect(s.forcedThinking).toBe(true);
    expect(s.effort).toBe(true);
  });

  it("glm-5.3-flash shares the glm-5.3 spec", () => {
    const s = getThinkingSpec("glm-5.3-flash");
    expect(s.tiers).toEqual(["low", "high", "max"]);
    expect(s.maxTokens).toBe(128000);
    expect(s.forcedThinking).toBe(true);
  });

  it("lookup is case-insensitive", () => {
    expect(getThinkingSpec("GLM-5.3").maxTokens).toBe(128000);
    expect(getThinkingSpec("GLM-5.3-Flash").forcedThinking).toBe(true);
  });

  it("glm-5.2: two tiers (no low), 64000, thinking optional", () => {
    const s = getThinkingSpec("glm-5.2");
    expect(s.tiers).toEqual(["high", "max"]);
    expect(s.maxTokens).toBe(64000);
    expect(s.forcedThinking).toBe(false);
    expect(s.effort).toBe(true);
  });

  it("glm-5-turbo / glm-4.7: on/off only, 64000, no effort", () => {
    for (const id of ["glm-5-turbo", "glm-4.7"]) {
      const s = getThinkingSpec(id);
      expect(s.tiers).toEqual([]);
      expect(s.maxTokens).toBe(64000);
      expect(s.forcedThinking).toBe(false);
      expect(s.effort).toBe(false);
    }
  });

  it("unknown / missing / non-string models get the default spec", () => {
    expect(getThinkingSpec("glm-4.6")).toEqual(DEFAULT_THINKING_SPEC);
    expect(getThinkingSpec("glm-5.1")).toEqual(DEFAULT_THINKING_SPEC);
    expect(getThinkingSpec("")).toEqual(DEFAULT_THINKING_SPEC);
    expect(getThinkingSpec(undefined)).toEqual(DEFAULT_THINKING_SPEC);
    expect(getThinkingSpec(123)).toEqual(DEFAULT_THINKING_SPEC);
    expect(DEFAULT_THINKING_SPEC.maxTokens).toBe(64000);
    expect(DEFAULT_THINKING_SPEC.tiers).toEqual([]);
  });

  it("every spec in the table has a consistent shape", () => {
    for (const [id, s] of Object.entries(MODEL_THINKING_SPECS)) {
      expect(typeof id).toBe("string");
      expect(s.maxTokens).toBeGreaterThan(0);
      // forced-thinking models must be effort-capable (they inject effort)
      if (s.forcedThinking) expect(s.effort).toBe(true);
      // effort-capable models must expose at least one tier
      if (s.effort) expect(s.tiers.length).toBeGreaterThan(0);
      // every advertised tier must have a budget in the shared ladder
      for (const t of s.tiers) expect(TIER_BUDGETS[t]).toBeGreaterThan(0);
    }
  });

  it("the five current zcode models all have pinned specs", () => {
    for (const id of ["glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5-turbo", "glm-4.7"]) {
      expect(MODEL_THINKING_SPECS[id]).toBeDefined();
    }
  });
});

describe("normalizeTier", () => {
  const s53 = getThinkingSpec("glm-5.3");
  const s52 = getThinkingSpec("glm-5.2");
  const sTurbo = getThinkingSpec("glm-5-turbo");

  it("supported tiers pass through unchanged", () => {
    expect(normalizeTier(s53, "low")).toBe("low");
    expect(normalizeTier(s53, "high")).toBe("high");
    expect(normalizeTier(s53, "max")).toBe("max");
    expect(normalizeTier(s52, "high")).toBe("high");
    expect(normalizeTier(s52, "max")).toBe("max");
  });

  it("glm-5.2: low steps UP to high (official Coding-Plan mapping: low/medium → high)", () => {
    expect(normalizeTier(s52, "low")).toBe("high");
  });

  it("tier-less models (on/off only) return the selection unchanged (caller ignores it)", () => {
    // Callers must check spec.tiers.length before using the result; the
    // function degrades gracefully rather than throwing.
    expect(normalizeTier(sTurbo, "high")).toBe("high");
    expect(normalizeTier(sTurbo, "low")).toBe("low");
  });

  it("budget ladder matches both captures (32000/16000/8000)", () => {
    expect(TIER_BUDGETS).toEqual({ low: 8000, high: 16000, max: 32000 });
  });
});
