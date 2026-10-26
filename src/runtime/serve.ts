/** Headless proxy startup and shutdown. */
import { hostSetTimeout } from "../utils/host-timers.js";
import { loadConfig } from "../config/loader.js";
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";
import { createConfiguredAuthManager, resolveConfiguredCredential } from "../auth/selection.js";
import { resolveEffectivePlan } from "../auth/plan.js";
import { exportAccounts } from "../auth/store.js";
import { startServer, type ProxyServer } from "../server/server.js";
import { buildServerOptions } from "../server/server-options.js";
import { resolvePanelSettings, type PanelServer } from "../server/panel.js";
import { startServePanel } from "./serve-panel.js";
import { installLogTee } from "./log-tee.js";
import { createCaptchaRuntime } from "./captcha-runtime.js";
import { ensureConfigFile } from "../config/edit.js";
import { ensureIdentitySelfHeal } from "./identity-config.js";
import { initPool } from "../proxy/proxy-pool.js";
import { checkForUpdate } from "../update/check.js";
import { shutdownAllHighspeed } from "../highspeed/manager.js";
import { VERSION } from "../version.js";

export async function serve(configPath: string | undefined, debug: boolean): Promise<void> {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) {
    console.log(`Created ${path} from bundled template.`);
    console.log(`Run: zcode-proxy auth login <zai|bigmodel>`);
    console.log(`(or start the server and log in from the dashboard at /admin)\n`);
  }
  // Self-heal EXISTING configs too: pre-deviceMid configs boot without an
  // X-Device-Mid (billing preview → 3001, balance → HTTP 400) and old
  // templates pin an appVersion the billing campaign list no longer serves.
  ensureIdentitySelfHeal(path);
  const config = loadConfig(path);

  const panelSettings = resolvePanelSettings();
  const panelLogBuffer = panelSettings ? installLogTee() : null;

  // Fork multi-account layer: the manager owns mode/apikey-vs-oauth and the
  // full-account list for failover switching.
  const auth = createConfiguredAuthManager(config);

  if ((config.auth.mode ?? "oauth") === "oauth") {
    const cred = await resolveConfiguredCredential(config);
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
      const effectivePlan = resolveEffectivePlan(cred, config.plan);
      if (effectivePlan !== config.plan) {
        console.log(`  Overriding plan: ${config.plan} → ${effectivePlan} (from credential)`);
        config.plan = effectivePlan;
      }
    }
  }

  if (debug) printDebugBanner(config, path, await resolveConfiguredCredential(config).catch(() => null));

  // Intercept console.log for admin dashboard log streaming (fork layer).
  // Wrapped so a logging failure never breaks the actual console output.
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const { appendLog, setLogFilePath, flushLogFileForShutdown } = await import("../admin/api.js");

  const serialize = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
    if (a === null || a === undefined || typeof a === "number" || typeof a === "boolean") return String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const logLevelRank = (level: string | undefined): number =>
    level === "debug" ? 0 : level === "info" ? 1 : level === "warn" ? 2 : level === "error" ? 3 : 1;
  const safeAppend = (level: string, levelRank: number, args: unknown[]) => {
    if (levelRank < logLevelRank(config.logging?.level)) return; // below configured minimum — skip
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
  const serverRef: { current: ProxyServer | null } = { current: server };
  let claimScheduler: { stop: () => void } | null = null;
  const captchaRuntime = createCaptchaRuntime();
  let shouldWarmCaptcha = config.plan === "start-plan";
  if (!shouldWarmCaptcha) {
    // The retry engine may select a stored start-plan account later.
    const storedAccounts = await exportAccounts().catch(() => []);
    shouldWarmCaptcha = storedAccounts.some((account) => resolveEffectivePlan(account.credential, config.plan) === "start-plan");
  }
  if (shouldWarmCaptcha) {
    void captchaRuntime.start(config.identity.appVersion)
      .catch((err) => console.error(`[captcha] pool warmup failed: ${(err as Error).message}`));
  }
  if (config.claim.enabled && config.claim.auto) {
    import("../claim/runtime.js")
      .then((m) => {
        claimScheduler = m.startAutoClaim(config, auth);
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

  void checkForUpdate(VERSION).then((result) => {
    if (result.kind === "update") console.log(`  update: ${result.notice.text}`);
  });
  let panelRuntime: PanelServer | null = null;
  let shuttingDown = false;
  const shutdown = (signal = "panel"): void => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down...`);
    try { claimScheduler?.stop(); } catch { /* already stopped */ }
    captchaRuntime.stop();
    // heartbeats are unref'd but stopped explicitly on shutdown (upstream v4.8.x)
    try { shutdownAllHighspeed(); } catch { /* loop never ignited */ }
    serverRef.current?.stop(false);
    const force = hostSetTimeout(() => process.exit(0), 5000);
    force.unref?.();
    void Promise.allSettled([
      panelRuntime?.close(),
      flushLogFileForShutdown(),
    ]).finally(() => process.exit(0));
  };
  if (panelSettings && panelLogBuffer) {
    try {
      panelRuntime = await startServePanel(panelSettings, {
        config, path, auth, serverRef, logBuffer: panelLogBuffer, shutdown,
      });
    } catch (err) {
      console.error(`[panel] failed to start: ${(err as Error).message}`);
    }
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
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
