/** Normalize imported and decrypted credentials without accessing the store. */
import { randomBytes } from "node:crypto";
import type { Credential } from "./types.js";
import type { StoredAccount, StoreV2 } from "./store-types.js";
import { validateProxyUrl } from "../utils/proxy-url.js";

export function cloneStoredAccount<T extends Omit<StoredAccount, "credential"> & { credential: Credential }>(account: T): T {
  return {
    ...account,
    credential: { ...account.credential },
  };
}

export function generateAccountId(): string {
  // 128 bits of entropy; imported legacy IDs are preserved when unique.
  return randomBytes(16).toString("hex");
}

export function defaultAccountLabel(cred: Credential, createdAt: number): string {
  const ts = new Date(createdAt).toISOString().slice(0, 16).replace("T", " ");
  return `${cred.provider} · ${ts}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) return undefined;
    return parsed;
  }
  return undefined;
}

function normalizeProvider(value: unknown): Credential["provider"] | null {
  return value === "zai" || value === "bigmodel" ? value : null;
}

function normalizePlan(value: unknown): Credential["plan"] | undefined {
  const plan = normalizeNonEmptyString(value);
  return plan === "coding-plan" || plan === "start-plan" ? plan : undefined;
}

export function normalizeCredential(raw: unknown): Credential | null {
  if (!isRecord(raw)) return null;
  const apiKey = normalizeNonEmptyString(raw.apiKey);
  const provider = normalizeProvider(raw.provider);
  if (!apiKey || !provider) return null;

  const cred: Credential = { apiKey, provider };
  const secret = normalizeNonEmptyString(raw.secret);
  if (secret) cred.secret = secret;
  const plan = normalizePlan(raw.plan);
  if (plan) cred.plan = plan;
  const expiresAt = normalizeOptionalNonNegativeInteger(raw.expiresAt);
  if (expiresAt !== undefined) cred.expiresAt = expiresAt;
  const userId = normalizeNonEmptyString(raw.userId);
  if (userId) cred.userId = userId;
  const jwt = normalizeNonEmptyString(raw.jwt);
  if (jwt) cred.jwt = jwt;
  // 4.7.2-fork.1: raw OAuth provider access token (desktop 3.14.4 reset
  // endpoints use it as X-Bigmodel-Authorization).
  const maasToken = normalizeNonEmptyString(raw.maasToken);
  if (maasToken) cred.maasToken = maasToken;
  const proxy = normalizeNonEmptyString(raw.proxy);
  if (proxy && validateProxyUrl(proxy).ok) cred.proxy = proxy;
  const name = normalizeNonEmptyString(raw.name);
  if (name) cred.name = name;
  const email = normalizeNonEmptyString(raw.email);
  if (email) cred.email = email;
  if (raw.disabled === true) cred.disabled = true;
  return cred;
}

export function normalizeStoredAccount(
  raw: unknown,
  opts: { usedIds?: Set<string>; now?: number } = {},
): StoredAccount | null {
  if (!isRecord(raw)) return null;
  const credential = normalizeCredential(raw.credential);
  if (!credential) return null;

  const usedIds = opts.usedIds;
  let id = normalizeNonEmptyString(raw.id);
  if (!id || usedIds?.has(id)) {
    do {
      id = generateAccountId();
    } while (usedIds?.has(id));
  }
  usedIds?.add(id);

  const createdAt = normalizeOptionalNonNegativeInteger(raw.createdAt) ?? opts.now ?? Date.now();
  const label = normalizeNonEmptyString(raw.label) ?? defaultAccountLabel(credential, createdAt);
  return { id, label, createdAt, credential };
}

export function normalizeStore(raw: unknown): StoreV2 | null {
  if (!isRecord(raw) || raw.version !== 2 || !Array.isArray(raw.accounts)) {
    return null;
  }
  const usedIds = new Set<string>();
  const now = Date.now();
  const accounts: StoredAccount[] = [];
  for (const rawAccount of raw.accounts) {
    const account = normalizeStoredAccount(rawAccount, { usedIds, now });
    if (account) accounts.push(account);
  }
  const store: StoreV2 = {
    version: 2,
    activeId: normalizeNonEmptyString(raw.activeId),
    accounts,
  };
  normalizeStoreActiveId(store);
  return store;
}

export function normalizeStoreInPlace(store: StoreV2): void {
  const normalized = normalizeStore(store);
  if (!normalized) {
    store.version = 2;
    store.activeId = null;
    store.accounts = [];
    return;
  }
  store.version = 2;
  store.activeId = normalized.activeId;
  store.accounts = normalized.accounts;
}

export function normalizeStoreActiveId(store: StoreV2): void {
  const active = store.activeId ? store.accounts.find(a => a.id === store.activeId) : undefined;
  if (active && !active.credential.disabled) return;
  store.activeId = store.accounts.find(a => !a.credential.disabled)?.id ?? null;
}
