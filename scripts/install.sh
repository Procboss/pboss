#!/usr/bin/env bash
# ProcBoss (pboss) Universal Installer for Linux and macOS
# https://procboss.com
# Usage: curl -fsSL https://procboss.com/install.sh | bash
#
# Install target, in order of preference:
#   1. /usr/local/bin — on PATH for EVERY user, every shell, out of the box,
#      so 'pboss' works the second the installer finishes. Used when the
#      installer runs as root (legacy sudo pipe) or when sudo can elevate
#      the binary copy (it may prompt once on the terminal — sudo asks on
#      /dev/tty, which works even though this script arrives via a pipe).
#      ONLY the binary is elevated: the daemon, the state (~/.pboss) and the
#      boot service stay per-user, root-free.
#   2. The same directory a previous install used (channel.json installDir)
#      — upgrades refresh IN PLACE; a second pboss in another prefix is a
#      bug, not a feature.
#   3. ~/.local/bin — no root and no sudo at all: user-writable, plus an
#      automatic PATH self-heal in the shell profile below.
# Override with PBOSS_INSTALL_DIR=/custom/path; force the per-user fallback
# with PBOSS_NO_SUDO=1.

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

# 1. Install target (see the header comment for the preference order).
INVOKE_USER="${SUDO_USER:-}"
INVOKE_HOME="$HOME"
if [ -n "$INVOKE_USER" ]; then
  CANDIDATE_HOME=$(eval echo "~${INVOKE_USER}" 2>/dev/null || true)
  if [ -n "$CANDIDATE_HOME" ] && [ -d "$CANDIDATE_HOME" ]; then
    INVOKE_HOME="$CANDIDATE_HOME"
  fi
fi

# A previous run of THIS installer records where the binary lives (step 4b).
# One-line JSON from printf, or pretty JSON from the TypeScript writer — the
# sed handles both.
STAMPED_DIR=""
if [ -f "$INVOKE_HOME/.pboss/channel.json" ]; then
  STAMPED_DIR=$(sed -n 's/.*"installDir" *: *"\([^"]*\)".*/\1/p' "$INVOKE_HOME/.pboss/channel.json" 2>/dev/null || true)
fi

# sudo capability, probed at most once: passwordless cache first, else ONE
# interactive prompt on the terminal. Without a terminal (CI) it fails fast
# and the per-user fallback takes over — nothing ever hangs.
CAN_SUDO="no"
SUDO_PREFIX=""
probe_sudo() {
  [ "${PBOSS_NO_SUDO:-}" = "1" ] && return 1
  [ "$CAN_SUDO" = "yes" ] && return 0
  command -v sudo >/dev/null 2>&1 || return 1
  if sudo -n true 2>/dev/null; then CAN_SUDO="yes"; return 0; fi
  if [ "${1:-}" = "allow-prompt" ]; then
    # Announce BEFORE prompting: a bare password prompt mid-install with
    # no explanation reads as an attack.
    echo -e "${CYAN}sudo may ask for your password — it elevates only the pboss binary copy; the daemon, state and boot service stay yours.${RESET}"
    sudo -v >/dev/null 2>&1 && CAN_SUDO="yes"
  fi
  [ "$CAN_SUDO" = "yes" ]
}

# elev — run a command with sudo ONLY when the target needs elevation (the
# current user cannot write it). Root and user-writable targets never sudo.
elev() {
  if [ -n "$SUDO_PREFIX" ]; then sudo "$@"; else "$@"; fi
}

# target_writable — can the current user create or write an install target?
# A target that does not exist yet counts as writable when its nearest
# EXISTING ancestor is (mkdir -p creates it a moment later): testing a
# not-yet-existing ~/.local/bin with -w would falsely demand sudo on every
# fresh box.
target_writable() {
  local dir="${1:-$INSTALL_DIR}"
  if [ -e "$dir" ]; then
    [ -d "$dir" ] && [ -w "$dir" ]
  else
    local p="$(dirname "$dir")"
    while [ "$p" != "/" ] && [ ! -e "$p" ]; do p="$(dirname "$p")"; done
    [ -w "$p" ]
  fi
}

