/**
 * Namespace-level process management — issue #27.
 *
 * The contract under test:
 *   1. `pboss stop|restart|reload|delete <namespace>` operates on the WHOLE
 *      group (the resolver already matched namespaces — these tests pin the
 *      semantics, the not-found errors, and the persistence integration).
 *   2. `pboss start <namespace>` (also name / cluster prefix / id) RESUMES
 *      existing processes — routed through startTarget, only when the
 *      positional is not an existing script file.
 *   3. Operating on an unknown name/namespace is a CLEAR error, not a
 *      silent empty table that reads as success ("all" stays a no-op).
 *
 * PBOSS_HOME is set before any src import (constants.ts binds at import
 * time). `bun test` shares module registries across files, so the BOUND
 * home may belong to whichever file loaded first — in-process manager
 * tests use the BOUND constants, never assume TEST_HOME, and never delete
 * the bound home (see runtime-discovery.test.ts for the full lesson).
 * Dump assertions are FILTER-based for the same reason: the bound dump is
 * shared with other files' read-after-their-own-write assertions.
 */
import { describe, test, expect, afterEach, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-nsops-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;

// The BOUND home — NOT necessarily TEST_HOME (shared module registries).
const BOUND = await import("../src/constants");
const BOUND_HOME = BOUND.PBOSS_HOME;
const BOUND_DUMP_FILE = BOUND.DUMP_FILE;

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  // The BOUND home belongs to whichever file bound constants first under
  // the full suite — only OUR own (unbound) temp home is safe to remove.
  if (BOUND_HOME !== TEST_HOME) rmSync(TEST_HOME, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-nsops-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

function stayAliveScript(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "setInterval(() => {}, 1000);\n");
  return p;
}

async function readDump(): Promise<any[]> {
  try {
    return JSON.parse(await Bun.file(BOUND_DUMP_FILE).text());
  } catch {
    return [];
  }
}

/** Start a process with a namespace, in a fresh or given manager. */
async function startIn(pm: any, name: string, dir: string, ns: string) {
  const { ProcessManager } = await import("../src/process-manager");
  if (!pm) pm = new ProcessManager();
  await pm.start({ name, script: stayAliveScript(dir, `${name}.ts`), namespace: ns });
  return pm;
}

describe("ProcessManager — namespace-level lifecycle (issue #27)", () => {
  let pm: any;
  let dir: string;

  afterEach(async () => {
    // Never leak live worker processes into later files: delete everything
    // this manager owns (persist:false would leave a stale dump — the
    // default persist matches deleteAll's own contract).
    try {
      if (pm) await pm.del("all");
    } catch {
      // empty fleet — nothing to delete
    }
    pm = undefined;
  });

  test("stop by namespace stops every member — and ONLY the members; the dump follows", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("stop-ns");
    pm = new ProcessManager();
    await startIn(pm, "nsweb", dir, "stellarforge");
    await startIn(pm, "nscollab", dir, "stellarforge");
    await startIn(pm, "unrelated", dir, "other-ns");

    const states = await pm.stop("stellarforge");
    expect(states).toHaveLength(2);

    const byName = new Map<string, any>(
      pm.list().map((s: any) => [s.name as string, s as any] as [string, any])
    );
    expect(byName.get("nsweb").status).toBe("stopped");
    expect(byName.get("nscollab").status).toBe("stopped");
    expect(byName.get("unrelated").status).toBe("online");

    // Auto-save (Task 37) records the group stop — a reboot resurrects the
    // namespace as stopped, the unrelated process as running.
    const dump = await readDump();
    const nsStopped = dump.filter((e) => e.config?.namespace === "stellarforge");
    expect(nsStopped).toHaveLength(2);
    expect(nsStopped.every((e) => e.stopped === true)).toBe(true);
    const unrelated = dump.find((e) => e.config?.name === "unrelated");
    expect(unrelated?.stopped).toBe(false);
  });

  test("restart by namespace restarts members — including stopped ones", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("restart-ns");
    pm = new ProcessManager();
    await startIn(pm, "nsweb", dir, "stellarforge");
    await startIn(pm, "nscollab", dir, "stellarforge");
    await pm.stop("nscollab"); // one member stopped

    const states = await pm.restart("stellarforge");
    expect(states).toHaveLength(2);
    for (const s of states) expect(s.status).toBe("online");
  });

  test("startTarget(namespace) resumes only the not-running members (online ones keep their pid)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("start-ns");
    pm = new ProcessManager();
    await startIn(pm, "nsweb", dir, "stellarforge");
    await startIn(pm, "nscollab", dir, "stellarforge");
    await pm.stop("nscollab");

    const pidBefore = pm.list().find((s: any) => s.name === "nsweb").pid;
    const states = await pm.startTarget("stellarforge");
    expect(states).toHaveLength(2);
    for (const s of states) expect(s.status).toBe("online");

    const after = new Map<string, any>(
      pm.list().map((s: any) => [s.name as string, s as any] as [string, any])
    );
    expect(after.get("nsweb").pid).toBe(pidBefore); // untouched, not restarted
    expect(after.get("nscollab").pid).toBeGreaterThan(0); // actually spawned

    // The dump flip back to running — the resume survives the next reboot.
    const dump = await readDump();
    const ns = dump.filter((e) => e.config?.namespace === "stellarforge");
    expect(ns.every((e) => e.stopped === false)).toBe(true);
  });

  test("startTarget also resumes by process name and by numeric id", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("start-name");
    pm = new ProcessManager();
    await startIn(pm, "solo", dir, "lonely");
    const id = pm.list()[0].pm_id;

    await pm.stop("solo");
    let states = await pm.startTarget("solo");
    expect(states[0].status).toBe("online");

    await pm.stop("solo");
    states = await pm.startTarget(String(id));
    expect(states[0].status).toBe("online");
  });

  test("delete by namespace removes the members only — the rest survives in list AND dump", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("del-ns");
    pm = new ProcessManager();
    await startIn(pm, "nsweb", dir, "stellarforge");
    await startIn(pm, "nscollab", dir, "stellarforge");
    await startIn(pm, "unrelated", dir, "other-ns");

    const states = await pm.del("stellarforge");
    expect(states).toHaveLength(2);

    const remaining = pm.list().map((s: any) => s.name);
    expect(remaining).toEqual(["unrelated"]);

    const dump = await readDump();
    expect(dump.filter((e) => e.config?.namespace === "stellarforge")).toHaveLength(0);
    expect(dump.some((e) => e.config?.name === "unrelated")).toBe(true);
  });

  test("unknown targets are CLEAR errors naming the target and the verb", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("notfound");
    pm = new ProcessManager();

    for (const [op, verb] of [
      ["startTarget", "start"],
      ["stop", "stop"],
      ["restart", "restart"],
      ["reload", "reload"],
      ["del", "delete"],
    ] as const) {
      try {
        await pm[op]("ghost-namespace");
        throw new Error(`${op} was expected to throw`);
      } catch (err: any) {
        expect(err.message).toContain('Process or namespace "ghost-namespace" not found');
        expect(err.message).toContain(`nothing to ${verb}`);
      }
    }
  });

  test("'all' on an empty fleet stays a silent no-op (empty ≠ not found)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("all-empty");
    pm = new ProcessManager();
    expect(await pm.stop("all")).toEqual([]);
  });

  test("cluster-prefix targets keep per-process semantics (name wins over namespaces)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("cluster");
    pm = new ProcessManager();
    await pm.start({
      name: "clu",
      script: stayAliveScript(dir, "cluster.ts"),
      instances: 2,
      namespace: "some-ns",
    });

    const states = await pm.stop("clu");
    expect(states).toHaveLength(2); // clu-0 and clu-1, the cluster pair
    for (const s of states) expect(s.status).toBe("stopped");
  });
});

