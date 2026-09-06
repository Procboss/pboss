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
 
import type { MetricSnapshot, ProcessState } from "./types";
import { getSystemInfo } from "./utils";
import { METRICS_DIR } from "./constants";
import { join } from "path";
import pidusage from "pidusage";
import { readdirSync } from "node:fs";

export class Monitor {
  private history: MetricSnapshot[] = [];
  private maxHistory = 3600; // 1 hour at 1s intervals

  async collectProcessMetrics(
    pid: number
  ): Promise<{ memory: number; cpu: number; handles?: number }> {
    try {
      if (process.platform === "linux") {
        const statusFile = Bun.file(`/proc/${pid}/status`);
        const statFile = Bun.file(`/proc/${pid}/stat`);

        let memory = 0;
        let cpu = 0;
        let handles: number | undefined;

        if (await statusFile.exists()) {
          const content = await statusFile.text();
          const vmRss = content.match(/VmRSS:\s+(\d+)\s+kB/);
          
          if (vmRss) memory = parseInt(vmRss[1]!) * 1024;
         
          // Count file descriptors
          try {
            handles = readdirSync(`/proc/${pid}/fd`).length;
          } catch {}
        }

        if (await statFile.exists()) {
          const stat = await statFile.text();
          const parts = stat.split(" ");
          
          const utime = parseInt(parts[13]!) || 0;
          const stime = parseInt(parts[14]!) || 0;
          
          // Simplified CPU calculation
          cpu = (utime + stime) / 100;
        }

        return { memory, cpu, handles };
      } else {
        // Windows, macOS, and cross-platform fallback
        const stats = await pidusage(pid);
        return {
          memory: stats.memory,
          cpu: stats.cpu,
        };
      }
    } catch {}

    return { memory: 0, cpu: 0 };
  }

  async takeSnapshot(processes: ProcessState[]): Promise<MetricSnapshot> {
    const system = getSystemInfo();
    const snapshot: MetricSnapshot = {
      timestamp: Date.now(),
      processes: processes.map((p) => {
        const env = p.pboss_env || p.bm2_env;
        return {
          id: p.id,
          name: p.name,
          pid: p.pid,
          cpu: p.monit.cpu,
          memory: p.monit.memory,
          eventLoopLatency: p.monit.eventLoopLatency,
          handles: p.monit.handles,
          status: p.status,
          restarts: env?.restart_time ?? 0,
          uptime: (env?.status === "online" && env?.pm_uptime) ? Date.now() - env.pm_uptime : 0,
        };
      }),
      system: {
        totalMemory: system.totalMemory,
        freeMemory: system.freeMemory,
        cpuCount: system.cpuCount,
        loadAvg: system.loadAvg,
        platform: system.platform,
      },
    };

    this.history.push(snapshot);
    while (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return snapshot;
  }

  getHistory(seconds: number = 300): MetricSnapshot[] {
    const cutoff = Date.now() - seconds * 1000;
    return this.history.filter((s) => s.timestamp >= cutoff);
  }

  getLatest(): MetricSnapshot | null {
    return this.history.length > 0 ? this.history[this.history.length - 1]! : null;
  }

  async saveMetrics(): Promise<void> {
    const filePath = join(METRICS_DIR, `metrics-${Date.now()}.json`);
    await Bun.write(filePath, JSON.stringify(this.history.slice(-300)));
  }

  generatePrometheusMetrics(processes: ProcessState[]): string {
    const lines: string[] = [];

    lines.push("# HELP pboss_process_cpu CPU usage percentage");
    lines.push("# TYPE pboss_process_cpu gauge");
    for (const p of processes) {
      lines.push(`pboss_process_cpu{name="${p.name}",id="${p.pm_id}"} ${p.monit.cpu}`);
    }

    lines.push("# HELP pboss_process_memory_bytes Memory usage in bytes");
    lines.push("# TYPE pboss_process_memory_bytes gauge");
    for (const p of processes) {
      lines.push(`pboss_process_memory_bytes{name="${p.name}",id="${p.pm_id}"} ${p.monit.memory}`);
    }

    lines.push("# HELP pboss_process_restarts_total Total restart count");
    lines.push("# TYPE pboss_process_restarts_total counter");
    for (const p of processes) {
      const env = p.pboss_env || p.bm2_env;
      lines.push(`pboss_process_restarts_total{name="${p.name}",id="${p.pm_id}"} ${env?.restart_time ?? 0}`);
    }

    lines.push("# HELP pboss_process_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE pboss_process_uptime_seconds gauge");
    for (const p of processes) {
      const env = p.pboss_env || p.bm2_env;
      const uptime = (env?.status === "online" && env?.pm_uptime)
        ? (Date.now() - env.pm_uptime) / 1000
        : 0;
      lines.push(`pboss_process_uptime_seconds{name="${p.name}",id="${p.pm_id}"} ${uptime.toFixed(0)}`);
    }

    lines.push("# HELP pboss_process_status Process status (1=online)");
    lines.push("# TYPE pboss_process_status gauge");
    for (const p of processes) {
      lines.push(`pboss_process_status{name="${p.name}",id="${p.pm_id}",status="${p.status}"} ${p.status === "online" ? 1 : 0}`);
    }

    const sys = getSystemInfo();
    lines.push("# HELP pboss_system_memory_total_bytes Total system memory");
    lines.push("# TYPE pboss_system_memory_total_bytes gauge");
    lines.push(`pboss_system_memory_total_bytes ${sys.totalMemory}`);

    lines.push("# HELP pboss_system_memory_free_bytes Free system memory");
    lines.push("# TYPE pboss_system_memory_free_bytes gauge");
    lines.push(`pboss_system_memory_free_bytes ${sys.freeMemory}`);

    lines.push("# HELP pboss_system_load_average System load average");
    lines.push("# TYPE pboss_system_load_average gauge");
    lines.push(`pboss_system_load_average{period="1m"} ${sys.loadAvg[0]}`);
    lines.push(`pboss_system_load_average{period="5m"} ${sys.loadAvg[1]}`);
    lines.push(`pboss_system_load_average{period="15m"} ${sys.loadAvg[2]}`);

    return lines.join("\n") + "\n";
  }
}
