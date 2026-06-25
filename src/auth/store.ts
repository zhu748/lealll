/**
 * Encrypted file-based credential store with multi-account support.
 *
 * File format (v2):
 *   { version: 2, activeId: string | null, accounts: StoredAccount[] }
 *
 * Backward compat: if the on-disk file is the original v1 format ({ encrypted: ... }),
 * it is migrated on first load (decrypted, wrapped in a single account, marked active).
 *
 * Encryption: AES-256-GCM with a FIXED key derived from SHA-256("520").
 * The same key is used on every machine, every OS, every run — so credentials.json
 * is portable across devices and never breaks due to key drift. This is a conscious
 * trade-off: we give up encryption-at-rest strength (anyone with the source code
 * can decrypt the file) in exchange for never losing user data to key-derivation
 * bugs. For a local dev tool where the credentials file lives on the user's own
 * machine, this is the right trade-off.
 *
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type { Credential } from "./types.js";

/**
 * Store directory.
 *
 * Defaults to `~/.zcode-proxy` for local desktop use (ZCode-import flow,
 * OAuth multi-account). On read-only filesystems (e.g. Render containers),
 * set `ZCODE_PROXY_STORE_DIR` to a writable path such as `/data/.zcode-proxy`
 * (persistent disk) or `/tmp/zcode-proxy/.zcode-proxy` (ephemeral).
 *
 * In `auth.mode: apikey` the store is only used by the dashboard's
 * multi-account UI — if you never use that UI, an empty/unwritable store
 * is harmless (reads return null, writes are silently no-oped by the upper
 * layer's try/catch).
 */
const STORE_DIR = process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "credentials.json");
/** Optional env var: if set, its value is used as a legacy seed for decrypt
 *  fallback (lets users recover credentials.json encrypted by an old version
 *  whose homedir/platform/arch differed from the current one). Only used in
 *  the decrypt fallback — new encryption always uses the fixed key. */
const ENV_LEGACY_SEED = "ZCODE_PROXY_LEGACY_SEED";

/**
 * In-memory cache of the decrypted store. Set to `undefined` to indicate
 * "not yet loaded" (distinct from `null` = "loaded but file doesn't exist").
 * Invalidated by every writeStore() and clearCredential() call so callers
 * always see fresh data after a mutation.
 */
let cachedStore: StoreV2 | null | undefined = undefined;

/**
 * Guard flag set by readStoreUncached() when credentials.json exists on disk
 * but cannot be decrypted (wrong key, corrupt ciphertext, etc.).
 *
 * While this flag is true, writeStore() REFUSES to overwrite credentials.json —
 * forcing saveCredential() to throw instead of silently destroying the user's
 * existing accounts. The flag is cleared by clearCredential() (the user must
 * explicitly confirm they want to discard the unreadable file) or by a
 * successful readStoreUncached() (the file was deleted or fixed).
 */
let undecryptableFilePresent = false;

/** One stored account record (without encryption — encryption wraps the whole file). */
export interface StoredAccount {
  /** Stable unique id (16 hex chars). */
  id: string;
  /** Human-readable label, e.g. "Z.AI · 2024-06-22 14:30". */
  label: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** The credential payload. */
  credential: Credential;
}

interface StoreV2 {
  version: 2;
  activeId: string | null;
  accounts: StoredAccount[];
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM via Node.js crypto — compatible with all platforms)
// ---------------------------------------------------------------------------

/**
 * The fixed encryption key seed. AES-256 requires a 32-byte key, so we derive
 * the actual key via SHA-256. The seed value "520" is intentionally trivial —
 * the goal is NOT cryptographic security (anyone with the source can decrypt
 * the file), but rather a stable, portable obfuscation that prevents casual
 * shoulder-surfing of plaintext credentials in `credentials.json`.
 *
 * Why a fixed key instead of per-machine key derivation:
 *   - The previous scheme derived the key from `${homedir}-${platform}-${arch}`,
 *     which broke whenever the user changed username, upgraded OS, switched
 *     32-bit↔64-bit binaries, or copied credentials.json to another machine.
 *     Each of those scenarios silently rotated the key and locked the user out
 *     of their own credentials — leading to data loss.
 *   - A fixed key eliminates that entire class of bugs. The same credentials.json
 *     file works on every machine, every OS, every Bun version, forever.
 *
 * If you ever need to change this value, ALL existing credentials.json files
 * will become unreadable (the decrypt fallback will try the old key via the
 * legacy-seed mechanism, but only if ZCODE_PROXY_LEGACY_SEED is set to "520").
 */
const FIXED_KEY_SEED = "520";

/**
 * In-memory cache of the fixed encryption key. Set once on first call to
 * avoid re-hashing on every encrypt/decrypt. Reset by `_resetKeyCacheForTesting`
 * between unit tests (harmless no-op for the fixed key — kept for backward
 * compat with test code that calls it).
 */
