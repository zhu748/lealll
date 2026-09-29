/**
 * Entry point — load config, create auth manager, start proxy server.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { loadConfig } from "./config/loader.js";
import { AuthManager } from "./auth/manager.js";
import { startServer, type ProxyServer } from "./server/server.js";
import { startControlListener, LogBuffer, type ControlState } from "./android/control.js";
import { loadCredential, saveCredential, clearCredential, getStorePath, exportAccounts, listAccounts } from "./auth/store.js";
import { readZCodeImport } from "./auth/zcode-config.js";
import { ZaiOAuthClient, BigmodelOAuthClient, BigmodelPollOAuthClient, LOGIN_TIMEOUT_MS, parsePastedCallbackUrl, type OAuthResult } from "./auth/oauth.js";
import { KeyResolver } from "./auth/resolver.js";
import type { Credential, PlanId } from "./auth/types.js";
import type { ProviderId } from "./provider/types.js";
import type { ProxyConfig } from "./config/types.js";
import { updateConfigYaml, ensureConfigFile } from "./config/edit.js";
import { openBrowser } from "./runtime/open-browser.js";
import { pasteLoginInstructions, readPastedLine, boldIfTTY } from "./runtime/paste-login.js";
import { buildServerOptions } from "./server/server-options.js";
import { readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ensureNodeFetchNoTimeouts } from "./runtime/node-fetch-compat.js";
import { initPool } from "./proxy/proxy-pool.js";

export const VERSION = "4.7.1-fork.1";

if (require.main === module) main();

export interface ServeArgs {
  configPath?: string;
  debug: boolean;
}

/**
 * Parse `serve` subcommand arguments. The token `debug` toggles debug mode;
 * any other token is treated as the config path. Order-independent:
 *   []                → { debug: false }
 *   ["debug"]         → { debug: true }
 *   ["my.yaml"]       → { configPath: "my.yaml", debug: false }
 *   ["debug","x.yaml"] → { configPath: "x.yaml", debug: true }
 *   ["x.yaml","debug"] → { configPath: "x.yaml", debug: true }
 */
export function parseServeArgs(args: string[]): ServeArgs {
  const debug = args.includes("debug");
  const configPath = args.find((a) => a !== "debug");
  return { configPath, debug };
}

