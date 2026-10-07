/**
 * Credential-file encryption and legacy decryption compatibility.
 * Writes always use AES-256-GCM with SHA-256("520") and the Node layout
 * IV[16] + auth tag[16] + ciphertext. Reads also accept the legacy WebCrypto
 * layout and old machine-derived keys. Only ZCODE_PROXY_LEGACY_SEED is an
 * opt-in recovery seed; it never changes the key used for new writes.
 *
 * The fixed key provides portable obfuscation, not a private per-user secret.
 */
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { homedir } from "node:os";
import { runtimeLog } from "../utils/log.js";

const FIXED_KEY_SEED = "520";
const ENV_LEGACY_SEED = "ZCODE_PROXY_LEGACY_SEED";
let cachedKey: Buffer | null = null;

/** @internal Reset the fixed-key cache between tests. */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}

export { resetEncryptionKeyCache as _resetKeyCacheForTesting };

function deriveSha256Key(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

function deriveXorFoldKey(seed: string): Buffer {
  const hash = Buffer.alloc(32);
  const seedBytes = Buffer.from(seed, "utf8");
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

function getEncryptionKeyBuffer(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = deriveSha256Key(FIXED_KEY_SEED);
  return cachedKey;
}

function buildCandidateKeysForDecrypt(): Array<{ label: string; key: Buffer }> {
  const home = homedir();
  const plat = process.platform;
  const arch = process.arch;

  // Old runtimes used different home sources, case and trailing slashes.
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
  // Manual recovery only; never override the key used for new writes.
  const legacyEnv = process.env[ENV_LEGACY_SEED];
  if (legacyEnv) seeds.add(legacyEnv);

  const candidates: Array<{ label: string; key: Buffer }> = [];
  for (const seed of seeds) {
    const shortSeed = seed.length > 60 ? seed.slice(0, 57) + "..." : seed;
    candidates.push({ label: `SHA-256("${shortSeed}")`, key: deriveSha256Key(seed) });
    candidates.push({ label: `XOR-fold("${shortSeed}")`, key: deriveXorFoldKey(seed) });
  }
  return candidates;
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = getEncryptionKeyBuffer();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export async function decrypt(ciphertext: string): Promise<string> {
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
      runtimeLog(`[store] Decryption succeeded with legacy fallback key: ${label}. File will be re-encrypted with the fixed key on next save.`);
      return plaintext;
    }

    plaintext = await tryWebCryptoFormat(key);
    if (plaintext !== null) {
      runtimeLog(`[store] Decryption succeeded with legacy fallback key (WebCrypto format): ${label}. File will be re-encrypted with the fixed key on next save.`);
      return plaintext;
    }
  }

  throw new Error(
    "Failed to decrypt credential store. Tried: fixed key SHA-256(\"520\") " +
    "(Node + WebCrypto formats), multi-seed fallback covering homedir/platform/" +
    "arch variations across Bun versions (Bun 1.1/1.2/1.3 homedir() differences, " +
    "USERPROFILE vs HOMEDRIVE+HOMEPATH, etc.). If your credentials.json was " +
    "encrypted on a different machine / OS / username, or by an older version " +
    "that consulted ZCODE_PROXY_CREDENTIAL_SECRET, set ZCODE_PROXY_LEGACY_SEED " +
    "to the old seed string (e.g. \"C:\\\\Users\\\\OldName-win32-x64\" or the old " +
    "secret value) and retry. As a last resort, run `zcode-proxy auth logout` " +
    "to discard and re-login."
  );
}
