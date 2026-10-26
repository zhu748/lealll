/** Android proxy and loopback control runtime. */
import { hostSetTimeout } from "../utils/host-timers.js";
import { createSerialQueue } from "../utils/serial.js";
import { loadConfig } from "../config/loader.js";
import { ensureConfigFile, updateConfigYaml } from "../config/edit.js";
import { configuredAuthOptions, createConfiguredAuthManager, resolveConfiguredCredential } from "../auth/selection.js";
import type { ProviderId } from "../provider/types.js";
import { startServer, type ProxyServer } from "../server/server.js";
import { buildServerOptions } from "../server/server-options.js";
import { startControlListener, type ControlState } from "../android/control.js";
import { collectQuotaSnapshot } from "../server/routes-quota.js";
import { applyAndroidIdentityDefaults } from "./identity-config.js";
import { installLogTee } from "./log-tee.js";
import { createCaptchaRuntime } from "./captcha-runtime.js";

/**
 * Android entry — starts the proxy plus a localhost control listener.
 * Caller (Kotlin shell) must set env: ZCODE_CONTROL_PORT (control listener),
 * ZCODE_OAUTH_CALLBACK_PORT (fixed OAuth callback port for WebView redirect).
 */
export async function runAndroid(): Promise<void> {
  applyAndroidIdentityDefaults();
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  ensureConfigFile(path);
  const config = loadConfig(path);

  const logBuffer = installLogTee();

  // Fork multi-account layer: same listAllCredentials wiring as serve(), so
  // the retry engine can failover across accounts on Android too.
  const auth = createConfiguredAuthManager(config);

  const captchaRuntime = createCaptchaRuntime();

  const serverRef: { current: ProxyServer | null } = { current: null };

  const runLifecycle = createSerialQueue();

  async function startProxy(): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
    if (serverRef.current) return { ok: false, error: "already_running" };
    const cred = await resolveConfiguredCredential(config).catch(() => null);
    if (!cred) return { ok: false, error: "not_logged_in" };
    auth.setOAuthCredential(cred);
    try {
      const s = await startServer(buildServerOptions(config, auth, false, { configPath: path }));
      serverRef.current = s;
      console.log(`zcode-proxy listening on http://${s.hostname}:${s.port}`);
      if (config.plan === "start-plan") {
        void captchaRuntime.start(config.identity.appVersion)
          .catch((err) => console.error(`[captcha] pool warmup failed: ${(err as Error).message}`));
      }
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
      captchaRuntime.stop();
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

  console.log("control listener ready; proxy stopped — use startProxy command to start");

  let claimScheduler: import("../claim/scheduler.js").ClaimScheduler | null = null;
  if (config.claim.enabled && config.claim.auto) {
    import("../claim/runtime.js")
      .then((m) => {
        claimScheduler = m.startAutoClaim(config, auth);
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
    onStartProxy: () => runLifecycle(startProxy),
    onStopProxy: () => runLifecycle(stopProxy),
    onSetConfig: changes => runLifecycle(() => setConfig(changes)),
    onCredentialChange: cred => {
      if (cred && cred.provider === config.provider) auth.setOAuthCredential(cred);
      else auth.clearOAuthCredential();
    },
    onQuota: () => collectQuotaSnapshot(config),
    getCredential: async () => {
      const cred = await resolveConfiguredCredential(config);
      if (cred) auth.setOAuthCredential(cred);
      else auth.clearOAuthCredential();
      return cred;
    },
    onShutdown: async () => {
      // The control protocol's `shutdown` promises a process exit (the Kotlin
      // shell uses it as a full stop). Previously it only stopped the proxy
      // server, leaving a Node process that still held the control/callback
      // ports — a semantic trap. Mirror the SIGINT path: stop everything,
      // flush the log, exit.
      try { claimScheduler?.stop(); } catch { /* best-effort */ }
      try { serverRef.current?.stop(true); } catch { /* best-effort */ }
      captchaRuntime.stop();
      const { flushLogFileForShutdown } = await import("../admin/api.js");
      const force = hostSetTimeout(() => process.exit(0), 5000);
      if (typeof force.unref === "function") force.unref();
      void flushLogFileForShutdown()
        .catch(() => {})
        .finally(() => process.exit(0));
    },
  });

  console.log(`control listener: 127.0.0.1:${controlPort}`);
  console.log(`provider: ${config.provider}`);
  console.log(`plan: ${config.plan}`);

  const shutdown = (): void => {
    // Stop the claim scheduler too — its (now unref'd) hold timer would
    // otherwise let a SIGINT'd process linger until the next tick.
    try { claimScheduler?.stop(); } catch { /* best-effort */ }
    captchaRuntime.stop();
    void controlListener.close().then(() => serverRef.current?.stop(true));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
