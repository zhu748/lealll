/**
 * In-memory store for `previous_response_id` conversation chaining.
 *
 * GLM upstream has no native Responses API or server-side conversation store,
 * so we keep the latest input + output of each response keyed by its id, and
 * replay it when the client sends `previous_response_id`.
 *
 * Cap is 256 entries with LRU eviction — plenty for a single-user local proxy.
 * Per-entry byte size is also capped (MAX_ENTRY_BYTES, default 256 KB) to
 * prevent OOM when a Codex CLI conversation grows long: each turn can carry
 * 100K+ tokens of cumulative context, and 256 × unbounded = OOM risk.
 *
 * v0.2.2+ LRU + TTL: entries are now evicted by BOTH least-recently-used
 * (getTurn updates lastAccessAt, saveTurn bumps it on overwrite) AND by a
 * 24h TTL (entries older than 24h are treated as misses and deleted on
 * access). This prevents the store from holding stale conversations
 * forever — a previous concern when the proxy runs for days/weeks.
 *
 * Restarting the proxy drops all stored conversations (matches the expectation
 * that a local proxy is short-lived; clients using `store:true` for long-lived
 * sessions should re-run `auth login` after a restart).
 *
 * v0.2.0.8 NOTE: persistence to disk was considered (so Codex sessions
 * survive restarts) but deliberately NOT implemented because:
 *   1. Conversation history may contain sensitive code/prompts — encrypting
 *      it with the fixed "520" key offers only obfuscation (see auth/store.ts).
 *   2. Schema migrations across versions add complexity for marginal benefit.
 *   3. The primary deployment (apikey mode, short-lived container) rarely
 *      benefits from cross-restart session continuity.
 * If you need this, consider implementing an opt-in ZCODE_RESPONSES_PERSIST
 * env flag that serializes the store to STORE_DIR/responses.json with the
 * same AES-256-GCM fixed-key encryption used for credentials.
 */

interface StoredTurn {
  /** Input items sent by the client for this turn. */
  input: unknown[];
  /** Output items we returned to the client. */
  output: unknown[];
  /** Timestamp when this turn was saved (for TTL expiry). */
  at: number;
  /** v0.2.2+: Timestamp of the last getTurn() access (for LRU eviction). */
  lastAccessAt: number;
  /** Approximate serialized size in bytes (capped on insertion). */
  bytes: number;
}

const MAX_ENTRIES = 256;
/** Max serialized size per entry. Entries larger than this are stored with
 *  older history removed first. Recent output is preferred, but single
 *  oversized input/output items are replaced with compact markers so the
 *  memory cap is enforced. */
const MAX_ENTRY_BYTES = 256 * 1024;
const EMPTY_ARRAY_BYTES = 2;
/** v0.2.2+: TTL — entries older than this are treated as misses and deleted
 *  on next access. 24h matches Codex CLI's typical session lifetime. */
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map<string, StoredTurn>();
const utf8Encoder = new TextEncoder();

function utf8Bytes(json: string): number {
  return utf8Encoder.encode(json).byteLength;
}

/** Approximate byte length of a value when JSON-serialized. Treat circular /
 *  un-stringifiable values as oversized so they are replaced by a marker
 *  instead of being kept indefinitely. */
function approxBytes(v: unknown): number {
  try {
    const json = JSON.stringify(v);
    return typeof json === "string" ? utf8Bytes(json) : MAX_ENTRY_BYTES + 1;
  } catch {
    return MAX_ENTRY_BYTES + 1;
  }
}

function truncationMarker(kind: "input" | "output", originalBytes: number): unknown {
  return {
    type: "message",
    role: kind === "output" ? "assistant" : "user",
    content: `[zcode-proxy truncated oversized previous_response_id ${kind} history (${originalBytes} bytes)]`,
  };
}

function cloneStoredValue(value: unknown, kind: "input" | "output"): unknown {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return truncationMarker(kind, approxBytes(value));
    }
  }
}

function cloneItems(items: unknown[], kind: "input" | "output"): unknown[] {
  return items.map(item => cloneStoredValue(item, kind));
}

function jsonArrayElementBytes(item: unknown): number | null {
  try {
    const json = JSON.stringify([item]);
    return typeof json === "string" ? utf8Bytes(json) - 2 : null;
  } catch {
    return null;
  }
}

function fitItemsToBudgetSlowPath(items: unknown[], budget: number, kind: "input" | "output"): unknown[] {
  for (let start = 0; start < items.length; start++) {
    const suffix = start === 0 ? items : items.slice(start);
    if (approxBytes(suffix) <= budget) return suffix;
    if (items.length - start === 1) {
      const marker = truncationMarker(kind, approxBytes(items[start]));
      return approxBytes([marker]) <= budget ? [marker] : [];
    }
  }
  return [];
}

