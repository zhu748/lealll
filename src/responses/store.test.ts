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
    const s = new ResponseStore({ ttlMs: 50 });
    s.set(entry("a"));
    expect(s.get("a")?.id).toBe("a");
    // Wait past TTL
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy-wait 60ms
    }
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
    const s = new ResponseStore({ maxEntries: 2, ttlMs: 500 });
    const expired = entry("expired"); s.set(expired); s.set(entry("live"));
    s.get("expired"); expired.createdAt -= 1000; // expired entry is most recently accessed
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
});
