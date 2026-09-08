/**
 * ProcBoss (pboss) — Cloud Agent
 *
 * Links this machine's pboss daemon to ProcBoss Cloud over an
 * OUTBOUND-ONLY WebSocket connection (/ws/agent). The cloud never reaches
 * into the user's network.
 *
 * One full-duplex socket carries everything:
 *   agent → cloud:  state reports (10s), command results, live log frames
 *   cloud → agent:  commands (restart/stop/…), log.watch / log.unwatch
 *
 * Enrollment: `pboss cloud connect` (device code) or the legacy single-use
 * token is exchanged once for a permanent per-server credential stored in
 * `~/.pboss/cloud.json` (0600). Reconnection is automatic with backoff;
 * close code 4001 means the credential was revoked — the agent unlinks
 * itself instead of retrying forever.
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
    const raw = JSON.parse(readFileSync(CLOUD_FILE, "utf-8") as string) as Partial<CloudConfig>;
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
  } catch (err) {
    // Best-effort — some filesystems reject chmod; the credential is still
    // written, and the failure is recorded instead of vanishing.
    ignore(`chmod cloud credential ${CLOUD_FILE} 0600`, err);
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

/** https://… → wss://…, http://… → ws://…, and the agent endpoint path. */
export function wsUrlOf(cloudUrl: string): string {
  const base = cloudUrl.replace(/\/+$/, "");
  const wsBase = base.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  return `${wsBase}/ws/agent`;
}

/* ── fleet view (`pboss cloud servers`, via the daemon's machine credential) ── */

export interface CloudFleetServer {
  id: string;
  name: string;
  host: string;
  status: string;
  os: string;
  agentVersion: string;
  cpu: number;
  memUsed: number;
  memTotal: number;
  lastSeen: string;
  enrolled: boolean;
}

/**
 * GET /api/agent/servers with the machine credential — the linked server's
 * owner's fleet with live presence. Runs inside the daemon (the CLI asks
 * over the socket): the machine secret never leaves this process except
 * toward the cloud itself.
 */
