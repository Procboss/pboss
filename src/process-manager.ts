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
 import type {
   ProcessDescription,
   ProcessState,
   StartOptions,
   EcosystemConfig,
   MetricSnapshot,
   LogEntry,
   LogItem,
 } from "./types";
 import { ProcessContainer } from "./process-container";
 import { LogManager } from "./log-manager";
 import { ClusterManager } from "./cluster-manager";
 import { HealthChecker } from "./health-checker";
 import { CronManager } from "./cron-manager";
 import { Monitor } from "./monitor";
 import { GracefulReload } from "./graceful-reload";
 import { parseMemory, DUMP_FILE } from "./utils";
 import { ignore } from "./error-handling";
 import { mkdir } from "fs/promises";
 import {
   DEFAULT_KILL_TIMEOUT,
   DEFAULT_MAX_RESTARTS,
   DEFAULT_MIN_UPTIME,
   DEFAULT_RESTART_DELAY,
   DEFAULT_LOG_MAX_SIZE,
   DEFAULT_LOG_RETAIN,
 } from "./constants";
import path from "path";
import type { ReadableStreamController } from "bun";
 
 export class ProcessManager {
   private processes: Map<number, ProcessContainer> = new Map();
   private nextId: number = 0;
   public logManager: LogManager;
   public clusterManager: ClusterManager;
   public healthChecker: HealthChecker;
   public cronManager: CronManager;
   public monitor: Monitor;
   public gracefulReload: GracefulReload;
 
   constructor() {
     this.logManager = new LogManager();
     this.clusterManager = new ClusterManager();
     this.healthChecker = new HealthChecker();
     this.cronManager = new CronManager();
     this.monitor = new Monitor();
     this.gracefulReload = new GracefulReload();
   }
 
  async start(options: StartOptions): Promise<ProcessState[]> {

    const resolvedInstances = this.clusterManager.resolveInstances(options.instances);
    const isCluster = options.execMode === "cluster" || resolvedInstances > 1;
    const states: ProcessState[] = [];

    options.script = path.isAbsolute(options.script)
      ? options.script
      : path.join(options.cwd || process.cwd(), options.script);


    if (!(await Bun.file(options.script).exists())) {
      throw new Error(`Script not found: ${options.script}`);
    }

    const existing = this.findExistingProcesses(options, options.script);
    if (existing.length > 0) {
      for (const container of existing) {
        if (
          container.status !== "online" &&
          container.status !== "launching" &&
          container.status !== "waiting-restart"
        ) {
          container.config.autorestart = options.autorestart !== false;
          container.unstableRestarts = 0;
          if (options.env) {
            container.config.env = { ...container.config.env, ...options.env };
          }
          if (options.args && options.args.length > 0) {
            container.config.args = options.args;
          }
          if (options.cwd) {
            container.config.cwd = options.cwd;
          }
          await container.start();
        }
        states.push(container.getState());
      }

      if (isCluster && existing.length < resolvedInstances) {
        const baseName = options.name || path.basename(options.script).replace(/\.\w+$/, "") || `app-${this.nextId}`;
        for (let i = existing.length; i < resolvedInstances; i++) {
          const id = this.nextId++;
          const name = `${baseName}-${i}`;
          const config = this.buildConfig(id, name, options, resolvedInstances, i);
          const container = new ProcessContainer(
            id,
            config,
            this.logManager,
            this.clusterManager,
            this.healthChecker,
            this.cronManager
          );
          this.processes.set(id, container);
          await container.start();
          states.push(container.getState());
        }
      }

      await this.persist();
      return states;
    }

    if (isCluster) {
      // In cluster mode, each instance is a separate container
      for (let i = 0; i < resolvedInstances; i++) {
          
        const id = this.nextId++;
        const baseName = options.name || path.basename(options.script).replace(/\.\w+$/, "") || `app-${id}`;
        const name = resolvedInstances > 1 ? `${baseName}-${i}` : baseName;

        const config = this.buildConfig(id, name, options, resolvedInstances, i);
        
        const container = new ProcessContainer(
          id,
          config,
          this.logManager,
          this.clusterManager,
          this.healthChecker, 
          this.cronManager
        );

        this.processes.set(id, container);
        await container.start();
        states.push(container.getState());
      }
      
    } else {
      const id = this.nextId++;
      const name =
          options.name ||
          path.basename(options.script).replace(/\.\w+$/, "") ||
          `app-${id}`;
  
      const config = this.buildConfig(id, name, options, 1, 0);
      const container = new ProcessContainer(
        id, config,
        this.logManager,
        this.clusterManager,
        this.healthChecker,
        this.cronManager
      );
  
      this.processes.set(id, container);
      await container.start();
      states.push(container.getState());
    }

    await this.persist();
    return states;
  }

  async stop(target: string | number): Promise<ProcessState[]> {
    const containers = this.resolveTarget(target);
    const states: ProcessState[] = [];
    for (const c of containers) {
      await c.stop();
      states.push(c.getState());
    }
    await this.persist();
    return states;
  }

  async restart(target: string | number): Promise<ProcessState[]> {
    const containers = this.resolveTarget(target);
    const states: ProcessState[] = [];
    for (const c of containers) {
      await c.restart();
      states.push(c.getState());
    }
    await this.persist();
    return states;
  }

  async reload(target: string | number): Promise<ProcessState[]> {
    const containers = this.resolveTarget(target);
    // Use graceful reload for zero downtime
    await this.gracefulReload.reload(containers);
    await this.persist();
    return containers.map((c) => c.getState());
  }

  async del(target: string | number): Promise<ProcessState[]> {
    const containers = this.resolveTarget(target);
    const states: ProcessState[] = [];
    for (const c of containers) {
      await c.stop(true);
      states.push(c.getState());
      this.processes.delete(c.id);
    }
    await this.persist();
    return states;
  }

    async stopAll(opts: { persist?: boolean } = {}): Promise<ProcessState[]> {
      const states: ProcessState[] = [];
      for (const c of this.processes.values()) {
        await c.stop();
        states.push(c.getState());
      }
      this.healthChecker.stopAll();
      this.cronManager.cancelAll();
      // Default: persist (a user's `pboss stop all` marks everything stopped
      // in the dump). The daemon shutdown path (the `kill` RPC, systemd's
      // ExecStop) opts OUT: the dump must keep describing what SHOULD run so
      // the next boot resurrects everything as it was.
      if (opts.persist !== false) await this.persist();
      return states;
    }

  private buildConfig(
     id: number,
     name: string,
     options: StartOptions,
     instances: number,
     workerIndex: number
   ): ProcessDescription {
     return {
       id,
       name,
       script: options.script,
       args: options.args || [],
       cwd: options.cwd || process.cwd(),
        env: {
          ...options.env,
          ...(instances > 1
            ? {
                NODE_APP_INSTANCE: String(workerIndex),
                PBOSS_INSTANCE_ID: String(workerIndex),
                BM2_INSTANCE_ID: String(workerIndex),
              }
            : {}),
        },
        instances,
        execMode: instances > 1 ? "cluster" : (options.execMode || "fork"),
        autorestart: options.autorestart !== false,
        maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
        minUptime: options.minUptime ?? DEFAULT_MIN_UPTIME,
        maxMemoryRestart: options.maxMemoryRestart
          ? parseMemory(options.maxMemoryRestart)
          : undefined,
        watch: Array.isArray(options.watch) ? true : (options.watch ?? false),
        watchPaths: Array.isArray(options.watch) ? options.watch : undefined,
        ignoreWatch: options.ignoreWatch || ["node_modules", ".git", ".pboss", ".bm2"],
       cronRestart: options.cron,
       interpreter: options.interpreter,
       interpreterArgs: options.interpreterArgs,
       mergeLogs: options.mergeLogs ?? false,
       raw: options.raw ?? false,
       logDateFormat: options.logDateFormat,
       errorFile: options.errorFile,
       outFile: options.outFile,
       killTimeout: options.killTimeout ?? DEFAULT_KILL_TIMEOUT,
       restartDelay: options.restartDelay ?? DEFAULT_RESTART_DELAY,
       port: options.port,
       healthCheckUrl: options.healthCheckUrl,
       healthCheckInterval: options.healthCheckInterval,
       healthCheckTimeout: options.healthCheckTimeout,
       healthCheckMaxFails: options.healthCheckMaxFails,
       logMaxSize: options.logMaxSize ? parseMemory(options.logMaxSize) : DEFAULT_LOG_MAX_SIZE,
       logRetain: options.logRetain ?? DEFAULT_LOG_RETAIN,
       logCompress: options.logCompress,
       waitReady: options.waitReady,
       listenTimeout: options.listenTimeout,
       namespace: options.namespace,
       nodeArgs: options.nodeArgs,
       sourceMapSupport: options.sourceMapSupport,
       treekill: true,
     };
   }

    async restartAll(): Promise<ProcessState[]> {
      const states: ProcessState[] = [];
      for (const c of this.processes.values()) {
        await c.restart();
        states.push(c.getState());
      }
      await this.persist();
      return states;
    }

    async reloadAll(): Promise<ProcessState[]> {
      const containers = Array.from(this.processes.values());
      await this.gracefulReload.reload(containers);
      await this.persist();
      return containers.map((c) => c.getState());
    }

    async deleteAll(): Promise<ProcessState[]> {
      const states: ProcessState[] = [];
      for (const c of this.processes.values()) {
        await c.stop(true);
        states.push(c.getState());
      }
      this.healthChecker.stopAll();
      this.cronManager.cancelAll();
      this.processes.clear();
      this.nextId = 0;
      await this.persist();
      return states;
    }
 
   async scale(target: string | number, count: number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     if (containers.length === 0) return [];
   
     const first = containers[0]!;
     const baseName = first.name.replace(/-\d+$/, "");
     const currentCount = containers.length;
   
     if (count > currentCount) {
       // Scale up
       const toAdd = count - currentCount;
       const baseConfig = first.config;
       const states: ProcessState[] = [];
   
       for (let i = 0; i < toAdd; i++) {
         const result = await this.start({
           name: `${baseName}-${currentCount + i}`,
           script: baseConfig.script,
           args: baseConfig.args,
           cwd: baseConfig.cwd,
           env: baseConfig.env,
           execMode: baseConfig.execMode,
           autorestart: baseConfig.autorestart,
           maxRestarts: baseConfig.maxRestarts,
           watch: baseConfig.watch,
           port: baseConfig.port,
         });
         states.push(...result);
       }
   
       return [...containers.map((c) => c.getState()), ...states];
     } else if (count < currentCount) {
       // Scale down
       const toRemove = containers.slice(count);
       for (const c of toRemove) {
         await c.stop(true);
         this.processes.delete(c.id);
       }
       await this.persist();
       return containers.slice(0, count).map((c) => c.getState());
     }
   
     await this.persist();
     return containers.map((c) => c.getState());
   }
   
   list(): ProcessState[] {
     return Array.from(this.processes.values()).map((p) => p.getState());
   }
 
   describe(target: string | number): ProcessState[] {
     return this.resolveTarget(target).map((p) => p.getState());
   }
 
   async getLogs(target: string | number, lines: number = 20) {
     
     const containers = this.resolveTarget(target);
     
    // just for readability
     let results: LogItem[] = [];
          
     results = (await Promise.all(containers.map(async (c) => {
      const logs = await this.logManager.readLogs(c.name, c.id, lines, c.config.outFile, c.config.errorFile);     
      return logs.map((log) => ({ name: c.name, id: c.id, ...log }))
     }))).flat();
     
     
     let sortedResults = results
       .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))
     
     
     return sortedResults;
   }
   
   async streamLogs(target: string | number, streamController: ReadableStreamDefaultController, signal: AbortSignal) {
     
     const containers = this.resolveTarget(target);
     const lm = this.logManager;
     
     await Promise.all(containers.map(async (c) => (
      lm.tailLog(c.name, c.id, streamController, signal)
     )))
     
   }
 
   async flushLogs(target?: string | number) {
     const containers = target
       ? this.resolveTarget(target)
       : Array.from(this.processes.values());
     for (const c of containers) {
       await this.logManager.flush(c.name, c.id, c.config.outFile, c.config.errorFile);
     }
   }
 
  /**
   * Persist the current process list to the dump file (`~/.pboss/dump.json`).
   *
   * Entries carry a `stopped` flag so a reboot can tell apart "was running"
   * (resurrect it running) from "the user stopped it" (resurrect it stopped):
   * anything whose live status is "stopped" — a user stop or a clean exit —
   * comes back stopped; anything else (online, errored, launching, …) comes
   * back running, because it was supposed to be running.
   */
  async save(): Promise<void> {
    const data = Array.from(this.processes.values()).map((p) => ({
      config: p.config,
      restartCount: p.restartCount,
      unstableRestarts: p.unstableRestarts,
      stopped: p.status === "stopped",
    }));
    // The dump must be writable even when the daemon starts before
    // ensureDirs() has run (a bare ProcessManager in tests, or the first
    // command of a fresh install) — never let a missing directory fail a save.
    await mkdir(path.dirname(DUMP_FILE), { recursive: true });
    await Bun.write(DUMP_FILE, JSON.stringify(data, null, 2));
  }

  /**
   * Auto-save after every mutation of the process list (start, stop, restart,
   * reload, delete, scale, reset). This is what makes processes survive
   * reboots BY DEFAULT: the dump always mirrors the live list, so boot-time
   * resurrect restores exactly what the user last had.
   *
   * Failures are reported, not thrown: a broken dump must never fail the
   * process command that triggered the save.
   */
  private async persist(): Promise<void> {
    try {
      await this.save();
    } catch (err) {
      ignore("auto-save process list (dump not updated)", err);
      console.warn(
        `[pboss] could not persist the process list: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async resurrect(): Promise<ProcessState[]> {
    try {
      const file = Bun.file(DUMP_FILE);
      if (!(await file.exists())) return [];
      const data = await file.json();
      const states: ProcessState[] = [];

      for (const item of data) {
        const savedConfig: ProcessDescription = item.config;
        if (!savedConfig || !savedConfig.script) continue;

        if (!(await Bun.file(savedConfig.script).exists())) {
          console.warn(`[pboss] Cannot resurrect ${savedConfig.name}: script not found at ${savedConfig.script}`);
          continue;
        }

        let id = savedConfig.id;
        if (id !== undefined && this.processes.has(id)) {
          const existing = this.processes.get(id)!;
          if (existing.status === "online" || existing.status === "launching") {
            states.push(existing.getState());
            continue;
          }
        } else if (id === undefined) {
          id = this.nextId++;
        }

        if (id >= this.nextId) {
          this.nextId = id + 1;
        }

        const config: ProcessDescription = {
          ...savedConfig,
          id,
        };

        const container = new ProcessContainer(
          id,
          config,
          this.logManager,
          this.clusterManager,
          this.healthChecker,
          this.cronManager
        );

        container.restartCount = item.restartCount ?? 0;
        container.unstableRestarts = item.unstableRestarts ?? 0;

        this.processes.set(id, container);
        // Entries saved while stopped (the user stopped them, or they exited
        // cleanly) are restored as stopped containers — listed, ready to
        // `pboss restart <name>`, but NOT auto-started. Everything else was
        // supposed to be running, so start it.
        if (item.stopped) {
          states.push(container.getState());
        } else {
          await container.start();
          states.push(container.getState());
        }
      }

      return states;
    } catch (err) {
      console.error("[pboss] Resurrect failed:", err);
      return [];
    }
  }
 
   async startEcosystem(config: EcosystemConfig): Promise<ProcessState[]> {
     const states: ProcessState[] = [];
     for (const app of config.apps) {
       const result = await this.start(app);
       states.push(...result);
     }
     // this.start() persisted per app; one final write keeps the dump in
     // lockstep with the full ecosystem (e.g. apps whose start was a no-op).
     await this.persist();
     return states;
   }
 
   async sendSignal(target: string | number, signal: string): Promise<void> {
     for (const c of this.resolveTarget(target)) {
       await c.sendSignal(signal);
     }
   }
 
   async getMetrics(): Promise<MetricSnapshot> {
     return this.monitor.takeSnapshot(this.list());
   }
 
   getPrometheusMetrics(): string {
     return this.monitor.generatePrometheusMetrics(this.list());
   }
 
   getMetricsHistory(seconds: number = 300): MetricSnapshot[] {
     return this.monitor.getHistory(seconds);
   }
 
   async reset(target: string | number): Promise<ProcessState[]> {
     const containers = this.resolveTarget(target);
     for (const c of containers) {
       c.restartCount = 0;
       c.unstableRestarts = 0;
     }
     await this.persist();
     return containers.map((c) => c.getState());
   }
 
   private resolveTarget(target: string | number): ProcessContainer[] {
     
     if (target === "all") {
       return Array.from(this.processes.values());
     }
 
     if (typeof target === "number" || /^\d+$/.test(String(target))) {
       const id = typeof target === "number" ? target : parseInt(target);
       const proc = this.processes.get(id);
       return proc ? [proc] : [];
     }
 
      // Match by name or namespace
      return Array.from(this.processes.values()).filter(
        (p) =>
          p.name === target ||
          p.name.startsWith(`${target}-`) ||
          p.config.namespace === target
      );
    }

    private findExistingProcesses(options: StartOptions, scriptPath: string): ProcessContainer[] {
      if (options.name) {
        const targetName = options.name;
        const clusterRegex = new RegExp(`^${this.escapeRegex(targetName)}-\\d+$`);
        return Array.from(this.processes.values()).filter(
          (p) =>
            p.name === targetName ||
            clusterRegex.test(p.name) ||
            p.config.name === targetName
        );
      }

      const derivedName = path.basename(scriptPath).replace(/\.\w+$/, "");
      const clusterRegex = new RegExp(`^${this.escapeRegex(derivedName)}-\\d+$`);

      // First match by exact script path
      const matchedByScript = Array.from(this.processes.values()).filter(
        (p) => p.config.script === scriptPath
      );
      if (matchedByScript.length > 0) return matchedByScript;

      // Next match by derived name
      return Array.from(this.processes.values()).filter(
        (p) => p.name === derivedName || clusterRegex.test(p.name)
      );
    }

    private escapeRegex(str: string): string {
      return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
