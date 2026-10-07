/**
 * Issue #41 — the daemon lifecycle, pinned.
 * https://github.com/Procboss/pboss/issues/41
 *
 *   1. `pboss daemon start|stop|restart|status` exist and behave:
 *      status reports the daemon's PID, pboss version, runtime and uptime
 *      next to the installed version; start/stop/restart are idempotent
 *      and honest.
 *   2. SERVICE SYNC — with a boot service installed, every action goes
 *      THROUGH it (systemctl / launchctl / schtasks): a stop that only
 *      killed the daemon is undone by Restart=always seconds later, and a
 *      restart must never leave the old daemon running while a new one
 *      starts. Pinned here with a systemctl shim that stands in for the
 *      manager (and actually starts the daemon, like the unit's ExecStart).
 *   3. UPGRADE REALIGN — `pboss upgrade` stops the old-code daemon,
 *      reinstalls the boot service from the NEW install and restarts the
 *      daemon through it (or `pboss resurrect` from the new install when
 *      no service exists). Pinned end to end with an old-shaped dist
 *      reporting a version below the registry's latest, a fake channel
 *      command, and a fake PATH pboss that logs the delegated calls —
 *      the same harness shape as the deno upgrade e2e.
 *   4. STALE-DAEMON DETECTION — the daemon reports its entry module and
 *      runtime executable (additive ping fields); status flags an older
 *      pboss, an upgraded runtime, and an install that moved underneath
 *      the daemon (deno's versioned install dirs), each with the exact
 *      fix: `pboss daemon restart`.
 *
 * Unit cases are pure (composeDaemonStatus / daemonEntryArg / sameEntry /
 * realignDaemonAfterUpgrade with injected deps). E2E cases run the real
 * CLI on hermetic PBOSS_HOMEs (the daemon-startup harness); the service
 * and upgrade e2e additionally skip on non-Linux (systemctl shims) and
 * the registry-dependent upgrade e2e skips visibly when the registry is
 * unreachable.
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { probeDaemon } from "../src/daemon-probe";
import {
  composeDaemonStatus,
  daemonEntryArg,
  sameEntry,
  realignDaemonAfterUpgrade,
  type DaemonFacts,
  type RealignDeps,
} from "../src/daemon-lifecycle";
import { bootServiceKind } from "../src/startup-manager";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "index.ts");
const DAEMON_SRC = join(REPO, "src", "daemon.ts");
const DIST_CLI = join(REPO, "dist", "cli.js");
const DIST_BUILT = existsSync(DIST_CLI);
const NODE_BIN = Bun.which("node");

/* ── harness (the daemon-startup pattern) ───────────────────────────────── */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) {
    hardKillDaemon(h);
    rmSync(h, { recursive: true, force: true });
  }
});

function hermetic(home: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    PBOSS_HOME: join(home, ".pboss"),
    // never set: the legacy sudo flow must not engage (targetUserContext
    // must read OUR hermetic HOME, not root's).
    SUDO_USER: "",
    TERM: "dumb",
  };
}

function spawnCli(args: string[], env: Record<string, string>, cwd?: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
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

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function socketOf(home: string): string {
  return join(home, ".pboss", "daemon.sock");
}

async function waitResponsive(home: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(socketOf(home))) return true;
    await Bun.sleep(150);
  }
  return false;
}

async function waitGone(home: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeDaemon(socketOf(home)))) return true;
    await Bun.sleep(150);
  }
  return false;
}

/** SIGKILL the daemon recorded in home's PID file, wait for exit. */
function hardKillDaemon(home: string) {
  const pidFile = join(home, ".pboss", "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim());
    if (Number.isFinite(pid) && pid !== process.pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { break; }
      }
    }
  }
}

function pidOf(home: string): number {
  return parseInt(readFileSync(join(home, ".pboss", "daemon.pid"), "utf8").trim());
}

/* ── unit: the pure helpers ──────────────────────────────────────────────── */

