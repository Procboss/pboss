#!/bin/sh
# ProcBoss (pboss) Universal Installer for Linux and macOS
# https://procboss.com
# Usage:
#   curl -fsSL https://procboss.com/install.sh | sh
#   curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=node
#   curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=bun
#   curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=deno
#
# RUNTIME-AWARE ARCHITECTURE (the contract this installer implements):
#
#   The USER selects the runtime — explicitly (--runtime=<x>) or through the
#   interactive prompt (Node is the default; Enter picks it). The selection
#   is persisted by pboss itself into ~/.pboss/.runtime and stays there
#   across upgrades until `pboss runtime change` says otherwise.
#
#   This installer NEVER infers a runtime from whatever happens to be
#   installed. The selected runtime is authoritative: if the user chose Bun
#   and only Node exists, Bun gets installed and used.
#
#   It installs the PUBLISHED package from the registry through the selected
#   runtime's own package ecosystem (npm / bun / deno) — never a git clone,
#   never a source build. Version pinning for `pboss upgrade`:
#   PBOSS_VERSION=<x> selects the exact release.
#
# No root required, ever. The boot service is per-user.

set -e

RESET=$(printf '\033[0m')
BOLD=$(printf '\033[1m')
GREEN=$(printf '\033[32m')
CYAN=$(printf '\033[36m')
YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m')

printf '%s\n' "${CYAN}${BOLD}"
printf '%s\n' "  ⚡ ProcBoss (pboss) Installer"
printf '%s\n' "  https://procboss.com"
printf '%s\n' "${RESET}"

# ── 1. Install context (root via sudo still works; the service drops back) ─
INVOKE_USER="${SUDO_USER:-}"
INVOKE_HOME="$HOME"
if [ -n "$INVOKE_USER" ]; then
  CANDIDATE_HOME=$(eval echo "~${INVOKE_USER}" 2>/dev/null || true)
  if [ -n "$CANDIDATE_HOME" ] && [ -d "$CANDIDATE_HOME" ]; then
    INVOKE_HOME="$CANDIDATE_HOME"
  fi
fi
IS_ROOT=0
[ "$(id -u)" -eq 0 ] && IS_ROOT=1

PBOSS_HOME_DIR="${PBOSS_HOME:-$INVOKE_HOME/.pboss}"
RUNTIME_FILE="$PBOSS_HOME_DIR/.runtime"

die() { printf '%s\n' "$*" >&2; exit 1; }

supported_runtimes_list() {
  printf '%s\n' "Supported runtimes:"
  printf '%s\n' "  node"
  printf '%s\n' "  bun"
  printf '%s\n' "  deno"
}

normalize_runtime() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' \t\r\n'; }

# Display labels for the spec-20 error texts ("Attempting to install Bun...").
runtime_display() {
  case "$1" in
    node) printf '%s' "Node" ;;
    bun) printf '%s' "Bun" ;;
    deno) printf '%s' "Deno" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ── 2. Runtime selection: --runtime=<x>, or the interactive prompt ───────
RUNTIME=""

# Parse the args (both spellings, anywhere before `--`).
EXPECT_VALUE=0
for ARG in "$@"; do
  if [ "$EXPECT_VALUE" = 1 ]; then
    RUNTIME="$ARG"
    EXPECT_VALUE=0
    continue
  fi
  case "$ARG" in
    --) break ;;
    --runtime) EXPECT_VALUE=1 ;;
    --runtime=*) RUNTIME="${ARG#--runtime=}" ;;
    -h | --help)
      printf '%s\n' "Usage: curl -fsSL https://procboss.com/install.sh | sh -s -- [--runtime=node|bun|deno]"
      exit 0
      ;;
  esac
done
[ "$EXPECT_VALUE" = 1 ] && die "--runtime requires a value: node | bun | deno"

if [ -n "$RUNTIME" ]; then
  # Explicit selection: validate, normalize to lowercase, never guess.
  RUNTIME="$(normalize_runtime "$RUNTIME")"
  case "$RUNTIME" in
    node | bun | deno) ;;
    *)
      printf '\n' >&2
      printf 'Unsupported runtime: %s\n\n' "$RUNTIME" >&2
      supported_runtimes_list >&2
      exit 1
      ;;
  esac
