import { describe, expect, it } from "bun:test";
import { loadConfig } from "../config/loader.js";
import { AuthManager } from "./manager.js";
import { createConfiguredAuthManager, resolveConfiguredCredential } from "./selection.js";
import type { Credential } from "./types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const credential: Credential = { provider: "zai", apiKey: "oauth-key", plan: "coding-plan" };
function config() {
  const dir = mkdtempSync(join(tmpdir(), "credential-selection-"));
  try { const path = join(dir, "config.yaml"); writeFileSync(path, "{}"); return loadConfig(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("configured credential selection", () => {
  it("uses the static key and configured plan without reading OAuth storage", async () => {
    const c = config(); c.provider = "zai"; c.plan = "start-plan"; c.auth = { mode: "apikey", apiKey: "static.secret" };
    const selected = await resolveConfiguredCredential(c, async () => { throw new Error("OAuth storage must not be read"); });
    expect(selected).toMatchObject({ apiKey: "static", secret: "secret", plan: "start-plan", provider: "zai" });
    const auth = createConfiguredAuthManager(c);
    auth.setOAuthCredential(credential);
    expect(await auth.getCredential()).toEqual(selected!);
  });
  it("uses a provider credential when the shared key is absent", async () => {
    const c = config(); c.provider = "bigmodel"; c.auth = { mode: "apikey" }; c.providers.bigmodel.credential = "provider-key";
    expect(await resolveConfiguredCredential(c)).toMatchObject({ provider: "bigmodel", apiKey: "provider-key" });
  });
  it("does not fall back to OAuth when the static key is missing", async () => {
    const c = config(); c.auth = { mode: "apikey" };
    expect(await resolveConfiguredCredential(c, async () => credential)).toBeNull();
  });
  it.each([
    { ...credential, disabled: true },
    { ...credential, expiresAt: Date.now() - 1 },
    { ...credential, provider: "bigmodel" as const },
  ])("rejects an unusable stored credential: %j", async (stored) => {
    const c = config(); c.provider = "zai"; c.auth = { mode: "oauth" };
    expect(await resolveConfiguredCredential(c, async () => stored)).toBeNull();
  });
  it("clears prior credential sources on mode and provider changes", async () => {
    const auth = new AuthManager(); auth.setOAuthCredential(credential);
    auth.updateConfig({ mode: "apikey", provider: "zai", apiKey: "static" });
    expect((await auth.getCredential()).apiKey).toBe("static");
    auth.updateConfig({ mode: "oauth", provider: "bigmodel" });
    await expect(auth.getCredential()).rejects.toThrow("not available");
  });
  it("skips expired, disabled and foreign-provider accounts during failover", async () => {
    const usable = { ...credential, apiKey: "usable" };
    const auth = new AuthManager({ listAllCredentials: async () => [credential,
      { ...credential, apiKey: "expired", expiresAt: Date.now() - 1 },
      { ...credential, apiKey: "disabled", disabled: true },
      { ...credential, apiKey: "foreign", provider: "bigmodel" }, usable] });
    auth.setOAuthCredential(credential);
    expect(await auth.getAvailableCredentialCount()).toBe(2);
    expect(await auth.switchToNextCredential()).toEqual(usable);
  });
  it("keeps static mode isolated from account rotation", async () => {
    const auth = new AuthManager({ mode: "apikey", apiKey: "static", listAllCredentials: async () => [credential, { ...credential, apiKey: "other" }] });
    expect(await auth.switchToNextCredential()).toBeNull();
    expect(await auth.getAvailableCredentialCount()).toBe(1);
    expect((await auth.getCredential()).apiKey).toBe("static");
  });
  it("cannot revive OAuth when config changes while account discovery is pending", async () => {
    let finish!: (value: Credential[]) => void;
    const auth = new AuthManager({ listAllCredentials: () => new Promise(resolve => { finish = resolve; }) });
    auth.setOAuthCredential(credential);
    const switching = auth.switchToNextCredential();
    auth.updateConfig({ mode: "apikey", provider: "zai", apiKey: "new-static" });
    finish([credential, { ...credential, apiKey: "late" }]);
    expect(await switching).toBeNull();
    expect((await auth.getCredential()).apiKey).toBe("new-static");
  });
});
