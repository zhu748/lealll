/**
 * Encrypted credential-store persistence and account mutations.
 *
 * Owns the decrypted cache, file fingerprint, migration/write guards and
 * process locks. Crypto, normalization and display helpers live in leaf
 * modules so callers can reuse them without loading persistence state.
 * Existing v1 files are migrated to the v2 multi-account envelope on read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { runtimeLog, runtimeWarn } from "../utils/log.js";
import type { Credential } from "./types.js";
import type { StoredAccount, StoreV2, AccountList } from "./store-types.js";
import { encrypt, decrypt, resetEncryptionKeyCache } from "./store-crypto.js";
import {
  cloneStoredAccount, generateAccountId, defaultAccountLabel, normalizeCredential,
  normalizeStoredAccount, normalizeStore, normalizeStoreInPlace, normalizeStoreActiveId,
} from "./store-normalization.js";
import { summarizeAccounts } from "./account-view.js";
import { validateProxyUrl } from "../utils/proxy-url.js";
// Store backoffs must survive destruction of the captcha solver's window.
import { hostSetTimeout } from "../utils/host-timers.js";

// Preserve the existing public entry points while internal users import leaves.
export type { StoredAccount } from "./store-types.js";
export { _resetKeyCacheForTesting } from "./store-crypto.js";
export { maskApiKey, credentialStatsKey } from "./account-view.js";
export { validateProxyUrl } from "../utils/proxy-url.js";

/**
 * Store directory.
 *
 * Defaults to `~/.zcode-proxy` for local desktop use (ZCode-import flow,
 * OAuth multi-account). On read-only filesystems (e.g. Render containers),
 * set `ZCODE_PROXY_STORE_DIR` to a writable path such as `/data/.zcode-proxy`
 * (persistent disk) or `/tmp/zcode-proxy/.zcode-proxy` (ephemeral).
 *
 * In `auth.mode: apikey` the store is only used by the dashboard's
 * multi-account UI. If you never use that UI, an empty store is harmless
 * (reads return null); failed writes are reported to the caller so users do
 * not mistake an in-memory-only credential for a durable save.
 */
function resolveStoreDir(): string {
  return process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy");
}

let STORE_DIR = resolveStoreDir();
let STORE_FILE = join(STORE_DIR, "credentials.json");

function refreshStorePathFromEnv(): void {
  const nextDir = resolveStoreDir();
  if (nextDir === STORE_DIR) return;
  STORE_DIR = nextDir;
  STORE_FILE = join(STORE_DIR, "credentials.json");
  cachedStore = undefined;
  cachedStoreMtimeMs = -1;
  cachedStoreCtimeMs = -1;
  cachedStoreSize = -1;
  undecryptableFilePresent = false;
  lastReadStoreNullReason = null;
}

/**
 * undefined = not loaded, null = read returned no usable store, object =
 * decrypted store. Successful writes update this cache; failed writes drop
 * it. Reads compare mtime/ctime/size to detect changes from another process.
 */
let cachedStore: StoreV2 | null | undefined = undefined;
/** mtimeMs of the on-disk credentials.json at the time cachedStore was
 *  populated. Used to detect external writes (cross-process). -1 = unknown
 *  (force re-read on next access). 0 = file didn't exist. */
let cachedStoreMtimeMs = -1;
/** ctimeMs paired with cachedStoreMtimeMs. This catches same-size rewrites
 *  where another process preserves mtime or the filesystem timestamp collides. */
let cachedStoreCtimeMs = -1;
/** File size paired with cachedStoreMtimeMs. Some filesystems have coarse
 * timestamp precision, so size helps detect rapid cross-process rewrites. */
let cachedStoreSize = -1;

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

type StoreNullReason =
  | "missing"
  | "empty"
  | "read_error"
  | "invalid_json"
  | "decrypt_failed"
  | "plaintext_disallowed"
  | "unsupported_format";

let lastReadStoreNullReason: StoreNullReason | null = null;

function markStoreNull(reason: StoreNullReason): null {
  lastReadStoreNullReason = reason;
  return null;
}

function clearStoreNullReason(): void {
  lastReadStoreNullReason = null;
}

/**
 * Read the store, using the in-memory cache when fresh. Detects external
 * writes by stat-ing the file's mtimeMs, ctimeMs, and size — if the file
 * changed on disk (e.g. `auth login` from start.bat in another process added a
 * credential), the cache is dropped and the next read goes to disk.
 *
 * The stat() call is ~50µs on Linux/macOS and ~200µs on Windows — negligible
 * compared to the JSON parse + AES-256-GCM decrypt we'd otherwise do (~1ms).
 */
