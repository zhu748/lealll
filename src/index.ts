/** Executable bootstrap and compatibility exports for existing consumers. */
import { runCli } from "./cli/main.js";
import { exitWithError } from "./runtime/process-exit.js";

export { VERSION } from "./version.js";
export { parseServeArgs, type ServeArgs } from "./cli/args.js";
export { exitWithError };
export { applyAndroidIdentityDefaults, ensureDeviceMidInConfig, ensureIdentitySelfHeal } from "./runtime/identity-config.js";

// Bun source runs and compiled CommonJS bundles share this entry condition.
// Importing helpers from ESM tests must not start a server or read config.
if (typeof require !== "undefined" && require.main === module) {
  void runCli().catch((error: unknown) => {
    exitWithError(`zcode-proxy: uncaught error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
}
