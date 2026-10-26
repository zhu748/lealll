/**
 * Tests for the exported pure functions (`parseServeArgs`,
 * `applyAndroidIdentityDefaults`).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseServeArgs, applyAndroidIdentityDefaults, ensureDeviceMidInConfig, ensureIdentitySelfHeal } from "./index.js";
import { DEFAULT_APP_VERSION } from "./config/loader.js";
import { buildIdentityHeaders } from "./proxy/identity.js";
import { parse } from "yaml";

const IDENTITY_ENV_KEYS = [
  "ZCODE_IDENTITY_PLATFORM",
  "ZCODE_IDENTITY_ARCH",
  "ZCODE_IDENTITY_RELEASE",
] as const;

const savedEnv: Record<string, string | undefined> = {};

describe("parseServeArgs", () => {
  it("returns debug=false with no args", () => {
    expect(parseServeArgs([])).toEqual({ configPath: undefined, debug: false });
  });

  it("returns debug=true with lone 'debug' token", () => {
    expect(parseServeArgs(["debug"])).toEqual({ configPath: undefined, debug: true });
  });

  it("treats a single non-debug token as the config path", () => {
    expect(parseServeArgs(["my.yaml"])).toEqual({ configPath: "my.yaml", debug: false });
  });

  it("accepts 'debug' before the config path", () => {
    expect(parseServeArgs(["debug", "custom.yaml"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
    });
  });

  it("accepts 'debug' after the config path (order-independent)", () => {
    expect(parseServeArgs(["custom.yaml", "debug"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
    });
  });

  it("is case-sensitive — only lowercase 'debug' toggles the flag", () => {
    expect(parseServeArgs(["DEBUG"])).toEqual({ configPath: "DEBUG", debug: false });
  });
});

describe("applyAndroidIdentityDefaults", () => {
  afterEach(() => {
    for (const k of IDENTITY_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
      delete savedEnv[k];
    }
  });

  function snapshotEnv(): void {
    for (const k of IDENTITY_ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  }

  it("injects a stable desktop-Linux profile when no overrides are set", () => {
    snapshotEnv();
    applyAndroidIdentityDefaults();
    expect(process.env.ZCODE_IDENTITY_PLATFORM).toBe("linux");
    expect(process.env.ZCODE_IDENTITY_ARCH).toBe("x64");
    expect(process.env.ZCODE_IDENTITY_RELEASE).toBe("6.8.0-49-generic");
  });

  it("never clobbers explicit env overrides", () => {
    snapshotEnv();
    process.env.ZCODE_IDENTITY_PLATFORM = "linux";
    process.env.ZCODE_IDENTITY_ARCH = "arm64";
    process.env.ZCODE_IDENTITY_RELEASE = "6.1.0-26-amd64";
    applyAndroidIdentityDefaults();
    expect(process.env.ZCODE_IDENTITY_ARCH).toBe("arm64");
    expect(process.env.ZCODE_IDENTITY_RELEASE).toBe("6.1.0-26-amd64");
  });

  it("produces headers free of any Android telltales", () => {
    snapshotEnv();
    applyAndroidIdentityDefaults();
    const h = buildIdentityHeaders({ appVersion: "3.8.1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" });
    const blob = JSON.stringify(h).toLowerCase();
    expect(h["X-Platform"]).toBe("linux-x64");
    expect(h["X-Os-Category"]).toBe("linux");
    expect(h["X-Os-Version"]).toBe("6.8.0-49-generic");
    expect(blob).not.toContain("android");
    expect(blob).not.toContain("aarch64");
  });
});

const MID_TMP = join(tmpdir(), `zcode-proxy-mid-test-${Date.now()}`);

function writeConfig(content: string): string {
  mkdirSync(MID_TMP, { recursive: true });
  const p = join(MID_TMP, "config.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ensureDeviceMidInConfig", () => {
  afterEach(() => {
    rmSync(MID_TMP, { recursive: true, force: true });
  });

  it("fills an empty deviceMid in place and preserves surrounding comments", () => {
    const p = writeConfig(`identity:
  appVersion: "3.8.1"  # keep me
  deviceMid: ""
other: 1
`);
    const mid = ensureDeviceMidInConfig(p);
    expect(mid).toMatch(UUID_RE);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain("# keep me");
    expect(after).toContain(`deviceMid: "${mid}"`);
    expect(after).toContain("other: 1");
  });

  it("inserts deviceMid under an existing identity: block", () => {
    const p = writeConfig(`identity:
  appVersion: "3.8.1"
`);
    const mid = ensureDeviceMidInConfig(p);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain(`identity:
  deviceMid: "${mid}"
  appVersion: "3.8.1"`);
  });

  it("appends an identity: block when the key is absent entirely", () => {
    const p = writeConfig(`server:
  port: 8080
`);
    const mid = ensureDeviceMidInConfig(p);
    const after = readFileSync(p, "utf-8");
    expect(after.endsWith(`identity:
  deviceMid: "${mid}"
`)).toBeTrue();
  });

  it("is idempotent — an existing mid is returned and the file untouched", () => {
    const existing = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
    const p = writeConfig(`identity:
  deviceMid: "${existing}"
`);
    const before = readFileSync(p, "utf-8");
    expect(ensureDeviceMidInConfig(p)).toBe(existing);
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  it("produces a mid that buildIdentityHeaders emits as X-Device-Mid", () => {
    const p = writeConfig(`identity:
  appVersion: "3.8.1"
`);
    const mid = ensureDeviceMidInConfig(p);
    const h = buildIdentityHeaders({ appVersion: "3.8.1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", deviceMid: mid });
    expect(h["X-Device-Mid"]).toBe(mid);
  });

  it("fills an unquoted empty value without swallowing the following line", () => {
    const p = writeConfig("identity:\n  deviceMid:\n  appVersion: '3.8.1'\n");
    const mid = ensureDeviceMidInConfig(p);
    const value = parse(readFileSync(p, "utf-8"));
    expect(mid).toMatch(UUID_RE);
    expect(value.identity.deviceMid).toBe(mid);
    expect(value.identity.appVersion).toBe("3.8.1");
  });

  it("fills a comment-only value and preserves its comment", () => {
    const p = writeConfig("identity:\n  deviceMid: # keep identity stable\n  appVersion: '3.8.1'\n");
    const mid = ensureDeviceMidInConfig(p);
    const content = readFileSync(p, "utf-8");
    expect(parse(content).identity.deviceMid).toBe(mid);
    expect(content).toContain("# keep identity stable");
  });

  it("reuses single-quoted and inline identity maps without rewriting them", () => {
    for (const content of ["identity:\n  deviceMid: 'existing-id' # keep\n", "identity: { deviceMid: existing-id, appVersion: '3.8.1' }\n"]) {
      const p = writeConfig(content);
      expect(ensureDeviceMidInConfig(p)).toBe("existing-id");
      expect(readFileSync(p, "utf-8")).toBe(content);
    }
  });

  it("does not mistake another section's deviceMid for the configured identity", () => {
    const p = writeConfig("other:\n  deviceMid: unrelated\nidentity: {}\n");
    const mid = ensureDeviceMidInConfig(p);
    const value = parse(readFileSync(p, "utf-8"));
    expect(mid).toMatch(UUID_RE);
    expect(value.other.deviceMid).toBe("unrelated");
    expect(value.identity.deviceMid).toBe(mid);
  });

  it.each(["identity: [broken\n", "identity: not-a-map\n", "- not-a-root-map\n"])(
    "rejects malformed configuration before changing it (%s)", (content) => {
      const p = writeConfig(content);
      expect(() => ensureDeviceMidInConfig(p)).toThrow();
      expect(readFileSync(p, "utf-8")).toBe(content);
    },
  );
});

describe("ensureIdentitySelfHeal", () => {
  afterEach(() => {
    rmSync(MID_TMP, { recursive: true, force: true });
  });

  it("fills a missing deviceMid AND bumps a template-era appVersion in one pass", () => {
    const p = writeConfig(`identity:
  appVersion: "3.9.2"
  deviceMid: ""
`);
    ensureIdentitySelfHeal(p);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain(`appVersion: "${DEFAULT_APP_VERSION}"`);
    expect(after).toMatch(/deviceMid: "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/);
  });

  it("appends an identity block for pre-identity configs and bumps the pin", () => {
    const p = writeConfig(`server:
  port: 8080
`);
    ensureIdentitySelfHeal(p);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain(`identity:\n  deviceMid: "`);
    expect(after).not.toContain("appVersion"); // absent pin → loader default, nothing injected
  });

  it("preserves a NEWER or custom appVersion pin", () => {
    const p = writeConfig(`identity:
  appVersion: "99.0.0"
  deviceMid: "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0"
`);
    const before = readFileSync(p, "utf-8");
    ensureIdentitySelfHeal(p);
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  it("preserves non-numeric custom values (fail-safe)", () => {
    const p = writeConfig(`identity:
  appVersion: "my-custom-build"
  deviceMid: "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0"
`);
    const before = readFileSync(p, "utf-8");
    ensureIdentitySelfHeal(p);
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const p = writeConfig(`identity:
  appVersion: "3.10.0"
  deviceMid: ""
`);
    ensureIdentitySelfHeal(p);
    const once = readFileSync(p, "utf-8");
    ensureIdentitySelfHeal(p);
    expect(readFileSync(p, "utf-8")).toBe(once);
    expect(once).toContain(`appVersion: "${DEFAULT_APP_VERSION}"`);
  });

  it("updates an inline identity map without creating duplicate keys", () => {
    const p = writeConfig("identity: { appVersion: '3.8.1', deviceMid: '' }\nother: keep\n");
    ensureIdentitySelfHeal(p);
    const value = parse(readFileSync(p, "utf-8"));
    expect(value.identity.appVersion).toBe(DEFAULT_APP_VERSION);
    expect(value.identity.deviceMid).toMatch(UUID_RE);
    expect(value.other).toBe("keep");
  });

  it("updates a version with an inline comment and keeps unrelated version fields", () => {
    const p = writeConfig("other:\n  appVersion: '1.0'\nidentity:\n  deviceMid: existing\n  appVersion: '3.8.1' # keep version comment\n");
    ensureIdentitySelfHeal(p);
    const content = readFileSync(p, "utf-8");
    const value = parse(content);
    expect(value.identity.appVersion).toBe(DEFAULT_APP_VERSION);
    expect(value.other.appVersion).toBe("1.0");
    expect(content).toContain("# keep version comment");
  });

  it.each(["3..1", "3.1.", "3.+1", "3.1e2", "3.9007199254740993"])(
    "preserves malformed or unsafe version segments (%s)", (version) => {
      const p = writeConfig(`identity:\n  deviceMid: existing\n  appVersion: '${version}'\n`);
      const content = readFileSync(p, "utf-8");
      ensureIdentitySelfHeal(p);
      expect(readFileSync(p, "utf-8")).toBe(content);
    },
  );
});
