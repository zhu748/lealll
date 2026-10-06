import {
  exportAccounts,
  exportSingleAccount,
  exportStore,
  importAccounts,
  invalidateStoreCache,
  listAccounts,
  loadCredential,
  removeAccount,
  setAccountDisabled,
  setAccountEmail,
  setAccountLabel,
  setAccountName,
  setAccountPlan,
  setAccountProxy,
  switchAccount,
  validateProxyUrl,
} from "../../auth/store.js";
import { errorResponse } from "../../proxy/translated-response.js";
import { handleMutationResult, synchronizeActiveCredential } from "../account-actions.js";
import { persistConfig } from "../config.js";
import { appendLog } from "../logs.js";
import { checkProxyConnectivity } from "../proxy-check.js";
import { clearQuotaCache, clearQuotaCacheForAccount } from "../quota.js";
import { MAX_ACCOUNT_IMPORT_BODY_BYTES, readJsonBody } from "../request-body.js";
import { jsonResp } from "../security.js";
import type { AdminRouteContext } from "../types.js";

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleAccountsRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, url, path, method } = context;

  // Store reads already detect external writes; polling must preserve the cache.
  if (path === "/admin/api/accounts" && method === "GET") {
    const result = await listAccounts();
    return jsonResp(result);
  }

  // Switch active account
  if (path === "/admin/api/accounts/active" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id) return errorResponse(400, "missing_param", "id is required");
      const ok = await switchAccount(body.id);
      // Handle null (store temporarily unreadable) vs false (not found) vs true
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      // Hot-swap the in-memory credential and sync plan
      const cred = await loadCredential();
      let planSynced = false;
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        // Sync config.plan to match the account's plan, and persist to yaml
        // so the change survives a server restart. Without this, users who
        // switch plan via the dashboard find the change silently reverted
        // after restart — leading to confusing "still coding-plan" reports.
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          planSynced = true;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Switched active account to ${body.id}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      if (planSynced) {
        try {
          await persistConfig(opts.config, opts.configPath);
          appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
        } catch (e) {
          appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
        }
      }
      return jsonResp({ ok: true, plan: cred?.plan || opts.config.plan });
    } catch (err) {
      return errorResponse(500, "switch_failed", (err as Error).message);
    }
  }

  // Update account label
  if (path === "/admin/api/accounts/label" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; label?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.label !== "string") {
        return errorResponse(400, "missing_param", "id and label are required");
      }
      const ok = await setAccountLabel(body.id, body.label);
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Update account plan
  if (path === "/admin/api/accounts/plan" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; plan?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || !body.plan) {
        return errorResponse(400, "missing_param", "id and plan are required");
      }
      if (body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const ok = await setAccountPlan(body.id, body.plan);
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      clearQuotaCacheForAccount(body.id);

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use the new
      // plan. Without this, the proxy would keep using the old plan until
      // restart — defeating the purpose of the dashboard edit.
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Account ${body.id} plan changed to ${body.plan}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      // Always write — even if plan matches config, the dashboard edit is
      // an explicit user action worth persisting (in case config.yaml had
      // been manually edited out of band).
      try {
        await persistConfig(opts.config, opts.configPath);
        appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
      } catch (e) {
        appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
      }
      return jsonResp({ ok: true, plan: body.plan });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Update account outbound proxy (v2.1.4.1test5+)
  // Accepts an empty/whitespace string to clear the override.
  if (path === "/admin/api/accounts/proxy" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; proxy?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required");
      }
      if (typeof body.proxy !== "string") {
        return errorResponse(400, "missing_param", "proxy is required (use empty string to clear)");
      }
      // M3 fix: validate via new URL() instead of a loose regex. The old
      // regex `/^(https?|socks5h?):\/\/[^\s]+$/i` allowed single quotes,
      // angle brackets and other characters that could escape the inline
      // onclick JS string in the dashboard, causing stored XSS. URL()
      // parsing rejects malformed URLs, and we additionally block any
      // host containing HTML/JS metacharacters as defense-in-depth.
      // Empty string clears the override.
      const trimmed = body.proxy.trim();
      if (trimmed) {
        let proxyUrl: URL;
        try {
          proxyUrl = new URL(trimmed);
        } catch {
          return errorResponse(
            400,
            "invalid_param",
            "proxy must be a valid URL with scheme http://, https://, socks4://, socks4a://, socks5://, or socks5h://",
          );
        }
        const allowedProtocols = ["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"];
        if (!allowedProtocols.includes(proxyUrl.protocol)) {
          return errorResponse(
            400,
            "invalid_param",
            "proxy must be a valid URL with scheme http://, https://, socks4://, socks4a://, socks5://, or socks5h://",
          );
        }
        // Reject hosts containing HTML/JS metacharacters — these can never
        // appear in a legitimate hostname and would escape any inline JS
        // string context in the dashboard.
        if (/[<>'"\s]/.test(proxyUrl.host)) {
          return errorResponse(
            400,
            "invalid_param",
            "proxy host contains invalid characters",
          );
        }
      }
      const success = await setAccountProxy(body.id, body.proxy);
      const errResp = handleMutationResult(success);
      if (errResp) return errResp;
      clearQuotaCacheForAccount(body.id);

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use (or stop
      // using) the new proxy. Without this, the proxy change would only
      // take effect after a server restart — defeating the purpose of the
      // dashboard edit.
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
      }
      appendLog(
        "info",
        `Account ${body.id} proxy ${trimmed ? `set to ${trimmed}` : "cleared"}`,
      );
      return jsonResp({ ok: true, proxy: trimmed });
    } catch (err) {
      // v0.2.0.8: setAccountProxy now throws on SSRF / scheme validation
      // failures. Distinguish those (400, client error) from genuine update
      // failures (500, server error) by sniffing the message — the validator
      // in store.ts produces messages starting with "Proxy URL" / "Invalid proxy".
      const msg = (err as Error).message ?? "";
      const isValidation = /^Proxy URL|Invalid proxy URL|points at an internal|scheme .* is not allowed|missing a hostname/i.test(msg);
      if (isValidation) {
        return errorResponse(400, "invalid_param", msg);
      }
      return errorResponse(500, "update_failed", msg);
    }
  }

  // Test proxy connectivity (v2.1.4.1test6+)
  // Does a HEAD request to the configured provider's base URL through the
  // supplied proxy URL. Any HTTP response (even 4xx/5xx) means the proxy is
  // reachable; only network-level failures (timeout, connection refused, DNS
  // failure through the proxy, auth rejection by the proxy) report ok=false.
  //
  // Body: { proxy: string, provider?: "zai"|"bigmodel" }
  // Returns: { ok: true, status, latencyMs, target } on success
  //          { ok: false, error, latencyMs, target } on failure (still HTTP 200
  //           so the dashboard can render the error message cleanly)
  if (path === "/admin/api/accounts/proxy-test" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ proxy?: string; provider?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (typeof body.proxy !== "string") {
        return errorResponse(400, "missing_param", "proxy is required");
      }
      const trimmed = body.proxy.trim();
      if (!trimmed) {
        return errorResponse(400, "invalid_param", "proxy URL cannot be empty (use 'No proxy' on the dashboard instead)");
      }
      // Keep the "test proxy" path aligned with the actual account proxy
      // save path. Without this, the dashboard could initiate a connectivity
      // probe to a URL that /accounts/proxy would later reject (e.g. cloud
      // metadata / link-local addresses).
      const validation = validateProxyUrl(trimmed);
      if (!validation.ok) {
        return errorResponse(400, "invalid_param", validation.message);
      }

      return jsonResp(await checkProxyConnectivity(trimmed, body.provider, opts));
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Delete an account
  if (path.startsWith("/admin/api/accounts/") && method === "DELETE") {
    const id = path.slice("/admin/api/accounts/".length);
    if (!id) return errorResponse(400, "missing_param", "account id required");
    const ok = await removeAccount(id);
    const errResp = handleMutationResult(ok);
    if (errResp) return errResp;
    // v0.2.0.8: drop any cached quota result for this account so a future
    // account reusing the same id (unlikely but possible) doesn't see stale
    // data. Previously the cache entry leaked — bounded to 50 entries so it
    // self-corrected eventually, but explicit cleanup is cleaner.
    clearQuotaCacheForAccount(id);
    // Hot-swap the in-memory credential if active changed
    await synchronizeActiveCredential(opts.auth);
    appendLog("info", `Removed account ${id}`);
    return jsonResp({ ok: true });
  }

  // Export all accounts (backup)
  if (path === "/admin/api/accounts/export" && method === "GET") {
    try {
      const accounts = await exportAccounts();
      return jsonResp({ accounts, exportedAt: Date.now(), version: 2 });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Export credentials as a base64 blob suitable for the ZCODE_OAUTH_CREDENTIAL
  // env var on Render / Fly.io / K8s.
  //
  // This is the dashboard equivalent of `zcode-proxy auth export` on the CLI.
  // Use case: you logged in via the dashboard (or imported from ZCode), and
  // now want to deploy to Render without re-doing the OAuth flow there.
  //
  // Two output formats, auto-selected by account count:
  //
  //   • Single account  → base64(JSON.stringify(credential))
  //     Backward-compatible with the original render-start.sh, which wraps the
  //     decoded blob as a single-account v2 store on the remote host.
  //
  //   • Multiple accounts → base64(JSON.stringify({version:2, activeId, accounts}))
  //     The full v2 store envelope, so all accounts (and the activeId pointer)
  //     survive the trip to Render. render-start.sh detects this format (top-
  //     level `version: 2` + `accounts` array) and writes it directly to
  //     credentials.json instead of wrapping.
  //
  // Returns:
  //   { credential: <base64>, json: <pretty JSON>, envVars: {...},
  //     multi: boolean, accountCount: number, instructions: <string> }
  // The `credential` field is what you paste into Render's ZCODE_OAUTH_CREDENTIAL.
  // The `json` field is the decoded payload for human inspection.
  // ---------------------------------------------------------------------
  // vceshi0.0.4+: Edit account name/email + export single account JSON
  // ---------------------------------------------------------------------

  // Edit account name/email (vceshi0.0.4+).
  // Body: { id, name?, email? } — only provided fields are updated; omitted
  // fields preserve their current value. Empty string clears the field.
  if (path === "/admin/api/accounts/edit" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; name?: string; email?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      // Type-check name/email (vceshi0.0.5+): non-string values (numbers, null,
      // objects) would crash setAccountName's .trim() call. Reject early.
      if (body.name !== undefined && typeof body.name !== "string") {
        return errorResponse(400, "invalid_param", "name must be a string");
      }
      if (body.email !== undefined && typeof body.email !== "string") {
        return errorResponse(400, "invalid_param", "email must be a string");
      }
      // At least one of name/email must be provided (otherwise the call is a no-op).
      if (body.name === undefined && body.email === undefined) {
        return errorResponse(400, "missing_param", "At least one of name or email must be provided");
      }

      // Update name if provided (including empty string to clear)
      if (body.name !== undefined) {
        const ok = await setAccountName(body.id, body.name);
        const errResp = handleMutationResult(ok);
        if (errResp) return errResp;
      }
      // Update email if provided (including empty string to clear)
      if (body.email !== undefined) {
        const ok = await setAccountEmail(body.id, body.email);
        const errResp = handleMutationResult(ok);
        if (errResp) return errResp;
      }

      // If the active account was edited, hot-swap the in-memory credential so
      // the new name/email take effect immediately for any running requests
      // (email is read by some upstreams via metadata.user_id — though name
      // is purely for display, hot-swapping is cheap and keeps things consistent).
      invalidateStoreCache();
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);

      appendLog("info", `Account ${body.id} edited (name=${body.name !== undefined ? "updated" : "kept"}, email=${body.email !== undefined ? "updated" : "kept"})`);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "edit_failed", (err as Error).message);
    }
  }

  // Export single account as JSON (vceshi0.0.4+).
  // Query param: ?id=<accountId>
  // Returns the full account record including plaintext credential — caller
  // should treat the response as sensitive (recommend downloading as a file
  // rather than logging).
  if (path === "/admin/api/accounts/export-single" && method === "GET") {
    try {
      const id = url.searchParams.get("id");
      if (!id) {
        return errorResponse(400, "missing_param", "id query param is required");
      }
      // NOTE: do NOT call invalidateStoreCache() here — readStore() already
      // detects external writes via mtime check. Removing this cuts latency
      // on this endpoint and avoids causing concurrent reads to miss cache.
      const account = await exportSingleAccount(id);
      if (!account) {
        return errorResponse(404, "not_found", "Account not found");
      }
      return jsonResp({ ok: true, account });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Toggle account disabled state (vceshi0.0.6+).
  // Body: { id, disabled: boolean }
  // When disabled, the credential is excluded from auto-switch + manual activation.
  if (path === "/admin/api/accounts/disabled" && method === "PUT") {
    try {
      const parsed = await readJsonBody<{ id?: string; disabled?: boolean }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      if (typeof body.disabled !== "boolean") {
        return errorResponse(400, "invalid_param", "disabled must be a boolean");
      }
      const ok = await setAccountDisabled(body.id, body.disabled);
      const errResp = handleMutationResult(ok);
      if (errResp) return errResp;
      invalidateStoreCache();
      await synchronizeActiveCredential(opts.auth);
      appendLog("info", `Account ${body.id} ${body.disabled ? "disabled" : "enabled"}`);
      return jsonResp({ ok: true, disabled: body.disabled });
    } catch (err) {
      return errorResponse(500, "toggle_failed", (err as Error).message);
    }
  }

  if (path === "/admin/api/accounts/render-export" && method === "GET") {
    try {
      const store = await exportStore();
      if (!store || store.accounts.length === 0) {
        return errorResponse(404, "not_logged_in", "No stored credential. Login or import first.");
      }

      // Single-account path: emit the bare credential (backward compat with
      // existing render-start.sh consumers).
      if (store.accounts.length === 1) {
        const cred = store.accounts[0].credential;
        const json = JSON.stringify(cred);
        const b64 = Buffer.from(json, "utf8").toString("base64");
        return jsonResp({
          credential: b64,
          json: JSON.stringify(cred, null, 2),
          envVars: {
            ZCODE_AUTH_MODE: "oauth",
            ZCODE_OAUTH_CREDENTIAL: b64,
          },
          multi: false,
          accountCount: 1,
          instructions: [
            "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
            "2. On Render, go to your service → Environment → add/edit:",
            "   - ZCODE_AUTH_MODE = oauth",
            "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
            "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
            "4. Save and let Render redeploy.",
            "",
            "WARNING: This blob contains your upstream credential in plaintext.",
            "Treat it like a password. On Render, mark the env var as Secret.",
          ].join("\n"),
        });
      }

      // Multi-account path: emit the full v2 store envelope so all accounts
      // are preserved on the remote host.
      const storeJson = JSON.stringify(store);
      const b64 = Buffer.from(storeJson, "utf8").toString("base64");
      return jsonResp({
        credential: b64,
        json: JSON.stringify(store, null, 2),
        envVars: {
          ZCODE_AUTH_MODE: "oauth",
          ZCODE_OAUTH_CREDENTIAL: b64,
        },
        multi: true,
        accountCount: store.accounts.length,
        instructions: [
          `Detected ${store.accounts.length} stored accounts — exporting the full credential store (v2 envelope).`,
          "All accounts and the active-account pointer are preserved in the base64 blob.",
          "",
          "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
          "2. On Render, go to your service → Environment → add/edit:",
          "   - ZCODE_AUTH_MODE = oauth",
          "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
          "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
          "4. Save and let Render redeploy.",
          "",
          "WARNING: This blob contains ALL your upstream credentials in plaintext.",
          "Treat it like a password. On Render, mark the env var as Secret.",
        ].join("\n"),
      });
    } catch (err) {
      return errorResponse(500, "render_export_failed", (err as Error).message);
    }
  }

  // Import accounts from backup
  if (path === "/admin/api/accounts/import" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ accounts?: unknown[] }>(req, { maxBytes: MAX_ACCOUNT_IMPORT_BODY_BYTES });
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (!Array.isArray(body.accounts)) {
        return errorResponse(400, "invalid_param", "accounts array is required");
      }
      // Basic validation: each account must have id, label, createdAt, credential
      const validated = body.accounts.filter((a: any) =>
        a && typeof a.id === "string" && typeof a.label === "string" &&
        typeof a.createdAt === "number" && a.credential && typeof a.credential.apiKey === "string"
      );
      if (validated.length === 0) {
        return errorResponse(400, "invalid_param", "No valid accounts found in import data");
      }
      const result = await importAccounts(validated as any);
      clearQuotaCache();
      appendLog("info", `Imported accounts: ${result.added} added, ${result.updated} updated`);
      // Hot-swap active credential (only if it changed). After import we
      // must invalidate cache so loadCredential() reads the freshly-imported
      // store from disk (importAccounts already wrote it, but our cache is
      // stale).
      invalidateStoreCache();
      await synchronizeActiveCredential(opts.auth);
      return jsonResp({ ok: true, added: result.added, updated: result.updated });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }
  return null;
}
