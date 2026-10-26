/** Private shared-memory protocol for the synchronous HTTP bridge. */
export const SYNC_FETCH_HEADER_BYTES = 64;
export const SYNC_FETCH_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const SYNC_FETCH_DEFAULT_TIMEOUT_MS = 12_000;

export interface SyncFetchRequest {
  buffer: SharedArrayBuffer;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}

export interface SyncFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie: string[];
  body: Buffer;
}

export type SyncFetchResult = SyncFetchResponse | { error: string };

/** Atomics.wait treats NaN as an infinite wait; never pass unchecked values. */
export function resolveSyncFetchTimeoutMs(value: unknown): number {
  const timeout = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timeout) && timeout > 0
    ? Math.min(2_147_483_647, Math.ceil(timeout))
    : SYNC_FETCH_DEFAULT_TIMEOUT_MS;
}

/** Read only published, bounded data. The returned body owns its bytes. */
export function readSyncFetchResult(buffer: SharedArrayBuffer): SyncFetchResult {
  const header = new Int32Array(buffer, 0, 3);
  const state = Atomics.load(header, 0);
  const metadataLength = header[1];
  const bodyLength = header[2];
  const capacity = buffer.byteLength - SYNC_FETCH_HEADER_BYTES;
  if ((state !== 1 && state !== 2) || metadataLength < 0 || bodyLength < 0 || metadataLength + bodyLength > capacity) {
    throw new Error("invalid sync fetch response layout");
  }
  const payload = new Uint8Array(buffer, SYNC_FETCH_HEADER_BYTES);
  const text = new TextDecoder().decode(payload.subarray(0, metadataLength));
  if (state === 2) return { error: text || "sync fetch failed" };
  const metadata: unknown = JSON.parse(text);
  if (!isResponseMetadata(metadata)) throw new Error("invalid sync fetch response metadata");
  return { ...metadata, body: Buffer.from(payload.subarray(metadataLength, metadataLength + bodyLength)) };
}

function isResponseMetadata(value: unknown): value is Omit<SyncFetchResponse, "body"> {
  if (value === null || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return Number.isInteger(metadata.status) && Number(metadata.status) >= 100 && Number(metadata.status) <= 599
    && typeof metadata.statusText === "string"
    && metadata.headers !== null && typeof metadata.headers === "object" && !Array.isArray(metadata.headers)
    && Object.values(metadata.headers).every((header) => typeof header === "string")
    && Array.isArray(metadata.setCookie) && metadata.setCookie.every((cookie) => typeof cookie === "string");
}
