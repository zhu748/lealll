import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildIdentityHeaders, _resetIdentityEnvCacheForTesting } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "3.9.1",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const ENV_KEYS = [
  "ZCODE_IDENTITY_PLATFORM",
  "ZCODE_IDENTITY_ARCH",
  "ZCODE_IDENTITY_RELEASE",
  "ZCODE_IDENTITY_RELEASE_CHANNEL",
  "ZCODE_IDENTITY_CLIENT_LANGUAGE",
  "ZCODE_IDENTITY_CLIENT_TIMEZONE",
  "ZCODE_IDENTITY_DEVICE_MID",
  "ZCODE_ENV",
] as const;

beforeEach(() => {
  _resetIdentityEnvCacheForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetIdentityEnvCacheForTesting();
});

describe("buildIdentityHeaders (pio order, upstream zcode-api v2.6.0 aligned)", () => {
  it("emits User-Agent as ZCode/{appVersion}", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["User-Agent"]).toBe("ZCode/3.9.1");
  });

  it("emits X-ZCode-App-Version (ASCII gate)", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-ZCode-App-Version"]).toBe("3.9.1");
  });

  it("falls back to ZCode/unknown when appVersion is non-ASCII", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "版本③" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBeUndefined();
  });

  it("emits X-Title as Z Code@{sourceTitle}", () => {
    const h = buildIdentityHeaders({ ...BASE, sourceTitle: "cli" });
    expect(h["X-Title"]).toBe("Z Code@cli");
  });

  it("emits HTTP-Referer from refererOrigin", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
  });

  it("emits X-ZCode-Agent glm by default", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-ZCode-Agent"]).toBe("glm");
  });

  it("emits X-Platform as {platform}-{arch}", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Platform"]).toMatch(/^(darwin|linux|win32)-(arm64|x64|arm64|x86)$/);
  });

  it("emits X-Release-Channel production by default (bundle IL())", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Release-Channel"]).toBe("production");
  });

  it("emits X-Release-Channel test when ZCODE_ENV=test", () => {
    process.env.ZCODE_ENV = "test";
    _resetIdentityEnvCacheForTesting();
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Release-Channel"]).toBe("test");
  });

  it("X-Release-Channel env override wins over ZCODE_ENV", () => {
    process.env.ZCODE_ENV = "test";
    process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = "canary";
    _resetIdentityEnvCacheForTesting();
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Release-Channel"]).toBe("canary");
  });

  it("emits X-Client-Language and X-Client-Timezone from Intl", () => {
    const h = buildIdentityHeaders(BASE);
    expect(typeof h["X-Client-Language"]).toBe("string");
    expect(h["X-Client-Language"].length).toBeGreaterThan(0);
    expect(typeof h["X-Client-Timezone"]).toBe("string");
  });

  it("honors ZCODE_IDENTITY_CLIENT_LANGUAGE / CLIENT_TIMEZONE overrides", () => {
    process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = "zh-CN";
    process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = "Asia/Shanghai";
    _resetIdentityEnvCacheForTesting();
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Client-Language"]).toBe("zh-CN");
    expect(h["X-Client-Timezone"]).toBe("Asia/Shanghai");
  });

  it("emits X-Os-Category mapped from platform (macos|windows|linux)", () => {
    const h = buildIdentityHeaders(BASE);
    expect(["macos", "windows", "linux"]).toContain(h["X-Os-Category"]);
  });

  it("emits X-Os-Version from os.release() (model-provider path)", () => {
    const h = buildIdentityHeaders(BASE);
    expect(typeof h["X-Os-Version"]).toBe("string");
    expect(h["X-Os-Version"].length).toBeGreaterThan(0);
  });

  it("emits X-Device-Mid when configured", () => {
    const h = buildIdentityHeaders({ ...BASE, deviceMid: "mid-1234" });
    expect(h["X-Device-Mid"]).toBe("mid-1234");
  });

  it("does NOT emit X-Device-Mid when it is non-ASCII", () => {
    const h = buildIdentityHeaders({ ...BASE, deviceMid: "标识" });
    expect(h["X-Device-Mid"]).toBeUndefined();
  });

  it("ZCODE_IDENTITY_DEVICE_MID env wins over the config value", () => {
    process.env.ZCODE_IDENTITY_DEVICE_MID = "env-mid";
    _resetIdentityEnvCacheForTesting();
    const h = buildIdentityHeaders({ ...BASE, deviceMid: "config-mid" });
    expect(h["X-Device-Mid"]).toBe("env-mid");
  });

  it("honors ZCODE_IDENTITY_PLATFORM/ARCH overrides", () => {
    process.env.ZCODE_IDENTITY_PLATFORM = "linux";
    process.env.ZCODE_IDENTITY_ARCH = "x64";
    _resetIdentityEnvCacheForTesting();
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Platform"]).toBe("linux-x64");
    expect(h["X-Os-Category"]).toBe("linux");
  });

  it("emits the full header set in the bundle pio wire order", () => {
    const h = buildIdentityHeaders(BASE);
    const expectedOrder = [
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-Os-Category",
      "X-Os-Version",
      "X-Device-Mid",
    ];
    const actualOrder = Object.keys(h);
    // All pio headers present (deviceMid optional — not configured here)
    expect(actualOrder).toEqual(expectedOrder.slice(0, expectedOrder.length - 1));
  });
});
