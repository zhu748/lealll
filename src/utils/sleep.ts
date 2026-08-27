/**
 * Shared utility: sleep for the specified number of milliseconds.
 *
 * v0.3.7.1: MUST go through host-timers' captured binding. The bare global
 * `setTimeout` is shadowed by the captcha solver's happy-dom window alias
 * during solve epochs (see src/utils/host-timers.ts) — a sleep registered on
 * a solving window's timer registry is silently cancelled when that window
 * is destroyed, which hung the retry loop forever right after
 * "upstream returned 429, retry 1/20 in 247ms..".
 */
import { hostSetTimeout } from "./host-timers.js";

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => hostSetTimeout(resolve, ms));
}
