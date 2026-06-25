/**
 * Auth manager — picks the right credential source based on mode.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { AuthMode, Credential } from "./types.js";
import { createApiKeyCredential } from "./apikey.js";
import type { ProviderId } from "../provider/types.js";

/** Options for constructing an `AuthManager`. */
export interface AuthManagerOptions {
  mode: AuthMode;
  provider: ProviderId;
  /** Raw credential string for apikey mode (`{apiKey}` or `{apiKey}.{secret}`). */
  apiKey?: string;
  /**
   * Optional: returns all stored credentials (for multi-account credential
   * switching on repeated upstream failures). When omitted, credential
   * switching is effectively disabled (switchToNextCredential always returns null).
   */
  listAllCredentials?: () => Promise<Credential[]>;
}

/**
 * Resolves the upstream credential to inject into proxied requests.
 *
 * In `apikey` mode: returns a static credential parsed from the config string.
 * In `oauth` mode: throws "not implemented" until T9/T10 land.
 */
export class AuthManager {
  private mode: AuthMode;
  private provider: ProviderId;
  private cachedApiKeyCred: Credential | null = null;
  private oauthCred: Credential | null = null;
  private listAllCredentials?: () => Promise<Credential[]>;

  constructor(opts: AuthManagerOptions) {
    this.mode = opts.mode;
    this.provider = opts.provider;
    this.listAllCredentials = opts.listAllCredentials;
    if (opts.mode === "apikey" && opts.apiKey) {
      this.cachedApiKeyCred = createApiKeyCredential(this.provider, opts.apiKey);
    }
  }

  /** Returns the current credential, refreshing if necessary. */
  async getCredential(): Promise<Credential> {
    if (this.mode === "apikey") {
      if (this.cachedApiKeyCred) return this.cachedApiKeyCred;
      throw new Error("apikey mode configured but no credential was set");
    }

    // oauth mode
    if (this.oauthCred) {
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        this.oauthCred = null;
        throw new Error("OAuth credential expired; re-authentication required (T9/T10 not yet implemented)");
      }
      return this.oauthCred;
    }
    throw new Error("OAuth credential not available — run login flow first (T9/T10 not yet implemented)");
  }

  /** Set the OAuth credential (used by T9/T10 OAuth flow). */
  setOAuthCredential(cred: Credential): void {
    this.oauthCred = cred;
  }

  /**
   * Clear the in-memory OAuth credential (vceshi0.0.7+).
   *
   * Called by the dashboard's "Clear all credentials" handler so that running
   * requests stop using the just-deleted credential. Without this, the proxy
   * would keep serving from the stale in-memory credential until restart —
   * defeating the purpose of the clear action.
   */
  clearOAuthCredential(): void {
    this.oauthCred = null;
  }

  /**
   * Switch to a different stored credential, skipping the current credential
   * and any credentials in `excludeApiKeys` (credentials already tried and
   * failed in the same request). Returns the new credential, or null if no
   * alternative is available.
   *
   * Side effect: updates the in-memory active credential so subsequent
   * getCredential() calls return the new one. Does NOT persist the change to
   * the on-disk store — the caller is responsible for that (via switchAccount)
   * if it wants the dashboard to reflect the switch.
   */
  async switchToNextCredential(excludeApiKeys?: Set<string>): Promise<Credential | null> {
    if (!this.listAllCredentials) return null;
    let all: Credential[];
    try {
      all = await this.listAllCredentials();
    } catch {
      return null;
    }
    if (all.length <= 1) return null;

    const current = this.cachedApiKeyCred ?? this.oauthCred;
    const currentKey = current?.apiKey;

    // Build the exclusion set: current credential + any explicitly excluded keys.
    // This prevents cycling back to a credential that already failed in this request.
    const excluded = new Set<string>(excludeApiKeys);
    if (currentKey) excluded.add(currentKey);

    const candidates = all.filter(c => !excluded.has(c.apiKey) && !c.disabled);
    if (candidates.length === 0) return null;

    // Pick the first candidate. A round-robin based on a stored index could be
    // added later, but for now first-available is deterministic and simple.
    const next = candidates[0];

    if (this.mode === "oauth") {
      this.oauthCred = next;
    } else {
      this.cachedApiKeyCred = next;
    }
    return next;
  }

  /** Current auth mode. */
  getMode(): AuthMode {
    return this.mode;
  }
}
