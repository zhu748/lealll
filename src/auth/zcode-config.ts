/**
 * Read & merge credentials from the ZCode desktop client's storage.
 *
 * The ZCode 3.1.x client stores login state in TWO files under `~/.zcode/v2/`:
 *
 * - `config.json` (plaintext) — provider entries with `options.apiKey` and an
 *   `enabled` flag. The `apiKey` here is directly usable (zai = `id.secret`,
 *   bigmodel = plain key). This is what the old import read exclusively.
 * - `credentials.json` (encrypted) — the OAuth-captured tokens, keyed:
 *     `oauth:{provider}:access_token` — coding-plan access JWT (needs biz-API
 *       exchange to become a usable apiKey.secret; NOT directly usable)
 *     `zcodejwttoken`                 — start-plan JWT (same as config.json's)
 *     `oauth:{provider}:user_info`    — JSON `{user_id, email, avatar}`
 *     `oauth:active_provider`         — plaintext provider name (zai/bigmodel)
 *
 * Each value in credentials.json is `enc:v1:{iv}.{tag}.{ct}` (base64url, 3
 * segments, AES-256-GCM). The key is `SHA-256(ZCODE_CREDENTIAL_SECRET ??
 * "zcode-credential-fallback:{platform}:{homedir}:{username}")`.
 *
 * This module merges both sources into one `ZCodeImportSource`, taking the
 * MORE COMPLETE picture: config.json wins for directly-usable apiKey/jwt;
 * credentials.json supplements email/userId (config.json has neither) and
 * drives provider auto-detect (from `active_provider`).
 *
 * NOTE: this is a SEPARATE key from lealll's own store (`SHA-256("520")` in
 * store.ts). That one encrypts `~/.zcode-proxy/credentials.json`; this one
 * decrypts the ZCode client's `~/.zcode/v2/credentials.json`. Do not share.
 *
 * Reverse-engineered from `D:/zcode/resources/app.asar` (host process) and
 * verified end-to-end 2026-06-25 against a real ~/.zcode/v2/credentials.json.
 */
import type { PlanId } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import { createHash, createDecipheriv } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

/**
 * Root of the ZCode client's per-user data.
 * Overridable via `ZCODE_HOME` (test isolation — points at a temp dir instead
 * of the real ~/.zcode/v2). Production leaves it unset and uses homedir().
 */
export function zcodeV2Dir(): string {
  const home = process.env.ZCODE_HOME ?? homedir();
  return join(home, ".zcode", "v2");
}

/** One decrypted ZCode credentials.json field set, per provider. */
interface DecryptedZCodeCreds {
  /** `oauth:{provider}:access_token` — raw OAuth JWT, NOT directly usable as apiKey. */
  accessToken?: string;
  /** `zcodejwttoken` — start-plan JWT. */
  jwt?: string;
  /** `oauth:{provider}:user_info` parsed. */
  userId?: string;
  email?: string;
  /** `oauth:active_provider` — plaintext provider name. */
  activeProvider?: string;
}

/** Result of merging config.json + credentials.json for one provider/plan. */
export interface ZCodeImportSource {
  provider: ProviderId;
  plan: PlanId;
  /**
   * The credential to use. Preference order:
   *   1. config.json plaintext apiKey (directly usable)
   *   2. credentials.json access_token (raw JWT — caller must resolve via
   *      KeyResolver before storing; `isRawAccessToken` flags this case)
   */
  apiKey: string;
  jwt?: string;
  email?: string;
  userId?: string;
  /** True when `apiKey` is a raw OAuth access_token JWT needing biz-API exchange. */
  isRawAccessToken: boolean;
}

// ---------------------------------------------------------------------------
// config.json (plaintext) — existing read logic, extracted here for reuse
// ---------------------------------------------------------------------------

interface ZCodeConfigShape {
  provider?: Record<string, {
    options?: { apiKey?: string };
    enabled?: boolean;
  }>;
}

function readZCodeConfig(): ZCodeConfigShape | null {
  const configPath = join(zcodeV2Dir(), "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as ZCodeConfigShape;
  } catch {
    return null;
  }
}

/** Read config.json's apiKey + enabled flag for one provider×plan. */
function readConfigEntry(
  config: ZCodeConfigShape | null,
  provider: ProviderId,
  plan: PlanId,
): { apiKey: string; enabled: boolean } {
  const key = `builtin:${provider}-${plan}`;
  const entry = config?.provider?.[key];
  return {
    apiKey: entry?.options?.apiKey?.trim() || "",
    enabled: entry?.enabled === true,
  };
}

// ---------------------------------------------------------------------------
// credentials.json (encrypted) — the new source
// ---------------------------------------------------------------------------