else
  # Interactive selection — Node on Enter (the default). Works when stdin is
  # the curl pipe too: the prompt reads the terminal via /dev/tty. Fully
  # headless environments (CI) must pass --runtime explicitly.
  printf '%s\n' "Kindly select your runtime:"
  printf '\n'
  printf '%s\n' "  1. Node"
  printf '%s\n' "  2. Bun"
  printf '%s\n' "  3. Deno"
  printf '\n'
  printf 'Select runtime [1]: '
  ANSWER=""
  if [ -t 0 ]; then
    read ANSWER || ANSWER=""
  elif [ -t 1 ] && read ANSWER </dev/tty 2>/dev/null; then
    : # terminal available despite the piped script (the curl | sh case)
  else
    printf '\n' >&2
    printf '%s\n' "ProcBoss needs a runtime selection." >&2
    printf '\n' >&2
    printf '%s\n' "Run the installer with one of:" >&2
    printf '\n' >&2
    printf '%s\n' "  --runtime=node" >&2
    printf '%s\n' "  --runtime=bun" >&2
    printf '%s\n' "  --runtime=deno" >&2
    printf '\n' >&2
    exit 1
  fi
  ANSWER="$(normalize_runtime "$ANSWER")"
  case "$ANSWER" in
    "" | 1 | node) RUNTIME="node" ;;
    2 | bun) RUNTIME="bun" ;;
    3 | deno) RUNTIME="deno" ;;
    *)
      printf '\n' >&2
      printf 'Unsupported runtime: %s\n\n' "$ANSWER" >&2
      supported_runtimes_list >&2
      exit 1
      ;;
  esac
fi

printf '%s' "${CYAN}Selected runtime: "
printf '%s\n' "${GREEN}${RUNTIME}${RESET}"

# ── 3. Ensure the selected runtime exists — install it when missing ───────
# The selected runtime is authoritative: another runtime being present is
# never a reason to switch. We install only what was chosen.
runtime_bin() { command -v "$1" 2>/dev/null || true; }

RUNTIME_BIN="$(runtime_bin "$RUNTIME")"
# Well-known per-user locations count (a PATH not yet healed by the shell).
if [ -z "$RUNTIME_BIN" ]; then
  case "$RUNTIME" in
    bun) [ -x "$INVOKE_HOME/.bun/bin/bun" ] && RUNTIME_BIN="$INVOKE_HOME/.bun/bin/bun" ;;
    deno) [ -x "$INVOKE_HOME/.deno/bin/deno" ] && RUNTIME_BIN="$INVOKE_HOME/.deno/bin/deno" ;;
    node) [ -x "$INVOKE_HOME/.local/bin/node" ] && RUNTIME_BIN="$INVOKE_HOME/.local/bin/node" ;;
  esac
fi

if [ -n "$RUNTIME_BIN" ]; then
  printf '%s\n' "${GREEN}✓ $(runtime_display "$RUNTIME") found (${RUNTIME_BIN})${RESET}"
