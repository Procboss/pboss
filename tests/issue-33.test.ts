/**
 * Issue #33 — first-class process dependencies and dependency policies.
 * https://github.com/Procboss/pboss/issues/33
 *
 * The contract under test (the issue's acceptance criteria):
 *
 * Configuration:
 *   1. `dependsOn` accepts strings and { name, policy } objects; garbage
 *      and unknown policies fail with CLEAR errors at the start choke
 *      point (nothing started, no half-created process).
 *
 * Resolution:
 *   2. ProcBoss applications are searched FIRST (rule #1) — a live
 *      container wins even when the system-service provider also knows
 *      the name.
 *   3. System services are the fallback; active satisfies, inactive /
 *      failed / not-found block REQUIRED deps with the issue's exact
 *      diagnostic shape (provider, service, state).
 *   4. Unresolved dependencies report both misses ("Checked: ProcBoss
 *      applications: not found; System services: …").
 *
 * Startup:
 *   5. Dependencies are resolved recursively (worker → api → postgres
 *      starts postgres, api, worker — in that order).
 *   6. Already-running dependencies are NEVER restarted (rule #2) —
 *      `pboss start api` / `restart api` keep postgres's pid.
 *   7. Optional dependencies never block (rule #5) — unresolved or
 *      failing optional deps leave the app running.
 *   8. Restart is dependency-aware: deps pre-flight, dependents never
 *      restarted (no runtime propagation).
 *
 * Graph:
 *   9. Cycles (a → b → a, and self-references) are detected BEFORE any
 *      lifecycle change and block with a clear circular error (rule #7).
 *  10. Independent dependencies live in the same graph level (the
 *      executor's concurrency contract — levels, not a flat recursion).
 *
 * Rollback (rules 9–11):
 *  11. A failing start rolls back only dependencies THIS invocation
 *      started; an already-running dependency (postgres) is preserved
 *      while the invocation-started one (redis) is stopped.
 *
 * Namespaces:
 *  12. Dependencies cross namespace boundaries; a backend failure blocks
 *      (does not roll back) the frontend that depends on it — already-
 *      running frontend members are untouched.
 *
 * Lifecycle safety:
 *  13. Stopping a dependency WARNS about the dependents (they keep
 *      running); deleting one is REFUSED with their names unless forced.
 *
 * Persistence & boot:
 *  14. dependsOn persists in the dump; resurrect (boot) starts
 *      dependencies before dependents regardless of dump order, and one
 *      failed graph does not block unrelated graphs (rule #12).
 *
 * Ecosystem:
 *  15. `pboss start ecosystem.config.ts` builds the graph: dependency-
 *      ordered sweep (deps declared LAST still start FIRST), upfront
 *      cycle refusal, cross-namespace deps ordered between groups.
 *
 * API/CLI (Part B — real daemon + real binary):
 *  16. `pboss deps <target>` and `--reverse` render provider/state rows;
 *      a blocked start exits 1 with the honest diagnostic; the `deps` RPC
 *      returns machine-readable reports; `--depends-on` flag parses.
 *
 * PBOSS_HOME discipline: set before any src import (constants bind at
 * import time); Part B runs the real CLI on hermetic temp homes.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SystemServiceState } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-issue33-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;

// The BOUND home — NOT necessarily TEST_HOME (shared module registries).
const BOUND = await import("../src/constants");
const BOUND_HOME = BOUND.PBOSS_HOME;
const { parseDependsOn, candidateUnits } = await import("../src/dependencies");
const { DUMP_FILE } = await import("../src/utils");

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  if (BOUND_HOME !== TEST_HOME) rmSync(TEST_HOME, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-issue33-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

function stayAliveScript(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "setInterval(() => {}, 1000);\n");
  return p;
}

/**
 * The injected fake system-service provider: deterministic unit states
 * plus a call log, so tests can assert ProcBoss-priority (the provider
 * must NOT even be consulted when a container matches).
 */
class FakeProvider {
  readonly kind = "systemd" as const;
  states = new Map<string, SystemServiceState>();
  calls: string[] = [];
  availableValue = true;
  async available(): Promise<boolean> {
    return this.availableValue;
  }
  async resolve(name: string): Promise<{ unit: string; state: SystemServiceState } | null> {
    this.calls.push(name);
    const state = this.states.get(name);
    return state ? { unit: `${name}.service`, state } : null;
  }
}