async function readStore(): Promise<StoreV2 | null> {
  refreshStorePathFromEnv();
  if (cachedStore !== undefined) {
    // Cache populated — check mtime to detect external writes.
    // Even when cachedStore === null, still stat: a separate CLI process may
    // have created credentials.json after the server started with no store.
    try {
      const st = statSync(STORE_FILE);
      if (st.mtimeMs === cachedStoreMtimeMs &&
          st.ctimeMs === cachedStoreCtimeMs &&
          st.size === cachedStoreSize) {
        return cachedStore; // fresh
      }
      // mtime changed — external write. Drop cache + fall through.
      runtimeLog("[store] credentials.json fingerprint changed — external write detected, refreshing cache");
      cachedStore = undefined;
      cachedStoreMtimeMs = -1;
      cachedStoreCtimeMs = -1;
      cachedStoreSize = -1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // File was deleted externally — cache is now stale (if it claimed
        // to exist) or already correct (if it claimed null).
        if (cachedStore !== null) {
          runtimeLog("[store] credentials.json disappeared — external delete detected, refreshing cache");
          cachedStore = undefined;
          cachedStoreMtimeMs = -1;
          cachedStoreCtimeMs = -1;
          cachedStoreSize = -1;
        }
      } else {
        // EPERM/EBUSY/etc — be conservative, drop cache.
        cachedStore = undefined;
        cachedStoreMtimeMs = -1;
        cachedStoreCtimeMs = -1;
        cachedStoreSize = -1;
      }
    }
  }
  if (cachedStore !== undefined) return cachedStore;
  cachedStore = await readStoreUncached();
  // Capture mtime AFTER the successful read so subsequent reads can detect
  // external writes. If the file doesn't exist, set 0 as the "missing" marker.
  if (cachedStore === null) {
    // 0 means "confirmed missing"; -1 means "null because the file exists
    // but could not be read/parsed/decrypted". The latter must be retried
    // on the next access and must never be treated as a safe empty store.
    cachedStoreMtimeMs = lastReadStoreNullReason === "missing" ? 0 : -1;
    cachedStoreCtimeMs = lastReadStoreNullReason === "missing" ? 0 : -1;
    cachedStoreSize = lastReadStoreNullReason === "missing" ? 0 : -1;
  } else {
    try {
      const st = statSync(STORE_FILE);
      cachedStoreMtimeMs = st.mtimeMs;
      cachedStoreCtimeMs = st.ctimeMs;
      cachedStoreSize = st.size;
    } catch {
      cachedStoreMtimeMs = -1; // unknown — force re-stat next time
      cachedStoreCtimeMs = -1;
      cachedStoreSize = -1;
    }
  }
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
  refreshStorePathFromEnv();
  cachedStore = undefined;
  cachedStoreMtimeMs = -1;
  cachedStoreCtimeMs = -1;
  cachedStoreSize = -1;
}

