/**
 * Aliyun Captcha V3 solver.
 *
 * Official ZCode runs AliyunCaptcha in the Electron renderer. To mirror that,
 * the default `auto` strategy prefers a real Chrome/Edge CDP page when one is
 * available, then falls back to the bundled in-process JSDOM solver. Set
 * `ZCODE_CAPTCHA_SOLVER=jsdom` only when you need a single-binary/no-browser
 * diagnostic path.
 *
 * Captcha verify params are treated as one-shot: whenever start-plan needs
 * a runtime captcha token (on upstream 3007, or when explicit preflight is
 * enabled), the solve result is used only for the immediate retry/attempt.
 * The mutex below serializes solves only to keep memory bounded; it never
 * shares a solved token between callers.
 *
 * The client config request mirrors the desktop host bundle:
 *   GET /api/v1/client/configs?app_version={appVersion}&platform={platform-arch}
 * with no auth headers. The returned captcha config is cached briefly by
 * appVersion/platform, but the solved Aliyun verify param is never cached.
 *
 * The AliyunCaptcha.js SDK is bundled as a text import for the JSDOM path
 * (no runtime dependency on the alicdn CDN, and no runtime node_modules
 * dependency after `bun build --compile`).
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import ALIYUN_SDK_LOCAL from "./AliyunCaptcha.js.txt" with { type: "text" };
import { createMutex } from "../utils/fs.js";
import type { AsyncMutex } from "../utils/fs.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
// v0.1.6+: TOKEN_TTL_MS no longer used (no token cache). Kept as a comment
// for documentation — Aliyun verifyParam is valid for ~45s upstream, but
// we solve fresh each time so TTL doesn't matter to us.
// const TOKEN_TTL_MS = 45_000;
const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How many times to retry a single captcha solve. Overridable via env. */
const SOLVE_RETRIES = Number(process.env.ZCODE_CAPTCHA_RETRIES || 3);
/** Per-attempt solve timeout (ms). Overridable via env. */
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 40_000);
/** Timeout (ms) waiting for the SDK to expose `initAliyunCaptcha`. */
const SDK_LOAD_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SDK_LOAD_MS || 20_000);
/** Config-fetch timeout (ms). The configs API is fast; 15s is generous
 *  for slow networks. Overridable via env. */
const CONFIG_FETCH_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_CONFIG_TIMEOUT_MS || 15_000);
const CHROME_SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_CHROME_TIMEOUT_MS || 70_000);
const CHROME_INTERACTIVE = process.env.ZCODE_CAPTCHA_CHROME_INTERACTIVE === "1";
const ALIYUN_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
export type CaptchaSolverStrategy = "auto" | "chrome" | "jsdom";
type CaptchaLanguage = "cn" | "en";

interface FetchedCaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

interface CaptchaRuntimeOptions {
  appVersion?: string;
  platform?: string;
  language?: string;
  solver?: CaptchaSolverStrategy;
}

let cachedConfigs = new Map<string, { value: FetchedCaptchaConfig | null; expiresAt: number }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractAliyunCaptchaVerifyParam(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = typeof value.captchaVerifyParam === "string"
    ? value.captchaVerifyParam
    : typeof value.CaptchaVerifyParam === "string"
      ? value.CaptchaVerifyParam
      : undefined;
  const param = raw?.trim();
  return param || undefined;
}

function readAliyunVerifyCode(value: Record<string, unknown>): string | undefined {
  return typeof value.verifyCode === "string"
    ? value.verifyCode
    : typeof value.VerifyCode === "string"
      ? value.VerifyCode
      : undefined;
}

export function isAliyunCaptchaTerminalPass(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const verifyCode = readAliyunVerifyCode(value);
  return (value.success === true && value.verifyResult === true) || verifyCode === "T006";
}

export function isAliyunCaptchaDeferredInteractive(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const verifyCode = readAliyunVerifyCode(value);
  if (value.success === true && value.verifyResult === false) return true;
  if (isAliyunCaptchaTerminalPass(value)) {
    return extractAliyunCaptchaVerifyParam(value) === undefined;
  }
  return verifyCode === "F001" || value.code === "F001";
}

export function resolveCaptchaSolverStrategy(raw = process.env.ZCODE_CAPTCHA_SOLVER): CaptchaSolverStrategy {
  const value = (raw || "auto").trim().toLowerCase();
  return value === "chrome" || value === "jsdom" ? value : "auto";
}

