/** Authentication commands and their terminal OAuth flow. */
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { loadCredential, saveCredential, clearCredentialAsync, getStorePath, listAccounts } from "../auth/store.js";
import { readZCodeImport } from "../auth/zcode-config.js";
import { ZaiOAuthClient, BigmodelOAuthClient, BigmodelPollOAuthClient, LOGIN_TIMEOUT_MS, parsePastedCallbackUrl, type OAuthResult } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import type { Credential, PlanId } from "../auth/types.js";
import type { ProviderId } from "../provider/types.js";
import { openBrowser } from "../runtime/open-browser.js";
import { pasteLoginInstructions, readPastedLine, boldIfTTY } from "../runtime/paste-login.js";
import { ensureConfigWithDeviceMid } from "../runtime/identity-config.js";

export async function authCommand(args: string[]): Promise<void> {
  const sub = args[0];
  try {
    if (sub === "login") await authLogin(args.slice(1));
    else if (sub === "logout") await authLogout();
    else if (sub === "status") await authStatus();
    else if (sub === "export") await authExport(args.slice(1));
    else {
      console.error("Usage: zcode-proxy auth <login|logout|status|export>");
      process.exit(1);
    }
  } catch (error) {
    console.error(`auth ${sub} failed: ${(error as Error).message}`);
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
  // --plan= on every menu item; omitted flags default to start-plan (4.8.0:
  // OAuth logins capture a JWT, which only the start-plan plane uses).
  const planFlag = args.find(a => a.startsWith("--plan="));
  let plan: PlanId = "start-plan";
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
    console.log(`[hint] --plan= not specified, defaulting to start-plan.`);
    console.log(`[hint] If you meant to use coding-plan, re-run with: --plan=coding-plan`);
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

async function authLogout(): Promise<void> {
  if (!existsSync(getStorePath())) {
    console.log("Not logged in.");
    return;
  }
  // Async variant: acquires the store write mutex (and the cross-process
  // lock) so a concurrently running serve process can't "resurrect" the
  // credentials file after the unlink.
  await clearCredentialAsync();
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