describe("parseDependsOn (issue #33)", () => {
  test("strings default to required; objects pass their policy through", () => {
    expect(parseDependsOn(["postgres", { name: "metrics", policy: "optional" }])).toEqual([
      { name: "postgres", policy: "required" },
      { name: "metrics", policy: "optional" },
    ]);
    // Idempotent on already-normalized entries (the buildConfig re-run).
    expect(parseDependsOn([{ name: "a", policy: "optional" }])).toEqual([
      { name: "a", policy: "optional" },
    ]);
    expect(parseDependsOn(undefined)).toEqual([]);
  });

  test("garbage shapes and unknown policies throw clear errors", () => {
    expect(() => parseDependsOn([42 as unknown as string])).toThrow(/Invalid dependsOn entry/);
    expect(() => parseDependsOn([{ policy: "required" } as never])).toThrow(/Invalid dependsOn entry/);
    expect(() => parseDependsOn([{ name: "x", policy: "sometimes" as never }])).toThrow(
      /Invalid dependency policy "sometimes" .+ use "required" or "optional"/
    );
    expect(() => parseDependsOn(["  "])).toThrow(/empty string/);
  });

  test("systemd candidates cover common service-name differences", () => {
    // The issue's examples: postgres → postgresql.service, mongodb →
    // mongod.service — plus the plain unit and generic daemon guesses.
    expect(candidateUnits("postgres")).toContain("postgresql.service");
    expect(candidateUnits("mongodb")).toContain("mongod.service");
    expect(candidateUnits("redis")).toContain("redis.service");
    expect(candidateUnits("rabbitmq")).toContain("rabbitmq-server.service");
    expect(candidateUnits("postgresql.service")).toEqual(["postgresql.service"]);
  });
});

