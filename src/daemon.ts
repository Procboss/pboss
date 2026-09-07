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

import { ProcessManager } from "./process-manager";
import { Dashboard } from "./dashboard";
import { ModuleManager } from "./module-manager";
import { CronJobManager } from "./cron-jobs";
import { CloudAgent, loadCloudConfig, resolveCloudUrl } from "./cloud";
import {
  DAEMON_SOCKET,
  DAEMON_PID_FILE,
  DASHBOARD_PORT,
  METRICS_PORT,
} from "./constants";
import {
  DaemonConflictError,
  EXIT_DAEMON_CONFLICT,
  ignore,
} from "./error-handling";
import { probeDaemon } from "./daemon-probe";
import { enrichPathWithBun } from "./install-mode";
import { ensureDirs } from "./utils";
import type { DaemonMessage, DaemonResponse } from "./types";
import type { ReadableStreamController, Server } from "bun";
import { existsSync, unlinkSync, readFileSync } from "node:fs";


export default class Daemon {

  initialized: boolean = false;

  server: Server<any> | null = null;
  pm: ProcessManager | null = null;
  dashboard: Dashboard | null = null;
  moduleManager: ModuleManager | null = null;
  cronJobManager: CronJobManager | null = null;
  cloudAgent: CloudAgent | null = null;
  metricsInterval: NodeJS.Timeout | null = null;
  args = process.argv.slice(2);

  debugMode: boolean = false;
  daemonEnabled: boolean = true;

  // ── Bound once so Bun.serve always has the right `this` ──────────────────
  private boundFetch = (req: Request) => this.handleServerRequests(req);

  getServerOpts = () => ({
    unix: DAEMON_SOCKET,
    fetch: this.boundFetch,
    idleTimeout: 0
  });

  
  async initialize(_daemonEnabled: boolean = true) {

    // PATH self-healing for minimal environments: a daemon spawned by a
    // systemd/launchd unit (especially one generated BEFORE the
    // multi-location Bun search existed) runs with a PATH that lacks
    // per-user bin dirs like ~/.bun/bin. findBun() resolves the absolute
    // interpreter for worker spawns anyway, but worker children inherit
    // the daemon's PATH — anything they shell out to by name (`bun`,
    // `bunx`) must also resolve. Worker envs are built from process.env,
    // so amending PATH here propagates to every future child.
    enrichPathWithBun();

    await ensureDirs();

    this.daemonEnabled = _daemonEnabled;
    this.pm = new ProcessManager();
    this.dashboard = new Dashboard(this.pm);
    this.moduleManager = new ModuleManager(this.pm);
    this.cronJobManager = new CronJobManager();

    this.args = process.argv.slice(2);
    this.debugMode = this.args.includes("--debug");

    if (_daemonEnabled) {
      // A RESPONSIVE socket is the authoritative "another daemon is live"
      // signal — PID files can lie (PID reuse after a reboot), so conflict
      // decisions are made on the probe, not the PID file. The old code
      // silently returned here and then failed binding the socket with an
      // opaque EADDRINUSE; now the conflict is loud and typed, and the
      // systemd unit restarts nothing (RestartPreventExitStatus=81).
      const live = await probeDaemon();
      if (live) {
        throw new DaemonConflictError(DAEMON_SOCKET, live.pid);
      }

      // Stale leftovers from a crash / reboot — take them over.
      try {
        if (existsSync(DAEMON_PID_FILE)) {
          const pidText = readFileSync(DAEMON_PID_FILE, "utf-8").trim();
          const existingPid = parseInt(pidText);
          if (pidText && existingPid !== process.pid) {
            process.kill(existingPid, 0);
          }
        }
      } catch (err) {
        // Stale PID file (process gone / PID reused) — safe to overwrite.
        ignore(`read/verify PID file ${DAEMON_PID_FILE} (stale)`, err);
      }

      // Clean up stale socket so Bun.serve can bind cleanly
      try {
        if (existsSync(DAEMON_SOCKET)) unlinkSync(DAEMON_SOCKET);
      } catch (err) {
        ignore(`unlink stale socket ${DAEMON_SOCKET}`, err);
      }
      try {
        const sock = Bun.file(DAEMON_SOCKET);
        if (await sock.exists()) await sock.delete();
      } catch (err) {
        ignore(`delete stale socket file ${DAEMON_SOCKET}`, err);
      }

      // Write PID file
      await Bun.write(DAEMON_PID_FILE, String(process.pid));
    }

    // Load modules
    await this.moduleManager.loadAll();

    // Standalone cron jobs: load persisted jobs and start the scheduler
    await this.cronJobManager.start();

    // Cloud link: if this machine was already enrolled, resume the agent
    this.cloudAgent = new CloudAgent(this.pm);
    const cloudCfg = loadCloudConfig();
    if (cloudCfg) {
      this.cloudAgent.start(cloudCfg);
    }

    this.metricsInterval = setInterval(() => {
      this.pm!.getMetrics();
    }, 5000);

    this.initialized = true;

  } // end initialize

