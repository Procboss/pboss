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
#      an explicit per-invocation override. This flag belongs to THE
#      WRAPPER (owner spec, 2026-10-07): it exists so the bin script can
#      detect which runtime to use to call pboss, and it is consumed HERE —
#      validated, persisted when no selection exists yet, and STRIPPED from
#      the argv below. The JavaScript CLI never sees it. On a start the
#      wrapper also hands the value down via PBOSS_LAUNCHER_RUNTIME so the
#      daemon can PIN the process/ecosystem (issue #40 — the pin lives in
#      ~/.pboss/runtime-overrides and outlives restarts and reboots, while
#      .runtime keeps holding the untouched default).
#   2. ~/.pboss/runtime-overrides      a SAVED override for this invocation's
#      target (issue #40: `pboss restart my-api` where my-api was pinned to
#      bun, or `pboss restart ecosystem.config.ts` pinned to deno). The
#      launcher resolves the store BEFORE .runtime because it must know the
#      runtime before the JS entry runs. Store keys are process base names
#      and absolute ecosystem paths; a miss simply falls through.
#   3. ~/.pboss/.runtime               the persistent selection (written by
#      `pboss --runtime=<x>`, `pboss runtime change`, or the first-run
#      prompt below). PBOSS_HOME overrides the directory.
#   4. Interactive selection           first run only; Enter = Node. In a
#      non-interactive environment this is a hard error, never a guess.
#
# Dispatch lands on the runtime-specific entrypoint:
#
#   node → node  …/dist/cli.node.js      bun → bun  …/dist/cli.bun.js
#   deno → deno run -A …/dist/cli.deno.js
#
# (Deno's own global installs do not run this file — deno executes package
#  bins as modules, so its installer targets the published entry subpath:
#  `deno install -g -A --min-dep-age=0 --name pboss --reload
#  --force npm:pboss/deno-entry`.)
#
# Every other argument — spaces, quotes, empty strings, tabs, unicode, and
# everything after `--` — is forwarded VERBATIM via "$@" (the strip loop
# rebuilds the positional parameters only to drop the flag itself; each
# element stays byte-exact).

# ── 0. ProcBoss home (tests + portability: PBOSS_HOME overrides ~/.pboss) ──
PBOSS_HOME_DIR="${PBOSS_HOME:-$HOME/.pboss}"
RUNTIME_FILE="$PBOSS_HOME_DIR/.runtime"
OVERRIDES_FILE="$PBOSS_HOME_DIR/runtime-overrides"

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

# ── 2b. Strip the flag — the CLI never sees --runtime ────────────────────
# The flag is the WRAPPER's (owner spec, 2026-10-07): rebuild the positional
# parameters without it (and its value). `for ARG in "$@"` expands ONCE
# (POSIX), so the loop's snapshot survives the `set --` calls below, and
# `set -- "$@" "$ARG"` appends byte-exact — no re-quoting, no word
# splitting, empty strings intact. Everything from `--` onward is the
# command's own argv and is never touched (the sentinel itself is kept).
if [ -n "$RUNTIME_FLAG" ]; then
  STRIP_BEGUN=0
  SKIP_VALUE=0
  PAST_SENTINEL=0
  for ARG in "$@"; do
    if [ "$STRIP_BEGUN" = 0 ]; then
      set --
      STRIP_BEGUN=1
    fi
    if [ "$SKIP_VALUE" = 1 ]; then
      SKIP_VALUE=0
      continue
    fi
    if [ "$PAST_SENTINEL" = 1 ]; then
      set -- "$@" "$ARG"
      continue
    fi
    case "$ARG" in
      --runtime) SKIP_VALUE=1 ;;
      --runtime=*) ;;
      --) PAST_SENTINEL=1; set -- "$@" "$ARG" ;;
      *) set -- "$@" "$ARG" ;;
    esac
  done
fi

