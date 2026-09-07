#!/bin/sh
# Binary-level reproduction of the reported incident:
#   compiled pboss binary (IS_COMPILED=true) + daemon running with a
#   systemd-style minimal PATH + bun at ~/.bun/bin → `pboss start` must work.
set -e

ROOT=/tmp/pboss-bin-incident
rm -rf "$ROOT"
mkdir -p "$ROOT/fakehome/.bun/bin" "$ROOT/pbosshome" "$ROOT/work"

# Fake bun at the default user install location: records argv, exits 0.
printf '#!/bin/sh\necho "fake-bun $*" > "%s/worker-marker"\nexit 0\n' "$ROOT" > "$ROOT/fakehome/.bun/bin/bun"
chmod +x "$ROOT/fakehome/.bun/bin/bun"

printf '// placeholder\n' > "$ROOT/work/index.ts"

BIN=/home/z/my-project/pboss/dist/pboss

# 1. Daemon: exactly what the systemd unit runs — minimal PATH, HOME with
#    bun in ~/.bun/bin (invisible to that PATH), PBOSS_HOME pinned.
PATH="/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
HOME="$ROOT/fakehome" \
PBOSS_HOME="$ROOT/pbosshome" \
  "$BIN" __daemon > "$ROOT/daemon.out" 2> "$ROOT/daemon.err" &
DAEMON_PID=$!

# 2. Wait for the socket.
i=0
while [ ! -S "$ROOT/pbosshome/daemon.sock" ]; do
  i=$((i+1)); [ $i -gt 100 ] && { echo "FAIL: daemon socket never appeared"; cat "$ROOT/daemon.err"; exit 1; }
  sleep 0.1
done

# 3. The user's command. CLI env is irrelevant — the DAEMON resolves the
#    runtime for the worker.
PATH="/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
HOME="$ROOT/fakehome" \
PBOSS_HOME="$ROOT/pbosshome" \
  "$BIN" start "$ROOT/work/index.ts" --name incident-app > "$ROOT/start.out" 2> "$ROOT/start.err" || {
    echo "FAIL: pboss start exited non-zero:"; cat "$ROOT/start.err"; kill $DAEMON_PID; exit 1;
  }

if grep -q "the Bun runtime was not found" "$ROOT/start.out" "$ROOT/start.err" 2>/dev/null; then
  echo "FAIL: the incident reproduced (bun not found)"; cat "$ROOT/start.err"; kill $DAEMON_PID; exit 1
fi

# 4. Proof: the worker ran under the fake bun (marker with `run` + script).
i=0
while [ ! -f "$ROOT/worker-marker" ]; do
  i=$((i+1)); [ $i -gt 50 ] && { echo "FAIL: worker never spawned (no marker)"; cat "$ROOT/start.err"; kill $DAEMON_PID; exit 1; }
  sleep 0.1
done
echo "WORKER MARKER: $(cat "$ROOT/worker-marker")"

# 5. startup status reports the saved process (auto-save) read-only.
PATH="/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
HOME="$ROOT/fakehome" \
PBOSS_HOME="$ROOT/pbosshome" \
  "$BIN" startup status > "$ROOT/status.out" 2>&1
grep -q "1 saved process(es)" "$ROOT/status.out" && echo "STATUS: shows the saved process" || { echo "FAIL: status does not show the saved process:"; cat "$ROOT/status.out"; exit 1; }
grep -q "Daemon:     reachable" "$ROOT/status.out" && echo "STATUS: daemon reachable" || { echo "FAIL: daemon not reported reachable:"; cat "$ROOT/status.out"; exit 1; }
grep -q "Installed:  no" "$ROOT/status.out" && echo "STATUS: honest not-installed report" || { echo "FAIL: installed state wrong"; cat "$ROOT/status.out"; exit 1; }

kill $DAEMON_PID 2>/dev/null || true
sleep 0.3
echo "PASS: compiled-binary incident e2e green"
rm -rf "$ROOT"
