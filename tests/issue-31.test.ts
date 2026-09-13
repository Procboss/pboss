/**
 * Issue #31 — Make namespace startup atomic and preserve standalone
 * process independence. https://github.com/Procboss/pboss/issues/31
 *
 * The contract under test:
 *
 * Ecosystem / boundary semantics:
 *   1. Apps WITHOUT a namespace are independent: a failing app is
 *      reported, but other standalone apps (before AND after it) still
 *      start — nothing is rolled back.
 *   2. Apps sharing a namespace form ONE atomic group: a member failure
 *      rolls back only the members this invocation started.
 *   3. Members already running before the operation are NEVER rolled back.
 *   4. A namespace failure never affects other namespaces or standalones.
 *
 * Rollback reporting:
 *   5. The ORIGINAL startup failure stays the primary error; rollback
 *      results are reported separately (✓/✗ per member), and a rollback
 *      failure is reported without hiding the original error.
 *
 * Namespace operations:
 *   6. `startTarget(namespace)` (the `pboss start <ns>` resume) is atomic
 *      with the same invocation-scoped rollback.
 *   7. `restart(namespace)` is stop-all + atomic start.
 *   8. Namespace-scoped operations on the same namespace serialize.
 *
 * onNsMemberExit policy (owner request on top of issue #31):
 *   9. Default `ignore`: a member exiting for good does nothing to siblings.
 *  10. `exit`: running siblings with the policy stop when a member exits
 *      for good on its own.
 *  11. pboss-initiated stops (user stop) NEVER trigger the policy.
 *  12. Standalone (namespace-less) processes are never affected.
 *
 * PBOSS_HOME is set before any src import (constants.ts binds at import
 * time) — same hermetic-home discipline as namespace-ops.test.ts.
 */