# normalize: trim + lowercase
normalize_runtime() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' \t\r\n'; }

# Display labels for the override notice ("Using Bun for this invocation.").
runtime_display() {
  case "$1" in
    node) printf '%s' "Node" ;;
    bun) printf '%s' "Bun" ;;
    deno) printf '%s' "Deno" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ── 2c. The saved-override target scan (issue #40) ──────────────────────
# The launcher must resolve runtime_overrides BEFORE .runtime — it cannot
# wait for the JS entry to decide. The candidate is the invocation's target:
# the first positional after the subcommand, or the value of --config (its
# sibling flag). A missed lookup is not an error — it just falls through to
# the .runtime default. The scan is a HINT, not a parser: a value-flag's
# value that matches a saved key (e.g. `pboss start --name api ./x.js`) is a
# legitimate resolution too, and anything that misses is inert.
find_launch_target() {
  SEEN_CMD=0
  EXPECT_CONFIG=0
  for ARG in "$@"; do
    case "$ARG" in
      --) return 0 ;; # everything after -- is the command's own argv
      --config) EXPECT_CONFIG=1; continue ;;
      --config=*) printf '%s\n' "${ARG#--config=}"; return 0 ;;
    esac
    if [ "$EXPECT_CONFIG" = 1 ]; then
      printf '%s\n' "$ARG"
      return 0
    fi
    case "$ARG" in
      -*) ;; # any other flag — skip it
      *)
        if [ "$SEEN_CMD" = 0 ]; then
          SEEN_CMD=1 # the subcommand (pboss restart …) — not a target
        else
          printf '%s\n' "$ARG"
          return 0
        fi
        ;;
    esac
  done
  return 0
}

