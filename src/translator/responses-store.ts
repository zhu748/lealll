/**
 * In-memory store for `previous_response_id` conversation chaining.
 *
 * GLM upstream has no native Responses API or server-side conversation store,
 * so we keep the latest input + output of each response keyed by its id, and
 * replay it when the client sends `previous_response_id`.
 *
 * Cap is 256 entries with FIFO eviction — plenty for a single-user local proxy.
 * Restarting the proxy drops all stored conversations (matches the expectation
 * that a local proxy is short-lived; clients using `store:true` for long-lived
 * sessions should re-run `auth login` after a restart).
 */

interface StoredTurn {
  /** Input items sent by the client for this turn. */
  input: unknown[];
  /** Output items we returned to the client. */
  output: unknown[];
  /** Timestamp for debugging / expiry. */
  at: number;
}

const MAX_ENTRIES = 256;
const store = new Map<string, StoredTurn>();

/** Save a turn keyed by the response id (must be unique). */
export function saveTurn(responseId: string, input: unknown[], output: unknown[]): void {
  if (!responseId) return;
  if (store.size >= MAX_ENTRIES) {
    // FIFO eviction: drop the oldest entry
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
  store.set(responseId, { input, output, at: Date.now() });
}

/** Look up a stored turn by previous_response_id. Returns undefined if not found. */
export function getTurn(responseId: string): StoredTurn | undefined {
  return store.get(responseId);
}

/** Clear all stored turns. Used by tests. */
export function clearStore(): void {
  store.clear();
}
