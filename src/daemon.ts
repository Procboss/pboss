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
import {
  DAEMON_SOCKET,
  DAEMON_PID_FILE,
  DASHBOARD_PORT,
  METRICS_PORT,
} from "./constants";
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

    await ensureDirs();

    this.daemonEnabled = _daemonEnabled;
    this.pm = new ProcessManager();
    this.dashboard = new Dashboard(this.pm);
    this.moduleManager = new ModuleManager(this.pm);

    this.args = process.argv.slice(2);
    this.debugMode = this.args.includes("--debug");

    if (_daemonEnabled) {
      // Check if an existing daemon is already alive on this machine
      if (existsSync(DAEMON_PID_FILE)) {
        try {
          const pidText = readFileSync(DAEMON_PID_FILE, "utf-8").trim();
          if (pidText) {
            const existingPid = parseInt(pidText);
            if (existingPid !== process.pid) {
              process.kill(existingPid, 0); // throws if process does not exist
              if (existsSync(DAEMON_SOCKET)) {
                // Another daemon process is already active on this machine
                return;
              }
            }
          }
        } catch {
          // Stale PID file, safe to overwrite
        }
      }

      // Clean up existing socket
      try {
        if (existsSync(DAEMON_SOCKET)) unlinkSync(DAEMON_SOCKET);
      } catch {}
      try {
        const sock = Bun.file(DAEMON_SOCKET);
        if (await sock.exists()) await sock.delete();
      } catch {}

      // Write PID file
      await Bun.write(DAEMON_PID_FILE, String(process.pid));
    }

    // Load modules
    await this.moduleManager.loadAll();

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
          return { type: "ecosystem", data: states, success: true, id: msg.id };
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
          await pm.stopAll();
          dashboard.stop();
          clearInterval(metricsInterval);
          setTimeout(() => process.exit(0), 200);
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
    console.error("Daemon startup error:", err);
    process.exit(1);
  });
}
