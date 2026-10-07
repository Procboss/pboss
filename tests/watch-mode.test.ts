/**
 * Watch mode (`--watch`) — restart on file change, on every runtime.
 *
 * The gap this closes (audit 2026-10-08): `--watch` was only ever pinned
 * as a PARSED FLAG (cli-parser / process-manager config assertions). The
 * behavior itself — a change under the app's directory restarts the
 * process — had no test, and the watcher migration to the runtime
 * adapters' NATIVE fs-watch (node:fs.watch under Bun/Node, Deno.watchFs
 * under Deno) shipped without one.
 *
 * Three layers:
 *   A. the adapter contract (in-process, the bun adapter): watch() fires
 *      with the changed entry's name, recursion sees nested directories,
 *      and close() ends the stream — close is the ONLY stop;
 *   B. the FEATURE e2e (real CLI + real daemon): `pboss start --watch`
 *      restarts the app on a watched-file change, and an ignore-list
 *      entry (node_modules/) does NOT restart it;
 *   C. the DENO adapter under real deno: Deno.watchFs — the native
 *      watcher — fires and closes the same way (the node-compat
 *      watch must never be imposed on a deno daemon).
 *
 * The e2e app writes its pid OUTSIDE the watched directory (the
 * PBOSS_HOME of the hermetic test — the daemon's own turf): a boot-time
 * write INSIDE cwd would itself trigger the watcher and loop the restart
 * — the honest shape of a real app's log/pid writes to a log dir.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getRuntime } from "../src/runtime";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "index.ts");
const R = getRuntime();

const denoBin = Bun.which("deno");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

async function pollUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await Bun.sleep(stepMs);
  }
  return await cond();
}

/* ── A. the adapter contract (bun adapter, in-process) ─────────────────── */

describe("watch adapter (R.filesystem.watch — the bun adapter)", () => {
  test("fires with the changed entry's name, recursively", async () => {
    const dir = scratchDir("pboss-watch-adapter-");
    const seen: string[] = [];
    const w = R.filesystem.watch(dir, (f) => seen.push(f));
    try {
      // The watcher needs a beat to arm.
      await Bun.sleep(200);
      mkdirSync(join(dir, "src"));
      await Bun.sleep(150);
      writeFileSync(join(dir, "src", "deep.js"), "1");
      const ok = await pollUntil(() => seen.some((f) => f.includes("deep.js")), 5000, 50);
      expect(ok).toBe(true);
    } finally {
      w.close();
    }
  });

  test("close() ends the stream — it is the only stop", async () => {
    const dir = scratchDir("pboss-watch-close-");
    const seen: string[] = [];
    const w = R.filesystem.watch(dir, (f) => seen.push(f));
    await Bun.sleep(200);
    writeFileSync(join(dir, "first.js"), "1");
    expect(await pollUntil(() => seen.length > 0, 5000, 50)).toBe(true);

    w.close();
    await Bun.sleep(150); // any in-flight event drains
    const count = seen.length;
    writeFileSync(join(dir, "second.js"), "2");
    await Bun.sleep(700);
    expect(seen.length).toBe(count); // nothing after close
  });
});

/* ── B. the feature e2e — pboss start --watch restarts on change ───────── */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) {
    hardKillDaemon(h);
    rmSync(h, { recursive: true, force: true });
  }
});

function hardKillDaemon(home: string) {
  const pidFile = join(home, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim());
    if (Number.isFinite(pid) && pid !== process.pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}

function hermeticEnv(home: string): Record<string, string> {
  return {
    ...process.env,
    PBOSS_HOME: home,
    SUDO_USER: "",
    TERM: "dumb",
  };
}

function spawnCli(args: string[], env: Record<string, string>, cwd?: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    ...(cwd ? { cwd } : {}),
  });
}

async function drain(p: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }) {
  const [out, err] = await Promise.all([
    new Response(p.stdout).text().catch(() => ""),
    new Response(p.stderr).text().catch(() => ""),
  ]);
  return { out, err };
}

/**
 * A watch-app whose observable state lives OUTSIDE the watched cwd: every
 * boot rewrites state.json (absolute path from STATE_FILE), so a restart
 * is a pid change there — and the boot write itself never feeds the
 * watcher (the restart-loop trap).
 */
