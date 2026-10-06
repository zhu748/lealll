import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config/loader.js";
import { persistConfig } from "./config.js";

it("retains every upstream feature gate and settings after a dashboard save/reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-roundtrip-")); const path = join(dir, "custom.yaml");
  try {
    writeFileSync(path, "{}"); const c = loadConfig(path);
    c.auth = { mode: "apikey", apiKey: "static-test-key", proxyApiKey: "proxy-test-key" };
    c.clientIdentity.mode = "off"; c.clientIdentity.maxSessions = 37;
    c.responses.enabled = false; c.responses.storeMaxEntries = 17;
    c.endpointRouting.enabled = false; c.clientSigning.enabled = false;
    c.mcp.enabled = false; c.mcp.gateway.enabled = false; c.mcp.usageEnabled = false;
    c.async.enabled = false; c.async.maxWaitMs = 12345;
    c.claim.enabled = false; c.claim.auto = false; c.claim.planId = "preserved-plan"; c.claim.cooldownMs = 12345;
    c.clientConfig = { refreshOnStart: false, origin: "https://offline-client-config.test", timeoutMs: 4321 };
    c.subscription = { checkOnSwitch: false, origin: "https://offline-subscription.test", timeoutMs: 4321 };
    const before = structuredClone(c); await persistConfig(c, path); const reloaded = loadConfig(path);
    for (const field of ["auth", "clientIdentity", "responses", "endpointRouting", "clientSigning", "mcp", "async", "claim", "clientConfig", "subscription"] as const) {
      expect(reloaded[field]).toEqual(before[field]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
