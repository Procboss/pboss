/**
 * PBoss — Bun Process Manager
 * Programmatic API
 *
 * Usage:
 *   import PBoss from "pboss";
 *   const pboss = new PBoss();
 *   await pboss.connect();
 *   const list = await pboss.list();
 *   await pboss.start({ script: "./app.ts", name: "my-app" });
 *   await pboss.disconnect();
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { EventEmitter } from "events";
import { existsSync, readFileSync, unlinkSync } from "fs";
import path, { join, resolve, extname } from "path";
import {
  DAEMON_SOCKET,
  DAEMON_PID_FILE,
  PBOSS_HOME,
  DUMP_FILE,
  DASHBOARD_PORT,
  METRICS_PORT,
  DAEMON_OUT_LOG_FILE,
  DAEMON_ERR_LOG_FILE,
} from "./constants";
import { ensureDirs, generateId } from "./utils";
import { daemonSpawnCommand } from "./install-mode";
import { ignore } from "./error-handling";
import { probeDaemon } from "./daemon-probe";
import Daemon from "./daemon";
import type {
  DaemonMessage,
  DaemonResponse,
  StartOptions,
  EcosystemConfig,
  CronJob,
  CronJobConfig,
  ProcessState,
  MetricSnapshot,
  ProcessStatus,
  LogItem,
} from "./types";

// 
// Bus event types emitted by PBoss
// 

export interface PBossEvents {
  /** Daemon successfully connected */
  "daemon:connected": [];
  /** Daemon connection lost */
  "daemon:disconnected": [];
  /** Daemon launched by this client */
  "daemon:launched": [pid: number];
  /** Daemon killed */
  "daemon:killed": [];
  /** Error on the transport layer */
  "error": [error: Error];
  /** Process started */
  "process:start": [processes: ProcessState[]];
  /** Process stopped */
  "process:stop": [processes: ProcessState[]];
  /** Process restarted */
  "process:restart": [processes: ProcessState[]];
  /** Process reloaded */
  "process:reload": [processes: ProcessState[]];
  /** Process deleted */
  "process:delete": [processes: ProcessState[]];
  /** Process scaled */
  "process:scale": [processes: ProcessState[]];
  /** Metrics snapshot received */
  "metrics": [snapshot: MetricSnapshot];
  /** Log data received */
  "log:data": [logs: LogItem[]];
  /** Standalone cron job added */
  "cron:add": [job: CronJob];
  /** Standalone cron job removed */
  "cron:remove": [job: CronJob];
}

export interface PBossOptions {
  /**
   * When true, runs in foreground blocking mode using an in-process daemon
   * instead of connecting to a detached background daemon.
   */
  noDaemon?: boolean;
}

// 
// Helpers: Config loader and direct process readers
// 

/**
 * Load and parse an ecosystem configuration file (.json, .ts, or .js).
 */
export async function loadEcosystemConfig(filePath: string): Promise<EcosystemConfig> {
  const abs = resolve(filePath);
  const file = Bun.file(abs);

  if (!(await file.exists())) {
    throw new Error(`Ecosystem file not found: ${abs}`);
  }

  const ext = extname(abs);
  let config: EcosystemConfig;

  if (ext === ".json") {
    config = (await file.json()) as EcosystemConfig;
  } else {
    const mod = await import(abs);
    config = (mod.default || mod) as EcosystemConfig;
  }

  const cwd = path.dirname(abs);

  config.apps = config.apps.map((app) => {
    if ((app.cwd || "").trim() === "") {
      app.cwd = cwd;
    }
    return app;
  });

  // Standalone cron jobs: default their cwd to the config file's directory
  // (same rule the apps above follow) so relative commands resolve there.
  if (Array.isArray(config.crons)) {
    config.crons = config.crons.map((cron) => {
      if ((cron.cwd || "").trim() === "") {
        cron.cwd = cwd;
      }
      return cron;
    });
  }

  return config;
}

/**
 * Read saved process configurations directly from disk (`~/.pboss/dump.json`)
 * without requiring the daemon to be running or initialized.
 */
