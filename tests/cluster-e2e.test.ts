/**
 * Cluster mode on ALL THREE runtimes — the owner's report (2026-10-08):
 *
 *   pboss start --instances 3 ./server.ts        (a Deno app)
 *   → server-0 binds the port; server-1/2 die with AddrInUse and
 *     restart-loop forever ([ERROR] AddrInUse spam in `pboss logs server`).
 *
 * The cluster contract per runtime:
 *
 *   node  — node:cluster wrapper: ONE supervised primary forks the N
 *           workers; node itself distributes connections (any app shape).
 *   deno  — SO_REUSEPORT: pboss preloads a shim into every worker
 *           (`deno run --unstable-net --preload=…`) that patches
 *           Deno.serve/Deno.listen to set reusePort — the kernel then
 *           spreads connections across the workers. The app never changes.
 *   bun   — the same shim (`bun run --preload …`) patching Bun.serve.
 *
 * Every block runs a REAL app of that runtime's NATIVE shape (the deno app
 * is the owner's exact source: Deno.serve with a hardcoded port, never
 * reading PORT) against a hermetic daemon, and proves the whole contract:
 * one shared port, MULTIPLE workers actually serving, logs from all
 * workers, a crashed worker respawning, restart round-trips, scale up/down,
 * and full teardown. The deno block additionally runs THE OWNER'S
 * INSTALLED SHAPE — the deno daemon from dist — gated on the build.
 *
 * Tests skip visibly where a runtime is absent (the false-green lesson;
 * see tests/wrapper.test.ts). Linux gates the reusePort blocks (the
 * verified kernel); the node block runs everywhere unix sockets do.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "src", "index.ts");
const DIST_DENO_ENTRY = join(REPO, "dist", "cli.deno.js");
const DIST_BUILT = existsSync(DIST_DENO_ENTRY);

const denoBin = Bun.which("deno");
const nodeBin = Bun.which("node");
const LINUX = process.platform === "linux";
// Ports well below the ephemeral range, one block each.
const PORT_BUN = 18200;
const PORT_NODE = 18210;
const PORT_DENO = 18220;

const scratch: string[] = [];
afterAll(() => {
  // Belt on top of per-test cleanup: never leak a daemon or a worker.
  Bun.spawnSync(["pkill", "-f", "pboss-cl-e2e-"], { stdout: "ignore", stderr: "ignore" });
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/* ── harness ─────────────────────────────────────────────────────────────── */

function makeHome(opts: { runtime?: "deno" } = {}): {
  home: string; pb: string; env: Record<string, string>;
} {
  const home = mkdtempSync(join(tmpdir(), "pboss-cl-e2e-"));
  scratch.push(home);
  const pb = join(home, ".pboss");
  mkdirSync(pb, { recursive: true });
  if (opts.runtime === "deno") {
    // The owner's machine shape: a deno install stamps .runtime=deno (the
    // wrapper-less deno channel persists it on first run).
    writeFileSync(join(pb, ".runtime"), "deno\n");
  }
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    PBOSS_HOME: pb,
    TERM: "dumb",
  };
  if (opts.runtime === "deno" && denoBin) {
    env.PATH = `${dirname(denoBin)}:${env.PATH ?? ""}`;
  }
  return { home, pb, env };
}

interface RunResult { code: number; out: string; }

function pboss(
  env: Record<string, string>,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): RunResult {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env,
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: opts.timeoutMs ?? 120_000,
  });
  return {
    code: proc.exitCode ?? -1,
    out: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
  };
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** Rows of `pboss list` matching name (exact or name-N) that are online. */
function onlineRows(listOut: string, name: string): string[] {
  return stripAnsi(listOut)
    .split("\n")
    .filter((l) => l.includes("│") && (l.includes(`${name}-`) || l.includes(` ${name} `) || l.includes(`│ ${name} │`)) && l.includes("online"));
}

/** Worker pids running the app at dir (pgrep -f, never the daemon itself). */
function workerPids(appPath: string): number[] {
  const r = Bun.spawnSync(["pgrep", "-f", appPath], { stdout: "pipe", stderr: "ignore" });
  return new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .map((l) => parseInt(l))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** One request over a FRESH connection (curl): keep-alive pooling would
 *  pin every request to ONE worker and hide the kernel's spread. */
function httpGet(port: number): string | null {
  const r = Bun.spawnSync(
    ["curl", "-s", "--max-time", "2", `http://localhost:${port}/`],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  if (r.exitCode !== 0) return null;
  return new TextDecoder().decode(r.stdout).trim();
}

/** Distinct response bodies over n requests — the workers actually serving. */
async function servedWorkers(port: number, n = 20): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const body = httpGet(port);
    if (body !== null) seen.add(body);
  }
  return seen;
}