export function resolveClientPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function buildCaptchaConfigUrl(options?: { appVersion?: string; platform?: string }): string {
  const url = new URL(CONFIGS_API);
  url.searchParams.set("app_version", options?.appVersion?.trim() || "3.1.8");
  url.searchParams.set("platform", options?.platform?.trim() || resolveClientPlatformKey());
  return url.toString();
}

export function resolveCaptchaLanguage(raw = process.env.ZCODE_CAPTCHA_LANGUAGE): CaptchaLanguage {
  const value = raw?.trim().toLowerCase();
  if (value === "cn" || value === "zh" || value === "zh-cn") return "cn";
  if (value === "en" || value === "en-us") return "en";
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale.toLowerCase().startsWith("zh")) return "cn";
  } catch {
    /* keep default */
  }
  return "en";
}

/**
 * v0.1.6+ FIX: NO token cache.
 *
 * Aliyun captcha verifyParam is ONE-SHOT — zcode.z.ai consumes it on first
 * verification. If two concurrent requests share the same cached token,
 * the second request gets `{"code":3007,"msg":"captcha verify failed"}`.
 *
 * The previous v0.1.5 cache + the mutex double-checked-locking I added
 * made this worse: concurrent cache-miss callers would all get the SAME
 * token (first solves, rest hit cache). This caused 3007 errors.
 *
 * New design:
 *   - getCaptchaToken() ALWAYS solves a fresh token (no cache)
 *   - solveMutex serializes solves so only ONE JSDOM exists at a time
 *     (prevents OOM from N concurrent JSDOM instances)
 *   - handler.ts keeps the solved token only for the immediate upstream
 *     attempt that follows; retries and 3007 responses solve a fresh token,
 *     matching ZCode's provider-runtime-headers refresh semantics
 *
 * This means concurrent requests each get their own token (safe), at the
 * cost of serialized solve latency (N requests = N × ~20s solve time).
 * For a single-user local proxy this is acceptable — concurrent
 * start-plan requests are rare.
 */

/**
 * Mutex serializing captcha solves. Ensures only ONE JSDOM exists at a time.
 * Solves take 10-40s; concurrent solves would each spawn a JSDOM (50-100MB
 * each) → OOM under load. With the mutex, the second+ caller waits for the
 * first to finish, then starts its own solve (NOT sharing the result).
 *
 * The mutex is module-level (singleton) so all callers share the same lock.
 */
const solveMutex: AsyncMutex = createMutex();

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Invalidate any cached captcha token. With the v0.1.6+ no-cache design,
 * this is effectively a no-op (there's nothing to invalidate) — but kept
 * for API compatibility with handler.ts which calls it on 403 responses.
 *
 * Safe to call multiple times in quick succession (idempotent).
 */
export function invalidateCaptchaToken(): void {
  // No-op: we don't cache tokens anymore. Each getCaptchaToken() call
  // solves fresh. Handler.ts's per-request cache is cleared separately.
}

async function fetchCaptchaConfig(reqId?: string, opts?: CaptchaRuntimeOptions): Promise<FetchedCaptchaConfig | null> {
  const url = buildCaptchaConfigUrl({ appVersion: opts?.appVersion, platform: opts?.platform });
  const cached = cachedConfigs.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const tag = reqId ? `${reqId} ` : "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
      const cfg = json?.data?.configs?.captcha ?? null;
      cachedConfigs.set(url, { value: cfg, expiresAt: Date.now() + 60000 });
      return cfg;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Config fetch failure is unrecoverable — don't retry. The retry loop
    // in getCaptchaToken treats null-config as a hard failure.
    //
    // v0.2.2+: tag the error so refreshCaptchaHeaders can distinguish
    // "network error fetching config" (hard-fail, retry won't help) from
    // "config returned but captcha disabled" (soft-fail, skip captcha
    // and let the upstream decide if it's needed).
    const wrapped = new Error(`captcha_config_fetch_failed: ${(err as Error).message}`);
    (wrapped as Error & { configFetchFailed?: boolean }).configFetchFailed = true;
    console.warn(`${tag}[captcha] config fetch failed: ${(err as Error).message}`);
    throw wrapped;
  }
}

