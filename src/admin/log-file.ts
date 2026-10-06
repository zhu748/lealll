import { mkdirSync } from "node:fs";
import {
  appendFile as appendFileAsync,
  rename as renameAsync,
  rm as rmAsync,
  stat as statAsync,
} from "node:fs/promises";
import { dirname } from "node:path";
import { LOG as LOG_CONST } from "../utils/constants.js";
import { hostClearInterval, hostSetInterval } from "../utils/host-timers.js";

// G3: File logging — when set, each log entry is also appended to this file.
// Set via config.logging.file or env var ZCODE_PROXY_LOG_FILE.
let logFilePath: string | undefined;

// === CRITICAL FIX (管理面板刷新卡顿) ===
// Buffered async file logging — replaces the old `appendFileSync` per-log
// write which blocked the event loop on Windows. See appendLog() for the
// full rationale.
type PendingLogFileLine = { path: string; line: string };

const logFileBuffer: PendingLogFileLine[] = [];

let logFileFlushInterval: ReturnType<typeof setInterval> | null = null;

let logFileFlushInFlight: Promise<void> | null = null;

const LOG_FILE_FLUSH_WARN_INTERVAL_MS = 60_000;

const LOG_FILE_DROP_WARN_INTERVAL_MS = 60_000;

let logFileFlushWarnKey: string | undefined;

let logFileFlushLastWarnAt = 0;

let logFileDroppedSinceWarn = 0;

let logFileDropLastWarnAt = 0;

let logFileDropWarnInProgress = false;

let appendLogFile = appendFileAsync;

// --- log rotation (unbounded log-file growth guard) ---
// `logging.file` appends forever; a busy proxy can produce multi-GB JSONL
// files and fill a container disk. Size is checked (throttled to once per
// minute) inside the flush loop; when the cap is hit the current file is
// renamed to `.1` and older rotations are shifted/dropped.
const LOG_ROTATE_CHECK_INTERVAL_MS = 60_000;

const LOG_ROTATE_MAX_BYTES = 64 * 1024 * 1024;

const LOG_ROTATE_KEEP = 2;

let lastRotateCheckAt = 0;

async function maybeRotateLogFile(path: string): Promise<void> {
  const now = Date.now();
  if (now - lastRotateCheckAt < LOG_ROTATE_CHECK_INTERVAL_MS) return;
  lastRotateCheckAt = now;
  try {
    const st = await statAsync(path);
    if (st.size < LOG_ROTATE_MAX_BYTES) return;
    // Shift rotations: .{KEEP-1} -> .{KEEP}, ... , current -> .1
    try { await rmAsync(`${path}.${LOG_ROTATE_KEEP}`, { force: true }); } catch { /* best-effort */ }
    for (let i = LOG_ROTATE_KEEP - 1; i >= 1; i--) {
      try { await renameAsync(`${path}.${i}`, `${path}.${i + 1}`); } catch { /* no such rotation */ }
    }
    try { await renameAsync(path, `${path}.1`); } catch { /* best-effort */ }
  } catch {
    // stat failed (file missing/locked) — nothing to rotate; the next
    // appendFile recreates the file.
  }
}

function warnLogFileFlushFailure(path: string, message: string): void {
  const now = Date.now();
  const key = `${path}\0${message}`;
  if (key === logFileFlushWarnKey && now - logFileFlushLastWarnAt < LOG_FILE_FLUSH_WARN_INTERVAL_MS) {
    return;
  }
  logFileFlushWarnKey = key;
  logFileFlushLastWarnAt = now;
  console.warn(`[admin] Could not flush log file ${path}: ${message}`);
}

function warnLogFileBufferDrop(path: string): void {
  if (logFileDropWarnInProgress) return;
  logFileDroppedSinceWarn++;
  const now = Date.now();
  if (now - logFileDropLastWarnAt < LOG_FILE_DROP_WARN_INTERVAL_MS) return;
  const dropped = logFileDroppedSinceWarn;
  logFileDroppedSinceWarn = 0;
  logFileDropLastWarnAt = now;
  logFileDropWarnInProgress = true;
  try {
    console.warn(
      `[admin] Log file buffer is full (${LOG_CONST.FILE_BUFFER_MAX} pending entries); ` +
      `dropped ${dropped} log line(s) for ${path}. Disk may be slow or unavailable.`,
    );
  } finally {
    logFileDropWarnInProgress = false;
  }
}

/**
 * Flush the log file buffer to disk asynchronously. Called by the interval
 * timer (every 500ms) and on process exit (best-effort). Errors are logged
 * to console.warn with throttling and don't break the server.
 */
