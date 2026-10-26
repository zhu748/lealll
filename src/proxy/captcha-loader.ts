import type { CaptchaModuleLike } from "./captcha-retry.js";

let pending: Promise<CaptchaModuleLike> | undefined;

/** Load captcha support only on demand; concurrent requests share the import. */
export function loadCaptcha(): Promise<CaptchaModuleLike> {
  return pending ??= import("./captcha.js").catch((error) => {
    pending = undefined;
    throw error;
  });
}