# Absolutize a path-looking candidate so it matches the store's absolute
# ecosystem keys (the daemon pins the path loadEcosystemConfig resolved).
# A bare token is absolutized only when it names an existing FILE in the
# cwd — `pboss restart ecosystem.config.json` from the app's own directory
# is the common relative form, while a process NAME never collides with a
# file. Names and non-existent paths stay as typed. POSIX only: the
# cd/dirname/pwd trick — realpath is not guaranteed.
absolutize_candidate() {
  case "$1" in
    */*) ABS_DIR="$(dirname -- "$1")" || { printf '%s\n' "$1"; return 0; } ;;
    *)
      if [ -f "$1" ]; then
        ABS_DIR="."
      else
        printf '%s\n' "$1"
        return 0
      fi
      ;;
  esac
  ABS_BASE="$(basename -- "$1")" || { printf '%s\n' "$1"; return 0; }
  ABS_PWD="$(cd -- "$ABS_DIR" 2>/dev/null && pwd -P)" || { printf '%s\n' "$1"; return 0; }
  if [ "$ABS_PWD" = "/" ]; then
    printf '/%s\n' "$ABS_BASE"
  else
    printf '%s/%s\n' "$ABS_PWD" "$ABS_BASE"
  fi
}

# One store lookup: the value for KEY, or empty. awk string-equality — no
# regex, keys may hold any character except TAB (the separator). Corrupt
# lines cannot match; an invalid value cannot pass the caller's case test.
lookup_override() {
  [ -f "$OVERRIDES_FILE" ] || return 0
  awk -F'\t' -v k="$1" '
    $1 == k { print $2; exit }
  ' "$OVERRIDES_FILE" 2>/dev/null || true
}

# ── 2d. Resolve the saved override for this invocation's target ───────
# Issue #40: only when the flag was NOT supplied (the flag is the freshest,
# most explicit choice — it beats the store by definition). The candidate is
# tried as typed, then absolutized (ecosystem keys are absolute paths).
OVERRIDE_RUNTIME=""
LAUNCH_TARGET=""
if [ -z "$RUNTIME_FLAG" ]; then
  LAUNCH_TARGET="$(find_launch_target "$@")"
  if [ -n "$LAUNCH_TARGET" ]; then
    for CAND in "$LAUNCH_TARGET" "$(absolutize_candidate "$LAUNCH_TARGET")"; do
      VALUE="$(lookup_override "$CAND")"
      case "$(normalize_runtime "$VALUE")" in
        node | bun | deno)
          OVERRIDE_RUNTIME="$(normalize_runtime "$VALUE")"
          break
          ;;
      esac
    done
  fi
fi

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
  if [ -f "$RUNTIME_FILE" ]; then
    # A DIFFERENT valid selection is overridden for this invocation only:
    # say so and name the permanent switch — the file is never touched.
    CONFIGURED_RUNTIME="$(normalize_runtime "$(cat "$RUNTIME_FILE" 2>/dev/null)")"
    case "$CONFIGURED_RUNTIME" in
      node | bun | deno)
        if [ "$CONFIGURED_RUNTIME" != "$RUNTIME" ]; then
          printf 'Using %s for this invocation.\n\n' "$(runtime_display "$RUNTIME")"
          printf 'Configured runtime remains: %s\n\n' "$(runtime_display "$CONFIGURED_RUNTIME")"
          printf 'To permanently change the runtime:\n  pboss runtime change\n\n'
        fi
        ;;
    esac
  else
    # No selection yet — the flag initializes it (spec §16): plain text,
    # one lowercase word, the same discipline as the first-run prompt.
    mkdir -p "$PBOSS_HOME_DIR" 2>/dev/null || true
    printf '%s\n' "$RUNTIME" > "$RUNTIME_FILE" 2>/dev/null ||
      printf 'warning: could not save the runtime selection to %s\n' "$RUNTIME_FILE" >&2
  fi
  # Issue #40: hand the flag's value down to the CLI (the ONLY channel — the
  # JS level never parses --runtime). cmdStart reads it so a pinned start
  # (`pboss start --runtime=bun ./x.ts`) can persist the process/ecosystem
  # override; every other command ignores it. Not exported on the other
  # branches: an invocation without the flag must never look pinned.
  PBOSS_LAUNCHER_RUNTIME="$RUNTIME"
  export PBOSS_LAUNCHER_RUNTIME
elif [ -n "$OVERRIDE_RUNTIME" ]; then
  # ── 3b. A SAVED override for this invocation's target (issue #40) ───────
  # The launcher resolves runtime_overrides BEFORE .runtime: the runtime must
  # already be known when the JS entry point is launched. The store's entry —
  # never .runtime — decides; the default file is not even read here.
  RUNTIME="$OVERRIDE_RUNTIME"
  if [ -f "$RUNTIME_FILE" ]; then
    CONFIGURED_RUNTIME="$(normalize_runtime "$(cat "$RUNTIME_FILE" 2>/dev/null)")"
    case "$CONFIGURED_RUNTIME" in
      node | bun | deno)
        if [ "$CONFIGURED_RUNTIME" != "$RUNTIME" ]; then
          printf 'Using %s for "%s" (saved runtime override).\n\n' \
            "$(runtime_display "$RUNTIME")" "$LAUNCH_TARGET"
          printf 'Default runtime remains: %s\n\n' "$(runtime_display "$CONFIGURED_RUNTIME")"
        fi
        ;;
      *)
        printf 'Using %s for "%s" (saved runtime override).\n\n' \
          "$(runtime_display "$RUNTIME")" "$LAUNCH_TARGET"
        ;;
    esac
  else
    printf 'Using %s for "%s" (saved runtime override).\n\n' \
      "$(runtime_display "$RUNTIME")" "$LAUNCH_TARGET"
  fi
elif [ -f "$RUNTIME_FILE" ]; then
  # ── 3c. The persistent selection ────────────────────────────────────────
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
  # ── 3d. First run: interactive selection, Node on Enter (spec §2) ───────
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
    exec bun "$CLI" "$@"
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