describe("DependencyEngine — resolution, ordering, policies (issue #33)", () => {
  let pm: import("../src/process-manager").ProcessManager;
  let fake: FakeProvider;
  let dir: string;
  let startOrder: Array<{ name: string; source: string }>;

  beforeEach(async () => {
    const { ProcessManager } = await import("../src/process-manager");
    pm = new ProcessManager();
    fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;
    dir = scratch("engine");
    startOrder = [];
    (pm.on as (k: string, l: (e: any) => void) => void)("process:start", (e) =>
      startOrder.push({ name: e.process.name, source: e.source })
    );
  });

  afterEach(async () => {
    try {
      if (pm) await pm.deleteAll();
    } catch {
      /* empty fleet */
    }
    pm = undefined!;
    fake = undefined!;
  });

  test("an invalid dependsOn fails the start with a clear error — no process created", async () => {
    const script = stayAliveScript(dir, "api.ts");
    try {
      await pm.start({
        name: "api",
        script,
        dependsOn: [{ name: "db", policy: "whenever" as never }],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toMatch(/Invalid dependency policy "whenever"/);
    }
    expect(pm.list()).toHaveLength(0);
  });

  test("recursive resolution starts worker → api → postgres in dependency order", async () => {
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "postgres.ts") });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres"],
    });
    startOrder = [];
    const states = await pm.start({
      name: "worker",
      script: stayAliveScript(dir, "worker.ts"),
      dependsOn: ["api"],
    });
    expect(states[0]!.status).toBe("online");
    // api + postgres already running → worker starts ALONE (deps satisfied,
    // never restarted).
    expect(startOrder.map((s) => s.name)).toEqual(["worker"]);
    expect(pm.list().find((s: any) => s.name === "api")!.status).toBe("online");
    expect(pm.list().find((s: any) => s.name === "postgres")!.status).toBe("online");
  });

  test("a stopped dependency chain is pulled up before the dependent", async () => {
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "postgres.ts") });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api2.ts"),
      dependsOn: ["postgres"],
    });
    await pm.stop("api");
    await pm.stop("postgres");
    startOrder = [];
    // `pboss start api` (resume): api's dep chain is started first.
    await pm.startTarget("api");
    expect(startOrder.map((s) => s.name)).toEqual(["postgres", "api"]);
  });

  test("ProcBoss apps win over system services (rule #1) — provider not even consulted", async () => {
    // The provider ALSO "knows" redis as an active unit, and a STOPPED
    // container named redis exists: the container is the dependency.
    fake.states.set("redis", "active");
    await pm.start({ name: "redis", script: stayAliveScript(dir, "redis.ts") });
    await pm.stop("redis");
    fake.calls = [];
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["redis"],
    });
    expect(pm.list().find((s: any) => s.name === "redis")!.status).toBe("online");
    expect(fake.calls).toEqual([]); // ProcBoss priority: systemd never asked
  });

  test("an active system service satisfies a required dependency — nothing spawned", async () => {
    fake.states.set("postgresql", "active");
    const before = pm.list().length;
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgresql"],
    });
    expect(pm.list().find((s: any) => s.name === "api")!.status).toBe("online");
    expect(pm.list()).toHaveLength(before + 1); // no postgres process created
  });

  test("an inactive system service blocks a required dependency with the issue's diagnostic", async () => {
    fake.states.set("postgresql", "inactive");
    try {
      await pm.start({
        name: "api",
        script: stayAliveScript(dir, "api.ts"),
        dependsOn: ["postgresql"],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain('Cannot start "api"');
      expect(err.message).toContain('Required dependency "postgresql" is unavailable');
      expect(err.message).toContain("Provider: systemd");
      expect(err.message).toContain("Service: postgresql.service");
      expect(err.message).toContain("State: inactive");
      // Machine-readable form (issue "AI/automation considerations").
      expect(err.details).toMatchObject({
        process: "api",
        dependency: "postgresql",
        provider: "systemd",
        service: "postgresql.service",
        state: "inactive",
        reason: "dependency_not_running",
      });
    }
    expect(pm.list()).toHaveLength(0);
  });

  test("a missing dependency reports BOTH misses (not found anywhere)", async () => {
    try {
      await pm.start({
        name: "api",
        script: stayAliveScript(dir, "api.ts"),
        dependsOn: ["ghostservice"],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain("could not be resolved");
      expect(err.message).toContain("ProcBoss applications: not found");
      expect(err.message).toContain("System services: not found");
      expect(err.details.reason).toBe("dependency_not_found");
    }
  });

  test("optional dependencies never block — unresolved or failing", async () => {
    // Unresolved optional dep: starts anyway.
    await pm.start({
      name: "app",
      script: stayAliveScript(dir, "app.ts"),
      dependsOn: [{ name: "ghost", policy: "optional" }],
    });
    expect(pm.list().find((s: any) => s.name === "app")!.status).toBe("online");

    // Optional dep that fails to START: still does not block. (pm.start
    // throws on the spawn failure, but the container is created errored.)
    try {
      await pm.start({
        name: "bad",
        script: stayAliveScript(dir, "bad.ts"),
        interpreter: "/nonexistent-interpreter-for-issue-33",
      });
    } catch {
      /* the spawn failure itself — expected */
    }
    const bad = pm.list().find((s: any) => s.name === "bad")!;
    expect(bad.status).toBe("errored");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await pm.start({
        name: "app2",
        script: stayAliveScript(dir, "app2.ts"),
        dependsOn: [{ name: "bad", policy: "optional" }],
      });
      expect(pm.list().find((s: any) => s.name === "app2")!.status).toBe("online");
    } finally {
      warn.mockRestore();
    }
  });

  test("already-running dependencies are never restarted (rule #2)", async () => {
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    const pgBefore = pm.list().find((s: any) => s.name === "postgres")!;
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres"],
    });
    const pgAfter = pm.list().find((s: any) => s.name === "postgres")!;
    expect(pgAfter.pid).toBe(pgBefore.pid); // same process, not restarted
    expect(startOrder.filter((s) => s.name === "postgres")).toHaveLength(1);
  });

  test("restart is dependency-aware: deps pre-flight, dependents untouched", async () => {
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres"],
    });
    const pgPid = pm.list().find((s: any) => s.name === "postgres")!.pid;

    // restart api: postgres must NOT be restarted.
    await pm.restart("api");
    expect(pm.list().find((s: any) => s.name === "postgres")!.pid).toBe(pgPid);

    // restart postgres (a dependency): api keeps running — re-read api's
    // pid AFTER its own restart (which legitimately changed it).
    const apiPid = pm.list().find((s: any) => s.name === "api")!.pid;
    await pm.restart("postgres");
    expect(pm.list().find((s: any) => s.name === "api")!.pid).toBe(apiPid);
    expect(pm.list().find((s: any) => s.name === "api")!.status).toBe("online");
  });

  test("circular dependencies are detected BEFORE any lifecycle change (rule #7)", async () => {
    await pm.start({ name: "a", script: stayAliveScript(dir, "a.ts") });
    await pm.start({ name: "b", script: stayAliveScript(dir, "b.ts"), dependsOn: ["a"] });
    await pm.stop("a");
    await pm.stop("b");
    // Form the cycle a → b → a in the persisted configs.
    for (const c of pm.allContainers()) {
      if (c.name === "a") c.config.dependsOn = [{ name: "b", policy: "required" }];
    }
    try {
      await pm.startTarget("a");
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain("Circular dependency detected");
      expect(err.message).toContain("a → b → a");
    }
    // NOTHING started — no infinite loop, no half-started chain.
    for (const c of pm.allContainers()) {
      if (c.name === "a" || c.name === "b") {
        expect(c.status).toBe("stopped");
      }
    }
  });

  test("a self-referencing dependsOn is a 1-cycle", async () => {
    try {
      await pm.start({
        name: "ouroboros",
        script: stayAliveScript(dir, "self.ts"),
        dependsOn: ["ouroboros"],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toMatch(/Circular dependency detected/);
    }
    expect(pm.list()).toHaveLength(0);
  });

  test("independent dependencies share a graph level (concurrency contract)", async () => {
    // api → [postgres, redis, auth]; auth → postgres. Levels: [postgres,
    // redis] then [auth]; the executor runs each level with Promise.all.
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    await pm.start({ name: "redis", script: stayAliveScript(dir, "rd.ts") });
    await pm.start({
      name: "auth",
      script: stayAliveScript(dir, "auth.ts"),
      dependsOn: ["postgres"],
    });
    await pm.stop("postgres");
    await pm.stop("redis");
    await pm.stop("auth");

    const graph = pm.dependencies.buildGraph("api", [
      { name: "postgres", policy: "required" },
      { name: "redis", policy: "required" },
      { name: "auth", policy: "required" },
    ]);
    expect(graph.findCycle()).toBeNull();
    const levels = graph.levels("api");
    expect(levels[0]).toContain("redis");
    expect(levels[0]).toContain("postgres");
    expect(levels[1]).toEqual(["auth"]);

    // And the real executor brings the whole chain up:
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres", "redis", "auth"],
    });
    for (const name of ["postgres", "redis", "auth", "api"]) {
      expect(pm.list().find((s: any) => s.name === name)!.status).toBe("online");
    }
  });

  test("invocation-scoped rollback: started dep rolls back, running dep preserved (rules 10/11)", async () => {
    // postgres already running; redis stopped; api FAILS to start.
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    await pm.start({ name: "redis", script: stayAliveScript(dir, "rd.ts") });
    await pm.stop("redis");
    const pgPid = pm.list().find((s: any) => s.name === "postgres")!.pid;

    try {
      await pm.start({
        name: "api",
        script: stayAliveScript(dir, "api-broken.ts"),
        interpreter: "/nonexistent-interpreter-for-issue-33",
        dependsOn: ["postgres", "redis"],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toMatch(/ENOENT/); // the real spawn failure, primary
      expect(err.message).toMatch(/Rollback: ✓ redis stopped/);
    }
    // redis was started by THIS invocation → rolled back.
    expect(pm.list().find((s: any) => s.name === "redis")!.status).toBe("stopped");
    // postgres was already running → preserved, same pid.
    expect(pm.list().find((s: any) => s.name === "postgres")!.pid).toBe(pgPid);
    expect(pm.list().find((s: any) => s.name === "postgres")!.status).toBe("online");
  });

  test("dependencies cross namespace boundaries; a failing dep graph blocks, never cascades", async () => {
    // backend ns: api (fails to start); frontend ns: web dependsOn api.
    const script = stayAliveScript(dir, "web.ts");
    const { ProcessManager: PM } = await import("../src/process-manager");
    const eco = new PM();
    const ecoFake = new FakeProvider();
    (eco.dependencies as unknown as { provider: unknown }).provider = ecoFake;
    try {
      await eco.startEcosystem({
        apps: [
          {
            name: "api",
            script: stayAliveScript(dir, "api-broken2.ts"),
            interpreter: "/nonexistent-interpreter-for-issue-33",
            namespace: "backend",
          },
          { name: "web", script, dependsOn: ["api"], namespace: "frontend" },
        ],
      });
      expect.unreachable();
    } catch (err: any) {
      // The ecosystem reports BOTH failures: backend's own spawn failure,
      // and web's blocked dependency. web is never STARTED.
      expect(err.message).toContain("ecosystem start failed");
      expect(err.message).toContain('namespace "backend" startup failed');
      expect(err.message).toContain('Dependency "api" failed to start');
      expect(err.message).toContain('Cannot start "web"');
    }
    const web = eco.list().find((s: any) => s.name === "web");
    // web was BLOCKED before its container was ever created — it is not
    // registered at all (a blocked start leaves no half-process behind).
    expect(web).toBeUndefined();
    try {
      await eco.deleteAll();
    } catch {
      /* cleanup */
    }
  });

  test("stopping a dependency warns about dependents; they keep running", async () => {
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres"],
    });
    const apiPid = pm.list().find((s: any) => s.name === "api")!.pid;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let warnCalls: string[][] = [];
    try {
      await pm.stop("postgres");
      // Read BEFORE restore — bun's mockRestore() clears mock.calls.
      warnCalls = warn.mock.calls as unknown as string[][];
    } finally {
      warn.mockRestore();
    }
    // The warning named the dependent...
    expect(
      warnCalls.some((c) => String(c[0]).includes('"postgres"') && String(c[0]).includes('"api"'))
    ).toBe(true);
    // ...and api itself keeps running (no runtime propagation).
    const api = pm.list().find((s: any) => s.name === "api")!;
    expect(api.status).toBe("online");
    expect(api.pid).toBe(apiPid);
  });

  test("deleting a dependency is refused with the dependents' names — force overrides", async () => {
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres"],
    });
    try {
      await pm.del("postgres");
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain('Cannot delete "postgres"');
      expect(err.message).toContain('"api"');
      expect(err.message).toContain("--force");
    }
    // postgres and api both still exist.
    expect(pm.list().map((s: any) => s.name).sort()).toEqual(["api", "postgres"]);

    // Forced: the delete proceeds.
    await pm.del("postgres", { force: true });
    expect(pm.list().map((s: any) => s.name)).toEqual(["api"]);
  });

  test("depsReport: providers, states, dependents — and resolve-only (nothing started)", async () => {
    fake.states.set("postgresql", "active");
    fake.states.set("memcached", "inactive");
    await pm.start({ name: "redis", script: stayAliveScript(dir, "rd.ts") });
    await pm.stop("redis");
    // memcached is REQUIRED and inactive → the whole start is blocked.
    try {
      await pm.start({
        name: "api",
        script: stayAliveScript(dir, "api.ts"),
        dependsOn: ["redis", "postgresql", "memcached"],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain('Required dependency "memcached" is unavailable');
    }
    // redis was started as a dep by the blocked attempt, then left running
    // (the block happened at the external check, after the pboss dep phase).

    // Register api WITHOUT memcached, then inspect the report.
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["redis", "postgresql", { name: "ghost", policy: "optional" }],
    });
    const reports = await pm.depsReport("api");
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r.process).toBe("api");
    const byName = new Map(r.dependencies.map((d) => [d.name, d]));
    expect(byName.get("redis")).toMatchObject({
      provider: "pboss",
      status: "running",
      satisfied: true,
    });
    expect(byName.get("postgresql")).toMatchObject({
      provider: "systemd",
      target: "postgresql.service",
      status: "active",
      satisfied: true,
    });
    expect(byName.get("ghost")).toMatchObject({
      // The fake provider IS available and knows no "ghost" unit → the
      // dependency resolved nowhere (checked both providers honestly).
      provider: "systemd",
      status: "not-found",
      satisfied: false,
      reason: "dependency_not_found",
      policy: "optional",
    });
    expect(r.dependents).toEqual([]);

    // The reverse view: who depends on redis → api.
    const rev = await pm.depsReport("redis");
    expect(rev[0]!.dependents.map((d) => d.name)).toEqual(["api"]);
  });

  test("unknown deps target is a clear error, not a silent empty report", async () => {
    try {
      await pm.depsReport("no-such-process");
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain('not found');
    }
  });
});

