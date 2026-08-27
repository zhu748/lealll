import type { ProxyConfig } from "../config/types.js";

const MAX_TIMER_MS = 2_147_483_647;
const SAFE_RETRY_INITIAL_DELAY_MS = 1_000;
const SAFE_RETRY_MAX_DELAY_MS = 8_000;
const HTTP_DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const HTTP_DAY_LONG = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const HTTP_MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const HTTP_TIME = "\\d{2}:\\d{2}:\\d{2}";
const RETRY_AFTER_HTTP_DATE_RE = new RegExp(
  `^(?:${HTTP_DAY}, \\d{2} ${HTTP_MONTH} \\d{4} ${HTTP_TIME} GMT|` +
  `${HTTP_DAY_LONG}, \\d{2}-${HTTP_MONTH}-\\d{2} ${HTTP_TIME} GMT|` +
  `${HTTP_DAY} ${HTTP_MONTH} [ \\d]\\d ${HTTP_TIME} \\d{4})$`,
  "i",
);

export function parseRetryAfterMs(raw: string | null | undefined, now = Date.now()): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Number.MAX_SAFE_INTEGER / 1000) {
      return undefined;
    }
    return seconds * 1000;
  }

  if (!RETRY_AFTER_HTTP_DATE_RE.test(value)) return undefined;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  const delayMs = dateMs - now;
  return delayMs > 0 ? delayMs : undefined;
}

function normalizeRetryDelayMs(raw: number, fallback: number): number {
  const n = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const safe = Number.isFinite(n) && n > 0 ? n : SAFE_RETRY_INITIAL_DELAY_MS;
  return Math.max(1, Math.min(Math.floor(safe), MAX_TIMER_MS));
}

export function normalizeTimerMs(raw: number, fallback: number): number {
  const n = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const safe = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1, Math.min(Math.floor(safe), MAX_TIMER_MS));
}

function normalizeRetryBackoffFactor(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function normalizeJitterRandom(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}

export function computeRetryDelayMs(
  retry: Pick<ProxyConfig["retry"], "initialDelayMs" | "maxDelayMs" | "backoffFactor">,
  attempt: number,
  retryAfter: string | null | undefined,
  now = Date.now(),
  random: () => number = Math.random,
): number {
  const maxDelayMs = normalizeRetryDelayMs(retry.maxDelayMs, SAFE_RETRY_MAX_DELAY_MS);
  const initialDelayMs = Math.min(
    normalizeRetryDelayMs(retry.initialDelayMs, SAFE_RETRY_INITIAL_DELAY_MS),
    maxDelayMs,
  );
  const backoffFactor = normalizeRetryBackoffFactor(retry.backoffFactor);
  const exponent = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt) - 1) : 0;
  const rawDelay = initialDelayMs * Math.pow(backoffFactor, exponent);
  let delayMs = Number.isFinite(rawDelay) && rawDelay > 0
    ? Math.min(rawDelay, maxDelayMs)
    : maxDelayMs;

  const retryAfterMs = parseRetryAfterMs(retryAfter, now);
  if (retryAfterMs !== undefined) {
    delayMs = Math.max(delayMs, Math.min(retryAfterMs, maxDelayMs));
  }

  const jitter = delayMs * 0.25 * normalizeJitterRandom(random());
  const rounded = Math.round(delayMs + jitter);
  return Math.max(1, Math.min(rounded, maxDelayMs));
}
