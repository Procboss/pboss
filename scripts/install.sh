#!/usr/bin/env bash
# ProcBoss (pboss) Universal Installer for Linux and macOS
# https://procboss.com
# Usage: curl -fsSL https://procboss.com/install.sh | bash

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

# 1. Check for Bun runtime; install if missing or upgrade if present
if ! command -v bun >/dev/null 2>&1; then
  echo -e "${YELLOW}Bun is not installed. Installing Bun...${RESET}"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
else
  echo -e "${CYAN}Updating Bun to the latest version...${RESET}"
  bun upgrade 2>/dev/null || curl -fsSL https://bun.sh/install | bash || true
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo -e "${RED}Failed to locate Bun. Please restart your terminal and run the installer again.${RESET}"
  exit 1
fi

BUN_VERSION=$(bun --version)
echo -e "${GREEN}✓ Ready with Bun v${BUN_VERSION}${RESET}"

# 2. Determine target install directory
INSTALL_DIR=""
if [ -w "/usr/local/bin" ]; then
  INSTALL_DIR="/usr/local/bin"
elif [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  INSTALL_DIR="$HOME/.local/bin"
else
  INSTALL_DIR="$HOME/.pboss/bin"
  mkdir -p "$INSTALL_DIR"
fi

# 3. Create temporary build workspace
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
bun build --compile --minify --bytecode ./src/index.ts --outfile "$TMP_DIR/pboss" >/dev/null 2>&1

# 4. Install compiled binary
echo -e "${CYAN}Installing pboss to ${INSTALL_DIR}...${RESET}"
cp "$TMP_DIR/pboss" "$INSTALL_DIR/pboss"
chmod +x "$INSTALL_DIR/pboss"

# 5. Check PATH and update shell profile if needed
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo -e "${YELLOW}Adding ${INSTALL_DIR} to your PATH...${RESET}"
  SHELL_NAME=$(basename "$SHELL")
  PROFILE_FILE=""

  case "$SHELL_NAME" in
    zsh)
      PROFILE_FILE="$HOME/.zshrc"
      ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        PROFILE_FILE="$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        PROFILE_FILE="$HOME/.bash_profile"
      else
        PROFILE_FILE="$HOME/.profile"
      fi
      ;;
    *)
      PROFILE_FILE="$HOME/.profile"
      ;;
  esac

  if [ -n "$PROFILE_FILE" ] && [ -f "$PROFILE_FILE" ]; then
    if ! grep -q "$INSTALL_DIR" "$PROFILE_FILE"; then
      echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$PROFILE_FILE"
      echo -e "${GREEN}✓ Updated ${PROFILE_FILE}${RESET}"
    fi
  fi
fi

echo -e "${GREEN}${BOLD}"
echo "✓ ProcBoss (pboss) successfully installed!"
echo -e "${RESET}"
echo -e "Run ${CYAN}pboss --help${RESET} to get started."