describe("Persistence + boot ordering (issue #33)", () => {
  test("dependsOn persists in the dump; resurrect starts dependencies before dependents", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("boot");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;

    // Dep chain up and running, then saved.
    await pm.start({ name: "postgres", script: stayAliveScript(dir, "pg.ts") });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["postgres"],
    });
    await pm.save();

    // The dump carries the normalized dependency configuration.
    const dump = JSON.parse(readFileSync(DUMP_FILE, "utf-8")) as Array<{
      config: { name: string; dependsOn?: Array<{ name: string; policy: string }> };
    }>;
    const apiEntry = dump.find((d) => d.config.name === "api")!;
    expect(apiEntry.config.dependsOn).toEqual([{ name: "postgres", policy: "required" }]);

    // Simulate the WORST-case dump order (dependent saved before its
    // dependency) — boot must still come up dependencies-first.
    const reversed = [...dump].reverse();
    writeFileSync(DUMP_FILE, JSON.stringify(reversed, null, 2));

    // A "reboot": a fresh manager resurrects from the dump. Deps first,
    // regardless of dump order.
    const pm2 = new ProcessManager();
    const bootOrder: string[] = [];
    (pm2.on as (k: string, l: (e: any) => void) => void)("process:start", (e) => {
      if (e.source === "system") bootOrder.push(e.process.name);
    });
    await pm2.resurrect();
    expect(bootOrder).toEqual(["postgres", "api"]);
    for (const name of ["postgres", "api"]) {
      expect(pm2.list().find((s: any) => s.name === name)!.status).toBe("online");
    }

    try {
      await pm.deleteAll();
      await pm2.deleteAll();
    } catch {
      /* cleanup */
    }
  });

  test("one failed boot graph does not block an unrelated graph (rule #12)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("bootfail");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;

    // Graph A: broken → api (api depends on a script that no longer
    // exists → resurrect skips it → api is blocked, warned). Graph B:
    // healthy web, unrelated.
    const brokenScript = stayAliveScript(dir, "broken-dep.ts");
    await pm.start({ name: "broken-dep", script: brokenScript });
    await pm.start({
      name: "api",
      script: stayAliveScript(dir, "api.ts"),
      dependsOn: ["broken-dep"],
    });
    await pm.start({ name: "web", script: stayAliveScript(dir, "web.ts") });
    // save() mirrors exactly this fleet into the dump; pm stays alive but
    // untouched — the "reboot" reads the same dump with the dependency's
    // script gone.
    await pm.save();
    rmSync(brokenScript);
    const pm2 = new ProcessManager();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await pm2.resurrect();
    } finally {
      // Read the captured calls BEFORE restoring — bun's mockRestore()
      // clears mock.calls.
    }
    const warned = (warn.mock.calls as unknown as string[][]).map((c) => String(c[0])).join("\n");
    warn.mockRestore();
    // The unrelated graph came up; the broken graph stayed down.
    expect(pm2.list().find((s: any) => s.name === "web")!.status).toBe("online");
    expect(pm2.list().find((s: any) => s.name === "broken-dep")).toBeUndefined();
    expect(warned).toMatch(/broken-dep/);

    try {
      await pm2.deleteAll();
    } catch {
      /* cleanup */
    }
  });
});