let cachedKey: Buffer | null = null;

/**
 * Reset the key cache. Internal — used by unit tests. With the fixed-key
 * scheme this is effectively a no-op (the cache will be repopulated with the
 * same SHA-256("520") on the next call), but it's kept so existing test code
 * that calls it between cases doesn't break.
 * @internal
 */
export function _resetKeyCacheForTesting(): void {
  cachedKey = null;
}

/**
 * SHA-256–derive a 256-bit key from a seed string. Used by the fixed-key
 * derivation and by the legacy multi-seed fallback in decrypt().
 */
function deriveSha256Key(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

/**
 * Derive the legacy XOR-fold key (zcode-api-ref / early zhipu format).
 * NOT cryptographic — kept only so users with credentials.json from the
 * open-source zcode-api-ref repo can be transparently migrated via the
 * decrypt fallback.
 */
function deriveXorFoldKey(seed: string): Buffer {
  const hash = Buffer.alloc(32);
  const seedBytes = Buffer.from(seed, "utf8");
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

/**
 * Get the encryption key. Always returns SHA-256("520") — a fixed, portable
 * key that never changes across machines, OS versions, or Bun versions.
 *
 * This eliminates the entire class of "key drift" bugs that previously caused
 * credential corruption:
 *   - homedir() resolving differently across Bun versions
 *   - USERPROFILE vs HOMEDRIVE+HOMEPATH on Windows
 *   - 32-bit vs 64-bit binary switching arch
 *   - username changes / OS reinstalls
 *   - copying credentials.json between machines
 *   - ZCODE_PROXY_CREDENTIAL_SECRET env var being set during one run and not
 *     the next (the most recent incarnation of the bug)
 *
 * The fixed key is cached after the first call. There is no env var override,
 * no key file, no seed derivation — just one constant key, everywhere, always.
 */
function getEncryptionKeyBuffer(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = deriveSha256Key(FIXED_KEY_SEED);
  return cachedKey;
}

/**
 * Build a list of candidate encryption keys to try during decrypt fallback.
 *
 * This is ONLY used when the fixed key fails to decrypt the file — i.e. the
 * file was encrypted by an OLDER version of this code that used seed-based
 * or env-var-based key derivation. Once the fallback succeeds, the file is
 * re-encrypted with the fixed key on the next writeStore() call, so the
 * fallback is a one-time migration path.
 *
 * Candidate seeds cover common version-drift scenarios:
 *   - `${home}-${plat}-${arch}`     historical seed template
 *   - `${home}-${plat}`             arch differed (32-bit vs 64-bit binary)
 *   - `${home}-${arch}`             platform differed (unlikely but cheap)
 *   - `${home}`                     old version may have only used homedir
 *   - `ZCODE_PROXY_LEGACY_SEED`     user-supplied (manual recovery)
 *   - `ZCODE_PROXY_CREDENTIAL_SECRET`  old env-var-derived key (recovery)
 *
 * For each seed we generate both SHA-256 (zhipu) and XOR-fold (zcode-api-ref)
 * derived keys, matching the historical key derivation functions.
 */
function buildCandidateKeysForDecrypt(): Array<{ label: string; key: Buffer }> {
  const home = homedir();
  const plat = process.platform;
  const arch = process.arch;

  // Collect all plausible "home path" strings that an older version might
  // have used as the seed. The variations cover:
  //   - os.homedir() result (current Bun version)
  //   - Direct env vars (old Bun 1.1 used USERPROFILE on Windows verbatim,
  //     and HOME on Unix — these may differ from homedir() in case / trailing
  //     slash / canonicalization).
  //   - Windows HOMEDRIVE+HOMEPATH fallback (some corporate Windows installs
  //     have USERPROFILE pointing to a redirected folder while HOMEDRIVE+
  //     HOMEPATH points to the canonical local path).
  const homeVariants = new Set<string>();
  homeVariants.add(home);
  const userProfile = process.env.USERPROFILE;
  if (userProfile) homeVariants.add(userProfile);
  const homeDrive = process.env.HOMEDRIVE;
  const homePath = process.env.HOMEPATH;
  if (homeDrive && homePath) homeVariants.add(`${homeDrive}${homePath}`);
  const homeEnv = process.env.HOME;
  if (homeEnv) homeVariants.add(homeEnv);

  // For each home variant, build the full seed combinations an older version
  // might have used.
  const seeds = new Set<string>();
  for (const h of homeVariants) {
    seeds.add(`${h}-${plat}-${arch}`);
    seeds.add(`${h}-${plat}`);
    seeds.add(`${h}-${arch}`);
    seeds.add(`${h}`);
  }
  // User-supplied legacy seed (manual recovery)
  const legacyEnv = process.env[ENV_LEGACY_SEED];
  if (legacyEnv) seeds.add(legacyEnv);
  // Old env-var-derived key recovery: if the file was encrypted by the
  // previous version of this code which consulted ZCODE_PROXY_CREDENTIAL_SECRET,
  // the user can set it again to recover.
  const oldEnvSecret = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  if (oldEnvSecret) seeds.add(oldEnvSecret);

  const candidates: Array<{ label: string; key: Buffer }> = [];
  for (const seed of seeds) {
    const shortSeed = seed.length > 60 ? seed.slice(0, 57) + "..." : seed;
    candidates.push({ label: `SHA-256("${shortSeed}")`, key: deriveSha256Key(seed) });
    candidates.push({ label: `XOR-fold("${shortSeed}")`, key: deriveXorFoldKey(seed) });
  }
  return candidates;
}

/**
 * Encrypt plaintext using AES-256-GCM (Node.js crypto) with the fixed key.
 * Output format: base64( IV[16] + AUTH_TAG[16] + CIPHERTEXT )
 */
async function encrypt(plaintext: string): Promise<string> {
  const key = getEncryptionKeyBuffer();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt ciphertext. Tries the fixed key first, then falls back to legacy
 * candidate keys for one-time recovery of files encrypted by older versions.
 *
 *   1. Fixed key (SHA-256("520")), Node.js crypto format (IV[16] + AUTH_TAG[16] + CIPHERTEXT).
 *      This handles ALL files encrypted by the current code — the normal path.
 *
 *   2. Fixed key in legacy WebCrypto format (IV[12] + encrypted+tag).
 *      Handles files encrypted by very old zhipu versions that used WebCrypto
 *      with the same key but a different cipher implementation.
 *
 *   3. Multi-seed fallback: iterate through ALL candidate seeds (homedir
 *      variants, ZCODE_PROXY_LEGACY_SEED, ZCODE_PROXY_CREDENTIAL_SECRET) in
 *      BOTH SHA-256 and XOR-fold derivations, in BOTH Node and WebCrypto
 *      formats. This recovers files encrypted by older versions of this code
 *      that used seed-based or env-var-based key derivation.
 *
 * On fallback success, the file is NOT re-encrypted with the fallback key.
 * Instead, the plaintext is returned to the caller (readStoreUncached), which
 * parses it into a StoreV2. The next writeStore() call will re-encrypt with
 * the fixed key — so the fallback is a one-time migration path, not a
 * permanent dependency on the old key.
 */
async function decrypt(ciphertext: string): Promise<string> {
  const data = Buffer.from(ciphertext, "base64");

  // Helper: try decrypting with a key in Node.js crypto format (IV[16] + tag[16] + ct)
  const tryNodeFormat = (key: Buffer): string | null => {
    if (data.length < 32) return null;
    try {
      const iv = data.subarray(0, 16);
      const tag = data.subarray(16, 32);
      const encrypted = data.subarray(32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
    } catch {
      return null;
    }
  };

  // Helper: try decrypting with a key in legacy WebCrypto format (IV[12] + ct+tag)
  const tryWebCryptoFormat = async (key: Buffer): Promise<string | null> => {
    try {
      const keyCopy = new Uint8Array(32);
      keyCopy.set(key);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyCopy,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );
      const iv = new Uint8Array(data.subarray(0, 12));
      const encrypted = new Uint8Array(data.subarray(12));
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        encrypted,
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  };

  // --- Try 1: fixed key, Node.js crypto format (the normal path) ---
  const fixedKey = getEncryptionKeyBuffer();
  let plaintext = tryNodeFormat(fixedKey);
  if (plaintext !== null) return plaintext;

  // --- Try 2: fixed key in legacy WebCrypto format ---
  plaintext = await tryWebCryptoFormat(fixedKey);
  if (plaintext !== null) return plaintext;

  // --- Try 3: multi-seed fallback (legacy file recovery) ---
  // Only reached if the file was encrypted by an older version with a different
  // key. We try every plausible candidate; on success, the caller will
  // re-encrypt with the fixed key on the next writeStore().
  const seen = new Set<string>([fixedKey.toString("hex")]);
  for (const { label, key } of buildCandidateKeysForDecrypt()) {
    // Skip duplicate keys (different seeds can derive the same key).
    const hex = key.toString("hex");
    if (seen.has(hex)) continue;
    seen.add(hex);

    plaintext = tryNodeFormat(key);
    if (plaintext !== null) {
      console.log(`[store] Decryption succeeded with legacy fallback key: ${label}. File will be re-encrypted with the fixed key on next save.`);
      return plaintext;
    }

    plaintext = await tryWebCryptoFormat(key);
    if (plaintext !== null) {
      console.log(`[store] Decryption succeeded with legacy fallback key (WebCrypto format): ${label}. File will be re-encrypted with the fixed key on next save.`);
      return plaintext;
    }
    void label; // label retained for future debug logging
  }

  throw new Error(
    "Failed to decrypt credential store. Tried: fixed key (Node + WebCrypto formats), " +
    "multi-seed fallback covering homedir/platform/arch variations across Bun versions " +
    "(Bun 1.1/1.2/1.3 homedir() differences, USERPROFILE vs HOMEDRIVE+HOMEPATH, etc.). " +
    "If your credentials.json was encrypted on a different machine / OS / username, " +
    "set ZCODE_PROXY_LEGACY_SEED to the old seed string (e.g. \"C:\\\\Users\\\\OldName-win32-x64\") " +
    "or ZCODE_PROXY_CREDENTIAL_SECRET to the old env var value, and retry. " +
    "As a last resort, run `zcode-proxy auth logout` to discard and re-login."
  );
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function genId(): string {
  // 16 random bytes = 128 bits = 32 hex chars. Matches UUID-style entropy.
  // 8 bytes was previously used; 16 is the modern default and removes any
  // collision concern when accounts are imported from another machine.
  return randomBytes(16).toString("hex");
}

function defaultLabel(cred: Credential, createdAt: number): string {
  const ts = new Date(createdAt).toISOString().slice(0, 16).replace("T", " ");
  return `${cred.provider} · ${ts}`;
}

/** Read raw store (migrates v1 if needed). Returns null if file doesn't exist.
 *
 * Results are cached in module memory and invalidated on every writeStore()
 * call. This avoids re-running AES-256-GCM decryption on every admin endpoint
 * invocation (9+ endpoints all call loadCredential() — that used to mean
 * 9 disk reads + 9 decrypts per dashboard refresh).
 *
 * The cache is process-local: a CLI invocation (e.g. `zcode-proxy auth login`
 * from start.bat) writes to the same credentials.json on disk, but the
 * long-running proxy process won't see the change because cachedStore is
 * still pointing at the old in-memory copy. Call invalidateStoreCache()
 * before reads that must reflect external writes (e.g. dashboard refresh).
 */
async function readStore(): Promise<StoreV2 | null> {
  if (cachedStore !== undefined) return cachedStore;
  cachedStore = await readStoreUncached();
  return cachedStore;
}

/**
 * Invalidate the in-memory store cache. Call this before any read that MUST
 * reflect external writes (e.g. another process added a credential via
 * start.bat while the proxy server was still running).
 *
 * Safe to call when the cache is already empty — it just resets the sentinel.
 * After this call, the next readStore() will re-read from disk + re-decrypt.
 */
export function invalidateStoreCache(): void {
  cachedStore = undefined;
}

/** Uncached inner implementation. Does the actual disk + decrypt work. */
async function readStoreUncached(): Promise<StoreV2 | null> {
  if (!existsSync(STORE_FILE)) {
    // File doesn't exist — clear the guard. Without this, a previous failed
    // read would leave undecryptableFilePresent=true forever, locking the user
    // out of saving new credentials even after the file was deleted externally.
    undecryptableFilePresent = false;
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(STORE_FILE, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // File exists but isn't valid JSON — back it up and start fresh.
    console.warn(`[store] credentials.json is not valid JSON. Backing up and starting fresh.`);
    backupCorruptedStore(raw);
    undecryptableFilePresent = true;
    return null;
  }

  // Both v1 and v2 wrap the actual data in an `encrypted` blob.
  // Distinguish by the presence of `version: 2` at the top level.
  if (parsed && typeof (parsed as any).encrypted === "string") {
    let json: string;
    try {
      json = await decrypt((parsed as any).encrypted);
    } catch (err) {
      // Decryption failed — most common cause is the encryption key changing
      // (different homedir / username / OS reinstall / file copied from another
      // machine, OR the binary was recompiled and homedir()/platform/arch
      // resolved differently than before).
      //
      // CRITICAL FIX (was: "back up and treat as empty"): we used to return
      // null here, which silently allowed the NEXT saveCredential() call to
      // OVERWRITE the original credentials.json with a fresh store containing
      // only the newly-added credential. The user's existing accounts were
      // preserved as a `.broken-{timestamp}` backup file but the live
      // credentials.json was clobbered — appearing as "credentials cleared"
      // after a version update.
      //
      // New behavior: back up the unreadable file (so the user can recover
      // later), set a guard flag, and return null. saveCredential() checks
      // the flag and REFUSES to overwrite — it throws so the caller surfaces
      // the error to the user instead of silently destroying data.
      console.warn(`[store] Failed to decrypt credentials.json: ${(err as Error).message}`);
      console.warn(`[store] This usually happens after changing username, reinstalling OS, or copying the file from another machine.`);
      console.warn(`[store] The unreadable file has been backed up. The store will be treated as empty for reads, but saveCredential() will refuse to overwrite until you explicitly clear it (zcode-proxy auth logout) — this prevents accidental data loss.`);
      backupCorruptedStore(raw);
      undecryptableFilePresent = true;
      return null;
    }

    if ((parsed as any).version === 2) {
      // v2: encrypted blob is the StoreV2 JSON
      // Decryption succeeded — clear the guard so future writes are allowed.
      // Without this, a user who recovers via ZCODE_PROXY_LEGACY_SEED would
      // be able to READ but not WRITE (the guard from the initial failed read
      // would persist forever, locking them out of saving any changes).
      undecryptableFilePresent = false;
      return JSON.parse(json) as StoreV2;
    }

    // v1: encrypted blob is a single Credential — migrate to a single-account store.
    // IMPORTANT: persist the migrated v2 form back to disk immediately. Without
    // this, every readStore() call generates a NEW random id for the migrated
    // account, so setAccountPlan(id) called after listAccounts(id) would never
    // find the account (different id on the second read).
    const cred = JSON.parse(json) as Credential;
    const account: StoredAccount = {
      id: genId(),
      label: defaultLabel(cred, Date.now()),
      createdAt: Date.now(),
      credential: cred,
    };
    const migrated: StoreV2 = { version: 2, activeId: account.id, accounts: [account] };
    try {
      await writeStore(migrated);
      console.log(`[store] Migrated v1 credential store to v2 format on disk.`);
    } catch (e) {
      // If write fails (e.g. read-only fs), at least return the in-memory copy
      // so the current request can proceed. Next read will re-migrate.
      console.warn(`[store] Could not persist v1→v2 migration: ${(e as Error).message}`);
    }
    return migrated;
  }

  // Plaintext v2 backdoor.
  //
  // SECURITY: only allowed when ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1 is set.
  // Without this gate, any process that can write ~/.zcode-proxy/credentials.json
  // can inject plaintext credentials and bypass AES-256-GCM entirely — defeating
  // the encryption-at-rest guarantee. Tests should set this env var explicitly
  // (or use a temp HOME + ZCODE_PROXY_CREDENTIAL_SECRET).
  if (process.env.ZCODE_PROXY_ALLOW_PLAINTEXT_STORE === "1"
      && parsed && (parsed as any).version === 2 && Array.isArray((parsed as any).accounts)) {
    return parsed as StoreV2;
  }

  // Plaintext file present but env not set — refuse to load and warn.
  if (parsed && (parsed as any).version === 2 && Array.isArray((parsed as any).accounts)) {
    console.warn("[store] Refusing to load plaintext credentials.json without ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1.");
    console.warn("[store] Either delete the file and re-login, or set the env var (test/debug only).");
    return null;
  }

  return null;
}

/**
 * Back up a corrupted / unreadable credentials.json before it gets overwritten.
 * Writes to `{STORE_FILE}.broken-{timestamp}` so the user can still recover
 * the original content if needed (e.g. they later remember the old username).
 */
function backupCorruptedStore(originalContent: string): void {
  const backupPath = `${STORE_FILE}.broken-${Date.now()}`;
  try {
    writeFileSync(backupPath, originalContent, "utf-8");
    console.warn(`[store] Unreadable store backed up to: ${backupPath}`);
  } catch {
    // Can't even write a backup — nothing more we can do; the next writeStore()
    // call will still overwrite the broken file with a fresh one.
  }
}

async function writeStore(store: StoreV2): Promise<void> {
  // Guard against the "silent overwrite" footgun: if a previous read found
  // credentials.json on disk but couldn't decrypt it (e.g. encryption key
  // changed after a binary update), the original file is preserved as a
  // `.broken-{timestamp}` backup. We MUST NOT overwrite credentials.json
  // with a fresh store here — that would clobber the only reference to the
  // user's existing accounts and force them to manually find+rename the
  // backup file.
  //
  // Instead, throw so the caller (saveCredential / setAccountLabel / etc.)
  // surfaces the error to the user. The user can then either:
  //   1. Restore the .broken-{timestamp} backup (rename it back to
  //      credentials.json) and figure out why decryption failed, OR
  //   2. Explicitly run `zcode-proxy auth logout` (or call clearCredential())
  //      to remove the unreadable file, after which new saves will work.
  if (undecryptableFilePresent) {
    throw new Error(
      `Refusing to overwrite ${STORE_FILE}: the existing file could not be ` +
      `decrypted (likely the encryption key changed after a binary update). ` +
      `A backup was saved as ${STORE_FILE}.broken-{timestamp}. ` +
      `Either restore that backup manually, or run \`zcode-proxy auth logout\` ` +
      `to discard the unreadable file before saving new credentials.`,
    );
  }
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    const json = JSON.stringify(store);
    const encrypted = await encrypt(json);
    writeFileSync(STORE_FILE, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });
  } catch (err) {
    // Read-only filesystem (e.g. Render container without a persistent disk
    // mounted at STORE_DIR). Don't crash the process — just log and keep the
    // in-memory copy so the current request can still complete. The next
    // restart will start with an empty store anyway.
    console.warn(`[store] Could not persist credentials to ${STORE_FILE}: ${(err as Error).message}`);
    console.warn(`[store] Set ZCODE_PROXY_STORE_DIR to a writable path (e.g. /data/.zcode-proxy on Render with a disk, or /tmp/.zcode-proxy for ephemeral storage).`);
  }
  cachedStore = store; // keep cache in sync with what we intended to write
}

// ---------------------------------------------------------------------------
// Public API — backward-compatible single-credential functions
// ---------------------------------------------------------------------------

/**
 * Save a credential. If an account with the same `provider + apiKey` exists,
 * it's updated in place (preserving activeId); otherwise a new account is
 * created.
 *
 * @param opts.keepActive — when true, the new account is appended WITHOUT
 *   becoming the active one. The existing activeId is preserved. Used by
 *   the OAuth flow so logging in via the dashboard doesn't silently swap
 *   the user's active credential out from under them. Default: false
 *   (preserves historical behavior used by `auth login` CLI and the
 *   "Add API Key" form).
 */
export async function saveCredential(cred: Credential, opts?: { keepActive?: boolean }): Promise<void> {
  let store = await readStore();
  if (!store) store = { version: 2, activeId: null, accounts: [] };

  const existingIdx = store.accounts.findIndex(
    a => a.credential.provider === cred.provider && a.credential.apiKey === cred.apiKey,
  );

  if (existingIdx >= 0) {
    // Update existing — preserve id, createdAt; refresh label if it looks auto-generated
    const old = store.accounts[existingIdx];
    store.accounts[existingIdx] = {
      ...old,
      credential: cred,
      label: old.label.startsWith(`${cred.provider} · `) ? defaultLabel(cred, old.createdAt) : old.label,
    };
  } else {
    const account: StoredAccount = {
      id: genId(),
      label: defaultLabel(cred, Date.now()),
      createdAt: Date.now(),
      credential: cred,
    };
    store.accounts.push(account);
    // BUGFIX: previously always `store.activeId = account.id`, which silently
    // swapped the user's active credential out from under them whenever they
    // logged in via OAuth. Now we honor opts.keepActive so the dashboard's
    // OAuth flow preserves the user's currently-selected account — the new
    // account is added to the list but the user must explicitly click
    // "Activate" to switch to it.
    if (!opts?.keepActive || !store.activeId) {
      store.activeId = account.id; // newly added becomes active
    }
  }

  await writeStore(store);
}

/** Load the currently active credential. Returns null if none. */
export async function loadCredential(): Promise<Credential | null> {
  const store = await readStore();
  if (!store || !store.activeId) return null;
  const account = store.accounts.find(a => a.id === store.activeId);
  return account?.credential ?? null;
}

/** Clear ALL stored credentials (preserves old behavior — used by "Clear Credentials" button). */
export function clearCredential(): void {
  if (existsSync(STORE_FILE)) {
    unlinkSync(STORE_FILE);
  }
  cachedStore = null; // invalidate store cache
  cachedKey = null;   // invalidate key cache (will be repopulated with the same fixed key)
  // Clear the guard flag — once the user has explicitly cleared credentials,
  // they're free to save new ones without the "refusing to overwrite" error.
  undecryptableFilePresent = false;
}

export function getStorePath(): string {
  return STORE_FILE;
}

// ---------------------------------------------------------------------------
// Public API — multi-account management
// ---------------------------------------------------------------------------

/** Mask a credential's API key for display: "abc12345...wxyz". */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 12) return apiKey;
  return apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
}

/** List all stored accounts (without exposing secret material — apiKey is masked).
 *
 * Accounts are returned sorted by `createdAt` ascending (oldest first),
 * matching the user's expectation that the account list reflects the order
 * in which credentials were added. vceshi0.0.4+.
 */
export async function listAccounts(): Promise<{
  accounts: Array<Omit<StoredAccount, "credential"> & {
    provider: string;
    apiKeyMask: string;
    hasSecret: boolean;
    userId?: string;
    expiresAt?: number;
    hasJwt: boolean;
    plan: string;
    /** Outbound HTTP proxy URL configured for this account (empty string if none). */
    proxy: string;
    /** Human-readable name (vceshi0.0.4+). Empty string when not set — the
     *  dashboard should fall back to `label` for display in that case. */
    name: string;
    /** OAuth account email (vceshi0.0.4+). Empty string for ZCode imports
     *  and manually-added API keys (no email available in those flows). */
    email: string;
    /** Disabled flag (vceshi0.0.6+). True = excluded from auto-switch +
     *  manual activation. Default false. */
    disabled: boolean;
  }>;
  activeId: string | null;
}> {
  const store = await readStore();
  if (!store) return { accounts: [], activeId: null };
  // Sort by createdAt ascending (oldest first). Array.prototype.sort is stable
  // in modern V8/Bun, so accounts with identical createdAt keep insertion order.
  const sortedAccounts = [...store.accounts].sort((a, b) => a.createdAt - b.createdAt);
  return {
    activeId: store.activeId,
    accounts: sortedAccounts.map(a => ({
      id: a.id,
      label: a.label,
      createdAt: a.createdAt,
      provider: a.credential.provider,
      apiKeyMask: maskApiKey(a.credential.apiKey),
      hasSecret: !!a.credential.secret,
      userId: a.credential.userId,
      expiresAt: a.credential.expiresAt,
      hasJwt: !!a.credential.jwt,
      // Display plan: explicit field wins; otherwise infer from JWT presence
      // (v1 credentials from zcode-api-ref have no plan field but carry a
      // start-plan JWT). Falls back to coding-plan only when neither signal
      // is present. This keeps the dashboard dropdown in sync with what
      // serve() will actually do at startup.
      plan: inferPlan(a.credential),
      // Per-account outbound proxy (v2.1.4.1test5+). Empty string means
      // direct connection — surfaced as "" rather than undefined so the
      // dashboard can always render the input with the current value.
      proxy: a.credential.proxy ?? "",
      // vceshi0.0.4+: expose name/email for display + editing. Empty string
      // (not undefined) so the dashboard can always render the input with
      // the current value, mirroring the `proxy` field convention.
      name: a.credential.name ?? "",
      email: a.credential.email ?? "",
      // vceshi0.0.6+: expose disabled flag for the dashboard toggle.
      disabled: !!a.credential.disabled,
    })),
  };
}

/**
 * Resolve a credential's plan for display/serving purposes.
 *   1. Explicit cred.plan wins (v0.1.4+ imports, dashboard edits)
 *   2. JWT presence → start-plan (v1 zcode-api-ref credentials)
 *   3. Default coding-plan
 */
function inferPlan(cred: Credential): "coding-plan" | "start-plan" {
  if (cred.plan === "start-plan" || cred.plan === "coding-plan") return cred.plan;
  if (cred.jwt) return "start-plan";
  return "coding-plan";
}

/** Switch the active credential by account id.
 * Returns false if the account doesn't exist OR is disabled (vceshi0.0.6+).
 * Callers should distinguish these cases by checking the disabled flag in the
 * listAccounts response before calling switchAccount, if they need to.
 */
export async function switchAccount(id: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const found = store.accounts.find(a => a.id === id);
  if (!found) return false;
  // vceshi0.0.6+: refuse to activate a disabled credential. The dashboard
  // should hide the "Activate" button for disabled accounts, but this is the
  // server-side enforcement.
  if (found.credential.disabled) return false;
  store.activeId = id;
  await writeStore(store);
  return true;
}

/** Remove an account by id. If the active account is removed, falls back to the first remaining. */
export async function removeAccount(id: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const idx = store.accounts.findIndex(a => a.id === id);
  if (idx < 0) return false;
  store.accounts.splice(idx, 1);
  if (store.activeId === id) {
    store.activeId = store.accounts[0]?.id ?? null;
  }
  await writeStore(store);
  return true;
}

/** Update an account's human-readable label. */
export async function setAccountLabel(id: string, label: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  account.label = label.trim() || account.label;
  await writeStore(store);
  return true;
}

/** Update an account's plan. */
export async function setAccountPlan(id: string, plan: "coding-plan" | "start-plan"): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  account.credential.plan = plan;
  await writeStore(store);
  return true;
}

/**
 * Update an account's outbound HTTP proxy URL.
 *
 * Pass an empty string (or undefined) to clear the override — the account
 * will fall back to a direct connection. No URL validation is performed
 * here; the dashboard is expected to send a syntactically valid URL
 * (`http://`, `https://`, or `socks5://` scheme). Invalid URLs surface as
 * fetch-time errors at request time, which is more useful to the user
 * than a silent rejection at config time.
 */
export async function setAccountProxy(id: string, proxy: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  const trimmed = (proxy ?? "").trim();
  if (trimmed) {
    account.credential.proxy = trimmed;
  } else {
    // Clear the field entirely so the serialized credential stays clean
    // rather than accumulating empty strings across versions.
    delete account.credential.proxy;
  }
  await writeStore(store);
  return true;
}

/**
 * Update an account's human-readable name (vceshi0.0.4+).
 *
 * Pass an empty string to clear the name — the dashboard will fall back to
 * the auto-generated `label` for display. The name shows up in the account
 * list "名称" column when set, otherwise the auto-generated label is shown.
 */
export async function setAccountName(id: string, name: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  const trimmed = (name ?? "").trim();
  if (trimmed) {
    account.credential.name = trimmed;
  } else {
    // Clear the field entirely so the serialized credential stays clean.
    delete account.credential.name;
  }
  await writeStore(store);
  return true;
}

/**
 * Update an account's email (vceshi0.0.4+).
 *
 * Pass an empty string to clear the email. No validation is performed here —
 * the dashboard may do a basic format check, but we accept any string to
 * accommodate edge cases (e.g. upstream returning a non-standard email format).
 */
export async function setAccountEmail(id: string, email: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  const trimmed = (email ?? "").trim();
  if (trimmed) {
    account.credential.email = trimmed;
  } else {
    delete account.credential.email;
  }
  await writeStore(store);
  return true;
}

/**
 * Enable or disable an account (vceshi0.0.6+).
 *
 * When disabled, the credential is:
 *   - Excluded from `switchToNextCredential` (won't be picked as fallback)
 *   - Refused by `switchAccount` (can't be manually activated)
 *
 * If the currently-active account is disabled, it remains active (so in-flight
 * requests continue) but the next auto-switch will skip it. The dashboard
 * should warn the user when disabling the active account.
 */
export async function setAccountDisabled(id: string, disabled: boolean): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  if (disabled) {
    account.credential.disabled = true;
  } else {
    delete account.credential.disabled;
  }
  await writeStore(store);
  return true;
}