if [ -n "${PBOSS_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="${PBOSS_INSTALL_DIR}"
  echo -e "${GREEN}✓ Installing to ${INSTALL_DIR} (PBOSS_INSTALL_DIR)${RESET}"
elif [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/usr/local/bin"
  echo -e "${GREEN}✓ Running as root — installing system-wide to ${INSTALL_DIR}${RESET}"
elif [ -n "$STAMPED_DIR" ] && [ -d "$STAMPED_DIR" ]; then
  # Upgrade path: keep the exact prefix this machine already owns.
  INSTALL_DIR="$STAMPED_DIR"
  echo -e "${GREEN}✓ Refreshing the existing install at ${INSTALL_DIR} — upgrades never move pboss${RESET}"
elif [ "${PBOSS_NO_SUDO:-}" != "1" ] && target_writable "/usr/local/bin"; then
  # The system path is directly writable (rare, e.g. containers): use it
  # without a sudo round-trip at all. PBOSS_NO_SUDO opts out — the flag
  # means "per-user install, period".
  INSTALL_DIR="/usr/local/bin"
  echo -e "${GREEN}✓ Installing system-wide to ${INSTALL_DIR} — writable without sudo, on PATH for every user${RESET}"
elif probe_sudo allow-prompt; then
  INSTALL_DIR="/usr/local/bin"
  echo -e "${GREEN}✓ Installing system-wide to ${INSTALL_DIR} as $(id -un) — on PATH for every user${RESET}"
  echo -e "${YELLOW}  (sudo elevated only the binary copy; the daemon, state and boot service stay yours)${RESET}"
else
  INSTALL_DIR="$HOME/.local/bin"
  echo -e "${GREEN}✓ Installing as $(id -un) — no sudo available, no root required (${INSTALL_DIR})${RESET}"
fi

# Elevation decision for the chosen target. A stamped system target on a
# machine where sudo just broke degrades to ~/.local/bin with a loud warning
# instead of failing the install halfway.
if [ "$(id -u)" -ne 0 ] && ! target_writable; then
  # probe_sudo announces the (optional) password prompt itself.
  if [ "$CAN_SUDO" != "yes" ]; then
    probe_sudo allow-prompt
  fi
  if [ "$CAN_SUDO" = "yes" ]; then
    SUDO_PREFIX="sudo"
  else
    echo -e "${YELLOW}⚠ Cannot write ${INSTALL_DIR} without sudo — installing to ${HOME}/.local/bin instead.${RESET}"
    echo -e "  Remove the old copy at ${INSTALL_DIR}/pboss later to avoid two pboss binaries."
    INSTALL_DIR="$HOME/.local/bin"
  fi
fi
elev mkdir -p "$INSTALL_DIR"

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
#    (Install target was decided in step 1 — root/sudo/stamped/override. Do
#     NOT re-assign INSTALL_DIR here: a stale override here once sent
#     non-root installs to /usr/local/bin and died on "cp: Permission
#     denied". The test suite pins "no INSTALL_DIR assignment after the
#     step-1 mkdir".)
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

# 4. Install the compiled binary (elevated only when the target needs it).
#     Unlink first: `cp` straight over a RUNNING executable dies with
#     "Text file busy" (ETXTBSY) — the classic broken `pboss upgrade` while
#     the daemon runs. rm drops the old inode (the running daemon keeps its
#     mapping), then cp lands the new one; the boot-persistence step below
#     restarts the daemon onto the new binary.
echo -e "${CYAN}Installing pboss to ${INSTALL_DIR}...${RESET}"
elev rm -f "$INSTALL_DIR/pboss"
elev cp "$TMP_DIR/pboss" "$INSTALL_DIR/pboss"
elev chmod 755 "$INSTALL_DIR/pboss"

# 4a. One pboss per machine: a legacy per-user copy from the old installer
#     default (~/.local/bin) must not linger next to a system-wide install
#     where it could shadow the new binary. User-owned, no sudo needed.
LEGACY_LOCAL="$INVOKE_HOME/.local/bin/pboss"
if [ "$INSTALL_DIR" != "$INVOKE_HOME/.local/bin" ] && [ -f "$LEGACY_LOCAL" ] && [ -w "$INVOKE_HOME/.local/bin" ]; then
  rm -f "$LEGACY_LOCAL"
  echo -e "${GREEN}✓ Removed the old per-user copy at ${INVOKE_HOME}/.local/bin/pboss (pboss now lives in ${INSTALL_DIR})${RESET}"
fi

# 4b. Record the install channel — `pboss upgrade` re-runs THIS installer
#     (never npm/brew/snap) so a machine keeps exactly one pboss. installDir
#     is the step-1 anchor: the next run refreshes THIS directory in place.
STAMP_DIR="$INVOKE_HOME/.pboss"
mkdir -p "$STAMP_DIR"
printf '{"channel":"universal","by":"install.sh","installDir":"%s","stampedAt":%s,"version":"%s"}\n' \
  "$INSTALL_DIR" "$(date +%s)" "$("$INSTALL_DIR/pboss" --version 2>/dev/null | awk '{print $NF}' | tr -d 'v')" \
  > "$STAMP_DIR/channel.json"
if [ -n "$INVOKE_USER" ]; then
  chown "${INVOKE_USER}:" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null \
    || chown "$INVOKE_USER" "$STAMP_DIR" "$STAMP_DIR/channel.json" 2>/dev/null || true
fi

# 5. PATH sanity — /usr/local/bin is on PATH essentially everywhere. The
#    ~/.local/bin fallback self-heals the shell profile so FUTURE shells
#    find pboss without manual edits (no child process can fix the CURRENT
#    shell — say so honestly when there is nothing to heal).
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  dir_in_rc() {
    # Referenced either by absolute path or via its $HOME-relative spelling.
    grep -qF "$INSTALL_DIR" "$1" 2>/dev/null && return 0
    case "$INSTALL_DIR" in
      "$INVOKE_HOME"/*) grep -qF '$HOME'"${INSTALL_DIR#"$INVOKE_HOME"}" "$1" 2>/dev/null ;;
    esac
  }
  healed=""
  case "${SHELL:-}" in
    *zsh) rc_candidates=("$INVOKE_HOME/.zshrc" "$INVOKE_HOME/.zprofile") ;;
    *)    rc_candidates=("$INVOKE_HOME/.bashrc" "$INVOKE_HOME/.profile") ;;
  esac
  for rc in "${rc_candidates[@]}"; do
    # Append only to rc files that already exist — never invent a shell
    # config the user did not choose to have.
    if [ ! -f "$rc" ] || dir_in_rc "$rc"; then
      continue
    fi
    {
      printf '\n# Added by the ProcBoss installer — keep pboss on PATH\n'
      printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    } >> "$rc"
    healed="$healed $(basename "$rc")"
  done
  if [ -n "$healed" ]; then
    echo -e "${GREEN}✓ PATH self-healed in${healed} — open a NEW terminal and pboss will be on PATH.${RESET}"
  else
    echo -e "${YELLOW}Note: ${INSTALL_DIR} is not on the current PATH. Add it to your shell profile if 'pboss' is not found.${RESET}"
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