describe("Ecosystem dependency ordering (issue #33)", () => {
  test("deps declared LAST still start FIRST — the sweep is graph-ordered", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("eco");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;
    const order: string[] = [];
    (pm.on as (k: string, l: (e: any) => void) => void)("process:start", (e) =>
      order.push(e.process.name)
    );

    await pm.startEcosystem({
      apps: [
        { name: "worker", script: stayAliveScript(dir, "worker.ts"), dependsOn: ["api"] },
        { name: "api", script: stayAliveScript(dir, "api.ts"), dependsOn: ["postgres"] },
        { name: "postgres", script: stayAliveScript(dir, "pg.ts") },
      ],
    });
    expect(order).toEqual(["postgres", "api", "worker"]);
    for (const name of ["postgres", "api", "worker"]) {
      expect(pm.list().find((s: any) => s.name === name)!.status).toBe("online");
    }
    try {
      await pm.deleteAll();
    } catch {
      /* cleanup */
    }
  });

  test("garbage dependsOn in an ecosystem fails BEFORE anything starts", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("ecogarbage");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "api", script: stayAliveScript(dir, "api.ts"), dependsOn: [{ name: "db", policy: "sometimes" as never }] },
          { name: "web", script: stayAliveScript(dir, "web.ts") },
        ],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toMatch(/Invalid dependency policy "sometimes"/);
    }
    expect(pm.list()).toHaveLength(0);
  });

  test("an ecosystem cycle is refused upfront — zero processes touched", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("ecocycle");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "api", script: stayAliveScript(dir, "api.ts"), dependsOn: ["worker"] },
          { name: "worker", script: stayAliveScript(dir, "worker.ts"), dependsOn: ["api"] },
        ],
      });
      expect.unreachable();
    } catch (err: any) {
      expect(err.message).toContain("Circular dependency detected");
      expect(err.message).toContain("api → worker → api");
    }
    expect(pm.list()).toHaveLength(0);
  });

  test("cross-namespace dependencies order the GROUPS (backend before frontend)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("econs");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;
    const order: string[] = [];
    (pm.on as (k: string, l: (e: any) => void) => void)("process:start", (e) =>
      order.push(e.process.name)
    );

    await pm.startEcosystem({
      apps: [
        { name: "web", script: stayAliveScript(dir, "web.ts"), namespace: "frontend", dependsOn: ["api"] },
        { name: "web-api", script: stayAliveScript(dir, "webapi.ts"), namespace: "frontend" },
        { name: "api", script: stayAliveScript(dir, "api.ts"), namespace: "backend" },
      ],
    });
    // The backend unit starts BEFORE the frontend unit (web needs api).
    expect(order.indexOf("api")).toBeLessThan(order.indexOf("web"));
    expect(order.indexOf("web-api")).toBeGreaterThan(order.indexOf("web")); // stable within unit
    for (const name of ["api", "web", "web-api"]) {
      expect(pm.list().find((s: any) => s.name === name)!.status).toBe("online");
    }
    try {
      await pm.deleteAll();
    } catch {
      /* cleanup */
    }
  });

  test("a namespace group member's deps within the group start in member order", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const dir = scratch("econsin");
    const pm = new ProcessManager();
    const fake = new FakeProvider();
    (pm.dependencies as unknown as { provider: unknown }).provider = fake;
    const order: string[] = [];
    (pm.on as (k: string, l: (e: any) => void) => void)("process:start", (e) =>
      order.push(e.process.name)
    );

    // api declared FIRST but depends on auth (same namespace).
    await pm.startEcosystem({
      apps: [
        { name: "api", script: stayAliveScript(dir, "api.ts"), namespace: "shop", dependsOn: ["auth"] },
        { name: "auth", script: stayAliveScript(dir, "auth.ts"), namespace: "shop" },
      ],
    });
    expect(order).toEqual(["auth", "api"]);
    try {
      await pm.deleteAll();
    } catch {
      /* cleanup */
    }
  });
});

