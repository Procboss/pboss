/**
 * ProcBoss (pboss) — dependency engine (issue #33)
 *
 * First-class process dependencies:
 *
 *   { name: "api", script: "./api.ts", dependsOn: ["postgres", "redis"] }
 *
 * Resolution order (issue rule #1): ProcBoss applications FIRST, then the
 * operating system's service manager (systemd on Linux). External services
 * are CHECKED, never started or stopped (rule #3) — ProcBoss does not take
 * ownership of services managed elsewhere. Dependencies are a real graph,
 * not a recursive start() call: cycle detection, topological levels and
 * reverse lookups all operate on an explicit graph model, and independent
 * levels start concurrently (rule #8).
 *
 * Architecture (the issue's "Suggested implementation architecture"):
 *
 *   Dependency configuration (dependsOn)
 *           ↓  parseDependsOn / normalizeDeps
 *   Dependency graph  (DependencyGraph — nodes, edges, cycles, levels)
 *           ↓  DependencyEngine.buildGraph
 *   Resolver + provider detection (ProcBoss provider | SystemServiceProvider)
 *           ↓  resolveOne / satisfy
 *   State checking (pboss statuses | systemd LoadState/ActiveState)
 *           ↓
 *   Graph executor (ensureForStart — level-by-level, concurrent within a level)
 *           ↓
 *   Lifecycle operation (start / restart / ecosystem sweep / boot)
 *
 * The provider interface is deliberately narrow (exists + state) so future
 * providers (Docker, Kubernetes, HTTP/TCP probes) can slot in without
 * changing the dependency configuration format.
 *
 * https://procboss.com
 * https://github.com/Procboss/pboss
 * License: GPL-3.0-only
 */

import type {
  DependencyPolicy,
  DependencyResolution,
  DependentRef,
  DependencySpec,
  DepsReport,
  DependencyFailureDetails,
  NormalizedDependency,
  StartOptions,
  EcosystemConfig,
  SystemServiceState,
} from "./types";
import { DEPENDENCY_POLICIES } from "./types";
import type { ProcessContainer } from "./process-container";
import type { ProcessEventSource } from "./events";
import { ignore } from "./error-handling";

// ── Configuration parsing ─────────────────────────────────────────────────

/**
 * Normalize `dependsOn` entries to `{ name, policy }`. Accepts the plain
 * string form ("postgres"), the object form ({ name, "policy": "optional" }),
 * and already-normalized objects (idempotent — buildConfig runs it again on
 * validated input). Throws a clear error on anything else, including
 * unknown policies, so garbage fails at the start choke point, never deep
 * inside the executor.
 */