export async function readSavedProcesses(): Promise<ProcessState[]> {
  const file = Bun.file(DUMP_FILE);
  if (!(await file.exists())) return [];
  try {
    const data = await file.json();
    return data.map((item: any) => {
      const config = item.config || item;
      return {
        id: config.id ?? 0,
        name: config.name ?? "unknown",
        namespace: config.namespace,
        status: "stopped" as ProcessStatus,
        pid: undefined,
        pm_id: config.id ?? 0,
        monit: { memory: 0, cpu: 0 },
        pboss_env: {
          ...config,
          status: "stopped" as ProcessStatus,
          pm_uptime: 0,
          restart_time: item.restartCount ?? 0,
          unstable_restarts: item.unstableRestarts ?? 0,
          created_at: 0,
          pm_id: config.id ?? 0,
        },
        bm2_env: {
          ...config,
          status: "stopped" as ProcessStatus,
          pm_uptime: 0,
          restart_time: item.restartCount ?? 0,
          unstable_restarts: item.unstableRestarts ?? 0,
          created_at: 0,
          pm_id: config.id ?? 0,
        },
      };
    });
  } catch {
    return [];
  }
}

/**
 * Retrieve existing processes.
 * If the daemon is active, returns live running process states.
 * If the daemon is not running, falls back to reading saved processes from disk
 * without spawning a new daemon.
 */
export async function getProcesses(): Promise<ProcessState[]> {
  const defaultClient = PBoss.getDefaultInstance();
  if (defaultClient.isDaemonRunning() && (await defaultClient.isDaemonAlive())) {
    try {
      return await defaultClient.list();
    } catch (err) {
      // Live list failed — fall through to the saved dump, but record it:
      // silent here would look like "no processes" instead of a daemon error.
      ignore("list processes from live daemon (falling back to dump)", err);
    }
  }
  return readSavedProcesses();
}

// 
// Main API class
// 

/**
 * Wait for a daemon that someone ELSE is starting (a systemd unit's
 * ExecStart, a supervisor). NEVER spawns — `resurrect --wait` uses this so
 * the CLI cannot race the unit's daemon for the socket (the loser's
 * EADDRINUSE exit code 1 was what sent the unit into systemd's restart
 * storm: "Start request repeated too quickly").
 *
 * Returns true once a live daemon answers pings, false on timeout.
 */
export async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon()) return true;
    await Bun.sleep(200);
  }
  return await probeDaemon() !== null;
}

/**
 * Ask a running daemon to shut down — used by `pboss startup` before the
 * systemd unit takes over, so a leftover detached daemon (spawned by an
 * earlier CLI command) cannot hold the socket the unit needs. Never
 * spawns. Returns true if a daemon was found and asked to stop.
 */
export async function stopDaemonIfRunning(timeoutMs: number = 15_000): Promise<boolean> {
  const live = await probeDaemon();
  if (!live) return false;

  try {
    await fetch("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "kill", id: "startup-stop" }),
      unix: DAEMON_SOCKET,
    });
    // The daemon may exit before responding — that IS the success path.
  } catch (err) {
    ignore("stopDaemonIfRunning: send kill", err);
  }

  // Wait until it is actually gone so the unit's daemon can bind cleanly.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeDaemon())) return true;
    await Bun.sleep(200);
  }
  // Still alive after the grace period — leave it; the unit's daemon will
  // surface a clear DaemonConflictError (exit 81) instead of a restart loop.
  return true;
}

export class PBoss extends EventEmitter<PBossEvents> {
  public readonly noDaemon: boolean;
  private _connected: boolean = false;
  private _daemonPid: number | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _inProcessDaemon: Daemon | null = null;

  constructor(options: PBossOptions = {}) {
    super();
    this.noDaemon = !!options.noDaemon;
  }

  /** Whether the client believes the daemon is reachable. */
  get connected(): boolean {
    return this._connected;
  }

  /** PID of the daemon process (if known). */
  get daemonPid(): number | null {
    return this._daemonPid;
  }

  //  lifecycle 

  /**
   * Connect to the pboss daemon.
   * If the daemon is not running it will be spawned automatically
   * (same behaviour as the CLI).
   */
  async connect(): Promise<this> {
    ensureDirs();

    if (this.noDaemon) {
      if (!this._inProcessDaemon) {
        this._inProcessDaemon = new Daemon();
        await this._inProcessDaemon.initialize(false);
      }
      this._connected = true;
      this._daemonPid = process.pid;
      this.emit("daemon:connected");
      return this;
    }

    if (!(await this.isDaemonAlive())) {
      await this.launchDaemon();
    }

    // Verify connectivity
    const pong = await this.send({ type: "ping" });
    if (!pong.success) {
      throw new Error("Failed to connect to pboss daemon");
    }

    this._connected = true;
    this._daemonPid = pong.data?.pid ?? null;
    this.emit("daemon:connected");

    return this;
  }

