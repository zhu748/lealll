import { describe, expect, it } from "bun:test";
import { RETRY_DEFAULTS, withRetryDefaults } from "./retry.js";

describe("withRetryDefaults", () => {
  it("fills missing fields and preserves disabled retry controls", () => {
    expect(withRetryDefaults({ maxRetries: 0, totalDeadlineMs: 0, credentialSwitchThreshold: 0 })).toEqual({
      ...RETRY_DEFAULTS, maxRetries: 0, totalDeadlineMs: 0, credentialSwitchThreshold: 0,
    });
  });

  it("isolates status arrays from both defaults and caller-owned configs", () => {
    const a = withRetryDefaults();
    a.retryableStatuses.push(503);
    expect(withRetryDefaults().retryableStatuses).toEqual([529, 429]);
    const original = { retryableStatuses: [502] };
    const b = withRetryDefaults(original);
    b.retryableStatuses.push(503);
    expect(original.retryableStatuses).toEqual([502]);
  });
});
