/**
 * Tests for the remote provider-config client (auth/client-config.ts).
 *
 * Covers:
 *  - happy path: two-step fetch (config endpoint → CDN URL → JSON),
 *    verifying URL params app_version / platform;
 *  - happy path: extractGlmModelIds dedupes + lowercases + filters
 *    non-GLM templates (deepseek / mimo / grok);
 *  - missing `builtin_provider_config_json` returns null (matches desktop
 *    local-fallback behavior);
 *  - HTTP non-2xx on either step returns null;
 *  - non-JSON response returns null;
 *  - network error returns null;
 *  - timeout abort (short timeoutMs aborts a hung server);
 *  - app_version & platform defaults when not overridden.
 */
import { describe, it, expect } from "bun:test";
import {
  fetchRemoteProviderConfig,
  extractGlmModelIds,
  DEFAULT_CLIENT_CONFIG_ORIGIN,
} from "./client-config.js";

type Json = Record<string, unknown>;

function makeFetch(
  routes: Record<string, { status?: number; body: Json }>,
  opts: { seen?: Array<{ url: string; init?: RequestInit }> } = {},
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    opts.seen?.push({ url: u, init });
    // Strip protocol + host
    const path = u.replace(/^https:\/\/[^/]+/, "");
    // Try exact match, then path-only (without query), then full URL match (for CDN URLs)
    let route = routes[path];
    if (!route) {
      const pathOnly = path.split("?")[0];
      route = routes[pathOnly] ?? routes[u];
    }
    if (!route) return new Response("no route", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const CONFIG_URL = `${DEFAULT_CLIENT_CONFIG_ORIGIN}/api/v1/client/configs`;
const CDN_URL = "https://cdn-zcode.z.ai/zcode/builtin-provider/2026-09-29.json";

describe("client-config — happy path", () => {
  it("fetches config endpoint then CDN URL, parses JSON", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = makeFetch(
      {
        "/api/v1/client/configs": {
          body: { data: { configs: { builtin_provider_config_json: CDN_URL } } },
        },
        [CDN_URL]: {
          body: {
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                templateRules: [
                  {
                    templateId: "zai-api",
                    config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] },
                  },
                ],
              },
            },
          },
        },
      },
      { seen },
    );
    const result = await fetchRemoteProviderConfig({
      fetchImpl,
      appVersion: "3.14.4",
      platform: "linux-x64",
    });
    expect(result).not.toBeNull();
    expect(result!.sourceUrl).toBe(CDN_URL);
    expect(result!.config.schemaVersion).toBe(1);
    expect(seen.length).toBe(2);
    expect(seen[0].url).toContain(CONFIG_URL);
    expect(seen[0].url).toContain("app_version=3.14.4");
    expect(seen[0].url).toContain("platform=linux-x64");
    expect(seen[1].url).toBe(CDN_URL);
  });
});

describe("client-config — failure tolerance", () => {
  it("missing builtin_provider_config_json returns null (local-fallback)", async () => {
    const fetchImpl = makeFetch({
      "/api/v1/client/configs": { body: { data: { configs: {} } } },
    });
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });

  it("undefined data returns null", async () => {
    const fetchImpl = makeFetch({
      "/api/v1/client/configs": { body: {} },
    });
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });

  it("HTTP non-2xx on step 1 returns null", async () => {
    const fetchImpl = makeFetch({
      "/api/v1/client/configs": { status: 503, body: { msg: "unavailable" } },
    });
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });

  it("HTTP non-2xx on step 2 (CDN) returns null", async () => {
    const fetchImpl = makeFetch({
      "/api/v1/client/configs": {
        body: { data: { configs: { builtin_provider_config_json: CDN_URL } } },
      },
      [CDN_URL]: { status: 404, body: { msg: "not found" } },
    });
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });

  it("non-JSON response on step 2 returns null", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/v1/client/configs")) {
        return new Response(
          JSON.stringify({ data: { configs: { builtin_provider_config_json: CDN_URL } } }),
          { status: 200 },
        );
      }
      return new Response("oops", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });

  it("network error returns null", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });

  it("non-string builtin_provider_config_json returns null", async () => {
    const fetchImpl = makeFetch({
      "/api/v1/client/configs": {
        body: { data: { configs: { builtin_provider_config_json: 12345 } } },
      },
    });
    const result = await fetchRemoteProviderConfig({ fetchImpl });
    expect(result).toBeNull();
  });
});

describe("client-config — timeout", () => {
  it("short timeout aborts a hung server and returns null", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (sig) sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        else setTimeout(reject, 30000);
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchRemoteProviderConfig({ fetchImpl, timeoutMs: 50 });
    expect(result).toBeNull();
  });
});

describe("client-config — extractGlmModelIds", () => {
  it("extracts + lowercases + dedupes GLM model ids from zai-api and bigmodel-api templates", () => {
    const config = {
      config: {
        providerConfigRules: {
          templateRules: [
            { templateId: "zai-api", config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] } },
            { templateId: "bigmodel-api", config: { builtinModelIds: ["GLM-5.3", "GLM-5.2"] } },
            { templateId: "zai-standard-api", config: { builtinModelIds: ["SHOULD-NOT-APPEAR"] } },
            { templateId: "deepseek-api", config: { builtinModelIds: ["deepseek-flash"] } },
            { templateId: "mimo-api", config: { builtinModelIds: ["mimo-v2.5"] } },
            { templateId: "grok-api", config: { builtinModelIds: ["grok-4.6"] } },
          ],
        },
      },
    };
    const ids = extractGlmModelIds(config);
    expect(ids).toEqual(["glm-5.3", "glm-5.3-flash", "glm-5.2"]);
  });

  it("returns empty array when no template rules", () => {
    expect(extractGlmModelIds({})).toEqual([]);
    expect(extractGlmModelIds({ config: {} })).toEqual([]);
    expect(extractGlmModelIds({ config: { providerConfigRules: {} } })).toEqual([]);
  });

  it("skips templates without builtinModelIds", () => {
    const config = {
      config: {
        providerConfigRules: {
          templateRules: [
            { templateId: "zai-api" }, // no config
            { templateId: "zai-api", config: {} }, // no builtinModelIds
          ],
        },
      },
    };
    expect(extractGlmModelIds(config)).toEqual([]);
  });
});