  /**
   * Disconnect from the daemon. Stops any internal polling but does **not**
   * kill the daemon — processes keep running.
   */
  async disconnect(): Promise<void> {
    this.stopPolling();
    this._connected = false;
    this.emit("daemon:disconnected");
  }

  //  process management 

  /**
   * Start a new process (or ecosystem).
   *
   * ```ts
   * await pboss.start({ script: "./server.ts", name: "api", instances: 4 });
   * ```
   */
  async start(options: StartOptions): Promise<ProcessState[]> {
    if (options.script) {
      options.script = resolve(options.script);
    }
    const res = await this.sendOrThrow({ type: "start", data: options });
    this.emit("process:start", res.data);
    return res.data;
  }

  /**
   * Start an ecosystem configuration object.
   *
   * ```ts
   * await pboss.startEcosystem({ apps: [{ script: "./a.ts" }, { script: "./b.ts" }] });
   * ```
   */
  async startEcosystem(config: EcosystemConfig): Promise<ProcessState[]> {
    // Resolve scripts to absolute paths
    for (const app of config.apps) {
      if (app.script) app.script = resolve(app.script);
    }
    const res = await this.sendOrThrow({ type: "ecosystem", data: config });
    this.emit("process:start", res.data);
    return res.data;
  }

  /**
   * Load and parse an ecosystem configuration file (.json, .ts, or .js).
   */
  async loadEcosystemConfig(filePath: string): Promise<EcosystemConfig> {
    return loadEcosystemConfig(filePath);
  }

  /**
   * Stop one or more processes.
   * @param target Process id, name, namespace, or `"all"`.
   */
  async stop(target: string | number = "all"): Promise<ProcessState[]> {
    const type = target === "all" ? "stopAll" : "stop";
    const data = target === "all" ? undefined : { target: String(target) };
    const res = await this.sendOrThrow({ type, data });
    this.emit("process:stop", res.data);
    return res.data;
  }

  /**
   * Restart one or more processes (hard restart).
   */
  async restart(target: string | number = "all"): Promise<ProcessState[]> {
    const type = target === "all" ? "restartAll" : "restart";
    const data = target === "all" ? undefined : { target: String(target) };
    const res = await this.sendOrThrow({ type, data });
    this.emit("process:restart", res.data);
    return res.data;
  }

  /**
   * Graceful zero-downtime reload.
   */
  async reload(target: string | number = "all"): Promise<ProcessState[]> {
    const type = target === "all" ? "reloadAll" : "reload";
    const data = target === "all" ? undefined : { target: String(target) };
    const res = await this.sendOrThrow({ type, data });
    this.emit("process:reload", res.data);
    return res.data;
  }

  /**
   * Stop and remove one or more processes from pboss's list.
   */
  async delete(target: string | number = "all"): Promise<ProcessState[]> {
    const type = target === "all" ? "deleteAll" : "delete";
    const data = target === "all" ? undefined : { target: String(target) };
    const res = await this.sendOrThrow({ type, data });
    this.emit("process:delete", res.data);
    return res.data;
  }

  /**
   * Scale a process group to `count` instances.
   */
  async scale(target: string | number, count: number): Promise<ProcessState[]> {
    const res = await this.sendOrThrow({
      type: "scale",
      data: { target: String(target), count },
    });
    this.emit("process:scale", res.data);
    return res.data;
  }

  /**
   * Send an OS signal to a process.
   */
  async sendSignal(target: string | number, signal: string): Promise<void> {
    await this.sendOrThrow({
      type: "signal",
      data: { target: String(target), signal },
    });
  }

  /**
   * Reset restart counters for one or more processes.
   */
  async reset(target: string | number = "all"): Promise<ProcessState[]> {
    const res = await this.sendOrThrow({
      type: "reset",
      data: { target: String(target) },
    });
    return res.data;
  }


  /**
   * List all managed processes.
   */
  async list(): Promise<ProcessState[]> {
    const res = await this.sendOrThrow({ type: "list" });
    return res.data;
  }

  /**
   * Get detailed description(s) of a process.
   */
  async describe(target: string | number): Promise<ProcessState[]> {
    const res = await this.sendOrThrow({
      type: "describe",
      data: { target: String(target) },
    });
    return res.data;
  }

  //  logs 