describe("issue #41 unit: daemonEntryArg (what a fresh daemon would run)", () => {
  test("node / deno / bun-script commands yield their entry module", () => {
    expect(daemonEntryArg(["/usr/bin/node", "/x/dist/cli.js", "__daemon"])).toBe("/x/dist/cli.js");
    expect(daemonEntryArg(["/usr/bin/deno", "run", "-A", "/x/dist/cli.deno.js", "__daemon"])).toBe("/x/dist/cli.deno.js");
    expect(daemonEntryArg(["/usr/local/bin/bun", "run", "/r/src/daemon.ts"])).toBe("/r/src/daemon.ts");
  });

  test("a compiled binary has no entry module — null, comparison skipped", () => {
    expect(daemonEntryArg(["/usr/local/bin/pboss", "__daemon"])).toBeNull();
    expect(daemonEntryArg([])).toBeNull();
  });
});

describe("issue #41 unit: sameEntry (install-drift comparison)", () => {
  test("identical paths and file://-equivalent paths match", () => {
    expect(sameEntry("/a/dist/cli.js", "/a/dist/cli.js")).toBe(true);
    expect(sameEntry("file:///a/dist/cli.js", "/a/dist/cli.js")).toBe(true);
  });

  test("different installs mismatch; unknown sides are null (never drift)", () => {
    expect(sameEntry("/old/.deno/pboss@1.6.6/cli.deno.js", "/new/.deno/pboss@1.6.8/cli.deno.js")).toBe(false);
    expect(sameEntry(null, "/a/cli.js")).toBeNull();
    expect(sameEntry("/a/cli.js", undefined)).toBeNull();
  });
});

