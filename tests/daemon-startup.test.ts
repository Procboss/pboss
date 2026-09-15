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
    "with no daemon: exits 0 (best-effort) and NEVER spawns one",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-nowait-"));
      homes.push(home);

      const proc = spawnCli(["resurrect", "--wait", "1"], home);
      const code = await proc.exited;
      const { out, err } = await drain(proc);

      // ExecStartPost contract: a FAILED ExecStartPost aborts the unit's
      // start transaction — systemd would kill the healthy ExecStart daemon
      // and restart-loop ("Start request repeated too quickly"). So a wait
      // timeout must be reported (stderr = journal) and exit 0.
      expect(code).toBe(0);
      expect(err).toContain("daemon not ready within 1s");
      expect(err).toContain("best-effort");

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

describe("kill (ExecStop idempotency)", () => {
  test.skipIf(process.platform === "win32")(
    "pboss kill with no daemon: exits 0, never spawns, cleans stale files",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-kill0-"));
      homes.push(home);

      // Post-crash leftovers: a stale socket file and PID file pointing at
      // a process that does not exist.
      writeFileSync(join(home, "daemon.sock"), "stale");
      writeFileSync(join(home, "daemon.pid"), "999999");

      const proc = spawnCli(["kill"], home);
      const code = await proc.exited;
      const { out, err } = await drain(proc);

      // `pboss kill` is the unit's ExecStop: it must be a no-op success
      // when nobody is home — the old path auto-SPAWNED a daemon via
      // send() just to kill it.
      expect(code).toBe(0);
      expect(out).toContain("Daemon killed");

      // No daemon was spawned to be killed.
      expect(existsSync(join(home, "daemon.err.log"))).toBeFalse();
      expect(out).not.toContain("Daemon listening");

      // Stale runtime files were cleaned up either way.
      await Bun.sleep(100);
      expect(existsSync(join(home, "daemon.sock"))).toBeFalse();
      expect(existsSync(join(home, "daemon.pid"))).toBeFalse();
      expect(err).toBe("");
    }
  );

  test.skipIf(process.platform === "win32")(
    "pboss kill with a live daemon: stops it and cleans up its files",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-kill1-"));
      homes.push(home);

      const daemon = spawnCli(["__daemon"], home);
      expect(await waitResponsive(home)).toBeTrue();

      const proc = spawnCli(["kill"], home);
      const code = await proc.exited;
      const { out } = await drain(proc);
      expect(code).toBe(0);
      expect(out).toContain("Daemon killed");

      // The daemon actually exited and removed its own files (plus the
      // CLI's fallback cleanup). Nothing listens afterwards.
      await daemon.exited;
      await Bun.sleep(200);
      expect(existsSync(join(home, "daemon.sock"))).toBeFalse();
      expect(existsSync(join(home, "daemon.pid"))).toBeFalse();
      expect(await probeDaemon(join(home, "daemon.sock"))).toBeNull();
      await drain(daemon);
    }
  );
});

describe("CLI against a live daemon (EBUSY reboot bug, issue #36 follow-up)", () => {
  // Owner report 2026-09-15: after reboot on Windows, `pboss logs -f`
  // died with "Error: EBUSY: resource busy or locked, open". Root cause:
  // isDaemonAlive() gated on Bun.file(socket).exists() — which OPENs the
  // path and therefore cannot see a socket file (ENXIO on POSIX, sharing
  // violation on Windows) — so it permanently said "dead", every command
  // spawned a DUPLICATE daemon, and on Windows the duplicate's daemon
  // log-file open collided with the logon task launcher's cmd.exe
  // handles (EBUSY). The fixed contract: against a live daemon, CLI
  // commands must see it, use it, and never spawn a duplicate.
  test.skipIf(process.platform === "win32")(
    "a live daemon is visible to isDaemonAlive and commands spawn no duplicate",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-live-"));
      homes.push(home);

      // 1. Daemon comes up (the "logon task" stand-in).
      const daemon = spawnCli(["__daemon"], home);
      expect(await waitResponsive(home)).toBeTrue();
      const pidBefore = parseInt(readFileSync(join(home, "daemon.pid"), "utf-8").trim());

      // 2. A CLI command that goes through the send()/ensure-daemon path
      //    (`ping` is the shortest) must succeed.
      const proc = spawnCli(["ping"], home);
      const code = await proc.exited;
      const { out, err } = await drain(proc);
      expect(code).toBe(0);
      expect(out).toContain("Daemon is alive");

      // 3. THE regression guard: no doomed duplicate was spawned. A
      //    duplicate CLI-launched daemon redirects its stderr into
      //    daemon.err.log and dies with DaemonConflictError ("already
      //    listening") — so a clean daemon.err.log is the no-duplicate
      //    proof. (The daemon itself was spawned with piped stdio, not
      //    the log files, so only a duplicate writes this file.)
      expect(existsSync(join(home, "daemon.err.log"))).toBeFalse();

      // 4. The daemon serving the command is still the SAME process.
      const pidAfter = parseInt(readFileSync(join(home, "daemon.pid"), "utf-8").trim());
      expect(pidAfter).toBe(pidBefore);
      expect(await probeDaemon(join(home, "daemon.sock"))).not.toBeNull();
      expect(err).toBe("");

      await hardKillDaemon(home);
      await daemon.exited;
      await drain(daemon);
    }
  );

  test.skipIf(process.platform === "win32")(
    "startDaemon() reports the live daemon instead of launching a duplicate",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-startd-"));
      homes.push(home);

      const daemon = spawnCli(["__daemon"], home);
      expect(await waitResponsive(home)).toBeTrue();

      // Run the API path in a fresh process (constants capture PBOSS_HOME
      // at import time): startDaemon() must detect the live daemon and
      // return without spawning — asserted by the same clean-log rule.
      const script = join(import.meta.dir, "helpers", "tmp-startd.ts");
      writeFileSync(
        script,
        `const { PBoss } = await import("../../src/api");\n` +
          `const c = new PBoss();\n` +
          `if (!(await c.isDaemonAlive())) { console.error("isDaemonAlive=false"); process.exit(1); }\n` +
          `await c.startDaemon();\n` +
          `console.log("startd-ok");\n`
      );
      const proc = Bun.spawn(["bun", "run", script], {
        env: { ...process.env, PBOSS_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const code = await proc.exited;
      const { out, err } = await drain(proc);
      expect(code).toBe(0);
      expect(out).toContain("startd-ok");
      expect(err).toBe("");
      rmSync(script, { force: true });

      // isDaemonAlive saw the live socket AND no duplicate was spawned.
      expect(existsSync(join(home, "daemon.err.log"))).toBeFalse();

      await hardKillDaemon(home);
      await daemon.exited;
      await drain(daemon);
    }
  );
});
