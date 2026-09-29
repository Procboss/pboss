import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";

/**
 * node:cluster mode (owner rule, 2026-09-29).
 *
 *   "When the main runtime is say Bun but an app runtime is Node and it runs
 *    in cluster mode / with instances > 1, we must use the node cluster API —
 *    the script we are targeting is Node and only node clustering clusters a
 *    Node app. Unless the runtime is not stated, in which case the script
 *    inherits the main runtime running it."
 *
 * Two halves, both pinned here:
 *
 *   1. Runtime selection — commandRuntime/inheritMainRuntime (pure) plus the
 *      live resolveScriptInterpreter inheritance (the bun test runner IS a
 *      main-runtime-bun, so an unstated script resolves to this very Bun).
 *
 *   2. The node:cluster wrapper — generated into PBOSS_HOME, syntax-checked
 *      with a real node, and driven end-to-end through the ProcessManager:
 *      one wrapper container, N workers, shared port, respawn, SIGHUP
 *      rolling reload, group teardown on stop. The unstated-runtime case
 *      stays process-based (three containers under the bun main runtime).
 */

// Isolate PBOSS_HOME BEFORE any src module is imported (constants.ts reads
// it at import time) — the wrapper and the dump land in the sandbox, never
// in the developer's real ~/.pboss.
const TEST_HOME = join(tmpdir(), `pboss-test-node-cluster-${process.pid}-${Date.now()}`);
process.env.PBOSS_HOME = TEST_HOME;

const TEST_DIR = join(tmpdir(), `pboss-node-cluster-app-${process.pid}-${Date.now()}`);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 12000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true; // AWAIT: an async cond returns a Promise — truthy regardless of its value
    await sleep(150);
  }
  return await cond();
}
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** The pid a marker file currently holds (NaN while a worker is mid-write). */
const readPid = async (i: number) => {
  try { return Number(await readFile(join(TEST_DIR, `worker-${i}.started`), "utf8")); }
  catch { return NaN; }
};

/** Marker files from a previous test lie — every e2e test starts clean. */
const wipeMarkers = async () => {
  const { readdir, unlink } = await import("fs/promises");
  for (const f of await readdir(TEST_DIR)) {
    if (f.startsWith("worker-")) await unlink(join(TEST_DIR, f)).catch(() => {});
  }
};

/** N distinct, ALIVE worker pids — the only trustworthy "workers are up". */
const workersUp = async (n: number) => {
  const pids = await Promise.all(Array.from({ length: n }, (_, i) => readPid(i)));
  return new Set(pids).size === n && pids.every((p) => alive(p));
};

// src modules are imported with TOP-LEVEL await, AFTER the PBOSS_HOME
// assignment above: constants.ts captures PBOSS_HOME at import time, so the
// wrapper and the dump must land in the sandbox, never in the real ~/.pboss.
const { commandRuntime, inheritMainRuntime, isJsTsFile, resolveScriptInterpreter } =
  await import("../src/install-mode");
const { ensureNodeClusterWrapper, NODE_CLUSTER_WRAPPER_SOURCE, NODE_CLUSTER_WRAPPER_NAME } =
  await import("../src/node-cluster");
const { ClusterManager } = await import("../src/cluster-manager");
const { ProcessManager } = await import("../src/process-manager");

// The node that runs cluster workers — required by the dist suite already.
const NODE_BIN = "node";

// Marker-writing worker app: each worker announces its identity by index and
// its pid, so the tests can see every worker the wrapper forked.
const WORKER_APP = `const fs = require("node:fs");
const path = require("node:path");
const id = process.env.NODE_APP_INSTANCE || "0";
fs.writeFileSync(path.join(__dirname, "worker-" + id + ".started"), String(process.pid));
if (process.env.PORT) fs.writeFileSync(path.join(__dirname, "worker-" + id + ".port"), process.env.PORT);
setInterval(() => {}, 1 << 30);
`;

