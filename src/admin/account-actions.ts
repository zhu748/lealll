import type { AuthManager } from "../auth/manager.js";
import { loadCredential } from "../auth/store.js";
import { errorResponse } from "../proxy/translated-response.js";
import { jsonResp } from "./security.js";

/** Synchronize a changed active account, clearing auth when none remains. */
export async function synchronizeActiveCredential(auth: AuthManager): Promise<void> {
  const credential = await loadCredential();
  if (credential) auth.setOAuthCredential(credential);
  else auth.clearOAuthCredential();
}
/**
 * Translate a store mutation result into an HTTP response.
 *
 * After the 凭证丢失 bug fix, switchAccount / setAccount* / removeAccount can
 * return THREE values:
 *   - true  : mutation succeeded → caller continues normally
 *   - false : account not found (or disabled, for switchAccount) → 404
 *   - null  : store could not be read (transient AV lock / IO error) → 503
 *
 * The 503 path is NEW — previously the store would silently fall back to an
 * empty store and clobber the user's credentials. Now we refuse the write
 * and tell the dashboard "try again in a moment". The dashboard should
 * surface this as a transient error, NOT a "not found" error.
 *
 * Returns null when the caller should continue (success), or a Response
 * when the caller should return immediately.
 */
export function handleMutationResult(
  result: boolean | null,
  notFoundMessage = "Account not found",
): Response | null {
  if (result === true) return null; // success — caller continues
  if (result === null) {
    return jsonResp(
      {
        error: {
          type: "store_unavailable",
          message:
            "Credential store is temporarily unreadable (possibly locked by " +
            "antivirus or another process). Please wait a few seconds and try again. " +
            "No changes were made — your credentials are safe.",
        },
      },
      503,
    );
  }
  return errorResponse(404, "not_found", notFoundMessage);
}
