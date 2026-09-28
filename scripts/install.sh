#!/usr/bin/env bash
# ProcBoss (pboss) Universal Installer for Linux and macOS
# https://procboss.com
# Usage: curl -fsSL https://procboss.com/install.sh | bash
#
# ProcBoss is runtime-agnostic: it runs under Bun, Node.js or Deno, using
# each runtime's native APIs. This installer has exactly ONE
# runtime-related responsibility:
#
#   Ensure at least one supported runtime exists on the machine.
#     - Bun OR Node OR Deno present  ->  do nothing, install nothing
#     - none present                 ->  install Bun
#
# It NEVER selects a runtime, NEVER persists a runtime preference (no
# PBOSS_RUNTIME, no config), and NEVER compiles anything — pboss is
# installed from the PUBLISHED npm package, globally. The runtime executing
# `pboss` is decided at execution time (the bin shim the package manager
# installs; `bunx pboss` / `npx pboss` / `deno run -A npm:pboss` override).
#
# No root required, ever. The boot service is per-user.

set -e

RESET="\033"
BOLD="\033"
GREEN="\033"
CYAN="\033"
YELLOW="\033"
RED="\033"

echo -e "${CYAN}${BOLD}"
echo "  ⚡ ProcBoss (pboss) Installer"
echo "  https://procboss.com"
echo -e "${RESET}"

# 1. Install context — the invoking user (root via sudo still works; the
#    service install drops back to the real user).
INVOKE_USER="${SUDO_USER:-}"
INVOKE_HOME="$HOME"
if [ -n "$INVOKE_USER" ]; then
  CANDIDATE_HOME=$(eval echo "~${INVOKE_USER}" 2>/dev/null || true)
  if [ -n "$CANDIDATE_HOME" ] && [ -d "$CANDIDATE_HOME" ]; then
    INVOKE_HOME="$CANDIDATE_HOME"
  fi
fi
IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=1
fi

# 2. Runtime presence — ANY ONE of Bun / Node / Deno is enough.
#    Multiple runtimes are NOT a conflict; nothing is chosen here.
detect_bun()   { command -v bun   >/dev/null 2>&1 && echo "$(command -v bun)";   }
detect_node()  { command -v node  >/dev/null 2>&1 && echo "$(command -v node)";  }
detect_deno()  { command -v deno  >/dev/null 2>&1 && echo "$(command -v deno)";  }

HAS_BUN=""
HAS_NODE=""
HAS_DENO=""
for candidate in "$(command -v bun 2>/dev/null || true)" \
                 "$INVOKE_HOME/.bun/bin/bun"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then HAS_BUN="$candidate"; break; fi
done
HAS_NODE=$(detect_node)
HAS_DENO=$(detect_deno)

echo -e "${CYAN}Runtime check — pboss runs under Bun, Node.js or Deno:${RESET}"
[ -n "$HAS_BUN" ]  && echo -e "  ${GREEN}✓ Bun found${RESET}    ($HAS_BUN)"      || echo -e "  ${YELLOW}· Bun not found${RESET}"
[ -n "$HAS_NODE" ] && echo -e "  ${GREEN}✓ Node found${RESET}   ($HAS_NODE, $(node --version 2>/dev/null || echo '?'))" || echo -e "  ${YELLOW}· Node not found${RESET}"
[ -n "$HAS_DENO" ] && echo -e "  ${GREEN}✓ Deno found${RESET}   ($HAS_DENO)"     || echo -e "  ${YELLOW}· Deno not found${RESET}"

# None at all -> install Bun (the ONLY runtime-side effect this script has).
if [ -z "$HAS_BUN" ] && [ -z "$HAS_NODE" ] && [ -z "$HAS_DENO" ]; then
  echo -e "${YELLOW}No supported runtime found — installing Bun (https://bun.sh)…${RESET}"
  # The env assignment must sit on the *bash* side of the pipe: piping into
  # `BUN_INSTALL=… bash` sends the var to the installer, whereas prefixing
  # curl with it does nothing for the installer (classic pipe foot-gun).
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$INVOKE_HOME/.bun" bash
  if [ -n "$INVOKE_USER" ]; then
    chown -R "${INVOKE_USER}:" "$INVOKE_HOME/.bun" 2>/dev/null \
      || chown -R "$INVOKE_USER" "$INVOKE_HOME/.bun" 2>/dev/null || true
  fi
  export PATH="$INVOKE_HOME/.bun/bin:$PATH"
  HAS_BUN="$INVOKE_HOME/.bun/bin/bun"
  if [ ! -x "$HAS_BUN" ]; then
    echo -e "${RED}✗ Failed to install Bun.${RESET}"
    echo -e "Install any one runtime manually and re-run:"
    echo -e "  ${CYAN}https://bun.sh${RESET}  ·  ${CYAN}https://nodejs.org${RESET}  ·  ${CYAN}https://deno.com${RESET}"
    exit 1
  fi
  echo -e "${GREEN}✓ Bun installed — pboss will run under it until you choose otherwise.${RESET}"
