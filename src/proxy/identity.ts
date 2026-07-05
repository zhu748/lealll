/**
 * Identity header builders.
 *
 * ZCode has two related but different header sets:
 *   - host/source headers for desktop API calls such as /client/configs
 *   - GLM agent model-provider headers for /v1/messages traffic
 *
 * === 2026-06-28 REVERSE-ENGINEERED FROM app.asar (Mf() offset 886853 + SDK
 *     literal offset 1085109 + yU offset 887429) — REAL CLIENT WIRE ORDER ===
 *
 * The real ZCode desktop host sends the source headers in this exact order
 * for host API calls (for example captcha client config):
 *
 *   4.  User-Agent              : ZCode/{appVersion}        (e.g. ZCode/3.2.5)
 *   5.  HTTP-Referer            : https://zcode.z.ai
 *   6.  X-Title                 : Z Code@electron
 *   7.  X-ZCode-App-Version     : {appVersion}
 *   8.  X-Platform              : {platform}-{arch}         (e.g. win32-x64)
 *   9.  X-Release-Channel       : {channel}                 (ONLY when non-empty)
 *   10. X-Client-Language       : {Intl locale}              (e.g. zh-CN)
 *   11. X-Client-Timezone       : {Intl timeZone}            (e.g. Asia/Shanghai)
 *   12. X-Os-Category           : macos | windows | linux
 *   13. X-Os-Version            : {os.version()}             (ONLY when non-empty)
 *   14. X-Device-Mid            : {telemetry deviceMid}       (ONLY when present)
 *
 * IMPORTANT CORRECTIONS vs the previous revision of this file (verified
 * against the 2026-06-28 unpacking):
 *
 *   1. ORDER: the previous revision emitted User-Agent → X-ZCode-App-Version
 *      → HTTP-Referer → X-Title. The real client emits User-Agent →
 *      HTTP-Referer → X-Title → X-ZCode-App-Version. We now match the real
 *      order exactly.
 *
 *   2. X-RELEASE-CHANNEL: the previous revision did NOT emit this header.
 *      The real client emits it conditionally — present when the channel
 *      value is non-empty (outer code: `r ? { "X-Release-Channel": r } : {}`),
 *      absent otherwise. The 3.2.5 production bundle sets this to
 *      "production". We now mirror that.
 *
 *   3. X-OS-VERSION FUNCTION: the previous revision used `os.release()`,
 *      which returns the kernel version string (e.g. "5.10.134-..." on
 *      Linux, "10.0.22621" on Windows). The real client uses `os.version()`,
 *      which returns the OS product name (e.g. "Windows 11 Home China",
 *      "Darwin Kernel Version 24.x.x: ...", "#1 SMP PREEMPT_DYNAMIC ...").
 *      This is a critical fingerprint mismatch — fixed.
 *
 *   4. X-OS-VERSION OPTIONALITY: the real client only emits X-Os-Version
 *      when the value is non-empty. We now skip the header entirely when
 *      os.version() returns an empty string (rare, but possible on minimal
 *      containers).
 *
 * The GLM agent model-provider path is different. In
 * D:\zcode\resources\glm\zcode.cjs it builds provider headers via
 * `$yo() + WOr()`:
 *
 *   HTTP-Referer → User-Agent → [X-ZCode-App-Version] → X-Title →
 *   X-ZCode-Agent → X-Platform → X-Os-Category → [X-Os-Version]
 *
 * That path does NOT include X-Client-Language, X-Client-Timezone,
 * X-Release-Channel, or X-Device-Mid. It also uses os.release() for
 * X-Os-Version because WOr() imports node:os.release(), while the desktop
 * host source-header path uses os.version().
 */
import os from "node:os";
import type { ProxyIdentity } from "../config/types.js";

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const MODEL_USER_AGENT_SUFFIX = "ai-sdk/provider-utils/4.0.27 runtime/node.js/24";

export interface IdentityHeaders {
  "User-Agent": string;
  "HTTP-Referer": string;
  "X-Title": string;
  "X-ZCode-App-Version": string;
  "X-Platform": string;
  "X-Client-Language": string;
  "X-Client-Timezone": string;
  "X-Os-Category": string;
  "X-Os-Version"?: string;
  "X-Device-Mid"?: string;
  "X-Release-Channel"?: string;
}

