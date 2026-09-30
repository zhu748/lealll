/**
 * Remote provider-config client (ZCode desktop 3.14.4).
 *
 * The 3.14.4 CLI bundle (`_reverse/3.14.4/zcode.cjs`) added a remote
 * provider-config delivery mechanism via function `xnr`:
 *   - URL: `${endpointOrigin}/api/v1/client/configs?app_version=X&platform=Y`
 *   - Timeout: 20s (AbortController with `unref()`)
 *   - Response: `{data: {configs: {builtin_provider_config_json?: string}}}`
 *   - The `builtin_provider_config_json` field is a CDN URL pointing to the
 *     latest `zcode-builtin.json` (model list + provider templates)
 *   - The desktop then fetches that CDN URL and parses it; on any failure
 *     it falls back to the local `config/provider/zcode-builtin.json`
 *     shipped inside the AppImage.
 *
 * Design intent: Z.AI can push new GLM model releases to existing desktop
 * clients without an app upgrade — the response can return a fresh CDN URL
 * whose contents add new `builtinModelIds` (e.g. when GLM-5.3.1 ships).
 *
 * Failure mode: any network / HTTP / envelope error returns `null` — the
 * caller (proxy startup or `/quota` aggregation) falls back to the
 * locally-configured `models:` list from `config.yaml`. This mirrors the
 * desktop's catch → local-fallback behavior.
 *
 * Auth: this endpoint is unauthenticated on the zcode plane — it only
 * inspects `app_version` and `platform` query parameters. The desktop
 * does NOT send `Authorization` or identity headers (verified in the
 * `xnr` function: only `C3i.parse(await l(u)).data...` — no headers built).
 *
 * @see _reverse/3.14.4/zcode.cjs (`xnr` / `C3i` / `Spe`)
 */
import type { ProxyIdentity } from "../config/types.js";
import { DEFAULT_APP_VERSION } from "../config/loader.js";

/** Default origin of the zcode control plane. */
export const DEFAULT_CLIENT_CONFIG_ORIGIN = "https://zcode.z.ai";
/** Upstream request timeout — the desktop uses 20s in `xnr` (2e4 ms). */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The shape of the builtin provider config file (subset — only the fields
 * the proxy consumes for model-list refresh). Mirrors the top-level
 * `zcode-builtin.json` shipped in `config/provider/`.
 */
export interface BuiltinProviderConfig {
  /** Schema revision (currently 1). */
  schemaVersion?: number;
  /** Provider template rules; the proxy only reads `builtinModelIds` for the GLM templates. */
  config?: {
    providerConfigRules?: {
      templateRules?: Array<{
        templateId: string;
        config?: {
          api?: { type?: string; baseUrl?: string };
          builtinModelIds?: string[];
        };
      }>;
    };
  };
}

/** Result of a successful remote-config fetch. */
export interface RemoteProviderConfig {
  /** The CDN URL the server pointed to (for cache-key / debug). */
  sourceUrl: string;
  /** Parsed builtin provider config (subset). */
  config: BuiltinProviderConfig;
}

export interface ClientConfigOptions {
  /** Override the zcode-plane origin (default `https://zcode.z.ai`). */
  origin?: string;
  /** App version sent as `app_version` query param (default from config loader). */
  appVersion?: string;
  /** Platform sent as `platform` query param (default `linux-x64`). */
  platform?: string;
  /** Request timeout in ms (default 20000, matching the desktop `xnr`). */
  timeoutMs?: number;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Identity (unused — endpoint is unauthenticated, kept for API symmetry). */
  identity?: ProxyIdentity;
}

/**
 * Fetch the remote provider config from `/api/v1/client/configs`, then
 * download the CDN URL it points to and parse the resulting
 * `zcode-builtin.json`. Returns `null` on any failure (network / HTTP
 * non-2xx / missing `builtin_provider_config_json` field / CDN fetch error
 * / parse error) — caller falls back to local config.
 *
 * The desktop's `xnr` function does the same two-step fetch; if the
 * `builtin_provider_config_json` field is `undefined` the desktop also
 * returns `null` and uses local fallback.
 */
export async function fetchRemoteProviderConfig(
  opts: ClientConfigOptions = {},
): Promise<RemoteProviderConfig | null> {
  const origin = (opts.origin ?? DEFAULT_CLIENT_CONFIG_ORIGIN).replace(/\/+$/, "");
  const appVersion = opts.appVersion ?? DEFAULT_APP_VERSION;
  const platform = opts.platform ?? "linux-x64";
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Step 1: query /api/v1/client/configs for the CDN URL.
  const url = new URL(`${origin}/api/v1/client/configs`);
  url.searchParams.set("app_version", appVersion);
  url.searchParams.set("platform", platform);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    return null;
  }
  let envelope: { data?: unknown };
  try {
    envelope = await resp.json();
  } catch {
    return null;
  }
  const data = (envelope as { data?: unknown } | null)?.data;
  if (data == null) return null;
  const configs = (data as { configs?: unknown }).configs;
  if (configs == null) return null;
  const cdnUrl = (configs as { builtin_provider_config_json?: unknown }).builtin_provider_config_json;
  if (typeof cdnUrl !== "string" || cdnUrl.trim() === "") return null;

  // Step 2: fetch the CDN URL.
  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
  let resp2: Response;
  try {
    resp2 = await fetchImpl(cdnUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller2.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer2);
  }
  if (!resp2.ok) {
    void resp2.body?.cancel().catch(() => {});
    return null;
  }
  let config: BuiltinProviderConfig;
  try {
    config = (await resp2.json()) as BuiltinProviderConfig;
  } catch {
    return null;
  }
  return { sourceUrl: cdnUrl, config };
}

/**
 * Extract GLM model ids (lowercased) from a builtin provider config, looking
 * at the templates whose `templateId` starts with `zai-api` or
 * `bigmodel-api` (the coding-plan templates). Returns the union of all
 * `builtinModelIds` from those templates, deduped, sorted by insertion order.
 *
 * The proxy's `config.yaml` `models:` field uses lowercase ids
 * (`glm-5.3-flash`), so this function lowercases to match. Third-party
 * templates (deepseek-*, mimo-*, grok-*) are skipped — they go through
 * separate API surfaces, not the Z.AI coding plan.
 */
export function extractGlmModelIds(config: BuiltinProviderConfig): string[] {
  const rules = config?.config?.providerConfigRules?.templateRules;
  if (!Array.isArray(rules)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const tid = rule?.templateId;
    if (typeof tid !== "string") continue;
    if (!tid.startsWith("zai-api") && !tid.startsWith("bigmodel-api")) continue;
    const ids = rule?.config?.builtinModelIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const lc = id.trim().toLowerCase();
      if (lc.length === 0) continue;
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(lc);
    }
  }
  return out;
}