// ---------------------------------------------------------------------------
// Client wire shape (mocked transport, same discipline as api.test.ts)
// ---------------------------------------------------------------------------

describe("PBoss.deps() wire shape (issue #33)", () => {
  test("sends the deps RPC with the target and returns the reports", async () => {
    const { PBoss } = await import("../src/api");
    const pboss = new (PBoss as any)({ noDaemon: true }) as import("../src/api").PBoss;
    const report = {
      process: "api",
      dependencies: [
        { name: "postgres", policy: "required", provider: "pboss", status: "running", satisfied: true },
      ],
      dependents: [],
    };
    const send = spyOn(pboss as any, "send").mockResolvedValue({
      type: "deps",
      data: [report],
      success: true,
    });
    try {
      const reports = await pboss.deps("api");
      expect(reports[0]!.process).toBe("api");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "deps", data: { target: "api" } })
      );
    } finally {
      send.mockRestore();
    }
  });

  test("delete() keeps the historical wire shape unless force is set", async () => {
    const { PBoss } = await import("../src/api");
    const pboss = new (PBoss as any)({ noDaemon: true }) as import("../src/api").PBoss;
    const send = spyOn(pboss as any, "send").mockResolvedValue({
      type: "delete",
      data: [],
      success: true,
    });
    try {
      await pboss.delete("my-app");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete", data: { target: "my-app" } })
      );
      await pboss.delete("my-app", { force: true });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete", data: { target: "my-app", force: true } })
      );
    } finally {
      send.mockRestore();
    }
  });

  test("a dependency failure surfaces its machine-readable details on the response", async () => {
    const { PBoss } = await import("../src/api");
    const pboss = new (PBoss as any)({ noDaemon: true }) as import("../src/api").PBoss;
    const details = {
      process: "api",
      dependency: "postgresql",
      provider: "systemd",
      service: "postgresql.service",
      state: "inactive",
      reason: "dependency_not_running",
    };
    const send = spyOn(pboss as any, "send").mockResolvedValue({
      type: "error",
      error: "Cannot start \"api\".",
      success: false,
      dependencyFailure: details,
    });
    try {
      try {
        await pboss.start({ script: "/x/api.ts", name: "api", dependsOn: ["postgresql"] });
        expect.unreachable();
      } catch (err: any) {
        expect(err.name).toBe("PBossError");
        // The structured payload rides on the response — machine-readable.
        expect(err.response.dependencyFailure).toEqual(details);
      }
    } finally {
      send.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI e2e — the real binary + real daemon on a fresh hermetic home
// ---------------------------------------------------------------------------

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: ROOT,
  });
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  const code = await proc.exited;
  return { out, err, code };
}

