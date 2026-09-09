import { describe, test, expect, afterAll } from "bun:test";
import { bringUpSystemdUnit } from "../src/startup-manager";
import { probeDaemon } from "../src/daemon-probe";
import { stopDaemonIfRunning } from "../src/api";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * bringUpSystemdUnit — the post-unit-file half of `pboss startup install`.
 *
 * These tests reproduce the reported incident: "sudo pboss startup install
 * HANGS, even though /etc/systemd/system/pboss.service is created". The unit
 * file write succeeded; what never returned was the await on
 * `systemctl start pboss` — the start job stays pending forever because every
 * failed start cycle includes ExecStartPost polling (>=10s), so systemd's
 * default 5-starts/10s rate limiter never fills and Restart=on-failure loops
 * indefinitely.
 *
 * Real systemd is not required: systemctl/journalctl are resolved through
 * PATH, so each test installs a /bin/sh shim that plays systemd's role,
 * including the never-completing start job (a `start` WITHOUT --no-block
 * sleeps in the shim — the code must never invoke it that way).
 *
 * Each test uses hermetic homes: targetHome plays the SUDO_USER whose home
 * the unit's User= daemon owns; cliSocket points at a path nothing will ever
 * answer, so the runner's real ~/.pboss is never touched.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const SAVED_PATH = process.env.PATH;

const scratchDirs: string[] = [];
afterAll(() => {
  process.env.PATH = SAVED_PATH;
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function shq(value: string): string {
  return `"${value.replace(/(["\\`$])/g, "\\$1")}"`;
}

interface ShimScenario {
  /** What the shim's `is-active pboss` reports. */
  isActive: string;
  /** Extra behavior for the --no-block start invocation. */
  onStart?: string;
  /** Extra behavior for daemon-reload (e.g. `exit 1` to force the manual path). */
  onReload?: string;
}

/**
 * Install systemctl + journalctl + loginctl shims on PATH and return:
 *   dir   — the shim dir (also usable for the dead cliSocket path)
 *   log   — file every systemctl invocation is appended to, one line each
 */
function installShims(scenario: ShimScenario): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "pboss-shim-"));
  const log = join(dir, "systemctl.log");
  scratchDirs.push(dir);

  const onStart = scenario.onStart ?? "exit 0";
  const onReload = scenario.onReload ?? "exit 0";
  const systemctl = [
    "#!/bin/sh",
    `echo "$@" >> ${shq(log)}`,
    // --user invocations (the only kind install() makes now) are matched
    // by the same cases after stripping the flag; the log keeps the full
    // original argument list.
    'case "$1" in --user) shift ;; esac',
    `case "$*" in`,
    // A blocking start (no --no-block) is THE bug: the start job never
    // completes. If the code ever regresses to this form, the shim hangs
    // and the test's race converts it into a clean failure.
    `  "start pboss") exec sleep 30 ;;`,
    `  "--no-block start pboss") ${onStart} ;;`,
    `  "daemon-reload") ${onReload} ;;`,
    `  "enable pboss") exit 0 ;;`,
    `  "is-active pboss") echo ${shq(scenario.isActive)}; exit 3 ;;`,
    `  *) exit 0 ;;`,
    `esac`,
  ].join("\n");
  writeFileSync(join(dir, "systemctl"), systemctl);
  chmodSync(join(dir, "systemctl"), 0o755);

  const journalctl = [
    "#!/bin/sh",
    `echo "systemd-sim journal: pboss[4242]: daemon failed (simulated)"`,
    `exit 0`,
  ].join("\n");
  writeFileSync(join(dir, "journalctl"), journalctl);
  chmodSync(join(dir, "journalctl"), 0o755);

  // Linger always succeeds in the sim: bring-up should report "Linger: on".
  const loginctl = ["#!/bin/sh", "exit 0"].join("\n");
  writeFileSync(join(dir, "loginctl"), loginctl);
  chmodSync(join(dir, "loginctl"), 0o755);

  process.env.PATH = `${dir}:${SAVED_PATH}`;
  return { dir, log };
}

