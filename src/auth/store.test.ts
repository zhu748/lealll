/**
 * Tests for encrypted credential store.
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  saveCredential,
  loadCredential,
  clearCredential,
  listAccounts,
  switchAccount,
  removeAccount,
  setAccountLabel,
  setAccountProxy,
  maskApiKey,
} from "./store.js";
import type { Credential } from "./types.js";

const TEST_SECRET = "test-encryption-secret-for-zcode-proxy";

describe("credential store", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns null when no credential stored", async () => {
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("roundtrips: save → load → matches original", async () => {
    const cred: Credential = {
      apiKey: "testApiKey123",
      secret: "testSecret456",
      provider: "zai",
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("testApiKey123");
    expect(loaded!.secret).toBe("testSecret456");
    expect(loaded!.provider).toBe("zai");
  });

  it("roundtrips bigmodel credential (no secret)", async () => {
    const cred: Credential = {
      apiKey: "bmKey789",
      provider: "bigmodel",
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("bmKey789");
    expect(loaded!.secret).toBeUndefined();
    expect(loaded!.provider).toBe("bigmodel");
  });

  it("clearCredential removes stored credential", async () => {
    const cred: Credential = { apiKey: "x", provider: "zai" };
    await saveCredential(cred);
    clearCredential();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("preserves expiresAt field", async () => {
    const cred: Credential = {
      apiKey: "x",
      provider: "zai",
      expiresAt: 9999999999999,
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded!.expiresAt).toBe(9999999999999);
  });
});

describe("multi-account store", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("saveCredential marks new account as active", async () => {
    await saveCredential({ apiKey: "key1", provider: "zai" });
    const list = await listAccounts();
    expect(list.accounts).toHaveLength(1);
    expect(list.activeId).toBe(list.accounts[0].id);
    expect(list.accounts[0].apiKeyMask).toBe("key1");
  });

  it("saving a second, different account keeps both and switches active", async () => {
    await saveCredential({ apiKey: "key1", provider: "zai" });
    await saveCredential({ apiKey: "key2", provider: "bigmodel" });
    const list = await listAccounts();
    expect(list.accounts).toHaveLength(2);
    // activeId should now point to the second account (key2/bigmodel)
    const active = list.accounts.find(a => a.id === list.activeId);
    expect(active?.provider).toBe("bigmodel");
    expect(active?.apiKeyMask).toBe("key2");
  });

  it("saving the same provider+apiKey updates in place without duplicating", async () => {
    await saveCredential({ apiKey: "key1", provider: "zai", userId: "u1" });
    await saveCredential({ apiKey: "key1", provider: "zai", userId: "u1-updated", jwt: "jwt-token" });
    const list = await listAccounts();
    expect(list.accounts).toHaveLength(1);
    // loadCredential should reflect the updated fields
    const loaded = await loadCredential();
    expect(loaded!.userId).toBe("u1-updated");
    expect(loaded!.jwt).toBe("jwt-token");
  });

  it("switchAccount changes the active credential", async () => {
    await saveCredential({ apiKey: "key1", provider: "zai" });
    await saveCredential({ apiKey: "key2", provider: "bigmodel" });
    // After save, key2/bigmodel is active
    let loaded = await loadCredential();
    expect(loaded!.provider).toBe("bigmodel");

    // Switch back to first
    const list = await listAccounts();
    const firstId = list.accounts.find(a => a.provider === "zai")!.id;
    const ok = await switchAccount(firstId);
    expect(ok).toBe(true);

    loaded = await loadCredential();
    expect(loaded!.provider).toBe("zai");
    expect(loaded!.apiKey).toBe("key1");
  });

  it("switchAccount returns false for unknown id", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const ok = await switchAccount("nonexistent-id");
    expect(ok).toBe(false);
  });

  it("removeAccount deletes the account and falls back to first remaining", async () => {
    await saveCredential({ apiKey: "key1", provider: "zai" });
    await saveCredential({ apiKey: "key2", provider: "bigmodel" });

    const list = await listAccounts();
    const bigmodelId = list.accounts.find(a => a.provider === "bigmodel")!.id;
    const ok = await removeAccount(bigmodelId);
    expect(ok).toBe(true);

    const list2 = await listAccounts();
    expect(list2.accounts).toHaveLength(1);
    expect(list2.accounts[0].provider).toBe("zai");
    // activeId should fall back to the only remaining
    expect(list2.activeId).toBe(list2.accounts[0].id);

    const loaded = await loadCredential();
    expect(loaded!.apiKey).toBe("key1");
  });

  it("setAccountLabel updates the label", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    const ok = await setAccountLabel(id, "My Custom Label");
    expect(ok).toBe(true);

    const list2 = await listAccounts();
    expect(list2.accounts[0].label).toBe("My Custom Label");
  });

  it("maskApiKey masks long keys correctly", () => {
    expect(maskApiKey("abcdefgh12345678wxyz")).toBe("abcdefgh...wxyz");
    expect(maskApiKey("short")).toBe("short");
    expect(maskApiKey("")).toBe("");
  });

  // --- v2.1.4.1test5: per-account proxy ---

  it("setAccountProxy persists proxy on the credential", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].proxy).toBe("");

    const ok = await setAccountProxy(id, "http://127.0.0.1:7890");
    expect(ok).toBe(true);

    const list2 = await listAccounts();
    expect(list2.accounts[0].proxy).toBe("http://127.0.0.1:7890");

    // The actual credential (loaded via loadCredential) should also carry it
    const cred = await loadCredential();
    expect(cred!.proxy).toBe("http://127.0.0.1:7890");
  });

  it("setAccountProxy with empty string clears the override", async () => {
    await saveCredential({ apiKey: "k", provider: "zai", proxy: "socks5://10.0.0.1:1080" } as Credential);
    const list = await listAccounts();
    expect(list.accounts[0].proxy).toBe("socks5://10.0.0.1:1080");

    const id = list.accounts[0].id;
    const ok = await setAccountProxy(id, "   ");
    expect(ok).toBe(true);

    const list2 = await listAccounts();
    expect(list2.accounts[0].proxy).toBe("");

    const cred = await loadCredential();
    expect(cred!.proxy).toBeUndefined();
  });

  it("setAccountProxy returns false for unknown account id", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const ok = await setAccountProxy("nonexistent-id", "http://localhost:1");
    expect(ok).toBe(false);
  });

  it("setAccountProxy preserves other credential fields", async () => {
    await saveCredential({ apiKey: "k", provider: "zai", plan: "coding-plan", userId: "u1", jwt: "jwttoken" });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    await setAccountProxy(id, "http://proxy:8080");

    const cred = await loadCredential();
    expect(cred!.apiKey).toBe("k");
    expect(cred!.provider).toBe("zai");
    expect(cred!.plan).toBe("coding-plan");
    expect(cred!.userId).toBe("u1");
    expect(cred!.jwt).toBe("jwttoken");
    expect(cred!.proxy).toBe("http://proxy:8080");
  });

  it("listAccounts exposes proxy field for all accounts (empty string when unset)", async () => {
    await saveCredential({ apiKey: "k1", provider: "zai" });
    await saveCredential({ apiKey: "k2", provider: "bigmodel", proxy: "http://p:8080" } as Credential);

    const list = await listAccounts();
    expect(list.accounts).toHaveLength(2);
    const zaiAcc = list.accounts.find(a => a.provider === "zai")!;
    const bigAcc = list.accounts.find(a => a.provider === "bigmodel")!;
    expect(zaiAcc.proxy).toBe("");
    expect(bigAcc.proxy).toBe("http://p:8080");
  });
});
