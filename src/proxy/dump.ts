/**
 * Upstream traffic dumper — used for debugging "JSON request body" issues.
 *
 * Activated by env `ZCODE_DUMP_UPSTREAM=<path>`: every proxied request emits
 * one JSONL line per phase (`client_in` / `upstream_out` / `upstream_in` /
 * `upstream_body_sample`), so the full request→response timeline can be
 * inspected offline. Inactive (no-op) when the env var is unset.
 *
 * Design constraints:
 * - Must NEVER affect request handling — all FS work is try/catch'd.
 * - Sensitive header values (Authorization / x-api-key / captcha tokens /
 *   proxy secrets) are masked to `abcd1234…wxyz` so fingerprints are visible
 *   while credentials stay redacted.
 * - Bodies are JSON.parsed and re-stringified when possible (for readability);
 *   otherwise emitted as the raw string.
 *
 * The dump file is line-oriented JSON (JSONL); each line is self-contained:
 *
 *   {"ts":"2026-07-31T12:00:00.000Z","reqId":"#001","phase":"client_in", ...}
 *
 * Pair lines by `reqId` to reconstruct a full request timeline.
 */
import { appendFileSync, statSync } from "node:fs";

const DUMP_PATH = process.env.ZCODE_DUMP_UPSTREAM;
/**
 * Total-bytes budget for the dump file: debug mode previously appended full
 * request/response bodies with NO ceiling and no rotation — a long debug
 * session could fill the disk (and every append is synchronous, on the hot
 * path). Once the budget is hit, dumping stops for the rest of the process
 * lifetime and one warning is emitted.
 */
const DUMP_MAX_TOTAL_BYTES = Math.max(
  1_048_576,
  Number(process.env.ZCODE_DUMP_UPSTREAM_MAX_BYTES) || 256 * 1024 * 1024,
);

/** Header names whose values must be masked before dumping/logging. */
export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "proxy-api-key",
  "x-zcode-captcha-verify-param",
  "x-zcode-captcha-verify-region",
  "cookie",
  "set-cookie",
]);

function maskHeaderValue(key: string, value: string): string {
  if (!SENSITIVE_HEADERS.has(key.toLowerCase())) return value;
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}…${value.slice(-4)} (len=${value.length})`;
}

/** Convert a Headers object to a plain object with sensitive values masked. */
export function dumpHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    out[k] = maskHeaderValue(k, v);
  }
  return out;
}

/** Try to parse body as JSON for pretty emission; fall back to raw string. */
export function dumpBody(body: string | undefined | null): unknown {
  if (body === undefined || body === null) return undefined;
  if (body.length === 0) return "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

interface DumpLine {
  ts: string;
  reqId: string;
  phase: string;
  [k: string]: unknown;
}

let dumpBytesWritten = 0;
let dumpStopped = false;

/**
 * Append one dump line. No-op when `ZCODE_DUMP_UPSTREAM` is unset.
 * All errors are swallowed — dumping must never break request handling.
 */
export function dumpPhase(reqId: string, phase: string, data: Record<string, unknown>): void {
  if (!DUMP_PATH) return;
  if (dumpStopped) return;
  try {
    const line: DumpLine = {
      ts: new Date().toISOString(),
      reqId,
      phase,
      ...data,
    };
    const json = JSON.stringify(line) + "\n";
    // Seed the counter from the existing file so restarting the process
    // against an existing dump doesn't silently double the budget.
    if (dumpBytesWritten === 0) {
      try { dumpBytesWritten = statSync(DUMP_PATH).size; } catch { dumpBytesWritten = 0; }
    }
    if (dumpBytesWritten + json.length > DUMP_MAX_TOTAL_BYTES) {
      dumpStopped = true;
      console.warn(`[dump] byte budget (${DUMP_MAX_TOTAL_BYTES}) reached — dumping paused for the rest of this process`);
      return;
    }
    dumpBytesWritten += json.length;
    appendFileSync(DUMP_PATH, json, "utf-8");
  } catch {
    // intentional swallow — see header comment
  }
}

/** True when dumping is active. Cheap check used to gate per-phase logic in handler. */
export function dumpEnabled(): boolean {
  return !!DUMP_PATH;
}
