import { SSE_HEARTBEAT as SSE_HEARTBEAT_CONST } from "../utils/constants.js";

/**
 * SSE heartbeat transform — keeps the client connection alive while the
 * upstream is slow to emit its first byte.
 *
 * Mechanism: while no real chunk has arrived from upstream yet, flush a
 * no-op SSE comment line (`: keepalive\n\n`) to the client every
 * `intervalMs`. SSE comment lines are spec-compliant and silently ignored
 * by every conformant client. Once the first real chunk arrives, the
 * heartbeat stops immediately.
 */
export function withSseHeartbeat(source: ReadableStream<Uint8Array>, intervalMs: number): ReadableStream<Uint8Array> {
  // Disabled / invalid interval — pure passthrough, no timer.
  if (!intervalMs || intervalMs <= 0) {
    return source;
  }

  const commentBytes = new TextEncoder().encode(SSE_HEARTBEAT_CONST.COMMENT_LINE);
  const reader = source.getReader();
  let firstChunkSeen = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let readInFlight = false;

  const stopHeartbeat = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const closeAll = (): void => {
    closed = true;
    stopHeartbeat();
  };

  const flushHeartbeat = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (closed || firstChunkSeen) return;
    if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
    try {
      controller.enqueue(commentBytes);
    } catch {
      // Stream errored or closed — stop the timer to prevent leak.
      closeAll();
      void reader.cancel("heartbeat enqueue failed").catch(() => {}).finally(() => {
        try { reader.releaseLock(); } catch {}
      });
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Kick off the heartbeat immediately. We use setInterval (not
      // setTimeout chain) because it's cheaper and Bun's timer impl
      // doesn't drift under load the way recursive setTimeout can.
      timer = setInterval(() => flushHeartbeat(controller), intervalMs);
      // Don't keep the event loop alive solely for heartbeat — if the
      // only thing pending is our timer, the process should be able to
      // exit. The real request pipeline (fetch response body) holds the
      // loop alive anyway.
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    async pull(controller) {
      if (closed || readInFlight) return;
      readInFlight = true;
      const safeClose = (): void => {
        if (closed) return;
        closeAll();
        try { controller.close(); } catch {}
      };
      const safeError = (err: unknown): void => {
        if (closed) return;
        closeAll();
        try { controller.error(err); } catch {}
      };
      const safeEnqueue = (value: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(value);
          return true;
        } catch (err) {
          safeError(err);
          return false;
        }
      };
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          try { reader.releaseLock(); } catch {}
          safeClose();
          return;
        }
        // First real chunk from upstream — stop the heartbeat forever.
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          stopHeartbeat();
        }
        if (value && !safeEnqueue(value)) {
          try { await reader.cancel("downstream closed"); } catch {}
          try { reader.releaseLock(); } catch {}
        }
      } catch (err) {
        try { reader.releaseLock(); } catch {}
        safeError(err);
      } finally {
        readInFlight = false;
      }
    },
    async cancel(reason) {
      closeAll();
      try {
        await reader.cancel(reason);
      } catch {
        // Best-effort cancellation; the downstream is already gone.
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
  });
}
