/** Command dispatch; each runtime is loaded only when its command is selected. */
import { parseCliArgs, parseServeArgs } from "./args.js";
import { printHelp } from "./help.js";
import { exitWithError } from "../runtime/process-exit.js";
import { ensureNodeFetchNoTimeouts } from "../runtime/node-fetch-compat.js";
import { VERSION } from "../version.js";

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const invocation = parseCliArgs(args);
  if (invocation.command === "version") {
    console.log(`zcode-proxy ${VERSION}`);
    return;
  }
  if (invocation.command === "help") {
    printHelp();
    return;
  }
  if (invocation.command === "unknown") {
    console.error(`Unknown command: ${invocation.name}\n`);
    printHelp();
    exitWithError("");
  }

  try {
    await ensureNodeFetchNoTimeouts();
    switch (invocation.command) {
      case "tui":
        return await (await import("../tui/app.js")).runTui(parseServeArgs(invocation.args));
      case "serve": {
        const args = parseServeArgs(invocation.args);
        return await (await import("../runtime/serve.js")).serve(args.configPath, args.debug);
      }
      case "android":
        return await (await import("../runtime/android.js")).runAndroid();
      case "auth":
        return await (await import("./auth.js")).authCommand(invocation.args);
      case "claim":
        return await (await import("./billing.js")).claimCommand(invocation.args);
      case "quota":
        return await (await import("./billing.js")).quotaCommand();
      case "reset":
        return await (await import("./billing.js")).resetCommand(invocation.args);
    }
  } catch (error) {
    exitWithError(`zcode-proxy: ${invocation.command} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
}
