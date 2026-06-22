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

const VERSION = "2.1.3.6beta0";

main();

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    // `serve` may be followed by either a positional path or `--config <path>`
    // (or `--config=<path>`). The legacy start.bat/start.sh used `--config`,
    // which the old parser mis-read as the path itself — creating a file
    // literally named `--config` and silently loading the bundled template.
    const configPath = cmd === "serve" ? parseServeConfigArg(args.slice(1)) : cmd;
    serve(configPath).catch(fatalError);
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

/**
 * Parse the arguments after `serve`, accepting both forms:
 *   zcode-proxy serve config.yaml
 *   zcode-proxy serve --config config.yaml
 *   zcode-proxy serve --config=config.yaml
 */
function parseServeConfigArg(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--config" && i + 1 < rest.length) return rest[i + 1];
    if (a.startsWith("--config=")) return a.slice("--config=".length);
    if (!a.startsWith("-")) return a; // first positional non-flag arg
  }
  return undefined;
}

/**
 * Last-resort error handler. Prints the error and waits briefly so the user
 * can read it before the window closes — important on Windows where
 * double-clicking the exe gives no parent terminal to scroll back.
 */
async function fatalError(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\n[FATAL] " + msg);
  console.error("\nServer could not start. This window will close in 15 seconds.");
  // Give the user time to read the message before the window disappears.
  // 15s is long enough to read but short enough to not feel stuck when run
  // from an interactive terminal.
  await new Promise(r => setTimeout(r, 15_000));
  process.exit(1);
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
      throw new Error(
        `Not logged in for OAuth mode. Run this in a terminal first:\n` +
        `    zcode-proxy auth login ${config.provider}\n` +
        `Or edit ${path} and set:\n` +
        `    auth.mode: apikey\n` +
        `    auth.apiKey: <your-key>`,
      );
    }
    auth.setOAuthCredential(cred);
    // Resolve the effective plan from the credential. Priority:
    //   1. cred.plan — explicit (set by v0.1.4+ import or dashboard)
    //   2. inferred from cred.jwt — if a JWT is present, the credential
    //      came from start-plan flow (JWTs are start-plan exclusive).
    //      This handles v1 imports from zcode-api-ref which have no plan
    //      field but DO carry a start-plan JWT.
    //   3. config.yaml's plan — final fallback (default coding-plan)
    //
    // The credential's plan (explicit or inferred) wins over config.yaml
    // because the credential determines which upstream URL and auth headers
    // we use — sending a start-plan JWT to a coding-plan endpoint would
    // fail with 401, and a coding-plan API key to zcode.z.ai would fail too.
    let effectivePlan: PlanId;
    let planSource: string;
    if (cred.plan) {
      effectivePlan = cred.plan;
      planSource = `explicit on credential`;
    } else if (cred.jwt) {
      effectivePlan = "start-plan";
      planSource = `inferred from JWT presence (v1 credential, no plan field)`;
    } else {
      // No plan on credential, no JWT — use config.yaml verbatim.
      // Don't change config.plan; just log the source.
      console.log(`  Using plan from config.yaml: ${config.plan}`);
      effectivePlan = config.plan;
      planSource = ""; // unused
    }

    if (cred.plan || cred.jwt) {
      // We inferred/overrode the plan from the credential
      if (effectivePlan !== config.plan) {
        console.log(`  Overriding plan: ${config.plan} → ${effectivePlan} (source: ${planSource})`);
        config.plan = effectivePlan;
      } else {
        console.log(`  Plan: ${effectivePlan} (source: ${planSource})`);
      }
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
  console.log(`zcode-proxy ${VERSION} listening on ${url}`);
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
    authLogin(args.slice(1)).catch(fatalError);
  } else if (sub === "logout") {
    authLogout();
  } else if (sub === "status") {
    authStatus().catch(fatalError);
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

  // Helpful hint when --plan= is omitted. For --import mode, the proxy
  // auto-detects the active plan from ZCode config, so no hint needed.
  // For OAuth mode, plan determines which credential structure to build,
  // so we remind the user to be explicit if they omit it.
  if (!planFlag && !importMode) {
    console.log(`[hint] --plan= not specified, defaulting to coding-plan.`);
    console.log(`[hint] If you meant to use start-plan, re-run with: --plan=start-plan`);
    console.log();
  }

  console.log(`Logging in: ${provider}${importMode ? " (import)" : " (OAuth)"} [${plan}]\n`);

  let cred: Credential;

  if (importMode) {
    // For --import: pass undefined when --plan= was NOT specified, so
    // importFromZCodeConfig can auto-detect from ZCode config's enabled flag.
    // Only pass plan when user explicitly set --plan= (forced override).
    cred = importFromZCodeConfig(provider, planFlag ? plan : undefined);
  } else {
    const { accessToken, userId, jwt } = await runOAuth(provider);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId, plan);
    if (jwt) cred.jwt = jwt;
  }

  await saveCredential(cred);
  // Use cred.plan (auto-detected) instead of the local `plan` variable,
  // because import mode may have auto-detected a different plan than the default.
  const actualPlan = cred.plan || plan;
  console.log(`\nLogged in as ${provider} (${actualPlan}).`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Plan:    ${actualPlan}`);
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

function importFromZCodeConfig(provider: ProviderId, forcedPlan?: PlanId): Credential {
  // Auto-detect the active plan from ZCode config:
  //   - The plan with `enabled: true` in ZCode config is the user's currently
  //     subscribed plan. Use that as the imported credential's plan.
  //   - `--plan=` flag (forcedPlan) overrides auto-detection — useful when the
  //     user wants to import a specific plan even if it's not the active one.
  //
  // This preserves multi-account support: if ZCode config has both plans
  // enabled (rare but possible), the user can run `--import` twice with
  // `--plan=coding-plan` and `--plan=start-plan` to get two separate accounts.
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
    provider?: Record<string, {
      options?: { apiKey?: string };
      enabled?: boolean;
      systemDisabledReason?: string;
    }>;
  };

  const codingPlanKey = `builtin:${provider}-coding-plan`;
  const startPlanKey = `builtin:${provider}-start-plan`;
  const codingEntry = config.provider?.[codingPlanKey];
  const startEntry = config.provider?.[startPlanKey];
  const codingPlanApiKey = codingEntry?.options?.apiKey?.trim() || "";
  const startPlanToken = startEntry?.options?.apiKey?.trim() || "";

  // Auto-detect: which plan is actually enabled in ZCode config?
  // `enabled: true` means the user is actively subscribed to that plan.
  let detectedPlan: PlanId | null = null;
  if (codingEntry?.enabled === true && codingPlanApiKey) detectedPlan = "coding-plan";
  else if (startEntry?.enabled === true && startPlanToken) detectedPlan = "start-plan";

  // User-supplied --plan= overrides detection
  const plan: PlanId = forcedPlan ?? detectedPlan ?? "coding-plan";

  if (forcedPlan) {
    console.log(`[import] --plan=${forcedPlan} specified, overriding auto-detected plan (${detectedPlan ?? "none"})`);
  } else if (detectedPlan) {
    console.log(`[import] Auto-detected active plan: ${detectedPlan}`);
  } else {
    console.log(`[import] No 'enabled: true' plan found in ZCode config — defaulting to coding-plan.`);
    console.log(`[import] If this is wrong, re-run with --plan=start-plan`);
  }

  if (plan === "start-plan") {
    // start-plan: primary credential is the JWT
    if (!startPlanToken) {
      console.error(`No start-plan JWT in ZCode config (looked for ${startPlanKey}).`);
      console.error(`Available: coding-plan API key=${codingPlanApiKey ? "yes" : "no"}`);
      process.exit(1);
    }
    console.log(`Imported from ${configPath} (start-plan)`);
    console.log(`  Start-plan JWT:     ${startPlanToken.slice(0, 12)}...`);
    if (codingPlanApiKey) console.log(`  Coding-plan API Key (captured for fallback): ${codingPlanApiKey.slice(0, 12)}...`);
    return { apiKey: codingPlanApiKey || startPlanToken, provider, plan, jwt: startPlanToken };
  }

  // coding-plan: primary credential is the API key
  if (!codingPlanApiKey) {
    console.error(`No coding-plan API key in ZCode config (looked for ${codingPlanKey}).`);
    if (startPlanToken) {
      console.error(`Found a start-plan JWT — re-run with --plan=start-plan to import that instead.`);
    }
    process.exit(1);
  }
  const jwt = startPlanToken || undefined;
  console.log(`Imported from ${configPath} (coding-plan)`);
  console.log(`  Coding-plan API Key: ${codingPlanApiKey.slice(0, 12)}...`);
  if (jwt) console.log(`  Start-plan JWT (also captured): ${jwt.slice(0, 12)}...`);
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
