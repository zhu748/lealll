/** Read, repair and atomically save identity fields without discarding YAML comments. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import { atomicWriteFileSync, ensureConfigFile } from "../config/edit.js";

/** Create the config if missing, then repair its identity in one read/write pass. */
export function ensureConfigWithDeviceMid(): string {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) console.log(`Created ${path} from bundled template.`);
  return repairIdentity(path, true);
}

/** Generate or reuse identity.deviceMid; unrelated deviceMid fields are untouched. */
export function ensureDeviceMidInConfig(path: string): string {
  return repairIdentity(path, false);
}

/** Repair missing device identity and stale numeric app versions on startup. */
export function ensureIdentitySelfHeal(path: string): void {
  repairIdentity(path, true);
}

function repairIdentity(path: string, repairVersion: boolean): string {
  const document: Document = parseDocument(readFileSync(path, "utf-8"));
  if (document.errors.length > 0) throw document.errors[0];
  if (document.contents === null) document.contents = document.createNode({});
  if (!isMap(document.contents)) throw new Error(`Config must be a YAML mapping: ${path}`);

  const identity = document.get("identity", true);
  if (identity !== undefined && !(isScalar(identity) && identity.value === null) && !isMap(identity)) {
    throw new Error(`identity must be a YAML mapping: ${path}`);
  }
  if (!isMap(identity)) document.set("identity", document.createNode({}));

  const existingMid = document.getIn(["identity", "deviceMid"]);
  const generated = typeof existingMid !== "string" || existingMid.trim().length === 0;
  const mid = generated ? randomUUID() : existingMid.trim();
  if (generated) {
    const mapping = document.get("identity", true);
    if (!isMap(mapping)) throw new Error(`identity must be a YAML mapping: ${path}`);
    if (mapping.has("deviceMid")) mapping.set("deviceMid", mid);
    else mapping.items.unshift(document.createPair("deviceMid", mid));
    const node = mapping.get("deviceMid", true);
    if (isScalar(node)) node.type = "QUOTE_DOUBLE";
  }

  const version = document.getIn(["identity", "appVersion"]);
  const upgraded = repairVersion && typeof version === "string" && isVersionOlderThan(version, DEFAULT_APP_VERSION);
  if (upgraded) document.setIn(["identity", "appVersion"], DEFAULT_APP_VERSION);
  if (generated || upgraded) atomicWriteFileSync(path, String(document));

  if (generated) console.log(`Device identity generated: ${mid.slice(0, 8)}… (stored in ${path})`);
  if (upgraded) console.log(`identity.appVersion updated: ${version} -> ${DEFAULT_APP_VERSION} (billing gates campaign visibility on app_version)`);
  return mid;
}

/** Custom, malformed and newer versions are preserved. Empty segments are not numbers. */
function isVersionOlderThan(a: string, b: string): boolean {
  const parse = (version: string): number[] | null => {
    const value = version.trim();
    if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
    const parts = value.split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const first = parse(a);
  const second = parse(b);
  if (!first || !second) return false;
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    const x = first[i] ?? 0;
    const y = second[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Keep Android's stable desktop profile; explicitly supplied values take precedence. */
export function applyAndroidIdentityDefaults(): void {
  process.env.ZCODE_IDENTITY_PLATFORM ??= "linux";
  process.env.ZCODE_IDENTITY_ARCH ??= "x64";
  process.env.ZCODE_IDENTITY_RELEASE ??= "6.8.0-49-generic";
}
