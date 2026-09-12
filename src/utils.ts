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

import { join } from "path";
import { ALL_DIRS, PBOSS_HOME } from "./constants";
import { mkdir } from "fs/promises";
import { chmodSync, readFileSync } from "fs";
import { ignore } from "./error-handling";
import { totalmem, freemem, loadavg, platform, hostname, uptime } from "node:os";

export const DUMP_FILE = join(PBOSS_HOME, "dump.json");

/**
 * Number of entries currently in the auto-saved dump (0 when absent or
 * unreadable). The CLI reads this BEFORE `pboss start` to detect the
 * fleet's first process — the moment the persistence onboarding hint
 * becomes relevant.
 */
export function dumpEntryCount(): number {
  try {
    const parsed = JSON.parse(readFileSync(DUMP_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch (err) {
    ignore("count dump entries", err);
    return 0;
  }
}

/**
 * Create the pboss home tree. Mode 0700: ~/.pboss contains the daemon's
 * Unix socket (any local user who can REACH the socket can command the
 * daemon — the classic pm2 /tmp/.pm2 local-privilege hole) and cloud.json
 * (the machine credential). Owner-only from the first mkdir on.
 */
export async function ensureDirs() {
  await Promise.all(
    ALL_DIRS.map(async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    })
  );
}

/**
 * Self-heal the permissions of an ~/.pboss created before the 0700 rule
 * (or by a mode-ignoring filesystem): best-effort, never fatal. Unix only —
 * Windows named pipes carry their own ACLs.
 */
export function tightenPbossHomeMode(): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(PBOSS_HOME, 0o700);
  } catch {
    // Not ours to fix (shared dir, exotic fs) — the mkdir mode already
    // covers fresh installs; a deliberate override stays deliberate.
  }
}

const MEMORY_REGEX = /^(\d+(?:\.\d+)?)\s*(K|M|G|T)?B?$/i;
const MEM_MULTIPLIERS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

export function parseMemory(value: string | number): number {
  if (typeof value === "number") return value;
  const match = value.match(MEMORY_REGEX);
  if (!match) throw new Error(`Invalid memory value: ${value}`);
  const num = parseFloat(match[1]!);
  const unit = (match[2] || "").toUpperCase();
  return num * (MEM_MULTIPLIERS[unit] || 1);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").substring(0, 12);
}

/**
 * Parse the dotenv subset of .env syntax (comments, blank lines, optional
 * `export ` prefix, KEY=VALUE, single/double-quoted values). Lines that do
 * not parse are ignored — a malformed .env must never break a spawn, it
 * just contributes nothing for that line.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes (single quotes are
    // literal in dotenv; double quotes keep their content verbatim here —
    // escape interpolation is out of scope for this subset).
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Re-read an application directory's `.env` at (re)spawn time.
 *
 * WHY THIS EXISTS: the env an app runs with was captured ONCE — when the
 * ecosystem config was evaluated at `pboss start` (its `import
 * "dotenv/config"` reads .env at config-load time) — then frozen into the
 * container config and the ~/.pboss/dump.json snapshot. `pboss restart` and
 * post-reboot `resurrect` re-spawned from that snapshot, so EVERY later .env
 * edit was invisible until the process was deleted and started fresh. The
 * production ProcBoss box hit exactly this: the process kept a placeholder
 * `DATABASE_URL` (`…@HOST/DBNAME`) from its first boot and 502'd every
 * request with "Can't reach database server at `HOST:5432`" while the real
 * Neon URL sat unread in .env.
 *
 * Semantics (the contract ProcBoss's .env template already documents):
 * editing `<app cwd>/.env` + `pboss restart` now actually applies — .env
 * values take precedence over the start-time snapshot. Apps without an
 * .env in their cwd see zero change. pboss's own injected vars (the
 * PBOSS_* and BM2_* families) are layered on top by the callers and cannot
 * be hijacked. An
 * unreadable/missing file contributes nothing and never blocks a spawn.
 */
