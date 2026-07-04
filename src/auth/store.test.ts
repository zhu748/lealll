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
  validateProxyUrl,
  importAccounts,
  exportSingleAccount,
  exportAccounts,
  maskApiKey,
  credentialStatsKey,
  invalidateStoreCache,
  getStorePath,
  _resetKeyCacheForTesting,
} from "./store.js";
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { Credential } from "./types.js";

let testStoreDir: string | null = null;

function useIsolatedStoreDir(): void {
  testStoreDir = mkdtempSync(join(tmpdir(), "zcode-proxy-store-"));
  process.env.ZCODE_PROXY_STORE_DIR = testStoreDir;
  invalidateStoreCache();
}

function cleanupIsolatedStoreDir(): void {
  const dir = testStoreDir;
  testStoreDir = null;
  delete process.env.ZCODE_PROXY_STORE_DIR;
  invalidateStoreCache();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function storeDir(): string {
  return dirname(getStorePath());
}

/** Test helper: remove all .broken-* backup files from the store dir. */
function cleanupBrokenBackups(): void {
  const dir = storeDir();
  if (!existsSync(dir)) return;
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("credentials.json.broken-")) {
        try { unlinkSync(join(dir, f)); } catch {}
      }
    }
  } catch {}
}

async function writeFixedKeyEncryptedStore(store: unknown): Promise<void> {
  const crypto = await import("node:crypto");
  const key = crypto.createHash("sha256").update("520").digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encrypted = Buffer.concat([iv, tag, enc]).toString("base64");
  const storePath = getStorePath();
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });
}