import { describe, test, expect, afterEach, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-issue31-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;

// The BOUND home — NOT necessarily TEST_HOME (shared module registries).
const BOUND = await import("../src/constants");
const BOUND_HOME = BOUND.PBOSS_HOME;

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  if (BOUND_HOME !== TEST_HOME) rmSync(TEST_HOME, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-issue31-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

function stayAliveScript(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "setInterval(() => {}, 1000);\n");
  return p;
}

/** A script that exits on its own after `ms` — a self-initiated exit. */
function selfExitScript(dir: string, name: string, ms = 120): string {
  const p = join(dir, name);
  writeFileSync(p, `setTimeout(() => process.exit(0), ${ms});\n`);
  return p;
}

async function startIn(pm: any, name: string, script: string, extra: any = {}) {
  const { ProcessManager } = await import("../src/process-manager");
  if (!pm) pm = new ProcessManager();
  await pm.start({ name, script, ...extra });
  return pm;
}

function byName(pm: any): Map<string, any> {
  return new Map<string, any>(pm.list().map((s: any) => [s.name as string, s as any]));
}

/** Poll until `predicate` holds, or fail after `ms`. */
async function until(predicate: () => boolean, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(80);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Ecosystem boundary semantics
// ---------------------------------------------------------------------------
describe("ProcessManager — ecosystem namespace boundaries (issue #31)", () => {
  let pm: any;
  let dir: string;

  afterEach(async () => {
    try {
      if (pm) await pm.del("all");
    } catch {
      /* empty fleet */
    }
    pm = undefined;
  });

  test("standalone apps are independent: a failing app never blocks or rolls back others", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("standalone");
    pm = new ProcessManager();
    const api = stayAliveScript(dir, "api.ts");
    const frontend = stayAliveScript(dir, "frontend.ts");

    let err: any;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "api", script: api },
          { name: "worker", script: join(dir, "does-not-exist.ts") },
          { name: "frontend", script: frontend },
        ],
      });
      throw new Error("expected the ecosystem start to report the failure");
    } catch (e: any) {
      err = e;
    }

    // Reported honestly: the failure is named...
    expect(err.message).toContain("ecosystem start failed");
    expect(err.message).toContain("worker");
    expect(err.message).toContain("does-not-exist.ts");

    // ...and apps BEFORE and AFTER the failure are still running — no
    // rollback, no abort of the sweep.
    const map = byName(pm);
    expect(map.get("api").status).toBe("online");
    expect(map.get("frontend").status).toBe("online");
    expect(map.has("worker")).toBe(false); // never created
  });

  test("a namespace starts atomically: a member failure rolls back only this invocation's members", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("atomic");
    pm = new ProcessManager();
    const shopApi = stayAliveScript(dir, "shop-api.ts");
    const shopWorker = stayAliveScript(dir, "shop-worker.ts");

    let err: any;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "shop-api", script: shopApi, namespace: "shop" },
          { name: "shop-worker", script: shopWorker, namespace: "shop" },
          { name: "shop-scheduler", script: join(dir, "missing.ts"), namespace: "shop" },
        ],
      });
      throw new Error("expected the namespace startup to fail");
    } catch (e: any) {
      err = e;
    }

    // Primary error first, rollback report separate.
    expect(err.message).toContain('namespace "shop" startup failed');
    expect(err.message).toContain("missing.ts");
    expect(err.message).toContain("Rollback:");
    expect(err.message).toContain("shop-api stopped");
    expect(err.message).toContain("shop-worker stopped");

    // The two successfully started members were rolled back.
    const map = byName(pm);
    expect(map.get("shop-api").status).toBe("stopped");
    expect(map.get("shop-worker").status).toBe("stopped");
    expect(map.has("shop-scheduler")).toBe(false);
  });

  test("already-running members are NEVER rolled back (invocation-scoped rollback only)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("prerunning");
    pm = new ProcessManager();
    // api was running BEFORE the operation.
    await startIn(pm, "shop-api", stayAliveScript(dir, "shop-api.ts"), { namespace: "shop" });
    const pidBefore = byName(pm).get("shop-api").pid;

    let err: any;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "shop-api", script: join(dir, "shop-api.ts"), namespace: "shop" },
          { name: "shop-worker", script: stayAliveScript(dir, "shop-worker.ts"), namespace: "shop" },
          { name: "shop-scheduler", script: join(dir, "missing.ts"), namespace: "shop" },
        ],
      });
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    expect(err.message).toContain('namespace "shop" startup failed');
    // worker (started by THIS invocation) rolled back…
    expect(byName(pm).get("shop-worker").status).toBe("stopped");
    // …api untouched: same pid, still online.
    const api = byName(pm).get("shop-api");
    expect(api.status).toBe("online");
    expect(api.pid).toBe(pidBefore);
  });

  test("a namespace failure leaves other namespaces and standalones untouched", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("boundaries");
    pm = new ProcessManager();
    const web = stayAliveScript(dir, "web.ts");
    const shopApi = stayAliveScript(dir, "shop-api.ts");
    const adminApi = stayAliveScript(dir, "admin-api.ts");

    let err: any;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "web", script: web },
          { name: "shop-api", script: shopApi, namespace: "shop" },
          { name: "shop-worker", script: join(dir, "missing.ts"), namespace: "shop" },
          { name: "admin-api", script: adminApi, namespace: "admin" },
        ],
      });
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    expect(err.message).toContain('namespace "shop" startup failed');
    const map = byName(pm);
    expect(map.get("web").status).toBe("online"); // standalone unaffected
    expect(map.get("admin-api").status).toBe("online"); // other namespace unaffected
    expect(map.get("shop-api").status).toBe("stopped"); // rolled back
  });

  test("a fully valid ecosystem (namespaces + standalones) starts clean — happy path intact", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("happy");
    pm = new ProcessManager();

    const states = await pm.startEcosystem({
      apps: [
        { name: "web", script: stayAliveScript(dir, "web.ts") },
        { name: "shop-api", script: stayAliveScript(dir, "shop-api.ts"), namespace: "shop" },
        { name: "shop-worker", script: stayAliveScript(dir, "shop-worker.ts"), namespace: "shop" },
      ],
    });
    expect(states).toHaveLength(3);
    for (const s of states) expect(s.status).toBe("online");
  });

  test("non-contiguous namespace declarations still form ONE atomic group", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("interleaved");
    pm = new ProcessManager();

    let err: any;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "web", script: stayAliveScript(dir, "web.ts") },
          { name: "shop-api", script: stayAliveScript(dir, "shop-api.ts"), namespace: "shop" },
          { name: "web2", script: stayAliveScript(dir, "web2.ts") },
          { name: "shop-worker", script: join(dir, "missing.ts"), namespace: "shop" },
        ],
      });
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    expect(err.message).toContain('namespace "shop" startup failed');
    const map = byName(pm);
    expect(map.get("web").status).toBe("online");
    expect(map.get("web2").status).toBe("online"); // started even though declared after shop's first member
    expect(map.get("shop-api").status).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// Rollback reporting quality