else
  printf '%s\n' "${YELLOW}ProcBoss requires $(runtime_display "$RUNTIME"), but $(runtime_display "$RUNTIME") was not found.${RESET}"
  printf '\n'
  printf '%s\n' "${YELLOW}Attempting to install $(runtime_display "$RUNTIME")...${RESET}"
  printf '\n'
  case "$RUNTIME" in
    bun)
      # The env assignment sits on the *bash* side of the pipe: prefixing
      # curl with it does nothing for the installer (classic pipe foot-gun).
      curl -fsSL https://bun.sh/install | BUN_INSTALL="$INVOKE_HOME/.bun" bash
      [ -n "$INVOKE_USER" ] && chown -R "${INVOKE_USER}:" "$INVOKE_HOME/.bun" 2>/dev/null || true
      RUNTIME_BIN="$INVOKE_HOME/.bun/bin/bun"
      ;;
    deno)
      curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$INVOKE_HOME/.deno" sh -s -- --yes
      [ -n "$INVOKE_USER" ] && chown -R "${INVOKE_USER}:" "$INVOKE_HOME/.deno" 2>/dev/null || true
      RUNTIME_BIN="$INVOKE_HOME/.deno/bin/deno"
      ;;
    node)
      # Node has no official one-line installer: unpack the official dist
      # tarball rootlessly (~/.local/opt/node + ~/.local/bin symlinks).
      OS_NAME="$(uname -s)"
      ARCH="$(uname -m)"
      case "$OS_NAME" in
        Linux) DIST_OS="linux" ;;
        Darwin) DIST_OS="darwin" ;;
        *) die "Unable to install Node.js automatically on $OS_NAME — install it from https://nodejs.org and re-run." ;;
      esac
      case "$ARCH" in
        x86_64 | amd64) DIST_ARCH="x64" ;;
        aarch64 | arm64) DIST_ARCH="arm64" ;;
        *) die "Unable to install Node.js automatically on $ARCH — install it from https://nodejs.org and re-run." ;;
      esac
      NODE_BASE="https://nodejs.org/dist/latest-v22.x"
      NODE_FILE="$(curl -fsSL "$NODE_BASE/" | grep -o "node-v[0-9.]*-${DIST_OS}-${DIST_ARCH}.tar.xz" | head -1)"
      [ -n "$NODE_FILE" ] || die "Unable to install Node.js automatically (could not read the dist listing). Install it from https://nodejs.org and re-run."
      printf '%s\n' "${CYAN}Downloading ${NODE_FILE} ...${RESET}"
      NODE_TMP="$(mktemp -d)"
      curl -fsSL "$NODE_BASE/$NODE_FILE" -o "$NODE_TMP/node.tar.xz"
      mkdir -p "$INVOKE_HOME/.local/opt/node" "$INVOKE_HOME/.local/bin"
      tar -xJf "$NODE_TMP/node.tar.xz" -C "$INVOKE_HOME/.local/opt/node" --strip-components=1
      for b in node npm npx corepack; do
        ln -sf "$INVOKE_HOME/.local/opt/node/bin/$b" "$INVOKE_HOME/.local/bin/$b" 2>/dev/null || true
      done
      rm -rf "$NODE_TMP"
      [ -n "$INVOKE_USER" ] && chown -R "${INVOKE_USER}:" "$INVOKE_HOME/.local" 2>/dev/null || true
      RUNTIME_BIN="$INVOKE_HOME/.local/bin/node"
      ;;
  esac
  if [ ! -x "$RUNTIME_BIN" ]; then
    printf '\n' >&2
    printf '%s\n' "${RED}Unable to install $(runtime_display "$RUNTIME") automatically.${RESET}" >&2
    printf '\n' >&2
    printf '%s\n' "Please install $(runtime_display "$RUNTIME") and run:" >&2
    printf '\n' >&2
    printf '%s\n' "  curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=${RUNTIME}" >&2
    printf '\n' >&2
    exit 1
  fi
  printf '%s\n' "${GREEN}✓ $(runtime_display "$RUNTIME") installed (${RUNTIME_BIN})${RESET}"
fi

# The runtime's bin dir must be on THIS shell's PATH for the steps below.
RUNTIME_BIN_DIR="$(dirname "$RUNTIME_BIN")"
case ":$PATH:" in
  *":$RUNTIME_BIN_DIR:"*) ;;
  *) export PATH="$RUNTIME_BIN_DIR:$PATH" ;;
esac

