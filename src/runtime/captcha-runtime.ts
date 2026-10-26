import { createSerialQueue } from "../utils/serial.js";

export interface CaptchaPoolRuntime {
  startCaptchaPool(appVersion: string): Promise<void>;
  shutdownCaptcha(): void;
}

/**
 * Own a lazy captcha pool across proxy starts/stops. Startup may await config
 * or prefill; stop must cover both the current module and a late continuation.
 * Serialized restarts prevent an old cleanup from shutting down a newer pool.
 */
export function createCaptchaRuntime(
  load: () => Promise<CaptchaPoolRuntime> = () => import("../proxy/captcha.js"),
) {
  const run = createSerialQueue();
  let generation = 0;
  let active: CaptchaPoolRuntime | undefined;

  function dispose(service: CaptchaPoolRuntime): void {
    if (active === service) active = undefined;
    try { service.shutdownCaptcha(); } catch { /* shutdown is best-effort */ }
  }

  return {
    start(appVersion: string): Promise<void> {
      const requested = ++generation;
      return run(async () => {
        if (requested !== generation) return;
        let service: CaptchaPoolRuntime | undefined;
        let started = false;
        try {
          service = await load();
          if (requested !== generation) return;
          if (active) dispose(active);
          active = service;
          started = true;
          await service.startCaptchaPool(appVersion);
        } catch (error) {
          if (service && started) dispose(service);
          if (requested === generation) throw error;
        } finally {
          // stop() already disposed once, but an awaited startup can create
          // more work after that stop. Clean it before any queued restart.
          if (service && started && requested !== generation) dispose(service);
        }
      });
    },
    stop(): void {
      generation++;
      if (active) dispose(active);
    },
  };
}