/** Uncached inner implementation. Does the actual disk + decrypt work. */
async function readStoreUncached(): Promise<StoreV2 | null> {
  if (!existsSync(STORE_FILE)) {
    // File doesn't exist — clear the guard. Without this, a previous failed
    // read would leave undecryptableFilePresent=true forever, locking the user
    // out of saving new credentials even after the file was deleted externally.
    undecryptableFilePresent = false;
    return markStoreNull("missing");
  }

  // Read with retry — on Windows, the file can be transiently locked by
  // antivirus / Windows Search indexer / backup tools during a concurrent
  // write. A single failed read would mark the file as "corrupted" and
  // create a .broken-* backup, even though the file is perfectly fine and
  // the next read would succeed. This was a major contributor to the
  // ".broken files piling up" symptom: every dashboard refresh during a
  // brief AV scan would back up the (locked, unreadable) file.
  //
  // We retry up to 5 times with 50ms backoff before declaring the file
  // unreadable.
  //
  // === CRITICAL FIX (event-loop blocking) ===
  // Previously this used a SYNCHRONOUS busy-wait spin:
  //   `while (Date.now() < end) { /* spin */ }`
  // which blocked the entire Bun event loop for up to 50+100+150+200+250
  // = 750ms. During that window, ALL HTTP requests, SSE pushes, and
  // timers were frozen — manifesting as "管理面板刷新卡一会才能点击".
  //
  // Now we use `await new Promise(r => setTimeout(r, ms))` which yields
  // to the event loop, letting other requests proceed during the backoff.
  let raw: string | null = null;
  let readErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      raw = readFileSync(STORE_FILE, "utf-8");
      readErr = null;
      break;
    } catch (err) {
      readErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      // EPERM/EBUSY/EACCES: transient Windows lock — retry with ASYNC sleep.
      // ENOENT: file disappeared between existsSync and readFileSync (another
      // process deleted it) — retry won't help, treat as "no file".
      if (code === "ENOENT") {
        undecryptableFilePresent = false;
        return markStoreNull("missing");
      }
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        // ASYNC sleep — yields to the event loop so other requests aren't
        // blocked during the backoff window. This is the key fix for the
        // "刷新卡顿" symptom on Windows.
        await new Promise(r => hostSetTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      // Other errors (EISDIR, etc.) — don't retry
      break;
    }
  }
  if (raw === null) {
    // All retries failed OR a non-retryable error. Log the actual error code
    // so the user can diagnose (AV lock vs permission vs disk failure).
    runtimeWarn(`[store] Could not read credentials.json after retries: ${(readErr as Error)?.message ?? readErr}`);
    // Do NOT backupCorruptedStore here — we don't have content to back up,
    // and the file may just be transiently locked. Do mark the null reason
    // so callers refuse to overwrite an existing-but-unreadable store.
    return markStoreNull("read_error");
  }

  // EMPTY FILE DEFENSE: if the file is empty or whitespace-only, it was
  // almost certainly left behind by a crashed write (the old writeFileSync
  // truncated-then-write race, before atomicWriteFile was added). Backing
  // up an empty file is pointless (there's nothing to recover) and creates
  // spam .broken-* files. Instead, treat as "no store" and let the next
  // saveCredential create a fresh one. We still set the guard so a
  // concurrent save doesn't overwrite — but since the file is empty,
  // overwriting is actually fine, so we DON'T set the guard.
  if (raw.trim() === "") {
    runtimeWarn(`[store] credentials.json is empty (likely from a crashed write). Treating as no store — next save will create a fresh one.`);
    undecryptableFilePresent = false;
    return markStoreNull("empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // File exists but isn't valid JSON — this means the file was truncated
    // mid-write (old writeFileSync race, before atomicWriteFile) OR corrupted
    // by a disk error. Back up the partial content so the user can inspect
    // what survived, then start fresh.
    runtimeWarn(`[store] credentials.json is not valid JSON: ${(err as Error).message}`);
    runtimeWarn(`[store] File size: ${raw.length} bytes, first 100 chars: ${JSON.stringify(raw.slice(0, 100))}`);
    backupCorruptedStore(raw);
    undecryptableFilePresent = true;
    return markStoreNull("invalid_json");
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
      runtimeWarn(`[store] Failed to decrypt credentials.json: ${(err as Error).message}`);
      runtimeWarn(`[store] This usually happens after changing username, reinstalling OS, or copying the file from another machine.`);
      runtimeWarn(`[store] The unreadable file has been backed up. The store will be treated as empty for reads, but saveCredential() will refuse to overwrite until you explicitly clear it (zcode-proxy auth logout) — this prevents accidental data loss.`);
      backupCorruptedStore(raw);
      undecryptableFilePresent = true;
      return markStoreNull("decrypt_failed");
    }

    if ((parsed as any).version === 2) {
      // v2: encrypted blob is the StoreV2 JSON
      // Decryption succeeded — clear the guard so future writes are allowed.
      // Without this, a user who recovers via ZCODE_PROXY_LEGACY_SEED would
      // be able to READ but not WRITE (the guard from the initial failed read
      // would persist forever, locking them out of saving any changes).
      let decryptedStore: unknown;
      try {
        decryptedStore = JSON.parse(json);
      } catch (err) {
        runtimeWarn(`[store] Decrypted v2 credential store is not valid JSON: ${(err as Error).message}`);
        backupCorruptedStore(raw);
        undecryptableFilePresent = true;
        return markStoreNull("invalid_json");
      }
      const store = normalizeStore(decryptedStore);
      if (!store) {
        runtimeWarn("[store] Decrypted v2 credential store has an unsupported format.");
        return markStoreNull("unsupported_format");
      }
      undecryptableFilePresent = false;
      clearStoreNullReason();
      return store;
    }

    // v1: encrypted blob is a single Credential — migrate to a single-account store.
    // IMPORTANT: persist the migrated v2 form back to disk immediately. Without
    // this, every readStore() call generates a NEW random id for the migrated
    // account, so setAccountPlan(id) called after listAccounts(id) would never
    // find the account (different id on the second read).
    let decryptedCredential: unknown;
    try {
      decryptedCredential = JSON.parse(json);
    } catch (err) {
      runtimeWarn(`[store] Decrypted v1 credential is not valid JSON: ${(err as Error).message}`);
      backupCorruptedStore(raw);
      undecryptableFilePresent = true;
      return markStoreNull("invalid_json");
    }
    const cred = normalizeCredential(decryptedCredential);
    if (!cred) {
      runtimeWarn("[store] Decrypted v1 credential has an unsupported format.");
      return markStoreNull("unsupported_format");
    }
    const account: StoredAccount = {
      id: generateAccountId(),
      label: defaultAccountLabel(cred, Date.now()),
      createdAt: Date.now(),
      credential: cred,
    };
    const migrated: StoreV2 = { version: 2, activeId: account.id, accounts: [account] };
    normalizeStoreActiveId(migrated);
    try {
      // Serialize against other writers (the dashboard's withStoreLock saves).
      // An unserialized migration write landing AFTER a concurrent save would
      // silently roll it back (the migration holds a single stale account).
      // Two subtleties handled by persistMigratedStore:
      //  - non-reentrancy: when this read was triggered INSIDE a locked
      //    operation, a nested mutex acquisition would deadlock — the
      //    enclosing operation persists the migrated store itself;
      //  - last-writer-wins: after acquiring the mutex, skip the write if a
      //    concurrent op already persisted a v2 store.
      await persistMigratedStore(migrated);
      runtimeLog(`[store] Migrated v1 credential store to v2 format on disk.`);
    } catch (e) {
      // If write fails (e.g. read-only fs), at least return the in-memory copy
      // so the current request can proceed. Next read will re-migrate.
      runtimeWarn(`[store] Could not persist v1→v2 migration: ${(e as Error).message}`);
    }
    clearStoreNullReason();
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
    const store = normalizeStore(parsed);
    if (!store) {
      runtimeWarn("[store] Plaintext credential store has an unsupported format.");
      return markStoreNull("unsupported_format");
    }
    undecryptableFilePresent = false;
    clearStoreNullReason();
    return store;
  }

  // Plaintext file present but env not set — refuse to load and warn.
  if (parsed && (parsed as any).version === 2 && Array.isArray((parsed as any).accounts)) {
    runtimeWarn("[store] Refusing to load plaintext credentials.json without ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1.");
    runtimeWarn("[store] Either delete the file and re-login, or set the env var (test/debug only).");
    return markStoreNull("plaintext_disallowed");
  }

  runtimeWarn("[store] credentials.json has an unsupported format. Refusing to treat it as an empty store.");
  return markStoreNull("unsupported_format");
}

/**
 * Back up a corrupted / unreadable credentials.json before it gets overwritten.
 * Writes to `{STORE_FILE}.broken-{timestamp}` so the user can still recover
 * the original content if needed (e.g. they later remember the old username).
 *
 * CLEANUP: keeps at most MAX_BROKEN_BACKUPS (5) most recent .broken-* files.
 * Older ones are deleted. This prevents the ".broken files piling up"
 * symptom where repeated transient read failures (AV locks, etc.) created
 * dozens of backup files. The user only needs the most recent few for
 * recovery — anything older is just clutter.
 */
const MAX_BROKEN_BACKUPS = 5;
function backupCorruptedStore(originalContent: string): void {
  const backupPath = `${STORE_FILE}.broken-${Date.now()}`;
  try {
    writeFileSync(backupPath, originalContent, "utf-8");
    runtimeWarn(`[store] Unreadable store backed up to: ${backupPath}`);
  } catch {
    // Can't even write a backup — nothing more we can do; the next writeStore()
    // call will still overwrite the broken file with a fresh one.
  }
  // Clean up old .broken-* backups, keeping only the most recent
  // MAX_BROKEN_BACKUPS. This is best-effort — failures are silently ignored.
  try {
    cleanupOldBrokenBackups();
  } catch { /* non-fatal */ }
}

/**
 * Delete old .broken-* backup files, keeping only the most recent
 * MAX_BROKEN_BACKUPS. Called after each new backup is created.
 */
