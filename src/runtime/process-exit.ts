import { hostSetTimeout, hostClearTimeout } from "../utils/host-timers.js";

/**
 * Print an error and exit — holding the console window open on Windows.
 *
 * Double-clicking zcode-proxy.exe spawns a cmd window that closes the
 * instant the process exits, so any startup error written to stderr is
 * invisible ("double-click flash-close": the user sees a window blink and
 * vanish, with no way to read the actual reason). When stderr AND stdin are
 * interactive TTYs — the double-click case always is — wait for Enter (or
 * 60s) before exiting so the operator can read the message. Shells, pipes,
 * services and Task Scheduler runs have a non-TTY stderr or stdin and exit
 * immediately, preserving scripting semantics.
 *
 * @see start.bat — the guided Windows entry already `pause`s after every
 * action; this guard covers the direct exe double-click path it cannot.
 */
export function exitWithError(message: string, code = 1): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  if (process.platform === "win32" && process.stderr.isTTY && process.stdin.isTTY) {
    try {
      process.stderr.write("\nPress Enter (or close this window) to exit...\n");
      const finish = (): void => process.exit(code);
      const timer = hostSetTimeout(finish, 60_000);
      process.stdin.resume();
      process.stdin.once("data", () => { hostClearTimeout(timer); finish(); });
      process.stdin.once("close", () => { hostClearTimeout(timer); finish(); });
      // Deferred exit: the listeners / timeout above call finish(). Returning
      // here would fall through to the immediate exit below, defeating the
      // hold, so this line is statically unreachable — the never assertion
      // just satisfies the signature.
      return undefined as never;
    } catch { /* stdin unusable — fall through to immediate exit */ }
  }
  process.exit(code);
}
