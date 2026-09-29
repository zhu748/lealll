/**
 * Tests for ZCode credential reading (config.json + credentials.json merge).
 * @see src/auth/zcode-config.ts
 *
 * Isolation: every test sets ZCODE_HOME to a temp dir (via mkdtempSync) so we
 * never touch the real ~/.zcode/v2/. Encryption uses a fixed
 * ZCODE_CREDENTIAL_SECRET so the round-trip (encrypt here → decrypt in module)
 * is deterministic — no real credentials are used.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readZCodeImport,
  decryptZCodeField,
  detectZCodeProvider,
  listAvailableZCodeImports,
} from "./zcode-config.js";

// Fixed key for the test — module reads ZCODE_CREDENTIAL_SECRET when set.
const TEST_SECRET = "test-secret-key-for-zcode-config";
const TEST_KEY = createHash("sha256").update(TEST_SECRET).digest();

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "zcode-cfg-"));
  savedEnv.ZCODE_HOME = process.env.ZCODE_HOME;
  savedEnv.ZCODE_CREDENTIAL_SECRET = process.env.ZCODE_CREDENTIAL_SECRET;
  process.env.ZCODE_HOME = tmpHome;
  process.env.ZCODE_CREDENTIAL_SECRET = TEST_SECRET;
  mkdirSync(join(tmpHome, ".zcode", "v2"), { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

// Encrypt a plaintext string into the ZCode `enc:v1:{iv}.{tag}.{ct}` format,
// mirroring what the real client writes. Used to build test fixtures.
function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TEST_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64u = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `enc:v1:${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
}

interface ConfigEntry { apiKey?: string; enabled?: boolean; }
function writeConfig(providers: Record<string, ConfigEntry>): void {
  const provider: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(providers)) {
    provider[key] = { options: { apiKey: entry.apiKey ?? "" }, enabled: entry.enabled ?? false };
  }
  writeFileSync(join(tmpHome, ".zcode", "v2", "config.json"), JSON.stringify({ provider }));
}

function writeCredentials(fields: Record<string, string>): void {
  const obj: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = encryptField(v);
  writeFileSync(join(tmpHome, ".zcode", "v2", "credentials.json"), JSON.stringify(obj));
}

const ZAI_CODING_KEY = "ab637d8642234d10a42c119475e5fd4f.mzXTzi4ZBJSkP7fs";
const ZAI_START_JWT = "eyJhbGciOiJIUzI1NiJ9.startplanpayload.sig";
const ZAI_ACCESS_TOKEN = "eyJhbGciOiJIUzUxMiJ9.accesstokenpayload.sig";

describe("decryptZCodeField", () => {
  it("round-trips enc:v1 ciphertext", () => {
    const enc = encryptField("hello world");
    expect(decryptZCodeField(enc)).toBe("hello world");
  });

  it("returns undefined for non-encrypted / malformed input", () => {
    expect(decryptZCodeField(undefined)).toBeUndefined();
    expect(decryptZCodeField("plaintext")).toBeUndefined();
    expect(decryptZCodeField("enc:v1:only.one.dot")).toBeUndefined();
    expect(decryptZCodeField("enc:v1:bad.bad.bad")).toBeUndefined();
  });
});

describe("readZCodeImport", () => {
  it("reads config.json only (no credentials.json) — backward compat", () => {
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: ZAI_CODING_KEY, enabled: false },
      "builtin:zai-start-plan": { apiKey: ZAI_START_JWT, enabled: true },
    });
    // No credentials.json written.

    const src = readZCodeImport("zai");
    // start-plan is enabled → auto-detected.
    expect(src.plan).toBe("start-plan");
    expect(src.apiKey).toBe(ZAI_CODING_KEY); // coding-plan key preferred when present
    expect(src.jwt).toBe(ZAI_START_JWT);
    expect(src.email).toBeUndefined();
    expect(src.isRawAccessToken).toBe(false);
  });

  it("merges email/userId from credentials.json onto config.json's apiKey", () => {
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: ZAI_CODING_KEY, enabled: false },
      "builtin:zai-start-plan": { apiKey: ZAI_START_JWT, enabled: false },
    });
    writeCredentials({
      "zcodejwttoken": ZAI_START_JWT,
      "oauth:zai:user_info": JSON.stringify({ user_id: "uid-123", email: "user@example.com" }),
      "oauth:active_provider": "zai",
    });

    const src = readZCodeImport("zai", "coding-plan");
    expect(src.plan).toBe("coding-plan");
    expect(src.apiKey).toBe(ZAI_CODING_KEY);
    expect(src.isRawAccessToken).toBe(false);
    expect(src.email).toBe("user@example.com");
    expect(src.userId).toBe("uid-123");
    expect(src.jwt).toBe(ZAI_START_JWT);
  });

  it("falls back to credentials.json access_token when config.json has no plaintext apiKey", () => {
    // config.json coding-plan apiKey is empty; start-plan absent too.
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: "", enabled: false },
      "builtin:zai-start-plan": { apiKey: "", enabled: false },
    });
    writeCredentials({
      "oauth:zai:access_token": ZAI_ACCESS_TOKEN,
      "oauth:zai:user_info": JSON.stringify({ user_id: "uid-9", email: "a@b.com" }),
      "oauth:active_provider": "zai",
    });

    const src = readZCodeImport("zai", "coding-plan");
    expect(src.apiKey).toBe(ZAI_ACCESS_TOKEN);
    expect(src.isRawAccessToken).toBe(true); // caller must resolve via KeyResolver
    expect(src.email).toBe("a@b.com");
  });

  it("forcedPlan overrides auto-detection", () => {
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: ZAI_CODING_KEY, enabled: true }, // would auto-detect coding
      "builtin:zai-start-plan": { apiKey: ZAI_START_JWT, enabled: false },
    });
    const src = readZCodeImport("zai", "start-plan");
    expect(src.plan).toBe("start-plan");
  });

  it("throws when no credential exists for the provider", () => {
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: "", enabled: false },
      "builtin:zai-start-plan": { apiKey: "", enabled: false },
    });
    expect(() => readZCodeImport("zai")).toThrow(/No ZCode credential found for zai/);
  });

  it("throws when forced start-plan but no JWT anywhere", () => {
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: ZAI_CODING_KEY, enabled: false },
      "builtin:zai-start-plan": { apiKey: "", enabled: false },
    });
    expect(() => readZCodeImport("zai", "start-plan")).toThrow(/No start-plan JWT for zai/);
  });
});

describe("detectZCodeProvider", () => {
  it("reads active_provider from credentials.json", () => {
    writeConfig({});
    writeCredentials({ "oauth:active_provider": "bigmodel" });
    expect(detectZCodeProvider()).toBe("bigmodel");
  });

  it("returns null when credentials.json absent", () => {
    writeConfig({});
    expect(detectZCodeProvider()).toBeNull();
  });
});

describe("listAvailableZCodeImports", () => {
  it("reports availability per provider×plan from both sources", () => {
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: ZAI_CODING_KEY, enabled: false },
      "builtin:zai-start-plan": { apiKey: ZAI_START_JWT, enabled: true },
      "builtin:bigmodel-coding-plan": { apiKey: "", enabled: false },
      "builtin:bigmodel-start-plan": { apiKey: "", enabled: false },
    });
    const avail = listAvailableZCodeImports();
    const get = (p: string, pl: string) => avail.find(a => a.provider === p && a.plan === pl)?.hasApiKey;
    expect(get("zai", "coding-plan")).toBe(true);
    expect(get("zai", "start-plan")).toBe(true);
    expect(get("bigmodel", "coding-plan")).toBe(false);
    expect(get("bigmodel", "start-plan")).toBe(false);
  });

  it("does NOT attribute the shared start-plan JWT to a non-active provider", () => {
    // zai is active and logged in (start JWT + user_info present). The
    // `zcodejwttoken` field is global — without ownership scoping, bigmodel
    // would falsely report an available start-plan.
    writeConfig({
      "builtin:zai-coding-plan": { apiKey: ZAI_CODING_KEY, enabled: false },
      "builtin:zai-start-plan": { apiKey: "", enabled: false },
      "builtin:bigmodel-coding-plan": { apiKey: "", enabled: false },
      "builtin:bigmodel-start-plan": { apiKey: "", enabled: false },
    });
    writeCredentials({
      "zcodejwttoken": ZAI_START_JWT,
      "oauth:zai:user_info": JSON.stringify({ user_id: "u", email: "a@b.com" }),
      "oauth:active_provider": "zai",
    });
    const avail = listAvailableZCodeImports();
    const get = (p: string, pl: string) => avail.find(a => a.provider === p && a.plan === pl)?.hasApiKey;
    expect(get("zai", "start-plan")).toBe(true);   // zai owns it (active)
    expect(get("bigmodel", "start-plan")).toBe(false); // bigmodel does NOT
    // And importing bigmodel start-plan must throw, not silently succeed.
    expect(() => readZCodeImport("bigmodel", "start-plan")).toThrow();
  });
});