  /**
   * Retrieve recent log lines.
   */
  async logs(
    target: string | number = "all",
    lines: number = 20
  ): Promise<LogItem[]> {
    const res = await this.sendOrThrow({
      type: "logs",
      data: { target: String(target), lines },
    });
    this.emit("log:data", res.data);
    return res.data;
  }

  /**
   * Stream live log items in real-time.
   */
  async streamLogs(
    target: string | number = "all",
    callback: (log: LogItem) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.noDaemon) {
      if (!this._inProcessDaemon) {
        this._inProcessDaemon = new Daemon();
        await this._inProcessDaemon.initialize(false);
      }
      const controller = {
        enqueue: (chunk: string) => {
          if (chunk.startsWith("data: ")) {
            try {
              const data = JSON.parse(chunk.replace(/^data:\s*/, "").trim()) as LogItem;
              callback(data);
            } catch (err) {
              // Non-JSON frames (keepalives, partial writes) — skip the line.
              ignore("parse in-process log line", err);
            }
          }
        },
        close: () => {},
      } as any;
      await this._inProcessDaemon.handleStreamMessage(
        { type: "streamLogs", data: { target: String(target) }, mode: "stream" },
        controller,
        signal || new AbortController().signal
      );
      return;
    }

    await this.startDaemon();