export interface AgentIdentityHeaders {
  "HTTP-Referer": string;
  "User-Agent": string;
  "X-ZCode-App-Version"?: string;
  "X-Title": string;
  "X-ZCode-Agent": string;
  "X-Platform": string;
  "X-Os-Category": string;
  "X-Os-Version"?: string;
}

/**
 * Map process.platform → the value the real client puts in X-Os-Category.
 * Matches buildZCodeSourceHeaders' R5() switch.
 */
function osCategory(platform: NodeJS.Platform | string): string {
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
 * lifetime of the process, but the original implementation re-derived them
 * on every upstream request:
 *   - `Intl.DateTimeFormat().resolvedOptions()` constructs a new formatter
 *     and runs locale resolution each call (~0.1-0.5ms CPU on a cold ICU).
 *   - `os.version()` is a synchronous syscall.
 * Under load (e.g. a batch request fan-out) this added up. We compute once
 * lazily and reuse. All values are primitives, so there's no mutation risk.
 */
interface CachedEnv {
  platform: NodeJS.Platform | string;
  arch: string;
  osCategory: string;
  clientLanguage: string;
  clientTimezone: string;
  osVersion: string;
  osRelease: string;
}

let _cachedEnv: CachedEnv | null = null;

function getCachedEnv(): CachedEnv {
  if (_cachedEnv) return _cachedEnv;
  const platform = os.platform();
  const arch = os.arch();

  let clientLanguage = "unknown";
  let clientTimezone = "unknown";
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    if (opts.locale) clientLanguage = opts.locale;
    if (opts.timeZone) clientTimezone = opts.timeZone;
  } catch {
    /* keep defaults */
  }

  // v0.2.3 (2026-06-28 unpacking): use os.version() NOT os.release().
  // os.version() returns the OS product name on Windows ("Windows 11 Home
  // China"), the Darwin kernel version string on macOS, and the kernel
  // build string on Linux. os.release() returns the kernel release number
  // ("10.0.22621" / "24.0.0" / "5.10.134-..."), which does NOT match what
  // the real client emits — see module header.
  let osVersion = "";
  try {
    osVersion = os.version() || "";
  } catch {
    /* keep empty */
  }

  let osRelease = "";
  try {
    osRelease = os.release() || "";
  } catch {
    /* keep empty */
  }

  _cachedEnv = {
    platform,
    arch,
    osCategory: osCategory(platform),
    clientLanguage,
    clientTimezone,
    osVersion,
    osRelease,
  };
  return _cachedEnv;
}

/** Test-only hook: clears the cached env so tests can simulate a different
 *  host platform. Not exported via the public surface. */
export function _resetIdentityEnvCacheForTesting(): void {
  _cachedEnv = null;
}

/**
 * Build the identity headers injected upstream — matching the real ZCode
 * client's buildZCodeSourceHeaders() output.
 *
 * Returns the identity block in the EXACT wire order the real client uses
 * (verified 2026-06-28 against app.asar Mf() offset 886853):
 *
 *   User-Agent → HTTP-Referer → X-Title → X-ZCode-App-Version → X-Platform →
 *   [X-Release-Channel] → X-Client-Language → X-Client-Timezone →
 *   X-Os-Category → [X-Os-Version] → [X-Device-Mid]
 *
 * Optional headers (X-Release-Channel, X-Os-Version) are OMITTED from the
 * returned object entirely when their value is empty/unset — the real
 * client does the same (NOT sent with empty value). The caller must insert
 * these into the final header map preserving this order; if an optional
 * header is absent, the subsequent headers simply shift up.
 *
 * Environmental headers (X-Platform / X-Client-* / X-Os-*) are taken from the
 * proxy's runtime environment, the closest faithful reproduction of what the
 * client emits on its own host.
 */
