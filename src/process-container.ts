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
import type { Subprocess } from "bun";
import type {
  ProcessDescription,
  ProcessState,
  ProcessStatus,
  LogRotateOptions,
} from "./types";
import { LogManager } from "./log-manager";
import { ClusterManager } from "./cluster-manager";
import { HealthChecker } from "./health-checker";
import { CronManager } from "./cron-manager";
import { treeKill, readEnvFileOverrides } from "./utils";
import { ignore, warn } from "./error-handling";
import type { PbossProcessEvent, ProcessEventKind, ProcessEventSource } from "./events";
import { join } from "path";
import {
  PID_DIR,
  MONITOR_INTERVAL,
  DEFAULT_LOG_MAX_SIZE,
  DEFAULT_LOG_RETAIN,
} from "./constants";
import pidusage from "pidusage";
import { readdir } from "node:fs/promises";
import { watch } from "node:fs";

export class ProcessContainer {
  public id: number;
  public name: string;
  public config: ProcessDescription;
  public status: ProcessStatus = "stopped";
  public process: Subprocess | null = null;
  public pid: number | undefined;
  public restartCount: number = 0;
  public unstableRestarts: number = 0;
  /** Exit facts from the most recent exit (null until it has exited once). */
  public lastExitCode: number | null = null;
  public lastExitSignal: string | null = null;
  public createdAt: number;
  public startedAt: number = 0;
  public memory: number = 0;
  public cpu: number = 0;
  public handles: number = 0;
  public eventLoopLatency: number = 0;
  public axmMonitor: Record<string, any> = {};

  /**
   * Issue #31: set while a pboss-driven stop/restart/reload/delete/
   * rollback is in flight for THIS container. A deliberate, operator-
   * initiated stop must NOT fire the namespace member-exit policy —
   * otherwise `pboss stop <ns>`/rollback would cascade into siblings.
   */
  public stopInitiated: boolean = false;

  /**
   * Issue #31: invoked by the container when it exits for GOOD — terminal
   * stop (no restart pending) or errored after exhausting the restart
   * budget — and the exit was NOT pboss-initiated. Wired by the
   * ProcessManager to evaluate the namespace `onNsMemberExit` policy.
   */
  public onFinalExit: ((container: ProcessContainer) => void) | null = null;

  /**
   * Issue #32: invoked on every REAL state transition (online, deliberate
   * stop, autonomous exit, restart-back-online, terminal error). Wired by
   * the ProcessManager — the canonical event source — so autonomous
   * behavior (crash/memory/watch/cron/health restarts) is as visible as
   * API-initiated operations. Same wiring pattern as onFinalExit. Guarded:
   * a broken listener can never take down the supervisor's exit paths.
   */
  public onProcessEvent:
    | ((
        container: ProcessContainer,
        event: ProcessEventKind,
        source: ProcessEventSource,
        extra?: Partial<PbossProcessEvent>
      ) => void)
    | null = null;

  /**
   * Issue #32: set while a restart is bringing this container back up —
   * makes the upcoming start() fire `process:restart` (with the restart's
   * source) instead of `process:start`. Set by restart(source) and by the
   * crash-autorestart timer; consumed and cleared by start().
   */
  private pendingRestartSource: ProcessEventSource | null = null;

  private logManager: LogManager;
  private clusterManager: ClusterManager;
  private healthChecker: HealthChecker;
  private cronManager: CronManager;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchers: ReturnType<typeof watch>[] = [];
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private logRotateInterval: ReturnType<typeof setInterval> | null = null;
  private isRestarting: boolean = false;
  /**
   * Issue #32: true while a restart's internal stop phase runs — its
   * completion must NOT surface as a standalone `process:stop` (one
   * restart = one `process:restart` event, when the process is back).
   */
  private suppressStopEvent: boolean = false;

