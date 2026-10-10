/**
 * ProcBoss (pboss) — the daemon lifecycle's pure half (issue #41).
 * https://procboss.com
 * License: GPL-3.0-only
 *
 * `pboss daemon start|stop|restart|status` and the post-upgrade daemon
 * realign share two decisions that must be testable without a daemon:
 *
 *   1. WHAT THE STATUS SAYS — composeDaemonStatus turns a probe (the
 *      daemon's identity: pid, pboss version, runtime, entry module) plus
 *      the CLI's own facts (installed version, executing runtime, the
 *      entry a daemon started NOW would run, the installed boot service)
 *      into the report `pboss daemon status` prints. The issue's contract:
 *      a daemon that no longer matches the installation says so and names
 *      the exact fix — `pboss daemon restart`.
 *
 *   2. WHAT THE UPGRADE DOES AFTERWARDS — realignDaemonAfterUpgrade stops
 *      the old-code daemon and brings a new-code one up THROUGH the
 *      installed boot service when there is one (`pboss startup install`
 *      regenerates the unit from the new install and restarts it — the
 *      daemon and the service never disagree), or through the new pboss
 *      itself (`pboss resurrect`) when there is none. Dependency-injected
 *      so every branch is unit-testable without upgrading anything.
 *
 * The impure halves (spawning, systemctl, sockets) live in index.ts /
 * startup-manager.ts; they only WIRE these decisions to the machine.
 */

import { fileURLToPath } from "node:url";
import type { DaemonProbe } from "./daemon-probe.ts";
import type { BootServiceKind } from "./startup-manager.ts";
import { bootServiceLabel } from "./startup-manager.ts";
import { compareVersions } from "./upgrade.ts";
import { formatUptime } from "./utils.ts";
import { runtimeLabel, type RuntimeChoice } from "./runtime-config.ts";

/* ── the entry a daemon would run (install-drift detection) ─────────────── */

/**
 * Pick the entry module out of a daemonSpawnCommand() argv: the LAST
 * argument that looks like a JS/TS file. Compiled binaries
 * ([<pboss>, "__daemon"]) have none — null, and the comparison is skipped
 * (the version check carries those installs).
 */
export function daemonEntryArg(cmd: readonly string[]): string | null {
  for (let i = cmd.length - 1; i >= 0; i--) {
    const arg = cmd[i];
    if (arg !== undefined && /\.(?:mjs|cjs|js|ts|tsx|jsx)$/.test(arg)) return arg;
  }
  return null;
}

/**
 * Compare two entry paths for identity. null when either side is unknown
 * — "cannot tell" never reports drift. file:// URLs (Deno's mainModule
 * raw form) are normalized to paths first.
 */
