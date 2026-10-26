import type { SyncFetchRequest } from "./captcha-sync-protocol.js";

/**
 * Self-contained worker program, serialized after TypeScript compilation.
 * All runtime dependencies must be obtained inside this function: eval workers
 * cannot capture module imports or bundle helpers from their parent.
 */
export function runSyncFetchWorker(load: NodeJS.Require): void {
  const { parentPort, workerData } = load("node:worker_threads") as typeof import("node:worker_threads");
  const { setTimeout, clearTimeout } = load("node:timers") as typeof import("node:timers");
  const headerBytes = (workerData as { headerBytes: number }).headerBytes;
  if (!parentPort) throw new Error("sync fetch worker requires a parent port");

  parentPort.on("message", async ({ buffer, url, init, timeoutMs }: SyncFetchRequest) => {
    // State: 0 = waiting, 1 = success, 2 = error. Payload = metadata + body.
    const header = new Int32Array(buffer, 0, 3);
    const payload = new Uint8Array(buffer, headerBytes);
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      const metadata = encoder.encode(JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        setCookie: typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [],
      }));
      if (metadata.byteLength > payload.byteLength) throw new Error("sync fetch metadata exceeds buffer capacity");
      payload.set(metadata);
      let bodyLength = 0;
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (metadata.byteLength + bodyLength + value.byteLength > payload.byteLength) {
            throw new Error("sync fetch response exceeds buffer capacity");
          }
          payload.set(value, metadata.byteLength + bodyLength);
          bodyLength += value.byteLength;
        }
      }
      header[1] = metadata.byteLength;
      header[2] = bodyLength;
      Atomics.store(header, 0, 1);
    } catch (error) {
      // Bound diagnostics too: an oversized error must still wake the host.
      const diagnostic = new Uint8Array(Math.min(payload.byteLength, 4096));
      const message = controller.signal.aborted ? "sync fetch timeout"
        : error instanceof Error ? error.message : String(error);
      const { written } = encoder.encodeInto(message, diagnostic);
      payload.set(diagnostic.subarray(0, written));
      header[1] = written;
      header[2] = 0;
      controller.abort();
      // Publish the error before cleanup: cancellation must not delay wakeup.
      Atomics.store(header, 0, 2);
    } finally {
      clearTimeout(timer);
      Atomics.notify(header, 0);
      try {
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        } else {
          void response?.body?.cancel().catch(() => {});
        }
      } catch { /* a locked or already-closed source is best-effort cleanup */ }
    }
  });
}
