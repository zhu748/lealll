import { errorResponse } from "../proxy/translated-response.js";
import {
  appendLogFileLine,
  _resetLogFileForTesting as resetFileLog,
  setLogFilePath as setFileLogPath,
} from "./log-file.js";
import { LOG as LOG_CONST } from "../utils/constants.js";
import { jsonResp } from "./security.js";
import {
  hostClearInterval,
  hostClearTimeout,
  hostSetInterval,
  hostSetTimeout,
} from "../utils/host-timers.js";
import type { AdminRouteContext } from "./types.js";
import { parseQueryLimit } from "./http-utils.js";

// A bounded ring retains recent logs; monotonic sequence cursors survive
// overwrites and let SSE subscribers resume without missing or replaying entries.
const LOG_BUFFER_SIZE = LOG_CONST.BUFFER_SIZE;

// Appending overwrites one slot instead of shifting the retained history.
type LogEntry = { seq: number; time: string; level: string; message: string };

type SerializedLogEntry = { entry: LogEntry; json: string; sse: string };

type LogWaiter = {
  resolve: (value: SerializedLogEntry) => void;
  resolveBatch: (values: readonly SerializedLogEntry[]) => void;
  flush: () => void;
};

const logBufferRing = new Array<LogEntry | null>(LOG_BUFFER_SIZE).fill(null);

let logRingWrite = 0;

  // next write position (wraps around)
let logRingCount = 0;

  // number of valid entries (0..LOG_BUFFER_SIZE)
let logSeq = 0;

 // monotonic, never reset — used as client cursor
const MAX_LOG_STREAM_SUBSCRIBERS = 50;

const logWaiters: LogWaiter[] = [];

// v0.2.2+ PERF: pending batch of log entries to fan out in one microtask.
// See appendLog() for the rationale.
let pendingLogEntries: SerializedLogEntry[] = [];

let logFlushScheduled = false;

let pendingLogOverflow = false;

const MAX_PENDING_LOG_FANOUT = 512;

const DEFAULT_LOG_STREAM_BACKPRESSURE_CHUNKS = 256;

let logStreamBackpressureChunksForTesting: number | undefined;

export function _logWaiterCountForTesting(): number {
  return logWaiters.length;
}

export function _setLogStreamBackpressureLimitForTesting(chunks?: number): void {
  logStreamBackpressureChunksForTesting = typeof chunks === "number" && Number.isFinite(chunks)
    ? Math.max(1, Math.floor(chunks))
    : undefined;
}

/**
 * Iterate over the ring buffer in order (oldest → newest).
 * Yields only non-null entries. Used by SSE flush and batch endpoint.
 */
function* iterRingBuffer(): Generator<LogEntry> {
  if (logRingCount === 0) return;
  // If the buffer isn't full yet, start from index 0.
  // If full, logRingWrite points to the OLDEST entry (next to be overwritten).
  const start = logRingCount < LOG_BUFFER_SIZE ? 0 : logRingWrite;
  for (let i = 0; i < logRingCount; i++) {
    const idx = (start + i) % LOG_BUFFER_SIZE;
    const entry = logBufferRing[idx];
    if (entry) yield entry;
  }
}

/**
 * Return the most recent log entries in chronological order without first
 * materializing the whole ring. Used by dashboard refresh paths where the
 * caller only needs a tail window.
 */
function recentRingEntries(limit: number): LogEntry[] {
  if (logRingCount === 0 || limit <= 0) return [];
  const count = Math.min(Math.floor(limit), logRingCount);
  const result: LogEntry[] = [];
  const oldest = logRingCount < LOG_BUFFER_SIZE ? 0 : logRingWrite;
  const first = logRingCount - count;
  for (let i = 0; i < count; i++) {
    const idx = (oldest + first + i) % LOG_BUFFER_SIZE;
    const entry = logBufferRing[idx];
    if (entry) result.push(entry);
  }
  return result;
}

/**
 * Return the most recent matching log entries in chronological order without
 * materializing/filtering the whole ring. This keeps the dashboard's filtered
 * log polling cheap after the process has been running for a long time.
 */
