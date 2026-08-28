/**
 * Identity header builder — emits the ZCode desktop client's companion headers
 * on every upstream request so the proxy is indistinguishable from the official
 * client at the fingerprinting layer.
 *
 * v0.3.0 (upstream zcode-api v2.6.0 alignment, refreshed 2026-08-07 against the
 * ZCode 3.9.x bundle): model-provider requests now carry the FULL header set
 * (`pio` / buildProviderIdentityHeaders in `_reverse/zcode.cjs`). The previous
 * local revision (2026-06-28, ZCode 3.2.5) split source vs. agent headers and
 * sent a NARROWER set on /v1/messages — that split no longer matches the
 * current client wire shape and was a fingerprint mismatch. The June-era
 * `buildAgentIdentityHeaders` helper has been retired accordingly.
 *
 * The bundle's `pio` emits, in this exact sequence (order preserved via
 * sequential key assignment — JS engines keep string-key insertion order):
 *
 *   HTTP-Referer            EP(env)                          // refererOrigin
 *   User-Agent              `ZCode/${n ?? "unknown"}`
 *   X-ZCode-App-Version     n                                // ONLY when appVersion resolves (ASCII gate)
 *   X-Title                 `Z Code@${sourceTitle}`
 *   X-ZCode-Agent           "glm"                            // bundle `Wna` helper, accepted upstream since v2.0
 *   X-Platform              `${platform}-${arch}`            // when both resolve
 *   X-Release-Channel       "production" (or "test" via ZCODE_ENV; override ZCODE_IDENTITY_RELEASE_CHANNEL)
 *   X-Client-Language       lsa() = Intl locale              // when Intl resolves
 *   X-Client-Timezone       csa() = Intl timezone            // when Intl resolves
 *   X-Os-Category           Nno(platform)                    // when platform resolves
 *   X-Os-Version            u                                // when osVersion resolves
 *   X-Device-Mid            i                                // when deviceMid resolves
 *
 * `n = fio(...)` validates appVersion against `/^[\x20-\x7e]+$/` (printable
 * ASCII). When no version resolves, `pio` drops `X-ZCode-App-Version` entirely
 * and falls back the User-Agent to `ZCode/unknown`. We replicate both
 * behaviours exactly. The same ASCII gate applies to every runtime header value.
 *
 * Runtime values are read via env overrides (kept from upstream so unusual
 * hosts — containers, Android, CI — can pin a stable desktop identity):
 *   - ZCODE_IDENTITY_PLATFORM / ZCODE_IDENTITY_ARCH / ZCODE_IDENTITY_RELEASE
 *   - ZCODE_IDENTITY_RELEASE_CHANNEL / ZCODE_IDENTITY_CLIENT_LANGUAGE
 *   - ZCODE_IDENTITY_CLIENT_TIMEZONE / ZCODE_IDENTITY_DEVICE_MID
 *
 * Performance note (kept from the local fork): the underlying os/Intl probes
 * are computed once per process and cached — `Intl.DateTimeFormat()` runs
 * locale resolution (~0.1-0.5ms on a cold ICU) and `os.*` are synchronous
 * syscalls; the original upstream re-derived them on every request.
 */
import os from "node:os";
import type { ProxyIdentity } from "../config/types.js";

/** Printable-ASCII gate copied from the ZCode bundle's `fio` helper. */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

