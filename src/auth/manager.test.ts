/**
 * Tests for credential types, API key parsing, and auth manager.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import { describe, it, expect } from "bun:test";
import { credentialString, isExpired } from "./types.js";
import { createApiKeyCredential } from "./apikey.js";
import { AuthManager } from "./manager.js";

describe("credentialString", () => {
  it("returns apiKey.secret when secret present", () => {
    expect(credentialString({ apiKey: "a", secret: "b", provider: "zai" })).toBe("a.b");
  });

  it("returns apiKey only when secret absent", () => {
    expect(credentialString({ apiKey: "abc", provider: "bigmodel" })).toBe("abc");
  });

  it("handles complex key values", () => {
    expect(credentialString({ apiKey: "key123", secret: "secret456", provider: "zai" })).toBe(
      "key123.secret456",
    );
  });
});

describe("isExpired", () => {
  it("returns false when expiresAt is undefined", () => {
    expect(isExpired({ apiKey: "x", provider: "zai" })).toBe(false);
  });

  it("returns true when past expiry", () => {
    const cred = { apiKey: "x", provider: "zai" as const, expiresAt: 1000 };
    expect(isExpired(cred, 2000)).toBe(true);
  });

  it("returns false when before expiry", () => {
    const cred = { apiKey: "x", provider: "zai" as const, expiresAt: 3000 };
    expect(isExpired(cred, 2000)).toBe(false);
  });
});

describe("createApiKeyCredential", () => {
  it("parses 'abc.def' into apiKey + secret", () => {
    const c = createApiKeyCredential("zai", "abc.def");
    expect(c.apiKey).toBe("abc");
    expect(c.secret).toBe("def");
    expect(c.provider).toBe("zai");
  });

  it("parses 'abc' without secret", () => {
    const c = createApiKeyCredential("bigmodel", "abc");
    expect(c.apiKey).toBe("abc");
    expect(c.secret).toBeUndefined();
  });

  it("handles keys with multiple dots (first dot splits)", () => {
    const c = createApiKeyCredential("zai", "keypart.secretpart.extra");
    expect(c.apiKey).toBe("keypart");
    expect(c.secret).toBe("secretpart.extra");
  });

  it("handles key where dot is at position 0 (treats whole string as apiKey)", () => {
    // .secret — leading dot means no apiKey before the dot
    const c = createApiKeyCredential("bigmodel", ".secret");
    expect(c.apiKey).toBe(".secret");
    expect(c.secret).toBeUndefined();
  });

  it("throws on empty key", () => {
    expect(() => createApiKeyCredential("zai", "")).toThrow(/empty/);
    expect(() => createApiKeyCredential("zai", "   ")).toThrow(/empty/);
  });
});

describe("AuthManager", () => {
  it("returns credential in apikey mode", async () => {
    const mgr = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test.secret" });
    const cred = await mgr.getCredential();
    expect(cred.apiKey).toBe("test");
    expect(cred.secret).toBe("secret");
  });

  it("returns bigmodel credential (no secret)", async () => {
    const mgr = new AuthManager({ mode: "apikey", provider: "bigmodel", apiKey: "bm-key" });
    const cred = await mgr.getCredential();
    expect(cred.apiKey).toBe("bm-key");
    expect(cred.secret).toBeUndefined();
  });

  it("throws in oauth mode without credential", async () => {
    const mgr = new AuthManager({ mode: "oauth", provider: "zai" });
    expect(mgr.getCredential()).rejects.toThrow(/not available/);
  });

  it("accepts OAuth credential via setOAuthCredential", async () => {
    const mgr = new AuthManager({ mode: "oauth", provider: "zai" });
    mgr.setOAuthCredential({ apiKey: "oa", secret: "sc", provider: "zai" });
    const cred = await mgr.getCredential();
    expect(cred.apiKey).toBe("oa");
    expect(cred.secret).toBe("sc");
  });

  it("throws when apikey mode but no key set", async () => {
    const mgr = new AuthManager({ mode: "apikey", provider: "zai" });
    expect(mgr.getCredential()).rejects.toThrow(/no credential/);
  });

  it("getMode returns current mode", () => {
    const m1 = new AuthManager({ mode: "apikey", provider: "zai", apiKey: "x" });
    expect(m1.getMode()).toBe("apikey");
    const m2 = new AuthManager({ mode: "oauth", provider: "zai" });
    expect(m2.getMode()).toBe("oauth");
  });
});
