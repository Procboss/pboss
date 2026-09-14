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
 import { EventEmitter } from "events";
 import {
   DependencyEngine,
   parseDependsOn,
   type StartInvocation,
 } from "./dependencies";
 import type {
   DepsReport,
   DependentRef,
   NormalizedDependency,
 } from "./types";
 import {
   PROCESS_EVENT_KINDS,
   type PbossProcessEvent,
   type ProcessEventKind,
   type ProcessEventSource,
   type ProcessManagerEventMap,
 } from "./events";
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
 
 /**
 * The canonical source of pboss's internal events (issue #32).
 *
 * Every ProcessContainer state transition — operator-initiated OR
 * autonomous (crash autorestart, maxMemoryRestart, watch, cron,
 * health-check) — is funneled here and re-emitted under typed
 * `process:*` keys. Modules receive this exact object in `init(pm)` and
 * can `pm.on("process:crashed", …)` without polling; remote clients
 * receive the same events over the daemon's SSE `subscribeEvents` stream
 * (see subscribeEvents() below).
 */
 export class ProcessManager extends EventEmitter<ProcessManagerEventMap> {
   private processes: Map<number, ProcessContainer> = new Map();
   private nextId: number = 0;
   public logManager: LogManager;
   public clusterManager: ClusterManager;
   public healthChecker: HealthChecker;
   public cronManager: CronManager;
   public monitor: Monitor;
   public gracefulReload: GracefulReload;
   /**
    * Issue #33: the dependency engine — resolution, the dependency graph,
    * providers, the level-concurrent executor, inspection reports and the
    * stop/delete safety lookups. Owned by THIS manager instance so tests
    * (and future hosts) can swap the system-service provider per manager.
    */
   public dependencies: DependencyEngine;

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
     super();
     this.logManager = new LogManager();
     this.clusterManager = new ClusterManager();
     this.healthChecker = new HealthChecker();
     this.cronManager = new CronManager();
     this.monitor = new Monitor();
     this.gracefulReload = new GracefulReload();
     // Issue #33: the engine sees the live container list through this
     // accessor (host interface — no bidirectional construction coupling).
     this.dependencies = new DependencyEngine({ containers: () => this.allContainers() });
   }

  /** The engine's view of the live fleet (DependencyHost). */
   allContainers(): ProcessContainer[] {
     return Array.from(this.processes.values());
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
   * startup order is undone in reverse; deduplicated — a container can
   * enter the set from both the dependency executor and the member
   * collector). Returns per-process ✓/✗ lines; rollback failures are
   * reported, never thrown: the ORIGINAL startup failure stays the
   * primary error.
   */
  private async rollbackInvocation(started: ProcessContainer[]): Promise<string[]> {
    const lines: string[] = [];
    const seen = new Set<number>();
    for (const c of [...started].reverse()) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
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
   * Issue #33: dependencies started BY this group's invocation (deps can
   * cross namespace boundaries — the issue's example has `postgres` in ns
   * "data" started for `api` in ns "backend") join the same rollback scope.
   * Members already running are untouched and NEVER rolled back; if any
   * member fails, only the containers THIS invocation started — members
   * AND dependency starts — are stopped (best-effort, reverse order);
   * already-running processes outside the operation are never touched.
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
        const result = await this.startWithScope(app, { startedByInvocation });
        states.push(...result);
        for (const c of this.collectInvocationStarted(
          result.map((s) => s.id),
          before
        )) {
          if (!startedByInvocation.includes(c)) startedByInvocation.push(c);
        }
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
   * Issue #33: each member's dependencies are resolved (and started if
   * stopped) BEFORE the member itself, inside the shared rollback scope.
   *
   * Must run under withNamespaceLock(ns).
   */
  private async resumeNamespaceAtomic(
    ns: string,
    containers: ProcessContainer[]
  ): Promise<ProcessState[]> {
    const startedByInvocation: ProcessContainer[] = [];
    return this.atomicStartContainers(ns, containers, (c) => {
      // Same resume semantics as start()'s existing-process branch: a
      // fresh attempt clears the unstable-restart debt and restores
      // supervision (a user stop set autorestart=false as the stop
      // MECHANISM — resuming means supervising again).
      c.unstableRestarts = 0;
      c.config.autorestart = true;
      return c.start();
    }, startedByInvocation);
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
        .stop(false, "policy")
        .then(() => this.persist())
        .catch((err) =>
          ignore(`policy stop of ${sibling.name} (onNsMemberExit: exit)`, err)
        );
    }
  }

  /** Wire the issue-#31 exit policy hook AND the issue-#32 event hook
   * onto a freshly built container — every container the manager ever
   * creates (start paths and resurrect) goes through here. */
  private attach(container: ProcessContainer): ProcessContainer {
    container.onFinalExit = (c) => this.handleNsMemberExit(c);
    container.onProcessEvent = (c, event, source, extra) =>
      this.emitProcessEvent(c, event, source, extra);
    return container;
  }

  /**
   * Issue #32: turn a container transition into the canonical typed
   * event. One event = one process, with a fresh state snapshot. Guarded:
   * a throwing listener is recorded, never allowed to break the
   * supervisor path that caused the transition.
   */
  private emitProcessEvent(
    container: ProcessContainer,
    event: ProcessEventKind,
    source: ProcessEventSource,
    extra: Partial<PbossProcessEvent> = {}
  ): void {
    const payload: PbossProcessEvent = {
      event,
      source,
      at: Date.now(),
      process: container.getState(),
      ...extra,
    };
    try {
      (this.emit as (event: string, payload: PbossProcessEvent) => void)(
        event,
        payload
      );
    } catch (err) {
      ignore(`emit ${event} for ${container.name}`, err);
    }
  }

  /**
   * Issue #32: bridge the canonical events onto a daemon SSE stream —
   * the `subscribeEvents` counterpart of streamLogs(). Every `process:*`
   * event is JSON-framed (`data: {...}\n\n`) onto `streamController`;
   * aborting `signal` (client disconnect / daemon shutdown) removes ALL
   * of this subscription's listeners from the ProcessManager, so nothing
   * leaks and no dangling controllers are retained.
   *
   * Multiple concurrent subscriptions are independent — each client gets
   * every event.
   */
  async subscribeEvents(
    streamController: ReadableStreamDefaultController,
    signal: AbortSignal
  ): Promise<void> {
    const forward = (event: PbossProcessEvent) => {
      try {
        streamController.enqueue(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Stream closed/broken — detach immediately (below).
        detach();
      }
    };

    const detach = () => {
      for (const kind of PROCESS_EVENT_KINDS) {
        (this.off as (event: string, l: (e: PbossProcessEvent) => void) => void)(
          kind,
          forward
        );
      }
    };

    for (const kind of PROCESS_EVENT_KINDS) {
      (this.on as (event: string, l: (e: PbossProcessEvent) => void) => void)(
        kind,
        forward
      );
    }

    signal.addEventListener("abort", detach, { once: true });
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
      if (opts.remove) {
        this.processes.delete(c.id);
        // Issue #32: group delete — one removal event per member.
        this.emitProcessEvent(c, "process:delete", "user");
      }
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
      const startedByInvocation: ProcessContainer[] = [];
      const states = await this.atomicStartContainers(ns, containers, (c) => {
        c.unstableRestarts = 0;
        // The user's pre-restart supervision intent, not the stop
        // mechanism's false.
        c.config.autorestart = autorestartIntent.get(c.id) ?? true;
        return c.start();
      }, startedByInvocation);
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
   * Issue #33: `startedByInvocation` is the shared rollback scope — the
   * dependency executor records dep starts into the SAME array, so a
   * failure rolls back dependencies started by this invocation while
   * processes that were already running stay untouched (rules 10/11).
   */
  private async atomicStartContainers(
    ns: string,
    containers: ProcessContainer[],
    startOne: (c: ProcessContainer) => Promise<void>,
    startedByInvocation: ProcessContainer[] = []
  ): Promise<ProcessState[]> {
    const states: ProcessState[] = [];

    try {
      for (const c of containers) {
        if (!this.isRunningStatus(c.status)) {
          // Issue #33: dependencies first — a member never starts before
          // its required dependencies are satisfied.
          await this.dependencies.ensureForStart(
            c.name,
            this.normalizedDeps(c.config.dependsOn),
            { startedByInvocation }
          );
          await startOne(c);
          if (this.isRunningStatus(c.status) && !startedByInvocation.includes(c)) {
            startedByInvocation.push(c);
          }
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

  /** Config deps, tolerated (persisted dumps can predate normalization). */
  private normalizedDeps(raw: unknown): NormalizedDependency[] {
    try {
      return parseDependsOn(raw as import("./types").DependencySpec[] | undefined);
    } catch {
      return [];
    }
  }

  // ── end namespace lifecycle helpers ──────────────────────────────────
 
  async start(options: StartOptions): Promise<ProcessState[]> {
    // Issue #33: an externally-initiated start owns its rollback scope —
    // dependencies started for THIS process (redis for api) are rolled
    // back when the process fails; the issue's exact example.
    return this.startWithScope(options, null);
  }

  /**
   * Issue #33: shared entry point. `scope === null` = own the rollback
   * (perform it on failure); a passed scope (namespace groups) defers
   * rollback to the scope owner.
   */
  private async startWithScope(
    options: StartOptions,
    scope: StartInvocation | null
  ): Promise<ProcessState[]> {
    const own = scope === null;
    const inv: StartInvocation = scope ?? { startedByInvocation: [] };
    try {
      return await this.startInternal(options, inv);
    } catch (err) {
      if (!own) throw err;
      const lines = await this.rollbackInvocation(inv.startedByInvocation);
      const report = lines.length > 0 ? `\nRollback: ${lines.join(", ")}` : "";
      if (err instanceof Error) {
        err.message = `${err.message}${report}`;
        throw err;
      }
      throw new Error(`${String(err)}${report}`);
    }
  }

  private async startInternal(
    options: StartOptions,
    inv: StartInvocation
  ): Promise<ProcessState[]> {

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

    // Issue #33: validate the dependency configuration at the same choke
    // point — garbage fails HERE, with a clear message, never deep inside
    // the executor.
    const dependsOn = parseDependsOn(options.dependsOn);

    options.script = path.isAbsolute(options.script)
      ? options.script
      : path.join(options.cwd || process.cwd(), options.script);


    if (!(await Bun.file(options.script).exists())) {
      throw new Error(`Script not found: ${options.script}`);
    }

    const existing = this.findExistingProcesses(options, options.script);
    if (existing.length > 0) {
      // Issue #33: an all-running app keeps its no-op semantics — a
      // dependency check here would surprise-start unrelated stopped
      // dependencies on a resume no-op. Only a start that will ACTUALLY
      // bring something up resolves dependencies first.
      const willStart = existing.some(
        (c) =>
          c.status !== "online" &&
          c.status !== "launching" &&
          c.status !== "waiting-restart"
      );
      if (willStart) {
        const appName =
          options.name || path.basename(options.script).replace(/\.\w+$/, "");
        await this.dependencies.ensureForStart(appName, dependsOn, inv);
      }

      for (const container of existing) {
        const wasRunning = this.isRunningStatus(container.status);
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
          // Issue #33: keep the declared dependencies on resume too — a
          // re-`pboss start` of a stopped app must keep honoring its
          // dependsOn (and persist it again).
          container.config.dependsOn = dependsOn;
          await container.start();
          if (!wasRunning && this.isRunningStatus(container.status)) {
            inv.startedByInvocation.push(container);
          }
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
          if (this.isRunningStatus(container.status)) {
            inv.startedByInvocation.push(container);
          }
          states.push(container.getState());
        }
      }

      await this.persist();
      return states;
    }

    // Issue #33: dependencies BEFORE the target exists — a blocked start
    // leaves no half-created process behind, and deps started here are
    // tracked for the invocation-scoped rollback.
    const targetName =
      options.name || path.basename(options.script).replace(/\.\w+$/, "") || `app-${this.nextId}`;
    await this.dependencies.ensureForStart(targetName, dependsOn, inv);

    if (isCluster) {
      // In cluster mode, each instance is a separate container
      for (let i = 0; i < resolvedInstances; i++) {
          
        const id = this.nextId++;
        const name = resolvedInstances > 1 ? `${targetName}-${i}` : targetName;

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
        if (this.isRunningStatus(container.status)) {
          inv.startedByInvocation.push(container);
        }
        states.push(container.getState());
      }
      
    } else {
      const id = this.nextId++;
      const name = targetName;
  
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
      if (this.isRunningStatus(container.status)) {
        inv.startedByInvocation.push(container);
      }
      states.push(container.getState());
    }

    await this.persist();
    return states;
  }

  /**
   * Issue #33: warn when stopping processes that other running processes
   * still require — `pboss stop postgres` must not SILENTLY strand `api`.
   * A warning, not a block: stopping for maintenance is legitimate, and
   * dependents keep running (no runtime propagation — a future policy).
   */
  private warnDependents(victims: ProcessContainer[], verb: string): void {
    try {
      const affected = this.dependencies.stopAffected(victims);
      if (affected.length === 0) return;
      const names = victims.map((v) => v.name).join(", ");
      console.warn(
        `[pboss] warning: ${verb} "${names}" — still required by ${affected
          .map((a) => `"${a.name}"`)
          .join(", ")}. They keep running, but their required dependency will be unavailable until it is started again.`
      );
    } catch (err) {
      ignore("warn dependents", err);
    }
  }

  async stop(target: string | number): Promise<ProcessState[]> {
    // Issue #31: a namespace group stop is serialized against other
    // operations on the same namespace and best-effort across members —
    // one stubborn member never leaves the rest of the group running.
    const group = this.resolveGroupTarget(target);
    if (group) {
      return this.withNamespaceLock(group.ns, () => {
        this.warnDependents(group.containers, "stopping");
        return this.stopNamespaceGroup(group.ns, group.containers, false, "stop");
      });
    }
    const containers = this.resolveTargetOrThrow(target, "stop");
    this.warnDependents(containers, "stopping");
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
      return this.withNamespaceLock(group.ns, () => {
        this.warnDependents(group.containers, "killing");
        return this.stopNamespaceGroup(group.ns, group.containers, true, "kill");
      });
    }
    const containers = this.resolveTargetOrThrow(target, "kill");
    this.warnDependents(containers, "killing");
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
      // Issue #33: restart is dependency-aware. Dependencies are resolved
      // (and started if stopped) BEFORE the restart — a blocked restart
      // fails up front, while the process is still running, instead of
      // stopping it and failing to bring it back. Already-running
      // dependencies are never restarted (the issue's "restart api must
      // not restart postgres"); restarting a dependency never touches its
      // dependents (no runtime propagation yet).
      const inv: StartInvocation = { startedByInvocation: [] };
      try {
        await this.dependencies.ensureForStart(
          c.name,
          this.normalizedDeps(c.config.dependsOn),
          inv
        );
        await c.restart();
      } catch (err) {
        const lines = await this.rollbackInvocation(inv.startedByInvocation);
        const report = lines.length > 0 ? `\nRollback: ${lines.join(", ")}` : "";
        if (err instanceof Error) {
          err.message = `${err.message}${report}`;
          throw err;
        }
        throw new Error(`${String(err)}${report}`);
      }
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
            // Issue #32: one reload event per member, emitted at completion.
            this.emitProcessEvent(c, "process:reload", "user");
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
    // Issue #32: the graceful reload op completed for these processes.
    for (const c of containers) {
      this.emitProcessEvent(c, "process:reload", "user");
    }
    await this.persist();
    return containers.map((c) => c.getState());
  }

  /**
   * Issue #33: refuse to delete a dependency other processes still
   * require — deleting it would silently break THEIR dependency graph
   * (they would fail to start after the next stop/reboot). `--force`
   * (CLI) / `{ force: true }` (API) overrides; the dependents keep running
   * either way. `all` deletes everything, so nothing is left stranded.
   */
  private assertNoDependents(target: string | number, force: boolean): void {
    if (target === "all" || force) return;
    const group = this.resolveGroupTarget(target);
    const victims = group
      ? group.containers
      : this.resolveTarget(target);
    if (victims.length === 0) return; // unknown target: the existing not-found error reports it
    const affected = this.dependencies.deleteAffected(victims);
    if (affected.length === 0) return;
    const victimNames = victims.map((v) => v.name).join(", ");
    const dependentList = affected.map((a) => `"${a.name}"`).join(", ");
    throw new Error(
      `Cannot delete "${target}" (${victimNames}) — ${dependentList} still ${
        affected.length > 1 ? "depend" : "depends"
      } on it.\n` +
        `Those processes will fail to start until the dependency is restored or removed from their dependsOn.\n` +
        `Run with --force (CLI) or pass { force: true } (API) to delete it anyway.`
    );
  }

  async del(
    target: string | number,
    opts: { force?: boolean } = {}
  ): Promise<ProcessState[]> {
    // Issue #33: the dependency-graph integrity guard, before anything stops.
    this.assertNoDependents(target, opts.force === true);

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
      // Issue #32: removal from the list is a manager-level transition —
      // the container only knows about stopping, not deletion.
      this.emitProcessEvent(c, "process:delete", "user");
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
       // Issue #33: normalized (already validated upstream) — this is what
       // the dump persists and what the engine reads back at boot.
       dependsOn: parseDependsOn(options.dependsOn),
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
      // Issue #32: one reload event per process, emitted at completion.
      for (const c of containers) {
        this.emitProcessEvent(c, "process:reload", "user");
      }
      await this.persist();
      return containers.map((c) => c.getState());
    }

    async deleteAll(): Promise<ProcessState[]> {
      const states: ProcessState[] = [];
      for (const c of this.processes.values()) {
        await c.stop(true);
        states.push(c.getState());
        this.emitProcessEvent(c, "process:delete", "user");
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
         // Issue #32: scaled-down instances are deleted from the list.
         this.emitProcessEvent(c, "process:delete", "user");
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

  /**
   * Issue #33: dependency inspection — the `pboss deps` engine-side
   * twin. One report per matched process (a namespace target reports each
   * member): every direct dependency with its provider, state and
   * satisfaction, the direct dependents, and the circular chain (if any).
   * Pure inspection — resolution runs, but nothing is started.
   */
  async depsReport(target: string | number): Promise<DepsReport[]> {
    const containers =
      target === "all"
        ? Array.from(this.processes.values())
        : this.resolveTarget(target);
    if (containers.length === 0) {
      throw new Error(
        `Process or namespace "${target}" not found — nothing to inspect. ` +
          `Run 'pboss list' to see registered names and namespaces.`
      );
    }
    const reports: DepsReport[] = [];
    for (const c of containers) {
      reports.push(
        await this.dependencies.reportFor(
          c.name,
          c.config.namespace,
          this.normalizedDeps(c.config.dependsOn)
        )
      );
    }
    return reports;
  }

  /**
   * Issue #33: direct dependents of `target` (live processes whose
   * dependsOn references it) — the reverse view, exposed for
   * dashboards/agents.
   */
  dependentsOf(target: string | number): DependentRef[] {
    const containers = this.resolveTarget(target);
    return this.dependencies.dependentsOf(containers.map((c) => c.name));
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
      // Issue #33 (boot): create every container first, then bring the
      // ones that were running up in DEPENDENCY order — a dump saved in
      // any order boots with dependencies up before dependents. Failures
      // are isolated per root: one broken graph never blocks unrelated
      // graphs (issue rule #12).
      const toStart: ProcessContainer[] = [];

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
        // supposed to be running, so it joins the dependency-ordered boot.
        if (item.stopped) {
          states.push(container.getState());
        } else {
          toStart.push(container);
        }
      }

      // Issue #33 boot bring-up: dependency-aware, failure-isolated. A
      // process whose required dependency could not come up stays stopped
      // with a clear warning; unrelated processes still start.
      const bootFailed = new Set<string>();
      for (const c of toStart) {
        if (c.status === "online" || c.status === "launching") {
          // Already brought up as someone's dependency earlier in this loop.
          states.push(c.getState());
          continue;
        }
        // A required dependency already failed this boot — do not retry it
        // (one honest failure per graph, no boot loops).
        const deps = this.normalizedDeps(c.config.dependsOn);
        const blockedBy = deps.find(
          (d) =>
            d.policy === "required" &&
            bootFailed.has(d.name)
        );
        if (blockedBy) {
          bootFailed.add(c.name);
          console.warn(
            `[pboss] boot: ${c.name} not started — dependency "${blockedBy.name}" failed to come up`
          );
          states.push(c.getState());
          continue;
        }
        try {
          // Boot deps may exist beyond the fleet (external services) — the
          // same executor checks them; started deps keep running (a
          // best-effort boot never rolls back what it managed to start).
          // Dep starts carry source "system" like every boot restore.
          await this.dependencies.ensureForStart(
            c.name,
            deps,
            { startedByInvocation: [] },
            { source: "system" }
          );
          // Issue #32: resurrect is the one start path whose events carry
          // source "system" (boot restore, not an operator action).
          await c.start("system");
          states.push(c.getState());
        } catch (err) {
          bootFailed.add(c.name);
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[pboss] boot: ${c.name} not started — ${msg}`);
          states.push(c.getState());
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
   * Issue #33: the sweep is now DEPENDENCY-ORDERED — the engine plans
   * units (standalone apps, whole namespaces) from every app's
   * `dependsOn`, validates cycles and shapes upfront (before anything
   * starts), orders namespace members topologically, and the sweep runs
   * in that order. Dependencies on processes OUTSIDE the config resolve
   * through the normal executor at each app's start (ProcBoss live
   * processes first, then system services).
   *
   * - Apps WITHOUT a namespace are standalone and independent: each is
   *   started on its own, a failure is recorded and the sweep CONTINUES —
   * a failing app never rolls back or blocks other standalone apps.
   * - Apps WITH the same namespace form ONE lifecycle group: the group is
   *   started atomically (in its first-declaration position among the
   * dependency-ordered units), and a member failure rolls back only the
   * members this invocation started.
   * - A namespace failure never affects other namespaces or standalone
   *   apps; any failure makes the overall operation report + throw at the
   *   end, after everything startable has been started.
   */
  async startEcosystem(config: EcosystemConfig): Promise<ProcessState[]> {
    const states: ProcessState[] = [];
    const failures: string[] = [];

    // Issue #33: validate + plan BEFORE starting anything — cycles and
    // malformed dependsOn fail with zero processes touched.
    const units = this.dependencies.planEcosystemUnits(config);

    for (const unit of units) {
      if (unit.namespace) {
        // The whole namespace is ONE unit — dependency-ordered, every
        // member included, started atomically under the namespace lock.
        const ns = unit.namespace;
        try {
          states.push(
            ...(await this.withNamespaceLock(ns, () =>
              this.startNamespaceGroupAtomic(ns, unit.apps)
            ))
          );
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      } else {
        const app = unit.apps[0]!;
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
             // Issue #33: dependencies first, rollback-scoped per app.
             const inv: StartInvocation = { startedByInvocation: [] };
             try {
               await this.dependencies.ensureForStart(
                 c.name,
                 this.normalizedDeps(c.config.dependsOn),
                 inv
               );
               await c.start();
             } catch (err) {
               await this.rollbackInvocation(inv.startedByInvocation);
               throw err;
             }
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

     // Name / id — the original per-process semantics, dependency-aware
     // (issue #33: resuming a stopped process starts its dependencies first;
     // an already-running process keeps its no-op semantics).
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
         const inv: StartInvocation = { startedByInvocation: [] };
         try {
           await this.dependencies.ensureForStart(
             c.name,
             this.normalizedDeps(c.config.dependsOn),
             inv
           );
           await c.start();
           if (this.isRunningStatus(c.status)) inv.startedByInvocation.push(c);
         } catch (err) {
           const lines = await this.rollbackInvocation(inv.startedByInvocation);
           const report = lines.length > 0 ? `\nRollback: ${lines.join(", ")}` : "";
           if (err instanceof Error) {
             err.message = `${err.message}${report}`;
             throw err;
           }
           throw new Error(`${String(err)}${report}`);
         }
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