/**
 * Resolve the AES-256-GCM key used to decrypt credentials.json.
 * Env var wins; otherwise the deterministic fallback the ZCode client uses
 * when ZCODE_CREDENTIAL_SECRET is unset.
 */
function resolveZCodeKey(): Buffer {
  const seed = process.env.ZCODE_CREDENTIAL_SECRET
    ?? `zcode-credential-fallback:${process.platform}:${homedir()}:${userInfo().username}`;
  return createHash("sha256").update(seed).digest();
}

/** base64url → Buffer (ZCode uses unpadded base64url for the 3 segments). */
function b64urlDecode(s: string): Buffer {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(pad + "=".repeat((4 - (pad.length % 4)) % 4), "base64");
}

/**
 * Decrypt one `enc:v1:{iv}.{tag}.{ct}` field.
 * Returns the decrypted UTF-8 string, or `undefined` if the value isn't
 * encrypted or decryption fails (wrong key / corrupt). Never throws — callers
 * treat a missing field as "not present" and keep going.
 */
export function decryptZCodeField(enc: unknown): string | undefined {
  if (typeof enc !== "string" || !enc.startsWith("enc:v1:")) return undefined;
  const payload = enc.slice("enc:v1:".length);
  const parts = payload.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const iv = b64urlDecode(parts[0]);
    const tag = b64urlDecode(parts[1]);
    const ct = b64urlDecode(parts[2]);
    const decipher = createDecipheriv("aes-256-gcm", resolveZCodeKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
  } catch {
    return undefined;
  }
}

