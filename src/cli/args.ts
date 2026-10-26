export interface ServeArgs {
  configPath?: string;
  debug: boolean;
}

/**
 * Parse `serve` subcommand arguments. The token `debug` toggles debug mode;
 * any other token is treated as the config path. Order-independent:
 *   []                → { debug: false }
 *   ["debug"]         → { debug: true }
 *   ["my.yaml"]       → { configPath: "my.yaml", debug: false }
 *   ["debug","x.yaml"] → { configPath: "x.yaml", debug: true }
 *   ["x.yaml","debug"] → { configPath: "x.yaml", debug: true }
 */
export function parseServeArgs(args: string[]): ServeArgs {
  const debug = args.includes("debug");
  const configPath = args.find((a) => a !== "debug");
  return { configPath, debug };
}

type CommandName = "tui" | "serve" | "android" | "auth" | "claim" | "quota" | "reset" | "version" | "help";

export type CliInvocation =
  | { command: CommandName; args: string[] }
  | { command: "unknown"; name: string };

/** Parse command aliases without loading a runtime, reading config or doing I/O. */
export function parseCliArgs(args: string[]): CliInvocation {
  const classic = args[0] === "--cli";
  const tokens = classic ? args.slice(1) : args;
  const first = tokens[0];
  const configPath = first?.endsWith(".yaml") || first?.endsWith(".yml");
  if (!classic && (first === undefined || first === "debug" || configPath)) {
    return { command: "tui", args: tokens };
  }
  if (configPath) return { command: "serve", args: tokens };
  switch (first) {
    case undefined: return { command: "serve", args: [] };
    case "-v": case "--version": case "version": return { command: "version", args: [] };
    case "-h": case "--help": case "help": return { command: "help", args: [] };
    case "tui": case "serve": case "android": case "auth": case "claim": case "quota": case "reset":
      return { command: first, args: tokens.slice(1) };
    default: return { command: "unknown", name: first };
  }
}