export function sameEntry(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean | null {
  if (!a || !b) return null;
  const norm = (p: string): string => {
    try {
      return fileURLToPath(p);
    } catch {
      return p;
    }
  };
  return norm(a) === norm(b);
}

/* ── `pboss daemon status` — the report ─────────────────────────────────── */

/** Everything composeDaemonStatus needs, gathered by the caller. */
export interface DaemonFacts {
  /** The live daemon's probe — null when nothing answers the socket. */
  live: DaemonProbe | null;
  /** This CLI's pboss version — the "installed" side of the comparison. */
  installedVersion: string;
  /** The runtime executing this CLI + its version (runtime-drift signals). */
  currentRuntime: string;
  currentRuntimeVersion: string;
  /** The entry module a daemon started NOW would run (daemonSpawnCommand
   *  through daemonEntryArg) — null when unknowable (compiled binary). */
  expectedEntry: string | null;
  /** The boot service installed on this machine. */
  serviceKind: BootServiceKind;
}

export interface DaemonStatusReport {
  /** "stopped" when nothing answers; "outdated" when a live daemon no
   *  longer matches the installed pboss; else "running". */
  status: "running" | "outdated" | "stopped";
  /** The lines to print, in order, plain text (no ANSI). */
  lines: string[];
  /** `pboss daemon status` exit code: 0 when a daemon answers, 1 when not. */
  exitCode: number;
}

/**
 * Compose the `pboss daemon status` report (issue #41 §1/§4/§5): the
 * daemon's PID, pboss version, runtime and uptime next to the installed
 * version — and, whenever the running daemon no longer matches what is
 * installed (older pboss, upgraded runtime, replaced install), the exact
 * command that fixes it. Pre-1.7.0 daemons answer without identity fields
 * (they are additive) — the report says so and names the same fix.
 */
export function composeDaemonStatus(f: DaemonFacts): DaemonStatusReport {
  const service = bootServiceLabel(f.serviceKind);

  if (!f.live) {
    return {
      status: "stopped",
      lines: [
        `Daemon:    stopped`,
        `Service:   ${service}`,
        ``,
        `Start it:  pboss daemon start`,
      ],
      exitCode: 1,
    };
  }

  const pre1700 = f.live.version === undefined;
  const daemonEngine = f.live.runtime
    ? `${runtimeLabel(f.live.runtime as RuntimeChoice)} ${f.live.runtimeVersion ?? ""}`.trim()
    : null;
  const outdated =
    !!f.live.version && compareVersions(f.live.version, f.installedVersion) < 0;

  const lines = [
    `Daemon:    running`,
    `PID:       ${f.live.pid}`,
    `Up:        ${formatUptime(f.live.uptime * 1000)}`,
    `pboss:     ${f.live.version ?? "unknown (pre-1.7.0 daemon)"}`,
    `Runtime:   ${daemonEngine ?? "unknown (pre-1.7.0 daemon)"}`,
    `Service:   ${service}`,
    `Installed: ${f.installedVersion} (${runtimeLabel(f.currentRuntime as RuntimeChoice)} ${f.currentRuntimeVersion})`,
    `Status:    ${outdated ? "outdated" : "running"}`,
  ];

  if (outdated) {
    lines.push(
      ``,
      `A newer pboss version is installed (the daemon runs v${f.live.version}).`,
      `Run \`pboss daemon restart\` to apply the update.`,
    );
  } else if (pre1700) {
    lines.push(
      ``,
      `An older daemon — it cannot report its version or engine, so drift stays invisible.`,
      `Bring it current (running apps stop and come back):`,
      `  pboss daemon restart`,
    );
  } else if (f.live.version !== f.installedVersion) {
    // Newer than the CLI: restarting cannot help — the CLI is the old half.
    lines.push(
      ``,
      `The daemon runs a newer pboss (v${f.live.version}) than this CLI (v${f.installedVersion}).`,
      `Update this CLI (\`pboss upgrade\`); restarting the daemon will not change it.`,
    );
  }

  // The daemon's runtime no longer matches the one executing pboss (the
  // original owner report: a leftover Node daemon imposing node on Deno
  // machines) — or the same runtime was upgraded underneath it (a `bun
  // upgrade` while the daemon kept running the old binary).
  if (!pre1700 && f.live.runtime && f.live.runtime !== f.currentRuntime) {
    lines.push(
      ``,
      `The daemon executes under ${runtimeLabel(f.live.runtime as RuntimeChoice)}, but this pboss is ${runtimeLabel(f.currentRuntime as RuntimeChoice)} —`,
      `realign it (running apps stop and come back):`,
      `  pboss daemon restart`,
    );
  } else if (
    !pre1700 &&
    f.live.runtime === f.currentRuntime &&
    f.live.runtimeVersion &&
    f.live.runtimeVersion !== f.currentRuntimeVersion
  ) {
    lines.push(
      ``,
      `The ${runtimeLabel(f.currentRuntime as RuntimeChoice)} runtime was upgraded (daemon runs ${f.live.runtimeVersion}, this pboss runs ${f.currentRuntimeVersion}).`,
      `Run \`pboss daemon restart\` to run it on the current runtime.`,
    );
  }

  // The install moved underneath the daemon (deno's versioned install
  // dirs, a replaced checkout) — version numbers alone cannot see it.
  const entryMatch = sameEntry(f.live.entry, f.expectedEntry);
  if (entryMatch === false) {
    lines.push(
      ``,
      `The daemon runs from a different pboss install:`,
      `  daemon:  ${f.live.entry}`,
      `  current: ${f.expectedEntry}`,
      `Run \`pboss daemon restart\` to switch it to this install.`,
    );
  }

  return { status: outdated ? "outdated" : "running", lines, exitCode: 0 };
}

/* ── the post-upgrade realign (issue #41 §2/§3) ─────────────────────────── */

/** The injectable machine half of realignDaemonAfterUpgrade. */
export interface RealignDeps {
  /** Pure probe of the daemon socket (never spawns). */
  probe(): Promise<DaemonProbe | null>;
  /** Graceful stop of a live daemon (stops its apps, cleans its files). */
  killDaemon(): Promise<void>;
  /** The installed boot mechanism. */
  serviceKind(): Promise<BootServiceKind>;
  /**
   * Run a pboss subcommand through the NEW install (the PATH-resolved
   * pboss). Null = it could not be run at all.
   */
  runPboss(args: string[]): Promise<number | null>;
  /** Wait until a daemon answers, bounded by ms. */
  waitForDaemon(ms: number): Promise<boolean>;
  /** Progress line ("Restarting the daemon onto the new code…"). */
  log(line: string): void;
  /** How long to wait for the new daemon (default 30s — a deno install's
   * first run after the upgrade compiles the whole entry bundle before the
   * daemon can answer; 18.5s observed on the owner's machine). */
  verifyMs?: number;
}

export interface RealignOutcome {
  /** The daemon answering at the end (null = none). */
  live: DaemonProbe | null;
  /** Which path brought the daemon up. */
  via: "service" | "manual" | "none";
  /** Honest one-liner for the upgrade report ("" = nothing to report). */
  note: string;
}

/**
 * Stop the old-code daemon and bring a new-code one up — the step that
 * makes `pboss upgrade` whole (issue #41 §3: "a pboss upgrade should
 * never leave users unknowingly running an old daemon").
 *
 *   boot service installed  →  `<new pboss> startup install`: regenerates
 *                              the unit from the NEW install (ExecStart
 *                              paths follow the package — deno's versioned
 *                              dirs, brew's Cellar) and restarts the
 *                              daemon through the manager, so daemon and
 *                              service never disagree (§2).
 *   no boot service         →  `<new pboss> resurrect`: spawns the daemon
 *                              from the new install and restores the
 *                              saved process list.
 *
 * Both paths run the NEW pboss (never this upgrading process — its spawn
 * command still points at the replaced install), and both stop the old
 * daemon FIRST: a graceful kill RPC (apps stop cleanly, files cleaned)
 * before any manager command, so no SIGTERM ever orphans a worker.
 */
export async function realignDaemonAfterUpgrade(deps: RealignDeps): Promise<RealignOutcome> {
  const verifyMs = deps.verifyMs ?? 30_000;

  const before = await deps.probe();
  if (before) {
    deps.log("Stopping the old daemon…");
    await deps.killDaemon();
  }

  const kind = await deps.serviceKind();
  const viaService = kind === "systemd" || kind === "launchd" || kind === "task";
  const args = viaService ? ["startup", "install"] : ["resurrect"];
  const code = await deps.runPboss(args);

  if (code === null) {
    return {
      live: await deps.probe(),
      via: "none",
      note: "could not run the new pboss — start the daemon with: pboss resurrect",
    };
  }
  if (code !== 0) {
    return {
      live: await deps.probe(),
      via: "none",
      note: `the new pboss exited ${code} — start the daemon with: pboss resurrect`,
    };
  }

  const up = await deps.waitForDaemon(verifyMs);
  const live = await deps.probe();
  if (up && live) {
    return {
      live,
      via: viaService ? "service" : "manual",
      note: "",
    };
  }
  return {
    live: null,
    via: viaService ? "service" : "manual",
    note: "the daemon has not come back yet — check: pboss daemon status",
  };
}