    const response = await fetch("http://localhost/command", {
      unix: DAEMON_SOCKET,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "streamLogs",
        data: { target: String(target) },
        mode: "stream",
      }),
      signal,
    });

    if (!response.body) {
      throw new Error("No stream received from daemon");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const line = part.replace(/^data:\s*/, "").trim();
        if (!line) continue;
        try {
          const result = JSON.parse(line) as LogItem;
          callback(result);
        } catch (err) {
          // Non-JSON frames (keepalives, partial writes) — skip the line.
          ignore("parse streamed log line", err);
        }
      }
    }
  }

  /**
   * Flush (truncate) log files for one or all processes.
   */
  async flush(target?: string | number): Promise<void> {
    await this.sendOrThrow({
      type: "flush",
      data: target !== undefined ? { target: String(target) } : undefined,
    });
  }

  //  cron jobs 

  /**
   * Schedule a standalone command.
   *
   * ```ts
   * await pboss.cronAdd("everyday@9:11", "bun backup.ts", { name: "backup" });
   * ```
   *
   * The schedule accepts the friendly syntax (`everyday@9:11`, `every-sunday`,
   * `every-15th@10:10`, `every-6-hours@30`, `every-second`, `every-30-seconds`,
   * `today@23:10`, `tomorrow@8:00`, `on-date@24-10-2026-23:10`) or a raw
   * 5-field cron expression (6 fields adds a seconds step).
   */
  async cronAdd(
    schedule: string,
    command: string,
    options: Omit<CronJobConfig, "schedule" | "command"> = {}
  ): Promise<CronJob> {
    const res = await this.sendOrThrow({
      type: "cronAdd",
      data: { schedule, command, ...options },
    });
    this.emit("cron:add", res.data);
    return res.data;
  }

  /**
   * List standalone cron jobs.
   */
  async cronJobs(): Promise<CronJob[]> {
    const res = await this.sendOrThrow({ type: "cronList" });
    return res.data;
  }

  /**
   * Remove a standalone cron job by id or name.
   */
  async cronRemove(target: string | number): Promise<CronJob> {
    const res = await this.sendOrThrow({
      type: "cronRemove",
      data: { target: String(target) },
    });
    this.emit("cron:remove", res.data);
    return res.data;
  }

  /**
   * Preview the next `count` run times (epoch ms) of a cron job.
   */
  async cronNext(target: string | number, count = 3): Promise<number[]> {
    const res = await this.sendOrThrow({
      type: "cronNext",
      data: { target: String(target), count },
    });
    return res.data;
  }

  /**
   * Run a cron job immediately (without waiting for its schedule).
   */
  async cronTrigger(target: string | number): Promise<CronJob> {
    const res = await this.sendOrThrow({
      type: "cronTrigger",
      data: { target: String(target) },
    });
    return res.data;
  }

  // ── cloud ────────────────────────────────────────────────────────────

  /**
   * Link this machine to ProcBoss Cloud by exchanging a single-use
   * enrollment token (minted in the dashboard) for a permanent
   * per-server credential. The daemon then maintains the outbound
   * connection (commands down, state up).
   */
  async cloudConnect(
    token: string,
    url?: string
  ): Promise<{ serverId: string; serverName: string }> {
    const res = await this.sendOrThrow({
      type: "cloudConnect",
      data: { token, url },
    });
    return res.data;
  }

  /** Live cloud-link status (connection state, last report, server id). */
  async cloudStatus(): Promise<{
    configured: boolean;
    cloudUrl: string | null;
    serverId: string | null;
    serverName: string | null;
    connected: boolean;
    streamState: string;
    reconnects: number;
    lastReportAt: number | null;
    lastReportAgeMs: number | null;
    processes: number;
    lastError: string | null;
  }> {
    const res = await this.sendOrThrow({ type: "cloudStatus" });
    return res.data;
  }

  /**
   * Unlink this machine: revokes the credential server-side, stops the
   * agent, and wipes the local cloud.json. The server row stays in the
   * dashboard fleet (offline) — re-link any time with a fresh token.
   */
  async cloudDisconnect(): Promise<{ ok: boolean }> {
    const res = await this.sendOrThrow({ type: "cloudDisconnect" });
    return res.data;
  }

  //  monitoring 

  /**
   * Take a single metrics snapshot.
   */
  async metrics(): Promise<MetricSnapshot> {
    const res = await this.sendOrThrow({ type: "metrics" });
    this.emit("metrics", res.data);
    return res.data;
  }

  /**
   * Get historical metric snapshots.
   * @param seconds Look-back window (default 300 = 5 min).
   */
  async metricsHistory(seconds: number = 300): Promise<MetricSnapshot[]> {
    const res = await this.sendOrThrow({
      type: "metricsHistory",
      data: { seconds },
    });
    return res.data;
  }

  /**
   * Get Prometheus-formatted metrics string.
   */
  async prometheus(): Promise<string> {
    const res = await this.sendOrThrow({ type: "prometheus" });
    return res.data;
  }

  /**
   * Start polling metrics at a fixed interval and emitting `"metrics"` events.
   *
   * ```ts
   * pboss.on("metrics", (snapshot) => console.log(snapshot));
   * pboss.startPolling(2000);
   * ```
   */
  startPolling(intervalMs: number = 2000): void {
    this.stopPolling();
    this._pollTimer = setInterval(async () => {
      try {
        await this.metrics();
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }, intervalMs);
  }

  /** Stop the metrics polling loop started by `startPolling()`. */
  stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  //  persistence 

  /**
   * Persist the current process list to disk so it can be restored later.
   */
  async save(): Promise<void> {
    await this.sendOrThrow({ type: "save" });
  }

  /**
   * Restore previously saved processes.
   */
  async resurrect(): Promise<ProcessState[]> {
    const res = await this.sendOrThrow({ type: "resurrect" });
    return res.data;
  }

  //  dashboard 

  /**
   * Start the web dashboard.
   */
  async dashboard(
    port: number = DASHBOARD_PORT,
    metricsPort: number = METRICS_PORT
  ): Promise<{ port: number; metricsPort: number }> {
    const res = await this.sendOrThrow({
      type: "dashboard",
      data: { port, metricsPort },
    });
    return res.data;
  }

  /**
   * Stop the web dashboard.
   */
  async dashboardStop(): Promise<void> {
    await this.sendOrThrow({ type: "dashboardStop" });
  }

  //  modules 

  /**
   * Install a pboss module.
   */
  async moduleInstall(nameOrPath: string): Promise<{ path: string }> {
    const res = await this.sendOrThrow({
      type: "moduleInstall",
      data: { module: nameOrPath },
    });
    return res.data;
  }

  /**
   * Uninstall a pboss module.
   */
  async moduleUninstall(name: string): Promise<void> {
    await this.sendOrThrow({
      type: "moduleUninstall",
      data: { module: name },
    });
  }

  /**
   * List installed modules.
   */
  async moduleList(): Promise<Array<{ name: string; version: string }>> {
    const res = await this.sendOrThrow({ type: "moduleList" });
    return res.data;
  }

  //  daemon lifecycle 

  /**
   * Check synchronously if the daemon PID file exists and the process is alive.
   */
  isDaemonRunning(): boolean {
    if (!existsSync(DAEMON_PID_FILE)) return false;
    try {
      const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim());
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check whether the daemon is running and socket is responsive.
   */
  async isDaemonAlive(): Promise<boolean> {
    const pidFile = Bun.file(DAEMON_PID_FILE);
    if (await pidFile.exists()) {
      try {
        const pidText = await pidFile.text();
        const pid = parseInt(pidText.trim());
        process.kill(pid, 0); // throws if process doesn't exist
      } catch {
        // Stale PID file
        return false;
      }
    } else {
      return false;
    }

    // Verify the socket is responsive
    if (!(await Bun.file(DAEMON_SOCKET).exists())) return false;

    try {
      const response = await fetch("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "ping", id: "ping-check" }),
        unix: DAEMON_SOCKET,
      });
      if (!response.ok) return false;
      const res = (await response.json()) as DaemonResponse;
      return res.success;
    } catch {
      return false;
    }
  }

  /**
   * Launch the daemon as a detached background process and wait until responsive.
   */
  async launchDaemon(): Promise<void> {
    await ensureDirs();
    // Resolved from the install mode (see install-mode.ts):
    //   compiled → [<pboss binary>, "__daemon"]   (no system Bun needed)
    //   script   → [<bun>, "run", <daemon.ts>]    (system Bun required)
    const spawnArgs = daemonSpawnCommand();

    // Open log files for daemon stdout/stderr
    const outLog = Bun.file(DAEMON_OUT_LOG_FILE);
    const errLog = Bun.file(DAEMON_ERR_LOG_FILE);

    if (!(await outLog.exists())) await Bun.write(outLog, "");
    if (!(await errLog.exists())) await Bun.write(errLog, "");

    const proc = Bun.spawn(spawnArgs, {
      stdout: outLog,
      stderr: errLog,
      stdin: "ignore",
      env: { ...(process.env as Record<string, string>) },
    });

    // Detach — we don't want to keep a handle
    proc.unref();

    // Poll until daemon is responsive (up to 5 s)
    const deadline = Date.now() + 5000;
    let alive = false;

    while (Date.now() < deadline) {
      await Bun.sleep(200);
      try {
        if (existsSync(DAEMON_SOCKET)) {
          const rawRes = await fetch("http://localhost/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "ping", id: "daemon-launch-ping" }),
            unix: DAEMON_SOCKET,
          });
          if (rawRes.ok) {
            const res = (await rawRes.json()) as DaemonResponse;
            if (res.success) {
              alive = true;
              this._daemonPid = res.data?.pid ?? proc.pid;
              this._connected = true;
              break;
            }
          }
        }
      } catch {
        // Not ready yet — keep waiting
      }
    }

    if (!alive) {
      throw new Error(
        "Timed out waiting for pboss daemon to start. " +
        `Check ${DAEMON_ERR_LOG_FILE} for details.`
      );
    }

    this.emit("daemon:launched", this._daemonPid!);
  }

  /**
   * Start the daemon if not already running.
   */
  async startDaemon(): Promise<void> {
    if (await this.isDaemonAlive()) return;
    return this.launchDaemon();
  }

  /**
   * Stop the daemon process.
   */
  async stopDaemon(): Promise<void> {
    try {
      if (!this.isDaemonRunning()) return;

      const pidText = await Bun.file(DAEMON_PID_FILE).text();
      const pid = Number(pidText);

      process.kill(pid, "SIGTERM");
      await Bun.write(DAEMON_PID_FILE, "");
    } catch (err) {
      // Ignore if already stopped
    }
  }

  /**
   * Ping the daemon. Returns daemon PID and uptime.
   */
  async ping(): Promise<{ pid: number; uptime: number }> {
    const res = await this.sendOrThrow({ type: "ping" });
    return res.data;
  }

  /**
   * Kill the daemon and all managed processes.
   */
  async kill(): Promise<void> {
    try {
      await this.send({ type: "kill" });
    } catch (err) {
      // Expected — daemon exits before responding
      ignore("send kill to daemon (exits before responding)", err);
    }

    // Clean up leftover files
    try { if (existsSync(DAEMON_SOCKET)) unlinkSync(DAEMON_SOCKET); } catch (err) { ignore(`unlink ${DAEMON_SOCKET} after kill`, err); }
    try { if (existsSync(DAEMON_PID_FILE)) unlinkSync(DAEMON_PID_FILE); } catch (err) { ignore(`unlink ${DAEMON_PID_FILE} after kill`, err); }

    this._connected = false;
    this._daemonPid = null;
    this.stopPolling();
    this.emit("daemon:killed");
  }

  /**
   * Reload the daemon server itself.
   */
  async daemonReload(): Promise<string> {
    const res = await this.sendOrThrow({ type: "daemonReload" });
    return res.data;
  }

  //  internal transport 

  /**
   * Low-level: send an arbitrary message to the daemon and return the
   * raw response. Useful for custom or future command types.
   */
  async send(message: DaemonMessage): Promise<DaemonResponse> {
    if (this.noDaemon) {
      if (!this._inProcessDaemon) {
        this._inProcessDaemon = new Daemon();
        await this._inProcessDaemon.initialize(false);
      }
      return this._inProcessDaemon.handleMessage(message);
    }

    if (!message.id) {
      message.id = generateId();
    }

    // Auto-start daemon if sending a command while daemon is not alive
    if (!this._connected && !(await this.isDaemonAlive())) {
      await this.launchDaemon();
    }

    const body = JSON.stringify(message);

    // Bun supports fetching over Unix sockets with the `unix` option
    const response = await fetch(`http://localhost/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      unix: DAEMON_SOCKET,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Daemon HTTP ${response.status}: ${text}`);
    }

    return (await response.json()) as DaemonResponse;
  }

  //  private helpers 

  /** Send and throw a friendly error if `success` is false. */
  private async sendOrThrow(message: DaemonMessage): Promise<DaemonResponse> {
    const res = await this.send(message);
    if (!res.success) {
      throw new PBossError(
        res.error || `Command "${message.type}" failed`,
        message.type,
        res
      );
    }
    return res;
  }
  //  static convenience methods 

  private static _defaultInstance: PBoss | null = null;

  public static getInstance(options?: PBossOptions): PBoss {
    if (options?.noDaemon) {
      return new PBoss(options);
    }
    if (!PBoss._defaultInstance) {
      PBoss._defaultInstance = new PBoss();
    }
    return PBoss._defaultInstance;
  }

  public static getDefaultInstance(): PBoss {
    return PBoss.getInstance();
  }

  /**
   * List all managed processes using the default PBoss client.
   * Auto-starts the daemon if needed.
   */
  static async list(): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().list();
  }

  /**
   * Get detailed description(s) of a process by id or name.
   */
  static async describe(target: string | number): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().describe(target);
  }

  /**
   * Retrieve existing processes directly without needing to initialize a client.
   * If the daemon is running, returns live states. If not, reads saved state from disk.
   */
  static async getProcesses(): Promise<ProcessState[]> {
    return getProcesses();
  }

  /**
   * Read saved processes from disk without requiring a running daemon.
   */
  static async readSavedProcesses(): Promise<ProcessState[]> {
    return readSavedProcesses();
  }

  /**
   * Start a process with the given options.
   */
  static async start(options: StartOptions): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().start(options);
  }

  /**
   * Start an ecosystem configuration.
   */
  static async startEcosystem(config: EcosystemConfig): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().startEcosystem(config);
  }

  /**
   * Stop processes by id, name, namespace, or "all".
   */
  static async stop(target: string | number = "all"): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().stop(target);
  }

  /**
   * Restart processes by id, name, namespace, or "all".
   */
  static async restart(target: string | number = "all"): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().restart(target);
  }

  /**
   * Graceful zero-downtime reload.
   */
  static async reload(target: string | number = "all"): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().reload(target);
  }

  /**
   * Delete processes from management.
   */
  static async delete(target: string | number = "all"): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().delete(target);
  }

  /**
   * Scale a process group to N instances.
   */
  static async scale(target: string | number, count: number): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().scale(target, count);
  }

  /**
   * Retrieve recent logs.
   */
  static async logs(target: string | number = "all", lines: number = 20): Promise<LogItem[]> {
    return PBoss.getDefaultInstance().logs(target, lines);
  }

  /**
   * Stream live logs in real time.
   */
  static async streamLogs(
    target: string | number = "all",
    callback: (log: LogItem) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return PBoss.getDefaultInstance().streamLogs(target, callback, signal);
  }

  /**
   * Flush (clear) logs.
   */
  static async flush(target?: string | number): Promise<void> {
    return PBoss.getDefaultInstance().flush(target);
  }

  /**
   * Take a metrics snapshot.
   */
  static async metrics(): Promise<MetricSnapshot> {
    return PBoss.getDefaultInstance().metrics();
  }

  /**
   * Get historical metrics snapshots.
   */
  static async metricsHistory(seconds: number = 300): Promise<MetricSnapshot[]> {
    return PBoss.getDefaultInstance().metricsHistory(seconds);
  }

  /**
   * Get Prometheus exposition text.
   */
  static async prometheus(): Promise<string> {
    return PBoss.getDefaultInstance().prometheus();
  }

  /**
   * Persist current process list to disk.
   */
  static async save(): Promise<void> {
    return PBoss.getDefaultInstance().save();
  }

  /**
   * Restore saved process list from disk.
   */
  static async resurrect(): Promise<ProcessState[]> {
    return PBoss.getDefaultInstance().resurrect();
  }

  /**
   * Schedule a standalone cron job.
   */
  static async cronAdd(
    schedule: string,
    command: string,
    options: Omit<CronJobConfig, "schedule" | "command"> = {}
  ): Promise<CronJob> {
    return PBoss.getDefaultInstance().cronAdd(schedule, command, options);
  }

  /**
   * List standalone cron jobs.
   */
  static async cronJobs(): Promise<CronJob[]> {
    return PBoss.getDefaultInstance().cronJobs();
  }

  /**
   * Remove a standalone cron job by id or name.
   */
  static async cronRemove(target: string | number): Promise<CronJob> {
    return PBoss.getDefaultInstance().cronRemove(target);
  }

  /**
   * Preview the next run times of a cron job.
   */
  static async cronNext(target: string | number, count = 3): Promise<number[]> {
    return PBoss.getDefaultInstance().cronNext(target, count);
  }

  /**
   * Run a cron job immediately.
   */
  static async cronTrigger(target: string | number): Promise<CronJob> {
    return PBoss.getDefaultInstance().cronTrigger(target);
  }

  /**
   * Ping the daemon.
   */
  static async ping(): Promise<{ pid: number; uptime: number }> {
    return PBoss.getDefaultInstance().ping();
  }

  /**
   * Kill the daemon and all managed processes.
   */
  static async kill(): Promise<void> {
    return PBoss.getDefaultInstance().kill();
  }

  /**
   * Check synchronously if the daemon process is running.
   */
  static isDaemonRunning(): boolean {
    return PBoss.getDefaultInstance().isDaemonRunning();
  }

  /**
   * Check whether the daemon is running and responsive.
   */
  static async isDaemonAlive(): Promise<boolean> {
    return PBoss.getDefaultInstance().isDaemonAlive();
  }

  /**
   * Start the background daemon if not already running.
   */
  static async startDaemon(): Promise<void> {
    return PBoss.getDefaultInstance().startDaemon();
  }

  /**
   * Stop the daemon process.
   */
  static async stopDaemon(): Promise<void> {
    return PBoss.getDefaultInstance().stopDaemon();
  }
}

