import { describe, expect, it } from "bun:test";
import { computeRetryDelayMs, parseRetryAfterMs } from "./retry.js";

describe("parseRetryAfterMs", () => {
  it("accepts complete delta-seconds values only", () => {
    expect(parseRetryAfterMs("120", 0)).toBe(120_000);
    expect(parseRetryAfterMs(" 5 ", 0)).toBe(5_000);
    expect(parseRetryAfterMs("0", 0)).toBeUndefined();
  });

  it("rejects partial or non-integer delta-seconds values", () => {
    expect(parseRetryAfterMs("1abc", 0)).toBeUndefined();
    expect(parseRetryAfterMs("1.5", 0)).toBeUndefined();
    expect(parseRetryAfterMs("Infinity", 0)).toBeUndefined();
    expect(parseRetryAfterMs("NaN", 0)).toBeUndefined();
  });

  it("accepts future HTTP-date values", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:27:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:26:00 GMT", now)).toBeUndefined();
  });
});

describe("computeRetryDelayMs", () => {
  const retry = { initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 };

  it("applies exponential backoff, cap, and deterministic jitter", () => {
    expect(computeRetryDelayMs(retry, 1, undefined, 0, () => 0)).toBe(1000);
    expect(computeRetryDelayMs(retry, 3, undefined, 0, () => 0)).toBe(4000);
    expect(computeRetryDelayMs(retry, 4, undefined, 0, () => 1)).toBe(8000);
  });

  it("caps Retry-After to maxDelayMs", () => {
    expect(computeRetryDelayMs(retry, 1, "3600", 0, () => 0)).toBe(8000);
  });

  it("returns a finite positive delay for pathological runtime config", () => {
    const badRetry = {
      initialDelayMs: Number.NEGATIVE_INFINITY,
      maxDelayMs: Number.POSITIVE_INFINITY,
      backoffFactor: Number.POSITIVE_INFINITY,
    };

    const delay = computeRetryDelayMs(badRetry, 99, undefined, 0, () => Number.NaN);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(1);
    expect(delay).toBeLessThanOrEqual(8000);
  });

  it("caps overflowing backoff at maxDelayMs", () => {
    const hugeRetry = {
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      backoffFactor: Number.MAX_VALUE,
    };

    expect(computeRetryDelayMs(hugeRetry, 3, undefined, 0, () => 0)).toBe(8000);
  });
});