async function appendLogFileBatch(path: string, lines: string[]): Promise<void> {
  try {
    await maybeRotateLogFile(path);
    await appendLogFile(path, lines.join(""));
    logFileFlushWarnKey = undefined;
    logFileFlushLastWarnAt = 0;
  } catch (err) {
    warnLogFileFlushFailure(path, (err as Error).message);
  }
}

async function drainLogFileBuffer(): Promise<void> {
  while (logFileBuffer.length > 0) {
    // Snapshot and clear the buffer atomically. Each line captures the target
    // path at append time, so switching log files while a slow flush is active
    // cannot send old-path lines into the new file.
    const snapshot = logFileBuffer.splice(0, logFileBuffer.length);
    let currentPath = "";
    let lines: string[] = [];
    for (const item of snapshot) {
      if (currentPath && item.path !== currentPath) {
        await appendLogFileBatch(currentPath, lines);
        lines = [];
      }
      currentPath = item.path;
      lines.push(item.line);
    }
    if (currentPath && lines.length > 0) {
      await appendLogFileBatch(currentPath, lines);
    }
  }
}

async function flushLogFile(): Promise<void> {
  if (logFileFlushInFlight) return logFileFlushInFlight;
  if (logFileBuffer.length === 0) return;
  // Serialize async file appends. A slow disk / antivirus scan can easily make
  // the 500ms interval fire again before the previous append completes; without
  // this guard, concurrent appendFile calls can reorder log lines and add I/O
  // pressure exactly when the machine is already struggling.
  logFileFlushInFlight = drainLogFileBuffer().finally(() => {
    logFileFlushInFlight = null;
    if (logFileBuffer.length > 0) void flushLogFile();
  });
  return logFileFlushInFlight;
}

/**
 * Set the file path for persistent log output. Called from index.ts after
 * config is loaded. Each appendLog() call will also write the entry as a
 * JSON line to this file (buffered + async, see appendLog). Set to
 * undefined to disable file logging.
 */
export function setLogFilePath(path: string | undefined, onEnabled: (path: string) => void): void {
  // If we're switching paths or disabling, flush any pending entries first.
  // (Best-effort — don't block on this.)
  if (logFileBuffer.length > 0 && logFilePath) {
    void flushLogFile();
  }
  // Clear any existing interval before switching.
  if (logFileFlushInterval) {
    hostClearInterval(logFileFlushInterval);
    logFileFlushInterval = null;
  }
  logFilePath = path;
  logFileFlushWarnKey = undefined;
  logFileFlushLastWarnAt = 0;
  if (path) {
    // Ensure the parent directory exists
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch { /* may already exist */ }
    // Start the async flush interval — every LOG.FILE_FLUSH_INTERVAL_MS, drain the buffer.
    // This replaces the per-log appendFileSync which was blocking the event
    // loop on Windows (each sync write = 5-50ms with AV interference).
    logFileFlushInterval = hostSetInterval(flushLogFile, LOG_CONST.FILE_FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for this interval — it should only
    // fire while the server is running for other reasons.
    if (typeof logFileFlushInterval.unref === "function") {
      logFileFlushInterval.unref();
    }
    onEnabled(path);
  }
}

export function flushLogFileForShutdown(): Promise<void> {
  return flushLogFile();
}

export function _flushLogFileForTesting(): Promise<void> {
  return flushLogFileForShutdown();
}

export function _logFileFlushStateForTesting(): { pending: number; inFlight: boolean } {
  return { pending: logFileBuffer.length, inFlight: logFileFlushInFlight !== null };
}

export function _setLogFileAppendForTesting(fn?: typeof appendFileAsync): void {
  appendLogFile = fn ?? appendFileAsync;
}

export function _resetLogFileForTesting(): void {
  if (logFileFlushInterval) {
    hostClearInterval(logFileFlushInterval);
    logFileFlushInterval = null;
  }
  logFilePath = undefined;
  logFileBuffer.length = 0;
  logFileFlushInFlight = null;
  appendLogFile = appendFileAsync;
  logFileFlushWarnKey = undefined;
  logFileFlushLastWarnAt = 0;
  logFileDroppedSinceWarn = 0;
  logFileDropLastWarnAt = 0;
  logFileDropWarnInProgress = false;
}

/** Queue a serialized line with the path active at append time. */
export function appendLogFileLine(line: string): void {
  if (!logFilePath) return;
  if (logFileBuffer.length < LOG_CONST.FILE_BUFFER_MAX) {
    logFileBuffer.push({ path: logFilePath, line });
  } else {
    warnLogFileBufferDrop(logFilePath);
  }
}
