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
import { getDashboardHTML } from "./dashboard-ui";
import { DASHBOARD_PORT, METRICS_PORT } from "./constants";
import { ignore } from "./error-handling";
import type { Server, ServerWebSocket } from "bun";

export class Dashboard {

  private server: Server<unknown> | null = null;
  private metricsServer: Server<unknown> | null = null;

  private clients: Set<ServerWebSocket<unknown>> = new Set();
  private pm: ProcessManager;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(pm: ProcessManager) {
    this.pm = pm;
  }

  start(port: number = DASHBOARD_PORT, metricsPort: number = METRICS_PORT) {
    // Dashboard + WebSocket server
    this.server = Bun.serve<unknown>({
      port,
      fetch: (req, server) => {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: undefined })) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/api/processes") {
          return Response.json(this.pm.list());
        }

        if (url.pathname === "/api/metrics") {
          const metrics = this.pm.monitor.getLatest();
          return Response.json(metrics);
        }

        if (url.pathname === "/api/metrics/history") {
          const seconds = parseInt(url.searchParams.get("seconds") || "300");
          return Response.json(this.pm.getMetricsHistory(seconds));
        }

        if (url.pathname === "/api/prometheus" || url.pathname === "/metrics") {
          return new Response(this.pm.getPrometheusMetrics(), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }

        // Action endpoints
        if (req.method === "POST") {
          return this.handleAction(url.pathname, req);
        }

        // Serve dashboard HTML
        return new Response(getDashboardHTML(), {
          headers: { "Content-Type": "text/html" },
        });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          // Send initial state
          const state = {
            processes: this.pm.list(),
            metrics: this.pm.monitor.getLatest(),
          };
          ws.send(JSON.stringify({ type: "state", data: state }));
        },
        message: async (ws, message) => {
          try {
            const msg = JSON.parse(String(message));
            await this.handleWsMessage(ws, msg);
          } catch (err) {
            // Malformed/mid-disconnect client frames are noise, not errors.
            ignore("handle dashboard ws message", err);
          }
        },
        close: (ws) => {
          this.clients.delete(ws);
        },
      },
    });

    // Separate Prometheus metrics server
    this.metricsServer = Bun.serve({
      port: metricsPort,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/metrics") {
          return new Response(this.pm.getPrometheusMetrics(), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("ProcBoss Metrics Server\nGET /metrics for Prometheus format", {
          status: 200,
        });
      },
    });

    // Periodic broadcast
    this.updateInterval = setInterval(async () => {
      await this.pm.getMetrics(); // Collect snapshot
      this.broadcast();
    }, 2000);

    console.log(`[pboss] Dashboard running at http://localhost:${port}`);
    console.log(`[pboss] Prometheus metrics at http://localhost:${metricsPort}/metrics`);
  }

  private async handleAction(pathname: string, req: Request): Promise<Response> {
    try {

        const body = (await req.json()) as { target?: string; count?: number };

      switch (pathname) {
        case "/api/restart":
          return Response.json(await this.pm.restart(body.target || "all"));
        case "/api/stop":
          return Response.json(await this.pm.stop(body.target || "all"));
        case "/api/reload":
          return Response.json(await this.pm.reload(body.target || "all"));
        case "/api/delete":
          return Response.json(await this.pm.del(body.target!));
        case "/api/scale":
          return Response.json(await this.pm.scale(body.target!, body.count!));
        case "/api/flush":
          await this.pm.flushLogs(body.target);
          return Response.json({ success: true });
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  private async handleWsMessage(ws: ServerWebSocket<unknown>, msg: any) {
    switch (msg.type) {
      case "getState": {
        const state = {
          processes: this.pm.list(),
          metrics: this.pm.monitor.getLatest(),
        };
        ws.send(JSON.stringify({ type: "state", data: state }));
        break;
      }
      case "getLogs": {
        const logs = await this.pm.getLogs(msg.data.target, msg.data.lines || 50);
        ws.send(JSON.stringify({ type: "logs", data: logs }));
        break;
      }
      case "restart":
        await this.pm.restart(msg.data.target);
        break;
      case "stop":
        await this.pm.stop(msg.data.target);
        break;
      case "reload":
        await this.pm.reload(msg.data.target);
        break;
      case "scale":
        await this.pm.scale(msg.data.target, msg.data.count);
        break;
    }
  }

  private broadcast() {
    const state = {
      processes: this.pm.list(),
      metrics: this.pm.monitor.getLatest(),
    };
    const message = JSON.stringify({ type: "state", data: state });
    for (const client of this.clients) {
      try {
        client.send(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  stop() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.server) this.server.stop();
    if (this.metricsServer) this.metricsServer.stop();
    this.clients.clear();
  }
}
