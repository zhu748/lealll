import { describe, it, expect } from "bun:test";
import { ResponseStore } from "./store.js";
import type { StoredResponse } from "./store.js";

function entry(id: string): StoredResponse {
  return {
    id,
    model: "glm-5.2",
    status: "completed",
    input: [],
    output: [],
    createdAt: 0,
    lastAccessedAt: 0,
  };
}

describe("ResponseStore", () => {
  it("round-trips set → get", () => {
    const s = new ResponseStore();
    s.set(entry("resp_1"));
    expect(s.get("resp_1")?.id).toBe("resp_1");
    expect(s.get("missing")).toBeUndefined();
  });

  it("evicts oldest on LRU overflow", () => {
    const s = new ResponseStore({ maxEntries: 2 });
    s.set(entry("a"));
    s.set(entry("b"));
    s.set(entry("c"));
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")?.id).toBe("b");
    expect(s.get("c")?.id).toBe("c");
  });

  it("refreshes LRU position on get", () => {
    const s = new ResponseStore({ maxEntries: 2 });
    s.set(entry("a"));
    s.set(entry("b"));
    s.get("a");
    s.set(entry("c"));
    expect(s.get("a")?.id).toBe("a");
    expect(s.get("b")).toBeUndefined();
  });

  it("expires entries past TTL", () => {
    let now = 100;
    const s = new ResponseStore({ ttlMs: 50, now: () => now });
    s.set(entry("a"));
    expect(s.get("a")?.id).toBe("a");
    now += 51;
    expect(s.get("a")).toBeUndefined();
  });

  it("supports delete and clear", () => {
    const s = new ResponseStore();
    s.set(entry("a"));
    s.set(entry("b"));
    expect(s.delete("a")).toBe(true);
    expect(s.get("a")).toBeUndefined();
    expect(s.size()).toBe(1);
    s.clear();
    expect(s.size()).toBe(0);
  });

  it("accounts for UTF-8 history bytes and instructions", () => {
    const s = new ResponseStore(); const value = entry("unicode"); value.instructions = "中文😀".repeat(100);
    s.set(value);
    expect(s.totalBytesUsed()).toBe(Buffer.byteLength(JSON.stringify(value), "utf8") + 256);
    expect(s.totalBytesUsed()).toBeGreaterThan(JSON.stringify(value).length + 256);
  });
  it("removes expired entries before evicting a live LRU entry", () => {
    let now = 0;
    const s = new ResponseStore({ maxEntries: 2, ttlMs: 500, now: () => now });
    s.set(entry("expired"));
    now = 400;
    s.set(entry("live"));
    s.get("expired"); // expired entry will be most recently accessed
    now = 501;
    s.set(entry("new"));
    expect(s.get("expired")).toBeUndefined();
    expect(s.get("live")).toBeDefined(); expect(s.get("new")).toBeDefined();
  });
  it("declines an oversized entry without evicting live histories", () => {
    const s = new ResponseStore({ maxTotalBytes: 1000 }); s.set(entry("live"));
    const huge = entry("huge"); huge.instructions = "中".repeat(1000); s.set(huge);
    expect(s.get("live")).toBeDefined(); expect(s.get("huge")).toBeUndefined();
    expect(s.totalBytesUsed()).toBeLessThanOrEqual(1000);
  });
  it("tracks replacement and removal bytes without accumulating old sizes", () => {
    const s = new ResponseStore(); const old = entry("same"); old.instructions = "abc".repeat(100); s.set(old);
    const replacement = entry("same"); s.set(replacement);
    expect(s.totalBytesUsed()).toBe(Buffer.byteLength(JSON.stringify(replacement)) + 256);
    s.delete("same"); expect(s.totalBytesUsed()).toBe(0);
  });
  it("does not retain entries with a disabled cache budget", () => {
    const s = new ResponseStore({ maxTotalBytes: 0 }); s.set(entry("a"));
    expect(s.size()).toBe(0); expect(s.totalBytesUsed()).toBe(0);
  });

  it("does not extend creation TTL when an entry is accessed", () => {
    let now = 0;
    const s = new ResponseStore({ ttlMs: 10, now: () => now });
    s.set(entry("a"));
    now = 10;
    expect(s.get("a")).toBeDefined();
    now = 11;
    expect(s.get("a")).toBeUndefined();
    expect(s.totalBytesUsed()).toBe(0);
  });

  it("replacement expires at its own deadline and clears the old deadline", () => {
    let now = 0;
    const s = new ResponseStore({ ttlMs: 10, now: () => now });
    s.set(entry("a"));
    now = 8;
    s.set(entry("a"));
    now = 11;
    s.set(entry("b"));
    expect(s.get("a")).toBeDefined();
    now = 19;
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeDefined();
  });

  it("expires by deadline even when the clock moves backwards between writes", () => {
    let now = 100;
    const s = new ResponseStore({ maxEntries: 2, ttlMs: 50, now: () => now });
    s.set(entry("later-deadline"));
    now = 0;
    s.set(entry("earlier-deadline"));
    now = 60;
    s.set(entry("new"));
    expect(s.get("later-deadline")).toBeDefined();
    expect(s.get("earlier-deadline")).toBeUndefined();
    expect(s.size()).toBe(2);
  });

  it("evicts for byte budget and releases every byte on expiry", () => {
    let now = 0;
    const s = new ResponseStore({ maxTotalBytes: 1000, ttlMs: 10, now: () => now });
    const a = entry("a"); a.instructions = "x".repeat(200);
    const b = entry("b"); b.instructions = "x".repeat(200);
    s.set(a); s.set(b);
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeDefined();
    now = 11;
    s.set(entry("c"));
    expect(s.size()).toBe(1);
    s.clear();
    expect(s.totalBytesUsed()).toBe(0);
    s.set(entry("d"));
    expect(s.get("d")).toBeDefined();
  });

  it("does not retain unserializable entries even with an unlimited byte budget", () => {
    const s = new ResponseStore({ maxTotalBytes: Infinity });
    const circular = entry("circular");
    circular.input.push(circular as never);
    s.set(circular);
    expect(s.size()).toBe(0);
    expect(s.totalBytesUsed()).toBe(0);
  });

  it("matches a reference cache across replacements, expiry, LRU and clock rollback", () => {
    let now = 0;
    let seed = 12345;
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const cache = new ResponseStore({ maxEntries: 7, ttlMs: 15, now: () => now });
    const reference = new Map<string, number>();
    for (let i = 0; i < 2500; i++) {
      now += i % 17 === 0 ? -10 : random(5);
      const id = `response-${random(12)}`;
      switch (random(5)) {
        case 0:
          expect(cache.delete(id)).toBe(reference.delete(id));
          break;
        case 1: {
          const deadline = reference.get(id);
          if (deadline !== undefined) reference.delete(id);
          const live = deadline !== undefined && now <= deadline;
          if (live) reference.set(id, deadline);
          expect(cache.get(id)?.id).toBe(live ? id : undefined);
          break;
        }
        default:
          for (const [key, deadline] of reference) if (deadline < now) reference.delete(key);
          reference.delete(id);
          reference.set(id, now + 15);
          while (reference.size > 7) reference.delete(reference.keys().next().value!);
          cache.set(entry(id));
      }
      expect(cache.size()).toBe(reference.size);
      expect(cache.totalBytesUsed()).toBeGreaterThanOrEqual(0);
    }
  });
});