/**
 * Export a single account's full credential JSON (vceshi0.0.4+).
 *
 * Returns the account metadata (id/label/createdAt) plus the FULL credential
 * (apiKey + secret + jwt + userId + plan + proxy + name + email) — suitable
 * for backup/import on another machine. Returns null if the account id is
 * not found.
 *
 * The exported JSON contains plaintext credentials — callers should treat it
 * as sensitive (don't log it, recommend the user store it securely).
 */
export async function exportSingleAccount(id: string): Promise<{
  id: string;
  label: string;
  createdAt: number;
  credential: Credential;
} | null> {
  const store = await readStore();
  if (!store) return null;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return null;
  // Return a deep copy so the caller can JSON.stringify without worrying
  // about the in-memory cache being mutated.
  return {
    id: account.id,
    label: account.label,
    createdAt: account.createdAt,
    credential: { ...account.credential },
  };
}

/** Export all accounts (excluding encryption — returns plain JSON for backup). */
export async function exportAccounts(): Promise<Array<Omit<StoredAccount, "credential"> & { credential: Credential }>> {
  const store = await readStore();
  if (!store) return [];
  return store.accounts;
}

/**
 * Export the full v2 store (activeId + accounts with credentials) as plain JSON.
 *
 * Used by the dashboard's "Export Render credentials" feature when the user has
 * multiple accounts — the entire store envelope is base64-encoded into
 * ZCODE_OAUTH_CREDENTIAL so all accounts (and the activeId pointer) survive
 * the trip to Render / Fly.io / K8s. `render-start.sh` detects this format
 * (presence of `version: 2` + `accounts` array) and writes it directly to
 * credentials.json instead of wrapping as a single-account store.
 *
 * Returns null if no store exists on disk.
 */
export async function exportStore(): Promise<StoreV2 | null> {
  const store = await readStore();
  if (!store) return null;
  // Return a deep-ish copy so callers can JSON.stringify without worrying
  // about the in-memory cache being mutated by concurrent writers.
  return {
    version: 2,
    activeId: store.activeId,
    accounts: store.accounts.map(a => ({ ...a, credential: { ...a.credential } })),
  };
}

/** Import accounts from a previously exported backup. Merges by id — existing accounts are updated, new ones are appended. */
export async function importAccounts(
  incoming: Array<Omit<StoredAccount, "credential"> & { credential: Credential }>,
): Promise<{ added: number; updated: number }> {
  let store = await readStore();
  if (!store) store = { version: 2, activeId: null, accounts: [] };

  let added = 0;
  let updated = 0;
  for (const acc of incoming) {
    const idx = store.accounts.findIndex(a => a.id === acc.id);
    if (idx >= 0) {
      store.accounts[idx] = acc;
      updated++;
    } else {
      store.accounts.push(acc);
      added++;
      if (!store.activeId) store.activeId = acc.id;
    }
  }
  await writeStore(store);
  return { added, updated };
}
