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

  /**
   * Issue #31: per-namespace operation locks. Every namespace-scoped
   * lifecycle operation (atomic start, group stop/restart/reload/delete,
   * namespace resume) appends to its namespace's promise chain, so two
   * terminals running `pboss restart namespace shop` and `pboss stop
   * namespace shop` serialize instead of interleaving. Different
   * namespaces have independent chains — they never block each other.
   * Standalone processes and `all` stay lock-free (the issue only
   * requires same-namespace coordination; also avoids multi-lock
   * ordering hazards).
   */
  private nsLocks = new Map<string, Promise<unknown>>();
 
   constructor() {
     this.logManager = new LogManager();
     this.clusterManager = new ClusterManager();
     this.healthChecker = new HealthChecker();
     this.cronManager = new CronManager();
     this.monitor = new Monitor();
     this.gracefulReload = new GracefulReload();
   }

  // ── Issue #31: namespace lifecycle helpers ───────────────────────────

  /**
   * Run `fn` serialized against every other namespace-scoped operation on
   * the same namespace (see nsLocks). Single-lock-per-operation usage —
   * chains cannot deadlock.
   */
  private async withNamespaceLock<T>(ns: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.nsLocks.get(ns) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    this.nsLocks.set(ns, gate);
    // A failed predecessor never wedges the chain — recorded, not thrown.
    await prev.catch((err: unknown) => ignore(`namespace "${ns}" lock chain`, err));
    try {
      return await fn();
    } finally {
      release();
      if (this.nsLocks.get(ns) === gate) this.nsLocks.delete(ns);
    }
  }

  /** Statuses meaning "the supervisor considers this running" — such
   * processes are NOT rollback-eligible and are skipped by resume. */
  private isRunningStatus(status: string): boolean {
    return status === "online" || status === "launching" || status === "waiting-restart";
  }

  /**
   * The containers of one namespace — matched by namespace ONLY. Used for
   * group-scoped operations; name/cluster targets keep their per-name
   * semantics (issue #27 precedence: a process name wins).
   */
  private resolveNamespaceGroup(ns: string): ProcessContainer[] {
    return Array.from(this.processes.values()).filter(
      (p) => p.config.namespace === ns
    );
  }

  /**
   * Issue #31: snapshot of live statuses keyed by container id — the
   * "already running" boundary for rollback. Only processes that BECOME
   * running during this invocation are rollback-eligible; ones already
   * running (or scheduled to restart) must never be touched.
   */
  private snapshotStatuses(): Map<number, string> {
    const snap = new Map<number, string>();
    for (const [id, c] of this.processes) snap.set(id, c.status);
    return snap;
  }

  /** Containers from `ids` running now but NOT running in `before`
   * (absent = created by this invocation). */
  private collectInvocationStarted(
    ids: number[],
    before: Map<number, string>
  ): ProcessContainer[] {
    const started: ProcessContainer[] = [];
    for (const id of ids) {
      const c = this.processes.get(id);
      if (!c) continue;
      const wasRunning = before.has(id) && this.isRunningStatus(before.get(id)!);
      if (!wasRunning && this.isRunningStatus(c.status)) started.push(c);
    }
    return started;
  }

  /**
   * Issue #31 rollback: stop `started` (best-effort, newest first — a
   * startup order is undone in reverse). Returns per-process ✓/✗ lines;
   * rollback failures are reported, never thrown: the ORIGINAL startup
   * failure stays the primary error.
   */
  private async rollbackInvocation(started: ProcessContainer[]): Promise<string[]> {
    const lines: string[] = [];
    for (const c of [...started].reverse()) {
      try {
        await c.stop();
        lines.push(`✓ ${c.name} stopped`);
      } catch (err) {
        lines.push(
          `✗ ${c.name} failed to stop: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (started.length > 0) await this.persist();
    return lines;
  }

  /**
   * Issue #31: start every app of ONE namespace as an atomic unit.
   *
   * - Members already running are untouched and NEVER rolled back.
   * - If any member fails to start, only the members THIS invocation
   *   started are stopped (best-effort, reverse order); the thrown error
   *   carries the original failure as the primary message plus a separate
   *   per-member rollback report.
   *
   * Must run under withNamespaceLock(ns).
   */
  private async startNamespaceGroupAtomic(
    ns: string,
    apps: StartOptions[]
  ): Promise<ProcessState[]> {
    const states: ProcessState[] = [];
    const startedByInvocation: ProcessContainer[] = [];

    try {
      for (const app of apps) {
        const before = this.snapshotStatuses();
        const result = await this.start(app);
        states.push(...result);
        startedByInvocation.push(
          ...this.collectInvocationStarted(
            result.map((s) => s.id),
            before
          )
        );
      }
      return states;
    } catch (primaryErr) {
      const rollbackLines = await this.rollbackInvocation(startedByInvocation);
      const report =
        rollbackLines.length > 0 ? `\nRollback: ${rollbackLines.join(", ")}` : "";
      throw new Error(
        `namespace "${ns}" startup failed: ${
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        }${report}`
      );
    }
  }

  /**
   * Issue #31: resume a namespace atomically — the `pboss start
   * <namespace>` path. Same rollback contract as
   * startNamespaceGroupAtomic, for containers that already exist.
   *
   * Must run under withNamespaceLock(ns).
   */
  private async resumeNamespaceAtomic(
    ns: string,
    containers: ProcessContainer[]
  ): Promise<ProcessState[]> {
    return this.atomicStartContainers(ns, containers, (c) => {
      // Same resume semantics as start()'s existing-process branch: a
      // fresh attempt clears the unstable-restart debt and restores
      // supervision (a user stop set autorestart=false as the stop
      // MECHANISM — resuming means supervising again).
      c.unstableRestarts = 0;
      c.config.autorestart = true;
      return c.start();
    });
  }

  /**
   * Issue #31 (onNsMemberExit policy): a namespaced member exited for good
   * on its own — terminal, NOT a pboss-initiated stop. Running siblings
   * whose policy is `exit` stop, so the namespace runs complete or not at
   * all. `ignore` (default) siblings and standalone processes are
   * untouched. These policy stops are pboss-initiated, so they cannot
   * cascade further.
   */
  private handleNsMemberExit(container: ProcessContainer): void {
    const ns = container.config.namespace;
    if (!ns) return; // standalone: the policy never applies

    for (const sibling of Array.from(this.processes.values())) {
      if (sibling === container || sibling.config.namespace !== ns) continue;
      if (sibling.config.onNsMemberExit !== "exit") continue;
      if (!this.isRunningStatus(sibling.status)) continue;
      console.log(
        `[pboss] namespace "${ns}" member ${container.name} exited — stopping ${sibling.name} (onNsMemberExit: exit)`
      );
      sibling
        .stop()
        .then(() => this.persist())
        .catch((err) =>
          ignore(`policy stop of ${sibling.name} (onNsMemberExit: exit)`, err)
        );
    }
  }

  /** Wire the issue-#31 exit policy hook onto a freshly built container. */
  private attach(container: ProcessContainer): ProcessContainer {
    container.onFinalExit = (c) => this.handleNsMemberExit(c);
    return container;
  }

  /**
   * True-ish when `target` resolves to a namespace GROUP: namespace
   * members exist AND the target is not also a process name (issue #27
   * precedence — a process name keeps per-name semantics). This is the
   * trigger for issue-#31 atomic/serialized group semantics.
   */
  private resolveGroupTarget(
    target: string | number
  ): { ns: string; containers: ProcessContainer[] } | null {
    if (typeof target !== "string" || target === "all" || /^\d+$/.test(target)) {
      return null;
    }
    const containers = this.resolveNamespaceGroup(target);
    if (containers.length === 0) return null;
    const nameMatch = Array.from(this.processes.values()).some(
      (p) => p.name === target || p.name.startsWith(`${target}-`)
    );
    if (nameMatch) return null;
    return { ns: target, containers };
  }

  /**
   * Issue #31: stop (or force-kill, or delete) every member of a
   * namespace — best-effort: a member that refuses to stop does not
   * prevent the others, and the surviving error(s) are aggregated into
   * one honest report at the end.
   */
  private async stopNamespaceGroup(
    ns: string,
    containers: ProcessContainer[],
    force: boolean,
    verb: string,
    opts: { remove?: boolean } = {}
  ): Promise<ProcessState[]> {
    const states: ProcessState[] = [];
    const errors: string[] = [];
    for (const c of containers) {
      try {
        await c.stop(force);
      } catch (err) {
        errors.push(
          `${c.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      states.push(c.getState());
      if (opts.remove) this.processes.delete(c.id);
    }
    await this.persist();
    if (errors.length > 0) {
      throw new Error(
        `namespace "${ns}" ${verb} failed for ${errors.length} member${errors.length > 1 ? "s" : ""} (others were ${verb === "delete" ? "removed" : "stopped"}): ${errors.join("; ")}`
      );
    }
    return states;
  }

  /**
   * Issue #31: restart a namespace as stop-all + atomic start. The stop
   * phase is best-effort and PRESERVES each member's autorestart intent
   * (stop() sets it false as the stop mechanism); the start phase is the
   * shared atomic bring-up with invocation-scoped rollback. A member
   * that failed to stop simply stays running — it is "already running"
   * for the start phase and is never rolled back.
   */
  private async restartNamespaceGroup(
    ns: string,
    containers: ProcessContainer[]
  ): Promise<ProcessState[]> {
    const stopErrors: string[] = [];
    const autorestartIntent = new Map<number, boolean>();

    for (const c of containers) {
      autorestartIntent.set(c.id, c.config.autorestart);
      try {
        await c.stop();
      } catch (err) {
        stopErrors.push(
          `${c.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    try {
      const states = await this.atomicStartContainers(ns, containers, (c) => {
        c.unstableRestarts = 0;
        // The user's pre-restart supervision intent, not the stop
        // mechanism's false.
        c.config.autorestart = autorestartIntent.get(c.id) ?? true;
        return c.start();
      });
      if (stopErrors.length > 0) {
        throw new Error(
          `namespace "${ns}" restarted, but ${stopErrors.length} member${stopErrors.length > 1 ? "s" : ""} failed to stop cleanly: ${stopErrors.join("; ")}`
        );
      }
      return states;
    } catch (startErr) {
      const startMsg = startErr instanceof Error ? startErr.message : String(startErr);
      if (stopErrors.length > 0) {
        throw new Error(`${startMsg}\nStop-phase issues: ${stopErrors.join("; ")}`);
      }
      throw startErr;
    }
  }

  /**
   * Issue #31 core: bring `containers` up through `startOne`, atomically.
   * Only members THIS call started are tracked; any failure rolls those
   * back (best-effort) and throws with the original failure primary and
   * the rollback report appended.
   */
  private async atomicStartContainers(
    ns: string,
    containers: ProcessContainer[],
    startOne: (c: ProcessContainer) => Promise<void>
  ): Promise<ProcessState[]> {
    const states: ProcessState[] = [];
    const startedByInvocation: ProcessContainer[] = [];

    try {
      for (const c of containers) {
        if (!this.isRunningStatus(c.status)) {
          await startOne(c);
          if (this.isRunningStatus(c.status)) startedByInvocation.push(c);
        }
        states.push(c.getState());
      }
      await this.persist();
      return states;
    } catch (primaryErr) {
      const rollbackLines = await this.rollbackInvocation(startedByInvocation);
      const report =
        rollbackLines.length > 0 ? `\nRollback: ${rollbackLines.join(", ")}` : "";
      throw new Error(
        `namespace "${ns}" startup failed: ${
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        }${report}`
      );
    }
  }

  // ── end namespace lifecycle helpers ──────────────────────────────────
 
  async start(options: StartOptions): Promise<ProcessState[]> {

    const resolvedInstances = this.clusterManager.resolveInstances(options.instances);
    const isCluster = options.execMode === "cluster" || resolvedInstances > 1;
    const states: ProcessState[] = [];

    // Issue #31: validate the member-exit policy once, at the single
    // choke point every start path funnels through (CLI flag, ecosystem
    // app, programmatic API, cloud deploy).
    if (
      options.onNsMemberExit !== undefined &&
      options.onNsMemberExit !== "ignore" &&
      options.onNsMemberExit !== "exit"
    ) {
      throw new Error(
        `Invalid onNsMemberExit "${options.onNsMemberExit}" — use "ignore" or "exit"`
      );
    }

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
          const container = this.attach(new ProcessContainer(
            id,
            config,
            this.logManager,
            this.clusterManager,
            this.healthChecker,
            this.cronManager
          ));
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
        
        const container = this.attach(new ProcessContainer(
          id,
          config,
          this.logManager,
          this.clusterManager,
          this.healthChecker, 
          this.cronManager
        ));

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
      const container = this.attach(new ProcessContainer(
        id, config,
        this.logManager,
        this.clusterManager,
        this.healthChecker,
        this.cronManager
      ));
  
      this.processes.set(id, container);
      await container.start();
      states.push(container.getState());
    }

    await this.persist();
    return states;
  }

  async stop(target: string | number): Promise<ProcessState[]> {
    // Issue #31: a namespace group stop is serialized against other
    // operations on the same namespace and best-effort across members —
    // one stubborn member never leaves the rest of the group running.
    const group = this.resolveGroupTarget(target);
    if (group) {
      return this.withNamespaceLock(group.ns, () =>
        this.stopNamespaceGroup(group.ns, group.containers, false, "stop")
      );
    }
    const containers = this.resolveTargetOrThrow(target, "stop");
    const states: ProcessState[] = [];
    for (const c of containers) {
      await c.stop();
      states.push(c.getState());
    }
    await this.persist();
    return states;
  }

  /**
   * Force-kill — the SIGKILL path. `stop()` asks nicely (SIGTERM + a
   * graceful wait); kill() skips the wait and escalates to SIGKILL, for
   * processes that ignore signals or wedge. The process row survives
   * (unlike `del`): a killed process can be `start()`ed again from its
   * persisted config. Cloud commands map process.stop → stop and
   * process.kill → here.
   */
  async kill(target: string | number): Promise<ProcessState[]> {
    const group = this.resolveGroupTarget(target);
    if (group) {
      return this.withNamespaceLock(group.ns, () =>
        this.stopNamespaceGroup(group.ns, group.containers, true, "kill")
      );
    }
    const containers = this.resolveTargetOrThrow(target, "kill");
    const states: ProcessState[] = [];
    for (const c of containers) {
      await c.stop(true); // force: no graceful SIGTERM window
      states.push(c.getState());
    }
    await this.persist();
    return states;
  }

  async restart(target: string | number): Promise<ProcessState[]> {
    // Issue #31: a namespace restart is stop-all + ATOMIC start — if any
    // member fails to come back, the members this restart brought up are
    // rolled back; members that never stopped (a failed stop) stay.
    const group = this.resolveGroupTarget(target);
    if (group) {
      return this.withNamespaceLock(group.ns, () =>
        this.restartNamespaceGroup(group.ns, group.containers)
      );
    }
    const containers = this.resolveTargetOrThrow(target, "restart");
    const states: ProcessState[] = [];
    for (const c of containers) {
      await c.restart();
      states.push(c.getState());
    }
    await this.persist();
    return states;
  }

  async reload(target: string | number): Promise<ProcessState[]> {
    // Issue #31: namespace reload is serialized + best-effort per member
    // (graceful reload is zero-downtime by design — atomicity does not
    // apply, but one member failing must not skip the rest of the group).
    const group = this.resolveGroupTarget(target);
    if (group) {
      return this.withNamespaceLock(group.ns, async () => {
        const errors: string[] = [];
        for (const c of group.containers) {
          try {
            await this.gracefulReload.reload([c]);
          } catch (err) {
            errors.push(
              `${c.name}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        await this.persist();
        if (errors.length > 0) {
          throw new Error(
            `namespace "${group.ns}" reload failed (other members reloaded): ${errors.join("; ")}`
          );
        }
        return group.containers.map((c) => c.getState());
      });
    }
    const containers = this.resolveTargetOrThrow(target, "reload");
    // Use graceful reload for zero downtime
    await this.gracefulReload.reload(containers);
    await this.persist();
    return containers.map((c) => c.getState());
  }

  async del(target: string | number): Promise<ProcessState[]> {
    // Issue #31: namespace delete is serialized + best-effort — every
    // member is removed even if one refuses to stop.
    const group = this.resolveGroupTarget(target);
    if (group) {
      return this.withNamespaceLock(group.ns, () =>
        this.stopNamespaceGroup(group.ns, group.containers, true, "delete", {
          remove: true,
        })
      );
    }
    const containers = this.resolveTargetOrThrow(target, "delete");
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
       onNsMemberExit: options.onNsMemberExit,
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
   
   /**
    * Live log tail for one process (by name), used by the cloud agent's
    * log.watch frames. Returns the stop function, or null when no process
    * with that name exists.
    */
   watchProcessLogs(
     name: string,
     onLines: (lines: { t: number; level: string; msg: string }[]) => void
   ): (() => void) | null {
     const container = Array.from(this.processes.values()).find((c) => c.name === name);
     if (!container) return null;
     return this.logManager.watchLogs(
       container.name,
       container.id,
       onLines,
       container.config.outFile,
       container.config.errorFile
     );
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

        const container = this.attach(new ProcessContainer(
          id,
          config,
          this.logManager,
          this.clusterManager,
          this.healthChecker,
          this.cronManager
        ));

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
 
   /**
   * Issue #31: start an ecosystem with namespace-aware lifecycle
   * boundaries.
   *
   * - Apps WITHOUT a namespace are standalone and independent: each is
   *   started on its own, a failure is recorded and the sweep CONTINUES —
   * a failing app never rolls back or blocks other standalone apps.
   * - Apps WITH the same namespace form ONE lifecycle group: the group is
   *   started atomically (in first-declaration position), and a member
   * failure rolls back only the members this invocation started.
   * - A namespace failure never affects other namespaces or standalone
   *   apps; any failure makes the overall operation report + throw at the
   *   end, after everything startable has been started.
   */
  async startEcosystem(config: EcosystemConfig): Promise<ProcessState[]> {
    const states: ProcessState[] = [];
    const failures: string[] = [];
    const startedGroups = new Set<string>();

    for (const app of config.apps) {
      if (app.namespace) {
        // The whole namespace is ONE unit — started at its
        // first-declaration position, every member included.
        if (startedGroups.has(app.namespace)) continue;
        startedGroups.add(app.namespace);
        const ns = app.namespace;
        const groupApps = config.apps.filter((a) => a.namespace === ns);
        try {
          states.push(
            ...(await this.withNamespaceLock(ns, () =>
              this.startNamespaceGroupAtomic(ns, groupApps)
            ))
          );
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      } else {
        try {
          states.push(...(await this.start(app)));
        } catch (err) {
          failures.push(
            `${app.name ?? app.script}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    // this.start() persisted per app; one final write keeps the dump in
    // lockstep with the full ecosystem (e.g. apps whose start was a no-op).
    await this.persist();

    if (failures.length > 0) {
      throw new Error(
        `ecosystem start failed — ${failures.length} failure${failures.length > 1 ? "s" : ""} (standalone failures were left running; namespace groups were rolled back where needed):\n` +
          failures.map((f) => `  ✗ ${f}`).join("\n")
      );
    }
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
 
   /**
    * The issue-#27 lifecycle entry point: start (resume) processes that
    * ALREADY exist in the list — by id, name, cluster prefix, or namespace.
    *
    * Issue #31 refines the NAMESPACE case: resuming a namespace is ATOMIC —
    * if any member fails to start, only the members this invocation
    * started are rolled back; already-running members are never touched.
    * Name/id targets keep their exact old per-process semantics, and `all`
    * applies the same boundary rules as an ecosystem start (standalone
    * processes independent, each namespace atomic).
    *
    * Every matched process that is not already running is started; online
    * ones are left untouched (no restart bump, same pid). New processes are
    * never created here — creating stays `start(options)` with a script.
    * The dump is re-saved so a stopped namespace resumed here survives the
    * next reboot as running (the Task-37 default-persistence contract).
    */
   async startTarget(target: string | number): Promise<ProcessState[]> {
     // Issue #31: namespace-group target → atomic resume under the
     // namespace lock.
     const group = this.resolveGroupTarget(target);
     if (group) {
       return this.withNamespaceLock(group.ns, () =>
         this.resumeNamespaceAtomic(group.ns, group.containers)
       );
     }

     if (target === "all") {
       // Same boundary rules as an ecosystem start: standalone processes
       // are independent (best-effort, continue on failure); every
       // namespace resumes atomically as one unit.
       const fleet = Array.from(this.processes.values());
       const standalones = fleet.filter((c) => !c.config.namespace);
       const groups = new Map<string, ProcessContainer[]>();
       for (const c of fleet) {
         const ns = c.config.namespace;
         if (!ns) continue;
         const list = groups.get(ns);
         if (list) list.push(c);
         else groups.set(ns, [c]);
       }

       const states: ProcessState[] = [];
       const failures: string[] = [];

       for (const c of standalones) {
         if (!this.isRunningStatus(c.status)) {
           c.unstableRestarts = 0;
           c.config.autorestart = true;
           try {
             await c.start();
           } catch (err) {
             failures.push(
               `${c.name}: ${err instanceof Error ? err.message : String(err)}`
             );
           }
         }
         states.push(c.getState());
       }

       for (const [ns, members] of groups) {
         try {
           states.push(
             ...(await this.withNamespaceLock(ns, () =>
               this.resumeNamespaceAtomic(ns, members)
             ))
           );
         } catch (err) {
           failures.push(err instanceof Error ? err.message : String(err));
         }
       }

       await this.persist();
       if (failures.length > 0) {
         throw new Error(
           `start all failed — ${failures.length} failure${failures.length > 1 ? "s" : ""}:\n` +
             failures.map((f) => `  ✗ ${f}`).join("\n")
         );
       }
       return states;
     }

     // Name / id — the original per-process semantics, unchanged.
     const containers = this.resolveTargetOrThrow(target, "start");
     const states: ProcessState[] = [];
     for (const c of containers) {
       if (
         c.status !== "online" &&
         c.status !== "launching" &&
         c.status !== "waiting-restart"
       ) {
         // Same resume semantics as the existing-process branch of
         // start(): a fresh attempt clears the unstable-restart debt and
         // restores supervision.
         c.unstableRestarts = 0;
         c.config.autorestart = true;
         await c.start();
       }
       states.push(c.getState());
     }
     await this.persist();
     return states;
   }

   /**
    * resolveTarget with the not-found contract the CLI needs: operating on
    * an unknown name or namespace must be a CLEAR error, not a silent empty
    * table that reads as success. "all" is exempt — an empty fleet is a
    * legitimate no-op there, not a mistake to report.
    */
   private resolveTargetOrThrow(target: string | number, verb: string): ProcessContainer[] {
     const containers = this.resolveTarget(target);
     if (target !== "all" && containers.length === 0) {
       throw new Error(
         `Process or namespace "${target}" not found — nothing to ${verb}. ` +
           `Run 'pboss list' to see registered names and namespaces.`
       );
     }
     return containers;
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
