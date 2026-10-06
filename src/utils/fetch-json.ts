import { readJsonLimited } from "../auth/quota.js";
import { hostSetTimeout, hostClearTimeout } from "./host-timers.js";

export class JsonHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** Bound headers and body together, including injected transports that ignore abort. */
export async function fetchJsonWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<any> {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(2_147_483_647, Math.ceil(timeoutMs)) : 15_000;
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort(init.signal?.reason);
    rejectAbort(init.signal?.reason ?? new Error("request cancelled"));
  };
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineAt = Date.now() + timeout;
  try {
    return await Promise.race([
      (async () => {
        if (controller.signal.aborted) throw init.signal?.reason ?? new Error("request cancelled");
        const response = await fetchImpl(input, { ...init, signal: controller.signal });
        if (controller.signal.aborted || !response.ok) {
          void response.body?.cancel().catch(() => {});
          if (controller.signal.aborted) throw new Error("request cancelled");
          throw new JsonHttpError(response.status);
        }
        return readJsonLimited(response, 1024 * 1024, Math.max(1, deadlineAt - Date.now()), controller.signal);
      })(),
      new Promise<never>((_, reject) => {
        timer = hostSetTimeout(() => {
          controller.abort();
          reject(new Error(`JSON request timeout after ${timeout}ms`));
        }, timeout);
        timer.unref?.();
      }),
      aborted,
    ]);
  } finally {
    if (timer) hostClearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