function cleanupOldBrokenBackups(): void {
  const dir = dirname(STORE_FILE);
  const prefix = `${basename(STORE_FILE)}.broken-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const brokenFiles = entries
    .filter(f => f.startsWith(prefix))
    .map(f => ({ name: f, path: join(dir, f) }))
    // Sort by modification time descending (newest first). fall back to name.
    .sort((a, b) => {
      try {
        return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
      } catch {
        return b.name.localeCompare(a.name);
      }
    });
  // Delete everything past the first MAX_BROKEN_BACKUPS
  for (let i = MAX_BROKEN_BACKUPS; i < brokenFiles.length; i++) {
    try { unlinkSync(brokenFiles[i].path); } catch { /* best-effort */ }
  }
}

/**
 * Mutex serializing all credential store writes.
 *
 * Without this, two concurrent mutations race: e.g. the proxy's auto-switch
 * path (handler.ts → switchAccount → writeStore) running at the same time as
 * a dashboard "add account" call (admin/api.ts → saveCredential → writeStore).
 * Both read the same store, both write their version — the second write wins
 * and the first writer's change is silently lost.
 *
 * The mutex is process-local: a CLI invocation (e.g. `zcode-proxy auth login`
 * from start.bat) writes to the same file from a SEPARATE process and is not
 * serialized here. That's an inherent limitation of file-based stores; the
 * atomic-write + retry-on-rename logic in utils/fs.ts handles the OS-level
 * race, and the in-memory cache is invalidated by invalidateStoreCache().
 *
 * IMPORTANT: the mutex must wrap the ENTIRE read-modify-write sequence, not
 * just the write. If it only wrapped writeStore, two concurrent
 * saveCredential calls would both read the same (empty) store, then each
 * write a single-account store — the second write would clobber the first,
 * silently dropping the first account. This is exactly the "credentials
 * lost" symptom the user reported. The `withStoreLock` helper below enforces
 * the full-sequence serialization for every mutating public API.
 */
const storeWriteMutex = createMutex();
/** Depth of in-progress storeWriteMutex.run callbacks (reentrancy guard). */
let storeWriteLockedDepth = 0;

/** True when credentials.json on disk is already a v2 store (plaintext envelope check, no decrypt). */
function diskStoreIsAlreadyV2(): boolean {
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown } | null;
    return parsed?.version === 2;
  } catch {
    return false; // unreadable / gone / v1-shaped — caller decides
  }
}

/**
 * Persist the v1→v2 migration safely (see the call site in readStoreUncached).
 * Returns false when the write was intentionally skipped (nested lock context,
 * or a newer v2 store already on disk).
 */
async function persistMigratedStore(migrated: StoreV2): Promise<boolean> {
  if (storeWriteLockedDepth > 0) {
    // readStoreUncached was re-entered from inside withStoreLock*/
    // clearCredentialAsync — the enclosing locked operation re-reads and
    // persists the (migrated) store itself; nesting would deadlock.
    return false;
  }
  await storeWriteMutex.run(async () => {
    storeWriteLockedDepth++;
    try {
      if (diskStoreIsAlreadyV2()) return; // concurrent op already saved a v2 store
      await writeStore(migrated);
    } finally {
      storeWriteLockedDepth--;
    }
  });
  return true;
}

const CROSS_PROCESS_LOCK_STALE_MS = 60_000;
const CROSS_PROCESS_LOCK_WAIT_MS = 10_000;

async function withCrossProcessStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  refreshStorePathFromEnv();
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true, mode: 0o700 });
  } catch (err) {
    const message = (err as Error).message;
    throw new Error(
      `Could not persist credentials to ${STORE_FILE}: ${message}. ` +
      `Set ZCODE_PROXY_STORE_DIR to a writable path.`,
    );
  }
  const lockDir = `${STORE_FILE}.lock`;
  const deadline = Date.now() + CROSS_PROCESS_LOCK_WAIT_MS;
  let acquired = false;
  let attempt = 0;

  while (!acquired) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      try {
        writeFileSync(
          join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // The directory itself is the lock; owner metadata is best-effort.
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > CROSS_PROCESS_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        const statCode = (statErr as NodeJS.ErrnoException)?.code;
        if (statCode === "ENOENT") continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for credential store lock: ${lockDir}`);
      }
      const delay = Math.min(250, 25 * (++attempt));
      await new Promise(resolve => hostSetTimeout(resolve, delay));
    }
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Run `fn` while holding the store write lock. `fn` receives the current
 * store (freshly read from disk + decrypted) and may mutate it freely; the
 * returned store is persisted atomically. If `fn` throws, no write happens
 * and the error propagates to the caller.
 *
 * This is the canonical entry point for ALL store mutations — it guarantees
 * read-modify-write atomicity across concurrent callers within the same
 * process. Reads that don't need to reflect concurrent writes (e.g.
 * loadCredential) can skip this and use readStore() directly for performance.
 *
 * === CRITICAL FIX (凭证丢失 bug) ===
 * Previously this function had an UNCONDITIONAL empty-store fallback:
 *   `if (!store) store = { version: 2, activeId: null, accounts: [] };`
 * When readStore() returned null for ANY reason (Windows AV transiently
 * locking the file, IO error, file deleted by another process, empty file
 * from a crashed write), the code would silently replace the user's entire
 * credential store with `{accounts: []}` and write that to disk —
 * EVAPORATING ALL ACCOUNTS with NO error log.
 *
 * The retry loop in handler.ts calls switchAccount on every credential
 * switch (3+ times per retry storm). If any one of those calls hit a
 * transient readStore() null, all accounts were gone. The user saw:
 *   1. "账号全没" — because disk now has {accounts: []}
 *   2. "切换失败" — because switchAccount can't find any account in empty store → 404
 *   3. "命令行还在继续重试" — because in-memory credential was still set,
 *      proxy kept retrying, returning 529 to client, client kept retrying
 *
 * FIX: split into two variants based on caller intent.
 *   - withStoreLock (allows empty fallback): for saveCredential / importAccounts
 *     where creating a fresh store is the explicit intent.
 *   - withExistingStoreLock (NO empty fallback): for switchAccount / removeAccount /
 *     setAccount* where mutating an empty store is ALWAYS a bug — returns null
 *     to signal "no store available, do not write".
 */
