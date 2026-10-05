#!/bin/sh
# ProcBoss (pboss) — the bin wrapper (Linux/macOS; PowerShell twin: pboss.ps1)
# https://procboss.com
# License: GPL-3.0-only
#
# THE ARCHITECTURE (why this file exists):
#
#   One shebang line cannot name two interpreters, and npm links bins as a
#   single file — so the package's bin IS this shell wrapper, and IT decides
#   which JavaScript runtime executes ProcBoss. The runtime is NEVER inferred
#   from whatever happens to be installed: it is an explicit, persistent,
#   user-owned choice.
#
# Resolution order (the contract — mirrored by bin/pboss.ps1, the installer,
#   and src/runtime-config.ts; tests/wrapper.test.ts pins the texts):
#
#   1. --runtime=<x> / --runtime <x>   anywhere before the `--` sentinel —
#      an explicit per-invocation override. Not persisted here: the CLI
#      prints the "Using <x> for this invocation" notice and (when no
#      selection exists yet) initializes ~/.pboss/.runtime itself.
#   2. ~/.pboss/.runtime               the persistent selection (written by
#      `pboss --runtime=<x>`, `pboss runtime change`, or the first-run
#      prompt below). PBOSS_HOME overrides the directory.
#   3. Interactive selection           first run only; Enter = Node. In a
#      non-interactive environment this is a hard error, never a guess.
#
# Dispatch lands on the runtime-specific entrypoint:
#
#   node → node  …/dist/cli.node.js      bun → bun  …/dist/cli.bun.js
#   deno → deno run -A …/dist/cli.deno.js
#
# (Deno's own global installs do not run this file — deno executes package
#  bins as modules, so its installer targets the published entry subpath:
#  `deno install -g -A --name pboss npm:pboss/deno-entry`.)
#
# All arguments — including spaces, quotes, empty strings and everything
# after `--` — are forwarded VERBATIM via "$@". The flag is stripped by the
# CLI, not here, so the wrapper's scan can stay read-only and order-safe.

# ── 0. ProcBoss home (tests + portability: PBOSS_HOME overrides ~/.pboss) ──
PBOSS_HOME_DIR="${PBOSS_HOME:-$HOME/.pboss}"
RUNTIME_FILE="$PBOSS_HOME_DIR/.runtime"

die() { printf '%s\n' "$*" >&2; exit 1; }

# ── 1. Locate this package (the wrapper is symlinked into bin dirs) ──────
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
PKG_DIR="$(CDPATH='' cd -- "$(dirname -- "$SELF")/.." 2>/dev/null && pwd -P)" || true

# ── 2. Scan the arguments for an explicit --runtime (before `--`) ─────────
RUNTIME_FLAG=""
EXPECT_VALUE=0
for ARG in "$@"; do
  if [ "$EXPECT_VALUE" = 1 ]; then
    RUNTIME_FLAG="$ARG"
    EXPECT_VALUE=0
    continue
  fi
  case "$ARG" in
    --) break ;; # everything after -- belongs to the command's own argv
    --runtime) EXPECT_VALUE=1 ;;
    --runtime=*) RUNTIME_FLAG="${ARG#--runtime=}" ;;
  esac
done
[ "$EXPECT_VALUE" = 1 ] && die "--runtime requires a value: node | bun | deno"

# normalize: trim + lowercase
normalize_runtime() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' \t\r\n'; }

if [ -n "$RUNTIME_FLAG" ]; then
  # ── 3a. Explicit override — validate, never silently guess ─────────────
  RUNTIME="$(normalize_runtime "$RUNTIME_FLAG")"
  case "$RUNTIME" in
    node | bun | deno) ;;
    *)
      die "Unsupported runtime: $RUNTIME_FLAG

Supported runtimes:
  node
  bun
  deno"
      ;;
  esac
elif [ -f "$RUNTIME_FILE" ]; then
  # ── 3b. The persistent selection ────────────────────────────────────────
  RUNTIME="$(normalize_runtime "$(cat "$RUNTIME_FILE" 2>/dev/null)")"
  case "$RUNTIME" in
    node | bun | deno) ;;
    *)
      die "Invalid ProcBoss runtime configuration: $(cat "$RUNTIME_FILE" 2>/dev/null)

