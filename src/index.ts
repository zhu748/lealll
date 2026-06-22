/**
 * Entry point — load config, create auth manager, start proxy server.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { loadConfig } from "./config/loader.js";
import { EXAMPLE_CONFIG_YAML } from "./config/template.js";
import { AuthManager } from "./auth/manager.js";
import { startServer } from "./server/server.js";
import { loadCredential, saveCredential, clearCredential, getStorePath } from "./auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "./auth/oauth.js";
import { KeyResolver } from "./auth/resolver.js";
import type { Credential, PlanId } from "./auth/types.js";
import type { ProviderId } from "./provider/types.js";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const VERSION = "2.1.1";

main();

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    const configPath = cmd === "serve" ? args[1] : cmd;
    serve(configPath);
  } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`zcode-proxy ${VERSION}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy serve [config.yaml]   Start the proxy server (default)
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
  zcode-proxy auth login <provider> --import
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth logout           Clear stored credentials
  zcode-proxy auth status           Show current authentication state
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Start server with default config.yaml
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth status           Check if logged in
`);
}

async function serve(configPath?: string): Promise<void> {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
    console.log(`Created ${path} from bundled template.`);
    console.log(`Edit auth.apiKey, or run: zcode-proxy auth login <zai|bigmodel>\n`);
  }
  const config = loadConfig(path);

  const auth = new AuthManager({
    mode: config.auth.mode,
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential,
  });

  if (config.auth.mode === "oauth") {
    const cred = await loadCredential();
    if (!cred) {
      console.error("Not logged in. Run: zcode-proxy auth login " + config.provider);
      process.exit(1);
    }
    auth.setOAuthCredential(cred);
    // Sync plan from the stored credential if it has an explicit plan
    if (cred.plan && cred.plan !== config.plan) {
      console.log(`  Overriding plan from credential: ${config.plan} → ${cred.plan}`);
      config.plan = cred.plan;
    }
  }

  // Intercept console.log for admin dashboard log streaming.
  // Wrapped in try/catch so a logging failure never breaks the actual console output.
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const { appendLog } = await import("./admin/api.js");
  const safeAppend = (level: string, args: unknown[]) => {
    try { appendLog(level, args.map(a => typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(" ")); }
    catch (e) { /* appendLog itself may throw if log buffer is full; never let it kill the request */ void e; }
  };
  console.log = (...args: unknown[]) => { origLog(...args); safeAppend("info", args); };
  console.error = (...args: unknown[]) => { origError(...args); safeAppend("error", args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); safeAppend("warn", args); };

  const server = startServer({ config, auth, configPath: path });
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy listening on ${url}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  auth mode: ${config.auth.mode}`);
  console.log(`  models: ${config.models.length} available`);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.stop(true);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}

function authCommand(args: string[]): void {
  const sub = args[0];

  if (sub === "login") {
    authLogin(args.slice(1));
  } else if (sub === "logout") {
    authLogout();
  } else if (sub === "status") {
    authStatus();
  } else {
    console.error("Usage: zcode-proxy auth <login|logout|status>");
    process.exit(1);
  }
}

async function authLogin(args: string[]): Promise<void> {
  const provider = args[0] as ProviderId | undefined;
  const importMode = args.includes("--import");
  const planFlag = args.find(a => a.startsWith("--plan="));
  const plan: PlanId = planFlag === "--plan=start-plan" ? "start-plan" : "coding-plan";

  if (!provider || (provider !== "zai" && provider !== "bigmodel")) {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import] [--plan=coding-plan|start-plan]");
    process.exit(1);
  }

  console.log(`Logging in: ${provider}${importMode ? " (import)" : " (OAuth)"} [${plan}]\n`);

  let cred: Credential;

  if (importMode) {
    cred = importFromZCodeConfig(provider, plan);
  } else {
    const { accessToken, userId, jwt } = await runOAuth(provider);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId, plan);
    if (jwt) cred.jwt = jwt;
  }

  await saveCredential(cred);
  console.log(`\nLogged in as ${provider} (${plan}).`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Plan:    ${cred.plan}`);
  console.log(`  Stored:  ${getStorePath()}`);
}

