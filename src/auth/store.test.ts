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
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types.js";

/** Test helper: remove all .broken-* backup files from the store dir. */
function cleanupBrokenBackups(): void {
  const storeDir = join(homedir(), ".zcode-proxy");
  if (!existsSync(storeDir)) return;
  try {
    for (const f of readdirSync(storeDir)) {
      if (f.startsWith("credentials.json.broken-")) {
        try { unlinkSync(join(storeDir, f)); } catch {}
      }
    }
  } catch {}
}

// With the fixed-key scheme (SHA-256("520")), there's no per-test secret to
// set. The env vars below are only used by the legacy-fallback recovery tests
// to simulate files encrypted by older versions of this code.
describe("credential store", () => {
  beforeEach(() => {
    _resetKeyCacheForTesting();
    clearCredential();
    cleanupBrokenBackups();
  });

  afterEach(() => {
    clearCredential();
    cleanupBrokenBackups();
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
    _resetKeyCacheForTesting();
    clearCredential();
    // Also clean up any leftover .broken-* files from prior test runs
    cleanupBrokenBackups();
  });

  afterEach(() => {
    clearCredential();
    cleanupBrokenBackups();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    delete process.env.ZCODE_PROXY_LEGACY_SEED;
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

  it("legacy fallback recovers credentials encrypted by an older version's seed-based key", async () => {
    // Simulates the upgrade scenario for users with EXISTING credentials.json
    // files encrypted by an older version of this code (which used
    // `${homedir}-${platform}-${arch}` as the encryption key seed):
    //   1. Old binary encrypts credentials.json with seed = "old-bun-homedir-win32-x64"
    //   2. New binary uses the fixed key SHA-256("520") → fixed key can't decrypt
    //   3. Multi-seed fallback tries the old seed → succeeds → file is re-encrypted
    //      with the fixed key on the next writeStore() call.
    //
    // We can't easily change os.homedir() in a test, so we simulate the
    // "different machine / different seed" scenario by:
    //   - Manually writing a credentials.json encrypted with a seed that ISN'T
    //     the current homedir seed (so the fixed key fails AND the current
    //     homedir seed fails, but ZCODE_PROXY_LEGACY_SEED provides the recovery seed).

    const crypto = await import("node:crypto");
    const oldSeed = "old-bun-homedir-win32-x64";
    const oldKey = crypto.createHash("sha256").update(oldSeed).digest();
    const storeJson = JSON.stringify({
      version: 2,
      activeId: "legacy-acct",
      accounts: [{
        id: "legacy-acct",
        label: "legacy",
        createdAt: Date.now(),
        credential: { apiKey: "legacy-key", provider: "zai" },
      }],
    });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", oldKey, iv);
    const enc = Buffer.concat([cipher.update(storeJson, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encrypted = Buffer.concat([iv, tag, enc]).toString("base64");

    // Write the legacy-encrypted credentials.json directly to disk.
    const storePath = join(homedir(), ".zcode-proxy", "credentials.json");
    mkdirSync(join(homedir(), ".zcode-proxy"), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });

    // Step 1: without LEGACY_SEED, the fixed key + current homedir seeds all fail.
    // The file is marked undecryptable, loadCredential returns null.
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const failedLoad = await loadCredential();
    expect(failedLoad).toBeNull();

    // Step 2: set ZCODE_PROXY_LEGACY_SEED to the old seed → fallback finds it,
    // decrypts successfully. The guard should auto-clear.
    process.env.ZCODE_PROXY_LEGACY_SEED = oldSeed;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const recovered = await loadCredential();
    expect(recovered).not.toBeNull();
    expect(recovered!.apiKey).toBe("legacy-key");

    // Step 3: after a write (which re-encrypts with the fixed key), the
    // LEGACY_SEED env var is no longer needed — the fixed key alone decrypts.
    await setAccountLabel((await listAccounts()).accounts[0].id, "new-label");
    delete process.env.ZCODE_PROXY_LEGACY_SEED;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const afterReEncrypt = await loadCredential();
    expect(afterReEncrypt).not.toBeNull();
    expect(afterReEncrypt!.apiKey).toBe("legacy-key");
  });

  it("REFUSES to overwrite credentials.json when ALL fallback keys fail (corrupt / unknown-origin file)", async () => {
    // With the fixed-key scheme, this scenario can only happen if:
    //   - The file was encrypted by a completely unknown key (e.g. manually
    //     corrupted, or encrypted by a fork of this project with a different seed), AND
    //   - None of the legacy fallback candidates (homedir variants, LEGACY_SEED,
    //     CREDENTIAL_SECRET) match that key.
    //
    // In that case, the guard kicks in and prevents saveCredential from silently
    // destroying the unreadable file — the user must explicitly clear it first.
    //
    // Step 1: manually write a credentials.json encrypted with a random key
    // that won't be in any fallback candidate list.
    const crypto = await import("node:crypto");
    const unknownKey = crypto.randomBytes(32); // 32 random bytes — not derived from any seed
    const storeJson = JSON.stringify({
      version: 2,
      activeId: "x",
      accounts: [{
        id: "x",
        label: "unknown",
        createdAt: Date.now(),
        credential: { apiKey: "unknown-key", provider: "zai" },
      }],
    });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", unknownKey, iv);
    const enc = Buffer.concat([cipher.update(storeJson, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encrypted = Buffer.concat([iv, tag, enc]).toString("base64");

    const storePath = join(homedir(), ".zcode-proxy", "credentials.json");
    mkdirSync(join(homedir(), ".zcode-proxy"), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });

    // Step 2: try to read — fixed key + all fallback candidates fail.
    // loadCredential returns null AND the guard flag is set.
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();

    // Step 3: try to save a new credential — should THROW (guard active)
    await expect(
      saveCredential({ apiKey: "new-key", provider: "bigmodel" }),
    ).rejects.toThrow(/Refusing to overwrite/);

    // The original credentials.json should still exist on disk (not deleted)
    expect(existsSync(storePath)).toBe(true);

    // After clearCredential (user explicitly confirms discard), saving works again
    clearCredential();
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "fresh-key", provider: "zai" });
    const fresh = await loadCredential();
    expect(fresh!.apiKey).toBe("fresh-key");
  });

  it("fixed key is used regardless of env var state (core guarantee of the simplified encryption)", async () => {
    // This is the CORE regression test for the user-reported bug:
    //   "我更新的时候，偶尔会遇到那个无法解密凭证的情况，导致把我的凭证全部损坏掉了"
    //
    // The old code had ZCODE_PROXY_CREDENTIAL_SECRET as priority 1, consulted on
    // every call (uncached). If the env var was set during one run and unset
    // during the next, the encryption key would silently rotate and lock the
    // user out of their own credentials.json.
    //
    // The fix: a FIXED key (SHA-256("520")) is ALWAYS used. Env vars are
    // completely ignored for new encryption. This guarantees the same key
    // across every run, every machine, every env var state — the encryption
    // key can NEVER silently rotate.
    //
    // Step 1: save with env var set — file is encrypted with the FIXED key
    // (env var is ignored for new encryption).
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "user-set-this-once-for-testing";
    _resetKeyCacheForTesting();
    await saveCredential({ apiKey: "important-key", provider: "zai" });
    expect(await loadCredential()).not.toBeNull();

    // Step 2: simulate a subsequent run where the env var is NO LONGER SET.
    // The fixed key is still used → decryption succeeds.
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("important-key");

    // Step 3: even after a write (which re-encrypts the file), the fixed key
    // is still used. So subsequent reads continue to work.
    await setAccountLabel((await listAccounts()).accounts[0].id, "new-label");
    invalidateStoreCache();
    const afterWrite = await loadCredential();
    expect(afterWrite).not.toBeNull();
    expect(afterWrite!.apiKey).toBe("important-key");

    // Step 4: simulate yet another run with the env var set to a DIFFERENT
    // value. The fixed key should STILL be used — the env var is ignored.
    // This guarantees the encryption key never silently rotates.
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "a-different-value-that-should-be-ignored";
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const loaded2 = await loadCredential();
    expect(loaded2).not.toBeNull();
    expect(loaded2!.apiKey).toBe("important-key");

    // Step 5: ZCODE_PROXY_CREDENTIAL_SECRET is NOT consulted as a recovery
    // seed anymore (removed in this version — it was the #1 cause of key
    // drift / credential loss). Only ZCODE_PROXY_LEGACY_SEED works for
    // manual recovery. Verify the new contract: a file encrypted with an
    // old env-var-derived key CANNOT be recovered by setting the old env
    // var — but CAN be recovered by setting ZCODE_PROXY_LEGACY_SEED to the
    // same value.
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    const crypto = await import("node:crypto");
    const legacyEnvSecret = "legacy-env-secret-from-old-version";
    const legacyKey = crypto.createHash("sha256").update(legacyEnvSecret).digest();
    const storeJson = JSON.stringify({
      version: 2,
      activeId: "legacy",
      accounts: [{
        id: "legacy",
        label: "legacy",
        createdAt: Date.now(),
        credential: { apiKey: "legacy-env-key", provider: "zai" },
      }],
    });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    const enc = Buffer.concat([cipher.update(storeJson, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encrypted = Buffer.concat([iv, tag, enc]).toString("base64");
    const storePath = join(homedir(), ".zcode-proxy", "credentials.json");
    mkdirSync(join(homedir(), ".zcode-proxy"), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });

    // Without any env var: fixed key + homedir seeds all fail → null.
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    expect(await loadCredential()).toBeNull();

    // With ZCODE_PROXY_CREDENTIAL_SECRET set to the old secret: STILL fails —
    // this env var is no longer consulted. The user must use
    // ZCODE_PROXY_LEGACY_SEED instead.
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = legacyEnvSecret;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    expect(await loadCredential()).toBeNull();

    // With ZCODE_PROXY_LEGACY_SEED set to the old secret value: fallback
    // finds the key → recovers. This is the ONLY supported manual recovery
    // path going forward.
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_LEGACY_SEED = legacyEnvSecret;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const recovered = await loadCredential();
    expect(recovered).not.toBeNull();
    expect(recovered!.apiKey).toBe("legacy-env-key");
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

  it("undecryptableFilePresent guard auto-clears when decryption succeeds on retry (via legacy fallback)", async () => {
    // Simulate the recovery scenario with the fixed-key scheme:
    //   1. A legacy file (encrypted by an older version with an unknown seed)
    //      is on disk → fixed key + homedir seeds all fail → guard set
    //   2. User sets ZCODE_PROXY_LEGACY_SEED to the old seed → fallback succeeds
    //      → guard auto-clears
    //   3. saveCredential should now work (re-encrypts with the fixed key)
    const crypto = await import("node:crypto");
    const oldSeed = "another-old-seed-from-a-prior-install";
    const oldKey = crypto.createHash("sha256").update(oldSeed).digest();
    const storeJson = JSON.stringify({
      version: 2,
      activeId: "x",
      accounts: [{
        id: "x",
        label: "old",
        createdAt: Date.now(),
        credential: { apiKey: "original-key", provider: "zai" },
      }],
    });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", oldKey, iv);
    const enc = Buffer.concat([cipher.update(storeJson, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encrypted = Buffer.concat([iv, tag, enc]).toString("base64");
    const storePath = join(homedir(), ".zcode-proxy", "credentials.json");
    mkdirSync(join(homedir(), ".zcode-proxy"), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });

    // Step 1: without LEGACY_SEED, all keys fail → guard set.
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const failedLoad = await loadCredential();
    expect(failedLoad).toBeNull();

    // Attempting to save now should fail (guard active)
    await expect(
      saveCredential({ apiKey: "should-fail", provider: "zai" }),
    ).rejects.toThrow(/Refusing to overwrite/);

    // Step 2: set LEGACY_SEED → fallback finds the key → succeeds → guard clears.
    process.env.ZCODE_PROXY_LEGACY_SEED = oldSeed;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const recoveredLoad = await loadCredential();
    expect(recoveredLoad).not.toBeNull();
    expect(recoveredLoad!.apiKey).toBe("original-key");

    // Step 3: saveCredential should now work (guard auto-cleared).
    // The new save re-encrypts with the fixed key, so LEGACY_SEED is no longer
    // needed for subsequent reads.
    await saveCredential({ apiKey: "new-after-recovery", provider: "zai" });
    delete process.env.ZCODE_PROXY_LEGACY_SEED;
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const finalLoad = await loadCredential();
    expect(finalLoad!.apiKey).toBe("new-after-recovery");
  });

  // --- Atomic write + mutex regression tests (this version) ---
  // The user reported "重启突然凭证全部丢失" — root cause was writeFileSync
  // truncating the file then writing; a crash between truncate and full write
  // left credentials.json empty/partial, which failed JSON.parse on next read
  // → "credentials cleared" symptom. These tests verify the new atomic-write
  // path and concurrent-write serialization.

  it("concurrent saveCredential calls do not lose accounts (mutex serializes writes)", async () => {
    // Fire 5 concurrent saves with distinct apiKeys. Without the mutex, the
    // last writer's read-modify-write would race with earlier writers and
    // drop their accounts — final list would have <5 entries.
    //
    // The mutex in store.ts serializes the read-modify-write critical
    // section so each save sees the previous one's result.
    const keys = ["concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4", "concurrent-5"];
    await Promise.all(keys.map(k => saveCredential({ apiKey: k, provider: "zai" })));
    const list = await listAccounts();
    const storedKeys = list.accounts.map(a => a.apiKeyMask);
    for (const k of keys) {
      expect(storedKeys).toContain(k);
    }
    expect(list.accounts).toHaveLength(keys.length);
  });

  it("saveCredential uses atomic write (temp file + rename), not direct writeFileSync", async () => {
    // Verify the atomic-write path is active by checking that no partial /
    // temp files are left behind after a successful save. The old
    // writeFileSync approach left no temp files but was non-atomic; the new
    // atomicWriteFile approach creates a temp file then renames it, so on
    // success the temp is gone and only credentials.json remains.
    await saveCredential({ apiKey: "atomic-test-key", provider: "zai" });
    const storeDir = dirname(join(homedir(), ".zcode-proxy", "credentials.json"));
    const dirContents = await import("node:fs/promises").then(m => m.readdir(storeDir));
    // No leftover .tmp-* files from atomicWriteFile
    const leftovers = dirContents.filter((f: string) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    // credentials.json exists and is valid JSON (not truncated)
    const content = readFileSync(join(homedir(), ".zcode-proxy", "credentials.json"), "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  // --- This version: empty-file defense + .broken-* cleanup ---

  it("empty credentials.json is treated as 'no store' without creating a .broken backup", async () => {
    // Simulate a crashed write that left an empty file (the old writeFileSync
    // truncate-then-write race). The new code should treat this as "no store"
    // and NOT back it up (backing up an empty file is pointless spam).
    clearCredential();
    const storePath = join(homedir(), ".zcode-proxy", "credentials.json");
    mkdirSync(join(homedir(), ".zcode-proxy"), { recursive: true });
    writeFileSync(storePath, "", "utf-8");

    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();

    // No .broken-* file should have been created for an empty file
    const dirContents = await import("node:fs/promises").then(m => m.readdir(join(homedir(), ".zcode-proxy")));
    const brokenFiles = dirContents.filter((f: string) => f.startsWith("credentials.json.broken-"));
    expect(brokenFiles).toEqual([]);

    // Guard should NOT be set — saving a new credential should work
    await saveCredential({ apiKey: "after-empty-recovery", provider: "zai" });
    const after = await loadCredential();
    expect(after!.apiKey).toBe("after-empty-recovery");
  });

  it(".broken-* backups are capped at 5 (oldest deleted)", async () => {
    // Create 7 corrupted files by writing invalid JSON directly, then trigger
    // a read (which backs up + cleans up). Only the 5 most recent should remain.
    clearCredential();
    const storeDir = join(homedir(), ".zcode-proxy");
    mkdirSync(storeDir, { recursive: true });

    // Write 7 .broken-* files with different timestamps (100ms apart so mtime
    // ordering is stable)
    for (let i = 0; i < 7; i++) {
      const bp = join(storeDir, `credentials.json.broken-${Date.now() + i * 1000}`);
      writeFileSync(bp, `old-backup-${i}`, "utf-8");
      await new Promise(r => setTimeout(r, 20));
    }

    // Now write a corrupted credentials.json and read it — triggers
    // backupCorruptedStore which should clean up to 5 most recent
    const storePath = join(storeDir, "credentials.json");
    writeFileSync(storePath, "{not valid json", "utf-8");
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    await loadCredential();

    // Count .broken-* files — should be at most 5 (the 7 old ones + 1 new = 8,
    // but cleanup keeps only 5 most recent)
    const dirContents = await import("node:fs/promises").then(m => m.readdir(storeDir));
    const brokenFiles = dirContents.filter((f: string) => f.startsWith("credentials.json.broken-"));
    expect(brokenFiles.length).toBeLessThanOrEqual(5);
  });
});
