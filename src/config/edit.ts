/**
 * Targeted YAML config editing helpers shared by the CLI entries (serve /
 * android / tui) and the TUI runtime.
 */
import { parseDocument } from "yaml";
import { chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import type { ProviderId } from "../provider/types.js";
import { EXAMPLE_CONFIG_YAML } from "./template.js";

/**
 * Sync atomic write: tmp file + rename. This file also holds
 * `identity.deviceMid`, which must stay stable — a truncate-then-write
 * crash (Ctrl+C mid-save) would silently rotate the device fingerprint.
 * Sync twin of utils/fs.ts atomicWriteFile (kept sync because every caller
 * in the CLI/TUI entry paths is synchronous).
 *
 * `mode` defaults to 0600: config.yaml carries `auth.proxyApiKey`,
 * `auth.apiKey` (apikey mode = the upstream credential itself) and
 * `providers.*.credential` — same secret class as credentials.json, which
 * was already tightened to 0600. The tmp file is created with the same
 * mode so the rename doesn't publish a brief 0644 window.
 */
export function atomicWriteFileSync(path: string, content: string, mode: number = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf-8", mode });
    // rename preserves the tmp file's mode; chmod is belt-and-suspenders for
    // filesystems (some FUSE mounts) that ignore the writeFileSync mode.
    try { chmodSync(tmp, mode); } catch { /* best-effort */ }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Targeted YAML update of top-level `provider` and `plan` keys.
 *
 * Uses `yaml`'s document model (`parseDocument` → `set` → `String(doc)`) so
 * comments and formatting in the rest of the file survive the edit — the old
 * `parse`/`stringify` round-trip dropped every comment, and this file is what
 * users see (and edit) in config.yaml.
 */
export function updateConfigYaml(
  path: string,
  fields: { provider: ProviderId; plan: "coding-plan" | "start-plan" },
): void {
  const doc = parseDocument(readFileSync(path, "utf-8"));
  doc.set("provider", fields.provider);
  doc.set("plan", fields.plan);
  atomicWriteFileSync(path, String(doc));
}

/**
 * Create the config file from the bundled template when missing.
 * Shared by the CLI entries (serve / android / auth login) and the TUI —
 * they used to each hand-roll this block. Returns true when the file was
 * created, false when it already existed.
 */
export function ensureConfigFile(path: string): boolean {
  if (existsSync(path)) return false;
  atomicWriteFileSync(path, EXAMPLE_CONFIG_YAML);
  return true;
}
