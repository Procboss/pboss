#!/usr/bin/env bash
# Simulate the systemd unit start sequence end-to-end (the user's incident):
#   ExecStart=pboss __daemon        (takes ~300ms to bind the socket)
#   ExecStartPost=pboss resurrect --wait 15   (fires essentially immediately)
# Both start CONCURRENTLY, like systemd does. Expect:
#   - resurrect exits 0
#   - exactly ONE daemon (the ExecStart one) — no competing spawn
#   - the daemon answers pings at the end
set -u
cd /home/z/my-project/pboss
RACE_HOME=$(mktemp -d /tmp/pboss-race-XXXXXX)
echo "RACE_HOME=$RACE_HOME"

# ExecStart — in background, like systemd forks it
PBOSS_HOME="$RACE_HOME" bun run src/index.ts __daemon \
  > "$RACE_HOME/start.out" 2> "$RACE_HOME/start.err" &
DAEMON_PID=$!

# ExecStartPost — immediately, no waiting for the daemon to be ready
PBOSS_HOME="$RACE_HOME" bun run src/index.ts resurrect --wait 15 \
  > "$RACE_HOME/post.out" 2> "$RACE_HOME/post.err"
POST_RC=$?

echo "ExecStartPost (resurrect --wait) exit: $POST_RC"
echo "--- ExecStart stdout ---"; cat "$RACE_HOME/start.out"
echo "--- ExecStartPost stderr ---"; cat "$RACE_HOME/post.err"
echo "--- ExecStartPost stdout (table) ---"; head -6 "$RACE_HOME/post.out"
echo "--- daemon pid file vs spawned pid ---"
cat "$RACE_HOME/daemon.pid" 2>/dev/null; echo "spawned: $DAEMON_PID"

# Probe the daemon (like waitForDaemon does)
PBOSS_HOME="$RACE_HOME" bun -e '
const { probeDaemon } = require("./src/daemon-probe.ts");
const live = await probeDaemon();
console.log("probe:", live ? `alive (pid ${live.pid})` : "DEAD");
'

# Exactly one daemon? (the ExecStart process itself, no extra spawns)
EXTRA=$(pgrep -f "index.ts __daemon" | grep -v "^$DAEMON_PID$" | wc -l)
echo "extra __daemon processes: $EXTRA"

# Teardown
kill -9 "$DAEMON_PID" 2>/dev/null
rm -rf "$RACE_HOME"
echo "RESULT: $([ "$POST_RC" = "0" ] && [ "$EXTRA" = "0" ] && echo PASS || echo FAIL)"