function recentMatchingRingEntries(limit: number, level?: string | null, search?: string | null): LogEntry[] {
  if (logRingCount === 0 || limit <= 0) return [];
  const count = Math.min(Math.floor(limit), logRingCount);
  const result: LogEntry[] = [];
  const oldest = logRingCount < LOG_BUFFER_SIZE ? 0 : logRingWrite;
  for (let i = logRingCount - 1; i >= 0; i--) {
    const idx = (oldest + i) % LOG_BUFFER_SIZE;
    const entry = logBufferRing[idx];
    if (!entry) continue;
    if (level && entry.level !== level) continue;
    if (search && !entry.message.toLowerCase().includes(search)) continue;
    result.push(entry);
    if (result.length >= count) break;
  }
  return result.reverse();
}

/** Add a log entry to the buffer (called by intercepting console.log). */
export function appendLog(level: string, message: string) {
  // v0.2.2+: keep log storage compact by default, but reserve more room for
  // explicit diagnostics. `console.log("[debug] ...")` arrives here as level
  // "info", so content tags matter in addition to the structured level.
  const isDebugDiagnostic = level === "debug" || message.includes("[debug]");
  const isVerbose = message.includes("[verbose]");
  const maxLen = isDebugDiagnostic
    ? LOG_CONST.DEBUG_MAX_CHARS
    : isVerbose
      ? LOG_CONST.VERBOSE_MAX_CHARS
      : LOG_CONST.REGULAR_MAX_CHARS;
  const entry = {
    seq: ++logSeq,
    time: new Date().toISOString().slice(11, 19),
    level,
    message: message.slice(0, maxLen),
  };
  const entryJson = JSON.stringify(entry);
  const serializedEntry: SerializedLogEntry = {
    entry,
    json: entryJson,
    sse: `data: ${entryJson}\n\n`,
  };
  // Ring buffer write — overwrite oldest when full
  logBufferRing[logRingWrite] = entry;
  logRingWrite = (logRingWrite + 1) % LOG_BUFFER_SIZE;
  if (logRingCount < LOG_BUFFER_SIZE) logRingCount++;
  appendLogFileLine(entryJson + "\n");
  // Batch fan-out in one microtask, sharing serialization across subscribers.
  // A synchronous burst is capped; on overflow subscribers resume from the ring.
  if (!pendingLogOverflow) {
    if (pendingLogEntries.length < MAX_PENDING_LOG_FANOUT) {
      pendingLogEntries.push(serializedEntry);
    } else {
      // A synchronous log storm can enqueue thousands of entries before the
      // microtask below gets a chance to run. Don't let that pending array
      // grow without bound; ask each SSE client to flush from the ring buffer
      // cursor once instead. The ring is capped, so memory stays bounded and
      // clients still receive the latest retained entries in order.
      pendingLogOverflow = true;
      pendingLogEntries = [];
    }
  }
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    queueMicrotask(() => {
      logFlushScheduled = false;
      const batch = pendingLogEntries;
      const overflow = pendingLogOverflow;
      pendingLogEntries = [];
      pendingLogOverflow = false;
      // Iterate a snapshot in case logWaiters is mutated during the loop
      // (a waiter's resolve() may register a new waiter via re-poll).
      const waiters = logWaiters.slice();
      for (const w of waiters) {
        try {
          if (overflow) {
            w.flush();
          } else if (batch.length === 1) {
            w.resolve(batch[0]);
          } else if (batch.length > 1) {
            w.resolveBatch(batch);
          }
        } catch { /* controller closed */ }
      }
    });
  }
}