/**
 * Get a FRESH captcha token. Always solves — no cache (see module header
 * for why: Aliyun verifyParam is one-shot, sharing causes 3007 errors).
 *
 * Serialized via solveMutex so only one JSDOM exists at a time (prevents
 * OOM from N concurrent JSDOM instances, each 50-100MB).
 *
 * handler.ts is responsible for carrying the token to the immediate upstream
 * attempt. Retries solve again because the verifyParam is consumed by the
 * attempt that used it.
 *
 * @throws Error if the config is unavailable OR all solve retries fail.
 *         Callers (handler.ts) catch this and return 503 to the client.
 */
export async function getCaptchaToken(
  reqId?: string,
  opts?: CaptchaRuntimeOptions,
): Promise<{ verifyParam: string; region: string; solveMs: number }> {
  const tag = reqId ? `${reqId} ` : "";
  const solveStart = Date.now();
  return solveMutex.run(async () => {
    let cfg: FetchedCaptchaConfig | null;
    try {
      cfg = await fetchCaptchaConfig(reqId, opts);
    } catch (err) {
      // Config FETCH failed (network error) — re-throw with the tag so
      // handler.ts can hard-fail the retry loop. We DON'T catch this
      // here because retrying getCaptchaToken won't help (the network
      // won't suddenly recover).
      throw err;
    }
    if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) {
      // Config was returned but captcha is disabled or malformed.
      // This is NOT a hard-fail — the upstream may not require captcha.
      // handler.ts treats this as a soft-fail (skip captcha, let the
      // upstream decide). Throw a distinguishable error.
      throw new Error("captcha_disabled_by_config");
    }

    const verifyParam = await solveInJsdomWithRetry(cfg, reqId, opts?.solver, resolveCaptchaLanguage(opts?.language));
    const solveMs = Date.now() - solveStart;
    console.log(`${tag}captcha solved in ${solveMs}ms`);
    return { verifyParam, region: cfg.region, solveMs };
  });
}

/**
 * Solve the captcha with retries. Config-fetch failures are NOT retried
 * (unrecoverable); only solve failures (SDK timeout, instance init error)
 * trigger the retry loop.
 *
 * v0.2.0.8: each solveInJsdom() call is now wrapped in a HARD outer timeout
 * (SOLVE_TIMEOUT_MS + 10s grace) as a safety net. The inner solve already
 * has two independent timeouts (SDK_LOAD_TIMEOUT_MS, SOLVE_TIMEOUT_MS), but
 * JSDOM on Bun has edge cases where a Promise can hang without either timer
 * firing — e.g. the SDK's internal callback never runs AND the setTimeout
 * gets swallowed by a jsdom event-loop quirk. The outer race guarantees we
 * always reject (and run finally cleanup) even in those pathological cases.
 *
 * The grace margin is deliberately large (10s over the inner timeout) so we
 * NEVER pre-empt a healthy solve — if the inner timeout is 40s, the outer
 * guard only fires at 50s, by which point the inner path has definitely
 * failed. This is a pure safety net, not a behavior change.
 */