export async function fetchFleet(cfg: CloudConfig): Promise<CloudFleetServer[]> {
  const res = await fetch(`${cfg.cloudUrl}/api/agent/servers`, {
    headers: {
      Authorization: `Bearer ${cfg.serverId}.${cfg.serverSecret}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401) {
    throw new Error("the machine credential was revoked — re-link with `pboss cloud connect`");
  }
  if (!res.ok) {
    throw new Error(`fleet request failed (HTTP ${res.status})`);
  }
  const body = (await res.json().catch((err: unknown) => {
    ignore("parse fleet response", err);
    return {};
  })) as { servers?: CloudFleetServer[] };
  return Array.isArray(body.servers) ? body.servers : [];
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
  /** Exit facts (present after the process has exited once). */
  exitCode?: number | null;
  signal?: string | null;
}

export interface CloudEventReport {
  kind: "crash" | "restart" | "online" | "stopped";
  process: string;
  at: number;
  detail?: string;
  /** Crash enrichment — drives the cloud's crash reports. */
  exitCode?: number | null;
  signal?: string | null;
  logTail?: string[];
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
    | "process.deploy"
    | "server.info"
    | "server.deploy";
  payload: Record<string, unknown>;
}

export interface CloudCommandResult {
  commandId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Frames the cloud sends down the socket. */
export type CloudServerFrame =
  | { type: "hello"; serverId: string; now: number }
  | { type: "command"; command: CloudCommand }
  | { type: "log.watch"; process: string }
  | { type: "log.unwatch"; process: string }
  | { type: "ping"; now: number };

/** Frames the agent sends up. */
export type CloudAgentFrame =
  | { type: "state"; report: CloudStateReport }
  | { type: "command-result"; result: CloudCommandResult }
  | { type: "log"; process: string; lines: { t: number; level?: string; msg: string }[] }
  | { type: "pong"; now: number };

/** The cloud closes the socket with this code when the credential is revoked. */
export const WS_CLOSE_REVOKED = 4001;

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
    exitCode: env?.last_exit_code ?? undefined,
    signal: env?.last_exit_signal ?? undefined,
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
      events.push({
        kind: "crash",
        process: p.name,
        at: now,
        detail: "process errored",
        exitCode: p.exitCode ?? null,
        signal: p.signal ?? null,
      });
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

/** Lines of crash-context the agent attaches to crash events (raw text). */
export function crashLogTail(logs: LogItem[], max = 30): string[] {
  return logs
    .slice(-max)
    .map((l) => l.msg ?? "")
    .filter((s) => s.length > 0);
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
  private ws: WebSocket | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private reconnects = 0;
  private streamState: CloudAgentStatus["streamState"] = "stopped";
  private lastReport: CloudStateReport | null = null;
  private lastReportAt: number | null = null;
  private lastError: string | null = null;
  private lastSnapshot = new Map<string, CloudProcessReport>();
  private reportNow: (() => void) | null = null;
  /** Active log tails (process name → stop function), driven by log.watch. */
  private logTails = new Map<string, () => void>();

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
    this.closeSocket(1000, "agent stopped");
    this.streamState = "stopped";
    if (opts.revoke && this.cfg) {
      const cfg = this.cfg;
      try {
        await fetch(`${cfg.cloudUrl}/api/agent/disconnect`, {
          method: "POST",
          headers: this.authHeader(cfg),
        });
      } catch (err) {
        // Network gone — the credential file is cleared below anyway, but
        // record it so a persistent reachability problem stays visible.
        ignore("revoke cloud credential (agent disconnect)", err);
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

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        // already closing — nothing to do
      }
    }
  }

  /* ── command + log channel (WebSocket, full-duplex) ─────────────────── */

  private async runStream(): Promise<void> {
    while (this.running && this.cfg) {
      const cfg = this.cfg;
      this.streamState = "connecting";
      let closedWith: { code: number; reason: string } | null = null;
      try {
        const ws = await this.dialWebSocket(cfg);
        if (!this.running || this.cfg !== cfg) {
          this.closeSocket(1000, "superseded");
          return;
        }
        this.ws = ws;
        this.streamState = "connected";
        this.backoffMs = 1000;
        this.lastError = null;
        console.log(
          colorize(`☁  cloud: connected — command channel live (WebSocket)`, "green")
        );
        // Fresh state right after (re)connecting — the dashboard lights up.
        void this.reportState().catch((err: unknown) =>
          ignore("cloud state report (post-connect)", err)
        );

        closedWith = await this.serveWebSocket(ws);
      } catch (err: any) {
        if (!this.running) return;
        this.lastError = err?.message ?? String(err);
      }
      if (!this.running || !this.cfg) return;

      // Revoked: the cloud told us to go away — unlink, don't retry.
      if (closedWith?.code === WS_CLOSE_REVOKED) {
        this.handleRevoked();
        return;
      }

      this.streamState = "backoff";
      this.reconnects++;
      await sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
  }

  /** Dial /ws/agent; resolves with the OPEN socket (auth header included). */
  private dialWebSocket(cfg: CloudConfig): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const url = wsUrlOf(cfg.cloudUrl);
      // Bun's WebSocket client accepts extra handshake headers.
      const ws = new WebSocket(url, { headers: this.authHeader(cfg) } as never);
      const failTimer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // not open — close is a no-op that triggers onclose below
        }
        reject(new Error(`websocket handshake timeout (${url})`));
      }, 15_000);
      ws.onopen = () => {
        clearTimeout(failTimer);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(failTimer);
        reject(new Error(`websocket error (dialing ${url})`));
      };
      ws.onclose = (ev) => {
        clearTimeout(failTimer);
        reject(new Error(`websocket closed during handshake (code ${ev.code})`));
      };
    });
  }

  /** Serve frames on an open socket; resolves when the socket closes. */
  private serveWebSocket(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      ws.onmessage = (ev) => {
        this.handleFrame(String(ev.data));
      };
      ws.onclose = (ev) => {
        // tails are per-connection state; watch frames re-arrive on reconnect
        this.stopAllLogTails();
        resolve({ code: ev.code, reason: String(ev.reason ?? "") });
      };
      ws.onerror = () => {
        // onclose follows; nothing to do here
      };
    });
  }

  private handleFrame(raw: string): void {
    let frame: CloudServerFrame | null = null;
    try {
      frame = JSON.parse(raw) as CloudServerFrame;
    } catch {
      return; // not JSON — ignore (forward-compat: unknown frames too)
    }
    if (!frame?.type) return;
    switch (frame.type) {
      case "hello":
        // handshake ack — registration is confirmed
        break;
      case "command": {
        const cmd = frame.command;
        if (cmd?.id && cmd.type) {
          void this.handleCommand(cmd);
        }
        break;
      }
      case "log.watch":
        if (frame.process) this.startLogTail(frame.process);
        break;
      case "log.unwatch":
        if (frame.process) this.stopLogTail(frame.process);
        break;
      case "ping":
        this.sendFrame({ type: "pong", now: Date.now() });
        break;
      default:
        break;
    }
  }

  /** Best-effort frame send — drops silently when the socket is closed. */
  private sendFrame(frame: CloudAgentFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      ignore("send cloud frame", err);
      return false;
    }
  }

  private handleRevoked(): void {
    this.running = false;
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.closeSocket(WS_CLOSE_REVOKED, "revoked");
    this.stopAllLogTails();
    this.streamState = "stopped";
    clearCloudConfig();
    this.cfg = null;
    console.error(
      colorize(
        "☁  cloud: credential revoked from the dashboard — re-link with `pboss cloud connect`",
        "yellow"
      )
    );
  }

  /* ── state reporting (every 10s and after each command) ─────────────── */

  private async reportState(): Promise<void> {
    if (!this.running || !this.cfg) return;
    const states = this.pm.list();
    const report = buildStateReport(this.cfg.serverId, states);
    report.events = diffEvents(this.lastSnapshot, report.processes);
    // crash events carry the log tail for the cloud's crash reports
    for (const ev of report.events) {
      if (ev.kind !== "crash") continue;
      try {
        const logs = await this.pm.getLogs(ev.process, 30);
        ev.logTail = crashLogTail(logs);
      } catch (err) {
        ignore(`read log tail for crash (${ev.process})`, err);
      }
    }
    this.lastSnapshot = new Map(report.processes.map((p) => [p.name, p]));
    this.lastReport = report;

    if (this.sendFrame({ type: "state", report })) {
      this.lastReportAt = Date.now();
    } else {
      this.lastError = "websocket not open — state report skipped";
    }
  }

  /* ── live log tails (log.watch / log.unwatch) ───────────────────────── */

  private startLogTail(process: string): void {
    if (this.logTails.has(process)) return; // idempotent — multiple watchers share one tail
    const stop = this.pm.watchProcessLogs(process, (lines) => {
      this.sendFrame({ type: "log", process, lines });
    });
    if (stop) {
      this.logTails.set(process, stop);
    }
  }

  private stopLogTail(process: string): void {
    const stop = this.logTails.get(process);
    stop?.();
    this.logTails.delete(process);
  }

  private stopAllLogTails(): void {
    for (const stop of this.logTails.values()) stop();
    this.logTails.clear();
  }

  /* ── command execution (local, against this daemon's process engine) ── */

  private async handleCommand(cmd: CloudCommand): Promise<void> {
    let result: CloudCommandResult;
    try {
      const data = await this.executeCommand(cmd);
      result = { commandId: cmd.id, success: true, data };
    } catch (err: any) {
      result = { commandId: cmd.id, success: false, error: err?.message ?? String(err) };
    }
    this.sendFrame({ type: "command-result", result });
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
