import { LogBuffer } from "../android/control.js";

/**
 * Mirror console output into a ring buffer so the panel's Logs card has data.
 * Same tee the Android entry installs — the buffer is also what `getLogs` reads.
 */
export function installLogTee(): LogBuffer {
  const buffer = new LogBuffer();
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { buffer.push(args.join(" ")); origLog(...args); };
  console.error = (...args: unknown[]) => { buffer.push("[error] " + args.join(" ")); origErr(...args); };
  console.warn = (...args: unknown[]) => { buffer.push("[warn] " + args.join(" ")); origWarn(...args); };
  return buffer;
}
