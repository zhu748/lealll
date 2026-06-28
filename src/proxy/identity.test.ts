/**
 * Tests for identity header builder.
 *
 * Verified against the ZCode Electron client's app.asar
 * (buildZCodeSourceHeaders / withZCodeEndpointHeaders, 2026-06). The real
 * client sends `ZCode/{appVersion}` as User-Agent plus the full X-ZCode-* /
 * X-Title / HTTP-Referer identity set.
 */
import { describe, it, expect } from "bun:test";
import { buildIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "3.1.8",
  sourceTitle: "Z Code@electron",
  refererOrigin: "https://zcode.z.ai",
};

describe("buildIdentityHeaders", () => {
  it("emits User-Agent as ZCode/{appVersion} (matches real ZCode client)", () => {
    const h = buildIdentityHeaders(BASE);
    // Real ZCode client UA, captured from app.asar buildZCodeSourceHeaders().
    expect(h["User-Agent"]).toBe("ZCode/3.1.8");
  });

  it("emits X-ZCode-App-Version (real ZCode client sends it)", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "9.9.9" });
    expect(h["X-ZCode-App-Version"]).toBe("9.9.9");
    expect(h["User-Agent"]).toBe("ZCode/9.9.9");
  });

  it("emits X-Title from sourceTitle (real ZCode client sends it)", () => {
    const h = buildIdentityHeaders({ ...BASE, sourceTitle: "Z Code@electron" });
    expect(h["X-Title"]).toBe("Z Code@electron");
  });

  it("emits HTTP-Referer from refererOrigin (real ZCode client sends it)", () => {
    const h = buildIdentityHeaders({ ...BASE, refererOrigin: "https://zcode.z.ai" });
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
  });

  it("emits X-Platform as {platform}-{arch}", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    // Format: <process.platform>-<os.arch>, e.g. win32-x64 / linux-x64.
    expect(h["X-Platform"]).toMatch(/^[a-z0-9]+-[a-z0-9]+$/i);
  });

  it("emits X-Os-Category mapped from platform (windows|macos|linux)", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    expect(["windows", "macos", "linux"]).toContain(h["X-Os-Category"]);
  });

  it("emits X-Client-Language and X-Client-Timezone", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    expect(h["X-Client-Language"]).toBeTruthy();
    expect(h["X-Client-Timezone"]).toBeTruthy();
  });

  it("falls back gracefully when appVersion is empty", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBe("unknown");
  });

  // v0.2.3 (2026-06-28 unpacking): identity header ORDER matches the real
  // ZCode desktop client's wire shape (Mf() offset 886853). The previous
  // revision emitted User-Agent → X-ZCode-App-Version → HTTP-Referer →
  // X-Title; the real client emits User-Agent → HTTP-Referer → X-Title →
  // X-ZCode-App-Version. This test pins the corrected order.
  it("emits identity headers in the real ZCode client wire order (v0.2.3+)", () => {
    const h = buildIdentityHeaders(BASE);
    const keys = Object.keys(h);
    const uaIdx = keys.indexOf("User-Agent");
    const refererIdx = keys.indexOf("HTTP-Referer");
    const titleIdx = keys.indexOf("X-Title");
    const appVerIdx = keys.indexOf("X-ZCode-App-Version");
    const platformIdx = keys.indexOf("X-Platform");
    const langIdx = keys.indexOf("X-Client-Language");
    const tzIdx = keys.indexOf("X-Client-Timezone");
    const osCatIdx = keys.indexOf("X-Os-Category");

    // All required headers should be present.
    expect(uaIdx).toBeGreaterThanOrEqual(0);
    expect(refererIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(appVerIdx).toBeGreaterThanOrEqual(0);
    expect(platformIdx).toBeGreaterThanOrEqual(0);
    expect(langIdx).toBeGreaterThanOrEqual(0);
    expect(tzIdx).toBeGreaterThanOrEqual(0);
    expect(osCatIdx).toBeGreaterThanOrEqual(0);

    // Verify the EXACT wire order: UA → Referer → Title → AppVer → Platform →
    // [ReleaseChannel] → Language → Timezone → OsCategory → [OsVersion]
    expect(uaIdx).toBeLessThan(refererIdx);
    expect(refererIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(appVerIdx);
    expect(appVerIdx).toBeLessThan(platformIdx);
    expect(platformIdx).toBeLessThan(langIdx);
    expect(langIdx).toBeLessThan(tzIdx);
    expect(tzIdx).toBeLessThan(osCatIdx);
  });

  // v0.2.3: X-Release-Channel is conditionally emitted — present when set,
  // absent when undefined/empty. Mirrors the real client's
  // `r ? { "X-Release-Channel": r } : {}` conditional.
  it("emits X-Release-Channel when releaseChannel is set (v0.2.3+)", () => {
    const h = buildIdentityHeaders({ ...BASE, releaseChannel: "stable" });
    expect(h["X-Release-Channel"]).toBe("stable");
  });

  it("does NOT emit X-Release-Channel when releaseChannel is undefined (v0.2.3+)", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Release-Channel"]).toBeUndefined();
  });

  it("does NOT emit X-Release-Channel when releaseChannel is empty string (v0.2.3+)", () => {
    const h = buildIdentityHeaders({ ...BASE, releaseChannel: "" });
    expect(h["X-Release-Channel"]).toBeUndefined();
  });

  it("does NOT emit X-Release-Channel when releaseChannel is whitespace-only (v0.2.3+)", () => {
    const h = buildIdentityHeaders({ ...BASE, releaseChannel: "   " });
    expect(h["X-Release-Channel"]).toBeUndefined();
  });

  it("places X-Release-Channel between X-Platform and X-Client-Language when set (v0.2.3+)", () => {
    // Wire order with X-Release-Channel present:
    //   ... → X-Platform → X-Release-Channel → X-Client-Language → ...
    const h = buildIdentityHeaders({ ...BASE, releaseChannel: "stable" });
    const keys = Object.keys(h);
    const platformIdx = keys.indexOf("X-Platform");
    const rcIdx = keys.indexOf("X-Release-Channel");
    const langIdx = keys.indexOf("X-Client-Language");
    expect(platformIdx).toBeLessThan(rcIdx);
    expect(rcIdx).toBeLessThan(langIdx);
  });

  // v0.2.3: X-Os-Version uses os.version() (OS product name), NOT os.release()
  // (kernel version number). The two return different values on every platform:
  //   - Windows: os.version() → "Windows 11 Home China", os.release() → "10.0.22621"
  //   - macOS:   os.version() → "Darwin Kernel Version 24.x.x: ...",
  //              os.release() → "24.0.0"
  //   - Linux:   os.version() → "#1 SMP PREEMPT_DYNAMIC ...",
  //              os.release() → "5.10.134-..."
  // The real ZCode client uses os.version(). Forwarding os.release() was a
  // fingerprint mismatch — fixed in v0.2.3.
  it("emits X-Os-Version using os.version() (NOT os.release()) (v0.2.3+)", () => {
    const h = buildIdentityHeaders(BASE) as unknown as Record<string, string>;
    const os = require("node:os");
    // The emitted value must equal os.version() (whatever that returns on the
    // test host), NOT os.release().
    expect(h["X-Os-Version"]).toBe(os.version());
    expect(h["X-Os-Version"]).not.toBe(os.release());
  });

  it("places X-Os-Version LAST in the identity block (after X-Os-Category) (v0.2.3+)", () => {
    // Wire order with X-Os-Version present:
    //   ... → X-Os-Category → X-Os-Version
    const h = buildIdentityHeaders(BASE);
    const keys = Object.keys(h);
    const osCatIdx = keys.indexOf("X-Os-Category");
    const osVerIdx = keys.indexOf("X-Os-Version");
    expect(osCatIdx).toBeLessThan(osVerIdx);
  });
});
