/** Request diagnostics and summaries; business decisions remain in handler.ts. */
import type { Format } from "../translator/types.js";
import { recordStat } from "../admin/stats.js";
import { SENSITIVE_HEADERS } from "./dump.js";

export interface RequestMeta {
  model: string;
  stream: boolean;
}

let reqCounter = 0;
let headerPrinted = false;

/** Format a unix-ms timestamp as local HH:MM:SS in the host's timezone (not UTC). */
function localTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

const DEBUG_BODY_PREVIEW = 200;

export function debugLine(reqId: string, msg: string): void {
  console.log(`${reqId} debug: ${msg}`);
}

export function debugError(reqId: string, kind: string, msg: string): void {
  console.log(`${reqId} debug: ERROR ${kind}: ${msg}`);
}

function redactHeaderVal(key: string, val: string): string {
  const k = key.toLowerCase();
  // Keep debug logs and dump files aligned, including captcha verification headers.
  if (!SENSITIVE_HEADERS.has(k)) return val;
  if (k === "authorization") {
    const sp = val.indexOf(" ");
    return sp > 0 ? `${val.slice(0, sp)} <redacted>` : "<redacted>";
  }
  if (val.length <= 10) return "<redacted>";
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

export function formatHeaderPairs(headers: Headers): string {
  const pairs: string[] = [];
  for (const [k, v] of headers.entries()) {
    pairs.push(`${k}=${redactHeaderVal(k, v)}`);
  }
  return pairs.join(" ");
}

export function formatResponseHeaders(headers: Headers): string {
  const interesting = [
    "content-type",
    "content-encoding",
    "content-length",
    "x-request-id",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-remaining",
  ];
  const pairs: string[] = [];
  for (const h of interesting) {
    const v = headers.get(h);
    if (v) pairs.push(`${h}=${v}`);
  }
  return pairs.length > 0 ? pairs.join(" ") : "(no notable headers)";
}

export function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= DEBUG_BODY_PREVIEW) return flat;
  return `${flat.slice(0, DEBUG_BODY_PREVIEW)}…(${flat.length} bytes total)`;
}

const COMPACT_LOG = process.env.ZCODE_LOG_FORMAT === "compact";

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  if (COMPACT_LOG) return;
  console.log(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB |   Tok |  tok/s |   Total |",
  );
  console.log(
    "|------|------------|-----|-------------|--------|------|---------|-------|--------|---------|",
  );
}

export interface RequestLogContext {
  reqId: string;
  format: Format;
  meta: RequestMeta;
  started: number;
}

export interface RequestLogResult {
  status: number;
  headersAt: number;
  tokens?: number;
  avgTps?: number;
  streamEndAt?: number;
  stats?: {
    retried?: boolean;
    credentialKey?: string;
    captchaMs?: number;
    inputTokens?: number;
    cacheReadTokens?: number;
  };
}

/** Bind immutable request metadata once; each result supplies only changing values. */
export function createRequestLogger(context: RequestLogContext): (result: RequestLogResult) => void {
  return result => logRequestResult(context, result);
}

function logRequestResult(
  { reqId, format, meta, started }: RequestLogContext,
  { status, headersAt, tokens = 0, avgTps = 0, streamEndAt = 0, stats }: RequestLogResult,
): void {
  // Deduplication by request ID also merges retry log entries.
  try {
    recordStat({
      id: reqId,
      time: new Date(started).toISOString().slice(11, 19),
      model: meta.model,
      status,
      ttfb: `${Math.max(0, headersAt - started)}ms`,
      tokens: tokens > 0 ? String(tokens) : "-",
      ...(stats?.inputTokens !== undefined ? { inputTokens: String(stats.inputTokens) } : {}),
      ...(stats?.cacheReadTokens !== undefined ? { cacheReadTokens: String(stats.cacheReadTokens) } : {}),
      ...(stats?.credentialKey ? { credentialKey: stats.credentialKey } : {}),
      ...(stats?.retried ? { retried: true } : {}),
      ...(stats?.captchaMs && stats.captchaMs > 0 ? { captchaMs: `${stats.captchaMs}ms` } : {}),
    });
  } catch { /* stats must never break the request path */ }

  printHeader();
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.stream ? "stream" : "batch";

  if (COMPACT_LOG) {
    const ttfbMs = headersAt - started;
    const totalMs = streamEndAt > started ? streamEndAt - started : ttfbMs;
    const ttfbStr = fmtMs(ttfbMs);
    const tokStr = tokens > 0 ? `${tokens}tok` : "";
    const tpsStr = avgTps > 0 ? `${avgTps.toFixed(0)}t/s` : "";
    const parts = [reqId, tag, meta.model, String(status), mode];
    if (meta.stream && streamEndAt > started) {
      parts.push(`${ttfbStr}→${fmtMs(totalMs)}`);
    } else {
      parts.push(ttfbStr);
    }
    if (tokStr) parts.push(tokStr);
    if (tpsStr) parts.push(tpsStr);
    console.log(parts.join(" "));
    return;
  }

  const ts = localTime(started);
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}