export function main(): void {
  // Fire-and-forget is race-safe: the dynamic import resolves in a microtask,
  // before the listener's event-loop callback can admit a request.
  void ensureNodeFetchNoTimeouts();
  try {
    runCli();
  } catch (err) {
    process.stderr.write(`zcode-proxy: uncaught error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  }
}

function runCli(): void {
  const args = process.argv.slice(2);

  // `--cli` opts out of the default TUI and restores the classic CLI dispatch
  // (bare `--cli` = the old no-arg default: serve).
  if (args[0] === "--cli") {
    dispatchCli(args.slice(1));
    return;
  }
  // Default surface is the TUI. Bare invocation, the retired `tui` token
  // (kept as a silent alias), and tui-style args (`debug`, `*.yaml`) all land
  // here — the former `tui <args>` subcommand simply dropped its prefix.
  if (
    args.length === 0 ||
    args[0] === "tui" ||
    args[0] === "debug" ||
    args[0].endsWith(".yaml") ||
    args[0].endsWith(".yml")
  ) {
    launchTui(parseServeArgs(args[0] === "tui" ? args.slice(1) : args));
    return;
  }
  dispatchCli(args);
}

/** Classic CLI dispatch — subcommand routing where bare = serve. */
function dispatchCli(args: string[]): void {
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "claim") {
    void claimCommand(args.slice(1));
  } else if (cmd === "android") {
    // Explicit catch: an async startup failure (e.g. control port already
    // bound by an orphaned process) must exit non-zero deterministically, not
    // surface as an unhandled rejection.
    runAndroid().catch((err: unknown) => {
      process.stderr.write(`zcode-proxy: android entry failed: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    });
  } else if (cmd === "tui") {
    // Kept for muscle memory under `--cli`: the default dispatch already
    // routes `tui` to the TUI, but `--cli tui` should not regress to an error.
    launchTui(parseServeArgs(args.slice(1)));
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    const serveArgs = cmd === "serve"
      ? parseServeArgs(args.slice(1))
      : parseServeArgs(args);
    serve(serveArgs.configPath, serveArgs.debug);
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

function launchTui(args: ServeArgs): void {
  // Dynamic import: the TUI module imports helpers back from this file, so a
  // static edge would create a load-time cycle (same pattern as claimCommand).
  import("./tui/app.js")
    .then((m) => m.runTui(args))
    .catch((err: unknown) => {
      process.stderr.write(`zcode-proxy: tui failed: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    });
}

function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy                       Interactive terminal UI (default):
                                    login, start/stop, live logs
  zcode-proxy [debug] [config.yaml] Same, with debug diagnostics / custom config
  zcode-proxy serve [config.yaml]   Start the proxy server (classic CLI mode)
  zcode-proxy serve debug [config.yaml]
                                    Start with verbose per-request diagnostics
  zcode-proxy --cli                 Classic CLI mode (bare --cli = serve)
  zcode-proxy android               Android entry: proxy + localhost control listener
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
                                    Optional: --plan=coding-plan|start-plan
  zcode-proxy auth login <provider> --import [--plan=...]
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth export [--output FILE] [--quiet]
                                    Print ZCODE_OAUTH_CREDENTIAL value for Render
  zcode-proxy auth logout           Clear stored credentials
  zcode-proxy auth status           Show current authentication state
  zcode-proxy claim [list|now]      List / claim weekend-plan trial packages
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Terminal UI: login, start/stop, live logs
  zcode-proxy debug                 Terminal UI with per-request diagnostics
  zcode-proxy serve debug           CLI: start with extra debug logging
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel (coding-plan)
  zcode-proxy auth login bigmodel --plan=start-plan
                                    OAuth login targeting the start-plan trial
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth export --output cred.b64
                                    Export credential blob for cloud deploy
  zcode-proxy auth status           Check if logged in
`);
}

/**
 * Build the multi-account AuthManager (fork layer).
 *
 * `listAllCredentials` exposes the full stored-account list so the proxy's
 * retry loop can auto-switch to a different account when the current one
 * fails repeatedly. In apikey mode there's only one credential, so switching
 * is a no-op (switchToNextCredential returns null) — that's fine.
 */
function buildAuthManager(config: ProxyConfig): AuthManager {
  return new AuthManager({
    mode: config.auth.mode ?? "oauth",
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential,
    listAllCredentials: async () => {
      const accounts = await exportAccounts();
      return accounts.map(a => a.credential);
    },
  });
}

async function serve(configPath: string | undefined, debug: boolean): Promise<void> {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) {
    ensureDeviceMidInConfig(path);
    console.log(`Created ${path} from bundled template.`);
    console.log(`Run: zcode-proxy auth login <zai|bigmodel>`);
    console.log(`(or start the server and log in from the dashboard at /admin)\n`);
  }
  const config = loadConfig(path);

  // Fork multi-account layer: the manager owns mode/apikey-vs-oauth and the
  // full-account list for failover switching.
  const auth = buildAuthManager(config);

  if ((config.auth.mode ?? "oauth") === "oauth") {
    const cred = await loadCredential();
    if (!cred) {
      // Fork behavior — DON'T throw / exit: let the server start so the user
      // can open the dashboard and log in via OAuth. The old behavior (exit
      // with "Not logged in") was a chicken-and-egg trap: the user couldn't
      // open the dashboard to log in because the server refused to start
      // (Windows exe double-click scenario). Now: server starts, dashboard is
      // accessible, and any /v1/* request before login returns 503
      // "credential_unavailable" (handled by proxyRequest). The new
      // credential is hot-swapped into the running server via
      // opts.auth.setOAuthCredential — no restart needed.
      console.warn("");
      console.warn("  ⚠  OAuth mode: no credential stored yet.");
      console.warn("  ⚠  The server is starting anyway so you can log in via the dashboard.");
      console.warn(`  ⚠  Open http://127.0.0.1:${config.server.port}/admin and click "OAuth 登录" or "从 ZCode 导入".`);
      console.warn("  ⚠  API requests will return 503 until a credential is added.");
      console.warn("");
    } else {
      auth.setOAuthCredential(cred);
      // Resolve the effective plan from the credential (fork logic). Priority:
      //   1. cred.plan — explicit
      //   2. inferred from cred.jwt — JWTs are start-plan exclusive
      //   3. config.yaml's plan — final fallback
      if (cred.plan || cred.jwt) {
        const effectivePlan: PlanId = cred.plan ?? (cred.jwt ? "start-plan" : config.plan);
        if (effectivePlan !== config.plan) {
          console.log(`  Overriding plan: ${config.plan} → ${effectivePlan} (from credential)`);
          config.plan = effectivePlan;
        }
      }
    }
  }

  if (debug) printDebugBanner(config, path, await loadCredential().catch(() => null));

  // Intercept console.log for admin dashboard log streaming (fork layer).
  // Wrapped so a logging failure never breaks the actual console output.
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const { appendLog, setLogFilePath, flushLogFileForShutdown } = await import("./admin/api.js");

  const serialize = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
    if (a === null || a === undefined || typeof a === "number" || typeof a === "boolean") return String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const logLevelRank = (level: string | undefined): number =>
    level === "debug" ? 0 : level === "info" ? 1 : level === "warn" ? 2 : level === "error" ? 3 : 1;
  const minRank = logLevelRank(config.logging?.level);
  const safeAppend = (level: string, levelRank: number, args: unknown[]) => {
    if (levelRank < minRank) return; // below configured minimum — skip
    try { appendLog(level, args.map(serialize).join(" ")); }
    catch { /* appendLog may throw if log buffer is full; never let it kill the request */ }
  };
  console.log = (...args: unknown[]) => { origLog(...args); safeAppend("info", 1, args); };
  console.error = (...args: unknown[]) => { origError(...args); safeAppend("error", 3, args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); safeAppend("warn", 2, args); };

  // Fork: file logging — mirror dashboard log entries to a JSON-lines file.
  const logFile = config.logging?.file || process.env.ZCODE_PROXY_LOG_FILE;
  if (logFile) setLogFilePath(logFile);

  const server = await startServer(buildServerOptions(config, auth, debug, { configPath: path }));
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy ${VERSION} listening on ${url}`);
  console.log(`  dashboard: ${url}/admin`);
  if (config.plan === "start-plan") {
    // Pre-solve the captcha token pool in the background so first requests
    // don't pay the full solve latency (in-process happy-dom backend).
    import("./proxy/captcha.js")
      .then((m) => m.startCaptchaPool(config.identity.appVersion))
      .catch((err) => console.error(`[captcha] pool warmup failed: ${(err as Error).message}`));
  } else {
    // Fork: multi-account mode — the retry engine may switch to a stored
    // start-plan account mid-request, so pre-solve when ANY stored credential
    // is a start-plan account. Fresh oauth installs skip the pre-solver
    // (nothing can consume the tokens yet; the pool starts lazily after the
    // first start-plan credential is saved — see admin/api.ts
    // ensureCaptchaPoolForStartPlan).
    const storedAccounts = await exportAccounts().catch(() => []);
    const anyStartPlanCredential = storedAccounts.length > 0
      && storedAccounts.some(a => a.credential?.plan === "start-plan" || Boolean(a.credential?.jwt));
    if (anyStartPlanCredential) {
      import("./proxy/captcha.js")
        .then((m) => m.startCaptchaPool(config.identity.appVersion))
        .catch((err) => console.error(`[captcha] pool warmup failed: ${(err as Error).message}`));
    }
  }
  if (config.claim.enabled && config.claim.auto) {
    import("./claim/runtime.js")
      .then((m) => {
        m.startAutoClaim(config, auth);
        console.log(`  claim: auto ON (poll ${Math.round(config.claim.pollIntervalMs / 1000)}s)`);
      })
      .catch((err) => console.error(`[claim] scheduler failed to start: ${(err as Error).message}`));
  }
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  auth mode: ${config.auth.mode ?? "oauth"}`);
  console.log(`  models: ${config.models.length} available`);
  if (config.responses.enabled) console.log(`  /v1/responses: ON`);
  if (config.async.enabled) {
    console.log(config.plan === "coding-plan" ? `  /async/v1/*: ON` : `  /async/v1/*: OFF (requires plan "coding-plan")`);
  }
  if (config.mcp.gateway.enabled) console.log(`  /mcp gateway: ON`);
  if (debug) console.log(`  debug: ON`);

  // Fork: initialize the global outbound proxy pool (reads
  // ~/.zcode-proxy/proxy-pool.json, schedules auto-refresh). Best-effort:
  // errors here don't stop the server.
  try {
    await initPool();
  } catch (e) {
    console.warn(`[proxy-pool] init failed (non-fatal): ${(e as Error).message}`);
  }

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    void flushLogFileForShutdown().catch(() => {});
    server.stop(true);
  });
  process.on("SIGTERM", () => {
    void flushLogFileForShutdown().catch(() => {});
    server.stop(true);
  });
}