let TEST_HOME_CREATED = false;

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(join(TEST_DIR, "app.cjs"), WORKER_APP);
  await writeFile(
    join(TEST_DIR, "bun-app.js"),
    "setInterval(() => {}, 1 << 30);\n"
  );
  TEST_HOME_CREATED = true;
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  if (TEST_HOME_CREATED) await rm(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Runtime selection — the pure decision helpers
// ---------------------------------------------------------------------------

describe("commandRuntime: which JS runtime does a command run?", () => {

  test("node in every shape a user or a resolution can produce", () => {
    expect(commandRuntime(["node"])).toBe("node");
    expect(commandRuntime(["/usr/bin/node"])).toBe("node");
    expect(commandRuntime(["/usr/local/bin/node", "--experimental-strip-types"])).toBe("node");
    expect(commandRuntime(["node.exe"])).toBe("node");
    expect(commandRuntime(["C:\\Program Files\\nodejs\\node.exe"])).toBe("node");
    expect(commandRuntime(["nodejs"])).toBe("node");
  });

  test("bun and deno classify too — the other two of the trio", () => {
    expect(commandRuntime(["bun", "run"])).toBe("bun");
    expect(commandRuntime(["/home/u/.bun/bin/bun", "run"])).toBe("bun");
    expect(commandRuntime(["deno", "run", "-A"])).toBe("deno");
    expect(commandRuntime(["/home/u/.deno/bin/deno"])).toBe("deno");
  });

  test("anything else is not one of the three", () => {
    expect(commandRuntime(["python3"])).toBeNull();
    expect(commandRuntime(["none"])).toBeNull();
    expect(commandRuntime(["ruby", "app.rb"])).toBeNull();
    expect(commandRuntime([])).toBeNull();
  });
});

describe("inheritMainRuntime: an unstated runtime inherits the main one", () => {

  test("bun main → [bun, run]", () => {
    expect(inheritMainRuntime("app.ts", { name: "bun", exec: "/usr/local/bin/bun" }, null))
      .toEqual(["/usr/local/bin/bun", "run"]);
  });

  test("deno main → [deno, run, -A]", () => {
    expect(inheritMainRuntime("app.ts", { name: "deno", exec: "/deno/bin/deno" }, null))
      .toEqual(["/deno/bin/deno", "run", "-A"]);
  });

  test("node main: plain for JS, tsx for TS when usable, strip-types otherwise", () => {
    expect(inheritMainRuntime("app.js", { name: "node", exec: "/usr/bin/node" }, null))
      .toEqual(["/usr/bin/node"]);
    const tsx = { cmd: ["/usr/bin/node", "/app/node_modules/tsx/dist/cli.mjs"], source: "app" } as never;
    expect(inheritMainRuntime("app.ts", { name: "node", exec: "/usr/bin/node" }, tsx))
      .toEqual(["/usr/bin/node", "/app/node_modules/tsx/dist/cli.mjs"]);
    expect(inheritMainRuntime("app.ts", { name: "node", exec: "/usr/bin/node" }, null))
      .toEqual(["/usr/bin/node", "--experimental-strip-types"]);
  });

  test("no main runtime (compiled binary) → null — the machine chain takes over", () => {
    expect(inheritMainRuntime("app.js", null, null)).toBeNull();
  });
});

describe("isJsTsFile: only JS/TS can be a node:cluster app", () => {

  test("the buildWorkerCommand extension list", () => {
    for (const f of ["a.js", "a.mjs", "a.cjs", "a.ts", "a.tsx", "a.jsx", "a.mts", "a.cts", "/x/y/z.TS"]) {
      expect(isJsTsFile(f)).toBe(true);
    }
    for (const f of ["a.py", "a.rb", "a.go", "noext", ".js/whatever", "a.exe"]) {
      expect(isJsTsFile(f)).toBe(false);
    }
  });
});

describe("resolveScriptInterpreter (live): the unstated runtime inherits THIS bun", () => {

  test("pboss under bun runs the app with the same bun", async () => {
    // The test runner IS the main runtime: the inheritance rule resolves the
    // app to process.execPath — this very bun — not a PATH search.
    const cmd = await resolveScriptInterpreter("whatever.js");
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd[1]).toBe("run");
  });
});

// ---------------------------------------------------------------------------
// 2. The wrapper asset + the cluster-manager's node-cluster command
// ---------------------------------------------------------------------------

