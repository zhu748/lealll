/**
 * Tests for the globMatch helper used by routing rules.
 *
 * Routing rules match request model ids against operator-supplied glob
 * patterns (e.g. "glm-5*" → all glm-5.x models). The matcher supports
 * `*` (any chars, including none) and `?` (exactly one char), and is
 * case-insensitive because model ids often vary only in case.
 *
 * The implementation is a non-backtracking DP so pathological patterns
 * like "a****b" against "aaaa...a" won't blow up.
 */
import { describe, it, expect } from "bun:test";
import { globMatch } from "./handler.js";

describe("globMatch — exact match (no wildcards)", () => {
  it("matches identical strings", () => {
    expect(globMatch("glm-4.6", "glm-4.6")).toBe(true);
    expect(globMatch("gpt-5.5", "gpt-5.5")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(globMatch("glm-4.6", "glm-4.5")).toBe(false);
    expect(globMatch("glm-4.6", "glm-4.60")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(globMatch("GLM-4.6", "glm-4.6")).toBe(true);
    expect(globMatch("glm-4.6", "GLM-4.6")).toBe(true);
    expect(globMatch("GLM-4.6", "GLM-4.6")).toBe(true);
  });
});

describe("globMatch — trailing * wildcard", () => {
  it("matches when value equals prefix exactly", () => {
    expect(globMatch("glm-5*", "glm-5")).toBe(true);
  });

  it("matches when value has any suffix", () => {
    expect(globMatch("glm-5*", "glm-5.1")).toBe(true);
    expect(globMatch("glm-5*", "glm-5v-turbo")).toBe(true);
    expect(globMatch("glm-5*", "glm-5.something.very.long")).toBe(true);
  });

  it("rejects when value doesn't start with prefix", () => {
    expect(globMatch("glm-5*", "glm-4.6")).toBe(false);
    expect(globMatch("glm-5*", "gpt-5")).toBe(false);
    expect(globMatch("glm-5*", "")).toBe(false);
  });
});

describe("globMatch — ? single-char wildcard", () => {
  it("matches exactly one char", () => {
    expect(globMatch("glm-5?", "glm-5X")).toBe(true);
    expect(globMatch("glm-5??", "glm-5.1")).toBe(true);
  });

  it("rejects when char count doesn't match", () => {
    expect(globMatch("glm-5?", "glm-5")).toBe(false); // too short
    expect(globMatch("glm-5?", "glm-5.1")).toBe(false); // too long
    expect(globMatch("glm-5??", "glm-5")).toBe(false);
  });
});

describe("globMatch — middle wildcard", () => {
  it("matches with prefix*suffix", () => {
    expect(globMatch("glm-*-turbo", "glm-5-turbo")).toBe(true);
    expect(globMatch("glm-*-turbo", "glm-4.6-turbo")).toBe(true);
    expect(globMatch("glm-*-turbo", "glm--turbo")).toBe(true); // * matches empty (single -)
  });

  it("rejects when suffix doesn't match", () => {
    expect(globMatch("glm-*-turbo", "glm-5.1")).toBe(false);
    expect(globMatch("glm-*-turbo", "glm-5-air")).toBe(false);
    expect(globMatch("glm-*-turbo", "glm-turbo")).toBe(false); // needs 2 dashes; value has 1
  });
});

describe("globMatch — * alone matches everything", () => {
  it("matches any value including empty", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("*", "glm-4.6")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
  });
});

describe("globMatch — multiple wildcards", () => {
  it("handles prefix*suffix*trailing", () => {
    expect(globMatch("glm-*-v*-turbo", "glm-5-v1-turbo")).toBe(true);
    expect(globMatch("glm-*-v*-turbo", "glm-4.6-v2-turbo")).toBe(true);
    expect(globMatch("glm-*-v*-turbo", "glm-5-turbo")).toBe(false); // missing -v*-middle
  });

  it("handles g*m (start+end wildcards)", () => {
    expect(globMatch("g*m", "glm")).toBe(true);
    expect(globMatch("g*m", "gxxm")).toBe(true);
    expect(globMatch("g*m", "gxxxxxxxm")).toBe(true);
    expect(globMatch("g*m", "gx")).toBe(false); // missing m
    expect(globMatch("g*m", "lm")).toBe(false); // missing g
  });
});

describe("globMatch — edge cases", () => {
  it("empty pattern matches nothing", () => {
    expect(globMatch("", "glm-4.6")).toBe(false);
    expect(globMatch("", "")).toBe(false);
  });

  it("empty value with non-wildcard pattern", () => {
    expect(globMatch("glm", "")).toBe(false);
  });

  it("empty value with * pattern", () => {
    expect(globMatch("*", "")).toBe(true);
  });

  it("pattern with only wildcards", () => {
    expect(globMatch("**", "anything")).toBe(true);
    expect(globMatch("***", "anything")).toBe(true);
    expect(globMatch("?", "x")).toBe(true);
    expect(globMatch("??", "xy")).toBe(true);
    expect(globMatch("??", "x")).toBe(false);
  });

  it("special chars in value don't break regex-free matching", () => {
    expect(globMatch("model*", "model.v2.1-rc")).toBe(true);
    expect(globMatch("model.v2*", "model.v2.1-rc")).toBe(true);
    expect(globMatch("model-?-rc", "model-v-rc")).toBe(true);
  });
});

describe("globMatch — performance (non-backtracking)", () => {
  it("doesn't blow up on pathological patterns", () => {
    // Old naive regex-based implementations could ReDoS on patterns like this.
    // Our DP must complete in O(P*V) regardless of pattern shape.
    const pathologicalPattern = "a" + "*".repeat(50) + "b";
    const longInput = "a".repeat(1000) + "b";
    const start = Date.now();
    const result = globMatch(pathologicalPattern, longInput);
    const elapsed = Date.now() - start;
    expect(typeof result).toBe("boolean");
    expect(elapsed).toBeLessThan(100); // must complete in <100ms
  });
});
