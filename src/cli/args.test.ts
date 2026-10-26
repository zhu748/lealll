import { describe, expect, it } from "bun:test";
import { parseCliArgs, type CliInvocation } from "./args.js";

describe("CLI command selection", () => {
  const cases: Array<[string[], CliInvocation]> = [
    [[], { command: "tui", args: [] }],
    [["debug"], { command: "tui", args: ["debug"] }],
    [["custom.yml", "debug"], { command: "tui", args: ["custom.yml", "debug"] }],
    [["--cli"], { command: "serve", args: [] }],
    [["--cli", "custom.yaml", "debug"], { command: "serve", args: ["custom.yaml", "debug"] }],
    [["--cli", "tui", "debug"], { command: "tui", args: ["debug"] }],
    [["tui", "custom.yaml"], { command: "tui", args: ["custom.yaml"] }],
    [["serve", "debug", "custom.yaml"], { command: "serve", args: ["debug", "custom.yaml"] }],
    [["android"], { command: "android", args: [] }],
    [["auth", "login", "bigmodel"], { command: "auth", args: ["login", "bigmodel"] }],
    [["claim", "list"], { command: "claim", args: ["list"] }],
    [["reset", "--use", "week"], { command: "reset", args: ["--use", "week"] }],
    [["quota"], { command: "quota", args: [] }],
    [["--version"], { command: "version", args: [] }],
    [["--cli", "-v"], { command: "version", args: [] }],
    [["--help"], { command: "help", args: [] }],
    [["help"], { command: "help", args: [] }],
    [["--cli", "debug"], { command: "unknown", name: "debug" }],
    [["unknown"], { command: "unknown", name: "unknown" }],
  ];
  it.each(cases)("selects the command for %j", (args, expected) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  it("does not mutate argv", () => {
    const args = ["--cli", "serve", "debug"];
    parseCliArgs(args);
    expect(args).toEqual(["--cli", "serve", "debug"]);
  });
});
