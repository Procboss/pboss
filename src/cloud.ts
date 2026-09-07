/**
 * ProcBoss (pboss) — Cloud Agent
 *
 * Links this machine's pboss daemon to ProcBoss Cloud over an
 * OUTBOUND-ONLY connection (SSE command channel + HTTPS state posts).
 * The cloud never reaches into the user's network.
 *
 * Enrollment: `pboss cloud connect pbc_…` (single-use token minted in the
 * dashboard) is exchanged once for a permanent per-server credential stored
 * in `~/.pboss/cloud.json` (0600). Reconnection is automatic with backoff.
 *
 * Wire protocol is mirrored on the cloud side (src/lib/cloud/protocol.ts).
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { platform, arch, hostname, totalmem, freemem, loadavg, cpus } from "node:os";
import { VERSION, CLOUD_FILE, CLOUD_DEFAULT_URL, CLOUD_REPORT_INTERVAL_MS } from "./constants";
import { getSystemInfo, colorize } from "./utils";
import { ignore } from "./error-handling";
import type { ProcessManager } from "./process-manager";
import type { ProcessState, StartOptions, LogItem } from "./types";

/* ── config file ──────────────────────────────────────────────────────── */

export interface CloudConfig {
  cloudUrl: string;
  serverId: string;
  serverSecret: string;
  serverName?: string;
}