async function withStoreLock<T>(
  fn: (store: StoreV2) => Promise<T> | T,
): Promise<T> {
  return storeWriteMutex.run(async () => {
    storeWriteLockedDepth++;
    try {
      return await withCrossProcessStoreLock(async () => {
    // ALWAYS re-read inside the lock — the in-memory cache may be stale if
    // another process (CLI) wrote to the file. The cost is one disk read +
    // decrypt per mutation, acceptable for the low write frequency of a
    // credential store.
    //
    // NOTE: we do NOT call invalidateStoreCache() here anymore. readStore()
    // already does a statSync-based mtime check (store.ts:441-447) that
    // detects external writes. Calling invalidateStoreCache() forces a
    // full disk read + decrypt on EVERY mutation, AND it makes concurrent
    // READS (from the dashboard's GET /admin/api/accounts) miss the cache
    // too — turning the mutation into a global cache-bust event. The mtime
    // check is sufficient for cross-process correctness; the explicit
    // invalidate was a performance footgun.
    let store = await readStore();
    if (!store) {
      const reason = lastReadStoreNullReason;
      const canCreateFresh = reason === "missing" || reason === "empty" || !existsSync(STORE_FILE);
      if (!canCreateFresh) {
        throw new Error(
          `Refusing to create a fresh credential store because ${STORE_FILE} ` +
          `exists but could not be safely read (${reason ?? "unknown"}). ` +
          `This prevents overwriting existing credentials. Retry after a moment; ` +
          `if the file is corrupted, back it up and run \`zcode-proxy auth logout\` ` +
          `before saving new credentials.`,
        );
      }
      store = { version: 2, activeId: null, accounts: [] };
    }
    const result = await fn(store);
    await writeStore(store);
    return result;
    });
    } finally {
      storeWriteLockedDepth--;
    }
  });
}

/**
 * Like withStoreLock, but REFUSES to create an empty store if readStore()
 * returns null. Used by all mutations that operate on EXISTING accounts
 * (switchAccount, removeAccount, setAccount*).
 *
 * Returns:
 *   - T (the fn's return value) when the store was read successfully and fn
 *     returned a truthy value (mutation happened, persisted to disk)
 *   - false when either:
 *       a) readStore() returned null BECAUSE THE FILE DOESN'T EXIST — in
 *          this case the store is genuinely empty, so any account id is
 *          "not found". Return false (not null) so callers return 404, not
 *          503. This is the right behavior for "user has no credentials
 *          stored, dashboard tries to edit a nonexistent account".
 *       b) fn returned false (e.g. switchAccount didn't find the id) — no
 *          mutation, no write. Caller returns 404 "not found".
 *   - null when readStore() returned null BUT THE FILE EXISTS — this is the
 *     dangerous case: the file is there (possibly with accounts) but we
 *     can't read it (transient AV lock, IO error). Return null to signal
 *     "transient failure, don't write, caller returns 503". This is the
 *     key defense against the "账号全没" bug: we refuse to write an empty
 *     store that would clobber the (possibly intact) file on disk.
 *
 * The file-existence check uses a separate existsSync call. This adds one
 * statSync per failed read, but only on the error path (rare) — acceptable.
 */
async function withExistingStoreLock<T>(
  fn: (store: StoreV2) => Promise<T | false> | (T | false),
  opts: { allowEmptyWrite?: boolean } = {},
): Promise<T | null> {
  return storeWriteMutex.run(async () => {
    storeWriteLockedDepth++;
    try {
      return await withCrossProcessStoreLock(async () => {
    const store = await readStore();
    if (!store) {
      // Distinguish "file doesn't exist" (genuine empty store → 404) from
      // "file exists but unreadable" (transient failure → 503, refuse write).
      // The existsSync check is the only reliable way to tell these apart
      // because readStore() returns null for both cases.
      if (!existsSync(STORE_FILE)) {
        // File genuinely doesn't exist — any account id is "not found".
        // Return false (not null) so callers return 404, not 503.
        return false as unknown as T;
      }
      // File EXISTS but readStore() returned null — this is the dangerous
      // case. Log loudly and return null to signal "transient failure,
      // don't write". This is the key defense against the 凭证丢失 bug.
      runtimeWarn(
        `[store] withExistingStoreLock: readStore() returned null but file ` +
        `exists — likely transiently locked by antivirus or in a broken ` +
        `state. Skipping write to avoid clobbering credentials.json.`,
      );
      return null;
    }
    const result = await fn(store);
    // Only persist if fn returned a truthy value (meaning a real mutation
    // happened). Returning false means "no change" (e.g. id not found),
    // so skip the write to avoid needless disk churn + AV interference.
    if (result === false) return result as T;
    await writeStore(store, { allowEmpty: opts.allowEmptyWrite });
    return result;
    });
    } finally {
      storeWriteLockedDepth--;
    }
  });
}