Supported runtimes:
  node
  bun
  deno"
      ;;
  esac
else
  # ── 3c. First run: interactive selection, Node on Enter (spec §2) ───────
  # The prompt is printed only when a terminal is attached (stdin or stdout
  # is a tty); fully headless environments go straight to the error. When
  # stdin is a pipe but a terminal is attached (the curl|sh class), the
  # answer is read from the controlling terminal via /dev/tty.
  if [ -t 0 ] || [ -t 1 ]; then
    printf 'Kindly select your runtime:\n\n'
    printf '  1. Node\n'
    printf '  2. Bun\n'
    printf '  3. Deno\n\n'
    printf 'Select runtime [1]: '
  fi
  ANSWER=""
  if [ -t 0 ]; then
    read ANSWER || ANSWER=""
  elif [ -t 1 ] && read ANSWER </dev/tty 2>/dev/null; then
    : # terminal available despite piped stdin (the curl|sh installer case)
  else
    die "ProcBoss needs a runtime selection.

Run pboss with one of:

  --runtime=node
  --runtime=bun
  --runtime=deno

(or run \`pboss\` in an interactive terminal once — the choice is saved to
~/.pboss/.runtime and never asked again)"
  fi
  ANSWER="$(normalize_runtime "$ANSWER")"
  case "$ANSWER" in
    "" | 1 | node) RUNTIME="node" ;;
    2 | bun) RUNTIME="bun" ;;
    3 | deno) RUNTIME="deno" ;;
    *)
      die "Unsupported runtime: $ANSWER

Supported runtimes:
  node
  bun
  deno"
      ;;
  esac
  # Persist the choice — plain text, one lowercase word (spec §6).
  mkdir -p "$PBOSS_HOME_DIR" 2>/dev/null || true
  printf '%s\n' "$RUNTIME" > "$RUNTIME_FILE" 2>/dev/null ||
    printf 'warning: could not save the runtime selection to %s\n' "$RUNTIME_FILE" >&2
fi

# ── 4. Dispatch to the runtime-specific entrypoint (spec §8/§9) ───────────
[ -n "$PKG_DIR" ] || die "pboss cannot locate its own package directory — reinstall pboss."

case "$RUNTIME" in
  node)
    CLI="$PKG_DIR/dist/cli.node.js"
    command -v node >/dev/null 2>&1 ||
      die "ProcBoss requires Node, but Node was not found.

Install Node (https://nodejs.org), or switch runtimes:
  pboss --runtime=bun   (or deno) for one invocation
  rm '$RUNTIME_FILE'    to choose again"
    [ -f "$CLI" ] || die "pboss install incomplete: $CLI is missing — reinstall pboss."
    exec node "$CLI" "$@"
    ;;
  bun)
    CLI="$PKG_DIR/dist/cli.bun.js"
    command -v bun >/dev/null 2>&1 ||
      die "ProcBoss requires Bun, but Bun was not found.

Install Bun (https://bun.sh), or switch runtimes:
  pboss --runtime=node  (or deno) for one invocation
  rm '$RUNTIME_FILE'    to choose again"
    [ -f "$CLI" ] || die "pboss install incomplete: $CLI is missing — reinstall pboss."
    exec bun --bun run "$CLI" "$@"
    ;;
  deno)
    CLI="$PKG_DIR/dist/cli.deno.js"
    command -v deno >/dev/null 2>&1 ||
      die "ProcBoss requires Deno, but Deno was not found.

Install Deno (https://deno.com), or switch runtimes:
  pboss --runtime=node  (or bun) for one invocation
  rm '$RUNTIME_FILE'    to choose again"
    [ -f "$CLI" ] || die "pboss install incomplete: $CLI is missing — reinstall pboss."
    exec deno run -A "$CLI" "$@"
    ;;
  *)
    # Unreachable: every path above validates. Kept for honesty.
    die "Invalid ProcBoss runtime: $RUNTIME"
    ;;
esac