describe("PBoss API — startTarget transport shape", () => {
  test("sends the startTarget RPC with the target and emits process:start", async () => {
    const { PBoss } = await import("../src/api");
    const pboss = new PBoss();
    const sendMock = spyOn(pboss, "send" as never);
    (sendMock as any).mockResolvedValue({
      type: "startTarget",
      data: [{ name: "nsweb", status: "online" }],
      success: true,
    });

    const result = await pboss.startTarget("stellarforge");

    expect(result).toEqual([{ name: "nsweb", status: "online" }] as any);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "startTarget", data: { target: "stellarforge" } })
    );
    (sendMock as any).mockRestore();
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end — the real binary path (`bun run src/index.ts …`) on a
// fresh hermetic home per test. The CLI spawns its own daemon on that home;
// every test kills it in its finally block. stdin is "ignore" (non-TTY),
// which is exactly what the namespace-delete confirmation must handle.
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

describe("CLI e2e — namespace lifecycle through the real binary", () => {
  async function e2eHome(prefix: string): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), `pboss-nsops-e2e-${prefix}-`));
    mkdirSync(join(home, "logs"), { recursive: true });
    return home;
  }

  test(
    "start/stop/start/delete a namespace, with clear not-found errors",
    async () => {
      const home = await e2eHome("full");
      const web = join(home, "web.ts");
      const collab = join(home, "collab.ts");
      writeFileSync(web, "setInterval(() => {}, 1000);\n");
      writeFileSync(collab, "setInterval(() => {}, 1000);\n");
      try {
        // 1. Start two members of the namespace.
        let res = await runCli(["start", web, "--name", "web", "--namespace", "stellarforge"], home);
        expect(res.code).toBe(0);
        res = await runCli(["start", collab, "--name", "collab", "--namespace", "stellarforge"], home);
        expect(res.code).toBe(0);

        // 2. Stop the whole namespace — with the group summary line.
        res = await runCli(["stop", "stellarforge"], home);
        expect(res.code).toBe(0);
        expect(res.out).toContain("2 processes in namespace");
        expect(res.out).toContain("stellarforge");

        // 3. `pboss start <namespace>` — the resume reroute (no such file).
        res = await runCli(["start", "stellarforge"], home);
        expect(res.code).toBe(0);
        expect(res.out).toContain("2 processes in namespace");
        expect(res.out).toContain("stellarforge");

        // 4. Namespace delete WITHOUT --force and without a TTY: refuse.
        res = await runCli(["delete", "stellarforge"], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain("--force");

        // 5. Same delete WITH --force: the group goes, with a summary.
        res = await runCli(["delete", "stellarforge", "--force"], home);
        expect(res.code).toBe(0);
        expect(res.out).toContain("2 processes in namespace");
        expect(res.out).toContain("Deleted");

        // 6. Unknown namespace on every verb: clear error, exit 1.
        res = await runCli(["stop", "ghost-ns"], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain('Process or namespace "ghost-ns" not found');
        expect(res.err).toContain("nothing to stop");

        // 7. `pboss start <unknown>`: BOTH misses reported honestly.
        res = await runCli(["start", "ghost-ns"], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain("no script at");
        expect(res.err).toContain("ghost-ns");
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    90000
  );

  test(
    "cluster-prefix stops do NOT print a namespace summary (name wins)",
    async () => {
      const home = await e2eHome("cluster");
      const script = join(home, "cluster-worker.ts");
      writeFileSync(script, "setInterval(() => {}, 1000);\n");
      try {
        let res = await runCli(
          ["start", script, "--name", "clu", "--instances", "2", "--namespace", "some-ns"],
          home
        );
        expect(res.code).toBe(0);

        res = await runCli(["stop", "clu"], home);
        expect(res.code).toBe(0);
        // The cluster pair stopped (name/cluster semantics, unchanged)…
        expect(res.out).toContain("clu-0");
        expect(res.out).toContain("clu-1");
        // …but the output must NOT claim a namespace group operation.
        expect(res.out).not.toContain('in namespace "clu"');
      } finally {
        await runCli(["kill"], home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    60000
  );
});