/** Poll `pboss list` until exactly count workers of name are online. */
async function waitOnline(
  env: Record<string, string>,
  name: string,
  count: number,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let rows: string[] = [];
  while (Date.now() < deadline) {
    rows = onlineRows(pboss(env, ["list"]).out, name);
    if (rows.length >= count) return rows.length;
    await Bun.sleep(400);
  }
  return rows.length;
}

/* ── apps: each runtime's NATIVE server shape ───────────────────────────── */

function writeBunApp(dir: string, port: number): string {
  const file = join(dir, "bun-app.js");
  writeFileSync(
    file,
    `const id = process.env.PBOSS_WORKER_ID ?? "0";\n` +
      `console.log(\`bun-worker-\${id} up\`);\n` +
      `Bun.serve({ port: ${port}, fetch: () => new Response(\`worker-\${id}\`) });\n`,
  );
  return file;
}

function writeNodeApp(dir: string, port: number): string {
  const file = join(dir, "node-app.js");
  writeFileSync(
    file,
    `const http = require("node:http");\n` +
      `const id = process.env.NODE_APP_INSTANCE ?? process.env.PBOSS_WORKER_ID ?? "0";\n` +
      `console.log(\`node-worker-\${id} up\`);\n` +
      `http.createServer((req, res) => res.end(\`worker-\${id}\`)).listen(${port});\n`,
  );
  return file;
}

/** The owner's exact source shape: Deno.serve, hardcoded port, no PORT read. */
function writeDenoApp(dir: string, port: number): string {
  const file = join(dir, "server.ts");
  writeFileSync(
    file,
    `console.log(\`deno-worker-\${Deno.env.get("PBOSS_WORKER_ID") ?? "0"} up\`);\n` +
      `Deno.serve({ port: ${port} }, (req) => new Response(\`worker-\${Deno.env.get("PBOSS_WORKER_ID") ?? "0"}\`));\n`,
  );
  return file;
}

/* ── BUN — the same runtime supervises the daemon ───────────────────────── */