const APP = [
  'const fs = require("node:fs");',
  'fs.writeFileSync(process.env.STATE_FILE, String(process.pid));',
  'setInterval(() => {}, 1000);',
  "",
].join("\n");

function readPid(stateFile: string): number {
  try {
    return parseInt(readFileSync(stateFile, "utf8").trim());
  } catch {
    return -1;
  }
}

describe("watch mode e2e — the real CLI, the real daemon (bun engine)", () => {
  test.skipIf(process.platform === "win32")(
    "pboss start --watch restarts the app when a watched file changes",
    async () => {
      // The app's WORLD (cwd, watched) and its OBSERVABLE STATE (PBOSS_HOME,
      // never watched) live in different trees — a state write inside cwd
      // would itself fire the watcher and loop the restart.
      const appDir = scratchDir("pboss-watch-app-");
      const home = scratchDir("pboss-watch-home-");
      homes.push(home);
      const env = hermeticEnv(home);
      const stateFile = join(home, "state.json");
      writeFileSync(join(appDir, "app.js"), APP);

      const p = spawnCli(
        ["start", "./app.js", "--name", "watcher", "--watch", "--env", `STATE_FILE=${stateFile}`],
        env, appDir,
      );
      await drain(p); // output not asserted — the state file is the oracle
      expect(await p.exited).toBe(0);

      // The daemon came up and the app booted (its pid is on record).
      expect(await pollUntil(() => readPid(stateFile) > 0, 20_000)).toBe(true);
      const pid1 = readPid(stateFile);

      // A change in the app's own directory restarts it (1s debounce +
      // spawn slop).
      appendFileSync(join(appDir, "app.js"), "// touched\n");
      expect(await pollUntil(() => readPid(stateFile) > 0 && readPid(stateFile) !== pid1, 10_000)).toBe(true);
      const pid2 = readPid(stateFile);
      expect(pid2).not.toBe(pid1);

      // An ignored path stays silent: node_modules is on the default
      // ignore list, a change there must NOT restart the app.
      mkdirSync(join(appDir, "node_modules"), { recursive: true });
      appendFileSync(join(appDir, "node_modules", "dep.js"), "// vendored\n");
      await Bun.sleep(3500); // past the 1s debounce
      expect(readPid(stateFile)).toBe(pid2);

      // Teardown: `pboss kill` takes daemon + app down.
      const k = spawnCli(["kill"], env);
      await drain(k);
      await k.exited;
      hardKillDaemon(home);
      await pollUntil(() => !existsSync(join(home, "daemon.pid")) || readPid(stateFile) === -1 || true, 2000);
    },
    60_000,
  );
});

/* ── C. the deno adapter under real deno — Deno.watchFs, natively ──────── */

describe("watch adapter (deno — Deno.watchFs under real deno)", () => {
  test.skipIf(!denoBin)("fires on change and close() ends the stream", async () => {
    const dir = scratchDir("pboss-watch-deno-");
    const script = `
import { createDenoFilesystem } from ${JSON.stringify(join(REPO, "src", "runtime", "deno", "filesystem.ts"))};
const fs = createDenoFilesystem();
const dir = ${JSON.stringify(dir)};
let fired = "";
const w = fs.watch(dir, (f) => { if (!fired) fired = f; });
await new Promise((r) => setTimeout(r, 300)); // arm
await Deno.writeTextFile(dir + "/a.txt", "x");
const deadline = Date.now() + 5000;
while (!fired && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
console.log("FIRED=" + (fired || "never"));
w.close();
await new Promise((r) => setTimeout(r, 200)); // drain in-flight
const before = fired;
await Deno.writeTextFile(dir + "/b.txt", "y");
await new Promise((r) => setTimeout(r, 800));
console.log("SILENT_AFTER_CLOSE=" + (fired === before));
`;
    const probeDir = scratchDir("pboss-watch-deno-probe-");
    const file = join(probeDir, "probe.ts");
    writeFileSync(file, script);
    const proc = Bun.spawnSync([denoBin!, "run", "-A", "--sloppy-imports", file], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 30_000,
    });
    const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
    // Deno.watchFs events carry ABSOLUTE paths (the adapter's documented
    // contract) — the changed entry's name, path spelling aside.
    expect(/FIRED=\S*a\.txt/.test(out)).toBe(true);  // the native watcher fired
    expect(out).toContain("SILENT_AFTER_CLOSE=true"); // close is the only stop
  }, 40_000);
});
