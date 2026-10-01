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
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Rough per-entry size estimate (the two history arrays dominate; fixed
 * overhead is folded into a constant). One stringify per set() — request
 * frequency — is cheap next to unbounded RSS growth.
 */
function estimateEntryBytes(entry: StoredResponse): number {
  try {
    return JSON.stringify(entry.input).length + JSON.stringify(entry.output).length + 256;
  } catch {
    return 4096; // circular/unserializable — assume a modest size
  }
}

/**
 * Bounded LRU + TTL cache of stored responses. Iteration order = insertion
 * order; `get()` re-inserts to refresh LRU position. Stale entries are evicted
 * lazily on access and proactively on `set()` overflow.
 */
export class ResponseStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly map = new Map<string, StoredResponse>();
  private readonly bytesById = new Map<string, number>();
  private totalBytes = 0;

  constructor(opts: ResponseStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  /** Store a response. Overwrites on duplicate id. Evicts LRU entries on overflow (count OR bytes). */
  set(entry: StoredResponse): void {
    const now = Date.now();
    entry.createdAt = now;
    entry.lastAccessedAt = now;
    if (this.map.has(entry.id)) {
      this.totalBytes -= this.bytesById.get(entry.id) ?? 0;
      this.bytesById.delete(entry.id);
      this.map.delete(entry.id);
    }
    const bytes = estimateEntryBytes(entry);
    this.bytesById.set(entry.id, bytes);
    this.totalBytes += bytes;
    this.map.set(entry.id, entry);
    while (this.map.size > 0 && (this.map.size > this.maxEntries || this.totalBytes > this.maxTotalBytes)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      // Always keep the just-inserted entry even if it alone busts the
      // budget — the bytes are already spent; evicting it would lose the
      // response the client is about to reference by id.
      if (oldestKey === entry.id && this.map.size === 1) break;
      this.map.delete(oldestKey);
      this.totalBytes -= this.bytesById.get(oldestKey) ?? 0;
      this.bytesById.delete(oldestKey);
    }
  }

  /**
   * Fetch a stored response. Returns `undefined` when missing or stale.
   * Refreshes LRU position on hit.
   */
  get(id: string): StoredResponse | undefined {
    const entry = this.map.get(id);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.map.delete(id);
      this.totalBytes -= this.bytesById.get(id) ?? 0;
      this.bytesById.delete(id);
      return undefined;
    }
    entry.lastAccessedAt = now;
    // Re-insert at the tail so the LRU eviction touches it last.
    this.map.delete(id);
    this.map.set(id, entry);
    return entry;
  }

  delete(id: string): boolean {
    const removed = this.map.delete(id);
    if (removed) {
      this.totalBytes -= this.bytesById.get(id) ?? 0;
      this.bytesById.delete(id);
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
    this.bytesById.clear();
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
