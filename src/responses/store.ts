/**
 * In-memory response store for the Responses API's `previous_response_id`.
 *
 * The Responses API is stateful: a client passes `previous_response_id`, and
 * the server (OpenAI) reconstructs the full conversation from that stored
 * response. On a non-OpenAI upstream (GLM Chat Completions) we must emulate
 * this ourselves — store each completed response keyed by id, and on the next
 * request prepend the stored `input[]` + `output[]` history so the upstream
 * sees a complete conversation.
 *
 * Backed by a bounded LRU cache with TTL eviction. Process restart drops
 * everything (documented limitation — OpenAI persists for ~30 days, we can't
 * match that without a persistence layer; in-memory is the P1.0 scope).
 *
 * Thread-safety: single-process; JS event loop serialises access.
 */

import type { ResponsesInputItem, ResponsesOutputItem, ResponsesUsage } from "../translator/responses-types.js";
import { ExpiryIndex } from "./expiry-index.js";

/** A stored response entry — enough to reconstruct the next turn's history. */
export interface StoredResponse {
  id: string;
  model: string;
  status: "completed" | "incomplete" | "failed";
  input: ResponsesInputItem[];
  output: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  instructions?: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface ResponseStoreOptions {
  /** Max entries before LRU eviction. Default 1000. */
  maxEntries?: number;
  /** TTL in ms before an entry is considered stale. Default 24h. */
  ttlMs?: number;
  /** Approximate total byte budget across all entries. Default 256 MiB.
   *  Entry-count bounds alone let 1000 long-context conversations occupy
   *  hundreds of MB of RSS; this evicts by size as well. */
  maxTotalBytes?: number;
  /** Clock injection for deterministic expiry tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

interface CachedResponse {
  response: StoredResponse;
  bytes: number;
  expiresAt: number;
}

/**
 * Rough per-entry size estimate (the two history arrays dominate; fixed
 * overhead is folded into a constant). One stringify per set() — request
 * frequency — is cheap next to unbounded RSS growth.
 */
function estimateEntryBytes(entry: StoredResponse): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8") + 256;
  } catch {
    return Infinity; // Unserializable histories cannot be safely retained.
  }
}

/**
 * Bounded LRU + TTL cache of stored responses. Iteration order = insertion
 * order; `get()` re-inserts to refresh LRU position. A separate expiry index
 * avoids scanning every live history on writes. Deadlines and byte accounting
 * belong to the cache; editing a returned response does not update them.
 */
export class ResponseStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly map = new Map<string, CachedResponse>();
  private readonly expiry = new ExpiryIndex();
  private totalBytes = 0;

  constructor(opts: ResponseStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Store a response. Overwrites on duplicate id. Evicts LRU entries on overflow (count OR bytes). */
  set(entry: StoredResponse): void {
    const now = this.now();
    // Expired entries must not force eviction of a still-live LRU entry.
    for (let id = this.expiry.nextExpired(now); id !== undefined; id = this.expiry.nextExpired(now)) {
      this.delete(id);
    }
    entry.createdAt = now;
    entry.lastAccessedAt = now;
    this.delete(entry.id);
    const bytes = estimateEntryBytes(entry);
    if (!Number.isFinite(bytes) || bytes > this.maxTotalBytes || this.maxEntries < 1) return;
    const expiresAt = now + this.ttlMs;
    this.totalBytes += bytes;
    this.map.set(entry.id, { response: entry, bytes, expiresAt });
    this.expiry.set(entry.id, expiresAt);
    while (this.map.size > 0 && (this.map.size > this.maxEntries || this.totalBytes > this.maxTotalBytes)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  /**
   * Fetch a stored response. Returns `undefined` when missing or stale.
   * Refreshes LRU position on hit.
   */
  get(id: string): StoredResponse | undefined {
    const entry = this.map.get(id);
    if (!entry) return undefined;
    const now = this.now();
    if (now > entry.expiresAt) {
      this.delete(id);
      return undefined;
    }
    entry.response.lastAccessedAt = now;
    // Re-insert at the tail so the LRU eviction touches it last.
    this.map.delete(id);
    this.map.set(id, entry);
    return entry.response;
  }

  delete(id: string): boolean {
    const entry = this.map.get(id);
    if (!entry) return false;
    this.totalBytes -= entry.bytes;
    this.map.delete(id);
    this.expiry.delete(id);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.expiry.clear();
    this.totalBytes = 0;
  }

  size(): number {
    return this.map.size;
  }

  /** Approximate total bytes held across all entries (for tests/monitoring). */
  totalBytesUsed(): number {
    return this.totalBytes;
  }
}
