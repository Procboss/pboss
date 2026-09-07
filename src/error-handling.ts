/**
 * ProcBoss (pboss) — Bun Process Manager
 * Error-handling policy for best-effort operations.
 *
 * Repo rules (enforced by tests/error-handling.test.ts):
 *   1. Empty `catch {}` blocks are FORBIDDEN in src/ — every suppression
 *      must go through `ignore()` or `warn()` here so the failure is
 *      recorded (ring buffer) and, when it matters, printed.
 *   2. Suppressed failures are never lost: `recentSuppressed()` exposes the
 *      last 100 for tests and debugging; PBOSS_DEBUG=1 (or the daemon's
 *      --debug flag) prints them live to stderr.
 *
 * Why this exists: a systemd unit storm was undiagnosable because socket
 * cleanup, PID-file reads, and metric probes all swallowed their errors.
 * Best-effort is fine — silent is not.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

/** Exit code for "another daemon already owns the socket".
 *  systemd units set RestartPreventExitStatus=81 for this: retrying cannot
 *  help while the other daemon holds the socket, and restarting in a loop
 *  is what produced the "Start request repeated too quickly" storm. */
export const EXIT_DAEMON_CONFLICT = 81;

/** Thrown when the daemon cannot start because another live daemon owns
 *  the socket (PID attached for the message). */
export class DaemonConflictError extends Error {
  readonly existingPid: number | null;

  constructor(socketPath: string, existingPid: number | null) {
    super(
      existingPid !== null
        ? `another pboss daemon (pid ${existingPid}) is already listening on ${socketPath}`
        : `another pboss daemon is already listening on ${socketPath}`,
    );
    this.name = "DaemonConflictError";
    this.existingPid = existingPid;
  }
}

type Suppressed = {
  context: string;
  message: string;
  at: number;
  level: "ignored" | "warned";
};

const globalAny = globalThis as unknown as { __pbossSuppressed?: Suppressed[] };
const RING_LIMIT = 100;

function record(level: Suppressed["level"], context: string, err?: unknown): Suppressed {
  const entry: Suppressed = {
    level,
    context,
    message: err instanceof Error ? err.message : err !== undefined ? String(err) : "",
    at: Date.now(),
  };
  const ring = (globalAny.__pbossSuppressed ??= []);
  ring.push(entry);
  while (ring.length > RING_LIMIT) ring.shift();
  return entry;
}

function debugEnabled(): boolean {
  return !!process.env.PBOSS_DEBUG || process.argv.includes("--debug");
}

/**
 * Suppress a best-effort failure, recording it for later inspection.
 * Silent unless PBOSS_DEBUG=1 / --debug — for operations whose failure is
 * expected in normal operation (cleanup races, /proc reads of a process
 * that just exited, fallback probes).
 */
export function ignore(context: string, err?: unknown): void {
  const entry = record("ignored", context, err);
  if (debugEnabled()) {
    console.error(`[pboss:debug] ignored — ${context}${entry.message ? `: ${entry.message}` : ""}`);
  }
}

/**
 * Suppress a failure the operator should SEE (one stderr line, still
 * non-throwing) — for operations whose silent loss would hide a real
 * problem: unreadable config files, log rotation failures, watchers that
 * failed to start. Daemon stderr lands in ~/.pboss/daemon.err.log and in
 * `journalctl -u pboss`, which is exactly where it needed to be.
 */
export function warn(context: string, err?: unknown): void {
  const entry = record("warned", context, err);
  console.error(
    `[pboss] ${context}${entry.message ? ` failed: ${entry.message}` : " failed"}`,
  );
}

/** The last suppressed failures (tests, `pboss doctor`-style tooling). */
export function recentSuppressed(): Suppressed[] {
  return [...(globalAny.__pbossSuppressed ?? [])];
}
