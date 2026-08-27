/**
 * Aliyun Captcha V3 front-end — config fetch + pre-solved token pool.
 *
 * v0.3.0 (upstream zcode-api v2.6.0 alignment): the legacy jsdom/Chrome-CDP
 * solver (1811 lines) is REPLACED by the upstream in-process happy-dom solver
 * (captcha-happy.ts) served through a pre-solved token pool (captcha-pool.ts).
 *
 * Why: the jsdom path's polyfill fingerprints were detectable by Aliyun's risk
 * engine (FeiLin SDK cross-checks fingerprint consistency), which made the
 * free/start-plan tier effectively unusable. The happy-dom solver is
 * production-proven upstream: deterministic stable fingerprints, native
 * toString disguise, WebGL/Canvas/Audio mocks, human behavior simulation, and
 * pe-VM stall detection. Tokens are minted into a pool; requests take an
 * already-solved token (sub-ms) while background refills keep the pool warm —
 * the hot path never waits on a solve.
 *
 * Fingerprint stability: the happy-dom solver's polyfill/guest-patch values
 * are deterministic and STABLE (never randomized) — Aliyun's risk engine
 * correlates fingerprint stability across requests; randomizing per-solve
 * flags it as `verifyCode: F001`. See captcha-happy.ts.
 */
import { shutdownCaptchaSolver } from "./captcha-solver.js";
import {
  configureCaptchaPool,
  getCaptchaPoolStats,
  prefillCaptchaPool,
  takeCaptchaToken,
  startCaptchaPoolRefill,
  stopCaptchaPool,
  urgentCaptchaRefill,
  type CaptchaConfig,
} from "./captcha-pool.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };

/** Options accepted for backward compatibility with the pre-v0.3.0 handler
 * signature — only `appVersion` is still consulted (the happy solver needs
 * no identity headers to fetch the captcha config; upstream mirrors this). */
export interface LegacyCaptchaSolveOptions {
  appVersion?: string;
  sourceTitle?: string;
  refererOrigin?: string;
  releaseChannel?: string;
  deviceMid?: string;
  /** Ignored — the happy backend serves every solve. Kept for API stability. */
  solver?: "chrome" | "jsdom" | "auto";
}

export interface LegacyCaptchaSolveResult {
  verifyParam: string;
  region: string;
  solveMs: number;
}

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}

async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  try {
    const resp = await fetch(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=win32-x64`);
    const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
    return cfg;
  } catch { return null; }
}

/**
 * Take a captcha token for an upstream request.
 *
 * New behavior (pool-based): returns a pre-solved token from the pool —
 * typically sub-millisecond. When the pool is empty (cold start / burst), the
 * take races parallel background solves and waits up to the pool's deadline
 * (~25s) for the first to land.
 *
 * Legacy handler signature preserved: `(reqId, opts) => { verifyParam, region,
 * solveMs }`. `solveMs` is now measured around the pool take (≈0 on the warm
 * path) so the dashboard's captcha-time column stays meaningful.
 */
export async function getCaptchaToken(
  reqId: string | undefined,
  opts: LegacyCaptchaSolveOptions = {},
): Promise<LegacyCaptchaSolveResult> {
  const appVersion = opts.appVersion || "3.9.1";
  const started = Date.now();
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("Captcha config unavailable");
  // Pre-solved token pool: requests take an already-minted token (sub-ms)
  // while background solves refill — the hot path never waits on a solve.
  const verifyParam = await takeCaptchaToken(cfg);
  void reqId; // kept for signature compatibility; the pool logs internally
  return { verifyParam, region: cfg.region, solveMs: Date.now() - started };
}

export function shutdownCaptcha(): void {
  try { shutdownCaptchaSolver(); } catch {}
  try { stopCaptchaPool(); } catch {}
}

/**
 * Start background pre-solving of the token pool (happy backend).
 * Warms only the idle minimum; the pool grows on demand with traffic.
 */
export async function startCaptchaPool(appVersion: string): Promise<void> {
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled) return;
  // Size the pool before prefill: the module-level pool defers sizing to the
  // first configure() so a cold boot doesn't mint a storm of soon-expired
  // tokens. CAPTCHA_POOL_MIN/CAPTCHA_POOL_MAX env vars override the defaults.
  const min = Number(process.env.CAPTCHA_POOL_MIN || 20);
  const max = Number(process.env.CAPTCHA_POOL_MAX || Math.max(min * 6, 120));
  configureCaptchaPool({ poolSizeMin: min, poolSizeMax: max });
  startCaptchaPoolRefill(cfg as CaptchaConfig);
  await prefillCaptchaPool(cfg as CaptchaConfig, min);
}

/** Request an urgent refill burst (e.g. after a challenge/retry). */
export function urgentCaptcha(): void {
  urgentCaptchaRefill();
}

export function captchaPoolStats(): { ready: number; target: number; activeSolves: number } {
  return getCaptchaPoolStats();
}

export function configureCaptchaSolving(opts: Parameters<typeof configureCaptchaPool>[0]): void {
  configureCaptchaPool(opts);
}

/** Test-only hook mirroring the legacy export surface. */
export function _clearCaptchaConfigCacheForTesting(): void {
  cachedConfig = { value: null, expiresAt: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-facing helper status/control.
//
// The dashboard's "captcha helper" panel used to control the hidden Chrome CDP
// renderer (legacy solver). With the happy-dom pool those controls now map to
// the token pool: GET reports pool stats, warmup pre-solves to the idle
// minimum, stop releases the pool + solver. The function names are kept so
// admin/api.ts and index.ts keep working unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChromeCaptchaHelperStatus {
  running: boolean;
  backend: "happy-pool";
  ready: number;
  target: number;
  activeSolves: number;
}

export function getChromeCaptchaHelperStatus(): ChromeCaptchaHelperStatus {
  const stats = getCaptchaPoolStats();
  return {
    running: stats.target > 0 || stats.activeSolves > 0,
    backend: "happy-pool",
    ready: stats.ready,
    target: stats.target,
    activeSolves: stats.activeSolves,
  };
}

export async function warmupChromeCaptchaHelper(appVersion?: string): Promise<ChromeCaptchaHelperStatus> {
  await startCaptchaPool(appVersion || process.env.ZCODE_APP_VERSION || "3.9.1");
  return getChromeCaptchaHelperStatus();
}

export async function shutdownChromeCaptchaHelper(_reason = "manual"): Promise<ChromeCaptchaHelperStatus> {
  shutdownCaptcha();
  return getChromeCaptchaHelperStatus();
}