  async handleServerRequests(req: Request): Promise<Response> {

    if (req.method !== "POST") {
      return Response.json(
        { type: "error", error: "Method Not Allowed", success: false },
        { status: 405 }
      );
    }

    try {

      const msg = (await req.json()) as DaemonMessage;
      
      if (msg.mode == "stream") {
        return this.handleStream(msg, req);
      }
      
      const response = await this.handleMessage(msg);
      return Response.json(response);

    } catch (err: any) {
      return Response.json(
        { type: "error", error: err.message, success: false },
        { status: 500 }
      );
    }
  }
  
  handleStream(msg: DaemonMessage, req: Request) {
    
    //let controller: ReadableStreamDefaultController;
    const self = this;
    const signal: AbortSignal = req.signal;
    
    const stream = new ReadableStream({
      start(controller) {
         
        self.handleStreamMessage(msg, controller, signal);
        
        const keepAlive = setInterval(() => {
          controller.enqueue(': ping\n\n');   // SSE comment – ignored by clients but counts as data
        }, 5000);                  // every 5 seconds (less than 10s timeout)
        
        // cleanup when client disconnects
        signal.addEventListener("abort", () => {
          clearInterval(keepAlive)
          controller.close();
        });
      },
    });
   
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream", // SSE style
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // initialize MUST be called before startServer
  startServer(): Server<any> {
    
    if (!this.initialized) {
      throw new Error("Daemon.initialize() must be called before startServer()");
    }
    
    this.server = Bun.serve(this.getServerOpts() as any);
    return this.server;
  }
  
  async handleStreamMessage(msg: DaemonMessage, streamController: ReadableStreamDefaultController, signal: AbortSignal) {
        
    if (!this.initialized) {
      await this.initialize();
    }

    const pm = this.pm!;
    //const dashboard = this.dashboard!;
    //const moduleManager = this.moduleManager!;
    //const metricsInterval = this.metricsInterval!;

    switch (msg.type) {
      case "streamLogs": {
        await pm.streamLogs(msg.data.target, streamController, signal);
        break;
      }
      default:
    }
  }


  async handleMessage(msg: DaemonMessage): Promise<DaemonResponse> {
    try {

      if (!this.initialized) {
        await this.initialize();
      }

      const pm = this.pm!;
      const dashboard = this.dashboard!;
      const moduleManager = this.moduleManager!;
      const metricsInterval = this.metricsInterval!;

      switch (msg.type) {
        case "start": {
          const states = await pm.start(msg.data);
          return { type: "start", data: states, success: true, id: msg.id };
        }
        case "startTarget": {
          // Resume existing processes by id/name/namespace (issue #27) —
          // distinct from "start", which creates a process from a script.
          const states = await pm.startTarget(msg.data.target);
          return { type: "startTarget", data: states, success: true, id: msg.id };
        }
        case "stop": {
          const states = await pm.stop(msg.data.target);
          return { type: "stop", data: states, success: true, id: msg.id };
        }
        case "restart": {
          const states = await pm.restart(msg.data.target);
          return { type: "restart", data: states, success: true, id: msg.id };
        }
        case "reload": {
          const states = await pm.reload(msg.data.target);
          return { type: "reload", data: states, success: true, id: msg.id };
        }
        case "delete": {
          const states = await pm.del(msg.data.target);
          return { type: "delete", data: states, success: true, id: msg.id };
        }
        case "scale": {
          const states = await pm.scale(msg.data.target, msg.data.count);
          return { type: "scale", data: states, success: true, id: msg.id };
        }
        case "stopAll": {
          const states = await pm.stopAll();
          return { type: "stopAll", data: states, success: true, id: msg.id };
        }
        case "restartAll": {
          const states = await pm.restartAll();
          return { type: "restartAll", data: states, success: true, id: msg.id };
        }
        case "reloadAll": {
          const states = await pm.reloadAll();
          return { type: "reloadAll", data: states, success: true, id: msg.id };
        }
        case "deleteAll": {
          const states = await pm.deleteAll();
          return { type: "deleteAll", data: states, success: true, id: msg.id };
        }
        case "list": {
          return { type: "list", data: pm.list(), success: true, id: msg.id };
        }
        case "describe": {
          return { type: "describe", data: pm.describe(msg.data.target), success: true, id: msg.id };
        }
        case "logs": {
          const logs = await pm.getLogs(msg.data.target, msg.data.lines);
          return { type: "logs", data: logs, success: true, id: msg.id };
        }
          
        case "flush": {
          await pm.flushLogs(msg.data?.target);
          return { type: "flush", success: true, id: msg.id };
        }
        case "save": {
          await pm.save();
          return { type: "save", success: true, id: msg.id };
        }
        case "resurrect": {
          const states = await pm.resurrect();
          return { type: "resurrect", data: states, success: true, id: msg.id };
        }
        case "ecosystem": {
          const states = await pm.startEcosystem(msg.data);
          // Register/update the config's standalone cron jobs (if any)
          const crons = await this.cronJobManager!.syncFromConfig(msg.data?.crons);
          return {
            type: "ecosystem",
            data: states,
            cronsAdded: crons.added,
            cronsUpdated: crons.updated,
            success: true,
            id: msg.id,
          };
        }
        case "signal": {
          await pm.sendSignal(msg.data.target, msg.data.signal);
          return { type: "signal", success: true, id: msg.id };
        }
        case "reset": {
          const states = await pm.reset(msg.data.target);
          return { type: "reset", data: states, success: true, id: msg.id };
        }
        case "metrics": {
          const metrics = await pm.getMetrics();
          return { type: "metrics", data: metrics, success: true, id: msg.id };
        }
        case "metricsHistory": {
          const history = pm.getMetricsHistory(msg.data?.seconds || 300);
          return { type: "metricsHistory", data: history, success: true, id: msg.id };
        }
        case "prometheus": {
          const prom = pm.getPrometheusMetrics();
          return { type: "prometheus", data: prom, success: true, id: msg.id };
        }
        case "dashboard": {
          const port = msg.data?.port || DASHBOARD_PORT;
          const metricsPort = msg.data?.metricsPort || METRICS_PORT;
          dashboard.start(port, metricsPort);
          return { type: "dashboard", data: { port, metricsPort }, success: true, id: msg.id };
        }
        case "dashboardStop": {
          dashboard.stop();
          return { type: "dashboardStop", success: true, id: msg.id };
        }
        case "moduleInstall": {
          const path = await moduleManager.install(msg.data.module);
          return { type: "moduleInstall", data: { path }, success: true, id: msg.id };
        }
        case "moduleUninstall": {
          await moduleManager.uninstall(msg.data.module);
          return { type: "moduleUninstall", success: true, id: msg.id };
        }
        case "moduleList": {
          return { type: "moduleList", data: moduleManager.list(), success: true, id: msg.id };
        }
        case "cronAdd": {
          const job = await this.cronJobManager!.add(msg.data);
          return { type: "cronAdd", data: job, success: true, id: msg.id };
        }
        case "cronList": {
          return { type: "cronList", data: this.cronJobManager!.list(), success: true, id: msg.id };
        }
        case "cronRemove": {
          const job = await this.cronJobManager!.remove(msg.data.target);
          if (!job) {
            return {
              type: "error",
              error: `No cron job found for "${msg.data.target}" — see pboss cron list`,
              success: false,
              id: msg.id,
            };
          }
          return { type: "cronRemove", data: job, success: true, id: msg.id };
        }
        case "cronNext": {
          const times = this.cronJobManager!.next(msg.data?.target, msg.data?.count ?? 3);
          return { type: "cronNext", data: times, success: true, id: msg.id };
        }
        case "cronTrigger": {
          const job = await this.cronJobManager!.trigger(msg.data.target);
          return { type: "cronTrigger", data: job, success: true, id: msg.id };
        }
        case "cloudConnect": {
          // Exchange a dashboard enrollment token for a permanent credential
          // and start the outbound cloud connection from the daemon.
          const { token, url } = msg.data ?? {};
          if (!token) {
            return { type: "error", error: "cloudConnect requires a token", success: false, id: msg.id };
          }
          const cloudUrl = resolveCloudUrl(url);
          const info = await this.cloudAgent!.enroll(String(token), cloudUrl);
          const cfg = this.cloudAgent!.config!;
          this.cloudAgent!.start(cfg);
          return { type: "cloudConnect", data: info, success: true, id: msg.id };
        }
        case "cloudStatus": {
          const status = this.cloudAgent!.status();
          return { type: "cloudStatus", data: status, success: true, id: msg.id };
        }
        case "cloudDisconnect": {
          await this.cloudAgent!.stop({ revoke: true });
          return { type: "cloudDisconnect", data: { ok: true }, success: true, id: msg.id };
        }
        case "daemonReload": {
          if (!this.server) {
            this.server = this.startServer();
          } else {
            this.server.reload(this.getServerOpts() as any);
          }
          return { type: "daemonReload", data: "Daemon reloaded", success: true, id: msg.id };
        }
        case "ping": {
          return {
            type: "pong",
            data: { pid: process.pid, uptime: process.uptime() },
            success: true,
            id: msg.id,
          };
        }
        case "kill": {
          // persist:false is load-bearing: `pboss kill` (and the systemd
          // unit's ExecStop) stops the daemon AND its processes, but the dump
          // must keep describing what was SUPPOSED to run — the next boot (or
          // `systemctl start pboss`) resurrects everything from it. A
          // persisted stop here would resurrect the whole machine as
          // "stopped" after every reboot.
          await pm.stopAll({ persist: false });
          dashboard.stop();
          this.cronJobManager!.stop();
          if (this.cloudAgent) await this.cloudAgent.stop({ revoke: false, quiet: true });
          clearInterval(metricsInterval);
          setTimeout(() => {
            // Remove our own runtime files so a stale socket/PID can never
            // block the next start (client-side cleanup stays as fallback).
            try { unlinkSync(DAEMON_PID_FILE); } catch (err) { ignore("unlink PID file on kill", err); }
            try { if (existsSync(DAEMON_SOCKET)) unlinkSync(DAEMON_SOCKET); } catch (err) { ignore("unlink socket on kill", err); }
            process.exit(0);
          }, 200);
          return { type: "kill", success: true, id: msg.id };
        }
        default:
          return { type: "error", error: `Unknown command: ${(msg as any).type}`, success: false, id: msg.id };
      }

    } catch (err: Error | any) {

      let error = err.message;

      if (this.debugMode) {
        error = `Message: ${err.message}\nStack: ${err.stack}`;
        console.error(err, err.stack);
      }

      return { type: "error", error, success: false, id: msg.id };

    }
  }

} // end class


// ── Entrypoint (spawned by CLI) ───────────────────────────────────────────
if (import.meta.main) {
  (async () => {
    const dm = new Daemon();
    await dm.initialize();
    dm.startServer();
    console.log(`Daemon listening on ${DAEMON_SOCKET}`);
  })().catch((err) => {
    if (err instanceof DaemonConflictError) {
      console.error(`[pboss] cannot start daemon: ${err.message}`);
      process.exit(EXIT_DAEMON_CONFLICT);
    }
    console.error("Daemon startup error:", err);
    process.exit(1);
  });
}