else
  echo -e "${GREEN}✓ A supported runtime is present — nothing installed, nothing selected.${RESET}"
fi

# 3. Install the published pboss package, GLOBALLY.
#    The package-manager choice below installs ONLY the npm package — it
#    is not a runtime selection and nothing is persisted. Preference:
#    bun (present machines, user-writable global) > npm > deno. Version
#    pinning for `pboss upgrade`: PBOSS_VERSION selects the exact release.
PKG_SPEC="pboss"
[ -n "$PBOSS_VERSION" ] && PKG_SPEC="pboss@${PBOSS_VERSION}"
PM_DIR=""        # the bin dir the package lands in (PATH-healed below)
PM_CHOICE=""

if [ -n "$HAS_BUN" ] && [ "$IS_ROOT" -eq 0 ]; then
  PM_CHOICE="bun"
  echo -e "${CYAN}Installing the published pboss package globally (bun install -g ${PKG_SPEC})…${RESET}"
  if ! "$HAS_BUN" install -g "$PKG_SPEC"; then
    echo -e "${RED}✗ bun install -g failed.${RESET}"
    exit 1
  fi
  PM_DIR="$(dirname "$HAS_BUN")"
elif command -v npm >/dev/null 2>&1; then
  PM_CHOICE="npm"
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
  echo -e "${CYAN}Installing the published pboss package globally (npm install -g ${PKG_SPEC})…${RESET}"
  if [ -n "$NPM_PREFIX" ] && [ ! -w "$NPM_PREFIX" ] && [ "$IS_ROOT" -eq 0 ]; then
    # npm's prefix is root-owned and we are not root: fall back to the
    # user's own prefix (the standard npm user-install layout).
    export NPM_CONFIG_PREFIX="$INVOKE_HOME/.npm-global"
    PM_DIR="$INVOKE_HOME/.npm-global/bin"
    if ! npm install -g --prefix "$INVOKE_HOME/.npm-global" "$PKG_SPEC"; then
      echo -e "${RED}✗ npm install -g failed.${RESET}"
      exit 1
    fi
  else
    if ! npm install -g "$PKG_SPEC"; then
      echo -e "${RED}✗ npm install -g failed.${RESET}"
      exit 1
    fi
    PM_DIR="$([ -n "$NPM_PREFIX" ] && echo "$NPM_PREFIX" || npm config get prefix)/bin"
    [ -d "$PM_DIR" ] || PM_DIR="$(npm config get prefix)"
  fi
elif [ -n "$HAS_DENO" ]; then
  PM_CHOICE="deno"
  echo -e "${CYAN}Installing the published pboss package globally (deno install -g npm:${PKG_SPEC})…${RESET}"
  if ! "$HAS_DENO" install -g "npm:${PKG_SPEC}"; then
    echo -e "${RED}✗ deno install -g failed.${RESET}"
    exit 1
  fi
  PM_DIR="$INVOKE_HOME/.deno/bin"
else
  echo -e "${RED}✗ No package manager available to install the pboss package (bun/npm/deno).${RESET}"
  exit 1
fi

# Make this session see the new bin (rc-heal follows).
if [ -n "$PM_DIR" ] && [ -d "$PM_DIR" ]; then
  case ":$PATH:" in
    *":$PM_DIR:"*) ;;
    *) export PATH="$PM_DIR:$PATH" ;;
  esac
fi

# 4. Verify — `pboss` must be on PATH and answer.
PBOSS_BIN="$(command -v pboss 2>/dev/null || true)"
if [ -z "$PBOSS_BIN" ] && [ -n "$PM_DIR" ] && [ -x "$PM_DIR/pboss" ]; then
  PBOSS_BIN="$PM_DIR/pboss"
fi
if [ -z "$PBOSS_BIN" ]; then
  echo -e "${RED}✗ pboss did not become available after the install.${RESET}"
  echo -e "  Package manager: ${PM_CHOICE}; expected bin in: ${PM_DIR:-unknown}"
  echo -e "  Open a NEW terminal (PATH heals below) and run:  pboss --version"
  exit 1
fi
INSTALLED_V=$("$PBOSS_BIN" --version 2>/dev/null | awk '{print $NF}' | tr -d 'v')
echo -e "${GREEN}✓ pboss is available: $PBOSS_BIN${RESET}"

# 4b. Record the install channel — `pboss upgrade` re-runs THIS installer
#     so a machine keeps exactly one pboss and one install method.
STAMP_DIR="$INVOKE_HOME/.pboss"
mkdir -p "$STAMP_DIR"
printf '{"channel":"universal","by":"install.sh","stampedAt":%s,"version":"%s"}\n' \
  "$(date +%s)" "${INSTALLED_V:-unknown}" \
  > "$STAMP_DIR/channel.json"