# ── 3b. Heal Bun's global state (pre-install) ───────────────────────────
# A `bun add -g .` run from inside a package directory leaves a nameless
# ("") entry in Bun's global package.json — and from Bun 1.4 on, EVERY
# later `bun add -g` (any package) then dies with "refusing to install
# dependency with unsafe name". The machine looks broken; only this state
# is. Heal it before installing: drop the invalid entry + the stale lock.
# $1 = bun home (default: $BUN_INSTALL or ~/.bun).
heal_bun_global_state() {
  _BH="${1:-${BUN_INSTALL:-$HOME/.bun}}"
  _BGP="$_BH/install/global/package.json"
  [ -f "$_BGP" ] || return 0
  grep -q '^[[:space:]]*""[[:space:]]*:' "$_BGP" 2>/dev/null || return 0
  printf '%s\n' "${YELLOW}⚠ Detected a corrupted Bun global state: $_BGP has a nameless (\"\") entry.${RESET}"
  printf '%s\n' "${YELLOW}  (It comes from a \`bun add -g .\` inside a package directory — every later \`bun add -g\` fails with \"refusing to install dependency with unsafe name\" until healed.)${RESET}"
  # Drop the "" line; if it was the last entry, also strip the previous
  # line's now-trailing comma. Pure POSIX awk — no runtime needed.
  awk '
    /^[ \t]*""[ \t]*:/ { next }
    {
      if (pending != "") {
        if ($0 ~ /^[ \t]*[}]/ && pending ~ /,[ \t]*$/) sub(/,[ \t]*$/, "", pending)
        print pending
      }
      pending = $0
    }
    END { if (pending != "") print pending }
  ' "$_BGP" > "${_BGP}.pboss-heal" 2>/dev/null && cat "${_BGP}.pboss-heal" > "$_BGP" && rm -f "${_BGP}.pboss-heal"
  rm -f "$_BH/install/global/bun.lock"
  printf '%s\n' "${GREEN}✓ Bun global state healed (the invalid entry and the stale lockfile are gone).${RESET}"
}

# ── 4. Install the PUBLISHED pboss package through the runtime's own ─────
#    package ecosystem (spec: never a clone, never a source build).
PKG_SPEC="pboss"
[ -n "$PBOSS_VERSION" ] && PKG_SPEC="pboss@${PBOSS_VERSION}"
PM_DIR=""
PM_CHOICE=""

case "$RUNTIME" in
  node)
    # npm ships with node. Unwritable prefix → the user's own prefix (the
    # standard rootless npm layout).
    PM_CHOICE="npm"
    NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
    printf '%s\n' "${CYAN}Installing the published pboss package globally (npm install -g ${PKG_SPEC})…${RESET}"
    if [ -n "$NPM_PREFIX" ] && [ ! -w "$NPM_PREFIX" ] && [ "$IS_ROOT" -eq 0 ]; then
      export NPM_CONFIG_PREFIX="$INVOKE_HOME/.npm-global"
      npm install -g --prefix "$INVOKE_HOME/.npm-global" "$PKG_SPEC" || die "npm install -g failed."
      PM_DIR="$INVOKE_HOME/.npm-global/bin"
    else
      npm install -g "$PKG_SPEC" || die "npm install -g failed."
      PM_DIR="$([ -n "$NPM_PREFIX" ] && printf '%s' "$NPM_PREFIX" || npm config get prefix)/bin"
      [ -d "$PM_DIR" ] || PM_DIR="$(npm config get prefix)"
    fi
    ;;
  bun)
    PM_CHOICE="bun"
    heal_bun_global_state
    if [ "$(id -u)" -eq 0 ] && [ -n "$INVOKE_USER" ]; then
      heal_bun_global_state "$INVOKE_HOME/.bun"
    fi
    printf '%s\n' "${CYAN}Installing the published pboss package globally (bun install -g ${PKG_SPEC})…${RESET}"
    BUN_INSTALL_OK=1
    if [ "$(id -u)" -eq 0 ]; then
      if [ -n "$INVOKE_USER" ]; then
        # Root: install into the invoking user's bun (the per-user layout).
        sudo -u "$INVOKE_USER" env BUN_INSTALL="$INVOKE_HOME/.bun" PATH="$PATH" "$RUNTIME_BIN" install -g "$PKG_SPEC" || BUN_INSTALL_OK=0
      else
        "$RUNTIME_BIN" install -g "$PKG_SPEC" || BUN_INSTALL_OK=0
      fi
    else
      "$RUNTIME_BIN" install -g "$PKG_SPEC" || BUN_INSTALL_OK=0
    fi
    if [ "$BUN_INSTALL_OK" -eq 1 ]; then
      PM_DIR="$(dirname "$(command -v bun 2>/dev/null || printf '%s' "$INVOKE_HOME/.bun/bin/bun")")"
    elif command -v npm >/dev/null 2>&1; then
      # npm fallback — the wrapper still dispatches to Bun at run time; npm
      # is only the delivery vehicle. The channel stamp records npm because
      # that is what can upgrade pboss on this machine.
      printf '%s\n' "${YELLOW}⚠ bun install -g failed — falling back to npm (pboss still runs on ${RUNTIME}; the runtime selection is unchanged).${RESET}"
      PM_CHOICE="npm"
      NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
      npm install -g "$PKG_SPEC" || die "npm install -g failed."
      PM_DIR="$([ -n "$NPM_PREFIX" ] && printf '%s' "$NPM_PREFIX" || npm config get prefix)/bin"
      [ -d "$PM_DIR" ] || PM_DIR="$(npm config get prefix)"
    else
      die "bun install -g failed, and npm was not found to fall back on.