export function readEnvFileOverrides(cwd?: string): Record<string, string> {
  const dir = cwd && cwd.trim() !== "" ? cwd : process.cwd();
  try {
    return parseEnvFile(readFileSync(join(dir, ".env"), "utf8"));
  } catch {
    return {};
  }
}


const ANSI_COLORS: Record<string, string> = {
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[37m", gray: "\x1b[90m", bold: "\x1b[1m",
  dim: "\x1b[2m", reset: "\x1b[0m",
};

export function colorize(text: string, color: string): string {
  return `${ANSI_COLORS[color] || ""}${text}\x1b[0m`;
}

export function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + " ".repeat(len - str.length);
}

export function getCpuCount(): number {
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 1;
}

export function getSystemInfo() {
  return {
    totalMemory: totalmem(),
    freeMemory: freemem(),
    cpuCount: getCpuCount(),
    loadAvg: loadavg(),
    platform: platform(),
    hostname: hostname(),
    uptime: uptime(),
  };
}

export function treeKill(pid: number, signal: string = "SIGTERM"): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      if (process.platform === "win32") {
        try {
          const forceFlag = signal === "SIGKILL" || signal === "SIGTERM" ? ["/F"] : [];
          const proc = Bun.spawn(["taskkill", ...forceFlag, "/T", "/PID", String(pid)], {
            stdout: "ignore",
            stderr: "ignore",
          });
          await proc.exited;
        } catch (err) {
          ignore(`taskkill ${pid} on Windows`, err);
          try {
            process.kill(pid);
          } catch (err2) {
            ignore(`process.kill(${pid}) after taskkill failure`, err2);
          }
        }
        resolve();
        return;
      }

      // Unix: try pgrep -P to find and kill child processes recursively
      try {
        const result = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe" });
        const output = await new Response(result.stdout).text();
        const childPids = output.trim().split("\n").filter(Boolean).map(Number);

        for (const childPid of childPids) {
          await treeKill(childPid, signal);
        }
      } catch (err) {
        // No pgrep (rare minimal systems) — fall through to direct kill.
        ignore(`pgrep -P ${pid} (children may survive)`, err);
      }

      try {
        process.kill(pid, signal as any);
      } catch (err) {
        // Already-dead processes are the normal case during teardown.
        ignore(`kill(${pid}, ${signal}) — process already gone`, err);
      }
    } catch (err) {
      ignore(`treeKill(${pid}, ${signal})`, err);
    }
    resolve();
  });
}

export function parseCron(expression: string): { next: () => Date } {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: ${expression}`);

  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts as [string, string, string, string, string];

  function matchField(value: number, expr: string, _max: number): boolean {
    if (expr === "*") return true;

    for (const part of expr.split(",")) {
      if (part.includes("/")) {
        const [range, step] = part.split("/");
        const stepNum = parseInt(step!);
        const start = range === "*" ? 0 : parseInt(range!);
        if ((value - start) % stepNum === 0 && value >= start) return true;
      } else if (part.includes("-")) {
        const [lo, hi] = part.split("-").map(Number);
        if (value >= lo! && value <= hi!) return true;
      } else {
        if (value === parseInt(part)) return true;
      }
    }
    return false;
  }

  return {
    next(): Date {
      const now = new Date();
      const candidate = new Date(now);
      candidate.setSeconds(0, 0);
      candidate.setMinutes(candidate.getMinutes() + 1);

      for (let i = 0; i < 525600; i++) {
        const min = candidate.getMinutes();
        const hour = candidate.getHours();
        const dom = candidate.getDate();
        const mon = candidate.getMonth() + 1;
        const dow = candidate.getDay();

        if (
          matchField(min, minExpr, 59) &&
          matchField(hour, hourExpr, 23) &&
          matchField(dom, domExpr, 31) &&
          matchField(mon, monExpr, 12) &&
          matchField(dow, dowExpr, 6)
        ) {
          return candidate;
        }

        candidate.setMinutes(candidate.getMinutes() + 1);
      }

      throw new Error("Could not find next cron time");
    },
  };
}