if [ -n "$INVOKE_USER" ]; then
  chown "${INVOKE_USER}:" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null \
    || chown "$INVOKE_USER" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null || true
fi

# 5. PATH sanity — heal the shell profile when the bin dir is missing, the
#    same self-heal the old installer had, now for the package manager's
#    bin dir (bun: ~/.bun/bin, npm user: ~/.npm-global/bin, deno: ~/.deno/bin).
if [ -n "$PM_DIR" ] && [[ ":$PATH:" != *":$PM_DIR:"* ]]; then
  dir_in_rc() {
    if grep -qF "$PM_DIR" "$1" 2>/dev/null; then return 0; fi
    case "$PM_DIR" in
      "$INVOKE_HOME"/*)
        grep -qF '$HOME'"${PM_DIR#"$INVOKE_HOME"}" "$1" 2>/dev/null && return 0
        grep -qF '~/.'"${PM_DIR#"$INVOKE_HOME/."}" "$1" 2>/dev/null && return 0
        ;;
    esac
    return 1
  }
  healed=""
  case "${SHELL:-}" in
    *zsh) rc_primary="$INVOKE_HOME/.zshrc"; rc_login="$INVOKE_HOME/.zprofile" ;;
    *)    rc_primary="$INVOKE_HOME/.bashrc"; rc_login="$INVOKE_HOME/.profile" ;;
  esac
  for rc in "$rc_primary" "$rc_login"; do
    if [ "$rc" = "$rc_login" ] && [ ! -f "$rc" ]; then
      continue
    fi
    if dir_in_rc "$rc"; then
      continue
    fi
    {
      printf '\n# Added by the ProcBoss installer — keep pboss on PATH\n'
      printf 'export PATH="%s:$PATH"\n' "$PM_DIR"
    } >> "$rc"
    healed="$healed $(basename "$rc")"
  done
  if [ -n "$healed" ]; then
    echo -e "${GREEN}✓ Added ${PM_DIR} to PATH in${healed} — open a NEW terminal (or source the file) and 'pboss' will be found.${RESET}"
  else
    echo -e "${YELLOW}Note: ${PM_DIR} is already in your shell profile but not in THIS shell — open a new terminal and 'pboss' will be found.${RESET}"
  fi
fi

# 6. Boot persistence — per-user service, no sudo. Same contract as before.
echo -e "${CYAN}Enabling boot persistence…${RESET}"
if [ "$(uname -s)" = "Linux" ] && { ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; }; then
  echo -e "${YELLOW}⚠ systemd is not running on this host — skipping the boot service.${RESET}"
  echo -e "  (Containers and minimal VMs usually have no systemd. On a systemd host, run:)"
  echo -e "  ${CYAN}pboss startup install${RESET}"
else
  run_as_user() {
    if [ "$(id -u)" -eq 0 ] && [ -n "$INVOKE_USER" ]; then
      sudo -u "$INVOKE_USER" env PATH="$PATH" HOME="$INVOKE_HOME" "$@"
    else
      "$@"
    fi
  }
  if run_as_user "$PBOSS_BIN" startup install; then
    echo -e "${GREEN}✓ Boot persistence enabled — pboss starts at boot and resurrects saved processes.${RESET}"
  else
    echo -e "${YELLOW}⚠ Boot persistence could not be configured automatically.${RESET}"
    echo -e "  Run it yourself:  ${CYAN}pboss startup install${RESET}"
  fi
fi

# 7. Existing cloud link — the machine credential in ~/.pboss/cloud.json is
#    the permanent cache across deletes, reinstalls and upgrades.
if [ -f "$INVOKE_HOME/.pboss/cloud.json" ]; then
  echo -e "${GREEN}✓ Existing cloud link detected — the daemon will resume it automatically.${RESET}"
  echo -e "  Check its state:  ${CYAN}pboss cloud status${RESET}"
fi

# 8. Done — the version, and WHICH RUNTIME is actually executing pboss
#    right now (detected at execution time, exactly as the architecture
#    promises; this is a report, not a choice).
echo -e "${GREEN}${BOLD}"
if [ -n "$INSTALLED_V" ]; then
  echo "✓ ProcBoss (pboss) v${INSTALLED_V} successfully installed!"
else
  echo "✓ ProcBoss (pboss) successfully installed!"
fi
echo -e "${RESET}"
echo -e "Executing runtime:  ${CYAN}$("$PBOSS_BIN" --runtime 2>/dev/null || echo 'detect at first run')${RESET}"
echo -e "Run ${CYAN}pboss --version${RESET} to re-check, then ${CYAN}pboss --help${RESET} to get started."