export function loadCloudConfig(): CloudConfig | null {
  try {
    if (!existsSync(CLOUD_FILE)) return null;
    const raw = JSON.parse(readFileSync(CLOUD_FILE, "utf-8")) as Partial<CloudConfig>;
    if (!raw.cloudUrl || !raw.serverId || !raw.serverSecret) return null;
    return {
      cloudUrl: String(raw.cloudUrl).replace(/\/+$/, ""),
      serverId: String(raw.serverId),
      serverSecret: String(raw.serverSecret),
      serverName: raw.serverName ? String(raw.serverName) : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCloudConfig(cfg: CloudConfig): void {
  writeFileSync(CLOUD_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(CLOUD_FILE, 0o600);
  } catch {
    /* best-effort — some filesystems reject chmod */
  }
}

export function clearCloudConfig(): void {
  try {
    if (existsSync(CLOUD_FILE)) unlinkSync(CLOUD_FILE);
  } catch (err) {
    ignore(`unlink cloud config ${CLOUD_FILE}`, err);
  }
}

export function resolveCloudUrl(explicit?: string): string {
  const url = (explicit || process.env.PBOSS_CLOUD_URL || CLOUD_DEFAULT_URL).trim();
  return url.replace(/\/+$/, "");
}

/* ── wire types (mirror of the cloud's protocol.ts) ───────────────────── */

export type CloudProcessStatus = "online" | "stopped" | "errored";

export interface CloudProcessReport {
  name: string;
  script: string;
  pmId: number;
  status: CloudProcessStatus;
  pid?: number;
  cpu: number;
  mem: number;
  restarts: number;
  crashes: number;
  uptimeSec: number;
}

export interface CloudEventReport {
  kind: "crash" | "restart" | "online" | "stopped";
  process: string;
  at: number;
  detail?: string;
}

export interface CloudStateReport {
  serverId: string;
  status: "online" | "degraded" | "offline";
  hostname: string;
  os: string;
  arch: string;
  bunVersion: string;
  agentVersion: string;
  cpu: number;
  memUsed: number;
  memTotal: number;
  processes: CloudProcessReport[];
  events: CloudEventReport[];
}

export interface CloudCommand {
  id: string;
  type:
    | "process.list"
    | "process.start"
    | "process.stop"
    | "process.restart"
    | "process.delete"
    | "process.logs"
    | "server.info";
  payload: Record<string, unknown>;
}

export interface CloudCommandResult {
  commandId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/* ── pure mapping helpers (unit-tested) ───────────────────────────────── */

export function mapProcessState(p: ProcessState): CloudProcessReport {
  const status: CloudProcessStatus =
    p.status === "online" || p.status === "launching" || p.status === "waiting-restart"
      ? "online"
      : p.status === "errored"
        ? "errored"
        : "stopped";
  const env = p.pboss_env ?? p.bm2_env;
  return {
    name: p.name,
    script: env?.script ?? "",
    pmId: p.pm_id ?? 0,
    status,
    pid: p.pid,
    cpu: Math.round(p.monit?.cpu ?? 0),
    mem: Math.round((p.monit?.memory ?? 0) / (1024 * 1024)),
    restarts: env?.restart_time ?? 0,
    crashes: env?.unstable_restarts ?? 0,
    // pm_uptime is the epoch-ms START timestamp (process-container sets it to
    // startedAt) — same math the CLI's own uptime column uses: now - start.
    uptimeSec: Math.max(0, Math.round((Date.now() - (env?.pm_uptime ?? Date.now())) / 1000)),
  };
}

export function systemSnapshot(): { cpu: number; memUsed: number; memTotal: number } {
  const cores = cpus().length || 1;
  const load = loadavg()[0] ?? 0;
  const cpu = Math.max(0, Math.min(100, Math.round((load / cores) * 100)));
  const total = Math.round(totalmem() / (1024 * 1024));
  const used = Math.max(0, Math.round((totalmem() - freemem()) / (1024 * 1024)));
  return { cpu, memUsed: used, memTotal: total };
}

export function buildStateReport(
  serverId: string,
  processes: ProcessState[],
): CloudStateReport {
  const sys = systemSnapshot();
  return {
    serverId,
    status: "online",
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    bunVersion: Bun.version,
    agentVersion: `pboss/${VERSION}`,
    cpu: sys.cpu,
    memUsed: sys.memUsed,
    memTotal: sys.memTotal,
    processes: processes.map(mapProcessState),
    events: [],
  };
}

/** Derive human-meaningful events from two consecutive snapshots. */
export function diffEvents(
  prev: Map<string, CloudProcessReport>,
  next: CloudProcessReport[],
): CloudEventReport[] {
  const events: CloudEventReport[] = [];
  const now = Date.now();
  for (const p of next) {
    const before = prev.get(p.name);
    if (!before) {
      events.push({ kind: "online", process: p.name, at: now, detail: "process discovered" });
      continue;
    }
    if (before.status !== "errored" && p.status === "errored") {
      events.push({ kind: "crash", process: p.name, at: now, detail: "process errored" });
    } else if (before.status === "online" && p.status === "stopped") {
      events.push({ kind: "stopped", process: p.name, at: now, detail: "process stopped" });
    } else if (
      (before.status === "stopped" || before.status === "errored") &&
      p.status === "online"
    ) {
      events.push({ kind: "online", process: p.name, at: now, detail: "process came online" });
    }
    if (p.restarts > before.restarts) {
      events.push({
        kind: "restart",
        process: p.name,
        at: now,
        detail: `restart #${p.restarts}`,
      });
    }
  }
  return events.slice(0, 50);
}

/** Rebuild StartOptions from a (stopped) process's persisted env. */
export function startOptionsFromState(p: ProcessState): StartOptions {
  const env = p.pboss_env ?? p.bm2_env;
  return {
    name: p.name,
    script: env?.script ?? "",
    args: env?.args ?? [],
    cwd: env?.cwd,
    env: env?.env,
    instances: env?.instances,
    execMode: env?.execMode,
    autorestart: env?.autorestart,
    maxRestarts: env?.maxRestarts,
    minUptime: env?.minUptime,
    maxMemoryRestart: env?.maxMemoryRestart,
    watch: env?.watch,
    ignoreWatch: env?.ignoreWatch,
    interpreter: env?.interpreter,
    interpreterArgs: env?.interpreterArgs,
    mergeLogs: env?.mergeLogs,
    raw: env?.raw,
    logDateFormat: env?.logDateFormat,
    errorFile: env?.errorFile,
    outFile: env?.outFile,
    killTimeout: env?.killTimeout,
    restartDelay: env?.restartDelay,
    port: env?.port,
  };
}

/* ── SSE frame parser (unit-tested) ───────────────────────────────────── */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";
  private event = "";
  private dataLines: string[] = [];

  /** Feed a chunk; returns complete events and keeps partials buffered. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith(":")) continue; // comment / keepalive
      if (line === "") {
        if (this.dataLines.length > 0 || this.event) {
          out.push({ event: this.event || "message", data: this.dataLines.join("\n") });
        }
        this.event = "";
        this.dataLines = [];
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.dataLines.push(value);
      // retry/id fields are ignored
    }
    return out;
  }
}

/* ── the agent ────────────────────────────────────────────────────────── */

export interface CloudAgentStatus {
  configured: boolean;
  cloudUrl: string | null;
  serverId: string | null;
  serverName: string | null;
  connected: boolean;
  streamState: "connecting" | "connected" | "backoff" | "stopped";
  reconnects: number;
  lastReportAt: number | null;
  lastReportAgeMs: number | null;
  processes: number;
  lastError: string | null;
}

export class CloudAgent {
  private pm: ProcessManager;
  private cfg: CloudConfig | null = null;
  private running = false;
  private streamAbort: AbortController | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private reconnects = 0;
  private streamState: CloudAgentStatus["streamState"] = "stopped";
  private lastReport: CloudStateReport | null = null;
  private lastReportAt: number | null = null;
  private lastError: string | null = null;
  private lastSnapshot = new Map<string, CloudProcessReport>();
  private reportNow: (() => void) | null = null;
  private retry409Armed = false;

  constructor(pm: ProcessManager) {
    this.pm = pm;
  }

  get config(): CloudConfig | null {
    return this.cfg;
  }

  status(): CloudAgentStatus {
    const cfg = this.cfg;
    return {
      configured: Boolean(cfg),
      cloudUrl: cfg?.cloudUrl ?? null,
      serverId: cfg?.serverId ?? null,
      serverName: cfg?.serverName ?? null,
      connected: this.streamState === "connected",
      streamState: this.streamState,
      reconnects: this.reconnects,
      lastReportAt: this.lastReportAt,
      lastReportAgeMs: this.lastReportAt ? Date.now() - this.lastReportAt : null,
      processes: this.lastReport?.processes.length ?? 0,
      lastError: this.lastError,
    };
  }

  /** Link this machine: exchange the enrollment token for a credential. */
  async enroll(token: string, cloudUrl: string): Promise<{ serverId: string; serverName: string }> {
    const res = await fetch(`${cloudUrl}/api/agent/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        bunVersion: Bun.version,
        pbossVersion: VERSION,
      }),
    });
    const body = (await res.json().catch((err: unknown) => {
      ignore("parse enrollment response JSON", err);
      return {} as Record<string, string>;
    })) as {
      serverId?: string;
      serverSecret?: string;
      serverName?: string;
      error?: string;
    };
    if (!res.ok || !body.serverId || !body.serverSecret) {
      throw new Error(body.error ?? `enrollment failed (HTTP ${res.status})`);
    }
    const cfg: CloudConfig = {
      cloudUrl,
      serverId: body.serverId,
      serverSecret: body.serverSecret,
      serverName: body.serverName,
    };
    saveCloudConfig(cfg);
    this.cfg = cfg;
    return { serverId: cfg.serverId, serverName: cfg.serverName ?? cfg.serverId };
  }

  /** Start (or restart) the connection loops from a saved config. */
  start(cfg: CloudConfig): void {
    this.stop({ revoke: false, quiet: true });
    this.cfg = cfg;
    this.running = true;
    this.streamState = "connecting";
    console.log(
      colorize(`☁  cloud: connecting to ${cfg.cloudUrl} (${cfg.serverName ?? cfg.serverId})`, "cyan")
    );
    void this.runStream();
    this.reportTimer = setInterval(() => this.reportNow?.(), CLOUD_REPORT_INTERVAL_MS);
    this.reportNow = () => void this.reportState().catch((err: unknown) => ignore("cloud state report (interval)", err));
    void this.reportState().catch((err: unknown) => ignore("cloud state report (initial)", err));
  }

  /** Stop the agent. `revoke` also kills the credential server-side. */
  async stop(opts: { revoke: boolean; quiet?: boolean }): Promise<void> {
    this.running = false;
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.reportNow = null;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.streamState = "stopped";
    if (opts.revoke && this.cfg) {
      const cfg = this.cfg;
      try {
        await fetch(`${cfg.cloudUrl}/api/agent/disconnect`, {
          method: "POST",
          headers: this.authHeader(cfg),
        });
      } catch {
        /* network gone — the credential file is cleared below anyway */
      }
      clearCloudConfig();
      if (!opts.quiet) {
        console.log(colorize("☁  cloud: credential revoked, this machine is unlinked", "cyan"));
      }
    }
    this.cfg = null;
  }

  private authHeader(cfg: CloudConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${cfg.serverId}.${cfg.serverSecret}`,
      "Content-Type": "application/json",
    };
  }

  /* ── command channel (SSE, outbound) ───────────────────────────────── */

  private async runStream(): Promise<void> {
    while (this.running && this.cfg) {
      const cfg = this.cfg;
      this.streamAbort = new AbortController();
      try {
        this.streamState = "connecting";
        const res = await fetch(`${cfg.cloudUrl}/api/agent/stream`, {
          headers: this.authHeader(cfg),
          signal: this.streamAbort.signal,
        });
        if (res.status === 401) {
          await this.handleRevoked();
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`stream HTTP ${res.status}`);
        }
        // stream opened — reset backoff and start reporting
        this.streamState = "connected";
        this.backoffMs = 1000;
        this.lastError = null;
        console.log(
          colorize(`☁  cloud: connected — command channel live`, "green")
        );

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
            if (ev.event === "command") {
              const cmd = this.safeJson(ev.data) as CloudCommand | null;
              if (cmd?.id && cmd.type) {
                void this.handleCommand(cmd);
              }
            }
            // "hello" and keepalive comments need no handling
          }
        }
        // server closed the stream gracefully — reconnect immediately
        this.streamState = "connecting";
      } catch (err: any) {
        if (!this.running) return;
        if (err?.name === "AbortError") return;
        this.lastError = err?.message ?? String(err);
      }
      if (!this.running || !this.cfg) return;
      this.streamState = "backoff";
      this.reconnects++;
      await sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
  }

  private async handleRevoked(): Promise<void> {
    this.running = false;
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.streamAbort?.abort();
    this.streamState = "stopped";
    clearCloudConfig();
    this.cfg = null;
    console.error(
      colorize(
        "☁  cloud: credential revoked from the dashboard — re-link with `pboss cloud connect <token>`",
        "yellow"
      )
    );
  }

  /* ── state reporting (POST, every 10s and after each command) ──────── */

  private async reportState(): Promise<void> {
    if (!this.running || !this.cfg) return;
    const cfg = this.cfg;
    const states = this.pm.list();
    const report = buildStateReport(cfg.serverId, states);
    report.events = diffEvents(this.lastSnapshot, report.processes);
    this.lastSnapshot = new Map(report.processes.map((p) => [p.name, p]));
    this.lastReport = report;

    try {
      const res = await fetch(`${cfg.cloudUrl}/api/agent/state`, {
        method: "POST",
        headers: this.authHeader(cfg),
        body: JSON.stringify(report),
      });
      if (res.status === 401) {
        await this.handleRevoked();
        return;
      }
      if (res.status === 409 && !this.retry409Armed) {
        // stream not registered yet (race between start() and the first
        // post) — retry once shortly instead of waiting a full interval
        this.retry409Armed = true;
        setTimeout(() => {
          this.retry409Armed = false;
          void this.reportState().catch((err: unknown) => ignore("cloud state report (409 retry)", err));
        }, 1500);
        return;
      }
      this.lastReportAt = Date.now();
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
    }
  }

  /* ── command execution (local, against this daemon's process engine) ── */

  private async handleCommand(cmd: CloudCommand): Promise<void> {
    const cfg = this.cfg;
    if (!cfg) return;
    let result: CloudCommandResult;
    try {
      const data = await this.executeCommand(cmd);
      result = { commandId: cmd.id, success: true, data };
    } catch (err: any) {
      result = { commandId: cmd.id, success: false, error: err?.message ?? String(err) };
    }
    try {
      await fetch(`${cfg.cloudUrl}/api/agent/command-result`, {
        method: "POST",
        headers: this.authHeader(cfg),
        body: JSON.stringify(result),
      });
    } catch (err) {
      // The dashboard's command dispatch times out on its own — but record
      // why the result never arrived.
      ignore("post command result to cloud", err);
    }
    // the dashboard expects fresh state right after a command
    await this.reportState().catch((err: unknown) => ignore("cloud state report (post-command)", err));
  }

  private async executeCommand(cmd: CloudCommand): Promise<unknown> {
    const target = typeof cmd.payload?.target === "string" ? cmd.payload.target : "";
    switch (cmd.type) {
      case "process.list":
        return this.pm.list().map(mapProcessState);

      case "process.start": {
        if (!target) throw new Error("process.start requires a target");
        const state = this.findState(target);
        if (!state) throw new Error(`no process named "${target}"`);
        if (state.status === "online") throw new Error(`"${target}" is already online`);
        const opts = startOptionsFromState(state);
        return (await this.pm.start(opts)).map(mapProcessState);
      }

      case "process.stop":
        if (!target) throw new Error("process.stop requires a target");
        return (await this.pm.stop(target)).map(mapProcessState);

      case "process.restart":
        if (!target) throw new Error("process.restart requires a target");
        return (await this.pm.restart(target)).map(mapProcessState);

      case "process.delete":
        if (!target) throw new Error("process.delete requires a target");
        return (await this.pm.del(target)).map(mapProcessState);

      case "process.logs": {
        const lines = Math.min(500, Math.max(10, Number(cmd.payload?.lines) || 200));
        const logs: LogItem[] = await this.pm.getLogs(target || "all", lines);
        return logs;
      }

      case "server.info": {
        const sys = getSystemInfo();
        return {
          hostname: sys.hostname,
          platform: sys.platform,
          cpuCount: sys.cpuCount,
          totalMemory: sys.totalMemory,
          freeMemory: sys.freeMemory,
          loadAvg: sys.loadAvg,
          uptime: sys.uptime,
          bunVersion: Bun.version,
          pbossVersion: VERSION,
          processes: this.pm.list().length,
          cloud: { serverId: this.cfg!.serverId, url: this.cfg!.cloudUrl },
        };
      }

      default:
        throw new Error(`unknown command type: ${(cmd as CloudCommand).type}`);
    }
  }

  private findState(target: string): ProcessState | undefined {
    const list = this.pm.list();
    return list.find(
      (p) => p.name === target || String(p.pm_id) === target || String(p.id) === target
    );
  }

  private safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