/**
 * Desktop-Linux identity defaults for the Android entry (anti-pattern #34).
 * Without these, the Node process on Android reports its true host values:
 * `X-Platform: linux-arm64` and `X-Os-Version: 6.1.xx-android14-…` — a kernel
 * string no real ZCode desktop emits. `identity.ts` reads these env vars per
 * request, so setting them once here retargets every upstream call. Values are
 * deliberately CONSTANT (Ubuntu 24.04 x64 profile — the largest desktop-Linux
 * population): kernel strings are shared by millions of real machines, and
 * stability is required by anti-pattern #13 (never randomize fingerprints).
 * Explicit env values (adb shell setprop / NodeRunner) still win — each is set
 * with `??`, not unconditionally.
 */
export function applyAndroidIdentityDefaults(): void {
  process.env.ZCODE_IDENTITY_PLATFORM = process.env.ZCODE_IDENTITY_PLATFORM ?? "linux";
  process.env.ZCODE_IDENTITY_ARCH = process.env.ZCODE_IDENTITY_ARCH ?? "x64";
  process.env.ZCODE_IDENTITY_RELEASE = process.env.ZCODE_IDENTITY_RELEASE ?? "6.8.0-49-generic";
}

/**
 * Android entry — starts the proxy plus a localhost control listener.
 * Caller (Kotlin shell) must set env: ZCODE_CONTROL_PORT (control listener),
 * ZCODE_OAUTH_CALLBACK_PORT (fixed OAuth callback port for WebView redirect).
 */