export function buildIdentityHeaders(id: ProxyIdentity): IdentityHeaders {
  const env = getCachedEnv();
  const appVersion = normalizePrintable(id.appVersion) ?? "unknown";
  const refererOrigin = normalizePrintable(id.refererOrigin) ?? "https://zcode.z.ai";
  const sourceTitle = normalizePrintable(id.sourceTitle) ?? "Z Code@electron";
  const releaseChannel = normalizePrintable(id.releaseChannel);

  // Build the headers in the EXACT wire order, assigning keys sequentially
  // so the resulting object's key iteration order matches the wire order
  // (JS engines preserve string-key insertion order).
  //
  // Optional headers (X-Release-Channel, X-Os-Version) are inserted in their
  // correct wire position ONLY when their value is non-empty. When absent,
  // subsequent headers naturally shift up — preserving the relative order
  // of the headers that ARE present.
  //
  // We use Partial<IdentityHeaders> during construction because we add keys
  // incrementally (to preserve insertion order); the optional fields
  // (X-Release-Channel, X-Os-Version) may or may not be set, and the
  // required fields are all populated by the time we return.
  const headers: Partial<IdentityHeaders> = {
    "User-Agent": `ZCode/${appVersion}`,
    "HTTP-Referer": refererOrigin,
    "X-Title": sourceTitle,
    "X-ZCode-App-Version": appVersion,
    "X-Platform": `${env.platform}-${env.arch}`,
  };

  // X-Release-Channel: emit ONLY when the proxy operator set a non-empty
  // channel. Mirrors the real client's `r ? {...} : {}` conditional.
  // Wire position: between X-Platform and X-Client-Language.
  if (releaseChannel) {
    headers["X-Release-Channel"] = releaseChannel;
  }

  // Continue the wire order with X-Client-Language → X-Client-Timezone →
  // X-Os-Category.
  headers["X-Client-Language"] = env.clientLanguage;
  headers["X-Client-Timezone"] = env.clientTimezone;
  headers["X-Os-Category"] = env.osCategory;

  // X-Os-Version: emit ONLY when os.version() returned a non-empty value.
  // Mirrors the real client's behavior on minimal containers where
  // os.version() can return "".
  if (env.osVersion) {
    headers["X-Os-Version"] = env.osVersion;
  }

  // X-Device-Mid: optional telemetry marker from ZCode's local state.
  // The desktop bundle appends it after X-Os-Version when readExistingDeviceMid()
  // returns a printable value.
  const deviceMid = normalizePrintable(id.deviceMid);
  if (deviceMid) {
    headers["X-Device-Mid"] = deviceMid;
  }

  return headers as IdentityHeaders;
}

/**
 * Build GLM agent model-provider headers.
 *
 * This mirrors `D:\zcode\resources\glm\zcode.cjs`:
 *   $yo(env, opts, apiKey) -> HTTP-Referer/User-Agent/App-Version/Title/Agent
 *   WOr()                 -> Platform/Os-Category/Os-Version
 *
 * These are the headers seen on real /v1/messages model requests. They are
 * intentionally narrower than buildIdentityHeaders(): no client language,
 * timezone, release channel, or deviceMid are sent on the model-provider path.
 */
export function buildAgentIdentityHeaders(id: ProxyIdentity): AgentIdentityHeaders {
  const env = getCachedEnv();
  const appVersion = normalizePrintable(id.appVersion);
  const refererOrigin = normalizePrintable(id.refererOrigin) ?? "https://zcode.z.ai";
  const sourceTitle = normalizeAgentSourceTitle(id.sourceTitle);
  const agent = normalizePrintable(id.zcodeAgent) ?? "glm";

  const headers: Partial<AgentIdentityHeaders> = {
    "HTTP-Referer": refererOrigin,
    "User-Agent": `ZCode/${appVersion ?? "unknown"} ${MODEL_USER_AGENT_SUFFIX}`,
  };

  if (appVersion) {
    headers["X-ZCode-App-Version"] = appVersion;
  }

  headers["X-Title"] = sourceTitle;
  headers["X-ZCode-Agent"] = agent;
  headers["X-Platform"] = `${env.platform}-${env.arch}`;
  headers["X-Os-Category"] = env.osCategory;

  if (env.osRelease) {
    headers["X-Os-Version"] = env.osRelease;
  }

  return headers as AgentIdentityHeaders;
}

function normalizePrintable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && ASCII_PRINTABLE.test(trimmed) ? trimmed : undefined;
}

function normalizeAgentSourceTitle(value: string | undefined): string {
  const title = normalizePrintable(value);
  if (!title) return "Z Code@electron";
  return title.startsWith("Z Code@") ? title : `Z Code@${title}`;
}