/** Feature handler; authorization is enforced by admin/router.ts. */
export function handleLogsRoutes(context: AdminRouteContext): Response | null {
  const { url, path, method } = context;

  // Each connection registers one long-lived waiter. Sequence cursors and
  // a scan after registration close the initial replay race without re-pushing
  // waiters during fan-out. Cancellation releases timers and subscriber state.
  if (path === "/admin/api/logs/stream" && method === "GET") {
    if (logWaiters.length >= MAX_LOG_STREAM_SUBSCRIBERS) {
      return errorResponse(
        503,
        "too_many_log_streams",
        `Too many concurrent log stream connections (max ${MAX_LOG_STREAM_SUBSCRIBERS}). Close other dashboard tabs and retry.`,
      );
    }
    let lastSentSeq = logSeq;
    let cleanup: (() => void) | null = null;
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const backpressureLimit = logStreamBackpressureChunksForTesting ?? DEFAULT_LOG_STREAM_BACKPRESSURE_CHUNKS;
        let streamWaiter: LogWaiter | null = null;
        const closeLogStream = (): void => {
          closed = true;
          cleanup?.();
          if (streamWaiter) {
            const idx = logWaiters.indexOf(streamWaiter);
            if (idx >= 0) logWaiters.splice(idx, 1);
          }
          try { controller.close(); } catch { /* already closed */ }
        };
        const sendPayload = (payload: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(payload));
            const desiredSize = controller.desiredSize;
            if (typeof desiredSize === "number" && desiredSize <= -backpressureLimit) {
              closeLogStream();
              return false;
            }
            return true;
          } catch {
            // The client is already gone. Clean up immediately instead of
            // keeping a dead waiter until the next heartbeat/maxTimeout.
            closeLogStream();
            return false;
          }
        };
        const sendBatch = (entries: readonly LogEntry[], respectCursor = true): boolean => {
          if (closed || entries.length === 0) return !closed;
          let payload = "";
          let nextSeq = lastSentSeq;
          for (const entry of entries) {
            if (respectCursor && entry.seq <= nextSeq) continue;
            payload += `data: ${JSON.stringify(entry)}\n\n`;
            if (entry.seq > nextSeq) nextSeq = entry.seq;
          }
          if (!payload) return true;
          if (!sendPayload(payload)) return false;
          lastSentSeq = nextSeq;
          return true;
        };
        const sendSerializedBatch = (entries: readonly SerializedLogEntry[]): boolean => {
          if (closed || entries.length === 0) return !closed;
          let payload = "";
          let nextSeq = lastSentSeq;
          for (const item of entries) {
            const entry = item.entry;
            if (entry.seq <= nextSeq) continue;
            payload += item.sse;
            if (entry.seq > nextSeq) nextSeq = entry.seq;
          }
          if (!payload) return true;
          if (!sendPayload(payload)) return false;
          lastSentSeq = nextSeq;
          return true;
        };
        const sendSerialized = (entry: SerializedLogEntry): boolean => sendSerializedBatch([entry]);

        // Flush any new entries with seq > lastSentSeq, then advance cursor.
        // Used by the safety-net polling interval only — push delivery goes
        // through waiter.resolve(entry) directly, no full buffer scan needed.
        const flushNew = () => {
          const pending: LogEntry[] = [];
          for (const e of iterRingBuffer()) {
            if (e.seq > lastSentSeq) {
              pending.push(e);
            }
          }
          if (pending.length > 0 && !sendBatch(pending)) return;
          if (!closed) lastSentSeq = logSeq;
        };

        // Replay only the newest INITIAL_REPLAY_LIMIT entries to bound refresh
        // work. Older retained entries remain available through /admin/api/logs;
        // retention and replay limits can be tuned independently.
        const replay = recentRingEntries(LOG_CONST.INITIAL_REPLAY_LIMIT);
        const replayEndSeq = replay.length > 0 ? replay[replay.length - 1].seq : logSeq;
        if (!sendBatch(replay, false)) return;
        // Advance only to the last entry we actually replayed. If a log is
        // appended between the replay snapshot and waiter registration, it is
        // not in `replay`; flushNew below must still be able to deliver it.
        lastSentSeq = replayEndSeq;

        // Long-lived waiter: appendLog() calls resolve(entry) for every
        // connected SSE client. resolve() just sends the entry directly —
        // NO re-push, NO flushNew (the entry is right here, no need to
        // re-scan the buffer). The waiter stays in logWaiters until the
        // connection closes (cancel() handler removes it).
        const waiter: LogWaiter = {
          resolve: (entry: SerializedLogEntry) => {
            if (closed) return;
            // The value IS the new log entry — send it directly.
            // No need to flushNew() because we have the entry right here.
            if (entry.entry.seq > lastSentSeq) {
              sendSerialized(entry);
            }
          },
          resolveBatch: (entries: readonly SerializedLogEntry[]) => {
            if (closed) return;
            sendSerializedBatch(entries);
          },
          flush: flushNew,
        };
        streamWaiter = waiter;
        logWaiters.push(waiter);
        // v0.2.0.8: cap concurrent SSE log subscribers. Each connected
        // dashboard tab holds one entry here; without a cap a script (or a
        // browser tab flood) could grow logWaiters unbounded, and every
        // appendLog call would fan out to all of them. 50 is plenty for any
        // realistic ops use; a 51st connection gets a 503 + explanatory
        // message so the client can retry with backoff. The route-level
        // preflight above rejects before initial replay; this guard is kept
        // as a defensive backstop if stream starts interleave unexpectedly.
        if (logWaiters.length > MAX_LOG_STREAM_SUBSCRIBERS) {
          logWaiters.pop(); // undo the push
          closed = true;
          controller.error(new Error(`Too many concurrent log stream connections (max ${MAX_LOG_STREAM_SUBSCRIBERS}). Close other dashboard tabs and retry.`));
          return;
        }

        // Close the narrow race window between initial replay and waiter
        // registration. This is cheap (ring buffer is bounded) and prevents
        // rare dashboard log gaps on refresh.
        flushNew();

        // Cleanup owns all timers and the waiter; interval callbacks run only
        // after this closure and its cleanup function have been initialized.
        let interval: ReturnType<typeof setInterval> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let maxTimeout: ReturnType<typeof setTimeout> | null = null;

        const doCleanup = () => {
          closed = true;
          if (interval) hostClearInterval(interval);
          if (heartbeat) hostClearInterval(heartbeat);
          if (maxTimeout) hostClearTimeout(maxTimeout);
          const idx = logWaiters.indexOf(waiter);
          if (idx >= 0) logWaiters.splice(idx, 1);
        };
        cleanup = doCleanup;

        // Safety-net polling: 2s interval, used only to recover from the
        // rare race where appendLog fires between the buffer-scan above and
        // the logWaiters.push() above. Slow enough to be cheap on idle
        // systems; fast enough that the race window is negligible.
        interval = hostSetInterval(() => {
          if (closed) return;
          flushNew();
        }, 2000);
        interval.unref?.();

        // Heartbeats keep idle proxy connections alive and detect abandoned
        // clients. SSE comments do not generate browser message events.
        heartbeat = hostSetInterval(() => {
          if (closed) return;
          if (!sendPayload(`: heartbeat\n\n`)) {
            // enqueue failed — client is gone. Trigger cleanup.
            doCleanup();
            try { controller.close(); } catch { /* already closed */ }
          }
        }, LOG_CONST.HEARTBEAT_MS);
        heartbeat.unref?.();

        // Bound leaked connection lifetimes. EventSource reconnects after close.
        maxTimeout = hostSetTimeout(() => {
          doCleanup();
          try { controller.close(); } catch { /* already closed */ }
        }, LOG_CONST.MAX_CONNECTION_MS);
        maxTimeout.unref?.();
      },
      cancel() {
        // Cleanup if the client disconnects early
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        // Disable Nagle's algorithm for snappier streaming
        "x-accel-buffering": "no",
      },
    });
  }

  // Get logs (batch)
  if (path === "/admin/api/logs" && method === "GET") {
    const level = url.searchParams.get("level");
    const search = url.searchParams.get("search")?.toLowerCase();
    const limit = parseQueryLimit(url.searchParams.get("limit"), 200, 2000);
    const logs = level || search
      ? recentMatchingRingEntries(limit, level, search)
      : recentRingEntries(limit);
    return jsonResp({ logs, total: logRingCount });
  }
  return null;
}

export {
  _flushLogFileForTesting,
  _logFileFlushStateForTesting,
  _setLogFileAppendForTesting,
  flushLogFileForShutdown,
} from "./log-file.js";

export function setLogFilePath(path: string | undefined): void {
  setFileLogPath(path, enabledPath => appendLog("info", `File logging enabled: ${enabledPath}`));
}

export function _resetLogFileForTesting(): void {
  resetFileLog();
  logStreamBackpressureChunksForTesting = undefined;
}