async function runAndroid(): Promise<void> {
  applyAndroidIdentityDefaults();
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  ensureConfigFile(path);
  const config = loadConfig(path);

  const logBuffer = new LogBuffer();
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logBuffer.push(args.join(" ")); origLog(...args); };
  console.error = (...args: unknown[]) => { logBuffer.push("[error] " + args.join(" ")); origErr(...args); };
  console.warn = (...args: unknown[]) => { logBuffer.push("[warn] " + args.join(" ")); origWarn(...args); };

  // Fork multi-account layer: same listAllCredentials wiring as serve(), so
  // the retry engine can failover across accounts on Android too.
  const auth = buildAuthManager(config);

  const serverRef: { current: ProxyServer | null } = { current: null };

  async function startProxy(): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
    if (serverRef.current) return { ok: false, error: "already_running" };
    const cred = await loadCredential().catch(() => null);
    if (!cred) return { ok: false, error: "not_logged_in" };
    auth.setOAuthCredential(cred);
    try {
      const s = await startServer(buildServerOptions(config, auth, false, { configPath: path }));
      serverRef.current = s;
      console.log(`zcode-proxy listening on http://${s.hostname}:${s.port}`);
      return { ok: true, port: s.port };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function stopProxy(): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = serverRef.current;
    if (!s) return { ok: false, error: "not_running" };
    try {
      s.stop(false);
      serverRef.current = null;
      console.log("zcode-proxy stopped");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function setConfig(changes: {
    provider?: ProviderId;
    plan?: "coding-plan" | "start-plan";
  }): Promise<{ ok: true; provider: ProviderId; plan: "coding-plan" | "start-plan" } | { ok: false; error: string }> {
    if (serverRef.current) return { ok: false, error: "stop_proxy_first" };
    if (changes.provider) config.provider = changes.provider;
    if (changes.plan) config.plan = changes.plan;
    updateConfigYaml(path, { provider: config.provider, plan: config.plan });
    console.log(`config updated: provider=${config.provider} plan=${config.plan}`);
    return { ok: true, provider: config.provider, plan: config.plan };
  }

  console.log("control listener ready; proxy stopped — use startProxy command to start");

  if (config.claim.enabled && config.claim.auto) {
    import("./claim/runtime.js")
      .then((m) => {
        m.startAutoClaim(config, auth);
        console.log(`[claim] auto ON (poll ${Math.round(config.claim.pollIntervalMs / 1000)}s; waits for login)`);
      })
      .catch((err) => console.error(`[claim] scheduler failed to start: ${(err as Error).message}`));
  }

  const controlPort = Number(process.env.ZCODE_CONTROL_PORT ?? 0) || 0;
  const controlState: ControlState = {
    provider: config.provider,
    plan: config.plan,
    proxyPort: serverRef.current?.port ?? 0,
  };
  const controlListener = await startControlListener({
    port: controlPort,
    state: controlState,
    logBuffer,
    onStartProxy: startProxy,
    onStopProxy: stopProxy,
    onSetConfig: setConfig,
    onShutdown: async () => {
      serverRef.current?.stop(true);
    },
  });

  console.log(`control listener: 127.0.0.1:${controlPort}`);
  console.log(`provider: ${config.provider}`);
  console.log(`plan: ${config.plan}`);

  process.on("SIGINT", () => {
    void controlListener.close().then(() => serverRef.current?.stop(true));
  });
  process.on("SIGTERM", () => {
    void controlListener.close().then(() => serverRef.current?.stop(true));
  });
}

function printDebugBanner(config: ProxyConfig, path: string, cred: Credential | null): void {
  const credShape = cred
    ? `${cred.apiKey.slice(0, 6)}...${cred.apiKey.slice(-4)} (${cred.apiKey.length} chars)`
    : "(none)";
  const active = config.providers[config.provider];
  console.log("=== zcode-proxy DEBUG MODE ===");
  console.log(`  config file: ${path}`);
  console.log(`  server: ${config.server.host}:${config.server.port}`);
  console.log(`  proxy api key: ${config.auth.proxyApiKey ? "required" : "open (no client auth)"}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  identity: appVersion=${config.identity.appVersion} sourceTitle=${config.identity.sourceTitle} referer=${config.identity.refererOrigin}`);
  console.log(`  client identity: mode=${config.clientIdentity.mode} ttl=${config.clientIdentity.ttlSeconds}s max=${config.clientIdentity.maxSessions}`);
  console.log(`  anthropic base: ${active.anthropicBase}`);
  console.log(`  openai base:    ${active.openaiBase}`);
  console.log(`  credential: ${credShape}`);
  console.log(`  models (${config.models.length}): ${config.models.join(", ")}`);
  console.log(`  log level: ${config.logging.level}`);
  console.log("===============================");
}

function authCommand(args: string[]): void {
  const sub = args[0];
  const fail = (err: unknown) => {
    console.error(`auth ${sub} failed: ${(err as Error).message}`);
    process.exit(1);
  };

  if (sub === "login") {
    authLogin(args.slice(1)).catch(fail);
  } else if (sub === "logout") {
    authLogout();
  } else if (sub === "status") {
    authStatus().catch(fail);
  } else if (sub === "export") {
    authExport(args.slice(1)).catch(fail);
  } else {
    console.error("Usage: zcode-proxy auth <login|logout|status|export>");
    process.exit(1);
  }
}

async function claimCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "now";
  if (sub !== "list" && sub !== "now") {
    console.error("Usage: zcode-proxy claim [list|now]");
    process.exit(1);
  }
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  // The billing gateway requires a stable X-Device-Mid — self-heal configs
  // created before the deviceMid feature (idempotent: reuses existing value).
  ensureDeviceMidInConfig(path);
  const config = loadConfig(path);
  try {
    const { runClaimCli } = await import("./claim/runtime.js");
    await runClaimCli(config, sub);
  } catch (err) {
    console.error(`claim failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function authLogin(args: string[]): Promise<void> {
  const provider = args[0] as ProviderId | undefined;
  const importMode = args.includes("--import");
  // Headless paste login: --paste flag or ZCODE_OAUTH_PASTE=1 (docker-friendly).
  const pasteMode =
    args.includes("--paste") || /^(1|true|yes)$/i.test(process.env.ZCODE_OAUTH_PASTE ?? "");
  // Fork layer: explicit plan selection. The release start scripts pass
  // --plan= on every menu item; omitted flags default to coding-plan.
  const planFlag = args.find(a => a.startsWith("--plan="));
  let plan: PlanId = "coding-plan";
  if (planFlag) {
    const rawPlan = planFlag.slice("--plan=".length);
    if (rawPlan === "coding-plan" || rawPlan === "start-plan") {
      plan = rawPlan;
    } else {
      console.error(`Invalid --plan value: ${rawPlan || "(empty)"}`);
      console.error("Expected: --plan=coding-plan or --plan=start-plan");
      process.exit(1);
    }
  }

  if (!provider || (provider !== "zai" && provider !== "bigmodel")) {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import] [--paste] [--plan=coding-plan|start-plan]");
    process.exit(1);
  }
  if (pasteMode && provider !== "bigmodel") {
    console.error("--paste applies to the bigmodel auth-code flow only.");
    console.error("zai login is server-mediated (no localhost callback) and already works headless.");
    process.exit(1);
  }
  if (!planFlag && !importMode) {
    console.log(`[hint] --plan= not specified, defaulting to coding-plan.`);
    console.log(`[hint] If you meant to use start-plan, re-run with: --plan=start-plan`);
    console.log();
  }

  ensureConfigWithDeviceMid();

  const mode = importMode ? "(import)" : pasteMode ? "(OAuth, paste)" : "(OAuth)";
  console.log(`Logging in: ${provider} ${mode} [${plan}]\n`);

  let cred: Credential;

  if (importMode) {
    // Fork import path (readZCodeImport): merges config.json + credentials.json,
    // auto-detects the plan from the enabled flag unless --plan= forces one,
    // and captures the start-plan JWT alongside the coding-plan key.
    const source = readZCodeImport(provider, planFlag ? plan : undefined);
    if (planFlag) {
      console.log(`[import] --plan=${plan} specified, overriding auto-detected plan.`);
    }
    console.log(`[import] Read from ~/.zcode/v2/ (config.json + credentials.json).`);
    if (source.email) console.log(`[import] Email (from credentials.json): ${source.email}`);
    // A raw access_token JWT (no plaintext apiKey in config.json) needs the
    // biz-API exchange to become a usable apiKey.secret.
    if (source.isRawAccessToken) {
      console.log("[import] Resolving access_token via biz API...");
      const resolver = new KeyResolver();
      cred = await resolver.resolveCredential(source.apiKey, source.provider, source.userId, source.plan, source.jwt, source.email);
    } else {
      cred = {
        apiKey: source.apiKey,
        provider: source.provider,
        plan: source.plan,
        jwt: source.jwt,
        userId: source.userId,
        email: source.email,
      };
    }
    // Auto-generate name: prefer `{email}-{plan}` (like OAuth) when we have an
    // email; otherwise fall back to zcode(N)-{plan} numbering.
    if (source.email) {
      cred.name = `${source.email}-${source.plan}`;
    } else {
      try {
        const list = await listAccounts();
        const zcodeCount = list.accounts.filter(a => (a.name || "").startsWith("zcode(")).length;
        cred.name = `zcode(${zcodeCount + 1})-${source.plan}`;
      } catch {
        // Non-fatal: if store read fails, just leave name unset
      }
    }
  } else {
    const { accessToken, userId, jwt, email } = await runOAuth(provider, pasteMode);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    // resolveCredential (fork layer): start-plan JWT fallback — a start-plan
    // login still yields a working credential when the biz API is unavailable.
    cred = await resolver.resolveCredential(accessToken, provider, userId, plan, jwt, email);
    // Auto-generate name from email + plan; store auto-labels when absent.
    if (email) cred.name = `${email}-${plan}`;
  }

  // Import mode: preserve the currently-active credential — the new account
  // is added but NOT activated. The user can switch to it manually via the
  // dashboard. OAuth login (non-import) DOES activate, matching the
  // historical behavior where `auth login` is the primary login flow.
  if (importMode) {
    await saveCredential(cred, { keepActive: true });
  } else {
    await saveCredential(cred);
  }
  console.log(`\nLogged in as ${provider}${cred.plan ? ` [${cred.plan}]` : ""}.`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  if (cred.email) console.log(`  Email:   ${cred.email}`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Stored:  ${getStorePath()}`);
  if (importMode) {
    console.log("  (imported account added WITHOUT activating — switch in the dashboard)");
  }
}

/**
 * Ensure config.yaml exists and carries a stable `identity.deviceMid`.
 * Creates the file from the bundled template when missing (desktop flow;
 * Android's mid comes from NodeRunner env injection instead and is never
 * written here). Returns the mid (existing or freshly generated).
 */
function ensureConfigWithDeviceMid(): string {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) {
    console.log(`Created ${path} from bundled template.`);
  }
  return ensureDeviceMidInConfig(path);
}