/**
 * Atomically persist the encrypted store to disk.
 *
 * ATOMICITY: Uses atomicWriteFile (write-to-tmp + rename) so a crash mid-write
 * leaves the previous file intact instead of a truncated/partial one. This is
 * the #1 fix for "重启突然凭证全部丢失" — the old code called writeFileSync
 * directly, which truncates-then-writes; a Ctrl+C / Windows kill / AV lock
 * between truncate and full write left credentials.json empty or partial,
 * which then failed JSON.parse on next read → "credentials cleared" symptom.
 *
 * MUTEX: Serialized via storeWriteMutex so concurrent writes from the dashboard
 * and the proxy's auto-switch path don't race (last-writer-wins would silently
 * drop one writer's changes).
 *
 * ENCRYPTION: Errors from encrypt() (randomBytes, createCipheriv) propagate
 * to the caller -- these are unrecoverable and should surface, not be swallowed.
 *
 * PERSISTENCE: Disk-write errors also propagate. Treating a failed write as a
 * successful save makes the dashboard/CLI report "saved", then the credential
 * disappears after restart because it only lived in memory.
 */
async function writeStore(store: StoreV2, opts: { allowEmpty?: boolean } = {}): Promise<void> {
  refreshStorePathFromEnv();
  normalizeStoreInPlace(store);
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
  // === DEFENSE-IN-DEPTH LOGGING (凭证丢失 bug) ===
  // If we're about to write a store with ZERO accounts, log a warning so the
  // user has visibility into when this happens. We do NOT refuse the write
  // because there's a legitimate path: removeAccount on the last account.
  // The actual BUG prevention happens upstream in withExistingStoreLock,
  // which refuses to write when readStore() returned null (the dangerous
  // case where switchAccount etc. would silently clobber a populated store).
  //
  // This log is still useful: if the user sees "writeStore: writing EMPTY
  // store" in the logs without having explicitly removed their last account,
  // they know something is wrong and can investigate.
  if (store.accounts.length === 0 && !opts.allowEmpty) {
    runtimeWarn(
      `[store] writeStore: writing EMPTY store to ${STORE_FILE}. ` +
      `If you didn't intend to delete all accounts, this is a bug — ` +
      `check the previous log lines for "withExistingStoreLock" warnings.`,
    );
  }
  // Encrypt OUTSIDE the mutex: crypto is CPU-bound and doesn't touch the file,
  // so concurrent encryptions are safe. Doing it inside the mutex would serialize
  // CPU work unnecessarily and extend the critical section.
  const json = JSON.stringify(store);
  let encrypted: string;
  try {
    encrypted = await encrypt(json);
  } catch (err) {
    // Encryption failure (e.g. randomBytes entropy exhaustion, cipher init
    // error) is unrecoverable — surface to caller so they see the real cause
    // instead of a misleading "could not persist" message.
    throw new Error(`Failed to encrypt credential store: ${(err as Error).message}`);
  }
  try {
    await mkdirSync(dirname(STORE_FILE), { recursive: true });
    // NOTE: no mutex here — withStoreLock (the only caller) already holds it.
    // Calling storeWriteMutex.run() here would deadlock (the mutex is not
    // reentrant). Direct write is safe because all mutations go through
    // withStoreLock which serializes the full read-modify-write sequence.
    await atomicWriteFile(
      STORE_FILE,
      JSON.stringify({ version: 2, encrypted }),
      "utf-8",
      // Owner-only: the store holds OAuth API keys / JWTs. The documented
      // encryption is obfuscation-grade (fixed key shipped in the source), so
      // file permissions are the real at-rest control on multi-user hosts.
      0o600,
    );
  } catch (err) {
    // Read-only filesystem (e.g. Render container without a persistent disk
    // mounted at STORE_DIR), OR Windows EPERM/EBUSY that exhausted the
    // safeRename retry budget. Surface this to the caller instead of keeping
    // a fake in-memory success that vanishes on restart.
    //
    // If `store` came from readStore() it may be the same object as
    // cachedStore and may already have been mutated in-place by the caller.
    // Drop the cache so the next read is forced back to the last durable
    // on-disk state.
    cachedStore = undefined;
    cachedStoreMtimeMs = -1;
    cachedStoreCtimeMs = -1;
    cachedStoreSize = -1;
    const message = (err as Error).message;
    runtimeWarn(`[store] Could not persist credentials to ${STORE_FILE}: ${message}`);
    runtimeWarn(`[store] Set ZCODE_PROXY_STORE_DIR to a writable path (e.g. /data/.zcode-proxy on Render with a disk, or /tmp/.zcode-proxy for ephemeral storage).`);
    throw new Error(
      `Could not persist credentials to ${STORE_FILE}: ${message}. ` +
      `Set ZCODE_PROXY_STORE_DIR to a writable path.`,
    );
  }
  cachedStore = store; // keep cache in sync with what we intended to write
  clearStoreNullReason();
  // Capture the post-write mtime so subsequent reads see "fresh" without
  // having to re-stat (we know we just wrote it).
  try {
    const st = statSync(STORE_FILE);
    cachedStoreMtimeMs = st.mtimeMs;
    cachedStoreCtimeMs = st.ctimeMs;
    cachedStoreSize = st.size;
  } catch {
    cachedStoreMtimeMs = -1;
    cachedStoreCtimeMs = -1;
    cachedStoreSize = -1;
  }
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
  const normalizedCred = normalizeCredential(cred);
  if (!normalizedCred) {
    throw new Error("Invalid credential: provider must be zai/bigmodel and apiKey must be a non-empty string.");
  }
  await withStoreLock((store) => {
    const existingIdx = store.accounts.findIndex(
      a => a.credential.provider === normalizedCred.provider && a.credential.apiKey === normalizedCred.apiKey,
    );

    if (existingIdx >= 0) {
      // Update existing — preserve id, createdAt; refresh label if it looks auto-generated
      const old = store.accounts[existingIdx];
      store.accounts[existingIdx] = {
        ...old,
        credential: normalizedCred,
        label: old.label.startsWith(`${normalizedCred.provider} · `) ? defaultAccountLabel(normalizedCred, old.createdAt) : old.label,
      };
    } else {
      const account: StoredAccount = {
        id: generateAccountId(),
        label: defaultAccountLabel(normalizedCred, Date.now()),
        createdAt: Date.now(),
        credential: normalizedCred,
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
  });
}

/** Load the currently active credential. Returns null if none. */
export async function loadCredential(): Promise<Credential | null> {
  const store = await readStore();
  if (!store || !store.activeId) return null;
  const account = store.accounts.find(a => a.id === store.activeId);
  if (!account || account.credential.disabled) return null;
  return { ...account.credential };
}

/** Reset cache and write guards only after confirming the file is gone. */
function resetClearedStoreState(): void {
  cachedStore = null;
  cachedStoreMtimeMs = 0;
  cachedStoreCtimeMs = 0;
  cachedStoreSize = 0;
  resetEncryptionKeyCache();
  undecryptableFilePresent = false;
  lastReadStoreNullReason = "missing";
}

/**
 * Clear ALL stored credentials — ASYNC, mutex-protected version.
 *
 * Production code (handler.ts, admin/api.ts, index.ts) should use THIS
 * function instead of the synchronous clearCredential() to avoid the
 * following race:
 *
 *   1. Caller A acquires storeWriteMutex, readStore(), mutates store
 *   2. Caller B calls clearCredential() (sync) → unlinkSync(STORE_FILE)
 *   3. Caller A's writeStore() re-creates the file with A's mutated store
 *   4. Result: user clicked "Clear", but credentials.json was "resurrected"
 *
 * clearCredentialAsync() acquires storeWriteMutex BEFORE the unlink, so
 * any in-flight writeStore() finishes (or hasn't started) before we delete.
 * After the unlink, the cache is reset to null (file gone) and mtime to 0
 * (the "confirmed missing" marker).
 *
 * @throws on persistent EPERM/EBUSY after retries (same as sync version).
 */
export async function clearCredentialAsync(): Promise<void> {
  refreshStorePathFromEnv();
  await storeWriteMutex.run(async () => {
    storeWriteLockedDepth++;
    try {
      await withCrossProcessStoreLock(async () => {
        if (!existsSync(STORE_FILE)) {
          // File already gone — just reset state.
          resetClearedStoreState();
          return;
        }
        // Windows: unlink can fail with EPERM/EBUSY/EACCES if AV / indexer /
        // backup tool briefly has the file open. Retry with backoff.
        const MAX_RETRIES = 5;
        const RETRY_DELAY_MS = 50;
        let lastErr: unknown;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            unlinkSync(STORE_FILE);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
              // ASYNC sleep — no event-loop blocking (unlike sync clearCredential).
              await new Promise(r => hostSetTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
              continue;
            }
            // ENOENT (already gone) is fine — treat as success.
            if (code === "ENOENT") {
              lastErr = null;
              break;
            }
            throw err; // other non-retryable
          }
        }
        if (lastErr) throw lastErr;
        resetClearedStoreState();
      });
    } finally {
      storeWriteLockedDepth--;
    }
  });
}

