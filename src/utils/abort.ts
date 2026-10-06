/** Stop awaiting work on cancellation, even when an injected transport ignores the signal. */
export async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("operation cancelled"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