// ---------------------------------------------------------------------------
describe("ProcessManager — rollback reporting (issue #31)", () => {
  let pm: any;
  let dir: string;

  afterEach(async () => {
    try {
      if (pm) await pm.del("all");
    } catch {
      /* empty fleet */
    }
    pm = undefined;
  });

  test("a rollback stop failure is reported WITHOUT hiding the original startup failure", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("rollbackfail");
    pm = new ProcessManager();

    // Both members pre-created and STOPPED → both are rollback-eligible
    // when the ecosystem start resumes them.
    const apiScript = stayAliveScript(dir, "api.ts");
    const workerScript = stayAliveScript(dir, "worker.ts");
    await startIn(pm, "api", apiScript, { namespace: "shop" });
    await startIn(pm, "worker", workerScript, { namespace: "shop" });
    await pm.stop("shop");

    // worker's ROLLBACK stop will explode (its start still succeeds).
    const workerId = byName(pm).get("worker").pm_id;
    (pm as any).processes.get(workerId).stop = () =>
      Promise.reject(new Error("stop refused (stub)"));

    let err: any;
    try {
      await pm.startEcosystem({
        apps: [
          { name: "api", script: apiScript, namespace: "shop" },
          { name: "worker", script: workerScript, namespace: "shop" },
          { name: "scheduler", script: join(dir, "missing.ts"), namespace: "shop" },
        ],
      });
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    // The ORIGINAL failure is the primary message…
    expect(err.message).toContain('namespace "shop" startup failed');
    expect(err.message).toContain("missing.ts");
    // …the rollback failure is reported separately (✗), not swallowed…
    expect(err.message).toContain("✗ worker failed to stop: stop refused (stub)");
    // …and the other member's rollback still ran (✓).
    expect(err.message).toContain("✓ api stopped");
  });
});