//  error class 

export class PBossError extends Error {
  /** The daemon command type that failed. */
  public readonly command: string;
  /** The full daemon response. */
  public readonly response: DaemonResponse;

  constructor(message: string, command: string, response: DaemonResponse) {
    super(message);
    this.name = "PBossError";
    this.command = command;
    this.response = response;
  }
}

//  standalone function exports 

export const pboss = PBoss.getDefaultInstance();

export const list = () => PBoss.list();
export const describe = (target: string | number) => PBoss.describe(target);
export const logs = (target: string | number = "all", lines: number = 20) => PBoss.logs(target, lines);
export const streamLogs = (
  target: string | number = "all",
  callback: (log: LogItem) => void,
  signal?: AbortSignal
) => PBoss.streamLogs(target, callback, signal);
export const metrics = () => PBoss.metrics();
export const prometheus = () => PBoss.prometheus();
export const start = (options: StartOptions) => PBoss.start(options);
export const startEcosystem = (config: EcosystemConfig) => PBoss.startEcosystem(config);
export const stop = (target: string | number = "all") => PBoss.stop(target);
export const restart = (target: string | number = "all") => PBoss.restart(target);
export const reload = (target: string | number = "all") => PBoss.reload(target);
export const del = (target: string | number = "all") => PBoss.delete(target);
export const scale = (target: string | number, count: number) => PBoss.scale(target, count);
export const flush = (target?: string | number) => PBoss.flush(target);
export const cronAdd = (
  schedule: string,
  command: string,
  options: Omit<CronJobConfig, "schedule" | "command"> = {}
) => PBoss.cronAdd(schedule, command, options);
export const cronJobs = () => PBoss.cronJobs();
export const cronRemove = (target: string | number) => PBoss.cronRemove(target);
export const cronNext = (target: string | number, count = 3) => PBoss.cronNext(target, count);
export const cronTrigger = (target: string | number) => PBoss.cronTrigger(target);
export const save = () => PBoss.save();
export const resurrect = () => PBoss.resurrect();
export const ping = () => PBoss.ping();
export const kill = () => PBoss.kill();

export default PBoss;