/**
 * Generate-or-reuse `identity.deviceMid` in a YAML config via targeted line
 * edit (comments preserved): fills an empty `deviceMid:` value, inserts one
 * under a block-style `identity:` key, or appends a new `identity:` block when
 * the key is absent entirely. Idempotent — an existing non-empty value is
 * returned untouched. The regexes are function-local on purpose: `main()` runs
 * synchronously at module top (before later top-level statements initialize),
 * so any module-level const this function touches would still be undefined on
 * the boot-time `serve` path.
 */
export function ensureDeviceMidInConfig(path: string): string {
  const deviceMidLine = /^(\s*)deviceMid:\s*(.*)$/m;
  const identityBlockLine = /^identity:\s*$/m;
  const raw = readFileSync(path, "utf-8");

  const existing = deviceMidLine.exec(raw);
  if (existing) {
    const value = existing[2].trim().replace(/^"|"$/g, "");
    if (value.length > 0) return value;
  }

  const mid = randomUUID();
  let updated: string;
  if (existing) {
    updated = raw.replace(deviceMidLine, `${existing[1]}deviceMid: "${mid}"`);
  } else if (identityBlockLine.test(raw)) {
    updated = raw.replace(identityBlockLine, `identity:\n  deviceMid: "${mid}"`);
  } else {
    const block = `identity:\n  deviceMid: "${mid}"\n`;
    updated = raw.endsWith("\n") || raw.length === 0 ? raw + block : raw + "\n" + block;
  }
  writeFileSync(path, updated, "utf-8");
  console.log(`Device identity generated: ${mid.slice(0, 8)}… (stored in ${path})`);
  return mid;
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

async function runOAuth(provider: ProviderId, pasteMode: boolean): Promise<OAuthResult> {
  if (provider === "bigmodel" && pasteMode) {
    const oauth = new BigmodelOAuthClient();
    return runPasteLogin(oauth);
  }

  // Both providers use the server-mediated poll login (ZCode 3.12.3 default):
  // the browser never calls back here — open the URL on ANY device and the
  // flow completes server-side while we poll.
  const oauth = provider === "bigmodel" ? new BigmodelPollOAuthClient() : new ZaiOAuthClient();
  const result = await oauth.authorize((url) => {
    console.log("Open this URL to authorize (any device/browser works):\n");
    console.log(`  ${url}\n`);
    console.log("Waiting for authorization... (expires in 300s)\n");
    console.log(
      "After you authorize, the browser may report it cannot open a zcode:// link —\n" +
        "that is expected and safe to ignore; the login completes here automatically.\n",
    );
    openBrowser(url);
  });
  return result;
}

/**
 * Headless bigmodel login (`auth login bigmodel --paste`): the localhost
 * callback server is still bound — it defines the redirect port and the
 * browser can never reach it from inside a container anyway — but instead of
 * waiting on it, the user pastes the redirected URL back. The exact
 * `started.callbackUrl` string is used BOTH as the authorize `redirect` param
 * and as the exchange `redirect_uri` (the token endpoint requires them to
 * match), so the pair stays consistent by construction.
 */
async function runPasteLogin(oauth: BigmodelOAuthClient): Promise<OAuthResult> {
  const started = await oauth.start();
  try {
    console.log(pasteLoginInstructions(started.authorizeUrl, started.callbackUrl, LOGIN_TIMEOUT_MS));
    openBrowser(started.authorizeUrl);
    process.stdout.write("\n" + boldIfTTY("Paste the FULL redirected URL here, then press Enter:") + "\n> ");
    const pasted = await readPastedLine(LOGIN_TIMEOUT_MS);
    const code = parsePastedCallbackUrl(pasted, started.state);
    console.log("\nExchanging authorization code...");
    const tokens = await oauth.exchangeCode(code, started.callbackUrl, started.state);
    return { accessToken: tokens.accessToken, provider: "bigmodel", userId: tokens.userId, jwt: tokens.jwt };
  } finally {
    await oauth.close();
  }
}

/**
 * Export the currently active credential as a base64-encoded JSON blob
 * (fork layer).
 *
 * Purpose: lets users who logged in locally (via `zcode-proxy auth login`)
 * reuse that credential on a remote host (Render, Fly.io, K8s, etc.) where
 * browser-based OAuth isn't possible — the blob feeds the
 * ZCODE_OAUTH_CREDENTIAL env var that store.ts consumes at boot.
 *
 * Usage:
 *   zcode-proxy auth export                          # banner + blob to stdout
 *   zcode-proxy auth export --output cred.b64        # 0600 file
 *   zcode-proxy auth export --quiet                  # blob only (pipeable)
 */
async function authExport(args: string[]): Promise<void> {
  const outputIdx = args.indexOf("--output");
  let outputPath: string | undefined;
  if (outputIdx >= 0 && outputIdx + 1 < args.length) {
    outputPath = args[outputIdx + 1];
  } else if (outputIdx >= 0) {
    console.error("--output requires a file path argument");
    process.exit(1);
  }
  // Also accept --output=<path> form
  const outputEq = args.find(a => a.startsWith("--output="));
  if (outputEq) outputPath = outputEq.slice("--output=".length);
  const quiet = args.includes("--quiet");

  const cred = await loadCredential();
  if (!cred) {
    console.error("Not logged in. Run: zcode-proxy auth login <zai|bigmodel>");
    process.exit(1);
  }

  const json = JSON.stringify(cred);
  const b64 = Buffer.from(json, "utf8").toString("base64");

  if (outputPath) {
    // File mode — write with 0600 (owner-only) permissions to avoid leaking
    // through world-readable files. Bun/Node's fs.writeFileSync mode option
    // is masked by the process umask, so we explicitly chmod after write to
    // guarantee 0600 regardless of umask.
    try {
      writeFileSync(outputPath, b64 + "\n", { mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch (err) {
      console.error(`Failed to write to ${outputPath}: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(`Credential blob written to: ${outputPath}`);
    console.log(`Permissions: 0600 (owner-only)`);
    console.log("");
    console.log("Next steps:");
    console.log(`  scp ${outputPath} remote:/tmp/cred.b64`);
    console.log(`  ssh remote 'export ZCODE_AUTH_MODE=oauth ZCODE_OAUTH_CREDENTIAL=$(cat /tmp/cred.b64)' ...`);
    console.log(`  shred -u ${outputPath}  # secure-delete the local copy when done`);
    console.log("");
    console.log("⚠  Treat this file like a password. Never commit it to git.");
    return;
  }

  if (quiet) {
    // Quiet mode — base64 only, no banner. Suitable for piping to known-safe
    // consumers. WARNING: still appears in scrollback/history — use --output
    // for sensitive workflows.
    process.stdout.write(b64 + "\n");
    return;
  }

  // Legacy mode — banner + blob to stdout (original behavior).
  console.log("=== ZCODE_OAUTH_CREDENTIAL (base64) ===");
  console.log(b64);
  console.log("=== END ===");
  console.log("");
  console.log("To use on Render / Fly.io / K8s:");
  console.log("  1. Copy the base64 blob above (between the === markers).");
  console.log("  2. On your host, set these environment variables:");
  console.log("       ZCODE_AUTH_MODE=oauth");
  console.log("       ZCODE_OAUTH_CREDENTIAL=<paste blob here>");
  console.log("  3. Restart the service.");
  console.log("");
  console.log("⚠  This blob contains your upstream credential in plaintext.");
  console.log("⚠  Treat it like a password. Never commit it to git.");
  console.log("⚠  On Render, mark the env var as Secret so it's masked in logs.");
  console.log("");
  console.log("Tip: use `--output <file>` to write the blob to a 0600 file instead of stdout,");
  console.log("     avoiding terminal scrollback / CI log / screen recording leaks.");
}
