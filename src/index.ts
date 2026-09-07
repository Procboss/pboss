#!/usr/bin/env bun
/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import path, { resolve, extname } from "path";
import {
  APP_NAME,
  VERSION,
  DAEMON_SOCKET,
  DASHBOARD_PORT,
  METRICS_PORT,
} from "./constants";
import { ensureDirs, formatBytes, formatUptime, colorize, padRight, dumpEntryCount } from "./utils";
import { PBoss, loadEcosystemConfig, waitForDaemon } from "./api";
import { DeployManager } from "./deploy";
import {
  StartupManager,
  bootServiceInstalled,
  persistenceHintLine,
} from "./startup-manager";
import { EnvManager } from "./env-manager";
import { DaemonConflictError, EXIT_DAEMON_CONFLICT, ignore } from "./error-handling";
import type {
  StartOptions,
  ProcessState,
  LogItem,
  CronJob,
} from "./types";
import { statusColor } from "./colors";
import { liveWatchProcess, printProcessTable, printCronTable } from "./process-table";
import Daemon from "./daemon";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// PBossCLI class — Delegates all process engine operations to PBoss API
// ---------------------------------------------------------------------------

/** Parse a `--wait <sec>` / `--wait=<sec>` flag. Returns the seconds (default
 *  30 when the flag is bare) or null when the flag is absent. */
function parseWaitFlag(args: string[]): number | null {
  const i = args.indexOf("--wait");
  if (i !== -1) {
    const next = args[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) return parseInt(next, 10);
    return 30;
  }
  const eq = args.find((a) => a.startsWith("--wait="));
  if (eq) {
    const v = parseInt(eq.slice("--wait=".length), 10);
    return Number.isFinite(v) && v > 0 ? v : 30;
  }
  return null;
}

class PBossCLI {
  public pboss: PBoss;
  public noDaemon: boolean = false;

  constructor(noDaemon: boolean = false) {
    this.noDaemon = noDaemon;
    this.pboss = new PBoss({ noDaemon });
  }

  // -------------------------------------------------------------------------
  // CLI flag parser
  //
  // Flags may appear in ANY order relative to the script path, e.g.:
  //   pboss start app.ts --no-daemon --name api
  //   pboss start --no-daemon app.ts --name api
  //   pboss start --name api --no-daemon app.ts
  // -------------------------------------------------------------------------