Bun's global state may still be corrupted. Fix it manually and re-run:
  1. Edit  ${BUN_INSTALL:-$HOME/.bun}/install/global/package.json
     and delete the nameless entry (the line starting with \"\")
  2. Delete  ${BUN_INSTALL:-$HOME/.bun}/install/global/bun.lock
  3. Re-run this installer
(That state is poisoned by a \`bun add -g .\` inside a package directory —
Bun refuses every later global install until it is healed.)"
    fi
    ;;
  deno)
    PM_CHOICE="deno"
    printf '%s\n' "${CYAN}Installing the published pboss package globally (deno install -g npm:${PKG_SPEC})…${RESET}"
    # Deno executes package bins as modules — the .sh wrapper cannot serve
    # that path — so deno installs the published entry subpath directly
    # (same file the wrapper dispatches to: dist/cli.deno.js).
    if [ "${PKG_SPEC}" != "pboss" ]; then
      DENO_SPEC="npm:pboss@${PKG_SPEC#pboss@}/deno-entry"
    else
      DENO_SPEC="npm:pboss/deno-entry"
    fi
    "$RUNTIME_BIN" install -g -f -A --name pboss "$DENO_SPEC" || die "deno install -g failed."
    PM_DIR="$INVOKE_HOME/.deno/bin"
    ;;
esac

# Make this session see the new bin (rc-heal follows).
if [ -n "$PM_DIR" ] && [ -d "$PM_DIR" ]; then
  case ":$PATH:" in
    *":$PM_DIR:"*) ;;
    *) export PATH="$PM_DIR:$PATH" ;;
  esac
fi

# ── 5. Verify + initialize the persistent runtime selection ──────────────
PBOSS_BIN="$(command -v pboss 2>/dev/null || true)"
if [ -z "$PBOSS_BIN" ] && [ -n "$PM_DIR" ] && [ -x "$PM_DIR/pboss" ]; then
  PBOSS_BIN="$PM_DIR/pboss"
fi
[ -n "$PBOSS_BIN" ] || {
  printf '%s\n' "${RED}✗ pboss did not become available after the install.${RESET}"
  printf '%s\n' "  Package manager: ${PM_CHOICE}; expected bin in: ${PM_DIR:-unknown}"
  printf '%s\n' "  Open a NEW terminal (PATH heals below) and run:  pboss --version"
  exit 1
}

# Tell the newly installed pboss which runtime was selected — this PERSISTS
# it to ~/.pboss/.runtime (the CLI saves it; every later `pboss` — including
# upgrades — reads it back and dispatches accordingly).
printf '%s\n' "${CYAN}Initializing the runtime selection…${RESET}"
"$PBOSS_BIN" --runtime="$RUNTIME" --version >/dev/null 2>&1 || {
  printf '%s\n' "${YELLOW}⚠ Could not initialize the runtime selection — run:  pboss --runtime=$RUNTIME${RESET}"
}
if [ "$(normalize_runtime "$(cat "$RUNTIME_FILE" 2>/dev/null || printf '%s' '')")" = "$RUNTIME" ]; then
  printf '%s\n' "${GREEN}✓ Runtime persisted: ${RUNTIME} (${RUNTIME_FILE})${RESET}"
fi

INSTALLED_V="$("$PBOSS_BIN" --version 2>/dev/null | awk '{print $NF}' | tr -d 'v')"
printf '%s\n' "${GREEN}✓ pboss is available: $PBOSS_BIN${RESET}"

# ── 6. Record the install channel — `pboss upgrade` upgrades in place ────
STAMP_DIR="$PBOSS_HOME_DIR"
mkdir -p "$STAMP_DIR"
printf '{"channel":"universal","pm":"%s","by":"install.sh","stampedAt":%s,"version":"%s"}\n' \
  "$PM_CHOICE" "$(date +%s)" "${INSTALLED_V:-unknown}" \
  > "$STAMP_DIR/channel.json"
[ -n "$INVOKE_USER" ] && chown "${INVOKE_USER}:" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null || true

# ── 7. PATH self-heal — the PM bin dir stays on PATH in future shells ────
heal_path_in_rc() {
  [ -n "$PM_DIR" ] || return 0
  case ":$PATH:" in
    *":$PM_DIR:"*) return 0 ;;
  esac
  dir_in_rc() {
    grep -qF "$PM_DIR" "$1" 2>/dev/null && return 0
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
    *) rc_primary="$INVOKE_HOME/.bashrc"; rc_login="$INVOKE_HOME/.profile" ;;
  esac
  for rc in "$rc_primary" "$rc_login"; do
    [ "$rc" = "$rc_login" ] && [ ! -f "$rc" ] && continue
    dir_in_rc "$rc" && continue
    {
      printf '\n# Added by the ProcBoss installer — keep pboss on PATH\n'
      printf 'export PATH="%s:$PATH"\n' "$PM_DIR"
    } >> "$rc"
    healed="$healed $(basename "$rc")"
  done
  [ -z "$healed" ] || printf '%s\n' "${GREEN}✓ Added ${PM_DIR} to PATH in${healed} — open a NEW terminal and 'pboss' will be found.${RESET}"
}
heal_path_in_rc

# ── 8. Boot persistence — per-user service, no sudo (best-effort) ─────────
printf '%s\n' "${CYAN}Enabling boot persistence…${RESET}"
if [ "$(uname -s)" = "Linux" ] && { ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; }; then
  printf '%s\n' "${YELLOW}⚠ systemd is not running on this host — skipping the boot service.${RESET}"
  printf '%s\n' "  (Containers and minimal VMs usually have no systemd. On a systemd host, run:)"
  printf '%s\n' "  ${CYAN}pboss startup install${RESET}"
else
  run_as_user() {
    if [ "$(id -u)" -eq 0 ] && [ -n "$INVOKE_USER" ]; then
      sudo -u "$INVOKE_USER" env PATH="$PATH" HOME="$INVOKE_HOME" "$@"
    else
      "$@"
    fi
  }
  if run_as_user "$PBOSS_BIN" startup install; then
    printf '%s\n' "${GREEN}✓ Boot persistence enabled — pboss starts at boot and resurrects saved processes.${RESET}"
  else
    printf '%s\n' "${YELLOW}⚠ Boot persistence could not be configured automatically.${RESET}"
    printf '%s\n' "  Run it yourself:  ${CYAN}pboss startup install${RESET}"
  fi
fi

# ── 9. Existing cloud link — the permanent machine credential ──────────────
if [ -f "$PBOSS_HOME_DIR/cloud.json" ]; then
  printf '%s\n' "${GREEN}✓ Existing cloud link detected — the daemon will resume it automatically.${RESET}"
  printf '%s\n' "  Check its state:  ${CYAN}pboss cloud status${RESET}"
fi

# ── 10. Done ───────────────────────────────────────────────────────────────
printf '%s\n' "${GREEN}${BOLD}"
if [ -n "$INSTALLED_V" ]; then
  printf '%s\n' "✓ ProcBoss (pboss) v${INSTALLED_V} successfully installed!"
else
  printf '%s\n' "✓ ProcBoss (pboss) successfully installed!"
fi
printf '%s\n' "${RESET}"
printf '%s' "Runtime:  ${CYAN}${RUNTIME}"
[ -n "$("$PBOSS_BIN" --version 2>/dev/null)" ] && printf '%s' " (persisted to ${RUNTIME_FILE})"
printf '\n'
printf '%s\n' "Change it any time:  ${CYAN}pboss runtime change${RESET}"
printf '%s\n' "Upgrade ONLY through pboss itself:  ${CYAN}pboss upgrade${RESET}  (never npm/bun update -g — the channel that installed pboss upgrades it)"
printf '%s\n' "Run ${CYAN}pboss --version${RESET} to re-check, then ${CYAN}pboss --help${RESET} to get started."