/** Parse credentials.json and decrypt the fields relevant to one provider. */
function readZCodeCreds(provider: ProviderId): DecryptedZCodeCreds | null {
  const credPath = join(zcodeV2Dir(), "credentials.json");
  if (!existsSync(credPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(credPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const accessToken = decryptZCodeField(raw[`oauth:${provider}:access_token`]);
  const jwt = decryptZCodeField(raw["zcodejwttoken"]);

  // user_info is a JSON blob; pull user_id + email out of it.
  const userInfoRaw = decryptZCodeField(raw[`oauth:${provider}:user_info`]);
  let userId: string | undefined;
  let email: string | undefined;
  if (userInfoRaw) {
    try {
      const info = JSON.parse(userInfoRaw) as { user_id?: string; email?: string };
      userId = typeof info.user_id === "string" ? info.user_id : undefined;
      email = typeof info.email === "string" && info.email.trim() ? info.email.trim() : undefined;
    } catch { /* malformed user_info — ignore, non-fatal */ }
  }

  // active_provider is plaintext in practice, but try decrypt first for safety.
  const activeProviderRaw = raw["oauth:active_provider"];
  const activeProvider = (typeof activeProviderRaw === "string" && activeProviderRaw && !activeProviderRaw.startsWith("enc:v1:"))
    ? activeProviderRaw
    : decryptZCodeField(activeProviderRaw);

  return { accessToken, jwt, userId, email, activeProvider };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Auto-detect the currently-active provider from credentials.json's
 * `active_provider` field. Returns null if credentials.json is absent, can't
 * be read, or the field is missing/unknown.
 */
export function detectZCodeProvider(): ProviderId | null {
  // Provider-agnostic read: try both known providers' user_info absent, just
  // grab active_provider. Reuse the creds reader for zai first, then bigmodel.
  for (const provider of ["zai", "bigmodel"] as ProviderId[]) {
    const creds = readZCodeCreds(provider);
    if (creds?.activeProvider === "zai") return "zai";
    if (creds?.activeProvider === "bigmodel") return "bigmodel";
  }
  return null;
}

/** True if the string looks like a usable zai/bigmodel apiKey (not a JWT). */
function isApiKeyFormat(s: string): boolean {
  if (!s) return false;
  // zai: 32-hex . secret. bigmodel: plain key. JWTs start with "eyJ".
  if (s.startsWith("eyJ")) return false;
  return /^[a-f0-9]{32}\./.test(s) || /^[a-zA-Z0-9]{20,}$/.test(s);
}

/**
 * Read & merge ZCode credentials for one provider.
 *
 * @param provider   Which provider to import.
 * @param forcedPlan Optional plan override (the dashboard/CLI `--plan=` flag).
 *                   When omitted, the plan is auto-detected from the enabled
 *                   flag in config.json, falling back to whichever token exists.
 * @throws If neither source yields a usable credential for the provider.
 */
export function readZCodeImport(
  provider: ProviderId,
  forcedPlan?: PlanId,
): ZCodeImportSource {
  const config = readZCodeConfig();
  const creds = readZCodeCreds(provider);

  const codingCfg = readConfigEntry(config, provider, "coding-plan");
  const startCfg = readConfigEntry(config, provider, "start-plan");
  const codingKey = codingCfg.apiKey;

  // start-plan JWT ownership is subtle: `zcodejwttoken` in credentials.json is a
  // SINGLE global field, NOT per-provider. It belongs to whichever provider is
  // currently active. So a provider "owns" the start-plan JWT only when:
  //   - config.json lists its own start-plan apiKey (explicit per-provider), OR
  //   - the credentials.json JWT exists AND this provider is the active one
  //     (activeProvider matches). Without this guard, a zai login would make
  //     bigmodel falsely report an available start-plan.
  const rawJwt = startCfg.apiKey || creds?.jwt;
  const ownsJwt = !!rawJwt && (!!startCfg.apiKey || creds?.activeProvider === provider);
  const startJwt = ownsJwt ? rawJwt : undefined;

  // Plan auto-detect: explicit override → config.json enabled flag → token presence.
  let plan: PlanId;
  if (forcedPlan) {
    plan = forcedPlan;
  } else if (codingCfg.enabled && codingKey) {
    plan = "coding-plan";
  } else if (startCfg.enabled && startJwt) {
    plan = "start-plan";
  } else if (codingKey) {
    plan = "coding-plan";
  } else if (startJwt) {
    plan = "start-plan";
  } else {
    throw new Error(
      `No ZCode credential found for ${provider} (looked in config.json + credentials.json). ` +
      `Make sure ZCode is installed and you've logged in.`,
    );
  }

  // Validate the chosen plan actually has a credential.
  if (plan === "start-plan" && !startJwt) {
    throw new Error(
      `No start-plan JWT for ${provider} in ZCode storage. ` +
      `Available: coding-plan apiKey=${codingKey ? "yes" : "no"}.`,
    );
  }
  if (plan === "coding-plan" && !codingKey && !creds?.accessToken) {
    throw new Error(
      `No coding-plan credential for ${provider} in ZCode storage ` +
      `(no config.json apiKey and no credentials.json access_token).`,
    );
  }

  // Build the apiKey for the chosen plan.
  // coding-plan: prefer config.json's plaintext apiKey (directly usable);
  // fall back to credentials.json access_token (raw JWT — caller resolves it).
  let apiKey: string;
  let isRawAccessToken = false;
  if (plan === "start-plan") {
    // start-plan's "key" is the JWT itself; we also keep a coding-plan apiKey
    // alongside when available (decorative fallback, matches the old behavior).
    apiKey = codingKey || startJwt!;
  } else {
    // coding-plan
    if (codingKey && isApiKeyFormat(codingKey)) {
      apiKey = codingKey;
    } else if (creds?.accessToken) {
      apiKey = creds.accessToken;
      isRawAccessToken = true;
    } else {
      // config.json had something but it's not apiKey-shaped (e.g. a JWT) — use as-is
      apiKey = codingKey;
    }
  }

  return {
    provider,
    plan,
    apiKey,
    jwt: startJwt || undefined,
    email: creds?.email,
    userId: creds?.userId,
    isRawAccessToken,
  };
}

/** One provider×plan availability entry for the detect endpoint. */
export interface ZCodeImportAvailability {
  provider: ProviderId;
  plan: PlanId;
  hasJwt: boolean;
  hasApiKey: boolean;
}

/**
 * Scan both files and report which provider×plan combinations actually have a
 * usable credential. Drives the dashboard's dropdown pre-fill + disabling.
 */
export function listAvailableZCodeImports(): ZCodeImportAvailability[] {
  const config = readZCodeConfig();
  const zaiCreds = readZCodeCreds("zai");
  const bmCreds = readZCodeCreds("bigmodel");
  const providers: Array<[ProviderId, DecryptedZCodeCreds | null]> = [
    ["zai", zaiCreds],
    ["bigmodel", bmCreds],
  ];

  const out: ZCodeImportAvailability[] = [];
  for (const [provider, creds] of providers) {
    const codingCfg = readConfigEntry(config, provider, "coding-plan");
    const startCfg = readConfigEntry(config, provider, "start-plan");
    // start-plan JWT ownership: `zcodejwttoken` is a single global field, so a
    // provider owns it only if config.json lists its own start-plan apiKey OR
    // this provider is the active one. See readZCodeImport for the full rationale.
    const rawStartJwt = startCfg.apiKey || creds?.jwt;
    const ownsStartJwt = !!rawStartJwt && (!!startCfg.apiKey || creds?.activeProvider === provider);
    const hasCodingKey = !!(codingCfg.apiKey || creds?.accessToken);
    out.push({ provider, plan: "start-plan", hasJwt: ownsStartJwt, hasApiKey: ownsStartJwt });
    out.push({ provider, plan: "coding-plan", hasJwt: hasCodingKey, hasApiKey: hasCodingKey });
  }
  return out;
}

export { isApiKeyFormat };
