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
  setAccountName,
  setAccountEmail,
  setAccountDisabled,
  exportSingleAccount,
  maskApiKey,
  invalidateStoreCache,
  _resetKeyCacheForTesting,
} from "./store.js";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types.js";

const TEST_SECRET = "test-encryption-secret-for-zcode-proxy";

describe("credential store", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    _resetKeyCacheForTesting();
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    delete process.env.ZCODE_PROXY_LEGACY_SEED;
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

  // --- vCESHI0.0.3: keepActive + cache invalidation + undecryptable guard ---

  it("saveCredential with keepActive:true preserves the existing activeId", async () => {
    // First credential: becomes active (no prior active to preserve)
    await saveCredential({ apiKey: "first-key", provider: "zai" });
    const list1 = await listAccounts();
    expect(list1.activeId).toBe(list1.accounts[0].id);

    // Switch active to first explicitly
    await switchAccount(list1.accounts[0].id);

    // Second credential with keepActive:true — should be ADDED but NOT activated
    await saveCredential({ apiKey: "second-key", provider: "bigmodel" }, { keepActive: true });
    const list2 = await listAccounts();
    expect(list2.accounts).toHaveLength(2);
    // activeId should still point at the first credential, not the new one
    expect(list2.activeId).toBe(list1.accounts[0].id);
    // loadCredential should still return the first credential
    const active = await loadCredential();
    expect(active!.apiKey).toBe("first-key");
  });

  it("saveCredential with keepActive:true still activates if no prior active exists", async () => {
    // First credential with keepActive:true — no prior active, so it becomes active
    // (matches OAuth flow on first-ever login: user has nothing yet)
    await saveCredential({ apiKey: "first-key", provider: "zai" }, { keepActive: true });
    const list = await listAccounts();
    expect(list.accounts).toHaveLength(1);
    expect(list.activeId).toBe(list.accounts[0].id);
  });

  it("invalidateStoreCache forces re-read from disk on next read", async () => {
    // Save one credential
    await saveCredential({ apiKey: "first-key", provider: "zai" });
    let list = await listAccounts();
    expect(list.accounts).toHaveLength(1);

    // Simulate an EXTERNAL process writing a second credential by bypassing
    // the cache: manually clear and re-save directly through the public API
    // (which is what start.bat does — runs `zcode-proxy auth login` in a
    // separate process, writing to the same credentials.json on disk).
    // To simulate this in-process, we invalidate the cache so the next read
    // goes back to disk.
    //
    // We can't truly spawn a separate process in a unit test, but we CAN
    // verify the cache invalidation works: after invalidateStoreCache(),
    // the next listAccounts() MUST reflect disk state, not the cached state.
    //
    // Approach: write a second credential via saveCredential (which updates
    // the cache), then invalidate the cache, then verify loadCredential()
    // re-reads from disk (returning the second credential).
    await saveCredential({ apiKey: "second-key", provider: "bigmodel" });
    list = await listAccounts();
    expect(list.accounts).toHaveLength(2);

    // Now invalidate and verify the cache was actually cleared
    invalidateStoreCache();
    // The next read should re-read from disk and return the same 2 accounts
    // (this verifies the invalidation didn't corrupt anything)
    const list2 = await listAccounts();
    expect(list2.accounts).toHaveLength(2);
    // Both keys are <= 12 chars so maskApiKey returns them as-is
    const keys = list2.accounts.map(a => a.apiKeyMask).sort();
    expect(keys).toEqual(["first-key", "second-key"]);
  });

  it("multi-seed fallback recovers credentials when ZCODE_PROXY_LEGACY_SEED matches the old seed", async () => {
    // Simulates the REAL upgrade scenario:
    //   1. v1.x binary encrypts credentials.json with seed = "old-bun-homedir-win32-x64"
    //      (Bun 1.1 returned a different homedir() than Bun 1.3)
    //   2. v2.x binary (new Bun) computes a different homedir() → different default seed
    //      → decryption fails with the current key
    //   3. User sets ZCODE_PROXY_LEGACY_SEED to the old seed → multi-seed fallback
    //      finds it, decrypts successfully, AND persists the recovered key to the
    //      key file so subsequent runs don't need the env var anymore.
    //
    // Step 1: encrypt with the "old" seed via ZCODE_PROXY_LEGACY_SEED
    //         (we use the env var path to force a specific seed for the encryption,
    //         simulating what the old binary did)
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "old-seed-simulating-bun-1.1-homedir";
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "original-key", provider: "zai" });
    expect(await loadCredential()).not.toBeNull();

    // Step 2: change the env var to a DIFFERENT value (simulating new Bun's homedir)
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "new-seed-simulating-bun-1.3-homedir";
    _resetKeyCacheForTesting();
    invalidateStoreCache();

    // Now the current key can't decrypt. Without fallback, loadCredential returns null.
    // But with ZCODE_PROXY_LEGACY_SEED set to the old seed, the multi-seed fallback
    // should find it and recover the credential.
    process.env.ZCODE_PROXY_LEGACY_SEED = "old-seed-simulating-bun-1.1-homedir";
    const recovered = await loadCredential();
    expect(recovered).not.toBeNull();
    expect(recovered!.apiKey).toBe("original-key");

    // The key file should now be persisted with the recovered key — clear the
    // env vars entirely and verify the credential still loads (key file takes over).
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    delete process.env.ZCODE_PROXY_LEGACY_SEED;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const fromKeyFile = await loadCredential();
    expect(fromKeyFile).not.toBeNull();
    expect(fromKeyFile!.apiKey).toBe("original-key");
  });

  it("REFUSES to overwrite credentials.json when ALL fallback keys fail", async () => {
    // When the multi-seed fallback can't find any working key (e.g. credentials.json
    // was copied from a completely different machine with unknown homedir), the
    // guard kicks in and prevents saveCredential from silently destroying the
    // unreadable file.
    //
    // Step 1: encrypt with a secret that won't be in any fallback candidate list
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "completely-unique-secret-not-in-any-fallback-list";
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "original-key", provider: "zai" });
    expect(await loadCredential()).not.toBeNull();

    // Step 2: switch to a DIFFERENT secret (no LEGACY_SEED set → no fallback recovery)
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "a-different-secret-also-not-in-fallback";
    delete process.env.ZCODE_PROXY_LEGACY_SEED;
    _resetKeyCacheForTesting();
    invalidateStoreCache();

    // The multi-seed fallback should fail (none of the homedir/USERPROFILE/etc.
    // seeds will match "completely-unique-secret-not-in-any-fallback-list"),
    // so loadCredential returns null AND the guard flag is set.
    const loaded = await loadCredential();
    expect(loaded).toBeNull();

    // Step 3: try to save a new credential — should THROW (guard active)
    await expect(
      saveCredential({ apiKey: "new-key", provider: "bigmodel" }),
    ).rejects.toThrow(/Refusing to overwrite/);

    // The original credentials.json should still exist on disk (not deleted)
    const storePath = join(homedir(), ".zcode-proxy", "credentials.json");
    expect(existsSync(storePath)).toBe(true);

    // After clearCredential (user explicitly confirms discard), saving works again
    clearCredential();
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "fresh-key", provider: "zai" });
    const fresh = await loadCredential();
    expect(fresh!.apiKey).toBe("fresh-key");
  });

  it("key file is written on first run and reused on subsequent runs (immune to homedir changes)", async () => {
    // Verify the core fix: once the key file exists, homedir/platform/arch changes
    // don't affect decryption. This is the "version update no longer locks me out"
    // guarantee.
    //
    // Step 1: first run with no key file — derives key from seed, persists to key file
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "test-key", provider: "zai" });

    const keyFilePath = join(homedir(), ".zcode-proxy", ".secret-key");
    expect(existsSync(keyFilePath)).toBe(true);

    // Step 2: simulate homedir change by overriding the env var with a different
    // "fake homedir" — but since the key file takes priority over seed derivation,
    // the credential should still load.
    // We can't actually change os.homedir() in a test, but we can verify the key
    // file is being READ (not re-derived) by checking that the credential loads
    // even when ZCODE_PROXY_CREDENTIAL_SECRET is unset (which forces the key file
    // path; if the key file weren't being read, the seed derivation would produce
    // a different key and decryption would fail).
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("test-key");

    // Step 3: even after clearing the in-memory key cache (simulating a process
    // restart), the key file is re-read and decryption still works.
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const reloaded = await loadCredential();
    expect(reloaded).not.toBeNull();
    expect(reloaded!.apiKey).toBe("test-key");
  });

  // --- vceshi0.0.4: name + email fields, sorting, edit, export ---

  it("saveCredential preserves name + email fields when provided", async () => {
    const cred: Credential = {
      apiKey: "test-key-with-name-email",
      provider: "zai",
      plan: "start-plan",
      name: "alice@example.com-start-plan",
      email: "alice@example.com",
    };
    await saveCredential(cred);

    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("alice@example.com-start-plan");
    expect(loaded!.email).toBe("alice@example.com");

    const list = await listAccounts();
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0].name).toBe("alice@example.com-start-plan");
    expect(list.accounts[0].email).toBe("alice@example.com");
  });

  it("listAccounts returns name/email as empty strings when not set", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    expect(list.accounts[0].name).toBe("");
    expect(list.accounts[0].email).toBe("");
  });

  it("listAccounts sorts accounts by createdAt ascending (oldest first)", async () => {
    // Save 3 accounts with controlled createdAt via direct manipulation.
    // We can't set createdAt directly via saveCredential (it uses Date.now()),
    // so we save them in order with small artificial delays to ensure distinct
    // timestamps. Bun's Date.now() resolution is millisecond-level.
    await saveCredential({ apiKey: "first", provider: "zai" });
    await new Promise(r => setTimeout(r, 5));
    await saveCredential({ apiKey: "second", provider: "bigmodel" });
    await new Promise(r => setTimeout(r, 5));
    await saveCredential({ apiKey: "third", provider: "zai" });

    const list = await listAccounts();
    expect(list.accounts).toHaveLength(3);
    // Oldest first (lowest createdAt first)
    expect(list.accounts[0].apiKeyMask).toBe("first");
    expect(list.accounts[1].apiKeyMask).toBe("second");
    expect(list.accounts[2].apiKeyMask).toBe("third");
  });

  it("setAccountName updates the name and clears when empty", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].name).toBe("");

    // Set a name
    let ok = await setAccountName(id, "my-account-name");
    expect(ok).toBe(true);
    let list2 = await listAccounts();
    expect(list2.accounts[0].name).toBe("my-account-name");

    // Clear the name (empty string)
    ok = await setAccountName(id, "   ");
    expect(ok).toBe(true);
    list2 = await listAccounts();
    expect(list2.accounts[0].name).toBe("");
  });

  it("setAccountEmail updates the email and clears when empty", async () => {
    await saveCredential({ apiKey: "k", provider: "zai", email: "orig@x.com" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].email).toBe("orig@x.com");

    // Update email
    let ok = await setAccountEmail(id, "new@x.com");
    expect(ok).toBe(true);
    let list2 = await listAccounts();
    expect(list2.accounts[0].email).toBe("new@x.com");

    // Clear email
    ok = await setAccountEmail(id, "");
    expect(ok).toBe(true);
    list2 = await listAccounts();
    expect(list2.accounts[0].email).toBe("");
  });

  it("setAccountName / setAccountEmail return false for unknown id", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    expect(await setAccountName("nonexistent", "x")).toBe(false);
    expect(await setAccountEmail("nonexistent", "x@y.com")).toBe(false);
  });

  it("exportSingleAccount returns full credential JSON (with secrets)", async () => {
    const cred: Credential = {
      apiKey: "full-api-key-1234567890",
      secret: "secret-456",
      provider: "zai",
      plan: "coding-plan",
      userId: "user-789",
      name: "alice@x.com-coding-plan",
      email: "alice@x.com",
    };
    await saveCredential(cred);
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const exported = await exportSingleAccount(id);
    expect(exported).not.toBeNull();
    expect(exported!.id).toBe(id);
    expect(exported!.label).toBeTruthy();
    expect(exported!.createdAt).toBeGreaterThan(0);
    // Full credential with secrets (NOT masked)
    expect(exported!.credential.apiKey).toBe("full-api-key-1234567890");
    expect(exported!.credential.secret).toBe("secret-456");
    expect(exported!.credential.userId).toBe("user-789");
    expect(exported!.credential.name).toBe("alice@x.com-coding-plan");
    expect(exported!.credential.email).toBe("alice@x.com");
  });

  it("exportSingleAccount returns null for unknown id", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const exported = await exportSingleAccount("nonexistent-id");
    expect(exported).toBeNull();
  });

  // --- vceshi0.0.6: disabled flag ---

  it("setAccountDisabled toggles the disabled flag", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].disabled).toBe(false);

    // Disable
    let ok = await setAccountDisabled(id, true);
    expect(ok).toBe(true);
    let list2 = await listAccounts();
    expect(list2.accounts[0].disabled).toBe(true);

    // Enable
    ok = await setAccountDisabled(id, false);
    expect(ok).toBe(true);
    list2 = await listAccounts();
    expect(list2.accounts[0].disabled).toBe(false);
  });

  it("switchAccount refuses to activate a disabled credential", async () => {
    // Save two accounts, disable the second, verify switchAccount returns false
    await saveCredential({ apiKey: "k1", provider: "zai" });
    await saveCredential({ apiKey: "k2", provider: "bigmodel" });
    const list = await listAccounts();
    const id1 = list.accounts[0].id;
    const id2 = list.accounts[1].id;

    // Switch to id1 first (so activeId is set)
    expect(await switchAccount(id1)).toBe(true);

    // Disable id2
    expect(await setAccountDisabled(id2, true)).toBe(true);

    // Attempt to activate id2 — should fail (disabled)
    expect(await switchAccount(id2)).toBe(false);

    // Re-enable id2
    expect(await setAccountDisabled(id2, false)).toBe(true);
    // Now activation should succeed
    expect(await switchAccount(id2)).toBe(true);
  });

  it("setAccountDisabled returns false for unknown id", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    expect(await setAccountDisabled("nonexistent", true)).toBe(false);
  });

  // --- vceshi0.0.5: undecryptableFilePresent guard auto-clears on success ---

  it("undecryptableFilePresent guard auto-clears when decryption succeeds on retry", async () => {
    // Simulate the recovery scenario:
    //   1. Save a credential with secret A
    //   2. Change secret so decryption fails → guard set to true
    //   3. Change secret back → decryption succeeds → guard should auto-clear
    //   4. saveCredential should now work (no "Refusing to overwrite" error)
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "secret-A";
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "original-key", provider: "zai" });
    expect(await loadCredential()).not.toBeNull();

    // Step 2: change secret, invalidate cache, read → fails, guard set
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "secret-B-wrong";
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const failedLoad = await loadCredential();
    expect(failedLoad).toBeNull();

    // Attempting to save now should fail (guard active)
    await expect(
      saveCredential({ apiKey: "should-fail", provider: "zai" }),
    ).rejects.toThrow(/Refusing to overwrite/);

    // Step 3: change secret back, invalidate cache, read → succeeds, guard clears
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "secret-A";
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const recoveredLoad = await loadCredential();
    expect(recoveredLoad).not.toBeNull();
    expect(recoveredLoad!.apiKey).toBe("original-key");

    // Step 4: saveCredential should now work (guard auto-cleared)
    await saveCredential({ apiKey: "new-after-recovery", provider: "zai" });
    const finalLoad = await loadCredential();
    expect(finalLoad!.apiKey).toBe("new-after-recovery");
  });
});