/** Resolve the appVersion the way `fio` does: trimmed + printable ASCII, else undefined. */
function resolveAppVersion(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function normalizePrintableHeaderValue(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Process-level cached environment values. None of these change for the
 * lifetime of the process, but re-deriving them on every upstream request
 * added measurable CPU under load (batch fan-out). Env overrides are honored
 * at cache-fill time — tests can reset the cache via the exported hook.
 */
interface CachedEnv {
  platform: string;
  arch: string;
  osRelease: string;
  osCategory: string;
  envReleaseChannel: string;
  clientLanguage: string | undefined;
  clientTimezone: string | undefined;
}

let _cachedEnv: CachedEnv | null = null;

function getCachedEnv(): CachedEnv {
  if (_cachedEnv) return _cachedEnv;

  let clientLanguage = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE);
  if (!clientLanguage) {
    try {
      clientLanguage = Intl.DateTimeFormat().resolvedOptions().locale || undefined;
    } catch { /* keep undefined */ }
  }

  let clientTimezone = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE);
  if (!clientTimezone) {
    try {
      clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch { /* keep undefined */ }
  }

  // bundle IL(): ZCODE_ENV==="test" ? "test" : "production" — always resolves.
  const envReleaseChannel = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL)
    ?? (process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production");

  _cachedEnv = {
    platform: process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform,
    arch: process.env.ZCODE_IDENTITY_ARCH ?? os.arch(),
    // The model-provider path uses os.release() (bundle `WOr` imports
    // node:os.release()) — e.g. "5.10.134-..." on Linux / "10.0.22621" on
    // Windows. ZCODE_IDENTITY_RELEASE lets containers pin a stable value.
    osRelease: process.env.ZCODE_IDENTITY_RELEASE ?? os.release(),
    osCategory: normalizeOsCategory(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform),
    envReleaseChannel,
    clientLanguage,
    clientTimezone,
  };
  return _cachedEnv;
}

/** Test-only hook: clears the cached env so tests can simulate a different
 *  host platform / env override set. */
export function _resetIdentityEnvCacheForTesting(): void {
  _cachedEnv = null;
}

/**
 * Build the identity and runtime platform headers injected upstream, in the
 * exact order and with the exact conditional semantics of the bundle's `pio`.
 *
 * Order (with X-ZCode-Agent kept between X-Title and X-Platform):
 *   HTTP-Referer, User-Agent, [X-ZCode-App-Version], X-Title, X-ZCode-Agent,
 *   [X-Platform], [X-Release-Channel], [X-Client-Language], [X-Client-Timezone],
 *   [X-Os-Category], [X-Os-Version], [X-Device-Mid]
 *
 * Returns `Record<string, string>` rather than a fixed interface because
 * several headers are conditionally omitted (matching `pio`).
 */
export function buildIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  const env = getCachedEnv();
  const n = resolveAppVersion(id.appVersion);
  const refererOrigin = normalizePrintableHeaderValue(id.refererOrigin) ?? "https://zcode.z.ai";
  const sourceTitle = normalizePrintableHeaderValue(id.sourceTitle) ?? "cli";
  const platform = normalizePrintableHeaderValue(env.platform);
  const arch = normalizePrintableHeaderValue(env.arch);
  const release = normalizePrintableHeaderValue(env.osRelease);
  // env (injected identity) wins over the config.yaml value (desktop
  // persistence) — both are UUIDv4 generated once and reused forever.
  const deviceMid = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_DEVICE_MID)
    ?? normalizePrintableHeaderValue(id.deviceMid);

  const headers: Record<string, string> = {
    "HTTP-Referer": refererOrigin,
    "User-Agent": `ZCode/${n ?? "unknown"}`,
  };
  if (n) headers["X-ZCode-App-Version"] = n;
  headers["X-Title"] = `Z Code@${sourceTitle}`;
  headers["X-ZCode-Agent"] = normalizePrintableHeaderValue(id.zcodeAgent) ?? "glm";
  if (platform && arch) headers["X-Platform"] = `${platform}-${arch}`;
  // Resolution order (keeps the fork's dashboard hot-update working):
  //   env override > YAML/config value (read per-call, hot-reloadable) > ZCODE_ENV > "production".
  const releaseChannel = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL)
    ?? normalizePrintableHeaderValue(id.releaseChannel)
    ?? env.envReleaseChannel;
  if (releaseChannel) headers["X-Release-Channel"] = releaseChannel;
  if (env.clientLanguage) headers["X-Client-Language"] = env.clientLanguage;
  if (env.clientTimezone) headers["X-Client-Timezone"] = env.clientTimezone;
  if (platform) headers["X-Os-Category"] = env.osCategory;
  if (release) headers["X-Os-Version"] = release;
  if (deviceMid) headers["X-Device-Mid"] = deviceMid;
  return headers;
}

/**
 * Identity headers for model-provider requests, matching ZCode 3.9.2's
 * bundled CLI provider helper (`qtn` + `PIi`).  This is deliberately separate
 * from buildIdentityHeaders(): control-plane calls may carry X-Device-Mid,
 * while the official model path puts the device id in Anthropic
 * `metadata.user_id` and appends X-ZCode-Agent last.
 */
export function buildModelIdentityHeaders(id: ProxyIdentity): Record<string, string> {
  const env = getCachedEnv();
  const n = resolveAppVersion(id.appVersion);
  const refererOrigin = normalizePrintableHeaderValue(id.refererOrigin) ?? "https://zcode.z.ai";
  const sourceTitle = normalizePrintableHeaderValue(id.sourceTitle) ?? "electron";
  const platform = normalizePrintableHeaderValue(env.platform);
  const arch = normalizePrintableHeaderValue(env.arch);
  const release = normalizePrintableHeaderValue(env.osRelease);
  const releaseChannel = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL)
    ?? normalizePrintableHeaderValue(id.releaseChannel)
    ?? env.envReleaseChannel;

  const headers: Record<string, string> = {
    "HTTP-Referer": refererOrigin,
    "User-Agent": `ZCode/${n ?? "unknown"}`,
  };
  if (n) headers["X-ZCode-App-Version"] = n;
  headers["X-Title"] = `Z Code@${sourceTitle}`;
  if (releaseChannel) headers["X-Release-Channel"] = releaseChannel;
  headers["X-Client-Language"] = env.clientLanguage ?? "unknown";
  headers["X-Client-Timezone"] = env.clientTimezone ?? "unknown";
  if (platform && arch) headers["X-Platform"] = `${platform}-${arch}`;
  if (platform) headers["X-Os-Category"] = env.osCategory;
  if (release) headers["X-Os-Version"] = release;
  headers["X-ZCode-Agent"] = normalizePrintableHeaderValue(id.zcodeAgent) ?? "glm";
  return headers;
}
