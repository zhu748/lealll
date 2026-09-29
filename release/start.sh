#!/usr/bin/env bash
# zcode-proxy Manager — cross-platform launcher.
#
# v0.3.2.0: the release now ships per-platform binaries
# (zcode-proxy-linux-x64 / -linux-arm64 / -darwin-x64 / -darwin-arm64 /
# zcode-proxy.exe). This launcher picks the right one automatically:
#   1. Exact match for the current OS/arch (from the matching release zip)
#   2. Fallback scan: any known binary present in the folder — covers WSL /
#      Git-Bash on Windows (they can exec the .exe) and renamed binaries
#   3. On macOS, if the binary is blocked by Gatekeeper quarantine, print
#      the xattr fix instead of a cryptic exec error.
#
# All CLI subcommands below are verified against `zcode-proxy help`:
# serve [config.yaml], auth login <zai|bigmodel> [--import] [--plan=...],
# auth status, auth logout, auth export.

cd "$(dirname "$0")" || exit 1

# ---------------------------------------------------------------------------
# Binary detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

BIN=""
case "${OS}-${ARCH}" in
  Linux-x86_64)         BIN="zcode-proxy-linux-x64" ;;
  Linux-aarch64)        BIN="zcode-proxy-linux-arm64" ;;
  Darwin-x86_64)        BIN="zcode-proxy-darwin-x64" ;;
  Darwin-arm64)         BIN="zcode-proxy-darwin-arm64" ;;
  *)                    BIN="" ;;
esac

# Exact match missing (e.g. WSL/Git-Bash where the folder holds only the
# .exe, or the user renamed a binary) — take whatever we can find.
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  for cand in \
    zcode-proxy-linux-x64 \
    zcode-proxy-linux-arm64 \
    zcode-proxy-darwin-x64 \
    zcode-proxy-darwin-arm64 \
    zcode-proxy \
    zcode-proxy.exe
  do
    if [ -f "$cand" ]; then
      BIN="$cand"
      break
    fi
  done
fi

if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "ERROR: no zcode-proxy binary found in $(pwd)."
  echo ""
  echo "Download the zip matching your platform from the GitHub release page:"
  echo "  windows-x64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64"
  exit 1
fi

chmod +x "$BIN" 2>/dev/null || true

# Run a command; on macOS, a quarantine-blocked exec gets a friendly hint.
zrun() {
  "./$BIN" "$@"
  local rc=$?
  if [ $rc -ne 0 ] && [ "$OS" = "Darwin" ]; then
    # Gatekeeper quarantine (browser-downloaded binaries) fails exec with
    # "Bad CPU type"/"cannot execute"/SIGKILL 137. Suggest the standard fix.
    if ! "./$BIN" help >/dev/null 2>&1; then
      echo ""
      echo "NOTE: macOS may have blocked '$BIN' (unsigned download)."
      echo "      Remove the quarantine flag and retry:"
      echo "        xattr -d com.apple.quarantine \"$BIN\""
      echo "      (or System Settings -> Privacy & Security -> Allow Anyway)"
    fi
  fi
  return $rc
}

# ---------------------------------------------------------------------------
# Menu
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "         zcode-proxy Manager"
echo "      binary: ${BIN} (${OS} ${ARCH})"
echo "============================================"
echo ""
echo "  1. Start proxy server"
echo "  2. OAuth login (Bigmodel) - Coding Plan"
echo "  3. OAuth login (Z.AI) - Coding Plan"
echo "  4. OAuth login (Bigmodel) - Start Plan"
echo "  5. OAuth login (Z.AI) - Start Plan"
echo "  6. Import key from ZCode (Bigmodel) - Coding Plan"
echo "  7. Import key from ZCode (Z.AI) - Coding Plan"
echo "  8. Import key from ZCode (Bigmodel) - Start Plan"
echo "  9. Import key from ZCode (Z.AI) - Start Plan"
echo "  a. Check login status"
echo "  b. Logout"
echo "  c. Export credential for Render/cloud deploy"
echo "  0. Exit"
echo ""
read -r -p "Select: " choice

case $choice in
  1)
    echo ""
    echo "Starting proxy server..."
    echo ""
    zrun serve config.yaml
    ;;
  2)
    echo ""
    echo "Starting Bigmodel OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    zrun auth login bigmodel --plan=coding-plan
    ;;
  3)
    echo ""
    echo "Starting Z.AI OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    zrun auth login zai --plan=coding-plan
    ;;
  4)
    echo ""
    echo "Starting Bigmodel OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    zrun auth login bigmodel --plan=start-plan
    ;;
  5)
    echo ""
    echo "Starting Z.AI OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    zrun auth login zai --plan=start-plan
    ;;
  6)
    echo ""
    echo "Importing key from ZCode (Bigmodel, Coding Plan)..."
    echo ""
    zrun auth login bigmodel --import --plan=coding-plan
    ;;
  7)
    echo ""
    echo "Importing key from ZCode (Z.AI, Coding Plan)..."
    echo ""
    zrun auth login zai --import --plan=coding-plan
    ;;
  8)
    echo ""
    echo "Importing key from ZCode (Bigmodel, Start Plan)..."
    echo ""
    zrun auth login bigmodel --import --plan=start-plan
    ;;
  9)
    echo ""
    echo "Importing key from ZCode (Z.AI, Start Plan)..."
    echo ""
    zrun auth login zai --import --plan=start-plan
    ;;
  a)
    echo ""
    zrun auth status
    ;;
  b)
    echo ""
    zrun auth logout
    ;;
  c)
    echo ""
    echo "Exporting credential as base64 for ZCODE_OAUTH_CREDENTIAL env var..."
    echo "(Used for Render / Fly.io / K8s deployment in oauth mode)"
    echo ""
    zrun auth export
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