describe("issue #41 unit: composeDaemonStatus (the status report)", () => {
  const base: DaemonFacts = {
    live: {
      pid: 4242,
      uptime: 3_600,
      version: "1.7.0",
      runtime: "bun",
      runtimeVersion: Bun.version,
      entry: "/r/src/daemon.ts",
      exec: process.execPath,
    },
    installedVersion: "1.7.0",
    currentRuntime: "bun",
    currentRuntimeVersion: Bun.version,
    expectedEntry: "/r/src/daemon.ts",
    serviceKind: "none",
  };

  test("a fresh daemon: every fact, no advice, exit 0", () => {
    const r = composeDaemonStatus(base);
    expect(r.status).toBe("running");
    expect(r.exitCode).toBe(0);
    const text = r.lines.join("\n");
    for (const expected of [
      "Daemon:    running",
      "PID:       4242",
      "pboss:     1.7.0",
      `Runtime:   Bun ${Bun.version}`,
      "Service:   none",
      "Installed: 1.7.0",
      "Status:    running",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("pboss daemon restart");
    expect(text).toContain("Up:");
  });

  test("stopped: exit 1 + the start hint", () => {
    const r = composeDaemonStatus({ ...base, live: null, serviceKind: "systemd" });
    expect(r.status).toBe("stopped");
    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain("Daemon:    stopped");
    expect(text).toContain("Service:   systemd (user unit)");
    expect(text).toContain("pboss daemon start");
  });

  test("an OLDER daemon: status outdated + the issue's exact advice", () => {
    const r = composeDaemonStatus({
      ...base,
      live: { ...base.live!, version: "1.2.0" },
    });
    expect(r.status).toBe("outdated");
    expect(r.exitCode).toBe(0); // the daemon IS running
    const text = r.lines.join("\n");
    expect(text).toContain("Installed: 1.7.0");
    expect(text).toContain("Status:    outdated");
    expect(text).toContain("A newer pboss version is installed (the daemon runs v1.2.0).");
    expect(text).toContain("Run `pboss daemon restart` to apply the update.");
  });

  test("a pre-1.7.0 daemon (no identity fields): named with the fix", () => {
    const r = composeDaemonStatus({
      ...base,
      live: { pid: 3058, uptime: 120 },
    });
    expect(r.status).toBe("running");
    const text = r.lines.join("\n");
    expect(text).toContain("unknown (pre-1.7.0 daemon)");
    expect(text).toContain("An older daemon");
    expect(text).toContain("pboss daemon restart");
  });

  test("a daemon NEWER than the CLI: no restart advice (the CLI is the old half)", () => {
    const r = composeDaemonStatus({
      ...base,
      live: { ...base.live!, version: "2.0.0" },
    });
    const text = r.lines.join("\n");
    expect(text).toContain("newer pboss");
    expect(text).toContain("pboss upgrade");
    expect(text).not.toContain("pboss daemon restart");
  });

  test("runtime mismatch (the owner's original report): realign advice", () => {
    const r = composeDaemonStatus({
      ...base,
      live: { ...base.live!, runtime: "node", runtimeVersion: "24.19.0" },
      currentRuntime: "deno",
      currentRuntimeVersion: "2.9.7",
    });
    const text = r.lines.join("\n");
    expect(text).toContain("daemon executes under Node, but this pboss is Deno");
    expect(text).toContain("pboss daemon restart");
  });

  test("runtime UPGRADED underneath the daemon (bun upgrade): advice names both versions", () => {
    const r = composeDaemonStatus({
      ...base,
      live: { ...base.live!, runtimeVersion: "1.3.9" },
    });
    const text = r.lines.join("\n");
    expect(text).toContain("The Bun runtime was upgraded (daemon runs 1.3.9");
    expect(text).toContain(`this pboss runs ${Bun.version}`);
    expect(text).toContain("pboss daemon restart");
  });

  test("the install moved underneath the daemon: both paths + the fix", () => {
    const r = composeDaemonStatus({
      ...base,
      live: { ...base.live!, entry: "/home/u/.deno/pboss@1.6.6/node_modules/pboss/dist/cli.deno.js" },
      expectedEntry: "/home/u/.deno/pboss@1.6.8/node_modules/pboss/dist/cli.deno.js",
    });
    const text = r.lines.join("\n");
    expect(text).toContain("The daemon runs from a different pboss install:");
    expect(text).toContain("daemon:  /home/u/.deno/pboss@1.6.6");
    expect(text).toContain("current: /home/u/.deno/pboss@1.6.8");
    expect(text).toContain("pboss daemon restart");
  });

  test("an unknown expected entry (compiled binary) never reports install drift", () => {
    const r = composeDaemonStatus({
      ...base,
      expectedEntry: null,
      live: { ...base.live!, entry: "/usr/local/bin/pboss" },
    });
    expect(r.lines.join("\n")).not.toContain("different pboss install");
  });
});

describe("issue #41 unit: bootServiceKind (hermetic unitDir)", () => {
  test.skipIf(process.platform !== "linux")(
    "a unit file answers systemd; an empty dir answers none",
    async () => {
      const withUnit = mkdtempSync(join(tmpdir(), "pboss-kind-yes-"));
      mkdirSync(join(withUnit, "pboss.service", ".."), { recursive: true });
      writeFileSync(join(withUnit, "pboss.service"), "[Unit]\n");
      const without = mkdtempSync(join(tmpdir(), "pboss-kind-no-"));
      homes.push(withUnit, without);
      expect(await bootServiceKind({ unitDir: withUnit })).toBe("systemd");
      expect(await bootServiceKind({ unitDir: without })).toBe("none");
    },
  );
});

/* ── unit: the post-upgrade realign (injected deps, every branch) ────────── */

function makeRealignDeps(over: Partial<RealignDeps> = {}) {
  const calls: string[] = [];
  let live: { pid: number } | null = { pid: 42 };
  const deps: RealignDeps = {
    probe: async () => live as never,
    killDaemon: async () => {
      calls.push("kill");
      live = null;
    },
    serviceKind: async () => "none",
    runPboss: async (args: string[]) => {
      calls.push(`pboss ${args.join(" ")}`);
      live = { pid: 43 };
      return 0;
    },
    waitForDaemon: async () => live !== null,
    log: (line: string) => calls.push(`log: ${line}`),
    ...over,
  };
  return { deps, calls };
}

describe("issue #41 unit: realignDaemonAfterUpgrade", () => {
  test("no boot service: the OLD daemon is killed, the NEW pboss resurrects", async () => {
    const { deps, calls } = makeRealignDeps();
    const r = await realignDaemonAfterUpgrade(deps);
    expect(calls).toContain("kill");
    expect(calls).toContain("pboss resurrect");
    expect(calls).not.toContain("pboss startup install");
    expect(r.via).toBe("manual");
    expect(r.live).not.toBeNull();
    expect(r.note).toBe("");
  });

  test("a boot service: pboss startup install (unit regenerated + restart)", async () => {
    const { deps, calls } = makeRealignDeps({ serviceKind: async () => "systemd" });
    const r = await realignDaemonAfterUpgrade(deps);
    expect(calls).toContain("kill");
    expect(calls).toContain("pboss startup install");
    expect(r.via).toBe("service");
  });

  test("a runkey-only machine takes the manual path (no on-demand control)", async () => {
    const { deps, calls } = makeRealignDeps({ serviceKind: async () => "runkey" });
    await realignDaemonAfterUpgrade(deps);
    expect(calls).toContain("pboss resurrect");
  });

  test("no daemon running: nothing is killed, the new one still comes up", async () => {
    const { deps, calls } = makeRealignDeps();
    // probe answers null from the start
    const r = await realignDaemonAfterUpgrade({
      ...deps,
      probe: async () => null,
      runPboss: async (args) => {
        calls.push(`pboss ${args.join(" ")}`);
        return 0;
      },
      waitForDaemon: async () => true,
    });
    expect(calls).not.toContain("kill");
    expect(calls).toContain("pboss resurrect");
    expect(r.via).toBe("manual");
  });

  test("the new pboss FAILS: the honest note names the manual command", async () => {
    const { deps } = makeRealignDeps({ runPboss: async () => 1 });
    const r = await realignDaemonAfterUpgrade(deps);
    expect(r.via).toBe("none");
    expect(r.note).toContain("pboss resurrect");
    expect(r.note).toContain("exited 1");
  });

  test("the new pboss cannot be run at all: same honesty", async () => {
    const { deps } = makeRealignDeps({ runPboss: async () => null });
    const r = await realignDaemonAfterUpgrade(deps);
    expect(r.note).toContain("could not run the new pboss");
  });

  test("the daemon does not come back: the note points at daemon status", async () => {
    const { deps } = makeRealignDeps({ waitForDaemon: async () => false });
    const r = await realignDaemonAfterUpgrade(deps);
    expect(r.live).toBeNull();
    expect(r.note).toContain("has not come back yet");
    expect(r.note).toContain("pboss daemon status");
  });
});

/* ── e2e: the lifecycle on a hermetic home (no boot service) ─────────────── */

describe("issue #41 e2e: daemon start/stop/restart/status (no boot service)", () => {
  test.skipIf(process.platform === "win32")(
    "the full round trip: stopped → start → status → restart → stop → stopped",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-d41-"));
      homes.push(home);
      const env = hermetic(home);

      // stopped: exit 1, the hint
      const st0 = spawnCli(["daemon", "status"], env);
      const st0r = await drain(st0);
      expect(await st0.exited).toBe(1);
      expect(stripAnsi(st0r.out + st0r.err)).toContain("Daemon:    stopped");
      expect(stripAnsi(st0r.out)).toContain("pboss daemon start");

      // start: spawns + restores (nothing to restore — no dump)
      const s1 = spawnCli(["daemon", "start"], env);
      const s1r = await drain(s1);
      expect(await s1.exited).toBe(0);
      expect(stripAnsi(s1r.out)).toContain("Daemon started");
      expect(await waitResponsive(home)).toBeTrue();
      const pid1 = pidOf(home);

      // status: running, the real pid, the real version, exit 0
      const st1 = spawnCli(["daemon", "status"], env);
      const st1r = await drain(st1);
      expect(await st1.exited).toBe(0);
      const text1 = stripAnsi(st1r.out);
      expect(text1).toContain("Daemon:    running");
      expect(text1).toContain(`PID:       ${pid1}`);
      expect(text1).toContain("pboss:     ");
      expect(text1).toContain("Status:    running");
      // a daemon just started from THIS tree matches it — no drift advice
      expect(text1).not.toContain("outdated");
      expect(text1).not.toContain("different pboss install");

      // start again: idempotent, SAME daemon
      const s2 = spawnCli(["daemon", "start"], env);
      const s2r = await drain(s2);
      expect(await s2.exited).toBe(0);
      expect(stripAnsi(s2r.out)).toContain("already running");
      expect(pidOf(home)).toBe(pid1);

      // restart: a NEW daemon replaces the old one
      const r1 = spawnCli(["daemon", "restart"], env);
      const r1r = await drain(r1);
      expect(await r1.exited).toBe(0);
      expect(stripAnsi(r1r.out)).toContain("Daemon restarted");
      expect(await waitResponsive(home)).toBeTrue();
      const pid2 = pidOf(home);
      expect(pid2).not.toBe(pid1);

      // stop: gone, exit 0 — and "stopped" means STOPPED
      const p1 = spawnCli(["daemon", "stop"], env);
      const p1r = await drain(p1);
      expect(await p1.exited).toBe(0);
      expect(stripAnsi(p1r.out)).toContain("Daemon stopped");
      expect(await waitGone(home)).toBeTrue();

      // stop again: idempotent
      const p2 = spawnCli(["daemon", "stop"], env);
      const p2r = await drain(p2);
      expect(await p2.exited).toBe(0);
      expect(stripAnsi(p2r.out)).toContain("not running");

      // status: stopped again
      const st2 = spawnCli(["daemon", "status"], env);
      expect(await st2.exited).toBe(1);
      await drain(st2);
    },
    120_000,
  );

  test.skipIf(process.platform === "win32")(
    "daemon stop → daemon start round-trips a managed process (the boot-service parity)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-d41-rt-"));
      homes.push(home);
      const env = hermetic(home);
      const appDir = join(home, "app");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, "keepalive.js"),
        "setInterval(() => {}, 1000);\n",
      );

      // start an app (brings the daemon up on demand), let it settle
      const sa = spawnCli(["start", "./keepalive.js", "--name", "issue41app"], env, appDir);
      const sar = await drain(sa);
      expect(await sa.exited).toBe(0);
      expect(stripAnsi(sar.out)).toContain("online");
      expect(await waitResponsive(home)).toBeTrue();
      const pid1 = pidOf(home);

      // stop: the daemon (and with it the app) stops
      const sp = spawnCli(["daemon", "stop"], env);
      await drain(sp);
      expect(await sp.exited).toBe(0);
      expect(await waitGone(home)).toBeTrue();

      // start: the daemon comes back AND the saved list is restored
      const ss = spawnCli(["daemon", "start"], env);
      const ssr = await drain(ss);
      expect(await ss.exited).toBe(0);
      expect(await waitResponsive(home)).toBeTrue();
      expect(stripAnsi(ssr.out)).toContain("issue41app");
      const pid2 = pidOf(home);
      expect(pid2).not.toBe(pid1);

      // the app is actually running again
      const sl = spawnCli(["list"], env);
      const slr = await drain(sl);
      expect(await sl.exited).toBe(0);
      expect(stripAnsi(slr.out)).toContain("issue41app");
      expect(stripAnsi(slr.out)).toContain("online");

      // cleanup: stop the app fleet via the daemon stop
      const fin = spawnCli(["daemon", "stop"], env);
      await drain(fin);
    },
    120_000,
  );
});