// ---------------------------------------------------------------------------
// Namespace operations: atomic resume + atomic restart + serialization
// ---------------------------------------------------------------------------
describe("ProcessManager — namespace operations (issue #31)", () => {
  let pm: any;
  let dir: string;

  afterEach(async () => {
    try {
      if (pm) await pm.del("all");
    } catch {
      /* empty fleet */
    }
    pm = undefined;
  });

  test("startTarget(namespace) is atomic: a failing member rolls back the resumed ones", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("resume-atomic");
    pm = new ProcessManager();
    await startIn(pm, "rapi", stayAliveScript(dir, "rapi.ts"), { namespace: "stellar" });
    await startIn(pm, "rworker", stayAliveScript(dir, "rworker.ts"), { namespace: "stellar" });
    await pm.stop("stellar");

    // rworker's start will fail; rapi was resumed successfully first.
    const rworkerId = byName(pm).get("rworker").pm_id;
    (pm as any).processes.get(rworkerId).start = () =>
      Promise.reject(new Error("worker exploded (stub)"));

    let err: any;
    try {
      await pm.startTarget("stellar");
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    expect(err.message).toContain('namespace "stellar" startup failed');
    expect(err.message).toContain("worker exploded (stub)");
    expect(err.message).toContain("rapi stopped"); // rollback line
    expect(byName(pm).get("rapi").status).toBe("stopped");
  });

  test("startTarget(namespace) happy path: whole group online, online members untouched", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("resume-happy");
    pm = new ProcessManager();
    await startIn(pm, "hapi", stayAliveScript(dir, "hapi.ts"), { namespace: "happy" });
    await startIn(pm, "hworker", stayAliveScript(dir, "hworker.ts"), { namespace: "happy" });
    await pm.stop("hworker");
    const pidBefore = byName(pm).get("hapi").pid;

    const states = await pm.startTarget("happy");
    expect(states).toHaveLength(2);
    const map = byName(pm);
    expect(map.get("hapi").pid).toBe(pidBefore);
    expect(map.get("hworker").pid).toBeGreaterThan(0);
  });

  test("restart(namespace) is atomic: a member that cannot come back rolls back the others", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("restart-atomic");
    pm = new ProcessManager();
    await startIn(pm, "capi", stayAliveScript(dir, "capi.ts"), { namespace: "core" });
    await startIn(pm, "cworker", stayAliveScript(dir, "cworker.ts"), { namespace: "core" });

    // cworker's start fails during the restart's bring-up phase.
    const cworkerId = byName(pm).get("cworker").pm_id;
    const containers = (pm as any).processes;
    containers.get(cworkerId).start = () =>
      Promise.reject(new Error("worker refused restart (stub)"));

    let err: any;
    try {
      await pm.restart("core");
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    expect(err.message).toContain('namespace "core" startup failed');
    expect(err.message).toContain("worker refused restart (stub)");
    // capi WAS restarted by this invocation → rolled back to stopped.
    expect(byName(pm).get("capi").status).toBe("stopped");
  });

  test("same-namespace operations serialize; different namespaces run concurrently", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    pm = new ProcessManager();
    const lock = (ns: string, ms: number, log: string[]) =>
      (pm as any).withNamespaceLock(ns, async () => {
        log.push(`start:${ns}`);
        await Bun.sleep(ms);
        log.push(`end:${ns}`);
      });

    const logA: string[] = [];
    const logB: string[] = [];
    const a = lock("shop", 80, logA);
    const a2 = lock("shop", 5, logA); // queued behind a
    const b = lock("admin", 5, logB); // independent — runs immediately
    await Promise.all([a, a2, b]);

    // shop's two operations never interleaved…
    expect(logA).toEqual(["start:shop", "end:shop", "start:shop", "end:shop"]);
    // …and admin finished while shop's first op was still sleeping.
    expect(logB).toEqual(["start:admin", "end:admin"]);
  });

  test("namespace stop keeps going when one member refuses; error aggregates the stragglers", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("stop-besteffort");
    pm = new ProcessManager();
    await startIn(pm, "sapi", stayAliveScript(dir, "sapi.ts"), { namespace: "stubborn" });
    await startIn(pm, "sworker", stayAliveScript(dir, "sworker.ts"), { namespace: "stubborn" });

    const sapiId = byName(pm).get("sapi").pm_id;
    const containers = (pm as any).processes;
    containers.get(sapiId).stop = () => Promise.reject(new Error("ignore SIGTERM (stub)"));

    let err: any;
    try {
      await pm.stop("stubborn");
      throw new Error("expected failure");
    } catch (e: any) {
      err = e;
    }

    expect(err.message).toContain('namespace "stubborn" stop failed');
    expect(err.message).toContain("sapi");
    // The OTHER member was still stopped — best-effort, not abort-on-first.
    expect(byName(pm).get("sworker").status).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// onNsMemberExit policy
// ---------------------------------------------------------------------------
describe("ProcessManager — onNsMemberExit policy (issue #31)", () => {
  let pm: any;
  let dir: string;

  afterEach(async () => {
    try {
      if (pm) await pm.del("all");
    } catch {
      /* empty fleet */
    }
    pm = undefined;
  });

  test("default ignore: a member exiting for good leaves siblings running", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("policy-ignore");
    pm = new ProcessManager();
    await startIn(pm, "gapi", selfExitScript(dir, "gapi.ts"), {
      namespace: "silent",
      autorestart: false,
    });
    await startIn(pm, "gworker", stayAliveScript(dir, "gworker.ts"), { namespace: "silent" });

    // gapi exits on its own (~120ms) — terminal, non-deliberate.
    expect(await until(() => byName(pm).get("gapi").status === "stopped")).toBe(true);
    await Bun.sleep(400); // give any (wrong) cascade a chance to fire

    expect(byName(pm).get("gworker").status).toBe("online");
  });

  test("exit: a member exiting for good stops its running siblings with the policy", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("policy-exit");
    pm = new ProcessManager();
    await startIn(pm, "xapi", selfExitScript(dir, "xapi.ts"), {
      namespace: "cascade",
      autorestart: false,
    });
    await startIn(pm, "xworker", stayAliveScript(dir, "xworker.ts"), {
      namespace: "cascade",
      onNsMemberExit: "exit",
    });

    expect(await until(() => byName(pm).get("xapi").status === "stopped")).toBe(true);
    // The policy stop is async — poll for the sibling to come down.
    expect(await until(() => byName(pm).get("xworker").status === "stopped")).toBe(true);
  });

  test("pboss-initiated stops never trigger the policy (no cascade from `pboss stop`)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("policy-deliberate");
    pm = new ProcessManager();
    await startIn(pm, "dapi", stayAliveScript(dir, "dapi.ts"), {
      namespace: "manual",
      autorestart: false,
    });
    await startIn(pm, "dworker", stayAliveScript(dir, "dworker.ts"), {
      namespace: "manual",
      onNsMemberExit: "exit",
    });

    // An operator stop of one member must NOT stop the sibling.
    await pm.stop("dapi");
    expect(byName(pm).get("dapi").status).toBe("stopped");
    await Bun.sleep(400);
    expect(byName(pm).get("dworker").status).toBe("online");
  });

  test("the policy never applies to standalone (namespace-less) processes", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("policy-standalone");
    pm = new ProcessManager();
    await startIn(pm, "papi", selfExitScript(dir, "papi.ts"), {
      autorestart: false,
      onNsMemberExit: "exit", // set, but meaningless without a namespace
    });
    await startIn(pm, "pworker", stayAliveScript(dir, "pworker.ts"), {
      onNsMemberExit: "exit",
    });

    expect(await until(() => byName(pm).get("papi").status === "stopped")).toBe(true);
    await Bun.sleep(400);
    expect(byName(pm).get("pworker").status).toBe("online");
  });

  test("invalid policy values are a clear, immediate error", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("policy-invalid");
    pm = new ProcessManager();
    try {
      await pm.start({
        name: "bad",
        script: stayAliveScript(dir, "bad.ts"),
        namespace: "badns",
        onNsMemberExit: "explode" as any,
      });
      throw new Error("expected rejection");
    } catch (err: any) {
      expect(err.message).toContain('Invalid onNsMemberExit "explode"');
    }
  });
});

