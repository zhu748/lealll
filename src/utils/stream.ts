/** Byte-bounded queues with pull-driven backpressure for asynchronous SSE pumps. */
const drains = new WeakMap<ReadableStreamDefaultController<Uint8Array>, { wait: () => Promise<void>; closed: boolean }>();

export function createBackpressuredStream(source: UnderlyingDefaultSource<Uint8Array>, highWaterMark = 64 * 1024): ReadableStream<Uint8Array> {
  const waiters = new Set<() => void>();
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const state = { wait: () => new Promise<void>(resolve => { waiters.add(resolve); }), closed: false };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      drains.set(controller, state);
      // start must return immediately: pull() cannot run until start settles.
      void Promise.resolve().then(() => source.start?.(controller)).catch(err => {
        try { controller.error(err); } catch {}
      }).finally(() => { state.closed = true; drains.delete(controller); wake(); });
    },
    pull(controller) { wake(); return source.pull?.(controller); },
    cancel(reason) { state.closed = true; wake(); return source.cancel?.(reason); },
  }, { highWaterMark, size: chunk => chunk?.byteLength ?? 0 });
}

/** Returns false for ordinary streams, whose legacy bounded wait remains available. */
export async function waitForStreamCapacity(controller: ReadableStreamDefaultController<Uint8Array>, signal?: AbortSignal): Promise<boolean> {
  const state = drains.get(controller);
  if (!state) return false;
  while (!state.closed && controller.desiredSize !== null && controller.desiredSize <= 0) {
    if (signal?.aborted) throw signal.reason ?? new Error("stream cancelled");
    if (!signal) { await state.wait(); continue; }
    let abort: () => void = () => {};
    try {
      await Promise.race([state.wait(), new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("stream cancelled"));
        signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  }
  return true;
}