/**
 * Clear ALL stored credentials — SYNC version, retained for backward compat
 * with test code (which calls clearCredential() directly without await).
 *
 * ⚠️ NOT MUTEX-SAFE — concurrent withStoreLock() callers can "resurrect"
 * the file by writing their in-flight store after this unlink. Production
 * code should use clearCredentialAsync() instead. Tests don't need mutex
 * protection because they run serially (no concurrent writers).
 */
export function clearCredential(): void {
  refreshStorePathFromEnv();
  if (existsSync(STORE_FILE)) {
    // Windows: unlinkSync can fail with EPERM/EBUSY/EACCES if another process
    // (antivirus, Windows Search indexer, backup tool) briefly has the file
    // open. Retry a few times with backoff before surfacing the error —
    // matches the safeRename pattern in utils/fs.ts. Without this retry, a
    // transient AV scan during "Clear credentials" would throw an uncaught
    // error, leaving the dashboard in a half-state and the file on disk.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 50;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        unlinkSync(STORE_FILE);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
          // Synchronous sleep — clearCredential is sync by API contract
          // (callers don't await it). The total worst-case blocking time
          // is 50+100+150+200+250 = 750ms, acceptable for a UI action.
          //
          // v0.2.0.8: use Atomics.wait on a SharedArrayBuffer instead of a
          // `while (Date.now() < end) { /* spin */ }` busy loop. Atomics.wait
          // truly parks the thread (the OS scheduler yields the CPU), whereas
          // the spin loop kept the core at 100% for the full delay. Behaviour
          // is identical: we still block the event loop for the same duration
          // (sync API contract preserved), just without burning a core.
          try {
            const waitBuf = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(waitBuf, 0, 0, RETRY_DELAY_MS * (attempt + 1));
          } catch {
            // SharedArrayBuffer unavailable (very old runtime) — fall back to
            // a short SetTimeout-based busy wait. This branch is defensive;
            // modern Bun/Node always expose Atomics.wait on SharedArrayBuffer.
            const end = Date.now() + RETRY_DELAY_MS * (attempt + 1);
            while (Date.now() < end) { /* spin */ }
          }
          continue;
        }
        if (code === "ENOENT") { lastErr = null; break; }
        throw err; // other non-retryable
      }
    }
    if (lastErr) throw lastErr;
  }
  resetClearedStoreState();
}

export function getStorePath(): string {
  refreshStorePathFromEnv();
  return STORE_FILE;
}

// ---------------------------------------------------------------------------
// Public API — multi-account management
// ---------------------------------------------------------------------------

/** List all stored accounts (without exposing secret material — apiKey is masked).
 *
 * Accounts are returned sorted by `createdAt` ascending (oldest first),
 * matching the user's expectation that the account list reflects the order
 * in which credentials were added. vceshi0.0.4+.
 */
export async function listAccounts(): Promise<AccountList> {
  const store = await readStore();
  if (!store) return { accounts: [], activeId: null };
  return { activeId: store.activeId, accounts: summarizeAccounts(store.accounts) };
}

