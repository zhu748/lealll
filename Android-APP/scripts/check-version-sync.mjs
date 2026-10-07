#!/usr/bin/env node
// Verifies package.json version === the server's shared VERSION export.
// Run with Node.js 24+ or Bun:
//   node Android-APP/scripts/check-version-sync.mjs
// The Android versionName is NOT compared: release CI injects it from the tag
// (ORG_GRADLE_PROJECT_androidApp_versionName → build.gradle.kts `prop()`
// lookup) while local builds derive "<package.json version>-android".

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/version.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;
console.log(`package.json:           ${pkgVersion}`);
console.log(`src/version.ts VERSION: ${VERSION}`);

if (pkgVersion !== VERSION) {
  console.error(`MISMATCH: package.json=${pkgVersion} vs src/version.ts=${VERSION}`);
  process.exit(1);
}
console.log("OK: package.json and the shared server version are in sync.");
