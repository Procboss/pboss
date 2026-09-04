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
  DASHBOARD_PORT,
  METRICS_PORT,
} from "./constants";
import { ensureDirs, formatBytes, formatUptime, colorize, padRight } from "./utils";
import { PBoss, loadEcosystemConfig } from "./api";
import { DeployManager } from "./deploy";
import { StartupManager } from "./startup-manager";
import { EnvManager } from "./env-manager";
import type {
  StartOptions,
  ProcessState,
  LogItem,
} from "./types";
import { statusColor } from "./colors";
import { liveWatchProcess, printProcessTable } from "./process-table";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Ensure directory structure exists
// ---------------------------------------------------------------------------
await ensureDirs();

// ---------------------------------------------------------------------------
// PBossCLI class — Delegates all process engine operations to PBoss API
// ---------------------------------------------------------------------------

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

        if (this.noDaemon) {
          await new Promise(() => {});
        }
      }
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
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
      console.log(colorize("✓ Process list saved", "green"));
    } catch (err: any) {
      console.error(colorize(`Error: ${err.message}`, "red"));
      process.exit(1);
    }
  }

  async cmdResurrect() {
    try {
      const states = await this.pboss.resurrect();
      printProcessTable(states);
    } catch (err: any) {
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
    } catch {}
    console.log(colorize("✓ Daemon killed", "green"));
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

  async cmdStartup(args: string[]) {
    const startup = new StartupManager();

    if (args[0] === "remove" || args[0] === "uninstall") {
      console.log(await startup.uninstall());
      return;
    }

    if (args[0] === "install") {
      console.log(await startup.install());
      return;
    }

    console.log(await startup.generate(args[0]));
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
    
    ${colorize("Persistence:", "cyan")}
    save                          Save current process list
    resurrect                     Restore saved process list
    startup [install|remove]      Generate/install startup script
    
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
        await this.cmdResurrect();
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

const cli = new PBossCLI();
await cli.run(process.argv.slice(2));