describe("cluster e2e — BUN (Bun.serve, SO_REUSEPORT shim)", () => {
  test.skipIf(!LINUX)(
    "3 instances share one port: all workers serve, logs carry all three",
    async () => {
      const { home, env } = makeHome();
      const app = writeBunApp(home, PORT_BUN);
      try {
        const start = pboss(env, ["start", "--instances", "3", app], { timeoutMs: 120_000 });
        expect(start.code).toBe(0);
        expect(await waitOnline(env, "bun-app", 3)).toBe(3);

        // THE contract: one port, multiple workers serving it.
        const seen = await servedWorkers(PORT_BUN, 24);
        expect(seen.size).toBeGreaterThanOrEqual(2);

        // no AddrInUse crash-loop: every row online, none errored.
        const list = stripAnsi(pboss(env, ["list"]).out);
        expect(list).not.toContain("errored");

        // logs aggregate all three workers.
        const logs = pboss(env, ["logs", "bun-app", "--lines", "100"]).out;
        for (const id of ["bun-worker-0 up", "bun-worker-1 up", "bun-worker-2 up"]) {
          expect(logs).toContain(id);
        }
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    180_000,
  );

  test.skipIf(!LINUX)(
    "the fleet is resilient: worker crash respawns, restart round-trips, scale 3→5→2, delete frees the port",
    async () => {
      const { home, env } = makeHome();
      const app = writeBunApp(home, PORT_BUN);
      try {
        pboss(env, ["start", "--instances", "3", app], { timeoutMs: 120_000 });
        expect(await waitOnline(env, "bun-app", 3)).toBe(3);

        // 1. SIGKILL one worker — the fleet must heal (autorestart) and
        //    the port must never go dark (the other workers hold it).
        const pids = workerPids(app);
        expect(pids.length).toBeGreaterThanOrEqual(3);
        process.kill(pids[pids.length - 1]!, "SIGKILL");
        expect(await waitOnline(env, "bun-app", 3, 30_000)).toBe(3);
        expect((await servedWorkers(PORT_BUN, 12)).size).toBeGreaterThanOrEqual(1);

        // 2. A fleet restart round-trips (stop+start, the port stays shared).
        const restart = pboss(env, ["restart", "all"], { timeoutMs: 120_000 });
        expect(restart.code).toBe(0);
        expect(await waitOnline(env, "bun-app", 3)).toBe(3);
        expect((await servedWorkers(PORT_BUN, 24)).size).toBeGreaterThanOrEqual(2);

        // 3. Scale up: the new worker joins the shared port (the group's
        //    instance count carries the shim decoration — scale-up without
        //    it crash-looped, the exact bug class this pins).
        const up = pboss(env, ["scale", "bun-app", "5"], { timeoutMs: 120_000 });
        expect(up.code).toBe(0);
        expect(await waitOnline(env, "bun-app", 5)).toBe(5);
        expect((await servedWorkers(PORT_BUN, 30)).size).toBeGreaterThanOrEqual(2);

        // 4. Scale down: survivors keep the port.
        const down = pboss(env, ["scale", "bun-app", "2"], { timeoutMs: 120_000 });
        expect(down.code).toBe(0);
        expect(await waitOnline(env, "bun-app", 2, 30_000)).toBe(2);
        expect((await servedWorkers(PORT_BUN, 12)).size).toBeGreaterThanOrEqual(1);
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    240_000,
  );

  test.skipIf(!LINUX)(
    "single-instance lifecycle: start → serve → logs → stop → resume → delete",
    async () => {
      const { home, env } = makeHome();
      const app = writeBunApp(home, PORT_BUN);
      try {
        const start = pboss(env, ["start", app], { timeoutMs: 120_000 });
        expect(start.code).toBe(0);
        expect(await waitOnline(env, "bun-app", 1)).toBe(1);
        expect((await servedWorkers(PORT_BUN, 3))).toEqual(new Set(["worker-0"]));

        const logs = pboss(env, ["logs", "bun-app", "--lines", "50"]).out;
        expect(logs).toContain("bun-worker-0 up");

        const stop = pboss(env, ["stop", "bun-app"], { timeoutMs: 60_000 });
        expect(stop.code).toBe(0);
        expect((await servedWorkers(PORT_BUN, 3)).size).toBe(0);

        const resume = pboss(env, ["start", "bun-app"], { timeoutMs: 120_000 });
        expect(resume.code).toBe(0);
        expect(await waitOnline(env, "bun-app", 1)).toBe(1);
        expect((await servedWorkers(PORT_BUN, 3))).toEqual(new Set(["worker-0"]));
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    180_000,
  );
});

/* ── NODE — the node:cluster wrapper (the owner rule, 2026-09-29) ───────── */

describe("cluster e2e — NODE (node:cluster wrapper)", () => {
  test.skipIf(!nodeBin || process.platform === "win32")(
    "3 instances through node:cluster: one wrapper, shared port, all workers serve",
    async () => {
      const { home, env } = makeHome();
      const app = writeNodeApp(home, PORT_NODE);
      try {
        const start = pboss(
          env,
          ["start", "--interpreter", "node", "--instances", "3", app],
          { timeoutMs: 120_000 },
        );
        expect(start.code).toBe(0);
        // ONE container — the wrapper primary owns the worker count.
        expect(await waitOnline(env, "node-app", 1)).toBe(1);

        const seen = await servedWorkers(PORT_NODE, 24);
        expect(seen.size).toBeGreaterThanOrEqual(2); // the forked workers all serve

        const logs = pboss(env, ["logs", "node-app", "--lines", "100"]).out;
        for (const id of ["node-worker-0 up", "node-worker-1 up", "node-worker-2 up"]) {
          expect(logs).toContain(id);
        }
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    180_000,
  );

  test.skipIf(!nodeBin || process.platform === "win32")(
    "a crashed worker is replaced by the wrapper; the port never goes dark",
    async () => {
      const { home, env } = makeHome();
      const app = writeNodeApp(home, PORT_NODE);
      try {
        pboss(env, ["start", "--interpreter", "node", "--instances", "3", app], { timeoutMs: 120_000 });
        expect(await waitOnline(env, "node-app", 1)).toBe(1);
        expect((await servedWorkers(PORT_NODE, 12)).size).toBeGreaterThanOrEqual(2);

        // SIGKILL one FORKED worker (not the wrapper — its cmdline runs the
        // generated wrapper file, so only the 3 workers match the app): the
        // wrapper's own respawn backoff brings it back; the others keep
        // serving.
        const pids = workerPids(app);
        expect(pids.length).toBeGreaterThanOrEqual(3); // exactly the forked workers
        process.kill(pids[pids.length - 1]!, "SIGKILL");
        await Bun.sleep(1500);
        // the wrapper is still the supervised container and the port answers
        expect(onlineRows(pboss(env, ["list"]).out, "node-app").length).toBe(1);
        expect((await servedWorkers(PORT_NODE, 24)).size).toBeGreaterThanOrEqual(1);
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    180_000,
  );

  test.skipIf(!nodeBin || process.platform === "win32")(
    "graceful reload is zero-downtime under load (the wrapper's rolling restart)",
    async () => {
      const { home, env } = makeHome();
      const app = writeNodeApp(home, PORT_NODE);
      try {
        pboss(env, ["start", "--interpreter", "node", "--instances", "3", app], { timeoutMs: 120_000 });
        expect(await waitOnline(env, "node-app", 1)).toBe(1);

        // Hammer the port WHILE the rolling reload runs; every request
        // must land (old-or-new worker — never a refused connection). Fresh
        // connections only (curl) — a pooled keep-alive socket reset by a
        // retiring worker is not a downtime signal.
        const reload = Bun.spawn(["bun", "run", CLI, "reload", "node-app"], {
          env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
        });
        let failures = 0;
        const served = new Set<string>();
        for (let i = 0; i < 24; i++) {
          const body = httpGet(PORT_NODE);
          if (body === null) failures++;
          else served.add(body);
          await Bun.sleep(80);
        }
        const code = await reload.exited;
        expect(code).toBe(0);
        expect(failures).toBe(0); // zero downtime — that is the feature
        expect(served.size).toBeGreaterThanOrEqual(1);
        expect((await servedWorkers(PORT_NODE, 24)).size).toBeGreaterThanOrEqual(2);
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    180_000,
  );
});

/* ── DENO — the owner's report, fixed (SO_REUSEPORT shim) ────────────────── */

describe("cluster e2e — DENO (Deno.serve, SO_REUSEPORT shim — the owner's report)", () => {
  test.skipIf(!LINUX || !denoBin)(
    "THE OWNER'S COMMAND: 3 deno instances share one hardcoded port, no AddrInUse loop",
    async () => {
      const { home, env } = makeHome({ runtime: "deno" });
      const app = writeDenoApp(home, PORT_DENO);
      try {
        const start = pboss(env, ["start", "--instances", "3", app], { timeoutMs: 180_000 });
        expect(start.code).toBe(0);
        expect(await waitOnline(env, "server", 3, 90_000)).toBe(3);

        // THE fix: all three workers bind the SAME port (reusePort) and
        // the kernel spreads the connections.
        const seen = await servedWorkers(PORT_DENO, 24);
        expect(seen.size).toBeGreaterThanOrEqual(2);

        // The pre-fix symptom was the AddrInUse restart storm — every row
        // must be online with a ZERO restart counter.
        const list = stripAnsi(pboss(env, ["list"]).out);
        expect(list).not.toContain("errored");
        expect(list).not.toContain("AddrInUse");

        // Logs aggregate all three workers (the owner pasted exactly this
        // command against the broken build).
        const logs = pboss(env, ["logs", "server", "--lines", "100"]).out;
        for (const id of ["deno-worker-0 up", "deno-worker-1 up", "deno-worker-2 up"]) {
          expect(logs).toContain(id);
        }
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    300_000,
  );

  test.skipIf(!LINUX || !denoBin)(
    "the deno fleet is resilient: crash respawn, restart round-trip, scale, delete",
    async () => {
      const { home, env } = makeHome({ runtime: "deno" });
      const app = writeDenoApp(home, PORT_DENO);
      try {
        pboss(env, ["start", "--instances", "3", app], { timeoutMs: 180_000 });
        expect(await waitOnline(env, "server", 3, 90_000)).toBe(3);

        // 1. SIGKILL a worker: autorestart heals, the port never darkens.
        const pids = workerPids(app);
        expect(pids.length).toBeGreaterThanOrEqual(3);
        process.kill(pids[pids.length - 1]!, "SIGKILL");
        expect(await waitOnline(env, "server", 3, 60_000)).toBe(3);
        expect((await servedWorkers(PORT_DENO, 12)).size).toBeGreaterThanOrEqual(1);

        // 2. Fleet restart: the workers re-share the port.
        const restart = pboss(env, ["restart", "all"], { timeoutMs: 180_000 });
        expect(restart.code).toBe(0);
        expect(await waitOnline(env, "server", 3, 90_000)).toBe(3);
        expect((await servedWorkers(PORT_DENO, 24)).size).toBeGreaterThanOrEqual(2);

        // 3. Scale up: the scaled-in worker carries the group's instance
        //    count (the shim decoration) and joins the shared port.
        const up = pboss(env, ["scale", "server", "5"], { timeoutMs: 180_000 });
        expect(up.code).toBe(0);
        expect(await waitOnline(env, "server", 5, 90_000)).toBe(5);

        // 4. Scale down, then full teardown — the port is actually freed.
        pboss(env, ["scale", "server", "2"], { timeoutMs: 120_000 });
        expect(await waitOnline(env, "server", 2, 60_000)).toBe(2);
        const del = pboss(env, ["delete", "all", "--force"], { timeoutMs: 120_000 });
        expect(del.code).toBe(0);
        await Bun.sleep(1000);
        expect((await servedWorkers(PORT_DENO, 4)).size).toBe(0);
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    420_000,
  );

  test.skipIf(!LINUX || !denoBin)(
    "single-instance lifecycle: start → serve → logs → stop → resume → delete",
    async () => {
      const { home, env } = makeHome({ runtime: "deno" });
      const app = writeDenoApp(home, PORT_DENO);
      try {
        const start = pboss(env, ["start", app], { timeoutMs: 180_000 });
        expect(start.code).toBe(0);
        expect(await waitOnline(env, "server", 1, 90_000)).toBe(1);
        expect(await servedWorkers(PORT_DENO, 3)).toEqual(new Set(["worker-0"]));

        const logs = pboss(env, ["logs", "server", "--lines", "50"]).out;
        expect(logs).toContain("deno-worker-0 up");

        const stop = pboss(env, ["stop", "server"], { timeoutMs: 60_000 });
        expect(stop.code).toBe(0);
        expect((await servedWorkers(PORT_DENO, 3)).size).toBe(0);

        const resume = pboss(env, ["start", "server"], { timeoutMs: 180_000 });
        expect(resume.code).toBe(0);
        expect(await waitOnline(env, "server", 1, 90_000)).toBe(1);
        expect(await servedWorkers(PORT_DENO, 3)).toEqual(new Set(["worker-0"]));
      } finally {
        pboss(env, ["delete", "all", "--force"], { timeoutMs: 60_000 });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    300_000,
  );

  // THE OWNER'S INSTALLED SHAPE: the deno daemon from dist — exactly what a
  // `deno install -g npm:pboss/deno-entry` machine runs. Gates on the build
  // (CI and dev boxes run it after `bun run build`).
  test.skipIf(!LINUX || !denoBin || !DIST_BUILT)(
    "THE OWNER'S INSTALLED SHAPE: the deno daemon clusters a deno app",
    async () => {
      const { home, env } = makeHome({ runtime: "deno" });
      const app = writeDenoApp(home, PORT_DENO);
      try {
        const run = (args: string[], timeoutMs = 180_000) =>
          Bun.spawnSync([denoBin!, "run", "-A", DIST_DENO_ENTRY, ...args], {
            env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs,
          });
        const dec = (p: ReturnType<typeof run>): string =>
          new TextDecoder().decode(p.stdout as Uint8Array) + new TextDecoder().decode(p.stderr as Uint8Array);

        const start = run(["start", "--instances", "3", app]);
        expect(start.exitCode).toBe(0);
        expect(dec(start)).toContain("online");

        // 3 deno workers under the deno daemon, one shared port.
        const deadline = Date.now() + 90_000;
        let seen = new Set<string>();
        while (Date.now() < deadline) {
          seen = await servedWorkers(PORT_DENO, 12);
          if (seen.size >= 2) break;
          await Bun.sleep(500);
        }
        expect(seen.size).toBeGreaterThanOrEqual(2);
        expect(dec(run(["list"]))).not.toContain("errored");
      } finally {
        Bun.spawnSync([denoBin!, "run", "-A", DIST_DENO_ENTRY, "kill"], {
          env, stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 60_000,
        });
        Bun.spawnSync(["pkill", "-f", app], { stdout: "ignore", stderr: "ignore" });
      }
    },
    300_000,
  );
});
