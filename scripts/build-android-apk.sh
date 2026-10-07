#!/usr/bin/env bash
# Regenerate the server bundle, then use a local JDK/SDK or a Docker builder.
# Usage: bun run build:android-apk [Gradle tasks/options...]
# ANDROID_BUILD_MODE=auto|local|docker; ANDROID_BUILD_IMAGE overrides the image.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${ANDROID_BUILD_MODE:-auto}"
TASKS=("$@")
if [[ ${#TASKS[@]} -eq 0 ]]; then TASKS=(assembleDebug); fi
case "$MODE" in
  auto|local|docker) ;;
  *) echo "ANDROID_BUILD_MODE must be auto, local or docker" >&2; exit 2 ;;
esac
if ! command -v bun >/dev/null 2>&1; then
  echo "Install Bun 1.4.0 before building the Android server bundle." >&2
  exit 2
fi
cd "$ROOT"
if [[ ! -d node_modules ]]; then bun install --frozen-lockfile; fi
bun run build:android-bundle
cp dist/android/server.cjs Android-APP/app/src/main/assets/server_bundle/server.cjs

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ "$MODE" != docker ]] && command -v java >/dev/null 2>&1 &&
   [[ -n "$SDK" || -f Android-APP/local.properties ]]; then
  cd Android-APP
  exec bash ./gradlew "${TASKS[@]}" --no-daemon
fi
if [[ "$MODE" == local ]] || ! command -v docker >/dev/null 2>&1; then
  echo "Android build needs JDK 17 and SDK 35. Set ANDROID_HOME (or Android-APP/local.properties), or install Docker." >&2
  exit 2
fi

# Docker Desktop on Git Bash needs a Windows mount path.
case "$ROOT" in
  /[a-z]/*) DRIVE="${ROOT:1:1}"; ROOT="${DRIVE^^}:/${ROOT:3}" ;;
esac
export MSYS_NO_PATHCONV=1
exec docker run --rm \
  -v "$ROOT:/work" \
  -v zcode-gradle-cache:/root/.gradle \
  -w /work/Android-APP \
  "${ANDROID_BUILD_IMAGE:-llama-android-builder:latest}" \
  bash ./gradlew "${TASKS[@]}" --no-daemon
