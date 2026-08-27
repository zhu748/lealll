/**
 * Tests for provider definitions and model catalog.
 * @see .omo/plans/zcode-proxy.md Task 3
 */
import { describe, it, expect } from "bun:test";
import { getProvider, listProviders, ZAI_PROVIDER, BIGMODEL_PROVIDER } from "./providers.js";
import { MODELS, getModel, listModelIds } from "./models.js";

describe("providers", () => {
  it("getProvider returns Z.AI definition", () => {
    const p = getProvider("zai");
    expect(p.id).toBe("zai");
    expect(p.anthropicBaseURL).toBe("https://api.z.ai/api/anthropic");
    expect(p.openaiBaseURL).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(p.bizHost).toBe("https://api.z.ai");
  });

  it("getProvider returns Bigmodel definition", () => {
    const p = getProvider("bigmodel");
    expect(p.id).toBe("bigmodel");
    expect(p.anthropicBaseURL).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(p.openaiBaseURL).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(p.bizHost).toBe("https://open.bigmodel.cn");
  });

  it("ZAI_PROVIDER constant matches getProvider('zai')", () => {
    expect(ZAI_PROVIDER).toEqual(getProvider("zai"));
  });

  it("BIGMODEL_PROVIDER constant matches getProvider('bigmodel')", () => {
    expect(BIGMODEL_PROVIDER).toEqual(getProvider("bigmodel"));
  });

  it("listProviders returns both providers", () => {
    const ids = listProviders();
    expect(ids).toContain("zai");
    expect(ids).toContain("bigmodel");
    expect(ids).toHaveLength(2);
  });

  it("getProvider throws on unknown id", () => {
    expect(() => getProvider("openai" as any)).toThrow(/Unknown provider/);
  });
});

describe("models", () => {
  // v0.3.10.0: catalog aligned with the CURRENT zcode lineup (2026-08) —
  // five models. Legacy ids are no longer advertised but still routable
  // (any glm-* id is accepted upstream; see model-routing.ts).
  it("MODELS contains exactly the 5 current zcode models", () => {
    expect(MODELS).toHaveLength(5);
    const ids = listModelIds();
    expect(ids).toEqual([
      "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5-turbo", "glm-4.7",
    ]);
  });

  it("getModel returns known model glm-5.3", () => {
    const m = getModel("glm-5.3");
    expect(m).toBeDefined();
    expect(m!.id).toBe("glm-5.3");
    expect(m!.name).toBe("GLM 5.3");
    expect(m!.contextWindow).toBe(1_000_000);
    expect(m!.maxOutputTokens).toBe(128_000);
  });

  it("getModel returns glm-5.3-flash with correct fields (multimodal flagship)", () => {
    const m = getModel("glm-5.3-flash");
    expect(m).toBeDefined();
    expect(m!.contextWindow).toBe(1_000_000);
    expect(m!.maxOutputTokens).toBe(128_000);
  });

  it("getModel returns undefined for unknown model", () => {
    expect(getModel("gpt-4")).toBeUndefined();
    expect(getModel("glm-4.5")).toBeUndefined();
    expect(getModel("codegeex-4")).toBeUndefined();
  });

  it("all models have valid id and contextWindow", () => {
    for (const m of MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBe(128_000);
    }
  });

  it("all models except the 5.x flagship trio have 200k context", () => {
    for (const m of MODELS) {
      if (m.id === "glm-5.2" || m.id === "glm-5.3" || m.id === "glm-5.3-flash") continue;
      expect(m.contextWindow).toBe(200_000);
    }
  });

  it("glm-5.2 / glm-5.3 / glm-5.3-flash have 1M context", () => {
    expect(getModel("glm-5.2")!.contextWindow).toBe(1_000_000);
    expect(getModel("glm-5.3")!.contextWindow).toBe(1_000_000);
    expect(getModel("glm-5.3-flash")!.contextWindow).toBe(1_000_000);
  });

  it("listModelIds matches MODELS length", () => {
    expect(listModelIds()).toHaveLength(MODELS.length);
  });

  it("includes key GLM models", () => {
    const ids = listModelIds();
    expect(ids).toContain("glm-4.7");
    expect(ids).toContain("glm-5.2");
    expect(ids).toContain("glm-5-turbo");
  });
});
