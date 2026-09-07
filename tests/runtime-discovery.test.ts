/**
 * Runtime discovery — the "bun exists but pboss cannot find it" incident,
 * pinned end-to-end.
 *
 * The reported bug: on Ubuntu with Bun installed at ~/.bun/bin (the default
 * `curl bun.sh/install` location), `pboss start ./index.ts` failed with
 * "the Bun runtime was not found on this system" even though `which bun`
 * found it. Root cause: worker spawns go through the DAEMON, and a daemon
 * started by the systemd unit runs with the unit's minimal PATH —
 * `Bun.which("bun")` (PATH-only) found nothing there, and ~/.bun/bin was
 * never consulted.
 *
 * The contract under test:
 *   1. findBun() falls back through $BUN_INSTALL, <home>/.bun/bin and the
 *      well-known system locations when PATH has no bun (daemon context).
 *   2. A daemon running with a systemd-style PATH + HOME still spawns
 *      .ts workers, using the absolute bun it discovered via ~/.bun/bin.
 *   3. enrichPathWithBun() prepends the discovered bun dir to a PATH that
 *      lacks it, and is a no-op when it is already present.
 *   4. The CLI's first-start persistence hint is TTY-gated: piped output
 *      stays clean for scripts and parsers.
 *
 * All subprocesses run with EXPLICIT controlled environments (PATH/HOME/
 * BUN_INSTALL) — Bun.which resolves from the spawn-time env, so this is
 * the only faithful way to reproduce the daemon's view of the world.
 *
 * PBOSS_HOME is isolated BEFORE any src import (constants.ts resolves it
 * at import time — the same pattern as persistence.test.ts): the in-process
 * API client binds to TEST_HOME, and every daemon spawned here uses it.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const DAEMON = join(ROOT, "src", "daemon.ts");
const CLI = join(ROOT, "src", "index.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-runtimedisc-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;

/**
 * The BOUND PBOSS_HOME — NOT necessarily TEST_HOME.
 *
 * `bun test` shares module registries across test files: constants.ts
 * binds PBOSS_HOME exactly once, for whichever file loaded first (e.g.
 * persistence.test.ts under the full suite). Setting process.env.PBOSS_HOME
 * afterwards cannot rebind it. The daemon-subprocess e2e below must agree
 * with the in-process API client on ONE home — so both sides use the
 * binding, not the env var. (TEST_HOME still matters: the CLI-subprocess
 * test gets a fresh registry and binds to it.)
 */
const BOUND = await import("../src/constants");
const BOUND_HOME = BOUND.PBOSS_HOME;
const BOUND_SOCKET = BOUND.DAEMON_SOCKET;
const BOUND_PID_FILE = BOUND.DAEMON_PID_FILE;

/**
 * A PATH with no bun on it — the shape a systemd unit gives the daemon:
 * system dirs only, no per-user bin dirs, and no /usr/local/bin (where this
 * sandbox's bun lives), so nothing but the fallback chain can find a bun.
 */
const SYSTEMD_STYLE_PATH = "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
  // NOTE: the BOUND home is NOT removed — under the full suite it belongs
  // to whichever test file bound constants first. Only our daemon is
  // stopped (each e2e test kills it in its finally block).
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-rtd-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** A fake `bun` executable: writes its argv to a marker file, exits 0. */
function fakeBun(home: string, marker: string): string {
  const binDir = join(home, ".bun", "bin");
  mkdirSync(binDir, { recursive: true });
  const bunPath = join(binDir, "bun");
  writeFileSync(
    bunPath,
    `#!/bin/sh\necho "fake-bun $*" > "${marker}"\nexit 0\n`,
    { mode: 0o755 }
  );
  chmodSync(bunPath, 0o755);
  return bunPath;
}

/** Poll until a daemon answers pings on the BOUND socket. */
async function waitResponsive(timeoutMs = 20_000): Promise<boolean> {
  const { probeDaemon } = await import("../src/daemon-probe");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(BOUND_SOCKET)) return true;
    await Bun.sleep(150);
  }
  return false;
}

