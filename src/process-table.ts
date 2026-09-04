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

import Table from "cli-table3";
import type { ProcessState, ProcessStatus, ExecMode } from "./types";
import { color } from "./colors";
import { colorize } from "./utils";

// ---------- Helpers ----------

function h(label: string) {
  return color(label, "cyan");
}

function prettyStatus(status: ProcessStatus) {
  switch (status) {
    case "online": return color("● online", "green");
    case "stopping": return color("● stopping", "yellow");
    case "stopped": return color("● stopped", "dim");
    case "errored": return color("● errored", "red");
    case "launching": return color("● launching", "cyan");
    case "waiting-restart": return color("● waiting", "yellow");
    case "one-launch-status": return color("● once", "magenta");
    default: return status;
  }
}

function prettyCpu(cpu: number) {
  const v = `${cpu.toFixed(1)}%`;
  if (cpu > 85) return color(v, "red");
  if (cpu > 50) return color(v, "yellow");
  return color(v, "green");
}

function prettyMemory(mem: number) {
  const formatted = formatBytes(mem);
  return formatted;
}

function highlightName(p: ProcessState) {
  const env = p.pboss_env || p.bm2_env;
  if (env && env.unstable_restarts > 0) return color(p.name, "yellow");
  return p.name;
}

function formatUptime(startTime: number) {
  if (!startTime) return "-";
  const diff = Date.now() - startTime;
  const sec = Math.floor(diff / 1000) % 60;
  const min = Math.floor(diff / 1000 / 60) % 60;
  const hr = Math.floor(diff / 1000 / 60 / 60);
  return `${hr}h ${min}m ${sec}s`;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0b";
  const sizes = ["b", "kb", "mb", "gb"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)}${sizes[i]}`;
}

function minimalBorders() {
  return {
    top: "─", "top-mid": "┬", "top-left": "┌", "top-right": "┐",
    bottom: "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘",
    left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼",
    right: "│", "right-mid": "┤", middle: "│"
  };
}

// ---------- Table Printer ----------

export function printProcessTable(processes: ProcessState[]) {
  
  console.log("");
  console.log(color("ProcBoss — Bun Process Manager", "bold"));
  console.log(color("─────────────────────────────────────────────", "dim"));
  console.log("");

  if (!processes?.length) {
    console.log(color("No processes running\n", "dim"));
    return;
  }

 // const sorted = [...processes].sort((a, b) => a.pm_id - b.pm_id);

  const table = new Table({
    head: [
      h("id"), h("name"), h("namespace"), h("version"), h("mode"), 
      h("pid"), h("uptime"), h("↺"), h("status"), h("cpu"), h("mem")
    ],
    colAligns: ["right","left","left","left","left","right","right","right","left","right","right"],
    style: { border: ["dim"] },
    chars: minimalBorders(),
  });
  
  //console.log("processes===>", processes)

  for (const p of processes) {
    const env = p.pboss_env || p.bm2_env;
    const cpu = p.monit?.cpu ?? 0;
    const mem = p.monit?.memory ?? 0;
    const uptime = (p.status === "online" && env)
      ? formatUptime(env.pm_uptime)
      : "-";

    table.push([
      p.pm_id,
      highlightName(p),
      p.namespace || "default",
      env?.version ?? "-",
      env?.execMode ?? "fork",
      p.pid ?? "-",
      uptime,
      env?.restart_time ?? 0,
      prettyStatus(p.status),
      prettyCpu(cpu),
      prettyMemory(mem)
    ]);
  }

  console.log(table.toString());
  console.log("");
}


export function liveWatchProcess(processes: ProcessState[], interval = 5_000) {
  let sortBy: "cpu" | "mem" | "uptime" | "default" = "default";

  // Clear console helper
  const clear = () => process.stdout.write("\x1Bc");

  // Helper to get sorted processes
  const getSortedProcesses = () => {
    return [...processes].sort((a, b) => {
      const envA = a.pboss_env || a.bm2_env;
      const envB = b.pboss_env || b.bm2_env;
      switch (sortBy) {
        case "cpu": return (b.monit.cpu ?? 0) - (a.monit.cpu ?? 0);
        case "mem": return (b.monit.memory ?? 0) - (a.monit.memory ?? 0);
        case "uptime":
          const uptimeA = (a.status === "online" && envA) ? Date.now() - envA.pm_uptime : 0;
          const uptimeB = (b.status === "online" && envB) ? Date.now() - envB.pm_uptime : 0;
          return uptimeB - uptimeA;
        default: return a.pm_id - b.pm_id;
      }
    });
  };

  // Render table
  const render = () => {
    clear();
    
    printProcessTable(getSortedProcesses());
    
    console.log(color("─".repeat(50), "dim"));
    console.log(color("Keyboard Shortcuts", "cyan"));
    console.log(color("─".repeat(50), "dim"));
    
    console.log(`${colorize("R", "green")}: Manual Reload`);
    console.log(`${colorize("C", "green")}: Sort By CPU`);
    console.log(`${colorize("M", "green")}: Sort By Memory`);
    console.log(`${colorize("U", "green")}: Sort By Uptime`);
    console.log(`${colorize("Q", "green")}: Quit`);
    
    console.log(color("─".repeat(50), "dim"));
    
    console.log(`Current Sort: ${sortBy.toUpperCase()}\n`);
  };

  // Initial render
  render();

  // Auto-refresh interval
  const timer = setInterval(render, interval);

  // Enable raw mode for keypress
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (key) => {
      const k = key.toString().toLowerCase();
      switch (k) {
        case "\u0003": // Ctrl+C
        case "q":      // Quit
          clearInterval(timer);
          process.exit();
          break;
        case "r":      // Reload
          render();
          console.log("[Table reloaded manually]");
          break;
        case "c":      // Sort by CPU
          sortBy = "cpu";
          render();
          break;
        case "m":      // Sort by Memory
          sortBy = "mem";
          render();
          break;
        case "u":      // Sort by Uptime
          sortBy = "uptime";
          render();
          break;
      }
    });
  }
}