  parseStartFlags(args: string[]): StartOptions {
    const opts: StartOptions = { script: "" };
    let i = 0;
    let scriptResolved = false;
    const positionalArgs: string[] = [];

    while (i < args.length) {
      const arg = args[i]!;

      // End-of-flags sentinel — everything after is passed to the script
      if (arg === "--") {
        positionalArgs.push(...args.slice(i + 1));
        break;
      }

      switch (arg) {
        case "--name":
        case "-n":
          opts.name = args[++i];
          break;
        case "--instances":
        case "-i":
          opts.instances = parseInt(args[++i]!) || 1;
          break;
        case "--cwd":
          opts.cwd = args[++i];
          break;
        case "--interpreter":
          opts.interpreter = args[++i];
          break;
        case "--interpreter-args":
          opts.interpreterArgs = args[++i]!.split(" ");
          break;
        case "--node-args":
          opts.nodeArgs = args[++i]!.split(" ");
          break;
        case "--watch":
        case "-w":
          opts.watch = true;
          break;
        case "--watch-path":
          if (!Array.isArray(opts.watch)) opts.watch = [];
          (opts.watch as string[]).push(args[++i]!);
          break;
        case "--ignore-watch":
          opts.ignoreWatch = args[++i]!.split(",");
          break;
        case "--exec-mode":
        case "-x":
          opts.execMode = args[++i] as "fork" | "cluster";
          break;
        case "--max-memory-restart":
          opts.maxMemoryRestart = args[++i];
          break;
        case "--max-restarts":
          opts.maxRestarts = parseInt(args[++i]!);
          break;
        case "--min-uptime":
          opts.minUptime = parseInt(args[++i]!);
          break;
        case "--kill-timeout":
          opts.killTimeout = parseInt(args[++i]!);
          break;
        case "--restart-delay":
          opts.restartDelay = parseInt(args[++i]!);
          break;
        case "--cron":
        case "--cron-restart":
          opts.cron = args[++i];
          break;
        case "--no-autorestart":
          opts.autorestart = false;
          break;
        case "--env": {
          const envPair = args[++i]!;
          const eqIdx = envPair.indexOf("=");
          if (eqIdx !== -1) {
            if (!opts.env) opts.env = {};
            opts.env[envPair.substring(0, eqIdx)] = envPair.substring(eqIdx + 1);
          }
          break;
        }
        case "--log":
        case "--output":
        case "-o":
          opts.outFile = args[++i];
          break;
        case "--error":
        case "-e":
          opts.errorFile = args[++i];
          break;
        case "--merge-logs":
          opts.mergeLogs = true;
          break;
        case "--raw":
          opts.raw = true;
          break;
        case "--log-date-format":
          opts.logDateFormat = args[++i];
          break;
        case "--log-max-size":
          opts.logMaxSize = args[++i];
          break;
        case "--log-retain":
          opts.logRetain = parseInt(args[++i]!);
          break;
        case "--log-compress":
          opts.logCompress = true;
          break;
        case "--port":
        case "-p":
          opts.port = parseInt(args[++i]!);
          break;
        case "--health-check-url":
          opts.healthCheckUrl = args[++i];
          break;
        case "--health-check-interval":
          opts.healthCheckInterval = parseInt(args[++i]!);
          break;
        case "--health-check-timeout":
          opts.healthCheckTimeout = parseInt(args[++i]!);
          break;
        case "--health-check-max-fails":
          opts.healthCheckMaxFails = parseInt(args[++i]!);
          break;
        case "--wait-ready":
          opts.waitReady = true;
          break;
        case "--listen-timeout":
          opts.listenTimeout = parseInt(args[++i]!);
          break;
        case "--namespace":
          opts.namespace = args[++i];
          break;
        case "--source-map-support":
          opts.sourceMapSupport = true;
          break;
        default:
          if (arg.startsWith("-")) {
            console.warn(colorize(`[pboss] Unknown flag ignored: ${arg}`, "dim"));
          } else {
            if (!scriptResolved) {
              opts.script = arg;
              scriptResolved = true;
            } else {
              positionalArgs.push(arg);
            }
          }
          break;
      }

      i++;
    }

    if (positionalArgs.length > 0) opts.args = positionalArgs;
    return opts;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async cmdStart(args: string[]) {
    if (args.length === 0) {
      console.error(colorize("Usage: pboss start <script|config> [options]", "red"));
      process.exit(1);
    }

    const firstPositional = args.find((a) => !a.startsWith("-"));
    if (!firstPositional) {
      console.error(colorize("Usage: pboss start <script|config> [options]", "red"));
      process.exit(1);
    }

    const ext = extname(firstPositional);
    // Read BEFORE the start: an empty dump means this is the fleet's first
    // process — the one moment the persistence onboarding hint matters.
    const wasEmptyFleet = dumpEntryCount() === 0;

    try {
      if (
        ext === ".json" ||
        firstPositional.includes("ecosystem") ||
        firstPositional.includes("pboss.config") ||
        firstPositional.includes("bm2.config") ||
        firstPositional.includes("pm2.config")
      ) {
        const config = await loadEcosystemConfig(firstPositional);
        const raw = args.includes("--raw");
        if (raw) {
          config.apps = config.apps.map((app) => ({ ...app, raw: true }));
        }
        if (config.noDaemon && !this.noDaemon) {
          this.noDaemon = true;
          this.pboss = new PBoss({ noDaemon: true });
        }

        const states = await this.pboss.startEcosystem(config);
        if (!raw && !config.apps.some((app) => app.raw)) {
          printProcessTable(states);
        }
        await this.maybePersistenceHint(raw, wasEmptyFleet);

        if (this.noDaemon) {
          await new Promise(() => {});
        }
      } else {
        const opts = this.parseStartFlags(args);
        if (!opts.script) {
          console.error(colorize("Error: no script specified", "red"));
          process.exit(1);
        }

        opts.script = resolve(opts.script);
        if (!opts.cwd) opts.cwd = path.dirname(opts.script);

        const states = await this.pboss.start(opts);
        if (!opts.raw) {
          printProcessTable(states);
        }
        await this.maybePersistenceHint(opts.raw === true, wasEmptyFleet);

        if (this.noDaemon) {
          await new Promise(() => {});
        }
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  /**
   * After a successful start that took the fleet from empty to non-empty,
   * state where reboot persistence stands — once, in one line, only on a
   * TTY (piped/scripted output stays clean for parsers).
   *
   * PM2's biggest usability trap is that persistence is opt-in and silent
   * (`pm2 startup` + `pm2 save`, discovered the hard way after a reboot).
   * pboss persists by default; this hint just says so out loud — and when
   * the boot service is missing (e.g. a manual binary copy without the
   * installer), it hands the user the one command that fixes it.
   */
  private async maybePersistenceHint(raw: boolean, wasEmptyFleet: boolean) {
    if (raw || !wasEmptyFleet || !process.stdout.isTTY) return;
    try {
      const presence = await bootServiceInstalled();
      const line = persistenceHintLine(presence);
      console.log("");
      console.log(colorize(line, presence.installed ? "green" : "yellow"));
    } catch (err) {
      // The hint is cosmetic — never let it break a successful start.
      ignore("persistence onboarding hint", err);
    }
  }

  async cmdStop(args: string[]) {
    const target = args[0] || "all";
    try {
      const states = await this.pboss.stop(target);
      printProcessTable(states);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdRestart(args: string[]) {
    const target = args[0] || "all";
    try {
      const states = await this.pboss.restart(target);
      printProcessTable(states);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdReload(args: string[]) {
    const target = args[0] || "all";
    try {
      const states = await this.pboss.reload(target);
      printProcessTable(states);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdDelete(args: string[]) {
    const target = args[0] || "all";
    try {
      const states = await this.pboss.delete(target);
      console.log(colorize("✓ Deleted", "green"));
      printProcessTable(states);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdList(args: string[]) {
    try {
      const states = await this.pboss.list();
      const liveMode = args.includes("--live");
      if (liveMode) {
        liveWatchProcess(states);
      } else {
        printProcessTable(states);
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdDescribe(args: string[]) {
    const target = args[0];
    if (!target) {
      console.error(colorize("Usage: pboss describe <id|name>", "red"));
      process.exit(1);
    }

    try {
      const processes: ProcessState[] = await this.pboss.describe(target);
      for (const p of processes) {
        const env = p.pboss_env || p.bm2_env;
        console.log(colorize(`\n─── ${p.name} (id: ${p.pm_id}) ───`, "bold"));
        console.log(`  Status       : ${colorize(p.status, statusColor(p.status))}`);
        console.log(`  PID          : ${p.pid || "N/A"}`);
        console.log(`  Exec mode    : ${env?.execMode ?? "fork"}`);
        console.log(`  Instances    : ${env?.instances ?? 1}`);
        console.log(`  Namespace    : ${p.namespace || "default"}`);
        console.log(`  Script       : ${env?.script ?? "-"}`);
        console.log(`  CWD          : ${env?.cwd ?? "-"}`);
        console.log(`  Args         : ${env?.args?.join(" ") || "(none)"}`);
        console.log(`  Interpreter  : ${env?.interpreter || "bun"}`);
        console.log(`  Restarts     : ${env?.restart_time ?? 0}`);
        console.log(`  Unstable     : ${env?.unstable_restarts ?? 0}`);
        console.log(
          `  Uptime       : ${
            (p.status === "online" && env?.pm_uptime) ? formatUptime(Date.now() - env.pm_uptime) : "N/A"
          }`
        );
        console.log(`  Created at   : ${env?.created_at ? new Date(env.created_at).toISOString() : "N/A"}`);
        console.log(`  CPU          : ${p.monit.cpu.toFixed(1)}%`);
        console.log(`  Memory       : ${formatBytes(p.monit.memory)}`);
        if (p.monit.handles !== undefined) console.log(`  Handles      : ${p.monit.handles}`);
        if (p.monit.eventLoopLatency !== undefined)
          console.log(`  EL Latency   : ${p.monit.eventLoopLatency.toFixed(2)} ms`);
        console.log(`  Watch        : ${env?.watch}`);
        console.log(`  Autorestart  : ${env?.autorestart}`);
        console.log(`  Max restarts : ${env?.maxRestarts}`);
        console.log(`  Kill timeout : ${env?.killTimeout} ms`);
        if (env?.healthCheckUrl) console.log(`  Health URL   : ${env.healthCheckUrl}`);
        if (env?.cronRestart) console.log(`  Cron restart : ${env.cronRestart}`);
        if (env?.port) console.log(`  Port         : ${env.port}`);
        console.log();
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdLogs(args: string[]) {
    let target: string | number = "all";
    let lines = 20;
    let follow = false;
    let i = 0;

    while (i < args.length) {
      const arg = args[i]!;
      if ((arg === "--lines" || arg === "-l") && !Number.isNaN(Number(args[i + 1]))) {
        lines = parseInt(args[i + 1]!);
        i++;
      } else if (arg.startsWith("--lines=")) {
        lines = parseInt(arg.split("=")[1]!);
      } else if (arg === "--follow" || arg === "-f") {
        follow = true;
      } else if (!arg.startsWith("-")) {
        target = arg;
      }
      i++;
    }

    const renderLog = (log: LogItem) => {
      let line;
      if (log.level === "err") {
        line = chalk.red(`[ERROR] ${log.name} | ${log.ts}: ${log.msg}\n`);
      } else {
        line = chalk.white(`${chalk.cyan(`[OUTPUT] ${log.name} | ${log.ts}`)}: ${log.msg}\n`);
      }
      console.log(line);
    };

    try {
      if (follow) {
        await this.pboss.streamLogs(target, (log) => {
          if (log) renderLog(log);
        });
      } else {
        const logs = await this.pboss.logs(target, lines);
        for (const log of logs) {
          renderLog(log);
        }
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdFlush(args: string[]) {
    try {
      await this.pboss.flush(args[0]);
      console.log(colorize("✓ Logs flushed", "green"));
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdScale(args: string[]) {
    const target = args[0];
    const count = parseInt(args[1]!);
    if (!target || isNaN(count)) {
      console.error(colorize("Usage: pboss scale <name|id> <count>", "red"));
      process.exit(1);
    }

    try {
      const states = await this.pboss.scale(target, count);
      printProcessTable(states);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdSave() {
    try {
      await this.pboss.save();
      console.log(
        colorize("✓ Process list saved", "green") +
          colorize("  (saved automatically after every change — this is just a manual re-save)", "gray"),
      );
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdResurrect(args: string[]) {
    // `--wait <sec>` (or `--wait=<sec>`, default 30): poll for a daemon that
    // someone ELSE is starting (systemd's ExecStart=pboss __daemon). NEVER
    // spawns one — the spawned daemon would race the unit's daemon for the
    // socket and the loser's EADDRINUSE exit was what restarted the unit in
    // a loop ("Start request repeated too quickly").
    //
    // --wait mode is also BEST-EFFORT by contract: its only caller is the
    // systemd unit's ExecStartPost, and a FAILED ExecStartPost aborts the
    // unit's whole start transaction — systemd kills the (healthy)
    // ExecStart daemon and restart-loops it. Unit health is ExecStart's
    // responsibility; a timeout or RPC hiccup must be reported (stderr =
    // the journal) and exit 0. The unit file additionally prefixes
    // ExecStartPost with '-' for the same guarantee.
    const waitSec = parseWaitFlag(args);
    if (waitSec !== null) {
      if (!(await waitForDaemon(waitSec * 1000))) {
        console.error(
          colorize(
            `⚠ daemon not ready within ${waitSec}s — resurrect skipped (best-effort)`,
            "yellow",
          ),
        );
        process.exit(0);
      }
    }
    try {
      const states = await this.pboss.resurrect();
      printProcessTable(states);
    } catch (err: any) {
      if (waitSec !== null) {
        console.error(
          colorize(`⚠ resurrect failed (best-effort): ${err?.message ?? err}`, "yellow"),
        );
        process.exit(0);
      }
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdSignal(args: string[]) {
    const signal = args[0];
    const target = args[1];
    if (!signal || !target) {
      console.error(colorize("Usage: pboss sendSignal <signal> <id|name>", "red"));
      process.exit(1);
    }

    try {
      await this.pboss.sendSignal(target, signal);
      console.log(colorize(`✓ Signal ${signal} sent to ${target}`, "green"));
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdReset(args: string[]) {
    const target = args[0] || "all";
    try {
      const states = await this.pboss.reset(target);
      console.log(colorize("✓ Restart counters reset", "green"));
      printProcessTable(states);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdMonit() {
    try {
      const snapshot = await this.pboss.metrics();
      console.log(colorize("\n⚡ ProcBoss Monitor\n", "bold"));

      console.log(colorize("System:", "cyan"));
      console.log(`  Platform : ${snapshot.system.platform}`);
      console.log(`  CPUs     : ${snapshot.system.cpuCount}`);
      console.log(
        `  Memory   : ${formatBytes(
          snapshot.system.totalMemory - snapshot.system.freeMemory
        )} / ${formatBytes(snapshot.system.totalMemory)}`
      );
      console.log(`  Load avg : ${snapshot.system.loadAvg.map((l: number) => l.toFixed(2)).join(", ")}`);
      console.log();

      console.log(colorize("Processes:", "cyan"));
      for (const p of snapshot.processes) {
        const statusStr = colorize(padRight(p.status, 14), statusColor(p.status));
        console.log(
          `  ${padRight(String(p.id), 4)} ${padRight(p.name, 20)} ${statusStr} CPU: ${padRight(
            p.cpu.toFixed(1) + "%",
            8
          )} MEM: ${padRight(formatBytes(p.memory), 10)} ↺ ${p.restarts}`
        );
      }
      console.log();
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdDashboard(args: string[]) {
    let port = DASHBOARD_PORT;
    let metricsPort = METRICS_PORT;

    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) port = parseInt(args[portIdx + 1]!);
    const mIdx = args.indexOf("--metrics-port");
    if (mIdx !== -1 && args[mIdx + 1]) metricsPort = parseInt(args[mIdx + 1]!);

    try {
      const res = await this.pboss.dashboard(port, metricsPort);
      console.log(colorize(`✓ Dashboard running at http://localhost:${res.port}`, "green"));
      console.log(
        colorize(`  Prometheus metrics at http://localhost:${res.metricsPort}/metrics`, "dim")
      );
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdDashboardStop() {
    try {
      await this.pboss.dashboardStop();
      console.log(colorize("✓ Dashboard stopped", "green"));
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdPing() {
    try {
      const res = await this.pboss.ping();
      console.log(colorize("✓ Daemon is alive", "green"));
      console.log(`  PID    : ${res.pid}`);
      console.log(`  Uptime : ${formatUptime(res.uptime * 1000)}`);
    } catch {
      console.log(colorize("✗ Daemon is not running", "red"));
    }
  }

  async cmdKill() {
    try {
      await this.pboss.kill();
      console.log(colorize("✓ Daemon killed", "green"));
    } catch (err: any) {
      // Honest failure — the old empty catch printed the success line even
      // when nothing was killed.
      console.error(colorize(`✗ Kill failed: ${err?.message ?? err}`, "red"));
      process.exit(1);
    }
  }

  async cmdDeploy(args: string[]) {
    const configFile = args[0];
    const environment = args[1];

    if (!configFile || !environment) {
      console.error(colorize("Usage: pboss deploy <config> <environment> [setup]", "red"));
      process.exit(1);
    }

    try {
      const config = await loadEcosystemConfig(configFile);
      if (!config.deploy || !config.deploy[environment]) {
        console.error(colorize(`Deploy environment "${environment}" not found in config`, "red"));
        process.exit(1);
      }

      const deployConfig = config.deploy[environment]!;
      const deployer = new DeployManager();

      if (args[2] === "setup") {
        await deployer.setup(deployConfig);
      } else {
        await deployer.deploy(deployConfig, args[2]);
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  /**
   * The shared option guidance. Bare `pboss startup` deliberately does NOT
   * pick a side: installing a boot service changes the machine, and the
   * matching way back out is `uninstall` — so the user chooses.
   */
  printStartupUsage(): void {
    console.log(`Usage: pboss startup <install | uninstall | status> [generate [os]]

Manage the boot startup service for the pboss daemon.

The boot service is normally set up automatically at install time (the
one-line installer and global npm installs do it for you) — you only need
these commands when that was not possible (e.g. no privileges at install
time, or a host without systemd) or to remove it again.

Commands:
  install               Install the boot startup service
                          Linux:    sudo env PATH="$PATH" pboss startup install
                          macOS:    pboss startup install   (no sudo needed)
                          Windows:  pboss startup install   (elevated shell)
  uninstall             Remove the boot startup service (alias: remove)
  status                Show whether the boot service is installed/enabled,
                          whether the daemon is up, and what a reboot would
                          restore from the auto-saved dump
  generate [os]         Print the service config without installing
                          (os: linux, darwin, win32)

With the boot service active, every process you start, stop, or delete is
saved automatically, and the whole list is resurrected at boot — processes
survive reboots and restarts by default.

\`pboss startup\` alone does nothing — pass one of the options above.`);
  }

  async cmdStartup(args: string[]) {
    const startup = new StartupManager();
    const sub = args[0];

    // Platform names keep the legacy "pboss startup <platform>" generate form.
    const PLATFORM_ALIASES: Record<string, string> = {
      linux: "linux",
      darwin: "darwin",
      macos: "darwin",
      win32: "win32",
      windows: "win32",
    };

    try {
      if (sub === "install") {
        console.log(await startup.install());
        return;
      }

      if (sub === "remove" || sub === "uninstall") {
        console.log(await startup.uninstall());
        return;
      }

      if (sub === "status") {
        console.log(await startup.status());
        return;
      }

      if (sub === "generate" || sub === "show" || sub === "print") {
        console.log(await startup.generate(PLATFORM_ALIASES[args[1] ?? ""] ?? args[1]));
        return;
      }

      if (sub && PLATFORM_ALIASES[sub]) {
        console.log(await startup.generate(PLATFORM_ALIASES[sub]));
        return;
      }

      // No implicit install: bare `pboss startup` tells the user to choose
      // (install or uninstall); an unknown option says so and shows the same
      // guidance. Generating a file to save by hand is what `startup
      // generate` is for.
      if (sub) {
        console.error(colorize(`Unknown startup option: "${sub}"`, "red"));
      }
      this.printStartupUsage();
      if (sub) process.exit(1);
    } catch (err: any) {
      console.error(colorize(err?.message ?? String(err), "red"));
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Cron jobs — standalone scheduled commands
  // -------------------------------------------------------------------------

  printCronHelp() {
    console.log(`Usage: pboss cron <command> [options]

Commands:
  run <schedule> <command...>   Schedule a command. The schedule is friendly
                                syntax or a raw 5/6-field cron expression.
  list                          List all cron jobs
  remove <id|name>              Remove a cron job
  next <id|name> [--count N]    Show the next N run times (default 3)
  trigger <id|name>             Run a job immediately

Options for "run":
  --name, -n <name>             Job name (default: derived from the command)
  --cwd <path>                  Working directory (default: current directory)

Schedules:
  everyday                      every day at 00:00
  everyday@10                   every day at 10:00
  everyday@9:11                 every day at 09:11
  everyday@24:30                every day at 00:30 (24:xx = next day)
  everysecond                   every second (also: every-15-seconds)
  everyminute                   every minute (also: every-30-minutes)
  everyhour [@30]               every hour at :00 / :30 (also: every-6-hours)
  everyweek [@10:10]            every Sunday
  every-sunday [@10:10]         every Sunday (also: everySunday, onSunday)
  every-saturday@22:00          every Saturday at 22:00 (3-letter: every-sat)
  everymonth [@10:10]           every 1st
  every-15th [@10:10]           every 15th
  every-6-hours [@30]           every 6 hours
  every-30-minutes              every 30 minutes
  every-2-days [@8]             every 2nd day
  today@23:10                   once, today
  tomorrow@8:00                 once, tomorrow
  on-date@24-10-2026            once, 24 Oct 2026 00:00 (day-month-year)
  on-date@24-10-2026-23:10      once, 24 Oct 2026 23:10 (also: onDate@)
  "*/5 * * * *"                 raw cron (5 fields, or 6 w/ seconds)

Examples:
  pboss cron run everyday@2:00 "bun /srv/backup.ts"
  pboss cron run every-sunday@10:10 "sh /srv/cleanup.sh" --name cleanup
  pboss cron run every-15th "tar -czf /backups/site.tar.gz /var/www"
  pboss cron run on-date@24-10-2026-23:10 "node migrate.js"
  pboss cron list
  pboss cron next cleanup --count 5
  pboss cron trigger cleanup
`);
  }

  async cmdCron(args: string[]) {
    const sub = args[0];
    const rest = args.slice(1);

    try {
      switch (sub) {
        case "run": {
          let name: string | undefined;
          let cwd: string | undefined;
          const positional: string[] = [];

          for (let i = 0; i < rest.length; i++) {
            const a = rest[i]!;
            if (a === "--name" || a === "-n") {
              name = rest[++i];
            } else if (a === "--cwd") {
              cwd = rest[++i];
            } else if (a === "--help" || a === "-h") {
              this.printCronHelp();
              return;
            } else {
              positional.push(a);
            }
          }

          const schedule = positional[0];
          const command = positional.slice(1).join(" ").trim();

          if (!schedule || !command) {
            console.error(
              colorize(
                'Usage: pboss cron run <schedule> <command...>   e.g. pboss cron run everyday@9:11 "bun backup.ts"',
                "red"
              )
            );
            process.exit(1);
          }

          const job = await this.pboss.cronAdd(schedule, command, {
            name,
            cwd: cwd ? resolve(cwd) : undefined,
          });

          console.log(
            colorize(`✓ Cron job ${colorize(job.name, "cyan")} scheduled — ${job.description}`, "green")
          );
          if (job.nextRun) {
            const d = new Date(job.nextRun);
            const p = (n: number) => String(n).padStart(2, "0");
            const secs = job.nextRun - Date.now() < 60_000 ? `:${p(d.getSeconds())}` : "";
            console.log(
              `  next run: ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
                `${p(d.getHours())}:${p(d.getMinutes())}${secs} (${formatUptime(job.nextRun - Date.now())} from now)`
            );
          } else {
            console.log(colorize("  paused (enabled: false)", "yellow"));
          }
          console.log(colorize(`  logs: ~/.pboss/logs/cron/${job.name}.log`, "dim"));
          break;
        }

        case "list":
        case "ls": {
          const jobs = await this.pboss.cronJobs();
          printCronTable(jobs);
          break;
        }

        case "remove":
        case "rm":
        case "delete": {
          const target = rest[0];
          if (!target) {
            console.error(colorize("Usage: pboss cron remove <id|name>", "red"));
            process.exit(1);
          }
          const job = await this.pboss.cronRemove(target);
          console.log(
            colorize(`✓ Removed cron job ${colorize(job.name, "cyan")} (${job.schedule})`, "green")
          );
          break;
        }

        case "next": {
          const positional = rest.filter((a, i) => !(a.startsWith("--") && i > 0));
          const countFlagIdx = rest.indexOf("--count");
          const count = countFlagIdx !== -1 ? parseInt(rest[countFlagIdx + 1] ?? "3", 10) || 3 : 3;
          const target = positional[0];

          if (!target) {
            console.error(colorize("Usage: pboss cron next <id|name> [--count N]", "red"));
            process.exit(1);
          }

          const times = await this.pboss.cronNext(target, count);
          if (!times.length) {
            console.log(colorize("No upcoming runs (completed one-shot or unknown job)", "yellow"));
            break;
          }
          const job = await this.pboss.cronJobs();
          const name = job.find((j) => j.id.toString() === target || j.name === target)?.name ?? target;
          console.log("");
          console.log(colorize(`Next ${times.length} run${times.length > 1 ? "s" : ""} of ${name}:`, "cyan"));
          // Sub-minute spacing (every-second jobs) needs second-level display.
          const spaced = times.length > 1 && times[1]! - times[0]! < 60_000;
          for (const t of times) {
            const d = new Date(t);
            const p = (n: number) => String(n).padStart(2, "0");
            const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d);
            const secs = spaced ? `:${p(d.getSeconds())}` : "";
            console.log(
              `  ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
                `${p(d.getHours())}:${p(d.getMinutes())}${secs}  ${day}`
            );
          }
          console.log("");
          break;
        }

        case "trigger": {
          const target = rest[0];
          if (!target) {
            console.error(colorize("Usage: pboss cron trigger <id|name>", "red"));
            process.exit(1);
          }
          console.log(colorize(`Running "${target}" now…`, "cyan"));
          const job = await this.pboss.cronTrigger(target);
          if (job.lastError) {
            console.error(colorize(`✗ ${job.lastError}`, "red"));
            process.exit(1);
          }
          console.log(
            colorize(
              `✓ ${job.name} finished — exit code ${job.lastExitCode ?? "?"} ` +
                `(logs: ~/.pboss/logs/cron/${job.name}.log)`,
              job.lastExitCode === 0 ? "green" : "yellow"
            )
          );
          break;
        }

        case "help":
        case "--help":
        case "-h":
        case undefined:
          this.printCronHelp();
          break;
        default:
          console.error(colorize(`Unknown cron command: ${sub}`, "red"));
          this.printCronHelp();
          process.exit(1);
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdCloud(args: string[]) {
    const sub = args[0];
    const rest = args.slice(1);

    try {
      switch (sub) {
        case "connect": {
          let token = "";
          let url: string | undefined;
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "--url" && rest[i + 1]) {
              url = rest[i + 1];
              i++;
            } else if (!token && !rest[i]!.startsWith("-")) {
              token = rest[i]!;
            }
          }
          if (!token) {
            console.error(
              colorize("Usage: pboss cloud connect <token> [--url <cloud>]", "red")
            );
            console.error(
              "Mint a token in the ProcBoss dashboard: Servers → Connect server."
            );
            process.exit(1);
          }
          console.log(colorize("☁  Linking this machine to ProcBoss Cloud…", "cyan"));
          const info = await this.pboss.cloudConnect(token, url);
          console.log("");
          console.log(colorize(`✓ Server registered and connected`, "green"));
          console.log(`  Server:    ${info.serverName} (${info.serverId})`);
          console.log(
            `  Dashboard: ${colorize((url || process.env.PBOSS_CLOUD_URL || "https://procboss.com").replace(/\/+$/, ""), "cyan")}`
          );
          console.log("");
          console.log(
            colorize("The daemon now streams state and accepts commands from your dashboard.", "dim")
          );
          console.log(
            colorize("Credential stored in ~/.pboss/cloud.json (0600). Reconnects are automatic.", "dim")
          );
          break;
        }

        case "status": {
          const st = await this.pboss.cloudStatus();
          console.log("");
          console.log(colorize("☁  ProcBoss Cloud", "bold"));
          console.log("");
          if (!st.configured) {
            console.log(`  Status:    ${colorize("not linked", "yellow")}`);
            console.log(
              `  Link with: ${colorize("pboss cloud connect <token>", "cyan")} (mint one in the dashboard)`
            );
          } else {
            const state =
              st.streamState === "connected"
                ? colorize("connected — command channel live", "green")
                : st.streamState === "connecting"
                  ? colorize("connecting…", "yellow")
                  : st.streamState === "backoff"
                    ? colorize(`reconnecting (backoff, ${st.reconnects} retries)`, "yellow")
                    : colorize("stopped", "red");
            console.log(`  Status:    ${state}`);
            console.log(`  Cloud:     ${st.cloudUrl}`);
            console.log(`  Server:    ${st.serverName ?? "?"} (${st.serverId})`);
            console.log(`  Processes: ${st.processes}`);
            console.log(
              `  Report:    ${
                st.lastReportAgeMs != null
                  ? `${Math.max(0, Math.round(st.lastReportAgeMs / 1000))}s ago`
                  : "never"
              }`
            );
            if (st.lastError) {
              console.log(`  Last err:  ${colorize(st.lastError, "yellow")}`);
            }
          }
          console.log("");
          break;
        }

        case "disconnect":
        case "unlink": {
          await this.pboss.cloudDisconnect();
          console.log(
            colorize("✓ Unlinked — credential revoked, cloud.json removed", "green")
          );
          console.log(
            colorize("The server row stays in your dashboard (offline); re-link any time.", "dim")
          );
          break;
        }

        case "help":
        case "--help":
        case undefined:
          this.printCloudHelp();
          break;
        default:
          console.error(colorize(`Unknown cloud command: ${sub}`, "red"));
          this.printCloudHelp();
          process.exit(1);
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  printCloudHelp() {
    console.log(`Usage: pboss cloud <command>

${colorize("Commands:", "cyan")}
  connect <token> [--url <cloud>]   Link this machine (token from the dashboard)
  status                            Show link status, server id, last report
  disconnect                        Unlink: revoke credential + stop the agent

${colorize("Notes:", "dim")}
  Tokens are single-use, expire in 15 minutes, and are minted in the
  ProcBoss dashboard (Servers → Connect server).
  The connection is outbound-only — no ports to open, ever.
  Set PBOSS_CLOUD_URL to override the cloud endpoint.`);
  }

  async cmdEnv(args: string[]) {
    const envMgr = new EnvManager();
    const subCmd = args[0];

    switch (subCmd) {
      case "set": {
        const name = args[1];
        const key = args[2];
        const value = args[3];
        if (!name || !key || value === undefined) {
          console.error(colorize("Usage: pboss env set <name> <key> <value>", "red"));
          process.exit(1);
        }
        await envMgr.setEnv(name, key, value);
        console.log(colorize(`✓ Set ${key}=${value} for ${name}`, "green"));
        break;
      }
      case "get": {
        const name = args[1];
        if (!name) {
          console.error(colorize("Usage: pboss env get <name>", "red"));
          process.exit(1);
        }
        const env = await envMgr.getEnv(name);
        for (const [k, v] of Object.entries(env)) {
          console.log(`${colorize(k, "cyan")}=${v}`);
        }
        break;
      }
      case "delete":
      case "rm": {
        const name = args[1];
        const key = args[2];
        if (!name) {
          console.error(colorize("Usage: pboss env delete <name> [key]", "red"));
          process.exit(1);
        }
        await envMgr.deleteEnv(name, key);
        console.log(colorize("✓ Deleted", "green"));
        break;
      }
      case "list": {
        const all = await envMgr.getEnvs();
        for (const [name, env] of Object.entries(all)) {
          console.log(colorize(`\n${name}:`, "bold"));
          for (const [k, v] of Object.entries(env)) {
            console.log(`  ${colorize(k, "cyan")}=${v}`);
          }
        }
        break;
      }
      default:
        console.error(colorize("Usage: pboss env <set|get|delete|list> ...", "red"));
        process.exit(1);
    }
  }

  async cmdModule(args: string[]) {
    const subCmd = args[0];

    switch (subCmd) {
      case "install": {
        const mod = args[1];
        if (!mod) {
          console.error(colorize("Usage: pboss module install <name|url|path>", "red"));
          process.exit(1);
        }
        try {
          const res = await this.pboss.moduleInstall(mod);
          console.log(colorize(`✓ Module installed at ${res.path}`, "green"));
        } catch (err: any) {
          console.error(colorize(`Error: ${err.message}`, "red"));
          process.exit(1);
        }
        break;
      }
      case "uninstall":
      case "remove": {
        const mod = args[1];
        if (!mod) {
          console.error(colorize("Usage: pboss module uninstall <name>", "red"));
          process.exit(1);
        }
        try {
          await this.pboss.moduleUninstall(mod);
          console.log(colorize("✓ Module uninstalled", "green"));
        } catch (err: any) {
          console.error(colorize(`Error: ${err.message}`, "red"));
          process.exit(1);
        }
        break;
      }
      case "list":
      case "ls": {
        try {
          const list = await this.pboss.moduleList();
          if (list.length === 0) {
            console.log(colorize("No modules installed", "dim"));
          } else {
            for (const m of list) {
              console.log(`  ${colorize(m.name, "cyan")} @ ${m.version}`);
            }
          }
        } catch (err: any) {
          console.error(colorize(`Error: ${err.message}`, "red"));
          process.exit(1);
        }
        break;
      }
      default:
        console.error(colorize("Usage: pboss module <install|uninstall|list> ...", "red"));
        process.exit(1);
    }
  }

  async cmdDaemon(args: string[]) {
    const subCmd = args[0];

    const daemonStatus = () => {
      if (this.pboss.isDaemonRunning()) {
        console.log(colorize("running", "green"));
      } else {
        console.error(colorize("stopped", "red"));
      }
      process.exit(1);
    };

    switch (subCmd) {
      case "status":
        daemonStatus();
        break;
      case "start":
        await this.pboss.startDaemon();
        process.exit(0);
        break;
      case "stop":
        await this.pboss.stopDaemon();
        process.exit(0);
        break;
      case "reload":
        await this.pboss.daemonReload();
        process.exit(0);
        break;
      default:
        console.error(colorize("Usage: pboss daemon <status|start|stop|reload>", "red"));
        process.exit(1);
    }
  }

  async cmdPrometheus() {
    try {
      const prom = await this.pboss.prometheus();
      console.log(prom);
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Help
  // -------------------------------------------------------------------------

  printHelp() {
    console.log(`
    ${colorize("ProcBoss", "bold")} ${colorize(`v${VERSION}`, "dim")} — Bun Process Manager
    
    ${colorize("Usage:", "bold")} pboss <command> [options]
    
    ${colorize("Process Management:", "cyan")}
    start <script|config> [opts]  Start a process or ecosystem config
    stop [id|name|all]            Stop process(es)
    restart [id|name|all]         Restart process(es)
    reload [id|name|all]          Graceful zero-downtime reload
    delete [id|name|all]          Stop and remove process(es)
    scale <id|name> <count>       Scale to N instances
    list | ls | status            List all processes
    describe <id|name>            Show detailed process info
    reset <id|name|all>           Reset restart counters
    
    ${colorize("Logs:", "cyan")}
    logs [id|name|all] [--lines N]  Show recent logs
    flush [id|name]                 Clear log files
    
    ${colorize("Monitoring:", "cyan")}
    monit                         Show live metrics snapshot
    dashboard [--port N]          Start web dashboard
    dashboard stop                Stop web dashboard
    prometheus                    Print Prometheus metrics
    
    ${colorize("Persistence (on by default):", "cyan")}
    save                          Manually re-save the process list
                                  (it is saved automatically after every
                                  start/stop/delete/scale — no need to run
                                  this)
    resurrect                     Restore saved process list
                                  --wait <sec>: wait for an externally
                                  started daemon instead of spawning one
                                  (systemd unit ExecStartPost uses this)
    startup install               Install the boot startup service
                                  (done automatically at install time; run
                                  this only when it could not be — sudo env
                                  PATH="$PATH" pboss startup install on
                                  Linux; macOS needs no sudo; Windows needs
                                  an elevated shell)
    startup uninstall             Remove the boot startup service
                                  (alias: startup remove)
    startup status                Show boot-persistence state: service
                                  installed/enabled, daemon up, and what a
                                  reboot would restore from the auto-saved
                                  dump
    startup generate [os]         Print the service config without installing
                                  (bare \`pboss startup\` shows these options)
    
    ${colorize("Scheduling:", "cyan")}
    cron run <when> <command>     Schedule a command (everyday@9:11, every-second, …)
    cron list                     List scheduled jobs
    cron remove <id|name>         Remove a scheduled job
    cron next <id|name>           Preview upcoming runs
    cron trigger <id|name>        Run a job immediately
    
    ${colorize("Cloud:", "cyan")}
    cloud connect <token>         Link this machine to ProcBoss Cloud
    cloud status                  Show the cloud link status
    cloud disconnect              Unlink (revokes this machine's credential)
    
    ${colorize("Deploy:", "cyan")}
    deploy <config> <env> [setup] Deploy using ecosystem config
    
    ${colorize("Environment:", "cyan")}
    env set <name> <key> <val>    Set env variable
    env get <name>                List env vars for a process
    env delete <name> [key]       Delete env variable(s)
    env list                      List all env registries
    
    ${colorize("Modules:", "cyan")}
    module install <name|url>     Install a pboss module
    module uninstall <name>       Remove a module
    module list                   List installed modules
    
    ${colorize("Daemon:", "cyan")}
    daemon status                 Returns the status of the daemon
    daemon start                  Starts the daemon
    daemon stop                   Stops the daemon
    daemon reload                 Reloads the daemon
    
    ${colorize("Other:", "cyan")}
    ping                          Check if daemon is alive
    kill                          Kill the daemon and all processes
    sendSignal <sig> <id|name>    Send OS signal to process
    
    ${colorize("Start Options:", "dim")}
    --name, -n <name>             Process name
    --instances, -i <N>           Number of instances (cluster)
    --exec-mode, -x <mode>        fork or cluster
    --watch, -w                   Watch for file changes
    --cwd <path>                  Working directory
    --interpreter <bin>           Custom interpreter
    --node-args <args>            Extra runtime arguments
    --max-memory-restart <size>   e.g. 200M, 1G
    --max-restarts <N>            Max restart attempts
    --cron, --cron-restart <expr> Cron-based restart schedule
    --port, -p <port>             Base port for cluster
    --env <KEY=VALUE>             Set environment variable
    --no-autorestart              Disable auto-restart
    --no-daemon, -d               Run without daemon (blocks)
    --raw                         Mirror child logs to stdout and stderr
    --log, -o <file>              Custom stdout log path
    --error, -e <file>            Custom stderr log path
    --namespace <ns>              Namespace grouping
    --wait-ready                  Wait for ready signal
    --health-check-url <url>      HTTP health check endpoint
    -- <args...>                  Pass arguments to script
    
    ${colorize("Examples:", "dim")}
    pboss start app.ts
    pboss start server.ts --name api -i 4 --watch
    pboss start --no-daemon app.ts
    pboss start --name api --no-daemon server.ts
    pboss start ecosystem.config.ts
    pboss cron run everyday@2:00 "bun /srv/backup.ts"
    pboss cron run every-sunday@10:10 "sh cleanup.sh" --name cleanup
    pboss restart api
    pboss scale api 8
    pboss logs api --lines 100
    pboss monit
    pboss save && pboss resurrect
    `);
  }

  // -------------------------------------------------------------------------
  // Main dispatch
  // -------------------------------------------------------------------------

  async run(argv: string[]) {
    const command = argv[0];
    const commandArgs = argv.slice(1);
    
    this.noDaemon = argv.includes("--no-daemon") || argv.includes("-d");
    if (this.noDaemon) {
      this.pboss = new PBoss({ noDaemon: true });
    }

    switch (command) {
      case "start":
        await this.cmdStart(commandArgs);
        break;
      case "stop":
        await this.cmdStop(commandArgs);
        break;
      case "restart":
        await this.cmdRestart(commandArgs);
        break;
      case "reload":
        await this.cmdReload(commandArgs);
        break;
      case "delete":
      case "del":
      case "rm":
        await this.cmdDelete(commandArgs);
        break;
      case "scale":
        await this.cmdScale(commandArgs);
        break;
      case "list":
      case "ls":
      case "status":
        await this.cmdList(commandArgs);
        break;
      case "describe":
      case "show":
      case "info":
        await this.cmdDescribe(commandArgs);
        break;
      case "logs":
      case "log":
        await this.cmdLogs(commandArgs);
        break;
      case "flush":
        await this.cmdFlush(commandArgs);
        break;
      case "monit":
      case "monitor":
        await this.cmdMonit();
        break;
      case "dashboard":
        if (commandArgs[0] === "stop") {
          await this.cmdDashboardStop();
        } else {
          await this.cmdDashboard(commandArgs);
        }
        break;
      case "prometheus":
        await this.cmdPrometheus();
        break;
      case "save":
      case "dump":
        await this.cmdSave();
        break;
      case "resurrect":
      case "restore":
        await this.cmdResurrect(commandArgs);
        break;
      case "reset":
        await this.cmdReset(commandArgs);
        break;
      case "sendSignal":
      case "signal":
        await this.cmdSignal(commandArgs);
        break;
      case "ping":
        await this.cmdPing();
        break;
      case "kill":
        await this.cmdKill();
        break;
      case "deploy":
        await this.cmdDeploy(commandArgs);
        break;
      case "startup":
        await this.cmdStartup(commandArgs);
        break;
      case "cron":
        await this.cmdCron(commandArgs);
        break;
      case "cloud":
        await this.cmdCloud(commandArgs);
        break;
      case "env":
        await this.cmdEnv(commandArgs);
        break;
      case "module":
        await this.cmdModule(commandArgs);
        break;
      case "daemon":
        await this.cmdDaemon(commandArgs);
        break;
      case "version":
      case "-v":
      case "--version":
        console.log(`${APP_NAME} v${VERSION}`);
        break;
      case "__daemon":
      case "daemon-server": {
        // The systemd unit's ExecStart (and the CLI daemonizer) run this.
        // Failure handling is explicit: a conflict with a live daemon exits
        // 81 (systemd units set RestartPreventExitStatus=81 — a restart
        // cannot help while the other daemon owns the socket); anything
        // else exits 1 with the actual error instead of an unhandled
        // rejection, so `journalctl -u pboss` shows something actionable.
        try {
          const dm = new Daemon();
          await dm.initialize(true);
          dm.startServer();
          console.log(`Daemon listening on ${DAEMON_SOCKET}`);
          await new Promise(() => {});
        } catch (err) {
          if (err instanceof DaemonConflictError) {
            console.error(`[pboss] cannot start daemon: ${err.message}`);
            console.error(
              "[pboss] it is probably a leftover detached daemon — stop it with `pboss kill` and restart the service.",
            );
            process.exit(EXIT_DAEMON_CONFLICT);
          }
          console.error("Daemon startup error:", err);
          process.exit(1);
        }
        break;
      }
      case "help":
      case "-h":
      case "--help":
      case undefined:
        this.printHelp();
        break;
      default:
        console.error(colorize(`Unknown command: ${command}`, "red"));
        console.error(`Run ${colorize("pboss --help", "cyan")} for usage information.`);
        process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main() {
  await ensureDirs();
  const cli = new PBossCLI();
  await cli.run(process.argv.slice(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