/* ── e2e: stale-daemon detection against fake daemons ───────────────────── */

describe("issue #41 e2e: daemon status vs stale daemons (fake pongs)", () => {
  test.skipIf(process.platform === "win32")(
    "a pre-1.7.0 daemon and an outdated daemon both name the fix",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-d41-fake-"));
      homes.push(home);
      mkdirSync(join(home, ".pboss"), { recursive: true });

      // 1. A pre-1.7.0 daemon: the ping answers the OLD shape (no
      //    identity fields — they are additive).
      const old = Bun.serve({
        unix: socketOf(home),
        fetch: () =>
          new Response(
            JSON.stringify({ type: "pong", success: true, data: { pid: 3058, uptime: 120 } }),
            { headers: { "Content-Type": "application/json" } },
          ),
      });

      const st1 = spawnCli(["daemon", "status"], hermetic(home));
      const st1r = await drain(st1);
      expect(await st1.exited).toBe(0); // it IS running
      const text1 = stripAnsi(st1r.out);
      expect(text1).toContain("unknown (pre-1.7.0 daemon)");
      expect(text1).toContain("pid 3058".replace("pid ", "PID:       "));
      expect(text1).toContain("An older daemon");
      expect(text1).toContain("pboss daemon restart");
      await old.stop(true);

      // 2. An outdated daemon: version below the installed one, running a
      //    moved install (deno's versioned dir shape).
      await Bun.sleep(200); // let the socket file free
      const outdated = Bun.serve({
        unix: socketOf(home),
        fetch: () =>
          new Response(
            JSON.stringify({
              type: "pong",
              success: true,
              data: {
                pid: 99,
                uptime: 5,
                version: "1.6.6",
                runtime: "deno",
                runtimeVersion: "2.9.7",
                entry: "/home/u/.deno/pboss@1.6.6/node_modules/pboss/dist/cli.deno.js",
                exec: "/home/u/.deno/bin/deno",
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      });

      const st2 = spawnCli(["daemon", "status"], hermetic(home));
      const st2r = await drain(st2);
      expect(await st2.exited).toBe(0);
      const text2 = stripAnsi(st2r.out);
      expect(text2).toContain("Status:    outdated");
      expect(text2).toContain("A newer pboss version is installed (the daemon runs v1.6.6).");
      expect(text2).toContain("Run `pboss daemon restart` to apply the update.");
      expect(text2).toContain("different pboss install");
      await outdated.stop(true);
    },
    60_000,
  );
});

/* ── e2e: the service-managed path (systemctl shim, Linux) ──────────────── */

/** A systemctl shim that stands in for the user manager: it logs every
 *  call, and start/restart actually launch the daemon (like the unit's
 *  ExecStart) with the hermetic env baked in. start/restart arrive as
 *  --no-block submissions (the CLI polls for the daemon itself — a cold
 *  unit must never hold a blocking systemctl). */
function makeSystemctlShim(home: string): { dir: string; log: string } {
  const dir = join(home, "shim");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "systemctl.log");
  const pb = join(home, ".pboss");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> ${JSON.stringify(log)}`,
    'case "$*" in',
    '  "--user --no-block start pboss"|"--user --no-block restart pboss")',
    `    ( env PBOSS_HOME=${JSON.stringify(pb)} HOME=${JSON.stringify(home)} \\`,
    `        bun run ${JSON.stringify(DAEMON_SRC)} >> ${JSON.stringify(join(dir, "shim-daemon.log"))} 2>&1 & )`,
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "systemctl"), script);
  chmodSync(join(dir, "systemctl"), 0o755);
  return { dir, log };
}

function withUnitFile(home: string): void {
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "pboss.service"), "[Unit]\n");
}

describe("issue #41 e2e: the boot service owns the lifecycle (systemd shim, Linux)", () => {
  test.skipIf(process.platform !== "linux")(
    "start goes through systemctl — no direct spawn behind the manager's back",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-d41-svc-"));
      homes.push(home);
      const { dir, log } = makeSystemctlShim(home);
      withUnitFile(home);
      const env = { ...hermetic(home), PATH: `${dir}:${process.env.PATH ?? ""}` };

      const s = spawnCli(["daemon", "start"], env);
      const sr = await drain(s);
      expect(await s.exited).toBe(0);
      expect(stripAnsi(sr.out)).toContain("through systemd (user unit)");
      // THE contract: the manager was told, not bypassed.
      expect(readFileSync(log, "utf8")).toContain("--user --no-block start pboss");
      expect(await waitResponsive(home)).toBeTrue();
    },
    60_000,
  );

  test.skipIf(process.platform !== "linux")(
    "stop kills the daemon AND tells the manager (Restart=always stands down)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-d41-svc-stop-"));
      homes.push(home);
      const { dir, log } = makeSystemctlShim(home);
      withUnitFile(home);
      const env = { ...hermetic(home), PATH: `${dir}:${process.env.PATH ?? ""}` };

      // a live daemon (as if the service had started it)
      const daemon = Bun.spawn(["bun", "run", DAEMON_SRC], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      expect(await waitResponsive(home)).toBeTrue();
      const pid = pidOf(home);

      const p = spawnCli(["daemon", "stop"], env);
      const pr = await drain(p);
      expect(await p.exited).toBe(0);
      expect(stripAnsi(pr.out)).toContain("Daemon stopped");
      expect(readFileSync(log, "utf8")).toContain("--user stop pboss");
      // the old daemon is DEAD — "stopped" means stopped.
      expect(await waitGone(home)).toBeTrue();
      let stillAlive = true;
      try { process.kill(pid, 0); } catch { stillAlive = false; }
      expect(stillAlive).toBe(false);
      await daemon.exited;
    },
    60_000,
  );

  test.skipIf(process.platform !== "linux")(
    "restart: the OLD daemon is dead before the new one answers — never both",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-d41-svc-rst-"));
      homes.push(home);
      const { dir, log } = makeSystemctlShim(home);
      withUnitFile(home);
      const env = { ...hermetic(home), PATH: `${dir}:${process.env.PATH ?? ""}` };

      // a live daemon to replace
      const daemon = Bun.spawn(["bun", "run", DAEMON_SRC], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      expect(await waitResponsive(home)).toBeTrue();
      const oldPid = pidOf(home);

      const r = spawnCli(["daemon", "restart"], env);
      const rr = await drain(r);
      expect(await r.exited).toBe(0);
      expect(stripAnsi(rr.out)).toContain("restarted through systemd (user unit)");
      expect(readFileSync(log, "utf8")).toContain("--user --no-block restart pboss");

      // the new daemon is up and is NOT the old process
      expect(await waitResponsive(home)).toBeTrue();
      const newPid = pidOf(home);
      expect(newPid).not.toBe(oldPid);
      let oldStillAlive = true;
      try { process.kill(oldPid, 0); } catch { oldStillAlive = false; }
      expect(oldStillAlive).toBe(false);
      await daemon.exited;
    },
    60_000,
  );
});

/* ── e2e: the upgrade realign (old-shaped dist + fake channel + fake pboss) */

/**
 * The upgrade harness (the deno upgrade e2e's shape, node-flavored):
 *  - an old-shaped dist copy reporting a version BELOW the registry's
 *    latest, so `upgrade` actually executes its plan;
 *  - a fake `npm` first on PATH: the channel command lands in a log and
 *    succeeds (a test must never reinstall the global package);
 *  - a fake `pboss` on PATH: --version reports the NEW version (the
 *    upgrade "succeeded"), and `resurrect` / `startup install` are logged
 *    AND actually start the new-code daemon from the repo's dist — the
 *    new install the upgrade just "delivered".
 */
function makeUpgradeHarness(home: string, unitFile: boolean) {
  const pkg = join(home, "pkg");
  const shimDir = join(home, "shim");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(home, ".pboss"), { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  if (unitFile) withUnitFile(home);

  const REPO_VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  const cliBody = readFileSync(DIST_CLI, "utf8");
  writeFileSync(join(pkg, "dist", "cli.js"), cliBody.split(`"${REPO_VERSION}"`).join('"1.6.6"'));

  const npmLog = join(shimDir, "npm.log");
  writeFileSync(
    join(shimDir, "npm"),
    ['#!/bin/sh', `printf '%s\\n' "$@" > ${JSON.stringify(npmLog)}`, "exit 0", ""].join("\n"),
  );
  chmodSync(join(shimDir, "npm"), 0o755);

  const pbossLog = join(shimDir, "pboss.log");
  writeFileSync(
    join(shimDir, "pboss"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(pbossLog)}`,
      'if [ "$1" = "--version" ]; then echo "pboss v1.6.8"; exit 0; fi',
      'if [ "$1" = "resurrect" ] || [ "$1" = "startup" ]; then',
      `  ( env PBOSS_HOME=${JSON.stringify(join(home, ".pboss"))} HOME=${JSON.stringify(home)} \\`,
      `      node ${JSON.stringify(DIST_CLI)} __daemon >> ${JSON.stringify(join(shimDir, "new-daemon.log"))} 2>&1 & )`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(shimDir, "pboss"), 0o755);

  return {
    env: {
      ...process.env,
      HOME: home,
      PBOSS_HOME: join(home, ".pboss"),
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      TERM: "dumb",
      SUDO_USER: "",
    } as Record<string, string>,
    oldCli: join(pkg, "dist", "cli.js"),
    npmLog,
    pbossLog,
  };
}

describe("issue #41 e2e: pboss upgrade realigns the daemon (old dist, fake channel)", () => {
  test.skipIf(process.platform === "win32" || !DIST_BUILT || !NODE_BIN)(
    "no boot service: stop the old daemon, run the NEW pboss resurrect, verify",
    async () => {
      // The registry decides whether an upgrade is even due — skip
      // visibly (never fail) on a machine without network.
      const reachable = await fetch("https://registry.npmjs.org/pboss/latest", {
        signal: AbortSignal.timeout(8_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      const latest = reachable
        ? ((await (await fetch("https://registry.npmjs.org/pboss/latest")).json()) as { version: string }).version
        : null;
      if (!latest || "1.6.6" >= latest) {
        console.log(`(skip) registry latest ${latest ?? "unreachable"} — the old-shaped 1.6.6 would not upgrade`);
        return;
      }

      const home = mkdtempSync(join(tmpdir(), "pboss-d41-upg-"));
      homes.push(home);
      const { env, oldCli, npmLog, pbossLog } = makeUpgradeHarness(home, false);

      // The old-code daemon, running from the old-shaped install.
      const daemon = Bun.spawn([NODE_BIN!, oldCli, "__daemon"], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      expect(await waitResponsive(home)).toBeTrue();
      const oldPid = pidOf(home);

      const up = Bun.spawn([NODE_BIN!, oldCli, "upgrade", "-y", "--channel", "npm"], {
        env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const upr = await drain(up);
      const text = stripAnsi(upr.out + upr.err);
      expect(await up.exited).toBe(0);

      // The upgrade executed its channel command (the fake npm).
      expect(readFileSync(npmLog, "utf8").trim().split("\n")).toContain("install");

      // THE REALIGN (issue #41 §3): the old daemon was stopped…
      expect(text).toContain("Stopping the old daemon");
      let oldStillAlive = true;
      try { process.kill(oldPid, 0); } catch { oldStillAlive = false; }
      expect(oldStillAlive).toBe(false);
      await daemon.exited;

      // …the NEW pboss was invoked to bring the daemon back (no service:
      // resurrect)…
      expect(readFileSync(pbossLog, "utf8")).toContain("resurrect");
      expect(readFileSync(pbossLog, "utf8")).not.toContain("startup");

      // …and a daemon answering on the new code is verified and reported.
      expect(await waitResponsive(home)).toBeTrue();
      const newPid = pidOf(home);
      expect(newPid).not.toBe(oldPid);
      expect(text).toContain("Daemon restarted onto the new code");
    },
    150_000,
  );

  test.skipIf(process.platform === "win32" || !DIST_BUILT || !NODE_BIN)(
    "with a boot service: the NEW pboss reinstalls it (startup install), never a bare resurrect",
    async () => {
      const reachable = await fetch("https://registry.npmjs.org/pboss/latest", {
        signal: AbortSignal.timeout(8_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      const latest = reachable
        ? ((await (await fetch("https://registry.npmjs.org/pboss/latest")).json()) as { version: string }).version
        : null;
      if (!latest || "1.6.6" >= latest) {
        console.log(`(skip) registry latest ${latest ?? "unreachable"} — the old-shaped 1.6.6 would not upgrade`);
        return;
      }

      const home = mkdtempSync(join(tmpdir(), "pboss-d41-upgsvc-"));
      homes.push(home);
      const { env, oldCli, pbossLog } = makeUpgradeHarness(home, true);

      const daemon = Bun.spawn([NODE_BIN!, oldCli, "__daemon"], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      expect(await waitResponsive(home)).toBeTrue();
      const oldPid = pidOf(home);

      const up = Bun.spawn([NODE_BIN!, oldCli, "upgrade", "-y", "--channel", "npm"], {
        env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const upr = await drain(up);
      const text = stripAnsi(upr.out + upr.err);
      expect(await up.exited).toBe(0);

      // With a unit installed, the realign goes through `pboss startup
      // install` — the unit regenerates from the NEW install and the
      // daemon restarts through the manager. A bare resurrect would
      // leave the OLD unit pointing at the replaced install.
      expect(readFileSync(pbossLog, "utf8")).toContain("startup install");
      expect(text).toContain("Stopping the old daemon");
      let oldStillAlive = true;
      try { process.kill(oldPid, 0); } catch { oldStillAlive = false; }
      expect(oldStillAlive).toBe(false);
      await daemon.exited;

      expect(await waitResponsive(home)).toBeTrue();
      expect(pidOf(home)).not.toBe(oldPid);
      expect(text).toContain("Daemon restarted onto the new code");
    },
    150_000,
  );
});
