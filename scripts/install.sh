#!/usr/bin/env bash
# ProcBoss (pboss) Universal Installer for Linux and macOS
# https://procboss.com
# Usage: curl -fsSL https://procboss.com/install.sh | sudo bash
#
# The installer places the compiled pboss executable in /usr/local/bin, so it
# must run as root. It checks for the required privileges itself and tells you
# exactly how to re-run it if sudo is missing.

set -e

RESET="\033[0m"
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"

echo -e "${CYAN}${BOLD}"
echo "  ⚡ ProcBoss (pboss) Installer"
echo "  https://procboss.com"
echo -e "${RESET}"

# 1. Require root privileges (sudo) — the binary is installed system-wide
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}${BOLD}✗ Root privileges are required to install pboss.${RESET}"
  echo ""
  echo -e "The installer compiles the standalone executable and installs it to ${CYAN}/usr/local/bin${RESET},"
  echo -e "so it must run as root. Re-run the installer with ${BOLD}sudo${RESET}:"
  echo ""
  echo -e "  ${CYAN}${BOLD}curl -fsSL https://procboss.com/install.sh | sudo bash${RESET}"
  echo ""
  exit 1
fi
echo -e "${GREEN}✓ Running with root privileges${RESET}"

# 2. Bun build toolchain.
#    Bun is only needed to COMPILE pboss — the final executable embeds the Bun
#    runtime, so the system does not need Bun installed once pboss is built.

# Resolve the invoking (non-root) user's home so Bun can be installed or found
# where the actual user — not root — will keep using it.
INVOKE_USER="${SUDO_USER:-}"
INVOKE_HOME="$HOME"
if [ -n "$INVOKE_USER" ]; then
  CANDIDATE_HOME=$(eval echo "~${INVOKE_USER}" 2>/dev/null || true)
  if [ -n "$CANDIDATE_HOME" ] && [ -d "$CANDIDATE_HOME" ]; then
    INVOKE_HOME="$CANDIDATE_HOME"
  fi
fi

# Look for an existing Bun: on PATH, in the invoking user's home, or root's.
BUN_PATH=""
for candidate in "$(command -v bun 2>/dev/null || true)" \
                 "$INVOKE_HOME/.bun/bin/bun" \
                 "$HOME/.bun/bin/bun" \
                 "/usr/local/bin/bun"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    BUN_PATH="$candidate"
    break
  fi
done

BUN_VERSION="0.0.0"
if [ -n "$BUN_PATH" ]; then
  BUN_VERSION=$("$BUN_PATH" --version 2>/dev/null || echo "0.0.0")
fi

# Bun >= 1.1.30 is required for standalone compilation with bytecode.
BUN_OK=$(awk -v v="$BUN_VERSION" 'BEGIN {
  split(v, a, ".")
  if (a[1]+0 > 1 || (a[1]+0 == 1 && a[2]+0 > 1) || (a[1]+0 == 1 && a[2]+0 == 1 && a[3]+0 >= 30)) print "yes"
  else print "no"
}')

if [ -z "$BUN_PATH" ] || [ "$BUN_OK" != "yes" ]; then
  if [ -z "$BUN_PATH" ]; then
    echo -e "${YELLOW}Bun was not found — installing the Bun build toolchain...${RESET}"
  else
    echo -e "${YELLOW}Bun v${BUN_VERSION} found, but v1.1.30+ is required to compile pboss. Upgrading Bun...${RESET}"
  fi
  BUN_INSTALL="$INVOKE_HOME/.bun" curl -fsSL https://bun.sh/install | bash
  # Bun was installed as root — hand it back to the invoking user.
  if [ -n "$INVOKE_USER" ]; then
    chown -R "${INVOKE_USER}:" "$INVOKE_HOME/.bun" 2>/dev/null \
      || chown -R "$INVOKE_USER" "$INVOKE_HOME/.bun" 2>/dev/null || true
  fi
  BUN_PATH="$INVOKE_HOME/.bun/bin/bun"
fi

if [ ! -x "$BUN_PATH" ]; then
  echo -e "${RED}✗ Failed to set up the Bun build toolchain.${RESET}"
  echo -e "Install Bun 1.1.30+ manually from ${CYAN}https://bun.sh${RESET} and re-run this installer."
  exit 1
fi

export PATH="$(dirname "$BUN_PATH"):$PATH"
echo -e "${GREEN}✓ Build toolchain ready: Bun v$("$BUN_PATH" --version)${RESET}"

# 3. Install target — root privileges let us use the canonical system path
INSTALL_DIR="/usr/local/bin"

# 4. Temporary build workspace
TMP_DIR=$(mktemp -d -t pboss-install-XXXXXX)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo -e "${CYAN}Fetching latest pboss source...${RESET}"
git clone --depth 1 https://github.com/procboss/pboss.git "$TMP_DIR" >/dev/null 2>&1 || {
  # Fallback to archive download if git is unavailable
  curl -fsSL https://github.com/procboss/pboss/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP_DIR" --strip-components=1
}

cd "$TMP_DIR"

echo -e "${CYAN}Compiling standalone pboss executable for this device...${RESET}"
bun install >/dev/null 2>&1
if ! bun build --compile --minify --bytecode ./src/index.ts --outfile "$TMP_DIR/pboss" >/dev/null 2>&1; then
  echo -e "${RED}✗ Failed to compile pboss with Bun v$(bun --version).${RESET}"
  echo "Ensure Bun 1.1.30+ is installed (https://bun.sh) and re-run the installer."
  exit 1
fi

# 5. Install the compiled binary
echo -e "${CYAN}Installing pboss to ${INSTALL_DIR}...${RESET}"
cp "$TMP_DIR/pboss" "$INSTALL_DIR/pboss"
chmod 755 "$INSTALL_DIR/pboss"

# 6. PATH sanity note (rare — /usr/local/bin is on PATH almost everywhere)
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo -e "${YELLOW}Note: ${INSTALL_DIR} is not on the current PATH. Add it to your shell profile if 'pboss' is not found.${RESET}"
fi

echo -e "${GREEN}${BOLD}"
echo "✓ ProcBoss (pboss) successfully installed to ${INSTALL_DIR}/pboss!"
echo -e "${RESET}"
echo -e "Run ${CYAN}pboss --version${RESET} to verify, then ${CYAN}pboss --help${RESET} to get started."
