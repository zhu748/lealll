import { maskApiKey } from "../../auth/account-view.js";
import { KeyResolver } from "../../auth/resolver.js";
import {
  clearCredentialAsync,
  exportStore,
  invalidateStoreCache,
  listAccounts,
  loadCredential,
  saveCredential,
} from "../../auth/store.js";
import type { Credential as AppCredential } from "../../auth/types.js";
import { detectZCodeProvider, listAvailableZCodeImports, readZCodeImport } from "../../auth/zcode-config.js";
import { errorResponse } from "../../proxy/translated-response.js";
import { appendLog } from "../logs.js";
import { clearQuotaCache } from "../quota.js";
import { readJsonBody } from "../request-body.js";
import { jsonResp } from "../security.js";
import type { AdminRouteContext } from "../types.js";

/** Feature handler; authorization is enforced by admin/router.ts. */
export async function handleCredentialsRoutes(context: AdminRouteContext): Promise<Response | null> {
  const { req, opts, path, method } = context;

  // Get credentials (active credential summary)
  if (path === "/admin/api/credentials" && method === "GET") {
    // readStore checks external mtime changes itself. Avoid a global cache
    // invalidation on dashboard reads, which would force repeated decrypts.
    const store = await exportStore();
    const activeAccount = store?.accounts.find((a) => a.id === store.activeId);
    const cred = activeAccount?.credential;
    if (!cred) return jsonResp({ credential: null });
    return jsonResp({
      credential: {
        id: activeAccount.id,
        label: activeAccount.label,
        provider: cred.provider,
        apiKeyMask: maskApiKey(cred.apiKey),
        hasSecret: !!cred.secret,
        userId: cred.userId,
        expiresAt: cred.expiresAt,
        mode: opts.config.auth.mode,
        plan: cred.plan || "coding-plan",
        name: cred.name,
        email: cred.email,
        proxy: cred.proxy,
        disabled: !!cred.disabled,
      },
    });
  }

  // Add API key
  if (path === "/admin/api/credentials" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ provider: string; apiKey: string; plan?: string; proxy?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      // Field validation (vceshi0.0.5+): reject empty apiKey / unknown provider
      // before they get persisted as garbage that breaks later requests.
      if (!body.apiKey || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        return errorResponse(400, "missing_param", "apiKey is required and must be a non-empty string");
      }
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      if (body.plan !== undefined && body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const plan = (body.plan ?? "coding-plan") as "coding-plan" | "start-plan";
      const cred = {
        apiKey: body.apiKey.trim(),
        provider: body.provider,
        plan,
        // Per-account proxy (v2.1.4.1test5+). Trim; empty/whitespace → undefined
        // so the field is omitted from the serialized credential entirely.
        ...(body.proxy && body.proxy.trim() ? { proxy: body.proxy.trim() } : {}),
      } as AppCredential;
      // Manual add: NO keepActive — new key becomes active (matches user expectation
      // that clicking "Add Key" makes it the active credential immediately).
      await saveCredential(cred);
      invalidateStoreCache();
      // Hot-swap in-memory credential so oauth-mode requests pick up the new
      // active credential immediately without restart.
      const active = await loadCredential();
      if (active && active.apiKey === cred.apiKey) {
        opts.auth.setOAuthCredential(active);
      }
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Clear ALL credentials (the "Clear Credentials" button).
  //
  // vceshi0.0.7+: also clear the in-memory oauth credential so running
  // requests stop using the just-deleted credential. Previously the proxy
  // kept serving from the stale in-memory credential until restart —
  // defeating the purpose of the clear action and creating a confusing
  // "I cleared credentials but the proxy still works" experience.
  if (path === "/admin/api/credentials" && method === "DELETE") {
    // Use clearCredentialAsync (mutex-protected) instead of sync clearCredential
    // — the sync version can race with concurrent withStoreLock writers
    // (handler.ts auto-switch + dashboard add/edit running in parallel),
    // causing the deleted file to be "resurrected" by the in-flight write.
    await clearCredentialAsync();
    clearQuotaCache();
    opts.auth.clearOAuthCredential();
    appendLog("info", "All credentials cleared via admin dashboard");
    return jsonResp({ ok: true });
  }

  // Import from ZCode
  // Reads BOTH config.json + credentials.json (encrypted) and merges them —
  // config.json gives the directly-usable apiKey, credentials.json supplements
  // email/userId + drives provider auto-detect. When the only coding-plan
  // credential is a raw access_token JWT (no plaintext apiKey in config.json),
  // resolve it via the biz API first. See zcode-config.ts.
  if (path === "/admin/api/import" && method === "POST") {
    try {
      const parsed = await readJsonBody<{ provider: string; plan?: string }>(req);
      if (!parsed.ok) return parsed.error;
      const body = parsed.body;
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const provider = body.provider as "zai" | "bigmodel";
      if (body.plan !== undefined && body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      // The dashboard's plan dropdown is the user's explicit choice — pass it
      // as forcedPlan so readZCodeImport imports exactly what they picked.
      const forcedPlan = body.plan as "coding-plan" | "start-plan" | undefined;
      const source = readZCodeImport(provider, forcedPlan);

      // Build the Credential. A raw access_token JWT needs the biz-API exchange
      // to become a usable apiKey.secret; a config.json plaintext apiKey is
      // already usable.
      let cred: AppCredential;
      if (source.isRawAccessToken) {
        const resolver = new KeyResolver(opts.fetchImpl ?? fetch);
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
      // Auto-generate name: prefer `{email}-{plan}` (like OAuth imports) when
      // we have an email from credentials.json; otherwise fall back to the
      // `zcode(N)-{plan}` numbering convention.
      if (source.email) {
        cred.name = `${source.email}-${source.plan}`;
      } else {
        try {
          const list = await listAccounts();
          const zcodeCount = list.accounts.filter(a => (a.name || "").startsWith("zcode(")).length;
          cred.name = `zcode(${zcodeCount + 1})-${source.plan}`;
        } catch { /* non-fatal */ }
      }
      // Import should NOT auto-activate the new credential — preserve the
      // user's currently-active account. The user can manually click
      // "Activate" on the new account if they want to switch to it.
      // This matches the user's explicit requirement: "通过zcode导入的凭证
      // 会直接开启它，应该不默认开启，而是保留原来凭证开启，就是不要立马切换
      // 新导入凭证".
      await saveCredential(cred, { keepActive: true });
      invalidateStoreCache();
      // NO hot-swap — the in-memory active credential stays as-is. The new
      // account is added to the store but doesn't become active until the
      // user explicitly activates it via the dashboard.
      return jsonResp({
        ok: true,
        apiKeyMask: maskApiKey(cred.apiKey),
        plan: cred.plan,
        email: cred.email,
        name: cred.name,
        activated: false, // signal to dashboard: not auto-activated
      });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // Detect available ZCode imports — drives the dashboard's import dropdown
  // pre-fill (activeProvider) + option disabling (availability). Reads both
  // config.json + credentials.json.
  if (path === "/admin/api/import/detect" && method === "GET") {
    try {
      const activeProvider = detectZCodeProvider();
      const available = listAvailableZCodeImports();
      return jsonResp({ activeProvider, available });
    } catch (err) {
      return errorResponse(500, "detect_failed", (err as Error).message);
    }
  }
  return null;
}