function authLogout(): void {
  if (!existsSync(getStorePath())) {
    console.log("Not logged in.");
    return;
  }
  clearCredential();
  console.log("Logged out. Credentials removed.");
}

async function authStatus(): Promise<void> {
  const cred = await loadCredential();
  if (!cred) {
    console.log("Not logged in.");
    console.log("Run: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  console.log(`Logged in: ${cred.provider}`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  console.log(`  Plan:    ${cred.plan || "(not set — uses config.yaml)"}`);
  if (cred.jwt) console.log(`  JWT:     ${cred.jwt.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Store:   ${getStorePath()}`);
}

async function runOAuth(provider: ProviderId): Promise<{ accessToken: string; userId?: string; jwt?: string }> {
  if (provider === "bigmodel") {
    const oauth = new BigmodelOAuthClient();
    const result = await oauth.authorize((url) => {
      console.log("Open this URL to authorize:\n");
      console.log(`  ${url}\n`);
      console.log("Waiting for authorization... (expires in 300s)\n");
      openBrowser(url);
    });
    return { accessToken: result.accessToken, userId: result.userId, jwt: result.jwt };
  }

  const oauth = new ZaiOAuthClient();
  const init = await oauth.init("zai");

  console.log("Open this URL to authorize:\n");
  console.log(`  ${init.authorizeUrl}\n`);
  console.log(`Waiting... (expires in ${Math.floor((init.expiresAt - Date.now()) / 1000)}s)\n`);

  openBrowser(init.authorizeUrl);

  const result = await oauth.waitForAuth(init);
  return { accessToken: result.accessToken, userId: result.userId, jwt: result.jwt };
}

function importFromZCodeConfig(provider: ProviderId, plan: PlanId = "coding-plan"): Credential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Cannot read ${configPath}.`);
    console.error("Make sure ZCode is installed and you've logged in at least once.");
    process.exit(1);
  }

  const config = JSON.parse(raw) as {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };

  // Read both plan keys from ZCode config
  const codingPlanKey = `builtin:${provider}-coding-plan`;
  const startPlanKey = `builtin:${provider}-start-plan`;
  const codingPlanApiKey = config.provider?.[codingPlanKey]?.options?.apiKey?.trim() || "";
  const startPlanToken = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || "";

  if (plan === "start-plan") {
    // For start-plan: the primary credential is the JWT from start-plan key.
    // The coding-plan API key is still useful as a fallback identifier.
    if (!startPlanToken && !codingPlanApiKey) {
      console.error(`No credential found for ${provider} in ZCode config.`);
      console.error(`Tried: ${codingPlanKey}, ${startPlanKey}`);
      process.exit(1);
    }
    const apiKey = codingPlanApiKey || startPlanToken; // fallback if no coding-plan key
    const jwt = startPlanToken || undefined;
    console.log(`Imported from ${configPath} (start-plan)`);
    if (jwt) console.log(`  Start-plan JWT: ${jwt.slice(0, 12)}...`);
    if (codingPlanApiKey) console.log(`  Coding-plan API Key: ${codingPlanApiKey.slice(0, 8)}...`);
    return { apiKey, provider, plan, jwt };
  }

  // For coding-plan: the primary credential is the API key.
  // Also capture start-plan JWT if available (stored for potential plan switch later).
  if (!codingPlanApiKey) {
    console.error(`No API key for ${codingPlanKey} in ZCode config.`);
    if (startPlanToken) {
      console.error(`Hint: Found a start-plan token. Use --plan=start-plan to import it instead.`);
    }
    process.exit(1);
  }

  const jwt = startPlanToken || undefined;
  console.log(`Imported from ${configPath} (coding-plan)`);
  if (jwt) console.log(`  Start-plan JWT also captured: ${jwt.slice(0, 12)}...`);
  return { apiKey: codingPlanApiKey, provider, plan, jwt };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", `start "" "${url}"`], {
        detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* user copies URL manually */ }
}