async function solveInJsdomWithRetry(
  cfg: FetchedCaptchaConfig,
  reqId?: string,
  solverOverride?: CaptchaSolverStrategy,
  language: CaptchaLanguage = resolveCaptchaLanguage(),
): Promise<string> {
  const tag = reqId ? `${reqId} ` : "";
  let lastErr: Error | null = null;
  const solver = solverOverride ?? resolveCaptchaSolverStrategy();
  let chromeTried = false;
  let chromeErr: Error | null = null;
  const tryChrome = async (reason: string): Promise<string> => {
    chromeTried = true;
    console.log(`${tag}[captcha] using Chrome CDP solver (${reason})...`);
    return await solveInChromeCdp(cfg, language);
  };
  if (solver === "chrome") {
    return await tryChrome(solverOverride ? "forced" : "ZCODE_CAPTCHA_SOLVER=chrome");
  }
  if (
    solver === "auto"
    && process.env.ZCODE_CAPTCHA_AUTO_PREFER_CHROME !== "0"
    && findChromeExecutable()
  ) {
    try {
      return await tryChrome("auto, official-style browser path");
    } catch (err) {
      chromeErr = err as Error;
      if (process.env.ZCODE_CAPTCHA_JSDOM_FALLBACK === "0") throw err;
      console.warn(`${tag}[captcha] Chrome CDP solve failed; trying JSDOM fallback: ${chromeErr.message}`);
    }
  }
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      // v0.2.0.8: outer hard-timeout race. If solveInJsdom's internal
      // timeouts both fail to fire (jsdom edge case), this guarantee
      // ensures we still reject and the finally block runs to release the
      // JSDOM instance (50-100MB each).
      const HARD_GUARD_MS = SOLVE_TIMEOUT_MS + SDK_LOAD_TIMEOUT_MS + 10_000;
      const result = await Promise.race([
        solveInJsdom(cfg, language),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`captcha hard-guard timeout after ${HARD_GUARD_MS}ms (inner timeouts failed to fire — JSDOM may be stuck)`)),
            HARD_GUARD_MS,
          );
        }),
      ]);
      return result;
    } catch (err) {
      lastErr = err as Error;
      const msg = (err as Error).message ?? "unknown";
      // Classify: config-related errors are unrecoverable, don't retry.
      // We've already fetched the config successfully to get here, so this
      // branch is unreachable in practice — kept as a safety net.
      if (/config unavailable|disabled|empty config/i.test(msg)) {
        throw err;
      }
      console.error(`${tag}[captcha] solve attempt ${attempt}/${SOLVE_RETRIES} failed: ${msg}`);
      // Brief backoff between retries — gives the SDK a chance to release
      // any lingering timers / event-loop work from the failed attempt.
      if (attempt < SOLVE_RETRIES) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  if (solver !== "jsdom" && !chromeTried && process.env.ZCODE_CAPTCHA_CHROME_FALLBACK !== "0") {
    try {
      console.log(`${tag}[captcha] jsdom solve failed; trying Chrome CDP fallback...`);
      return await solveInChromeCdp(cfg, language);
    } catch (err) {
      throw new Error(
        `captcha solve failed after ${SOLVE_RETRIES} jsdom attempts and Chrome fallback: ` +
        `${(err as Error).message}; last jsdom error: ${lastErr?.message ?? "unknown"}`,
      );
    }
  }
  throw new Error(
    `captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? "unknown"}` +
    `${chromeErr ? `; earlier Chrome error: ${chromeErr.message}` : ""}`,
  );
}

function findChromeExecutable(): string | null {
  const envPath = process.env.ZCODE_CAPTCHA_CHROME_PATH?.trim();
  const candidates = [
    envPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ].filter((p): p is string => !!p);
  return candidates.find(p => existsSync(p)) ?? null;
}

function defaultStoreDir(): string {
  return process.env.ZCODE_PROXY_STORE_DIR?.trim() || join(homedir(), ".zcode-proxy");
}

function resolveChromeUserDataDir(): { dir: string; ephemeral: boolean } {
  const configured = process.env.ZCODE_CAPTCHA_CHROME_USER_DATA_DIR?.trim();
  if (configured) return { dir: configured, ephemeral: false };
  if (process.env.ZCODE_CAPTCHA_CHROME_EPHEMERAL === "1") {
    return { dir: mkdtempSync(join(tmpdir(), "zcode-captcha-cdp-")), ephemeral: true };
  }
  return { dir: join(defaultStoreDir(), "captcha-chrome-profile"), ephemeral: false };
}

async function waitForCdpJson(port: number, path: string): Promise<any> {
  const deadline = Date.now() + 15_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${path}`);
      if (resp.ok) return await resp.json();
      last = await resp.text();
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP did not become ready: ${last}`);
}