  constructor(
    id: number,
    config: ProcessDescription,
    logManager: LogManager,
    clusterManager: ClusterManager,
    healthChecker: HealthChecker,
    cronManager: CronManager
  ) {
    this.id = id;
    this.name = config.name;
    this.config = config;
    this.logManager = logManager;
    this.clusterManager = clusterManager;
    this.healthChecker = healthChecker;
    this.cronManager = cronManager;
    this.createdAt = Date.now();
  }

  async start(source: ProcessEventSource = "user"): Promise<void> {
    if (this.status === "online") return;

    this.status = "launching";
    const logPaths = this.logManager.getLogPaths(
      this.name,
      this.id,
      this.config.outFile,
      this.config.errorFile
    );

    try {
      // Ensure log files exist
      for (const f of [logPaths.outFile, logPaths.errFile]) {
        const file = Bun.file(f);
        if (!(await file.exists())) await Bun.write(f, "");
      }

      if (this.config.execMode === "cluster" && this.config.instances > 1) {
        await this.startCluster(logPaths);
      } else {
        await this.startFork(logPaths);
      }

      this.startedAt = Date.now();
      this.status = "online";

      // Write PID file
      if (this.pid) {
        await Bun.write(
          join(PID_DIR, `${this.name}-${this.id}.pid`),
          String(this.pid)
        );
      }

      // Start monitoring
      this.startMonitoring();

      // Start log rotation
      this.startLogRotation(logPaths);

      // Setup watch mode
      if (this.config.watch) {
        this.setupWatch();
      }

      // Setup health checks
      if (this.config.healthCheckUrl) {
        this.healthChecker.startCheck(
          this.id,
          {
            url: this.config.healthCheckUrl,
            interval: this.config.healthCheckInterval || 30000,
            timeout: this.config.healthCheckTimeout || 5000,
            maxFails: this.config.healthCheckMaxFails || 3,
          },
          (_id, reason) => {
            console.log(`[pboss] Health check failed for ${this.name}: ${reason}`);
            this.restart("health");
          }
        );
      }

      // Setup cron restart
      if (this.config.cronRestart) {
        this.cronManager.schedule(this.id, this.config.cronRestart, () => {
          console.log(`[pboss] Cron restart triggered for ${this.name}`);
          this.restart("cron");
        });
      }

      // Issue #32: the process is really online now — emit the canonical
      // transition. A restart's second phase reports `process:restart`
      // (with the restart's source) instead of a plain start.
      const restartSource = this.pendingRestartSource;
      this.pendingRestartSource = null;
      if (restartSource) {
        this.notify("process:restart", restartSource);
      } else {
        this.notify("process:start", source);
      }
    } catch (err: any) {
      this.status = "errored";
      this.pendingRestartSource = null;
      this.notify("process:errored", source, {
        reason: err?.message ?? String(err),
      });
 
      await this.logManager.appendJSONLog(logPaths.errFile, `[pboss] Failed to start: ${err.message}`);
      
      throw err;
    }
  }

  private async startFork(logPaths: { outFile: string; errFile: string }) {
    const cmd = this.clusterManager.buildWorkerCommand(this.config);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.config.env,
      // The app dir's .env is re-read on EVERY (re)spawn and wins over the
      // start-time snapshot — edit .env + `pboss restart` now actually
      // applies (see readEnvFileOverrides for the incident this fixes).
      // PBOSS_*/BM2_* below stay on top so .env cannot hijack pboss's own vars.
      ...readEnvFileOverrides(this.config.cwd),
      PBOSS_ID: String(this.id),
      PBOSS_NAME: this.name,
      PBOSS_EXEC_MODE: "fork",
      BM2_ID: String(this.id),
      BM2_NAME: this.name,
      BM2_EXEC_MODE: "fork",
    };