/**
 * Switch the active credential by account id.
 * Returns:
 *   - true  : account found and activated
 *   - false : account not found OR is disabled (vceshi0.0.6+)
 *   - null  : store could not be read (e.g. transiently locked by AV). The
 *             caller should treat this as a transient failure and either
 *             retry or surface to the user. Importantly, NO WRITE happened —
 *             the on-disk store is untouched, which is the key defense
 *             against the "账号全没" bug.
 *
 * Callers should distinguish these cases by checking the disabled flag in the
 * listAccounts response before calling switchAccount, if they need to.
 */
export async function switchAccount(id: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const found = store.accounts.find(a => a.id === id);
    if (!found) return false;
    // vceshi0.0.6+: refuse to activate a disabled credential. The dashboard
    // should hide the "Activate" button for disabled accounts, but this is the
    // server-side enforcement.
    if (found.credential.disabled) return false;
    store.activeId = id;
    return true;
  });
}

/**
 * Remove an account by id. If the active account is removed, falls back to
 * the first remaining.
 *
 * Returns:
 *   - true  : account was found and removed
 *   - false : account not found (no change)
 *   - null  : store could not be read (transient failure, no write happened)
 */
export async function removeAccount(id: string): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const idx = store.accounts.findIndex(a => a.id === id);
    if (idx < 0) return false;
    store.accounts.splice(idx, 1);
    if (store.activeId === id) {
      store.activeId = store.accounts[0]?.id ?? null;
    }
    return true;
  }, { allowEmptyWrite: true });
}

/** Apply a single-account mutation under the existing read/write guard. */
function updateAccount(id: string, mutate: (account: StoredAccount) => void): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    mutate(account);
    return true;
  });
}

/** Empty optional text is represented by an absent field on disk. */
function setAccountOptionalText(
  id: string,
  field: "proxy" | "name" | "email",
  value: string,
): Promise<boolean | null> {
  return updateAccount(id, account => {
    const trimmed = (value ?? "").trim();
    if (trimmed) account.credential[field] = trimmed;
    else delete account.credential[field];
  });
}

/**
 * Update an account's human-readable label.
 * Returns true/false as expected, OR null if store could not be read.
 */
export async function setAccountLabel(id: string, label: string): Promise<boolean | null> {
  return updateAccount(id, account => {
    account.label = label.trim() || account.label;
  });
}

/** Update an account's plan. Returns null if store could not be read. */
export async function setAccountPlan(id: string, plan: "coding-plan" | "start-plan"): Promise<boolean | null> {
  return updateAccount(id, account => {
    account.credential.plan = plan;
  });
}

/**
 * Set or clear the outbound proxy. Loopback/private proxies are supported;
 * literal metadata, link-local and unspecified addresses are rejected by
 * validateProxyUrl. Hostname URLs are accepted without DNS resolution.
 * Invalid URLs throw before acquiring the store lock so admin returns 400.
 */
export async function setAccountProxy(id: string, proxy: string): Promise<boolean | null> {
  const trimmed = (proxy ?? "").trim();
  if (trimmed) {
    const validation = validateProxyUrl(trimmed);
    if (!validation.ok) throw new Error(validation.message);
  }
  return setAccountOptionalText(id, "proxy", trimmed);
}

/**
 * Update an account's human-readable name (vceshi0.0.4+).
 *
 * Pass an empty string to clear the name — the dashboard will fall back to
 * the auto-generated `label` for display. The name shows up in the account
 * list "名称" column when set, otherwise the auto-generated label is shown.
 */
export async function setAccountName(id: string, name: string): Promise<boolean | null> {
  return setAccountOptionalText(id, "name", name);
}

/**
 * Update an account's email (vceshi0.0.4+).
 *
 * Pass an empty string to clear the email. No validation is performed here —
 * the dashboard may do a basic format check, but we accept any string to
 * accommodate edge cases (e.g. upstream returning a non-standard email format).
 */
export async function setAccountEmail(id: string, email: string): Promise<boolean | null> {
  return setAccountOptionalText(id, "email", email);
}

/**
 * Enable or disable an account (vceshi0.0.6+).
 *
 * When disabled, the credential is:
 *   - Excluded from `switchToNextCredential` (won't be picked as fallback)
 *   - Refused by `switchAccount` (can't be manually activated)
 *
 * If the currently-active account is disabled, activeId falls back to the
 * first remaining enabled account; if none are enabled, activeId is cleared.
 */
export async function setAccountDisabled(id: string, disabled: boolean): Promise<boolean | null> {
  return withExistingStoreLock((store) => {
    const account = store.accounts.find(a => a.id === id);
    if (!account) return false;
    if (disabled) {
      account.credential.disabled = true;
    } else {
      delete account.credential.disabled;
    }
    if (disabled && store.activeId === id) {
      store.activeId = store.accounts.find(a => a.id !== id && !a.credential.disabled)?.id ?? null;
    }
    return true;
  });
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
  return store.accounts.map(cloneStoredAccount);
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
    accounts: store.accounts.map(cloneStoredAccount),
  };
}

/** Import accounts from a previously exported backup. Merges by id — existing accounts are updated, new ones are appended. */
export async function importAccounts(
  incoming: Array<Omit<StoredAccount, "credential"> & { credential: Credential }>,
): Promise<{ added: number; updated: number }> {
  return withStoreLock((store) => {
    let added = 0;
    let updated = 0;
    const records = Array.isArray(incoming) ? incoming : [];
    for (const acc of records) {
      const normalized = normalizeStoredAccount(acc);
      if (!normalized) continue;
      const cloned = cloneStoredAccount(normalized);
      const idx = store.accounts.findIndex(a => a.id === normalized.id);
      if (idx >= 0) {
        store.accounts[idx] = cloned;
        updated++;
      } else {
        store.accounts.push(cloned);
        added++;
        if (!store.activeId) store.activeId = cloned.id;
      }
    }
    return { added, updated };
  });
}
