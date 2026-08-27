// ─────────────────────────────────────────────────────────────────────────────
// Guest-origin error classification + silent collector (v0.3.6.1)
//
// FeiLin's fingerprint SDK races dozens of best-effort async collectors
// ("getUniversalCombatFeature", screen probes, ...) inside promises with NO
// catch handlers. Under Bun the guest scripts run in the HOST realm, so when
// one of those collectors throws — a missing API in the happy-dom env
// (TypeError: L[$] is not a function), or a bare `window` reference after
// destroyDom removed the global aliases (ReferenceError: window is not
// defined) — the rejection surfaces at the PROCESS level, where the generic
// index.ts handlers printed it as
//
//   [unhandledRejection] TypeError: L[$] is not a function ...
//       at p (https://g.alicdn.com/captcha-frontend/FeiLin/.../feilin149....js:1:220532)
//
// i.e. exactly the "一堆报错" the user saw on every startup / solve wave.
//
// Classification is deliberately conservative — a rejection is guest-origin
// ONLY if an `at (...)` STACK FRAME points at an alicdn.com URL. Every guest
// script (o.alicdn.com AliyunCaptcha.js + g.alicdn.com rotated FeiLin/pe
// chunks) is alicdn-hosted, and host code never executes inside them. The
// MESSAGE is never inspected: a host-side `fetch("https://o.alicdn.com/...")`
// network failure legitimately mentions the URL in its message but its stack
// frames are host/native — those must keep printing.
//
// Consumed rejections are collected into a bounded ring buffer (mirroring the
// in-window __capGuestErrors from GUEST_EVAL_PATCH) and surfaced ONLY when a
// captcha solve FAILS — quiet successes, self-diagnosing failures. This is
// the host-realm twin of the v0.3.6.0 guest-window error collection.
// ─────────────────────────────────────────────────────────────────────────────

const GUEST_FRAME_RE = /alicdn\.com\//i;
const FRAME_LINE_RE = /^\s*at\b/;
const MAX_NOTES = 40;

const _notes: string[] = [];

/** Serialize a rejection for the collector (never throws). */
function formatNote(value: unknown): string {
  try {
    if (value instanceof Error) {
      const frames = String(value.stack ?? "")
        .split("\n")
        .filter((l) => FRAME_LINE_RE.test(l))
        .slice(0, 3)
        .map((l) => l.trim().replace(/^at\s+/, ""))
        .join(" | ");
      return `${value.name || "Error"}: ${String(value.message).slice(0, 200)}${frames ? ` @ ${frames}` : ""}`;
    }
    return `non-Error: ${String(value).slice(0, 200)}`;
  } catch {
    return "unformattable rejection";
  }
}

/**
 * True iff the value is an Error whose STACK FRAMES (not message) point into
 * an alicdn.com-hosted guest script. Non-Error rejections are never
 * classified as guest — there is no stack to attribute them by.
 */
export function isGuestOriginError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const stack = String(value.stack ?? "");
  if (!stack) return false;
  for (const line of stack.split("\n")) {
    if (FRAME_LINE_RE.test(line) && GUEST_FRAME_RE.test(line)) return true;
  }
  return false;
}

/**
 * Offer an error/rejection to the silent guest collector.
 * Returns true when it was consumed (guest-origin): the caller MUST NOT print
 * it — it lives in the ring buffer and is attached to captcha solve failures
 * via peekGuestErrorNotes().
 */
export function noteGuestError(value: unknown): boolean {
  if (!isGuestOriginError(value)) return false;
  try {
    if (_notes.length >= MAX_NOTES) _notes.shift();
    _notes.push(formatNote(value));
  } catch {}
  return true;
}

/**
 * The most recent `count` collected notes (oldest → newest), without clearing.
 * Attached to a solve's error message by solveTraceless on failure.
 */
export function peekGuestErrorNotes(count = 4): string[] {
  return _notes.slice(-Math.max(0, count));
}

/** Total collected so far (diagnostics/tests). */
export function guestErrorNoteCount(): number {
  return _notes.length;
}

/** Test hook: wipe the collector. */
export function _resetGuestErrorNotesForTest(): void {
  _notes.length = 0;
}
