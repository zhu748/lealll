import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager } from "../auth/manager.js";
import { invalidateStoreCache } from "../auth/store.js";
import { loadConfig } from "../config/loader.js";
import { getDashboardHTML, handleAdminRoute, type AdminOptions } from "./api.js";

// Public HTTP contracts survive moves between feature modules. Exercise the
// shared gate for every supported method, including the dynamic DELETE route.
const routeMethods: Array<[string, string[]]> = [
  ["verify", ["GET"]],
  ["config", ["GET", "PUT"]],
  ["credentials", ["GET", "POST", "DELETE"]],
  ["accounts", ["GET"]],
  ["accounts/active", ["PUT"]],
  ["accounts/label", ["PUT"]],
  ["accounts/plan", ["PUT"]],
  ["accounts/proxy", ["PUT"]],
  ["accounts/proxy-test", ["POST"]],
  ["accounts/quota", ["POST"]],
  ["accounts/contract-account", ["DELETE"]],
  ["import", ["POST"]],
  ["import/detect", ["GET"]],
  ["accounts/export", ["GET"]],
  ["accounts/edit", ["PUT"]],
  ["accounts/export-single", ["GET"]],
  ["accounts/disabled", ["PUT"]],
  ["accounts/render-export", ["GET"]],
  ["accounts/import", ["POST"]],
  ["oauth/init", ["POST"]],
  ["oauth/poll", ["GET"]],
  ["oauth/callback", ["POST"]],
  ["endpoints", ["PUT"]],
  ["routing-rules", ["GET", "PUT"]],
  ["model-mappings", ["GET", "PUT"]],
  ["glm-models", ["GET"]],
  ["responses-thinking", ["GET", "PUT"]],
  ["stats", ["GET", "DELETE"]],
  ["logs/stream", ["GET"]],
  ["logs", ["GET"]],
  ["debug-dumps", ["GET", "DELETE"]],
  ["proxy-pool", ["GET"]],
  ["proxy-pool/config", ["PUT"]],
  ["proxy-pool/import-text", ["POST"]],
  ["proxy-pool/import-url", ["POST"]],
  ["proxy-pool/refresh", ["POST"]],
  ["proxy-pool/proxy", ["DELETE"]],
  ["proxy-pool/clear", ["POST"]],
  ["proxy-pool/test-one", ["POST"]],
  ["proxy-pool/test-all", ["POST"]],
  ["proxy-pool/test-status", ["GET"]],
  ["proxy-pool/test-cancel", ["POST"]],
];
const routes = routeMethods.flatMap(([path, methods]) => methods.map(method => ({ path, method })));
const directory = mkdtempSync(join(tmpdir(), "zcode-admin-router-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function options(proxyApiKey: string | undefined, clientIp: string): AdminOptions {
  const config = loadConfig(new URL("../../config.example.yaml", import.meta.url).pathname);
  config.auth.proxyApiKey = proxyApiKey;
  return {
    config,
    auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" }),
    configPath: join(directory, "config.yaml"),
    startTime: Date.now(),
    resolveClientIp: () => clientIp,
    fetchImpl: Object.assign(
      async () => { throw new Error("Denied routes must not fetch"); },
      { preconnect() { throw new Error("Denied routes must not preconnect"); } },
    ),
  };
}

test("every admin API contract requires a valid token before feature dispatch", async () => {
  const opts = options("router-key", "198.51.100.71");
  for (const { path, method } of routes) {
    const response = await handleAdminRoute(new Request(`http://localhost/admin/api/${path}`, {
      method,
      headers: { authorization: "Bearer wrong-key" },
    }), opts);
    expect(response?.status, `${method} ${path}`).toBe(401);
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect(readdirSync(directory)).toEqual([]);
});

test("every admin API contract rejects remote clients when no token is configured", async () => {
  const opts = options(undefined, "198.51.100.72");
  for (const { path, method } of routes) {
    const response = await handleAdminRoute(new Request(`http://localhost/admin/api/${path}`, { method }), opts);
    expect(response?.status, `${method} ${path}`).toBe(401);
    const body = await response!.json();
    expect(body.error.type).toBe("authentication_required");
  }
  expect(readdirSync(directory)).toEqual([]);
});

test("every admin mutation rejects cross-site requests before feature dispatch", async () => {
  const opts = options("router-key", "127.0.0.1");
  for (const { path, method } of routes.filter(route => !["GET", "HEAD", "OPTIONS"].includes(route.method))) {
    const response = await handleAdminRoute(new Request(`http://localhost/admin/api/${path}`, {
      method,
      headers: { authorization: "Bearer router-key", origin: "https://attacker.example" },
    }), opts);
    expect(response?.status, `${method} ${path}`).toBe(403);
    const body = await response!.json();
    expect(body.error.type).toBe("cross_origin_blocked");
  }
  expect(readdirSync(directory)).toEqual([]);
});

test("dashboard HTML stays public and carries security headers", async () => {
  const response = await handleAdminRoute(new Request("http://localhost/admin"), options("router-key", "198.51.100.73"));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toContain("text/html");
  expect(response?.headers.get("content-security-policy")).toBeTruthy();
  expect(await response!.text()).toBe(getDashboardHTML());
});

test("requests outside admin routes remain available to the server dispatcher", async () => {
  const opts = options("router-key", "127.0.0.1");
  for (const path of ["/health", "/v1/messages", "/admin-elsewhere"]) {
    expect(await handleAdminRoute(new Request(`http://localhost${path}`), opts)).toBeNull();
  }
  expect(await handleAdminRoute(new Request("http://localhost/admin/api/unknown", {
    headers: { authorization: "Bearer router-key" },
  }), opts)).toBeNull();
});

test("quota POST specialization preserves the generic account DELETE contract", async () => {
  const previousDirectory = process.env.ZCODE_PROXY_STORE_DIR;
  process.env.ZCODE_PROXY_STORE_DIR = directory;
  invalidateStoreCache();
  try {
    const response = await handleAdminRoute(new Request("http://localhost/admin/api/accounts/quota", {
      method: "DELETE",
      headers: { authorization: "Bearer router-key" },
    }), options("router-key", "127.0.0.1"));
    expect(response?.status).toBe(404);
    expect((await response!.json()).error.message).toBe("Account not found");
  } finally {
    if (previousDirectory === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
    else process.env.ZCODE_PROXY_STORE_DIR = previousDirectory;
    invalidateStoreCache();
  }
});
