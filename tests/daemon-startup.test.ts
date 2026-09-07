/**
 * Daemon startup integration tests — the systemd unit failure, pinned.
 *
 * Reproduces the reported incident end-to-end with hermetic PBOSS_HOME
 * directories: `systemctl start pboss` failed with ExecStart exiting 1 and
 * a 5-restart storm while `sudo pboss __daemon` worked fine manually.
 *
 * Root cause verified here:
 *   A) CONFLICT  — a second __daemon against a live one must exit 81
 *      (RestartPreventExitStatus target) with a clear message, not die
 *      with an opaque EADDRINUSE code 1.
 *   B) TAKEOVER  — stale socket + PID file whose PID was reused by an
 *      unrelated process must NOT block startup: the daemon takes over.
 *   C) NO-SPAWN  — `resurrect --wait` polls for an external daemon and
 *      never spawns one (the spawned daemon raced the unit's daemon for
 *      the socket); with no daemon it exits 1 leaving no runtime files.
 *
 * Each test spawns real `bun src/index.ts` subprocesses; skipped on
 * Windows (unix sockets are the transport under test).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDaemon } from "../src/daemon-probe";
import { EXIT_DAEMON_CONFLICT } from "../src/error-handling";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
}

/** Read all of a pipe without blocking the test on a dead process. */
async function drain(p: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }) {
  const [out, err] = await Promise.all([
    new Response(p.stdout).text().catch(() => ""),
    new Response(p.stderr).text().catch(() => ""),
  ]);
  return { out, err };
}

async function waitResponsive(home: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(join(home, "daemon.sock"))) return true;
    await Bun.sleep(150);
  }
  return false;
}

/** SIGKILL the daemon recorded in home's PID file, wait for exit. */
async function hardKillDaemon(home: string) {
  const pidFile = join(home, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
    if (Number.isFinite(pid) && pid !== process.pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); await Bun.sleep(100); } catch { break; }
      }
    }
  }
}

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("daemon startup: conflict (systemd restart-storm root cause)", () => {
  test.skipIf(process.platform === "win32")(
    "second __daemon against a live one exits 81 with a clear message",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-conflict-"));
      homes.push(home);

      // 1. First daemon comes up and owns the socket.
      const first = spawnCli(["__daemon"], home);
      const up = await waitResponsive(home);
      expect(up).toBeTrue();

      // 2. Second daemon must detect the conflict and exit 81 — the
      //    RestartPreventExitStatus contract — instead of EADDRINUSE/1.
      const second = spawnCli(["__daemon"], home);
      const code = await second.exited;
      const { err } = await drain(second);
      expect(code).toBe(EXIT_DAEMON_CONFLICT);
      expect(err).toContain("cannot start daemon");
      expect(err).toContain("already listening");
      expect(err).toContain(join(home, "daemon.sock"));

      // 3. The first daemon is unaffected.
      expect(await probeDaemon(join(home, "daemon.sock"))).not.toBeNull();

      await hardKillDaemon(home);
      await first.exited;
      expect(await drain(first)).toBeDefined();
    }
  );
});

describe("daemon startup: stale files (post-reboot / PID reuse)", () => {
  test.skipIf(process.platform === "win32")(
    "stale socket file + live-but-unrelated PID does not block startup",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-stale-"));
      homes.push(home);

      // Simulate the post-reboot trap: socket file exists (no listener),
      // PID file holds THIS test process's pid — kill(pid, 0) succeeds
      // exactly like PID reuse did on the broken builds.
      writeFileSync(join(home, "daemon.sock"), "stale");
      writeFileSync(join(home, "daemon.pid"), String(process.pid));

      const proc = spawnCli(["__daemon"], home);
      const up = await waitResponsive(home);
      expect(up).toBeTrue(); // took over despite the lying PID file

      // The PID file now belongs to the real daemon, not the test process.
      const pid = parseInt(readFileSync(join(home, "daemon.pid"), "utf-8").trim());
      expect(pid).not.toBe(process.pid);

      await hardKillDaemon(home);
      await proc.exited;
      expect(await drain(proc)).toBeDefined();
    }
  );
});

describe("resurrect --wait (ExecStartPost race fix)", () => {
  test.skipIf(process.platform === "win32")(
    "with no daemon: exits 1 and NEVER spawns one",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-nowait-"));
      homes.push(home);

      const proc = spawnCli(["resurrect", "--wait", "1"], home);
      const code = await proc.exited;
      const { out, err } = await drain(proc);
      expect(code).toBe(1);
      expect(err).toContain("did not become ready");

      // THE regression guard: no pid file, no socket — nothing was spawned
      // to fight the unit's daemon for the socket.
      expect(existsSync(join(home, "daemon.pid"))).toBeFalse();
      expect(existsSync(join(home, "daemon.sock"))).toBeFalse();
      expect(existsSync(join(home, "daemon.err.log"))).toBeFalse();
      expect(out).not.toContain("Daemon listening");
    }
  );

  test.skipIf(process.platform === "win32")(
    "with a live daemon: waits for it and succeeds without spawning another",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-wait-"));
      homes.push(home);

      const daemon = spawnCli(["__daemon"], home);
      expect(await waitResponsive(home)).toBeTrue();

      const proc = spawnCli(["resurrect", "--wait", "10"], home);
      const code = await proc.exited;
      const { err } = await drain(proc);
      expect(code).toBe(0);
      expect(err).toBe("");

      // Exactly one daemon: the PID in the file is still the first one.
      const pid = parseInt(readFileSync(join(home, "daemon.pid"), "utf-8").trim());
      expect(pid).toBe(daemon.pid);

      await hardKillDaemon(home);
      await daemon.exited;
      await drain(daemon);
    }
  );
});