export function parseDependsOn(
  raw: readonly DependencySpec[] | undefined
): NormalizedDependency[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid dependsOn: expected an array of names or { name, policy } objects (got ${typeof raw})`
    );
  }
  const out: NormalizedDependency[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (!name) throw new Error('Invalid dependsOn entry: empty string');
      out.push({ name, policy: "required" });
      continue;
    }
    if (typeof entry === "object" && entry !== null && typeof entry.name === "string") {
      const policy = (entry as { policy?: string }).policy;
      if (policy !== undefined && !DEPENDENCY_POLICIES.includes(policy as DependencyPolicy)) {
        throw new Error(
          `Invalid dependency policy "${policy}" for "${entry.name}" — use "required" or "optional"`
        );
      }
      const name = entry.name.trim();
      if (!name) throw new Error('Invalid dependsOn entry: empty name');
      out.push({ name, policy: (policy as DependencyPolicy) ?? "required" });
      continue;
    }
    throw new Error(
      `Invalid dependsOn entry: ${JSON.stringify(entry)} — use "name" or { name, policy }`
    );
  }
  return out;
}

/**
 * Tolerant re-normalization for entries read back from persisted state
 * (dump.json) or foreign configs — never throws, worst case the entry is
 * treated as a required dependency on the given name.
 */
function normalizeDeps(
  raw: readonly DependencySpec[] | undefined
): NormalizedDependency[] {
  try {
    return parseDependsOn(raw);
  } catch (err) {
    ignore("normalize persisted dependsOn", err);
    // Salvage recognizable string entries; drop the rest.
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((d): d is string => typeof d === "string" && d.trim() !== "")
      .map((d) => ({ name: d.trim(), policy: "required" as const }));
  }
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * The error every dependency failure throws. `details` is the
 * machine-readable form (issue #33 "AI/automation considerations") — the
 * daemon copies it onto the response as `dependencyFailure`, and the message
 * is the human-readable multi-line diagnostic from the issue's examples.
 */
export class DependencyError extends Error {
  public readonly details: DependencyFailureDetails;

  constructor(details: DependencyFailureDetails, message: string) {
    super(message);
    this.name = "DependencyError";
    this.details = details;
  }
}

/** Format the human-readable diagnostic (the issue's error examples). */
export function formatDependencyFailure(details: DependencyFailureDetails): string {
  const lines = [`Cannot start "${details.process}".`];
  if (details.reason === "circular_dependency") {
    lines.push(``, `Circular dependency detected — no process on this chain can start.`);
    return lines.join("\n");
  }
  if (details.reason === "dependent_exists") {
    return details.dependency;
  }
  const dep = `"${details.dependency}"`;
  if (details.reason === "dependency_not_found") {
    lines.push(
      ``,
      `Required dependency ${dep} could not be resolved.`,
      ``,
      `Checked:`,
      `  ProcBoss applications: not found`,
      `  System services: ${details.provider === "unresolved" ? "not available on this platform" : "not found"}`
    );
    return lines.join("\n");
  }
  if (details.reason === "dependency_failed_to_start") {
    lines.push(
      ``,
      `Dependency ${dep} failed to start.`,
      ``,
      `Provider: ProcBoss`,
      `State: ${details.state ?? "failed"}`
    );
    return lines.join("\n");
  }
  // dependency_not_running (and anything else describing an unavailable dep)
  lines.push(
    ``,
    `Required dependency ${dep} is unavailable.`,
    ``,
    `Provider: ${details.provider === "systemd" ? "systemd" : details.provider}`,
    ...(details.service ? [`Service: ${details.service}`] : []),
    `State: ${details.state ?? "unknown"}`
  );
  return lines.join("\n");
}

// ── System-service provider (systemd) ─────────────────────────────────────

/**
 * Common service-name differences between a dependency string and the real
 * systemd unit (issue: "The implementation should account for common
 * service-name differences"). Checked AFTER the plain `<name>.service`
 * candidate, each costing one `systemctl show` call.
 */
const SERVICE_ALIASES: Record<string, readonly string[]> = {
  postgres: ["postgresql.service", "postgres.service"],
  postgresql: ["postgres.service"],
  mysql: ["mysqld.service", "mysql.service"],
  mysqld: ["mysql.service"],
  mariadb: ["mariadb.service"],
  mongodb: ["mongod.service"],
  mongo: ["mongod.service"],
  redis: ["redis-server.service", "redis.service"],
  nginx: ["nginx.service"],
  apache: ["apache2.service", "httpd.service"],
  apache2: ["httpd.service"],
  httpd: ["apache2.service"],
  memcached: ["memcached.service"],
  rabbitmq: ["rabbitmq-server.service"],
  elasticsearch: ["elasticsearch.service"],
  docker: ["docker.service"],
  ssh: ["sshd.service"],
};

/** Candidate unit names for a dependency name, most-likely first. */
export function candidateUnits(name: string): string[] {
  const isUnit = name.endsWith(".service");
  const list: string[] = [isUnit ? name : `${name}.service`];
  for (const alias of SERVICE_ALIASES[name] ?? []) list.push(alias);
  if (!isUnit) {
    // Two cheap generic guesses: postgres → postgresd? No — but
    // "rabbitmq" → "rabbitmq-server.service" style and "<x>d" daemons.
    list.push(`${name}d.service`, `${name}-server.service`);
  }
  return [...new Set(list)].slice(0, 5);
}

/** Map an ActiveState property to the states the issue distinguishes. */
function mapActiveState(active: string | undefined): SystemServiceState {
  switch (active) {
    case "active":
    case "reloading": // active while reloading config — still serving
      return "active";
    case "activating":
      return "activating";
    case "failed":
      return "failed";
    case "inactive":
    case "deactivating":
      return "inactive";
    default:
      return "unknown";
  }
}

async function runSystemctl(
  args: string[]
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(["systemctl", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return { ok: proc.exitCode === 0, stdout };
  } catch (err) {
    ignore(`systemctl ${args.join(" ")}`, err);
    return { ok: false, stdout: "" };
  }
}

/**
 * The external-service provider contract: determine whether a service
 * EXISTS and whether it is ACTIVE — nothing more. Deliberately no
 * start/stop: ProcBoss must not take lifecycle ownership of services
 * managed by systemd or another administrator (issue rule #3).
 */
export interface SystemServiceProvider {
  readonly kind: "systemd";
  /** False when this platform has no service manager to ask. */
  available(): Promise<boolean>;
  /** Resolve a dependency name to a unit + state, or null when not found. */
  resolve(name: string): Promise<{ unit: string; state: SystemServiceState } | null>;
}

/**
 * The default provider: systemd, via `systemctl show` — one call per
 * candidate unit yields both existence (LoadState) and activity
 * (ActiveState). Works on Linux; `available()` is false everywhere else so
 * dependencies fall through to "unresolved" with an honest reason instead
 * of a misleading "not running".
 */
export class SystemdServiceProvider implements SystemServiceProvider {
  readonly kind = "systemd" as const;
  private availability: Promise<boolean> | null = null;

  available(): Promise<boolean> {
    if (process.platform !== "linux") return Promise.resolve(false);
    this.availability ??= runSystemctl(["--version"]).then((r) => r.ok);
    return this.availability;
  }

  async resolve(
    name: string
  ): Promise<{ unit: string; state: SystemServiceState } | null> {
    if (!(await this.available())) return null;
    for (const unit of candidateUnits(name)) {
      const out = await runSystemctl([
        "show",
        unit,
        "--property=LoadState",
        "--property=ActiveState",
      ]);
      const load = /^LoadState=(.*)$/m.exec(out.stdout)?.[1]?.trim();
      const active = /^ActiveState=(.*)$/m.exec(out.stdout)?.[1]?.trim();
      if (!load || load === "not-found" || load === "error") continue;
      return { unit, state: mapActiveState(active) };
    }
    return null;
  }
}

// ── The graph model ───────────────────────────────────────────────────────

interface GraphNode {
  name: string;
  /** The node's own dependencies (only pboss nodes have these). */
  deps: NormalizedDependency[];
  /** True when the name matches no live ProcBoss process (external leaf). */
  external: boolean;
  /** Policies this node is required under, accumulated from all dependents. */
  policies: Set<DependencyPolicy>;
}

/**
 * An explicit dependency graph (issue: "Do not implement the dependency
 * system as a simple recursive start() call that has no graph
 * representation"). Supports cycle detection, topological levels (Kahn,
 * stable within levels) and reverse lookups — the pieces every lifecycle
 * policy, present and future, needs.
 */
export class DependencyGraph {
  readonly nodes = new Map<string, GraphNode>();

  node(name: string): GraphNode {
    const n = this.nodes.get(name);
    if (!n) throw new Error(`dependency graph has no node "${name}"`);
    return n;
  }

  /** All node names that (transitively) depend on `name` — direct first. */
  dependentsOf(name: string): string[] {
    const direct = Array.from(this.nodes.values()).filter((n) =>
      n.deps.some((d) => d.name === name)
    );
    return direct.map((n) => n.name);
  }

  /** DFS cycle detection; returns the cycle path or null. */
  findCycle(): string[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const n of this.nodes.values()) color.set(n.name, WHITE);

    const path: string[] = [];
    const visit = (name: string): string[] | null => {
      color.set(name, GRAY);
      path.push(name);
      for (const dep of this.node(name).deps) {
        // Only edges between nodes present in the graph (pboss nodes) can
        // close a cycle; external leaves have no outgoing deps.
        if (!this.nodes.has(dep.name)) continue;
        const c = color.get(dep.name);
        if (c === GRAY) {
          const from = path.indexOf(dep.name);
          return [...path.slice(from), dep.name];
        }
        if (c === WHITE) {
          const found = visit(dep.name);
          if (found) return found;
        }
      }
      path.pop();
      color.set(name, BLACK);
      return null;
    };

    for (const n of this.nodes.values()) {
      if (color.get(n.name) === WHITE) {
        const cycle = visit(n.name);
        if (cycle) return cycle;
      }
    }
    return null;
  }

  /**
   * Kahn topological levels EXCLUDING `exclude` (the root being started):
   * level 0 = nodes with no dependencies, level N = nodes whose deps are
   * all in levels < N. Nodes in the same level have no ordering constraint
   * between them — the executor runs them concurrently. Stable: equal-rank
   * nodes keep insertion order.
   */
  levels(exclude: string): string[][] {
    const names = Array.from(this.nodes.keys()).filter((n) => n !== exclude);
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const n of names) inDegree.set(n, 0);
    for (const n of names) {
      for (const dep of this.node(n).deps) {
        if (!inDegree.has(dep.name) || dep.name === exclude) continue;
        inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
        const list = dependents.get(dep.name) ?? [];
        list.push(n);
        dependents.set(dep.name, list);
      }
    }
    // NOTE: `exclude`'s own edges are dropped — the root starts LAST, after
    // every level, so it must not participate in the level computation.
    let frontier = names.filter((n) => (inDegree.get(n) ?? 0) === 0);
    const out: string[][] = [];
    const emitted = new Set<string>();
    while (frontier.length > 0) {
      out.push([...frontier]);
      for (const n of frontier) emitted.add(n);
      const next: string[] = [];
      for (const n of frontier) {
        for (const d of dependents.get(n) ?? []) {
          inDegree.set(d, (inDegree.get(d) ?? 0) - 1);
          if ((inDegree.get(d) ?? 0) === 0) next.push(d);
        }
      }
      frontier = next;
    }
    // Unreachable leftovers mean a cycle the DFS missed (should not happen;
    // callers check findCycle first). Append them so nothing is dropped.
    const leftover = names.filter((n) => !emitted.has(n));
    if (leftover.length > 0) out.push(leftover);
    return out;
  }
}

/** What the host ProcessManager exposes to the engine. */
export interface DependencyHost {
  /** Every live container, in id order. */
  containers(): ProcessContainer[];
}

/** The rollback scope shared by a start invocation (issue #33 rules 10/11). */
export interface StartInvocation {
  /** Everything THIS invocation brought up — deps and targets alike. */
  startedByInvocation: ProcessContainer[];
}

/** An ecosystem sweep unit: one standalone app, or one whole namespace. */
export interface EcoUnit {
  /** Effective app name (standalone) or the namespace name. */
  key: string;
  namespace?: string;
  apps: StartOptions[];
}

// ── The engine ───────────────────────────────────────────────────────────

/**
 * Dependency resolution + execution for one ProcessManager. The manager
 * owns the lifecycle entry points; the engine owns everything
 * dependency-shaped: parsing, the graph, providers, the executor, the
 * inspection reports, and the stop/delete safety lookups.
 */
export class DependencyEngine {
  /** Swappable provider — tests inject fakes; production uses systemd. */
  public provider: SystemServiceProvider = new SystemdServiceProvider();

  constructor(private readonly host: DependencyHost) {}

  /** Live containers matching a dependency name (exact or cluster prefix). */
  containersFor(name: string): ProcessContainer[] {
    const bare = clusterBase(name);
    return this.host
      .containers()
      .filter((c) => c.name === name || c.name.startsWith(`${name}-`) || c.name === bare);
  }

  // ── Graph construction ────────────────────────────────────────────────

  /**
   * Build the graph rooted at `rootName` with its direct `deps`, walking
   * each ProcBoss-managed dependency's own dependsOn (recursively, issue
   * rule #6). Names matching no live process become external leaves —
   * their satisfaction is delegated to the system-service provider.
   */
  buildGraph(rootName: string, rootDeps: NormalizedDependency[]): DependencyGraph {
    const graph = new DependencyGraph();
    const visit = (name: string) => {
      if (graph.nodes.has(name)) return;
      const containers = this.containersFor(name);
      if (containers.length === 0) {
        graph.nodes.set(name, {
          name,
          deps: [],
          external: true,
          policies: new Set(),
        });
        return;
      }
      const own = normalizeDeps(containers[0]!.config.dependsOn);
      graph.nodes.set(name, { name, deps: own, external: false, policies: new Set() });
      for (const d of own) visit(d.name);
    };
    // Root first so a self-referencing dependency closes a 1-cycle.
    graph.nodes.set(rootName, { name: rootName, deps: rootDeps, external: false, policies: new Set() });
    for (const d of rootDeps) visit(d.name);
    // Accumulate edge policies onto dep nodes (a node can be required by
    // one dependent and optional for another — required wins).
    for (const node of graph.nodes.values()) {
      for (const d of node.deps) {
        const target = graph.nodes.get(d.name);
        if (target) target.policies.add(d.policy);
      }
    }
    return graph;
  }

  // ── The executor ──────────────────────────────────────────────────────

  /**
   * Ensure every dependency of `rootName` is satisfied — the single
   * executor behind start/startTarget/restart/ecosystem/boot:
   *
   *  1. build the graph, detect cycles BEFORE any lifecycle change
   *     (issue rule #7),
   *  2. resolve level by level — concurrent within a level (rule #8),
   *  3. ProcBoss deps that are stopped are STARTED (recursively resolved
   *     by the level order); ones already running are satisfied and never
   *     restarted (rule #2),
   *  4. external deps are CHECKED against the service manager, never
   *     started (rule #3); only an acceptable active state satisfies a
   *     required dependency (rule #4),
   *  5. every container this executor starts is recorded in `invocation`
   *     so the operation's rollback can stop exactly those (rules 10/11).
   *
   * `source` rides through to the containers' start events — "user" for
   * operator-initiated operations, "system" for boot (resurrect).
   */
  async ensureForStart(
    rootName: string,
    deps: NormalizedDependency[],
    invocation: StartInvocation,
    opts: { source?: ProcessEventSource } = {}
  ): Promise<void> {
    if (deps.length === 0) return;

    const graph = this.buildGraph(rootName, deps);
    const cycle = graph.findCycle();
    if (cycle) {
      throw new DependencyError(
        {
          process: rootName,
          dependency: cycle[cycle.length - 1] ?? rootName,
          provider: "unresolved",
          reason: "circular_dependency",
        },
        `Cannot start "${rootName}".\n\nCircular dependency detected: ${cycle.join(" → ")} — no process on this chain can start.`
      );
    }

    const levels = graph.levels(rootName);
    for (const level of levels) {
      await Promise.all(
        level.map((name) =>
          this.satisfy(graph.node(name), invocation, rootName, opts.source ?? "user"))
      );
    }
  }

  /** Satisfy one node — see ensureForStart for the contract. */
  private async satisfy(
    node: GraphNode,
    invocation: StartInvocation,
    rootName: string,
    source: ProcessEventSource = "user"
  ): Promise<void> {
    const required = node.policies.has("required");

    // ProcBoss-managed dependency (rule #1: app list first).
    const containers = this.containersFor(node.name);
    if (containers.length > 0) {
      const stopped = containers.filter((c) => !isRunning(c.status));
      if (stopped.length === 0) return; // already running — never restarted
      for (const c of stopped) {
        try {
          await c.start(source);
          if (isRunning(c.status) && !invocation.startedByInvocation.includes(c)) {
            invocation.startedByInvocation.push(c);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!required) {
            console.warn(
              `[pboss] optional dependency "${node.name}" failed to start (${reason}) — continuing without it`
            );
            continue;
          }
          throw new DependencyError(
            {
              process: rootName,
              dependency: node.name,
              provider: "pboss",
              state: c.status,
              reason: "dependency_failed_to_start",
            },
            `Cannot start "${rootName}".\n\nDependency "${node.name}" failed to start.\n\nProvider: ProcBoss\nState: ${c.status}\nReason: ${reason}`
          );
        }
      }
      return;
    }

    // External system service (rule #3: check, never manage).
    const available = await this.provider.available();
    const res = available ? await this.provider.resolve(node.name) : null;
    if (res && res.state === "active") return;
    if (!required) {
      console.warn(
        `[pboss] optional dependency "${node.name}" is unavailable — continuing without it`
      );
      return;
    }
    const reason =
      res === null ? "dependency_not_found" : "dependency_not_running";
    const details: DependencyFailureDetails = {
      process: rootName,
      dependency: node.name,
      provider: available ? "systemd" : "unresolved",
      service: res?.unit,
      state: res?.state ?? (available ? "not-found" : "unavailable"),
      reason,
    };
    throw new DependencyError(details, formatDependencyFailure(details));
  }

  // ── Reverse lookups + stop/delete safety ──────────────────────────────

  /** A dependent plus WHICH declared dependency matched. */
  private dependentHits(names: string[]): Array<DependentRef & { depName: string }> {
    const hits: Array<DependentRef & { depName: string }> = [];
    for (const c of this.host.containers()) {
      for (const d of normalizeDeps(c.config.dependsOn)) {
        if (d.policy !== "required") continue;
        if (names.some((n) => depMatches(d.name, n))) {
          hits.push({ name: c.name, status: c.status, policy: d.policy, depName: d.name });
          break;
        }
      }
    }
    return hits;
  }

  /** Live direct dependents of `names` (processes whose dependsOn matches). */
  dependentsOf(names: string[]): DependentRef[] {
    return this.dependentHits(names).map(({ name, status, policy }) => ({ name, status, policy }));
  }

  /**
   * Issue #33 stop safety: dependents that would actually lose their last
   * running provider when `victims` stop. A cluster losing one instance of
   * four still satisfies the dependency — only the LAST running provider
   * counts. Never blocks — the caller just warns.
   */
  stopAffected(victims: ProcessContainer[]): DependentRef[] {
    const stopSet = new Set<ProcessContainer>(victims);
    const stopNames = new Set(victims.map((v) => v.name));
    const victimNames = victims.map((v) => v.name);
    const out: DependentRef[] = [];
    for (const hit of this.dependentHits(victimNames)) {
      if (stopNames.has(hit.name)) continue;
      // Providers of the dependency the dependent declared — NOT just the
      // containers being stopped (sibling cluster instances also provide).
      const providers = this.containersFor(hit.depName);
      const stillUp = providers.some(
        (c) => !stopSet.has(c) && !stopNames.has(c.name) && isRunning(c.status)
      );
      const tookDown = providers.some(
        (c) => (stopSet.has(c) || stopNames.has(c.name)) && isRunning(c.status)
      );
      if (tookDown && !stillUp) out.push({ name: hit.name, status: hit.status, policy: hit.policy });
    }
    return out;
  }

  /**
   * Issue #33 delete safety: dependents OUTSIDE the deletion set that would
   * be left pointing at nothing. Callers refuse (unless forced).
   */
  deleteAffected(victims: ProcessContainer[]): DependentRef[] {
    const victimSet = new Set<ProcessContainer>(victims);
    const victimNames = victims.map((v) => v.name);
    const out: DependentRef[] = [];
    for (const hit of this.dependentHits(victimNames)) {
      if (victims.some((v) => v.name === hit.name)) continue;
      const providers = this.containersFor(hit.depName);
      // The dependency's every provider is being deleted.
      if (providers.length > 0 && providers.every((c) => victimSet.has(c))) {
        out.push({ name: hit.name, status: hit.status, policy: hit.policy });
      }
    }
    return out;
  }

  // ── Inspection (`pboss deps`, the API) ────────────────────────────────

  /**
   * Resolve ONE dependency name for a report: ProcBoss first, then the
   * system-service provider, then unresolved. Pure inspection — nothing
   * is started.
   */
  async resolveOne(
    name: string,
    policy: DependencyPolicy
  ): Promise<DependencyResolution> {
    const containers = this.containersFor(name);
    if (containers.length > 0) {
      const running = containers.filter((c) => isRunning(c.status)).length;
      const status =
        running === containers.length
          ? "running"
          : running === 0
            ? "stopped"
            : "partial";
      return {
        name,
        policy,
        provider: "pboss",
        target: clusterBase(containers[0]!.name),
        status,
        satisfied: running === containers.length,
        reason: running === containers.length ? undefined : "dependency_not_running",
      };
    }
    const available = await this.provider.available();
    const res = available ? await this.provider.resolve(name) : null;
    if (res && res.state === "active") {
      return { name, policy, provider: "systemd", target: res.unit, status: "active", satisfied: true };
    }
    return {
      name,
      policy,
      provider: available ? "systemd" : "unresolved",
      target: res?.unit,
      status: res?.state ?? (available ? "not-found" : "unavailable"),
      satisfied: false,
      reason: res ? "dependency_not_running" : "dependency_not_found",
    };
  }

  /**
   * The full report for one process: every direct dependency with provider
   * + state + satisfaction, the direct dependents, and a cycle warning
   * when the process sits on a circular chain. This is what `pboss deps`
   * renders and the API returns — ProcBoss stays the source of truth so
   * clients never re-implement resolution (issue "API" section).
   */
  async reportFor(
    name: string,
    namespace: string | undefined,
    deps: NormalizedDependency[]
  ): Promise<DepsReport> {
    const dependencies = await Promise.all(
      deps.map((d) => this.resolveOne(d.name, d.policy))
    );
    const dependents = this.dependentsOf([name]).map((d) => ({
      name: d.name,
      status: d.status,
      policy: d.policy,
    }));
    const graph = this.buildGraph(name, deps);
    const cycle = graph.findCycle();
    return {
      process: name,
      namespace,
      dependencies,
      dependents,
      circular: cycle,
    };
  }

  // ── Ecosystem planning ────────────────────────────────────────────────

  /**
   * Validate an ecosystem config's dependency shapes (upfront, before
   * anything starts) and plan the sweep as dependency-ordered UNITS —
   * standalone apps and whole namespaces. A namespace is one lifecycle
   * unit (issue #31), so ordering happens between units, never inside the
   * daemon's group semantics; members inside a unit are ordered
   * topologically among themselves.
   */
  planEcosystemUnits(config: EcosystemConfig): EcoUnit[] {
    // 1. Validate shapes — a garbage dependsOn must fail BEFORE any start.
    for (const app of config.apps) parseDependsOn(app.dependsOn);

    // 2. Declare units in declaration order (stable Kahn preserves it when
    //    there are no dependency edges at all — full backward compat).
    const units: EcoUnit[] = [];
    const nsUnits = new Map<string, EcoUnit>();
    const nameToUnit = new Map<string, EcoUnit>();
    for (const app of config.apps) {
      const eff = effectiveName(app);
      let unit: EcoUnit;
      if (app.namespace) {
        unit = nsUnits.get(app.namespace)!;
        if (!unit) {
          unit = { key: app.namespace, namespace: app.namespace, apps: [] };
          nsUnits.set(app.namespace, unit);
          units.push(unit);
        }
        unit.apps.push(app);
      } else {
        unit = { key: eff, apps: [app] };
        units.push(unit);
      }
      if (eff && !nameToUnit.has(eff)) nameToUnit.set(eff, unit);
    }

    // 3. Name-level cycle check across the whole ecosystem (covers cycles
    //    inside a namespace and across namespaces) — BEFORE lifecycle.
    const graph = new DependencyGraph();
    for (const app of config.apps) {
      const eff = effectiveName(app);
      if (!graph.nodes.has(eff)) {
        graph.nodes.set(eff, {
          name: eff,
          deps: parseDependsOn(app.dependsOn),
          external: false,
          policies: new Set(),
        });
      }
    }
    const cycle = graph.findCycle();
    if (cycle) {
      throw new DependencyError(
        {
          process: cycle[0] ?? "ecosystem",
          dependency: cycle[cycle.length - 1] ?? "ecosystem",
          provider: "unresolved",
          reason: "circular_dependency",
        },
        `Cannot start this ecosystem.\n\nCircular dependency detected: ${cycle.join(" → ")} — no process on this chain can start.`
      );
    }

    // 4. Unit edges: unit U depends on unit V when a member of U depends
    //    on a name belonging to V. External names create no edges (the
    //    per-app executor checks them at start time).
    const unitOf = (name: string): EcoUnit | undefined => nameToUnit.get(name);
    const edges = new Map<string, Set<string>>(); // depUnitKey -> depending unit keys
    const addEdge = (from: string, to: string) => {
      if (from === to) return; // intra-unit ordering, not a unit edge
      const set = edges.get(from) ?? new Set<string>();
      set.add(to);
      edges.set(from, set);
    };
    for (const app of config.apps) {
      const eff = effectiveName(app);
      const ownUnit = unitOf(eff);
      if (!ownUnit) continue;
      for (const d of parseDependsOn(app.dependsOn)) {
        const depUnit = unitOf(d.name);
        if (depUnit) addEdge(depUnit.key, ownUnit.key);
      }
    }

    // 4b. Unit-level cycle check: two namespaces whose members depend on
    // each other across the boundary have no valid group order even when
    // the NAME graph is acyclic — report it before anything starts.
    // Node deps = units THIS unit depends on = reverse of `edges`.
    const unitGraph = new DependencyGraph();
    for (const u of units) {
      const rev: NormalizedDependency[] = [];
      for (const [from, tos] of edges) {
        if (tos.has(u.key)) rev.push({ name: from, policy: "required" });
      }
      unitGraph.nodes.set(u.key, {
        name: u.key,
        deps: rev,
        external: false,
        policies: new Set(),
      });
    }
    const unitCycle = unitGraph.findCycle();
    if (unitCycle) {
      throw new DependencyError(
        {
          process: unitCycle[0] ?? "ecosystem",
          dependency: unitCycle[unitCycle.length - 1] ?? "ecosystem",
          provider: "unresolved",
          reason: "circular_dependency",
        },
        `Cannot start this ecosystem.\n\nCircular dependency between groups: ${unitCycle.join(" → ")} — these namespace groups depend on each other across boundaries, so neither can start first. Split the cycle, or move the entangled apps into one namespace.`
      );
    }

    // 5. Stable topological order of units (Kahn, declaration-seeded).
    const inDegree = new Map<string, number>();
    for (const u of units) inDegree.set(u.key, 0);
    const unlock = new Map<string, string[]>(); // unitKey -> units waiting on it
    for (const [from, tos] of edges) {
      for (const to of tos) {
        inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
        const list = unlock.get(from) ?? [];
        list.push(to);
        unlock.set(from, list);
      }
    }
    const ordered: EcoUnit[] = [];
    let frontier = units.filter((u) => (inDegree.get(u.key) ?? 0) === 0);
    while (frontier.length > 0) {
      for (const u of frontier) ordered.push(u);
      const next: EcoUnit[] = [];
      for (const u of frontier) {
        for (const to of unlock.get(u.key) ?? []) {
          inDegree.set(to, (inDegree.get(to) ?? 0) - 1);
          if ((inDegree.get(to) ?? 0) === 0) {
            const unit = units.find((x) => x.key === to);
            if (unit) next.push(unit);
          }
        }
      }
      frontier = next;
    }
    // Unreachable leftovers would mean a unit cycle — already reported
    // above — but be honest rather than silently dropping anything.
    for (const u of units) {
      if (!ordered.includes(u)) ordered.push(u);
    }

    // 6. Order members WITHIN namespace units: dependencies first, stable.
    for (const u of ordered) {
      if (!u.namespace || u.apps.length < 2) continue;
      u.apps = orderMembers(u.apps);
    }
    return ordered;
  }
}

// ── small helpers ─────────────────────────────────────────────────────────

/** Statuses meaning "the supervisor considers this running". */
function isRunning(status: string): boolean {
  return status === "online" || status === "launching" || status === "waiting-restart";
}

/** "api-3" → "api"; untouched otherwise. */
export function clusterBase(name: string): string {
  return name.replace(/-\d+$/, "");
}

/** Does declared dep `depName` target process `processName`? */
function depMatches(depName: string, processName: string): boolean {
  return (
    depName === processName ||
    processName.startsWith(`${depName}-`) ||
    clusterBase(processName) === depName
  );
}

/** An app's effective name — explicit, or derived from its script. */
function effectiveName(app: StartOptions): string {
  if (app.name) return app.name;
  const script = app.script ?? "";
  const base = script.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.\w+$/, "");
}

/** Stable topological order of ecosystem members within one namespace. */
function orderMembers(apps: StartOptions[]): StartOptions[] {
  const names = apps.map((a) => effectiveName(a));
  const depsOf = new Map<string, NormalizedDependency[]>();
  for (const app of apps) depsOf.set(effectiveName(app), parseDependsOn(app.dependsOn));

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of names) inDegree.set(n, 0);
  for (const n of names) {
    for (const d of depsOf.get(n) ?? []) {
      if (!inDegree.has(d.name) || d.name === n) continue;
      inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      const list = dependents.get(d.name) ?? [];
      list.push(n);
      dependents.set(d.name, list);
    }
  }
  const ordered: string[] = [];
  let frontier = names.filter((n) => (inDegree.get(n) ?? 0) === 0);
  while (frontier.length > 0) {
    ordered.push(...frontier);
    const next: string[] = [];
    for (const n of frontier) {
      for (const d of dependents.get(n) ?? []) {
        inDegree.set(d, (inDegree.get(d) ?? 0) - 1);
        if ((inDegree.get(d) ?? 0) === 0) next.push(d);
      }
    }
    frontier = next;
  }
  for (const n of names) {
    if (!ordered.includes(n)) ordered.push(n); // intra-unit cycle — already reported upfront
  }
  const byName = new Map(apps.map((a) => [effectiveName(a), a] as const));
  return ordered.map((n) => byName.get(n)!);
}
