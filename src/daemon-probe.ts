/**
 * ProcBoss (pboss) — JavaScript & TypeScript Process Manager
 * Shared daemon-socket probe.
 *
 * Answers one question: "is there a daemon LISTENING and answering pings
 * on the socket right now?" Used by:
 *   - daemon.ts   — refuse to start when another live daemon owns the socket
 *   - api.ts       — the daemon launcher's liveness waits
 *   - startup-manager.ts — the install/restart flows' stray-sweep
 *
 * Also home to the socket's two WAIT/STOP companions (moved here from
 * api.ts so startup-manager can use them without importing api — the
 * daemon launcher needed startup-manager's boot-service awareness, and the
 * old api ↔ startup-manager import had to break for it):
 *   - waitForDaemon()         — poll for a daemon someone ELSE is starting
 *   - stopDaemonIfRunning()   — ask a stray daemon to stand down
 *
 * None of the three ever spawns, throws, or keeps state — a pure probe plus
 * two idempotent asks. A responsive socket is the authoritative liveness
 * signal; PID files can lie (PID reuse after a reboot), so conflict
 * decisions are made on this, not on the PID file.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { DAEMON_SOCKET } from "./constants";
import { ignore } from "./error-handling";
import { getRuntime } from "./runtime";
const R = getRuntime();
export type DaemonProbe = {
  pid: number;
  uptime: number;
  /** The runtime executing the DAEMON (additive; absent from pre-1.7.0
   *  daemons — treat as unknown). */
  runtime?: "node" | "bun" | "deno";
  /** That runtime's own version string ("2.9.7", "v24.19.0"). */
  runtimeVersion?: string;
  /** The daemon's pboss version (additive). */
  version?: string;
  /** The entry module the daemon process runs (additive; issue #41) —
   *  daemon.ts / dist/cli.js / dist/cli.deno.js. Deno installs live in
   *  versioned directories, so an install that moved is visible here. */
  entry?: string;
  /** The runtime executable running the daemon (additive; issue #41) —
   *  nvm/Cellar-style versioned runtime installs show their move here. */
  exec?: string;
};

/**
 * Ping whatever is listening on the daemon socket (default DAEMON_SOCKET).
 * Returns its { pid, uptime } when a live daemon answers, null otherwise
 * (no socket file, stale file, connection refused, unresponsive listener).
 */
export async function probeDaemon(socketPath: string = DAEMON_SOCKET): Promise<DaemonProbe | null> {
  try {
    const res = await R.network.socketFetch("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ping", id: "daemon-probe" }),
    }, socketPath);
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: DaemonProbe };
    if (!body?.success || !body.data) return null;
    return body.data;
  } catch (err) {
    // Expected on every "nobody home" path — recorded, never thrown.
    ignore(`probe daemon socket ${socketPath}`, err);
    return null;
  }
}

/**
 * Wait for a daemon that someone ELSE is starting (a systemd unit's
 * ExecStart, a supervisor, the daemon launcher's service path). NEVER
 * spawns — `resurrect --wait` uses this so the CLI cannot race the unit's
 * daemon for the socket (the loser's EADDRINUSE exit code 1 was what sent
 * the unit into systemd's restart storm: "Start request repeated too
 * quickly").
 *
 * Returns true once a live daemon answers pings, false on timeout.
 */
export async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon()) return true;
    await R.misc.sleep(200);
  }
  return await probeDaemon() !== null;
}

/**
 * Ask a running daemon to shut down — used by `pboss startup install` before
 * the systemd unit takes over, by the launchd install path, and by the
 * daemon launcher's pre-spawn sweep, so a leftover detached daemon (spawned
 * by an earlier CLI command) cannot hold the socket the unit needs. Never
 * spawns. Returns true if a daemon was found and asked to stop.
 *
 * The socket defaults to the CLI's own PBOSS_HOME, but the unit's daemon
 * runs with its own home (per-user installs can point the unit at any
 * user's ~/.pboss) — callers pass that path explicitly so a stray there
 * is stopped too (otherwise the unit's daemon would hit EADDRINUSE and
 * exit 81).
 */
export async function stopDaemonIfRunning(
  timeoutMs: number = 15_000,
  socketPath: string = DAEMON_SOCKET,
): Promise<boolean> {
  const live = await probeDaemon(socketPath);
  if (!live) return false;

  try {
    await R.network.socketFetch("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "kill", id: "startup-stop" }),
    }, socketPath);
    // The daemon may exit before responding — that IS the success path.
  } catch (err) {
    ignore("stopDaemonIfRunning: send kill", err);
  }

  // Wait until it is actually gone so the unit's daemon can bind cleanly.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeDaemon(socketPath))) return true;
    await R.misc.sleep(200);
  }
  // Still alive after the grace period — leave it; the unit's daemon will
  // surface a clear DaemonConflictError (exit 81) instead of a restart loop.
  return true;
}