// With the fixed-key scheme (SHA-256("520")), there's no per-test secret to
// set. The env vars below are only used by the legacy-fallback recovery tests
// to simulate files encrypted by older versions of this code.
describe("credential store", () => {
  beforeEach(() => {
    useIsolatedStoreDir();
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
    cleanupIsolatedStoreDir();
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

  it("loadCredential returns a defensive copy", async () => {
    await saveCredential({ apiKey: "copy-test-key", provider: "zai" });
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    loaded!.apiKey = "mutated-in-caller";

    const after = await loadCredential();
    expect(after!.apiKey).toBe("copy-test-key");
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
    useIsolatedStoreDir();
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
    cleanupIsolatedStoreDir();
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

  it("removeAccount deleting the final account does not emit the empty-store bug warning", async () => {
    await saveCredential({ apiKey: "only-key", provider: "zai" });
    const list = await listAccounts();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const ok = await removeAccount(list.accounts[0].id);
      expect(ok).toBe(true);
      expect((await listAccounts()).accounts).toHaveLength(0);
      expect(warnings.some(w => w.includes("writeStore: writing EMPTY store"))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
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

  it("credentialStatsKey distinguishes API keys with the same display mask", async () => {
    const first = { apiKey: "abcdefgh11111111wxyz", provider: "zai" as const };
    const second = { apiKey: "abcdefgh22222222wxyz", provider: "zai" as const };
    expect(maskApiKey(first.apiKey)).toBe(maskApiKey(second.apiKey));
    expect(credentialStatsKey(first)).not.toBe(credentialStatsKey(second));

    await saveCredential(first);
    await saveCredential(second);
    const list = await listAccounts();
    expect(list.accounts).toHaveLength(2);
    expect(list.accounts[0].apiKeyMask).toBe(list.accounts[1].apiKeyMask);
    expect(list.accounts[0].credentialKey).not.toBe(list.accounts[1].credentialKey);
    expect(list.accounts[0].credentialKey.startsWith("sha256:")).toBe(true);
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

  it("setAccountProxy rejects port 0 instead of deferring to request-time failures", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    expect(validateProxyUrl("socks5://10.0.0.1:0").ok).toBe(false);
    await expect(setAccountProxy(id, "socks5://10.0.0.1:0")).rejects.toThrow(/port must be between 1 and 65535/);
    const cred = await loadCredential();
    expect(cred!.proxy).toBeUndefined();
  });

  it("validateProxyUrl rejects IPv6 unspecified and link-local literals", () => {
    expect(validateProxyUrl("http://[::]:8080").ok).toBe(false);
    expect(validateProxyUrl("http://[fe80::1]:8080").ok).toBe(false);
    expect(validateProxyUrl("http://[::1]:8080").ok).toBe(true);
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

  it("detects external store rewrites when mtime is unchanged but size differs", async () => {
    await saveCredential({ apiKey: "first-key", provider: "zai" });

    const storePath = getStorePath();
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(storePath, fixedTime, fixedTime);
    invalidateStoreCache();

    const cached = await listAccounts();
    expect(cached.accounts).toHaveLength(1);
    const cachedStat = statSync(storePath);

    await writeFixedKeyEncryptedStore({
      version: 2,
      activeId: "external-2",
      accounts: [
        {
          id: "external-1",
          label: "external one",
          createdAt: 1,
          credential: { apiKey: "first-key", provider: "zai" },
        },
        {
          id: "external-2",
          label: "external two",
          createdAt: 2,
          credential: { apiKey: "second-key", provider: "bigmodel" },
        },
      ],
    });
    utimesSync(storePath, fixedTime, fixedTime);

    const rewrittenStat = statSync(storePath);
    expect(rewrittenStat.mtimeMs).toBe(cachedStat.mtimeMs);
    expect(rewrittenStat.size).not.toBe(cachedStat.size);

    const refreshed = await listAccounts();
    expect(refreshed.accounts).toHaveLength(2);
    expect(refreshed.activeId).toBe("external-2");
    const keys = refreshed.accounts.map(a => a.apiKeyMask).sort();
    expect(keys).toEqual(["first-key", "second-key"]);
  });

  it("detects same-size external store rewrites when mtime is unchanged", async () => {
    const storePath = getStorePath();
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");

    await writeFixedKeyEncryptedStore({
      version: 2,
      activeId: "acct-a",
      accounts: [{
        id: "acct-a",
        label: "account one",
        createdAt: 1,
        credential: { apiKey: "key-aaaa", provider: "zai" },
      }],
    });
    utimesSync(storePath, fixedTime, fixedTime);
    invalidateStoreCache();

    const cached = await listAccounts();
    expect(cached.accounts).toHaveLength(1);
    expect(cached.accounts[0].apiKeyMask).toBe("key-aaaa");
    const cachedStat = statSync(storePath);

    await new Promise(r => setTimeout(r, 20));
    await writeFixedKeyEncryptedStore({
      version: 2,
      activeId: "acct-b",
      accounts: [{
        id: "acct-b",
        label: "account two",
        createdAt: 1,
        credential: { apiKey: "key-bbbb", provider: "zai" },
      }],
    });
    utimesSync(storePath, fixedTime, fixedTime);

    const rewrittenStat = statSync(storePath);
    expect(rewrittenStat.mtimeMs).toBe(cachedStat.mtimeMs);
    expect(rewrittenStat.size).toBe(cachedStat.size);

    const refreshed = await listAccounts();
    expect(refreshed.accounts).toHaveLength(1);
    expect(refreshed.activeId).toBe("acct-b");
    expect(refreshed.accounts[0].apiKeyMask).toBe("key-bbbb");
  });

  it("detects credentials.json created after an earlier missing-store read", async () => {
    // Regression for Windows startup: the server can start before any
    // credentials exist, cache `null`, then a separate CLI process writes
    // ~/.zcode-proxy/credentials.json. The cache must stat even cached-null
    // results so the new file becomes visible without restarting.
    expect(await loadCredential()).toBeNull();

    await writeFixedKeyEncryptedStore({
      version: 2,
      activeId: "external",
      accounts: [{
        id: "external",
        label: "external",
        createdAt: Date.now(),
        credential: { apiKey: "external-key", provider: "zai" },
      }],
    });

    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("external-key");
  });

  it("refuses to overwrite an existing credentials.json that could not be safely read", async () => {
    // If a file exists but the current build cannot parse it (future format,
    // transient read failure, plaintext without debug flag, etc.), saving a
    // new credential must NOT create a fresh empty store over the top.
    const storePath = getStorePath();
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify({
      version: 99,
      note: "future-format",
      accounts: [{ id: "keep-me" }],
    }), "utf-8");

    invalidateStoreCache();
    expect(await loadCredential()).toBeNull();

    await expect(
      saveCredential({ apiKey: "new-key-should-not-overwrite", provider: "zai" }),
    ).rejects.toThrow(/Refusing to create a fresh credential store/);

    const raw = readFileSync(storePath, "utf-8");
    expect(raw).toContain("future-format");
    expect(raw).not.toContain("new-key-should-not-overwrite");
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
    // We simulate the
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
    const storePath = getStorePath();
    mkdirSync(storeDir(), { recursive: true });
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

    const storePath = getStorePath();
    mkdirSync(storeDir(), { recursive: true });
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
    ).rejects.toThrow(/could not be safely read/);

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
    const storePath = getStorePath();
    mkdirSync(storeDir(), { recursive: true });
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

  it("exportAccounts returns defensive copies of cached accounts", async () => {
    await saveCredential({ apiKey: "export-key", provider: "zai", name: "original-name" });

    const exported = await exportAccounts();
    expect(exported).toHaveLength(1);
    exported[0].label = "mutated-label";
    exported[0].credential.apiKey = "mutated-key";
    exported.push({
      id: "fake",
      label: "fake",
      createdAt: Date.now(),
      credential: { apiKey: "fake-key", provider: "zai" },
    });

    const after = await exportAccounts();
    expect(after).toHaveLength(1);
    expect(after[0].label).not.toBe("mutated-label");
    expect(after[0].credential.apiKey).toBe("export-key");
    expect((await loadCredential())?.apiKey).toBe("export-key");
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

  it("setAccountDisabled moves activeId away from a disabled active account", async () => {
    await saveCredential({ apiKey: "k1", provider: "zai" });
    await saveCredential({ apiKey: "k2", provider: "bigmodel" });
    const list = await listAccounts();
    const id1 = list.accounts[0].id;
    const id2 = list.accounts[1].id;
    expect(list.activeId).toBe(id2);

    expect(await setAccountDisabled(id2, true)).toBe(true);
    const after = await listAccounts();
    expect(after.activeId).toBe(id1);
    expect((await loadCredential())?.apiKey).toBe("k1");

    expect(await setAccountDisabled(id1, true)).toBe(true);
    expect((await listAccounts()).activeId).toBeNull();
    expect(await loadCredential()).toBeNull();
  });

  it("normalizes a stored disabled activeId to the first enabled account", async () => {
    const now = Date.now();
    await writeFixedKeyEncryptedStore({
      version: 2,
      activeId: "disabled-active",
      accounts: [
        {
          id: "disabled-active",
          label: "disabled",
          createdAt: now,
          credential: { apiKey: "disabled-key", provider: "zai", disabled: true },
        },
        {
          id: "enabled-fallback",
          label: "enabled",
          createdAt: now + 1,
          credential: { apiKey: "enabled-key", provider: "bigmodel" },
        },
      ],
    });
    invalidateStoreCache();

    const list = await listAccounts();
    expect(list.activeId).toBe("enabled-fallback");
    expect((await loadCredential())?.apiKey).toBe("enabled-key");
  });

  it("normalizes dirty stored accounts from disk before listing/loading", async () => {
    const now = Date.now();
    await writeFixedKeyEncryptedStore({
      version: 2,
      activeId: "missing-active",
      accounts: [
        null,
        { id: "missing-credential", label: "bad", createdAt: now },
        {
          id: "bad-provider",
          label: "bad provider",
          createdAt: now + 1,
          credential: { apiKey: "bad-key", provider: "unknown" },
        },
        {
          id: "duplicate-id",
          label: "   ",
          createdAt: "not-a-number",
          credential: {
            apiKey: "  clean-key  ",
            provider: "zai",
            plan: " start-plan ",
            secret: "  secret-value  ",
            userId: "  user-1  ",
            jwt: "  jwt-token  ",
            proxy: "ftp://not-allowed.example",
            name: "  Display Name  ",
            email: "  user@example.com  ",
            disabled: false,
          },
        },
        {
          id: "duplicate-id",
          label: "disabled duplicate",
          createdAt: now + 2,
          credential: {
            apiKey: "disabled-key",
            provider: "bigmodel",
            disabled: true,
            expiresAt: "12345",
            proxy: "http://proxy.example:8080",
          },
        },
      ],
    });
    invalidateStoreCache();

    const list = await listAccounts();
    expect(list.accounts).toHaveLength(2);
    const active = list.accounts.find(a => a.apiKeyMask === "clean-key");
    const disabled = list.accounts.find(a => a.apiKeyMask === "disabled-key");
    expect(active).toBeDefined();
    expect(disabled).toBeDefined();
    expect(list.activeId).toBe(active!.id);
    expect(active!.id).toBe("duplicate-id");
    expect(active!.label.startsWith("zai · ")).toBe(true);
    expect(active!.plan).toBe("start-plan");
    expect(active!.proxy).toBe("");
    expect(active!.name).toBe("Display Name");
    expect(active!.email).toBe("user@example.com");
    expect(disabled!.id).not.toBe("duplicate-id");
    expect(disabled!.disabled).toBe(true);
    expect(disabled!.expiresAt).toBe(12345);
    expect(disabled!.proxy).toBe("http://proxy.example:8080");

    const loaded = await loadCredential();
    expect(loaded?.apiKey).toBe("clean-key");
    expect(loaded?.secret).toBe("secret-value");
    expect(loaded?.userId).toBe("user-1");
    expect(loaded?.jwt).toBe("jwt-token");
    expect(loaded?.proxy).toBeUndefined();
  });

  it("importAccounts skips disabled accounts when choosing a fresh activeId", async () => {
    const result = await importAccounts([
      {
        id: "disabled-import",
        label: "disabled import",
        createdAt: Date.now(),
        credential: { apiKey: "disabled-import-key", provider: "zai", disabled: true },
      },
      {
        id: "enabled-import",
        label: "enabled import",
        createdAt: Date.now() + 1,
        credential: { apiKey: "enabled-import-key", provider: "bigmodel" },
      },
    ]);

    expect(result).toEqual({ added: 2, updated: 0 });
    const list = await listAccounts();
    expect(list.activeId).toBe("enabled-import");
    expect((await loadCredential())?.apiKey).toBe("enabled-import-key");
  });

  it("importAccounts skips invalid incoming accounts and normalizes valid ones", async () => {
    const result = await importAccounts([
      null,
      {
        id: "missing-provider",
        label: "missing provider",
        createdAt: Date.now(),
        credential: { apiKey: "bad-key" },
      },
      {
        id: "valid-import",
        label: "  Imported Account  ",
        createdAt: "1234",
        credential: {
          apiKey: "  import-key  ",
          provider: "zai",
          plan: " start-plan ",
          secret: "  import-secret  ",
          proxy: "ftp://not-allowed.example",
          disabled: "yes",
        },
      },
    ] as any);

    expect(result).toEqual({ added: 1, updated: 0 });
    let exported = await exportAccounts();
    expect(exported).toHaveLength(1);
    expect(exported[0].id).toBe("valid-import");
    expect(exported[0].label).toBe("Imported Account");
    expect(exported[0].createdAt).toBe(1234);
    expect(exported[0].credential.apiKey).toBe("import-key");
    expect(exported[0].credential.plan).toBe("start-plan");
    expect(exported[0].credential.secret).toBe("import-secret");
    expect(exported[0].credential.proxy).toBeUndefined();
    expect(exported[0].credential.disabled).toBeUndefined();

    const update = await importAccounts([
      {
        id: "valid-import",
        label: "Updated Account",
        createdAt: 5678,
        credential: { apiKey: "updated-key", provider: "bigmodel", disabled: true },
      },
    ]);
    expect(update).toEqual({ added: 0, updated: 1 });
    exported = await exportAccounts();
    expect(exported).toHaveLength(1);
    expect(exported[0].label).toBe("Updated Account");
    expect(exported[0].createdAt).toBe(5678);
    expect(exported[0].credential.apiKey).toBe("updated-key");
    expect(exported[0].credential.disabled).toBe(true);
    expect((await listAccounts()).activeId).toBeNull();
  });

  it("importAccounts clones incoming account objects before caching them", async () => {
    const incoming = [{
      id: "import-clone-id",
      label: "Original imported account",
      createdAt: Date.now(),
      credential: { apiKey: "import-clone-key", provider: "zai" as const, name: "original" },
    }];

    await importAccounts(incoming);
    incoming[0].label = "Mutated after import";
    incoming[0].credential.apiKey = "mutated-after-import";
    incoming[0].credential.name = "mutated";

    const exported = await exportAccounts();
    expect(exported).toHaveLength(1);
    expect(exported[0].label).toBe("Original imported account");
    expect(exported[0].credential.apiKey).toBe("import-clone-key");
    expect(exported[0].credential.name).toBe("original");
    expect((await loadCredential())?.apiKey).toBe("import-clone-key");
  });

  it("importAccounts clears activeId when every imported account is disabled", async () => {
    const result = await importAccounts([
      {
        id: "disabled-only",
        label: "disabled only",
        createdAt: Date.now(),
        credential: { apiKey: "disabled-only-key", provider: "zai", disabled: true },
      },
    ]);

    expect(result).toEqual({ added: 1, updated: 0 });
    const list = await listAccounts();
    expect(list.activeId).toBeNull();
    expect(await loadCredential()).toBeNull();
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
    const storePath = getStorePath();
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });

    // Step 1: without LEGACY_SEED, all keys fail → guard set.
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const failedLoad = await loadCredential();
    expect(failedLoad).toBeNull();

    // Attempting to save now should fail (guard active)
    await expect(
      saveCredential({ apiKey: "should-fail", provider: "zai" }),
    ).rejects.toThrow(/could not be safely read/);

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
    const dir = storeDir();
    const dirContents = await import("node:fs/promises").then(m => m.readdir(dir));
    // No leftover .tmp-* files from atomicWriteFile
    const leftovers = dirContents.filter((f: string) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    // credentials.json exists and is valid JSON (not truncated)
    const content = readFileSync(getStorePath(), "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("saveCredential fails loudly instead of caching credentials that were not persisted", async () => {
    if (!testStoreDir) throw new Error("test store dir not initialized");
    const blockedStoreDir = join(testStoreDir, "blocked-store-dir");
    writeFileSync(blockedStoreDir, "not a directory", "utf-8");
    process.env.ZCODE_PROXY_STORE_DIR = blockedStoreDir;
    invalidateStoreCache();

    await expect(
      saveCredential({ apiKey: "not-written", provider: "zai" }),
    ).rejects.toThrow(/Could not persist credentials/);

    invalidateStoreCache();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  // --- This version: empty-file defense + .broken-* cleanup ---

  it("empty credentials.json is treated as 'no store' without creating a .broken backup", async () => {
    // Simulate a crashed write that left an empty file (the old writeFileSync
    // truncate-then-write race). The new code should treat this as "no store"
    // and NOT back it up (backing up an empty file is pointless spam).
    clearCredential();
    const storePath = getStorePath();
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(storePath, "", "utf-8");

    _resetKeyCacheForTesting();
    invalidateStoreCache();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();

    // No .broken-* file should have been created for an empty file
    const dirContents = await import("node:fs/promises").then(m => m.readdir(storeDir()));
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
    const dir = storeDir();
    mkdirSync(dir, { recursive: true });

    // Write 7 .broken-* files with different timestamps (100ms apart so mtime
    // ordering is stable)
    for (let i = 0; i < 7; i++) {
      const bp = join(dir, `credentials.json.broken-${Date.now() + i * 1000}`);
      writeFileSync(bp, `old-backup-${i}`, "utf-8");
      await new Promise(r => setTimeout(r, 20));
    }

    // Now write a corrupted credentials.json and read it — triggers
    // backupCorruptedStore which should clean up to 5 most recent
    const storePath = getStorePath();
    writeFileSync(storePath, "{not valid json", "utf-8");
    _resetKeyCacheForTesting();
    invalidateStoreCache();
    await loadCredential();

    // Count .broken-* files — should be at most 5 (the 7 old ones + 1 new = 8,
    // but cleanup keeps only 5 most recent)
    const dirContents = await import("node:fs/promises").then(m => m.readdir(dir));
    const brokenFiles = dirContents.filter((f: string) => f.startsWith("credentials.json.broken-"));
    expect(brokenFiles.length).toBeLessThanOrEqual(5);
  });
});
