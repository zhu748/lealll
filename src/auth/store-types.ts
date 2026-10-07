import type { Credential } from "./types.js";

/** One stored account record (without encryption — encryption wraps the whole file). */
export interface StoredAccount {
  /** Stable unique id (32 hex chars for newly created accounts). */
  id: string;
  /** Human-readable label, e.g. "Z.AI · 2024-06-22 14:30". */
  label: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** The credential payload. */
  credential: Credential;
}

export interface StoreV2 {
  version: 2;
  activeId: string | null;
  accounts: StoredAccount[];
}

export type AccountSummary = Omit<StoredAccount, "credential"> & {
  provider: string;
  apiKeyMask: string;
  credentialKey: string;
  hasSecret: boolean;
  userId?: string;
  expiresAt?: number;
  hasJwt: boolean;
  plan: string;
  /** Outbound HTTP proxy URL configured for this account (empty string if none). */
  proxy: string;
  /** Empty when unset; the dashboard then displays label. */
  name: string;
  /** Empty for imports or API keys without an OAuth email. */
  email: string;
  /** Excluded from automatic switching and manual activation when true. */
  disabled: boolean;
};

export interface AccountList {
  accounts: AccountSummary[];
  activeId: string | null;
}
