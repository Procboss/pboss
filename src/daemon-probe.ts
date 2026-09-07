/**
 * ProcBoss (pboss) — Bun Process Manager
 * Shared daemon-socket probe.
 *
 * Answers one question: "is there a daemon LISTENING and answering pings
 * on the socket right now?" Used by:
 *   - daemon.ts   — refuse to start when another live daemon owns the socket
 *   - api.ts      — waitForDaemon() (resurrect --wait) and the startup
 *                   installer's stop-stray-daemon step
 *
 * Never spawns, never throws, no state — a pure probe. A responsive socket
 * is the authoritative liveness signal; PID files can lie (PID reuse after
 * a reboot), so conflict decisions are made on this, not on the PID file.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { DAEMON_SOCKET } from "./constants";
import { ignore } from "./error-handling";

export type DaemonProbe = { pid: number; uptime: number };

/**
 * Ping whatever is listening on the daemon socket (default DAEMON_SOCKET).
 * Returns its { pid, uptime } when a live daemon answers, null otherwise
 * (no socket file, stale file, connection refused, unresponsive listener).
 */
export async function probeDaemon(socketPath: string = DAEMON_SOCKET): Promise<DaemonProbe | null> {
  try {
    const res = await fetch("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ping", id: "daemon-probe" }),
      unix: socketPath,
    });
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
