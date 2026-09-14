/**
 * ProcBoss (pboss) — Bun Process Manager
 *
 * Issue #32: the real internal event system.
 *
 * Before this file existed, "events" in pboss were a client-side illusion:
 * `PBoss` (src/api.ts) emitted `process:*` events synchronously right after
 * its OWN request resolved — so only the caller ever heard them, and
 * autonomous daemon behavior (crash autorestarts, maxMemoryRestart, watch,
 * cron, health-check restarts) was invisible to everyone.
 *
 * Now the canonical source of truth is the `ProcessManager` itself: it
 * extends EventEmitter, every ProcessContainer state transition is funneled
 * through it (via the `onProcessEvent` hook wired by `attach()`), modules
 * receive real events through the same `pm` they get in `init(pm)`, and
 * remote clients receive them over the daemon's existing SSE stream
 * mechanism (the `subscribeEvents` stream — same transport as `streamLogs`).
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */
import type { ProcessState } from "./types";

/**
 * WHY something happened — attached to every event so consumers can tell
 * apart operator actions from the supervisor's own autonomous behavior.
 *
 * - `user`    — an API/CLI/cloud command (start, stop, restart, delete, scale)
 * - `crash`   — the process exited on its own (any non-deliberate exit;
 *               check `exitCode` — 0 means a clean self-exit)
 * - `memory`  — maxMemoryRestart tripped
 * - `watch`   — a watched file changed
 * - `cron`    — the cronRestart schedule fired
 * - `health`  — the health check failed `maxFails` times
 * - `policy`  — the issue-#31 onNsMemberExit:exit policy stopped a sibling
 * - `system`  — boot-time resurrect (dump restore)
 */
export type ProcessEventSource =
  | "user"
  | "crash"
  | "memory"
  | "watch"
  | "cron"
  | "health"
  | "policy"
  | "system";

/**
 * WHAT happened — the event names double as EventEmitter keys on
 * `ProcessManager` and (after transport) on the `PBoss` client.
 *
 * - `process:start`   — a start/resume/resurrect actually brought the
 *                       process online (not a restart's second phase)
 * - `process:stop`    — pboss deliberately stopped it (user op or policy)
 * - `process:restart` — the process is BACK ONLINE following a restart —
 *                       manual or autonomous (see `source`)
 * - `process:crashed` — the process exited on its own; NOT a pboss stop.
 *                       `exitCode`/`exitSignal` carry the raw exit facts and
 *                       `willRestart` says whether a restart was scheduled
 * - `process:errored` — terminal: start failed or the unstable-restart
 *                       budget was exhausted (supervision gave up)
 * - `process:delete`  — removed from pboss's list
 * - `process:reload`  — a graceful reload completed
 */
export type ProcessEventKind =
  | "process:start"
  | "process:stop"
  | "process:restart"
  | "process:crashed"
  | "process:errored"
  | "process:delete"
  | "process:reload";

/**
 * The single event payload shape used across the whole pipeline — module
 * listeners, the daemon's SSE `subscribeEvents` stream, and the `PBoss`
 * client's re-emitted events all see this exact object.
 *
 * One event = one process. Group operations (stop namespace, restart all,
 * scale) surface as one event per affected process, each with a fresh
 * `process` state snapshot taken at emit time.
 */
export interface PbossProcessEvent {
  /** Event name — always identical to the key the listener registered on. */
  event: ProcessEventKind;
  /** What caused it (see ProcessEventSource). */
  source: ProcessEventSource;
  /** Epoch milliseconds at emit time. */
  at: number;
  /** State snapshot of the affected process at emit time. */
  process: ProcessState;
  /** process:crashed — raw exit code (null when killed by signal). */
  exitCode?: number | null;
  /** process:crashed — signal name, when the process was signaled to death. */
  exitSignal?: string | null;
  /** process:crashed — was an autorestart scheduled for it? */
  willRestart?: boolean;
  /** Human-readable detail (e.g. the health-check failure reason). */
  reason?: string;
}

/** Every event kind the ProcessManager can emit. */
export const PROCESS_EVENT_KINDS: readonly ProcessEventKind[] = [
  "process:start",
  "process:stop",
  "process:restart",
  "process:crashed",
  "process:errored",
  "process:delete",
  "process:reload",
];

/**
 * Typed event map for `ProcessManager extends EventEmitter<…>` (the same
 * Node EventEmitter generic pattern `PBoss` already uses in src/api.ts).
 */
export interface ProcessManagerEventMap {
  "process:start": [event: PbossProcessEvent];
  "process:stop": [event: PbossProcessEvent];
  "process:restart": [event: PbossProcessEvent];
  "process:crashed": [event: PbossProcessEvent];
  "process:errored": [event: PbossProcessEvent];
  "process:delete": [event: PbossProcessEvent];
  "process:reload": [event: PbossProcessEvent];
}