describe("ensureNodeClusterWrapper: the generated primary wrapper", () => {

  test("writes into PBOSS_HOME and rewrites only when the source changes", async () => {
    // Assert against the PBOSS_HOME the src modules actually captured: in a
    // combined `bun test` run another file's static import chain (cluster-
    // manager → utils → constants) may have evaluated constants BEFORE this
    // file's env assignment — the captured home is the truth ensure uses.
    const { PBOSS_HOME } = await import("../src/constants");
    const file = await ensureNodeClusterWrapper();
    expect(file).toBe(join(PBOSS_HOME, NODE_CLUSTER_WRAPPER_NAME));
    expect(existsSync(file)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(NODE_CLUSTER_WRAPPER_SOURCE);
    // idempotent — a second call leaves the file as-is
    expect(await ensureNodeClusterWrapper()).toBe(file);
    expect(await readFile(file, "utf8")).toBe(NODE_CLUSTER_WRAPPER_SOURCE);
  });

  test("the wrapper source pins: real node:cluster, shared port, supervised lifecycle", async () => {
    // setupPrimary with the target + hidden consoles (issue #36 contract)
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("cluster.setupPrimary({ exec: SCRIPT, args: APP_ARGS, windowsHide: true })");
    // worker identity env — the documented conventions
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("NODE_APP_INSTANCE: String(i)");
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("PBOSS_WORKER_ID");
    // the SHARED base port — node:cluster distributes connections, the
    // +workerId offset belongs to the process-based model only
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("...(BASE_PORT !== null ? { PORT: String(BASE_PORT) } : {})");
    // teardown never trusts node's internal dead-marking: pids are tracked
    // and SIGKILLed directly (the leak this fixes)
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("const workerPids = new Set();");
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("killWorkersHard(); process.exit(0);");
    // zero-downtime rolling reload on SIGHUP
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain('"SIGHUP"');
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("next.once(\"online\"");
    // a crashed worker is replaced with backoff
    expect(NODE_CLUSTER_WRAPPER_SOURCE).toContain("respawning in");
  });

  test("node --check: the generated wrapper parses under the real Node", async () => {
    const file = await ensureNodeClusterWrapper();
    const check = spawn(NODE_BIN, ["--check", file], { stdio: "pipe" });
    let err = "";
    check.stderr.on("data", (d) => { err += d.toString(); });
    const code = await new Promise<number>((r) => check.on("exit", (c) => r(c ?? 1)));
    expect([code, err]).toEqual([0, ""]);
  }, 30000);
});

describe("ClusterManager.buildNodeClusterCommand", () => {

  test("a stated node interpreter runs the wrapper under that node", async () => {
    const cm = new ClusterManager();
    const cmd = await cm.buildNodeClusterCommand(
      { script: "app.js", interpreter: "node" } as never,
      "/wrapper.mjs"
    );
    expect(cmd).toEqual(["node", "/wrapper.mjs"]);
  });

  test("interpreter args and nodeArgs land between the node and the wrapper", async () => {
    const cm = new ClusterManager();
    const cmd = await cm.buildNodeClusterCommand(
      { script: "app.js", interpreter: "node", nodeArgs: ["--max-old-space-size=512"] } as never,
      "/wrapper.mjs"
    );
    expect(cmd).toEqual(["node", "--max-old-space-size=512", "/wrapper.mjs"]);
  });

  test("a non-node route fails loudly — never a bun primary for a node app", async () => {
    const cm = new ClusterManager();
    // unstated under the bun test runner resolves to bun — the defensive check
    await expect(
      cm.buildNodeClusterCommand({ script: "app.js" } as never, "/wrapper.mjs")
    ).rejects.toThrow("node:cluster mode requires the app to run under Node");
    // "none"/binary interpreters are not node either
    await expect(
      cm.buildNodeClusterCommand({ script: "svc", interpreter: "none" } as never, "/wrapper.mjs")
    ).rejects.toThrow("node:cluster mode requires the app to run under Node");
  });
});

// ---------------------------------------------------------------------------
// 3. End to end through the ProcessManager
// ---------------------------------------------------------------------------

describe("node:cluster apps through the ProcessManager (real wrapper, real workers)", () => {

  test("interpreter node + instances 3 → ONE wrapper container, three workers, shared port", async () => {
    const pm = new ProcessManager();
    await wipeMarkers();
    const states = await pm.start({
      name: "nodeapi",
      script: join(TEST_DIR, "app.cjs"),
      cwd: TEST_DIR,
      instances: 3,
      interpreter: "node",
      port: 4567,
    });

    // ONE container — the wrapper. No -0/-1/-2 siblings.
    expect(states.length).toBe(1);
    expect(states[0]!.name).toBe("nodeapi");
    expect((pm as any).processes.get(states[0]!.id).config.nodeCluster).toBe(true);
    expect((pm as any).processes.get(states[0]!.id).config.instances).toBe(3);

    // three workers, each writing its marker with its NODE_APP_INSTANCE
    const spawned = await until(() => workersUp(3));
    expect(spawned).toBe(true);
    const pids = await Promise.all([readPid(0), readPid(1), readPid(2)]);
    expect(new Set(pids).size).toBe(3);

    // the shared port: every worker sees the SAME base port (node:cluster
    // distributes connections — the whole point of the model)
    const ports = [0, 1, 2].map((i) => readFile(join(TEST_DIR, `worker-${i}.port`), "utf8"));
    for (const p of await Promise.all(ports)) expect(Number(p)).toBe(4567);

    // the wrapper is the container's pid — a single supervised process
    const wrapperPid = states[0]!.pid;
    expect(alive(wrapperPid)).toBe(true);

    // stop: the whole group dies with it — workers AND wrapper
    await pm.stop("nodeapi");
    const workersGone = await until(() => !pids.some((p) => alive(p)));
    expect(workersGone).toBe(true);
    expect(alive(wrapperPid)).toBe(false);

    await pm.deleteAll();
  }, 60000);

  test("a crashed worker respawns without touching pboss's restart accounting", async () => {
    const pm = new ProcessManager();
    await wipeMarkers();
    const states = await pm.start({
      name: "nodeapi2",
      script: join(TEST_DIR, "app.cjs"),
      cwd: TEST_DIR,
      instances: 2,
      interpreter: "node",
    });
    expect(states.length).toBe(1);

    await until(() => workersUp(2));
    const pid0 = await readPid(0);

    // SIGKILL one worker — the wrapper replaces it, the container stays online
    process.kill(pid0, "SIGKILL");
    const replaced = await until(async () => (await readPid(0)) !== pid0 && !Number.isNaN(await readPid(0)), 15000);
    expect(replaced).toBe(true);
    const newPid = await readPid(0);
    expect(alive(newPid)).toBe(true);

    const container = (pm as any).processes.get(states[0]!.id);
    expect(container.status).toBe("online");
    expect(container.restartCount).toBe(0); // wrapper-level restarts only

    await pm.stop("nodeapi2");
    const pid1 = await readPid(1);
    await until(async () => !alive(newPid) && !alive(pid1));
    await pm.deleteAll();
  }, 60000);

  test("SIGHUP rolls the workers with zero downtime", async () => {
    const pm = new ProcessManager();
    await wipeMarkers();
    const states = await pm.start({
      name: "nodeapi3",
      script: join(TEST_DIR, "app.cjs"),
      cwd: TEST_DIR,
      instances: 2,
      interpreter: "node",
    });
    expect(states.length).toBe(1);

    await until(() => workersUp(2));
    const before = await Promise.all([readPid(0), readPid(1)]);

    process.kill(states[0]!.pid!, "SIGHUP");
    const rotated = await until(
      async () => (await readPid(0)) !== before[0] && (await readPid(1)) !== before[1],
      20000
    );
    expect(rotated).toBe(true);
    const after = await Promise.all([readPid(0), readPid(1)]);
    expect(after.every((p) => alive(p))).toBe(true); // never fewer than N workers

    await pm.stop("nodeapi3");
    await until(() => !after.some((p) => alive(p)));
    await pm.deleteAll();
  }, 60000);

  test("re-start with a different --instances resizes the ONE container, no siblings", async () => {
    const pm = new ProcessManager();
    await wipeMarkers();
    await pm.start({
      name: "nodeapi4",
      script: join(TEST_DIR, "app.cjs"),
      cwd: TEST_DIR,
      instances: 2,
      interpreter: "node",
    });
    await until(() => workersUp(2));

    const again = await pm.start({
      name: "nodeapi4",
      script: join(TEST_DIR, "app.cjs"),
      cwd: TEST_DIR,
      instances: 4,
      interpreter: "node",
    });

    // still exactly one container for the app — resized, not appended
    expect(again.length).toBe(1);
    const list = pm.list().filter((p) => p.name === "nodeapi4");
    expect(list.length).toBe(1);
    const cfg = (pm as any).processes.get(list[0]!.id).config;
    expect(cfg.instances).toBe(4);

    const fourUp = await until(() => workersUp(4), 20000);
    expect(fourUp).toBe(true);

    await pm.stop("nodeapi4");
    await pm.deleteAll();
  }, 60000);

  test("unstated runtime under the bun main runtime stays process-based — three containers", async () => {
    const pm = new ProcessManager();
    await wipeMarkers();
    const states = await pm.start({
      name: "bunapp",
      script: join(TEST_DIR, "bun-app.js"),
      cwd: TEST_DIR,
      instances: 3,
    });

    // The unstated runtime inherits the main runtime (bun here) — NOT node,
    // so the app keeps the per-instance process model: three containers.
    expect(states.length).toBe(3);
    expect(states.map((s) => s.name).sort()).toEqual(["bunapp-0", "bunapp-1", "bunapp-2"]);
    for (const s of states) {
      expect((pm as any).processes.get(s.id).config.nodeCluster).toBeUndefined();
    }

    await pm.stop("bunapp");
    await pm.deleteAll();
  }, 60000);
});
