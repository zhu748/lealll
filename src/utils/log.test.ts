import { expect, test } from "bun:test";
import { shouldEmitRuntimeLog } from "./log.js";

test("runtime logs are quiet only when test quiet mode is enabled", () => {
  const oldQuiet = process.env.ZCODE_PROXY_TEST_QUIET;
  const oldLogs = process.env.ZCODE_PROXY_TEST_LOGS;
  try {
    delete process.env.ZCODE_PROXY_TEST_LOGS;
    delete process.env.ZCODE_PROXY_TEST_QUIET;
    expect(shouldEmitRuntimeLog("log")).toBe(true);

    process.env.ZCODE_PROXY_TEST_QUIET = "1";
    expect(shouldEmitRuntimeLog("log")).toBe(false);

    process.env.ZCODE_PROXY_TEST_LOGS = "1";
    expect(shouldEmitRuntimeLog("log")).toBe(true);
  } finally {
    if (oldQuiet === undefined) delete process.env.ZCODE_PROXY_TEST_QUIET;
    else process.env.ZCODE_PROXY_TEST_QUIET = oldQuiet;
    if (oldLogs === undefined) delete process.env.ZCODE_PROXY_TEST_LOGS;
    else process.env.ZCODE_PROXY_TEST_LOGS = oldLogs;
  }
});

test("runtime logs still emit when a test captures the console method", () => {
  const oldQuiet = process.env.ZCODE_PROXY_TEST_QUIET;
  const oldLogs = process.env.ZCODE_PROXY_TEST_LOGS;
  const oldWarn = console.warn;
  try {
    delete process.env.ZCODE_PROXY_TEST_LOGS;
    process.env.ZCODE_PROXY_TEST_QUIET = "1";
    expect(shouldEmitRuntimeLog("warn")).toBe(false);

    console.warn = () => {};
    expect(shouldEmitRuntimeLog("warn")).toBe(true);
  } finally {
    console.warn = oldWarn;
    if (oldQuiet === undefined) delete process.env.ZCODE_PROXY_TEST_QUIET;
    else process.env.ZCODE_PROXY_TEST_QUIET = oldQuiet;
    if (oldLogs === undefined) delete process.env.ZCODE_PROXY_TEST_LOGS;
    else process.env.ZCODE_PROXY_TEST_LOGS = oldLogs;
  }
});