// ---------------------------------------------------------------------------
// API transport shape
// ---------------------------------------------------------------------------
describe("PBoss API — onNsMemberExit transport shape (issue #31)", () => {
  test("start() carries the policy through the RPC payload", async () => {
    const { PBoss } = await import("../src/api");
    const pboss = new PBoss();
    const sendMock = spyOn(pboss, "send" as never);
    (sendMock as any).mockResolvedValue({
      type: "start",
      data: [{ name: "web", status: "online" }],
      success: true,
    });

    await pboss.start({
      script: "/tmp/web.ts",
      name: "web",
      namespace: "shop",
      onNsMemberExit: "exit",
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start",
        data: expect.objectContaining({ onNsMemberExit: "exit", namespace: "shop" }),
      })
    );
    (sendMock as any).mockRestore();
  });
});

// ---------------------------------------------------------------------------
// CLI e2e — the real binary path on a fresh hermetic home
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
  const home = mkdtempSync(join(tmpdir(), `pboss-issue31-e2e-${prefix}-`));
  mkdirSync(join(home, "logs"), { recursive: true });
  return home;
}

describe("CLI e2e — atomic ecosystem + policy flag (issue #31)", () => {
  test(
    "ecosystem start: namespace failure rolls back, standalone survives, exit 1",
    async () => {
      const home = await e2eHome("eco");
      writeFileSync(join(home, "web.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(join(home, "shop-api.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(join(home, "shop-worker.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(
        join(home, "ecosystem.config.json"),
        JSON.stringify({
          apps: [
            { name: "web", script: "web.ts" },
            { name: "shop-api", script: "shop-api.ts", namespace: "shop" },
            { name: "shop-worker", script: "shop-worker.ts", namespace: "shop" },
            { name: "shop-scheduler", script: "scheduler-missing.ts", namespace: "shop" },
          ],
        })
      );
      try {
        const res = await runCli(["start", join(home, "ecosystem.config.json")], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain('namespace "shop" startup failed');
        expect(res.err).toContain("scheduler-missing.ts");
        expect(res.err).toContain("Rollback:");
        expect(res.err).toContain("shop-api stopped");
        expect(res.err).toContain("shop-worker stopped");

        // The standalone app survived; the namespace is down.
        const list = await runCli(["list"], home);
        expect(list.out).toContain("web");
        expect(list.out).toContain("online");
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    90000
  );

  test(
    "--on-ns-member-exit flag: valid value accepted, invalid value rejected with guidance",
    async () => {
      const home = await e2eHome("flag");
      writeFileSync(join(home, "web.ts"), "setInterval(() => {}, 1000);\n");
      try {
        const ok = await runCli(
          ["start", join(home, "web.ts"), "--name", "web", "--on-ns-member-exit", "exit"],
          home
        );
        expect(ok.code).toBe(0);

        const bad = await runCli(
          ["start", join(home, "web.ts"), "--name", "web2", "--on-ns-member-exit", "explode"],
          home
        );
        expect(bad.code).toBe(1);
        expect(bad.err).toContain('must be "ignore" or "exit"');
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    90000
  );
});
