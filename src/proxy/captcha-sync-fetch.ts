/** Blocking HTTP bridge used only by the captcha DOM's synchronous XHR hook. */
import { Worker } from "node:worker_threads";
import { runSyncFetchWorker } from "./captcha-sync-worker.js";
import {
  readSyncFetchResult,
  resolveSyncFetchTimeoutMs,
  SYNC_FETCH_HEADER_BYTES,
  SYNC_FETCH_PAYLOAD_BYTES,
  type SyncFetchResult,
} from "./captcha-sync-protocol.js";

// No file asset or child executable: the program remains embedded in compiled
// Bun binaries and the Android Node bundle, matching the original mechanism.
const WORKER_SOURCE = `(${runSyncFetchWorker.toString()})(require);`;
let worker: Worker | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(WORKER_SOURCE, { eval: true, workerData: { headerBytes: SYNC_FETCH_HEADER_BYTES } });
  // Idle bridge workers must not keep a closed solver process alive.
  created.unref();
  created.on("error", () => {
    if (worker === created) worker = null;
  });
  created.on("exit", () => {
    if (worker === created) worker = null;
  });
  worker = created;
  return created;
}

export function syncFetchBlocking(
  url: string,
  init: RequestInit,
  timeout: unknown = process.env.CAPTCHA_SYNC_FETCH_TIMEOUT_MS,
): SyncFetchResult {
  try {
    const timeoutMs = resolveSyncFetchTimeoutMs(timeout);
    const buffer = new SharedArrayBuffer(SYNC_FETCH_HEADER_BYTES + SYNC_FETCH_PAYLOAD_BYTES);
    const header = new Int32Array(buffer, 0, 3);
    ensureWorker().postMessage({ buffer, url, init, timeoutMs });
    if (Atomics.wait(header, 0, 0, timeoutMs) === "timed-out") {
      // Cancel the actual request as well as the caller's wait. Never reuse a
      // timed-out worker while its previous fetch may still be running.
      shutdownSyncFetchWorker();
      return { error: "sync fetch timeout" };
    }
    return readSyncFetchResult(buffer);
  } catch (error) {
    shutdownSyncFetchWorker();
    return { error: `sync fetch error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function shutdownSyncFetchWorker(): void {
  const previous = worker;
  worker = null;
  if (previous) void previous.terminate().catch(() => {});
}
