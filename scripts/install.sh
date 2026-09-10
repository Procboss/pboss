#!/usr/bin/env bash
# ProcBoss (pboss) Universal Installer for Linux and macOS
# https://procboss.com
# Usage: curl -fsSL https://procboss.com/install.sh | bash
#
# No root required, ever: the binary goes to ~/.local/bin (a user-writable
# dir), and when that dir is not on PATH the installer ADDS it to the user's
# shell profile (~/.bashrc / ~/.zshrc) instead of printing a manual note.
# The boot service is a per-user systemd unit. Running the installer AS root
# (the legacy sudo pipe) still works and installs system-wide to
# /usr/local/bin for all users of the machine — but sudo is never required.

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

# 1. Install target — no root required, no sudo ever invoked.
#    Default: ~/.local/bin (per-user, writable; step 5 adds it to PATH in
#    the shell profile when missing). Legacy/explicit system install: run
#    AS root → /usr/local/bin.
INVOKE_USER="${SUDO_USER:-}"
INVOKE_HOME="$HOME"
if [ -n "$INVOKE_USER" ]; then
  CANDIDATE_HOME=$(eval echo "~${INVOKE_USER}" 2>/dev/null || true)
  if [ -n "$CANDIDATE_HOME" ] && [ -d "$CANDIDATE_HOME" ]; then
    INVOKE_HOME="$CANDIDATE_HOME"
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/usr/local/bin"
  echo -e "${GREEN}✓ Running as root — installing system-wide to ${INSTALL_DIR}${RESET}"
  echo -e "${YELLOW}Note: sudo is NOT needed. A plain user install goes to ~/.local/bin${RESET}"
else
  INSTALL_DIR="$HOME/.local/bin"
  echo -e "${GREEN}✓ Installing as $(id -un) — no root required (${INSTALL_DIR})${RESET}"
fi
mkdir -p "$INSTALL_DIR"

# 2. Bun build toolchain.
#    Bun is only needed to COMPILE pboss — the final executable embeds the Bun
#    runtime, so the system does not need Bun installed once pboss is built.

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
  # The env assignment must sit on the *bash* side of the pipe: piping into
  # `BUN_INSTALL=… bash` sends the var to the installer, whereas prefixing
  # curl with it does nothing for the installer (classic pipe foot-gun).
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$INVOKE_HOME/.bun" bash
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

# 3. Temporary build workspace
#    (Install target was decided in step 1: root → /usr/local/bin, plain
#     user → ~/.local/bin. Do NOT re-assign INSTALL_DIR here — a stale
#     override here once sent non-root installs to /usr/local/bin and died
#     on "cp: Permission denied". The test suite pins "no INSTALL_DIR
#     assignment after the step-1 mkdir".)
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

# 4. Install the compiled binary.
#     Unlink first: `cp` straight over a RUNNING executable dies with
#     "Text file busy" (ETXTBSY) — the classic broken `pboss upgrade` while
#     the daemon runs. rm drops the old inode (the running daemon keeps its
#     mapping), then cp lands the new one; the boot-persistence step below
#     restarts the daemon onto the new binary.
echo -e "${CYAN}Installing pboss to ${INSTALL_DIR}...${RESET}"
rm -f "$INSTALL_DIR/pboss"
cp "$TMP_DIR/pboss" "$INSTALL_DIR/pboss"
chmod 755 "$INSTALL_DIR/pboss"

# 4b. Record the install channel — `pboss upgrade` re-runs THIS installer
#     (never npm/brew/snap) so a machine keeps exactly one pboss.
STAMP_DIR="$INVOKE_HOME/.pboss"
mkdir -p "$STAMP_DIR"
printf '{"channel":"universal","by":"install.sh","stampedAt":%s,"version":"%s"}\n' \
  "$(date +%s)" "$("$INSTALL_DIR/pboss" --version 2>/dev/null | awk '{print $NF}' | tr -d 'v')" \
  > "$STAMP_DIR/channel.json"
if [ -n "$INVOKE_USER" ]; then
  chown "${INVOKE_USER}:" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null \
    || chown "$INVOKE_USER" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null || true
fi