    this.process = Bun.spawn(cmd, {
      cwd: this.config.cwd || process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // windowsHide (issue #36 follow-up, 2026-09-15): the daemon that runs
      // this container is detached — it has NO console. A console child of a
      // console-less parent gets a brand-new VISIBLE console window on
      // Windows (owner report: `pboss start` opened a terminal per app).
      // The app's output is piped to the log files anyway; the window was
      // pure noise. Deliberately NOT detached: the daemon must keep
      // supervising (and treeKill-ing) this process.
      windowsHide: true,
    });

    this.pid = this.process.pid;
    this.pipeOutput(logPaths);

    this.process.exited.then((code) => {
      if (!this.isRestarting) {
        this.handleExit(code);
      }
    });
  }

  private async startCluster(logPaths: { outFile: string; errFile: string }) {
    const workerId = parseInt(this.config.env?.PBOSS_INSTANCE_ID || this.config.env?.BM2_INSTANCE_ID || this.config.env?.NODE_APP_INSTANCE || "0") || 0;
    const proc = this.clusterManager.spawnWorker(
      this.config,
      workerId,
      this.config.instances,
      { stdout: "pipe", stderr: "pipe" }
    );

    this.process = proc;
    this.pid = proc.pid;

    if (proc.stdout && typeof proc.stdout !== "number") {
      this.pipeStream(proc.stdout, logPaths.outFile, "stdout");
    }
    if (proc.stderr && typeof proc.stderr !== "number") {
      this.pipeStream(proc.stderr, logPaths.errFile, "stderr");
    }

    proc.exited.then((code) => {
      if (!this.isRestarting) {
        this.handleExit(code);
      }
    });
  }

  private pipeOutput(logPaths: { outFile: string; errFile: string }) {
    if (!this.process) return;
    if (this.process.stdout && typeof this.process.stdout !== "number") {
      this.pipeStream(this.process.stdout, logPaths.outFile, "stdout");
    }
    if (this.process.stderr && typeof this.process.stderr !== "number") {
      this.pipeStream(this.process.stderr, logPaths.errFile, "stderr");
    }
  }

  private async pipeStream(
    stream: ReadableStream<Uint8Array>,
    filePath: string,
    output: "stdout" | "stderr"
  ) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let remainder = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          if (remainder.trim().length > 0) {
            await this.logManager.appendJSONLog(filePath, remainder);
            remainder = "";
          }
          break;
        }

        if (this.config.raw) {
          if (output === "stdout") {
            process.stdout.write(value);
          } else {
            process.stderr.write(value);
          }
        }

        const text = remainder + decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        remainder = lines.pop() || "";

        for (const line of lines) {
          if (line.length > 0) {
            await this.logManager.appendJSONLog(filePath, line);
          }
        }
      }
    } catch {
      if (remainder.trim().length > 0) {
        await this.logManager.appendJSONLog(filePath, remainder).catch((err: unknown) =>
          warn(`append structured log ${filePath}`, err),
        );
      }
    }
  }

  
  private startMonitoring() {
      this.monitorInterval = setInterval(async () => {
        
        if (!this.pid || this.status !== "online") return;
  
        try {
          
          // 1. Fetch cross-platform CPU and Memory usage
          const stats = await pidusage(this.pid);
          
          // pidusage returns memory directly in bytes and cpu as a percentage
          this.memory = stats.memory; 
          this.cpu = stats.cpu;
  
          // 2. Track file descriptors (handles) on Linux
          // (pidusage does not provide this metric, so we keep the original logic)
          if (process.platform === "linux") {
            try {
              this.handles = (await readdir(`/proc/${this.pid}/fd`)).length;
            } catch (err) {
              // Expected when the process exits between metric ticks.
              ignore(`read /proc/${this.pid}/fd (process may have exited)`, err);
            }
          }
  
          // 3. Max memory restart
          if (this.config.maxMemoryRestart && this.memory > this.config.maxMemoryRestart) {
            console.log(`[pboss] ${this.name} exceeded memory limit (${this.memory} > ${this.config.maxMemoryRestart}), restarting...`);
            await this.restart("memory");
          }
          
        } catch (err) {
          // Metrics degrade to the last known values; recorded for diagnosis.
          ignore(`metrics tick for ${this.name} (pid ${this.pid})`, err);
        }
      }, MONITOR_INTERVAL);
  }

  private startLogRotation(logPaths: { outFile: string; errFile: string }) {
    const rotateOpts: LogRotateOptions = {
      maxSize: this.config.logMaxSize || DEFAULT_LOG_MAX_SIZE,
      retain: this.config.logRetain || DEFAULT_LOG_RETAIN,
      compress: this.config.logCompress || false,
    };

    this.logRotateInterval = setInterval(() => {
      this.logManager.checkRotation(
        this.name,
        this.id,
        rotateOpts,
        this.config.outFile,
        this.config.errorFile
      );
    }, 60000);
  }

  private setupWatch() {
    const paths = this.config.watchPaths || [this.config.cwd || process.cwd()];
    const ignorePatterns = this.config.ignoreWatch || ["node_modules", ".git", ".pboss", ".bm2"];

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    for (const watchPath of paths) {
      try {
        const w = watch(
          watchPath,
          { recursive: true },
          (_event: string, filename: string | null) => {
            if (!filename) return;
            if (ignorePatterns.some((p) => filename.includes(p))) return;

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              console.log(`[pboss] ${filename} changed, restarting ${this.name}...`);
              this.restart("watch");
            }, 1000);
          }
        );
        this.watchers.push(w);
      } catch (err) {
        // A failed watcher silently disabled watch-mode restarts — the user
        // asked for watch and thinks it works. Warn, don't swallow.
        warn(`start file watcher for ${this.name} (watch-mode restarts inactive)`, err);
      }
    }
  }

  private handleExit(code: number | string | null) {
    const wasOnline = this.status === "online";
    const oldPid = this.pid;
    // Record the raw exit facts — the cloud turns them into crash reports.
    this.lastExitCode = typeof code === "number" ? code : null;
    this.lastExitSignal = typeof code === "string" ? code : null;
    this.status = code === 0 ? "stopped" : "errored";
    this.pid = undefined;
    this.process = null;
  
    this.cleanupTimers();
    if (oldPid) {
      try { (pidusage as any).clear(oldPid); } catch (err) { ignore(`pidusage.clear(${oldPid}) on exit`, err); }
    }
  
    const uptime = Date.now() - this.startedAt;

    // A pboss-initiated stop (user stop/restart, rollback, policy stop) is
    // NOT a member "exit" in the issue-#31 sense — the operator (or the
    // policy itself) already decided what happens to this namespace.
    const deliberateStop = this.stopInitiated;
    this.stopInitiated = false;

    // Decide the supervision outcome FIRST so the issue-#32 crash event
    // can report an accurate `willRestart` at notify time.
    let gaveUp = false;
    if (wasOnline && this.config.autorestart) {
      if (uptime < this.config.minUptime) {
        this.unstableRestarts++;
        // Cap consecutive unstable restarts
        if (this.unstableRestarts >= this.config.maxRestarts) {
          gaveUp = true;
        }
      } else {
        // Process survived minUptime: reset the consecutive unstable restart budget
        this.unstableRestarts = 0;
      }
    }
    const willRestart = wasOnline && this.config.autorestart && !gaveUp;

    // Issue #32: the process exited on its own — not because pboss stopped
    // it. This is the crash signal every listener (module, second client,
    // CLI in another terminal) hears, with the raw exit facts attached.
    // A clean `exit 0` is still reported here (source "crash", exitCode 0)
    // so "process exited by itself" is one uniform contract — severity is
    // the consumer's call.
    if (!deliberateStop) {
      this.notify("process:crashed", "crash", {
        exitCode: this.lastExitCode,
        exitSignal: this.lastExitSignal,
        willRestart,
      });
      if (gaveUp) {
        this.notify("process:errored", "crash", {
          reason: `reached max consecutive unstable restarts (${this.config.maxRestarts}) — supervision gave up`,
        });
      }
    }

    if (gaveUp) {
      console.log(`[pboss] ${this.name} reached max consecutive unstable restarts (${this.config.maxRestarts}), not restarting`);
      this.status = "errored";
      // Terminal: the supervisor gave up — this member has left the
      // running set for good, so siblings may react (onNsMemberExit).
      if (!deliberateStop) this.notifyFinalExit();
      return;
    }

    if (wasOnline && this.config.autorestart) {
      // A restart is already scheduled — the exit is transient, not a
      // member exit. Siblings do not react yet.
      this.status = "waiting-restart";
      const delay = this.config.restartDelay || 0;
  
      this.restartTimer = setTimeout(() => {
        this.restartCount++; // Keep cumulative for observability
        console.log(`[pboss] Restarting ${this.name} (cumulative attempt ${this.restartCount})`);
        // Issue #32: this is the crash-autorestart's bring-back — the
        // start() below reports it as `process:restart` (source "crash"),
        // not a plain `process:start`.
        this.pendingRestartSource = "crash";
        this.start("crash").catch((err) => {
          console.error(`[pboss] Failed to restart ${this.name}:`, err);
        });
      }, delay);
    } else if (!this.config.autorestart) {
      this.status = "stopped";
      // Terminal and self-initiated (a deliberate stop would have had
      // stopInitiated set) — the member exited for good.
      if (!deliberateStop) this.notifyFinalExit();
    }
  }

  /** Issue #32: forward a real state transition to the manager's canonical
   * event source. Guarded so a broken listener can never take down the
   * supervisor's exit path — same contract as notifyFinalExit. */
  private notify(
    event: ProcessEventKind,
    source: ProcessEventSource,
    extra?: Partial<PbossProcessEvent>
  ) {
    if (!this.onProcessEvent) return;
    try {
      this.onProcessEvent(this, event, source, extra);
    } catch (err) {
      ignore(`onProcessEvent (${event}) for ${this.name}`, err);
    }
  }

  /** Issue #31: terminal, non-deliberate exit — let the manager evaluate
   * the namespace member-exit policy. Guarded so a listener error can
   * never take down the supervisor's exit path. */
  private notifyFinalExit() {
    if (!this.onFinalExit) return;
    try {
      this.onFinalExit(this);
    } catch (err) {
      ignore(`onFinalExit notification for ${this.name}`, err);
    }
  }
  
  private cleanupTimers() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.logRotateInterval) {
      clearInterval(this.logRotateInterval);
      this.logRotateInterval = null;
    }
    this.healthChecker.stopCheck(this.id);
    this.cronManager.cancel(this.id);
  }

  async stop(force: boolean = false, source: ProcessEventSource = "user"): Promise<void> {
    if (this.status !== "online" && this.status !== "launching" && this.status !== "waiting-restart") {
      return;
    }

    this.isRestarting = false;
    this.status = "stopping";
    // Issue #31: this stop is pboss-initiated — the process's exit must
    // not fire the namespace member-exit policy (cleared in handleExit).
    this.stopInitiated = true;
    this.config.autorestart = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.cleanupTimers();

    for (const w of this.watchers) {
      try { w.close(); } catch (err) { ignore(`close watcher for ${this.name}`, err); }
    }
    this.watchers = [];

    const oldPid = this.pid;

    if (this.process && this.pid) {
      if (this.config.treekill !== false) {
        await treeKill(this.pid, "SIGTERM");
      } else {
        this.process.kill("SIGTERM" as any);
      }

      if (!force) {
        const timeout = this.config.killTimeout || 5000;
        const exited = await Promise.race([
          this?.process?.exited.then(() => true),
          Bun.sleep(timeout).then(() => false),
        ]);

        if (!exited && this.process) {
          if (this.config.treekill !== false && this.pid) {
            await treeKill(this.pid, "SIGKILL");
          } else {
            this.process.kill("SIGKILL" as any);
          }
          await this?.process?.exited;
        }
      } else {
        if (this.config.treekill !== false && this.pid) {
          await treeKill(this.pid, "SIGKILL");
        } else if (this.process) {
          // Guard: the process may have ALREADY exited (handleExit nulls
          // this.process/pid) — force-stopping an exited process (e.g.
          // `pboss delete` of a stopped entry after resurrect) must be a
          // clean no-op, not a null deref.
          this.process.kill("SIGKILL" as any);
        }
        await this?.process?.exited;
      }
    }

    if (oldPid) {
      try { (pidusage as any).clear(oldPid); } catch (err) { ignore(`pidusage.clear(${oldPid}) on stop`, err); }
    }

    // Clean up cluster workers
    this.clusterManager.removeAllWorkers(this.id);

    this.status = "stopped";
    this.pid = undefined;
    this.process = null;
    this.memory = 0;
    this.cpu = 0;

    // Issue #32: a deliberate pboss stop completed — the canonical
    // `process:stop` transition (suppressed during a restart's internal
    // stop phase: a restart is one operation, reported once when the
    // process is back online).
    if (!this.suppressStopEvent) {
      this.notify("process:stop", source);
    }
  }

  async restart(source: ProcessEventSource = "user"): Promise<void> {
    this.isRestarting = true;
    const wasAutoRestart = this.config.autorestart;
    // Issue #32: the restart's own start() reports `process:restart` with
    // this source once the process is back online — the internal stop
    // phase stays silent so one operation is exactly one event.
    this.pendingRestartSource = source;
    this.suppressStopEvent = true;
    try {
      await this.stop();
    } catch (err) {
      // The restart never reached its start phase — no restart event may
      // be attributed to a LATER start() call.
      this.pendingRestartSource = null;
      throw err;
    } finally {
      this.suppressStopEvent = false;
    }
    this.config.autorestart = wasAutoRestart;
    this.isRestarting = false;
    await this.start();
  }

  async reload(): Promise<void> {
    const oldPid = this.pid;
    const oldProcess = this.process;

    this.isRestarting = true;
    this.process = null;
    this.pid = undefined;

    await this.start();

    // Wait for new process to be stable
    await Bun.sleep(2000);

    // Kill old process
    if (oldProcess && oldPid) {
      try {
        if (this.config.treekill !== false) {
          await treeKill(oldPid, "SIGTERM");
        } else {
          oldProcess.kill("SIGTERM" as any);
        }
      } catch (err) {
        // Old process already gone — reload continues with the new one.
        ignore(`SIGTERM old pid ${oldPid} during reload`, err);
      }
      try { (pidusage as any).clear(oldPid); } catch (err) { ignore(`pidusage.clear(${oldPid}) on reload`, err); }
    }

    this.isRestarting = false;
  }

  async sendSignal(signal: string): Promise<void> {
    if (this.pid) {
      process.kill(this.pid, signal as any);
    }
  }

  getState(): ProcessState {
    const envMeta = {
      ...this.config,
      status: this.status,
      pm_uptime: this.startedAt,
      restart_time: this.restartCount,
      unstable_restarts: this.unstableRestarts,
      created_at: this.createdAt,
      pm_id: this.id,
      axm_monitor: this.axmMonitor,
      last_exit_code: this.lastExitCode,
      last_exit_signal: this.lastExitSignal,
    };

    return {
      id: this.id,
      name: this.name,
      namespace: this.config.namespace,
      status: this.status,
      pid: this.pid,
      pm_id: this.id,
      monit: {
        memory: this.memory,
        cpu: this.cpu,
        handles: this.handles,
        eventLoopLatency: this.eventLoopLatency,
      },
      pboss_env: envMeta,
      bm2_env: envMeta,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      config: this.config,
      restartCount: this.restartCount,
    };
  }
}