async function solveInChromeCdp(cfg: FetchedCaptchaConfig, language: CaptchaLanguage): Promise<string> {
  const chrome = findChromeExecutable();
  if (!chrome) throw new Error("Chrome/Edge executable not found; set ZCODE_CAPTCHA_CHROME_PATH");

  const port = 9300 + Math.floor(Math.random() * 1000);
  const { dir: userDataDir, ephemeral } = resolveChromeUserDataDir();
  mkdirSync(userDataDir, { recursive: true });
  let hostServer: ReturnType<typeof Bun.serve> | null = null;
  let chromePageUrl = process.env.ZCODE_CAPTCHA_CHROME_URL?.trim();
  if (!chromePageUrl) {
    hostServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    chromePageUrl = `http://127.0.0.1:${hostServer.port}/captcha-host`;
  }
  const chromeArgs = [
    chrome,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    "--window-size=1280,720",
    CHROME_INTERACTIVE ? "--window-position=120,80" : "--window-position=-32000,-32000",
    chromePageUrl,
  ];
  if (process.platform === "linux") {
    chromeArgs.splice(1, 0, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
    if (!process.env.DISPLAY && !CHROME_INTERACTIVE) {
      chromeArgs.splice(1, 0, "--headless=new");
    }
  }
  const proc = Bun.spawn(chromeArgs, { stdout: "ignore", stderr: "ignore" });

  let ws: WebSocket | null = null;
  try {
    const tabs = await waitForCdpJson(port, "/json/list");
    const tab = tabs.find((t: any) =>
      t.webSocketDebuggerUrl
      && t.type === "page"
      && typeof t.url === "string"
      && (t.url === chromePageUrl || t.url.startsWith(chromePageUrl)),
    ) ?? tabs.find((t: any) =>
      t.webSocketDebuggerUrl
      && t.type === "page"
      && typeof t.url === "string"
      && !t.url.startsWith("chrome://"),
    ) ?? tabs.find((t: any) => t.webSocketDebuggerUrl) ?? tabs[0];
    if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome CDP target not found");

    ws = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data));
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    };
    await new Promise<void>((resolve, reject) => {
      if (!ws) return reject(new Error("WebSocket not initialized"));
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Chrome CDP websocket error"));
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
      if (!ws) return reject(new Error("Chrome CDP websocket closed"));
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    await send("Runtime.enable");
    await send("Page.enable").catch(() => {});
    await send("Page.setBypassCSP", { enabled: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    const expression = `(() => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome captcha solve timeout")), ${CHROME_SOLVE_TIMEOUT_MS});
      let settled = false;
      let instance = null;
      let deferredInteractiveStarted = false;
      let sdkLoadedAt = 0;
      const done = (value) => { clearTimeout(timeout); resolve(JSON.stringify(value)); };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const readVerifyCode = (err) => {
        if (!err || typeof err !== "object") return "";
        return typeof err.verifyCode === "string" ? err.verifyCode : typeof err.VerifyCode === "string" ? err.VerifyCode : "";
      };
      const isDeferredInteractive = (err) => {
        if (!err || typeof err !== "object") return false;
        const verifyCode = readVerifyCode(err);
        if (err.success === true && err.verifyResult === false) return true;
        if ((err.success === true && err.verifyResult === true) || verifyCode === "T006") {
          return !extractVerifyParam(err);
        }
        return verifyCode === "F001" || err.code === "F001";
      };
      const extractVerifyParam = (value) => {
        if (!value || typeof value !== "object") return "";
        const param = typeof value.captchaVerifyParam === "string"
          ? value.captchaVerifyParam
          : typeof value.CaptchaVerifyParam === "string"
            ? value.CaptchaVerifyParam
            : "";
        return param.trim();
      };
      const loadSdk = () => new Promise((resolveLoad, rejectLoad) => {
        const sdkLoadError = (script, ev) => {
          let entries = [];
          try {
            entries = performance.getEntriesByName(script.src).map((entry) => ({
              name: entry.name,
              entryType: entry.entryType,
              duration: entry.duration,
              transferSize: entry.transferSize,
              decodedBodySize: entry.decodedBodySize,
              initiatorType: entry.initiatorType,
            }));
          } catch {}
          return new Error("Failed to load Aliyun captcha script: " + JSON.stringify({
            type: ev && ev.type,
            src: script && script.src,
            entries,
          }));
        };
        if (typeof window.initAliyunCaptcha === "function") {
          resolveLoad();
          return;
        }
        let script = document.querySelector('script[src="${ALIYUN_SDK_URL}"]');
        if (script) {
          script.addEventListener("load", () => resolveLoad(), { once: true });
          script.addEventListener("error", (ev) => rejectLoad(sdkLoadError(script, ev)), { once: true });
          return;
        }
        script = document.createElement("script");
        script.src = ${JSON.stringify(ALIYUN_SDK_URL)};
        script.async = true;
        script.onload = () => {
          sdkLoadedAt = Date.now();
          resolveLoad();
        };
        script.onerror = (ev) => rejectLoad(sdkLoadError(script, ev));
        document.head.appendChild(script);
      });
      const waitAfterSdkLoad = () => new Promise((resolveWait) => {
        if (!sdkLoadedAt) {
          resolveWait();
          return;
        }
        const elapsed = Date.now() - sdkLoadedAt;
        const delay = Math.max(0, 2000 - elapsed);
        setTimeout(resolveWait, delay);
      });
      const tryInteractive = () => {
        if (deferredInteractiveStarted) return;
        deferredInteractiveStarted = true;
        try {
          if (instance && typeof instance.show === "function") {
            instance.show();
            return;
          }
          const button = document.querySelector("#captcha-button");
          if (button && typeof button.click === "function") {
            button.click();
            return;
          }
          fail(new Error("Aliyun SDK requested interactive captcha but no show/button is available"));
        } catch (err) {
          fail(err);
        }
      };
      (async () => {
        const hostId = "zcode-aliyun-captcha-container";
        const elementId = "zcode-aliyun-captcha-element";
        const buttonId = "zcode-aliyun-captcha-button";
        let host = document.getElementById(hostId);
        if (!host) {
          host = document.createElement("div");
          host.id = hostId;
          host.setAttribute("aria-hidden", "true");
          host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;height:0;width:0;overflow:visible";
          document.body.appendChild(host);
        }
        host.replaceChildren();
        const el = document.createElement("div");
        el.id = elementId;
        el.style.cssText = "position:absolute;left:0;top:0;height:0;width:0;overflow:visible";
        host.appendChild(el);
        const btn = document.createElement("button");
        btn.id = buttonId;
        btn.type = "button";
        btn.tabIndex = -1;
        btn.setAttribute("aria-hidden", "true");
        btn.style.cssText = "position:fixed;left:50%;top:50%;height:1px;width:1px;transform:translate(-50%,-50%);border:0;padding:0;opacity:0";
        host.appendChild(btn);

        window.AliyunCaptchaConfig = { region: ${JSON.stringify(cfg.region)}, prefix: ${JSON.stringify(cfg.prefix)} };
        await loadSdk();
        await waitAfterSdkLoad();
        if (typeof window.initAliyunCaptcha !== "function") {
          throw new Error("Aliyun SDK did not expose initAliyunCaptcha");
        }
        window.initAliyunCaptcha({
          SceneId: ${JSON.stringify(cfg.sceneId)},
          mode: "popup",
          language: ${JSON.stringify(language)},
          element: "#" + elementId,
          button: "#" + buttonId,
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance: (inst) => {
            instance = inst;
            try {
              if (typeof inst.startTracelessVerification === "function") {
                inst.startTracelessVerification();
                return;
              }
              tryInteractive();
            } catch (err) { fail(err); }
          },
          success: (param) => finish({ ok: true, param }),
          fail: (err) => {
            const param = extractVerifyParam(err);
            if (param) {
              finish({ ok: true, param, source: "fail-terminal-pass" });
              return;
            }
            if (isDeferredInteractive(err)) {
              tryInteractive();
              return;
            }
            finish({ ok: false, err });
          },
          onError: (err) => finish({ ok: false, err }),
        });
      })().catch(fail);
    }))()`;
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: CHROME_SOLVE_TIMEOUT_MS + 10_000,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Chrome solve exception");
    }
    const raw = result.result?.value;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed?.ok || typeof parsed.param !== "string" || parsed.param.length === 0) {
      throw new Error(`Chrome captcha solve failed: ${JSON.stringify(parsed)}`);
    }
    return parsed.param;
  } finally {
    try { ws?.close(); } catch {}
    try { proc.kill(); } catch {}
    try { hostServer?.stop(true); } catch {}
    if (ephemeral) {
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Solve the captcha in a fresh JSDOM instance. Resources (window, timers,
 * event listeners) are explicitly cleaned up in finally — JSDOM instances
 * that fail to close leak their internal timer queue indefinitely.
 */
async function solveInJsdom(cfg: FetchedCaptchaConfig, language: CaptchaLanguage): Promise<string> {
  const vc = new VirtualConsole();
  // Silence the SDK's verbose console.log noise — we only care about
  // errors, which surface via the reject path.
  // v0.1.6+: also silence the `vm.runInContext` TypeError that jsdom
  // throws on Bun (Bun's vm module is incomplete). These errors are
  // non-fatal — the SDK has fallback paths and solve still succeeds.
  // Logging them floods the dashboard with scary-looking errors that
  // don't actually break anything.
  vc.on("jsdomError", (err: Error) => {
    const msg = err.message ?? "";
    // Silence known-non-fatal jsdom errors on Bun:
    //   - "undefined is not an object (evaluating 'vm.runInContext...')"
    //     → Bun's vm module doesn't expose runInContext; jsdom's script
    //       execution falls back to eval, which works for the SDK.
    //   - "Not implemented: HTMLCanvasElement.prototype.getContext"
    //     → we polyfill this, but some code paths still hit the native one
    if (/vm\.runInContext|Not implemented:/i.test(msg)) {
      return; // suppress
    }
    console.error(`[captcha] jsdomError: ${msg}`);
  });

  const sdkSafe = ALIYUN_SDK_LOCAL.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
  const dom = new JSDOM(html, {
    url: "https://zcode.z.ai/", runScripts: "dangerously", resources: "usable",
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window: any) { applyPolyfills(window); window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }; },
  });
  const w = dom.window as any;
  // Track the solve timeout so we can clear it on early return / error.
  let solveTimeout: ReturnType<typeof setTimeout> | null = null;
  // Track the SDK-load interval so we can clear it on early return / error.
  let sdkLoadInterval: ReturnType<typeof setInterval> | null = null;

  try {
    // Wait for the SDK to expose initAliyunCaptcha. Independent timeout
    // from the solve timeout — if the SDK fails to load, we fail fast.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      sdkLoadInterval = setInterval(() => {
        let ok = false;
        try { ok = typeof w.initAliyunCaptcha === "function"; } catch {}
        if (ok) {
          if (sdkLoadInterval) clearInterval(sdkLoadInterval);
          sdkLoadInterval = null;
          resolve();
        } else if (Date.now() - start > SDK_LOAD_TIMEOUT_MS) {
          if (sdkLoadInterval) clearInterval(sdkLoadInterval);
          sdkLoadInterval = null;
          reject(new Error(`Aliyun SDK failed to load within ${SDK_LOAD_TIMEOUT_MS}ms — bundled JS may be corrupt`));
        }
      }, 80);
    });

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let captchaInstance: any = null;
      let interactiveAttempted = false;
      const clearSolveTimer = (): void => {
        if (solveTimeout) clearTimeout(solveTimeout);
        solveTimeout = null;
      };
      const resolveOnce = (param: string): void => {
        if (settled) return;
        settled = true;
        clearSolveTimer();
        resolve(param);
      };
      const rejectOnce = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearSolveTimer();
        reject(err);
      };
      const triggerCaptcha = (inst: any, preferInteractive: boolean): void => {
        const fn = preferInteractive
          ? inst?.show
          : inst?.startTracelessVerification || inst?.show;
        if (typeof fn === "function") {
          fn.call(inst);
          return;
        }
        const button = w.document?.querySelector?.("#captcha-button");
        if (preferInteractive && button && typeof button.click === "function") {
          button.click();
          return;
        }
        rejectOnce(new Error("Aliyun SDK instance has no startTracelessVerification or show method"));
      };
      solveTimeout = setTimeout(
        () => rejectOnce(new Error(`captcha solve timeout after ${SOLVE_TIMEOUT_MS}ms`)),
        SOLVE_TIMEOUT_MS,
      );
      w.initAliyunCaptcha({
        SceneId: cfg.sceneId, mode: "popup", region: cfg.region, prefix: cfg.prefix, language,
        element: "#captcha-element", button: "#captcha-button", captchaLogoImg: "", showErrorTip: false,
        getInstance: (inst: any) => {
          captchaInstance = inst;
          try {
            triggerCaptcha(inst, false);
          } catch (err) {
            rejectOnce(new Error(`Aliyun SDK startTracelessVerification threw: ${(err as Error).message}`));
          }
        },
        success: (param: string) => {
          const trimmed = param.trim();
          if (trimmed) resolveOnce(trimmed);
          else rejectOnce(new Error("Aliyun SDK success returned an empty verify param"));
        },
        fail: (err: unknown) => {
          const param = extractAliyunCaptchaVerifyParam(err);
          if (param) {
            resolveOnce(param);
            return;
          }
          if (isAliyunCaptchaDeferredInteractive(err) && !interactiveAttempted) {
            interactiveAttempted = true;
            try {
              triggerCaptcha(captchaInstance, true);
              return;
            } catch (showErr) {
              rejectOnce(new Error(`Aliyun SDK interactive fallback threw: ${(showErr as Error).message}`));
              return;
            }
          }
          rejectOnce(new Error(`SDK fail: ${JSON.stringify(err)}`));
        },
        onError: (err: unknown) => {
          rejectOnce(new Error(`SDK error: ${JSON.stringify(err)}`));
        },
      });
    });
  } finally {
    // Aggressive cleanup — JSDOM instances hold timers, event listeners,
    // and a fake XMLHttpRequest pool that all leak if we don't tear down.
    if (sdkLoadInterval) { try { clearInterval(sdkLoadInterval); } catch {} sdkLoadInterval = null; }
    if (solveTimeout) { try { clearTimeout(solveTimeout); } catch {} solveTimeout = null; }
    // v0.2.2+ PERF: remove the jsdomError listener explicitly before
    // closing the window. VirtualConsole keeps an internal listener list
    // that can retain references to the dom/window even after w.close().
    // Without this, every solve leaves a small closure graph behind
    // (~50-200KB) that adds up under sustained start-plan traffic.
    try {
      vc.removeAllListeners?.("jsdomError");
      vc.removeAllListeners?.();
    } catch { /* VirtualConsole API may differ across jsdom versions */ }
    try {
      // Close the window — fires the unload event, releases internal
      // resources. Second arg "true" forces close even if pending
      // operations exist.
      w.close();
    } catch {}
    // JSDOM windows sometimes hold references via document event listeners.
    // Null out the major references to help GC.
    try { (dom as any)._document = null; } catch {}
    try { (dom as any)._defaultView = null; } catch {}
    // v0.2.2+: also null out the captured window reference (the `w` const
    // above) so the JSDOM internal map of windows can drop this instance.
    // We can't reassign `w` (it's a const), but we can clear its key
    // properties to break reference cycles.
    try {
      delete (w as any).document;
      delete (w as any).navigator;
    } catch { /* some props are non-configurable; ignore */ }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function applyPolyfills(window: any): void {
  // --- matchMedia polyfill ---
  window.matchMedia = () => ({
    matches: false, media: "", onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });

  // --- Canvas polyfills ---
  const proto = window.HTMLCanvasElement.prototype;

  proto.getContext = function (type: string) {
    if (/webgl/i.test(type)) {
      return {
        canvas: this,
        getParameter: () => "Intel Inc.",
        getExtension: () => null,
        getSupportedExtensions: () => ["WEBGL_debug_renderer_info"],
        getContextAttributes: () => ({}),
        getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
      };
    }
    return {
      canvas: this,
      fillRect() {}, clearRect() {},
      getImageData: (_x: number, _y: number, w = 1, h = 1) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData() {},
      createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      setTransform() {}, transform() {}, drawImage() {},
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {},
      clip() {}, stroke() {}, fill() {}, arc() {}, rect() {},
      ellipse() {}, translate() {}, scale() {}, rotate() {},
      fillText() {}, strokeText() {},
      measureText: (t: string) => ({ width: ("" + t).length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}),
      isPointInPath: () => false,
      font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start",
      fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1,
      shadowBlur: 0, shadowColor: "",
    };
  };

  proto.toDataURL = () =>
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb: any) => cb && cb(null);

  // --- Worker / OffscreenCanvas polyfills ---
  window.Worker = class {
    postMessage() {} terminate() {}
    addEventListener() {} removeEventListener() {}
    onmessage = null; onerror = null;
  };
  window.OffscreenCanvas = class {
    width = 0; height = 0;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return proto.getContext.call(this); }
  };

  // --- Document visibility polyfill ---
  try {
    Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  } catch {}

  // --- Navigator polyfills ---
  const navProps: Record<string, unknown> = {
    userAgent: FAKE_UA, platform: "Win32", language: "en-US",
    languages: ["en-US", "en"], vendor: "Google Inc.", webdriver: false,
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true,
    plugins: { length: 3, item: (): null => null, namedItem: (): null => null, refresh() {} },
    mimeTypes: { length: 0, item: (): null => null, namedItem: (): null => null },
  };
  for (const [k, v] of Object.entries(navProps)) {
    try { Object.defineProperty(window.navigator, k, { value: v, configurable: true }); } catch {}
  }

  // --- Screen / viewport polyfills ---
  window.screen = {
    width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
    colorDepth: 24, pixelDepth: 24,
  };
  window.chrome = { runtime: {} };
  window.outerWidth = 1920;
  window.outerHeight = 1080;
  window.innerWidth = 1280;
  window.innerHeight = 720;
  window.devicePixelRatio = 1;
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