function fitItemsToBudget(items: unknown[], budget: number, kind: "input" | "output"): unknown[] {
  if (budget <= 2) return [];
  if (items.length === 0) return [];

  let totalBytes = 2; // JSON array brackets: []
  const elementBytes: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const bytes = jsonArrayElementBytes(items[i]);
    if (bytes === null) return fitItemsToBudgetSlowPath(items, budget, kind);
    elementBytes.push(bytes);
    totalBytes += bytes + (i === 0 ? 0 : 1); // comma between array elements
  }

  let start = 0;
  let remaining = items.length;
  while (remaining > 1 && totalBytes > budget) {
    totalBytes -= elementBytes[start] + 1; // remove the element and its comma
    start++;
    remaining--;
  }

  if (totalBytes <= budget) return start === 0 ? items : items.slice(start);

  const marker = truncationMarker(kind, approxBytes(items[start]));
  return approxBytes([marker]) <= budget ? [marker] : [];
}

/** Fit the stored history within MAX_ENTRY_BYTES. We prefer preserving recent
 *  output (what the model just said), then keep as much recent input as fits.
 *  Both sides have a hard fallback marker for single oversized items so the
 *  advertised per-entry cap is real, not best-effort. */
function fitToBytes(input: unknown[], output: unknown[]): { input: unknown[]; output: unknown[]; bytes: number } {
  const fittedOutput = fitItemsToBudget(output, MAX_ENTRY_BYTES - EMPTY_ARRAY_BYTES, "output");
  const outputBytes = approxBytes(fittedOutput);
  const fittedInput = fitItemsToBudget(input, MAX_ENTRY_BYTES - outputBytes, "input");
  return {
    input: fittedInput,
    output: fittedOutput,
    bytes: approxBytes(fittedInput) + outputBytes,
  };
}

/**
 * v0.2.2+ LRU eviction: drop the entry with the oldest `lastAccessAt`.
 * Falls back to FIFO (oldest `at`) if all lastAccessAt values are equal
 * (shouldn't happen in practice, but defensive). Only called when the store
 * is at capacity.
 */
function evictLRU(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, turn] of store) {
    const time = turn.lastAccessAt ?? turn.at;
    if (time < oldestTime) {
      oldestTime = time;
      oldestKey = key;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

function pruneExpired(now: number): void {
  for (const [key, turn] of store) {
    if (now - turn.at > ENTRY_TTL_MS) {
      store.delete(key);
    }
  }
}

/** Save a turn keyed by the response id (must be unique). */
export function saveTurn(responseId: string, input: unknown[], output: unknown[]): void {
  if (!responseId) return;
  const now = Date.now();
  pruneExpired(now);
  // v0.2.2+ LRU: if the store is at capacity AND this is a NEW key (not an
  // overwrite of an existing one), evict the least-recently-used entry first.
  // Overwriting an existing key doesn't grow the store, so we skip eviction.
  while (store.size >= MAX_ENTRIES && !store.has(responseId)) {
    const before = store.size;
    evictLRU();
    if (store.size === before) break;
  }
  const fitted = fitToBytes(input, output);
  store.set(responseId, {
    input: cloneItems(fitted.input, "input"),
    output: cloneItems(fitted.output, "output"),
    at: now,
    lastAccessAt: now,
    bytes: fitted.bytes,
  });
}

/** Look up a stored turn by previous_response_id. Returns undefined if not found
 *  or if the entry has expired (TTL). Expired entries are deleted on access. */
export function getTurn(responseId: string): StoredTurn | undefined {
  const turn = store.get(responseId);
  if (!turn) return undefined;
  // v0.2.2+ TTL: check if the entry has expired. If so, delete it and return
  // undefined — the client will see a "not found" and should start a fresh
  // conversation (Codex CLI handles this gracefully by re-sending full context).
  const now = Date.now();
  if (now - turn.at > ENTRY_TTL_MS) {
    store.delete(responseId);
    return undefined;
  }
  // v0.2.2+ LRU: update lastAccessAt so this entry moves to the "recently used"
  // end of the eviction order. Map preserves insertion order, but evictLRU
  // uses lastAccessAt (not insertion order) so this update is what actually
  // keeps the entry from being evicted.
  turn.lastAccessAt = now;
  return {
    ...turn,
    input: cloneItems(turn.input, "input"),
    output: cloneItems(turn.output, "output"),
  };
}

/** Total bytes currently held by the store. Exposed for diagnostics. */
export function totalBytes(): number {
  let sum = 0;
  for (const v of store.values()) sum += v.bytes;
  return sum;
}

/** Number of entries currently in the store. Exposed for diagnostics. */
export function entryCount(): number {
  return store.size;
}

/** Clear all stored turns. Used by tests. */
export function clearStore(): void {
  store.clear();
}
