import type { ProxyConfig } from "../config/types.js";
import { createApiKeyCredential } from "./apikey.js";
import { AuthManager } from "./manager.js";
import { loadCredential, exportAccounts } from "./store.js";
import { isExpired, type Credential } from "./types.js";

export function configuredAuthOptions(config: ProxyConfig) {
  return {
    mode: config.auth.mode ?? "oauth",
    provider: config.provider,
    plan: config.plan,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential,
  };
}

/** Static API keys never borrow a stored OAuth account. */
export async function resolveConfiguredCredential(
  config: ProxyConfig,
  load: () => Promise<Credential | null> = loadCredential,
): Promise<Credential | null> {
  const options = configuredAuthOptions(config);
  if (options.mode === "apikey") {
    return options.apiKey?.trim()
      ? createApiKeyCredential(options.provider, options.apiKey, options.plan)
      : null;
  }
  const credential = await load();
  return credential && !credential.disabled && !isExpired(credential) && credential.provider === config.provider
    ? { ...credential }
    : null;
}

/** Every entry point, including the TUI, gets the same account failover source. */
export function createConfiguredAuthManager(
  config: ProxyConfig,
  listAllCredentials: () => Promise<Credential[]> = async () => (await exportAccounts()).map((account) => account.credential),
): AuthManager {
  return new AuthManager({ ...configuredAuthOptions(config), listAllCredentials });
}