# 5. PATH sanity — /usr/local/bin (root installs) is on PATH essentially
#    everywhere. The ~/.local/bin per-user install self-heals the shell
#    profile instead of printing a manual note: ~/.bashrc (bash) or
#    ~/.zshrc (zsh) is appended — and created when missing — plus the login
#    profile (~/.profile / ~/.zprofile) when the user already has one, so
#    FUTURE shells find pboss with zero manual edits. No child process can
#    fix the CURRENT shell; the messages below say so honestly.
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  dir_in_rc() {
    # Referenced by absolute path, its $HOME-relative spelling, or the ~
    # shorthand (Ubuntu's stock ~/.profile snippet uses $HOME).
    if grep -qF "$INSTALL_DIR" "$1" 2>/dev/null; then return 0; fi
    case "$INSTALL_DIR" in
      "$INVOKE_HOME"/*)
        grep -qF '$HOME'"${INSTALL_DIR#"$INVOKE_HOME"}" "$1" 2>/dev/null && return 0
        grep -qF '~/.'"${INSTALL_DIR#"$INVOKE_HOME/."}" "$1" 2>/dev/null && return 0
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
    # The primary rc is CREATED when missing (the owner's ask: add the dir
    # to ~/.bashrc, do not just note it); the login profile is only ever
    # appended to when the user already has one — never invent a config
    # they did not choose.
    if [ "$rc" = "$rc_login" ] && [ ! -f "$rc" ]; then
      continue
    fi
    if dir_in_rc "$rc"; then
      continue
    fi
    {
      printf '\n# Added by the ProcBoss installer — keep pboss on PATH\n'
      printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    } >> "$rc"
    healed="$healed $(basename "$rc")"
  done
  if [ -n "$healed" ]; then
    echo -e "${GREEN}✓ Added ${INSTALL_DIR} to PATH in${healed} — open a NEW terminal (or source the file) and 'pboss' will be found.${RESET}"
  else
    echo -e "${YELLOW}Note: ${INSTALL_DIR} is already in your shell profile but not in THIS shell — open a new terminal and 'pboss' will be found.${RESET}"
  fi
fi

# 6. Boot persistence — installed automatically, WITHOUT sudo.
#    The whole point of pboss: processes survive reboots by default. The boot
#    service is PER-USER (systemd user unit / launchd agent), starts the
#    daemon, and the daemon resurrects the saved process list (auto-saved
#    after every pboss start/stop/delete). When the installer itself runs as
#    root (legacy sudo pipe), the service install runs as the INVOKING user
#    instead — root has no user systemd session. Best-effort: hosts without
#    systemd (containers, WSL1) get a note instead of an error.
echo -e "${CYAN}Enabling boot persistence...${RESET}"
if [ "$(uname -s)" = "Linux" ] && { ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; }; then
  echo -e "${YELLOW}⚠ systemd is not running on this host — skipping the boot service.${RESET}"
  echo -e "  (Containers and minimal VMs usually have no systemd. On a systemd host, run:)"
  echo -e "  ${CYAN}${INSTALL_DIR}/pboss startup install${RESET}"
else
  PBOSS_BIN="$INSTALL_DIR/pboss"
  run_as_user() {
    # Non-root: plain. Root via sudo: drop back to the invoking user — the
    # service is per-user and `systemctl --user` needs THEIR session.
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
    echo -e "  Run it yourself:  ${CYAN}${PBOSS_BIN} startup install${RESET}"
  fi
fi

# 7. Existing cloud link — the machine credential in ~/.pboss/cloud.json is
#    the permanent cache: it outlives the binary across deletes, reinstalls
#    and upgrades. The boot-persistence step above (re)started the daemon,
#    which resumes the link; the next CLI command does the same on hosts
#    without a service. Say so instead of making a reinstalled machine look
#    unlinked.
if [ -f "$INVOKE_HOME/.pboss/cloud.json" ]; then
  echo -e "${GREEN}✓ Existing cloud link detected — the daemon will resume it automatically.${RESET}"
  echo -e "  Check its state:  ${CYAN}${INSTALL_DIR}/pboss cloud status${RESET}"
fi

echo -e "${GREEN}${BOLD}"
echo "✓ ProcBoss (pboss) successfully installed to ${INSTALL_DIR}/pboss!"
echo -e "${RESET}"
echo -e "Run ${CYAN}pboss --version${RESET} to verify, then ${CYAN}pboss --help${RESET} to get started."
