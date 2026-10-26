import { describe, expect, it } from "bun:test";
import { resolveEffectivePlan } from "./plan.js";
import type { Credential, PlanId } from "./types.js";

describe("resolveEffectivePlan", () => {
  it.each([
    [undefined, undefined, "coding-plan", "coding-plan"],
    [undefined, "jwt", "coding-plan", "coding-plan"],
    ["coding-plan", "jwt", "start-plan", "coding-plan"],
    ["start-plan", "jwt", "coding-plan", "start-plan"],
    ["start-plan", undefined, "start-plan", "coding-plan"],
    [undefined, "jwt", "start-plan", "start-plan"],
  ] as Array<[PlanId | undefined, string | undefined, PlanId, PlanId]>)(
    "resolves plan=%s jwt=%s fallback=%s to %s",
    (plan, jwt, fallback, expected) => {
      const credential: Credential = Object.freeze({ apiKey: "key", provider: "zai", plan, jwt });
      expect(resolveEffectivePlan(credential, fallback)).toBe(expected);
    },
  );
});
