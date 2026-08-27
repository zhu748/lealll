type ConsoleLevel = "log" | "warn" | "error";

const defaultConsoleMethods: Record<ConsoleLevel, (...args: unknown[]) => void> = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

export function shouldEmitRuntimeLog(level: ConsoleLevel = "log"): boolean {
  if (process.env.ZCODE_PROXY_TEST_LOGS === "1") return true;
  if (process.env.ZCODE_PROXY_TEST_QUIET !== "1") return true;
  return console[level] !== defaultConsoleMethods[level];
}

export function runtimeLog(...args: unknown[]): void {
  if (shouldEmitRuntimeLog("log")) console.log(...args);
}

export function runtimeWarn(...args: unknown[]): void {
  if (shouldEmitRuntimeLog("warn")) console.warn(...args);
}

export function runtimeError(...args: unknown[]): void {
  if (shouldEmitRuntimeLog("error")) console.error(...args);
}
