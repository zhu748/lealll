/** Authenticated web panel for the headless serve runtime. */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { ProviderId } from "../provider/types.js";
import { configuredAuthOptions, resolveConfiguredCredential } from "../auth/selection.js";
import { createSerialQueue } from "../utils/serial.js";
import { hostSetTimeout } from "../utils/host-timers.js";
import { startServer, type ProxyServer } from "../server/server.js";
import { buildServerOptions } from "../server/server-options.js";
import { startPanelServer, type PanelServer, type PanelSettings, type ControlDispatcher } from "../server/panel.js";
import { createControlDispatcher, type LogBuffer, type ControlState } from "../android/control.js";
import { collectQuotaSnapshot } from "../server/routes-quota.js";
import { updateConfigYaml } from "../config/edit.js";

/**
 * Loopback spellings that keep the panel unexposed (same set the config loader
 * accepts for http:// origins). Anything else was an explicit `ZCODE_PANEL_HOST`
 * and gets the startup warning below.
 */
function isLoopbackPanelHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Start the optional web panel for `serve`. `serve` has no TUI, so this is the
 * only way to see quota, read live logs or switch provider/plan on a headless
 * box without `docker exec`.
 *
 * Commands are dispatched in-process through `createControlDispatcher()` — the
 * same protocol the Android shell drives over `POST /control`, without opening a
 * second, unauthenticated loopback port. The panel token is therefore the only
 * way in.
 *
 * The proxy lifecycle hooks mirror `runAndroid` on purpose: `serve` starts the
 * proxy eagerly, so `serverRef` is pre-filled and the start/stop commands only
 * matter for restarts (including the `stop_proxy_first` rule before setConfig).
 *
 * Two behaviours are panel-only and stay out of the shared control layer: the
 * `shutdown` command unwinds the whole process (through the same path as the
 * signals, so it works after the proxy was stopped from the page), and a
 * logout/login re-syncs the live credential — see `handleControl` below.
 */
export async function startServePanel(
  settings: PanelSettings,
  ctx: {
    config: ProxyConfig;
    path: string;
    auth: AuthManager;
    serverRef: { current: ProxyServer | null };
    logBuffer: LogBuffer;
    /** Unwind the process; independent of whether the proxy is still running. */
    shutdown: () => void;
  },
): Promise<PanelServer> {
  const { config, path, auth, serverRef, logBuffer, shutdown } = ctx;

  // The panel can log out (or log in another account) while `serve` keeps
  // running, but AuthManager caches the credential in memory and auto-claim
  // prefers it over the store — so a disk-only change would leave `/v1` and
  // auto-claim serving the account that was just replaced (issue #58 review,
  // P2). Fingerprint the store and re-sync after every panel command: the
  // page polls `getLogs` every 2s, so a background login lands within one poll.
  let authFingerprint = JSON.stringify((await resolveConfiguredCredential(config).catch(() => null)) ?? null);

  async function syncAuthWithDisk(): Promise<void> {
    const onDisk = await resolveConfiguredCredential(config).catch(() => null);
    const fingerprint = JSON.stringify(onDisk ?? null);
    if (fingerprint === authFingerprint) return;
    authFingerprint = fingerprint;
    if (onDisk) {
      auth.setOAuthCredential(onDisk);
      console.log("auth: switched to the account now on disk");
    } else {
      auth.clearOAuthCredential();
      console.log("auth: credential cleared (logged out)");
    }
  }

  const controlState: ControlState = {
    provider: config.provider,
    plan: config.plan,
    proxyPort: serverRef.current?.port ?? 0,
  };

  const runLifecycle = createSerialQueue();

  async function startProxy(): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
    if (serverRef.current) return { ok: false, error: "already_running" };
    const cred = await resolveConfiguredCredential(config).catch(() => null);
    if (!cred) return { ok: false, error: "not_logged_in" };
    auth.setOAuthCredential(cred);
    authFingerprint = JSON.stringify(cred);
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
      await s.stop(false);
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
    const provider = changes.provider ?? config.provider;
    const plan = changes.plan ?? config.plan;
    updateConfigYaml(path, { provider, plan });
    config.provider = provider;
    config.plan = plan;
    auth.updateConfig(configuredAuthOptions(config));
    console.log(`config updated: provider=${config.provider} plan=${config.plan}`);
    return { ok: true, provider: config.provider, plan: config.plan };
  }

  // Dispatched in-process: the panel already guards its own transport with a
  // token, so a second loopback listener would only add an unauthenticated way
  // to reach stopProxy / logout / shutdown (issue #58 review, P1) and a second
  // thing to clean up when the panel fails to start (P2, now structurally gone).
  const dispatchControl = createControlDispatcher(controlState, {
    logBuffer,
    onStartProxy: () => runLifecycle(startProxy),
    onStopProxy: () => runLifecycle(stopProxy),
    onSetConfig: changes => runLifecycle(() => setConfig(changes)),
    onCredentialChange: cred => {
      if (cred && cred.provider === config.provider) auth.setOAuthCredential(cred);
      else auth.clearOAuthCredential();
    },
    onQuota: () => collectQuotaSnapshot(config),
    getCredential: () => resolveConfiguredCredential(config),
  });

  /** Grace period for the `shutdown` reply before `process.exit()` runs. */
  const SHUTDOWN_REPLY_GRACE_MS = 50;

  /**
   * The panel's transport wrapper. Two panel-only responsibilities live here
   * rather than in the shared control layer, so the Android protocol keeps its
   * existing semantics:
   *
   * - `shutdown` answers first and unwinds afterwards. Exiting inside the
   *   command would truncate the reply the page is waiting for, and it unwinds
   *   through the same path as SIGTERM/SIGINT, so it works whether or not the
   *   proxy is still running (issue #58 review, P2).
   * - Every other successful command re-syncs the live credential with the
   *   store, and a logout while the proxy runs stops it. Otherwise `/v1` and
   *   auto-claim keep spending the account that was just logged out (issue #58
   *   review, P2).
   */
  const handleControl: ControlDispatcher = async (cmd) => {
    if (cmd.cmd === "shutdown") {
      hostSetTimeout(shutdown, SHUTDOWN_REPLY_GRACE_MS);
      return { ok: true, event: "shuttingDown" };
    }
    const res = await dispatchControl(cmd);
    if (!res.ok) return res;
    await syncAuthWithDisk();
    if (cmd.cmd === "logout" && serverRef.current) {
      await runLifecycle(stopProxy);
      controlState.proxyPort = 0;
      console.log("panel: logout cleared the live credential — proxy stopped");
    }
    return res;
  };

  const panel = await startPanelServer({
    port: settings.port,
    hostname: settings.host,
    token: settings.token,
    handleControl,
  });
  console.log(`panel: http://${panel.hostname}:${panel.port} (token required)`);
  // A non-loopback bind (the Docker bridge escape hatch, `ZCODE_PANEL_HOST`)
  // is safe only as long as the token is strong and the port stays firewalled
  // past the host that needs it — say so at startup, not only in the docs.
  if (!isLoopbackPanelHost(panel.hostname)) {
    console.warn(
      `panel: bound to ${panel.hostname} — anyone who reaches this port with the token can stop the proxy, log out, or shut down`,
    );
  }

  return panel;
}