/** SIGKILL the daemon recorded in the BOUND PID file, wait for exit. */
async function hardKillDaemon() {
  if (existsSync(BOUND_PID_FILE)) {
    const pid = parseInt(readFileSync(BOUND_PID_FILE, "utf-8").trim());
    if (Number.isFinite(pid) && pid !== process.pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); await Bun.sleep(100); } catch { break; }
      }
    }
  }
  try { rmSync(BOUND_SOCKET, { force: true }); } catch { /* gone */ }
}

/** Write a probe script that exercises install-mode in ITS own process. */
function discoveryProbe(body: string): string {
  const dir = scratch("probe");
  const script = join(dir, "probe.ts");
  writeFileSync(
    script,
    `import { findBun, enrichPathWithBun } from ${JSON.stringify(join(ROOT, "src", "install-mode"))};\n${body}\n`
  );
  return script;
}

// ---------------------------------------------------------------------------
// findBun / enrichPathWithBun in a controlled subprocess
// ---------------------------------------------------------------------------

describe("findBun: discovery beyond PATH (the daemon's view)", () => {
  test("PATH miss + ~/.bun/bin hit — the reported incident", async () => {
    const home = scratch("home");
    const fake = fakeBun(home, join(home, "marker"));
    const script = discoveryProbe(`console.log(findBun());`);

    const proc = Bun.spawnSync([process.execPath, "run", script], {
      env: { PATH: SYSTEMD_STYLE_PATH, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(fake);
  });

  test("$BUN_INSTALL wins over HOME when both are set", async () => {
    const home = scratch("home");
    fakeBun(home, join(home, "marker-home"));
    const installPrefix = scratch("install");
    const binDir = join(installPrefix, "bin");
    mkdirSync(binDir, { recursive: true });
    const overrideBun = join(binDir, "bun");
    writeFileSync(overrideBun, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(overrideBun, 0o755);
    const script = discoveryProbe(`console.log(findBun());`);

    const proc = Bun.spawnSync([process.execPath, "run", script], {
      env: { PATH: SYSTEMD_STYLE_PATH, HOME: home, BUN_INSTALL: installPrefix },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(overrideBun);
  });

  test("fixed system locations are the last resort (no PATH, no HOME bun)", async () => {
    const home = scratch("emptyhome"); // no .bun inside
    const script = discoveryProbe(`console.log(findBun() ?? "null");`);

    const proc = Bun.spawnSync([process.execPath, "run", script], {
      env: { PATH: "/nonexistent", HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const found = proc.stdout.toString().trim();
    // /usr/local/bin/bun exists in this sandbox (and on many hosts); when it
    // does, it must be the answer. Otherwise: no bun anywhere → null.
    if (existsSync("/usr/local/bin/bun")) {
      expect(found).toBe("/usr/local/bin/bun");
    } else {
      expect(found).toBe("null");
    }
  });

  test("enrichPathWithBun prepends the discovered dir when missing, no-op when present", async () => {
    const home = scratch("home");
    fakeBun(home, join(home, "marker"));
    const bunDir = join(home, ".bun", "bin");
    const script = discoveryProbe(
      [
        "const first = enrichPathWithBun();",
        "const afterFirst = process.env.PATH!;",
        "const second = enrichPathWithBun();",
        "const unchanged = process.env.PATH! === afterFirst;",
        "console.log(JSON.stringify({ first, afterFirst, second, unchanged }));",
      ].join("\n")
    );

    // PATH lacks the dir → first call amends and prepends; second is a no-op.
    const proc = Bun.spawnSync([process.execPath, "run", script], {
      env: { PATH: SYSTEMD_STYLE_PATH, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const result = JSON.parse(proc.stdout.toString().trim());
    expect(result.first).toBe(true);
    expect(result.afterFirst.startsWith(bunDir)).toBe(true);
    expect(result.afterFirst.endsWith(SYSTEMD_STYLE_PATH)).toBe(true);
    expect(result.second).toBe(false);
    expect(result.unchanged).toBe(true);

    // PATH already contains the dir → no amendment at all.
    const proc2 = Bun.spawnSync([process.execPath, "run", script], {
      env: { PATH: `${bunDir}:${SYSTEMD_STYLE_PATH}`, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc2.exitCode).toBe(0);
    const result2 = JSON.parse(proc2.stdout.toString().trim());
    expect(result2.first).toBe(false);
    expect(result2.second).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The daemon end-to-end: systemd-style env + ~/.bun/bin worker spawn
// ---------------------------------------------------------------------------

describe("daemon with a systemd-style PATH still runs .ts workers", () => {
  test.skipIf(process.platform === "win32")(
    "worker spawns via the bun found in ~/.bun/bin (the reported incident, e2e)",
    async () => {
      const fakeHome = scratch("fakehome");
      const marker = join(fakeHome, "worker-marker");
      fakeBun(fakeHome, marker);

      // A .ts worker script — contents are irrelevant: the FAKE bun is the
      // interpreter the daemon must resolve, and it records argv to marker.
      const worker = join(fakeHome, "index.ts");
      writeFileSync(worker, "// placeholder — the fake bun does not execute this\n");

      // Daemon spawned exactly like systemd would: explicit minimal env, no
      // inherited shell PATH. process.execPath (absolute) starts it, so the
      // daemon itself does not need `bun` on ITS PATH. PBOSS_HOME is the
      // BOUND home — the one the in-process client below will talk to.
      await hardKillDaemon(); // defensive: a leftover from a crashed run
      const daemonProc = Bun.spawn([process.execPath, "run", DAEMON], {
        env: {
          PATH: SYSTEMD_STYLE_PATH,
          HOME: fakeHome,
          PBOSS_HOME: BOUND_HOME,
        },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      daemonProc.unref();

      try {
        expect(await waitResponsive()).toBe(true);
        const { PBoss } = await import("../src/api");
        const pboss = new PBoss();

        // THE incident: this used to reject with "the Bun runtime was not
        // found on this system". Now the worker is spawned with the bun
        // discovered at ~/.bun/bin. autorestart off — the fake bun exits
        // immediately, no restart loop.
        const states = await pboss.start({
          name: "disc-app",
          script: worker,
          autorestart: false,
        });
        expect(states.length).toBeGreaterThan(0);
        expect(states[0]?.name).toBe("disc-app");

        // Proof the worker ran under the fake bun: marker written with the
        // `run` argument and the resolved script path.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !existsSync(marker)) await Bun.sleep(100);
        expect(existsSync(marker)).toBe(true);
        const argv = readFileSync(marker, "utf-8");
        expect(argv).toContain("run");
        expect(argv).toContain(worker);

        await pboss.delete("disc-app");
      } finally {
        await hardKillDaemon();
      }
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// The CLI persistence hint stays out of piped output (parser-safe)
// ---------------------------------------------------------------------------

describe("first-start persistence hint: TTY-gated (piped output stays clean)", () => {
  test.skipIf(process.platform === "win32")(
    "pboss start with piped stdout prints no persistence hint",
    async () => {
      const cliHome = scratch("cli-home");

      // Worker script that exits immediately (exit 0) — no orphan process
      // to clean up after the test.
      const workDir = scratch("cli-work");
      const worker = join(workDir, "quick.ts");
      writeFileSync(worker, "process.exit(0);\n");

      // The subprocess runs with the test process's PATH (a real bun — the
      // CLI auto-starts the daemon with it) but a hermetic PBOSS_HOME, so
      // the dump starts EMPTY: the first-process condition is TRUE — the
      // hint would print on a TTY, and must NOT print through a pipe.
      const proc = Bun.spawn([process.execPath, "run", CLI, "start", worker], {
        env: { ...process.env, PBOSS_HOME: cliHome },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;

      try {
        expect(code).toBe(0);
        expect(err).not.toContain("the Bun runtime was not found");
        // …and the hint is absent from piped output.
        expect(out).not.toContain("Persistence on");
        expect(out).not.toContain("Reboot persistence is off");
      } finally {
        // Kill the daemon the CLI auto-started inside cliHome.
        const pidFile = join(cliHome, "daemon.pid");
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
          if (Number.isFinite(pid) && pid !== process.pid) {
            try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
          }
        }
        rmSync(cliHome, { recursive: true, force: true });
      }
    },
    30_000
  );
});