async function e2eHome(prefix: string): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), `pboss-issue33-e2e-${prefix}-`));
  mkdirSync(join(home, "logs"), { recursive: true });
  return home;
}

describe("CLI e2e — dependency start, deps inspection, blocked start (issue #33)", () => {
  test(
    "ecosystem with a dep chain starts in order; pboss deps + --reverse render providers and states",
    async () => {
      const home = await e2eHome("chain");
      writeFileSync(join(home, "postgres.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(join(home, "api.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(join(home, "worker.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(
        join(home, "ecosystem.config.json"),
        JSON.stringify({
          apps: [
            { name: "worker", script: "worker.ts", dependsOn: ["api"] },
            { name: "api", script: "api.ts", dependsOn: ["postgres"] },
            { name: "postgres", script: "postgres.ts" },
          ],
        })
      );
      try {
        const start = await runCli(["start", join(home, "ecosystem.config.json")], home);
        expect(start.code).toBe(0);
        expect(start.out).toContain("postgres");
        expect(start.out).toContain("api");
        expect(start.out).toContain("worker");

        const deps = await runCli(["deps", "worker"], home);
        expect(deps.code).toBe(0);
        expect(deps.out).toContain("worker");
        expect(deps.out).toContain("api");
        expect(deps.out).toContain("running");
        expect(deps.out).toContain("ProcBoss");

        const rev = await runCli(["deps", "postgres", "--reverse"], home);
        expect(rev.code).toBe(0);
        // Reverse = DIRECT dependents: api depends on postgres.
        expect(rev.out).toContain("api");
        expect(rev.out).not.toContain("worker"); // worker depends on api, not postgres

        // A no-deps process shows the honest empty state.
        const none = await runCli(["deps", "postgres"], home);
        expect(none.out).toContain("(no dependencies declared)");
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    120000
  );

  test(
    "a required dependency that resolves nowhere blocks the start with the honest diagnostic",
    async () => {
      const home = await e2eHome("blocked");
      writeFileSync(join(home, "api.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(
        join(home, "ecosystem.config.json"),
        JSON.stringify({
          apps: [
            { name: "api", script: "api.ts", dependsOn: ["definitely-not-a-service-xyz"] },
          ],
        })
      );
      try {
        const res = await runCli(["start", join(home, "ecosystem.config.json")], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain("could not be resolved");
        expect(res.err).toContain("ProcBoss applications: not found");
        // This environment has no systemd-managed units to ask about…
        // the line still names where pboss looked.
        expect(res.err).toMatch(/System services: (not found|not available on this platform)/);

        const list = await runCli(["list"], home);
        expect(list.out).not.toContain("api"); // nothing was started
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    120000
  );

  test(
    "--depends-on flag: blocked unknown name; bad policy rejected with guidance",
    async () => {
      const home = await e2eHome("flag");
      writeFileSync(join(home, "api.ts"), "setInterval(() => {}, 1000);\n");
      try {
        const blocked = await runCli(
          ["start", join(home, "api.ts"), "--name", "api", "--depends-on", "ghost-service-xyz"],
          home
        );
        expect(blocked.code).toBe(1);
        expect(blocked.err).toContain("could not be resolved");

        const badPolicy = await runCli(
          ["start", join(home, "api.ts"), "--name", "api2", "--depends-on", "x:sometimes"],
          home
        );
        expect(badPolicy.code).toBe(1);
        expect(badPolicy.err).toContain('must be "required" or "optional"');
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    120000
  );

  test(
    "deleting a dependency via the CLI is refused, then --force removes it",
    async () => {
      const home = await e2eHome("delguard");
      writeFileSync(join(home, "postgres.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(join(home, "api.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(
        join(home, "ecosystem.config.json"),
        JSON.stringify({
          apps: [
            { name: "postgres", script: "postgres.ts" },
            { name: "api", script: "api.ts", dependsOn: ["postgres"] },
          ],
        })
      );
      try {
        await runCli(["start", join(home, "ecosystem.config.json")], home);

        const refused = await runCli(["delete", "postgres"], home);
        expect(refused.code).toBe(1);
        expect(refused.err).toContain('Cannot delete "postgres"');
        expect(refused.err).toContain('"api"');

        const forced = await runCli(["delete", "postgres", "--force"], home);
        expect(forced.code).toBe(0);
        const list = await runCli(["list"], home);
        expect(list.out).toContain("api");
        expect(list.out).not.toMatch(/postgres\s/);
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    120000
  );
});