function readLog(log: string): string[] {
  try {
    return readFileSync(log, "utf-8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/** Hermetic home for the SUDO_USER the unit's daemon runs as. */
function makeTargetHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pboss-unit-user-"));
  scratchDirs.push(home);
  return home;
}

function optsFor(home: string, cliSocket: string, verifyTimeoutMs = 2_500) {
  return {
    // A USER unit: written under the target user's own config, brought up
    // through their user manager — the no-root path install() drives.
    servicePath: join(home, ".config", "systemd", "user", "pboss.service"),
    targetUser: "testy",
    targetHome: home,
    verifyTimeoutMs,
    cliSocket,
    userMode: true,
  };
}

/** Convert a would-be hang into a clean test failure with a real diagnosis. */
function withHangGuard<T>(p: Promise<T>, ms = 12_000): Promise<T> {
  return Promise.race([
    p,
    Bun.sleep(ms).then(() => {
      throw new Error(
        "bringUpSystemdUnit never returned — the blocking `systemctl start` hang is back"
      );
    }),
  ]);
}

describe("bringUpSystemdUnit — the install() hang", () => {
  test.skipIf(process.platform !== "linux")(
    "completes with an honest failure when the start job never completes",
    async () => {
      const { dir, log } = installShims({ isActive: "activating" });
      const home = makeTargetHome();
      const deadCliSocket = join(dir, "no-cli-daemon.sock");

      // The reported bug: unit file written, then nothing. Must return a
      // diagnostic (bounded by the verify deadline), never hang.
      const msg = await withHangGuard(
        bringUpSystemdUnit(optsFor(home, deadCliSocket))
      );

      expect(msg).toContain("is not healthy");
      expect(msg).toContain("activating");
      // The diagnosis includes the journal tail and how to inspect further
      // — through the USER manager, since the unit is a user unit.
      expect(msg).toContain("Recent unit output:");
      expect(msg).toContain("systemd-sim journal");
      expect(msg).toContain("journalctl --user -u pboss");

      // THE regression guard: start must be submitted --no-block, never
      // awaited as a blocking job. The shim's bare "start pboss" sleeps —
      // the hang guard would have caught any invocation of it.
      const calls = readLog(log);
      expect(calls).toContain("--user --no-block start pboss");
      expect(calls).not.toContain("start pboss");
      expect(calls).not.toContain("--no-block start pboss");
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "healthy unit: verifies against the TARGET user's socket and reports success",
    async () => {
      const home = makeTargetHome();
      const targetPboss = join(home, ".pboss");
      const unitSocket = join(targetPboss, "daemon.sock");
      // The shim plays ExecStart: on --no-block start it launches the REAL
      // daemon bound to the target user's PBOSS_HOME (as systemd would).
      const { dir, log } = installShims({
        isActive: "active",
        onStart: `PBOSS_HOME=${shq(targetPboss)} setsid bun run ${shq(CLI)} __daemon >/dev/null 2>&1 & exit 0`,
      });
      const deadCliSocket = join(dir, "no-cli-daemon.sock");

      try {
        const msg = await withHangGuard(
          bringUpSystemdUnit(optsFor(home, deadCliSocket, 20_000))
        );
        expect(msg).toContain("Service installed and started");
        // Healthy means the daemon on the UNIT's socket actually answers —
        // not just that is-active said "active" (Type=simple says that at
        // fork time, before any socket exists).
        expect(await probeDaemon(unitSocket)).not.toBeNull();
        expect(readLog(log)).toContain("--user --no-block start pboss");
        // User mode: linger is best-effort-enabled so the daemon runs from
        // BOOT, not just from the user's first login (loginctl is shimmed
        // to succeed — deterministic).
        expect(msg).toContain("Linger: on");
        expect(msg).not.toContain("sudo");
      } finally {
        // Leave no daemon behind.
        await stopDaemonIfRunning(10_000, unitSocket);
      }
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "stops a stray daemon on the TARGET user's socket before starting the unit",
    async () => {
      // The sudo incident class: `sudo pboss startup install` runs with the
      // CLI's socket at /root/.pboss, but the unit's daemon runs as the
      // SUDO_USER — a stray in THEIR home is what the unit's daemon would
      // collide with (EADDRINUSE -> exit 81 -> "Start request repeated too
      // quickly"). bringUp must ask it to stop.
      const home = makeTargetHome();
      const targetPboss = join(home, ".pboss");
      const unitSocket = join(targetPboss, "daemon.sock");

      const stray = Bun.spawn(["bun", "run", CLI, "__daemon"], {
        env: { ...process.env, PBOSS_HOME: targetPboss },
        stdout: "ignore",
        stderr: "ignore",
      });
      scratchDirs.push(home);

      try {
        // Wait for the stray to bind before exercising the bring-up.
        const bindDeadline = Date.now() + 15_000;
        while (Date.now() < bindDeadline) {
          if (await probeDaemon(unitSocket)) break;
          await Bun.sleep(200);
        }
        expect(await probeDaemon(unitSocket)).not.toBeNull();

        const { dir } = installShims({ isActive: "activating" });
        const deadCliSocket = join(dir, "no-cli-daemon.sock");
        const msg = await withHangGuard(
          bringUpSystemdUnit(optsFor(home, deadCliSocket))
        );

        // The stray was asked to exit BEFORE the unit start: the socket is
        // free for the unit's daemon to bind.
        expect(await probeDaemon(unitSocket)).toBeNull();
        expect(stray.exitCode).not.toBe(1);
        expect(msg).toContain("is not healthy"); // the shim started no daemon
      } finally {
        await stopDaemonIfRunning(10_000, unitSocket);
        stray.kill();
      }
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "systemd unavailable: falls back to the manual command list",
    async () => {
      const { dir } = installShims({ isActive: "activating", onReload: "exit 1" });
      const home = makeTargetHome();
      const deadCliSocket = join(dir, "no-cli-daemon.sock");

      const msg = await withHangGuard(
        bringUpSystemdUnit(optsFor(home, deadCliSocket, 1_500))
      );

      expect(msg).toContain("could not be");
      // The manual fallback drives the USER manager and needs no sudo.
      expect(msg).toContain("systemctl --user daemon-reload");
      expect(msg).not.toContain("sudo");
      // The fallback still names the unit start command.
      expect(msg).toMatch(/systemctl --user (start|daemon-reload|enable)/);
    },
    30_000
  );
});
