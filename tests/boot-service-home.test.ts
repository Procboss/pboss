/**
 * Boot-service home scoping — the 54-failure regression, pinned.
 * (owner report 2026-10-08)
 *
 * THE BUG: `bootServiceKind()` answered "systemd" from the unit file's mere
 * EXISTENCE, but a unit pins its own PBOSS_HOME (Environment=…, written for
 * the installing user's ~/.pboss). On a machine with the user unit
 * installed, every CLI invocation against a DIFFERENT home — the e2e
 * suite's hermetic temp homes, or a user's PBOSS_HOME override — routed its
 * daemon "through the service": systemctl happily started the UNIT's-home
 * daemon, the CLI polled ITS OWN socket for the full 30s liveness budget,
 * and failed ("The daemon did not come up through systemd within 30s").
 * On the owner's machine that was 54 e2e failures at ~30s each; worse,
 * `pboss daemon stop` under a foreign home told the manager to stand down
 * the OTHER home's daemon.
 *
 * THE CONTRACT, pinned here:
 *   - a unit that pins a DIFFERENT home is invisible to this CLI's daemon
 *     lifecycle: launchDaemon spawns directly, `daemon stop/restart` never
 *     touch the manager, and systemctl is NEVER invoked (the shim log stays
 *     empty — the whole proof of this file)
 *   - a unit that pins THIS home keeps the full issue-#41 service path
 *     (pinned in daemon-startup.test.ts / issue-41.test.ts with realistic
 *     home-pinning unit fixtures)
 *   - the parsers read exactly what the generator writes (unit text, plist
 *     text) — including XML-escaped homes
 *   - static pin: the daemon-lifecycle decision sites (api.ts launchDaemon,
 *     index.ts daemon flows / realign / status facts) only ever consult the
 *     home-scoped kind — the raw bootServiceKind() can never sneak back in
 *
 * E2E cases run the real CLI on hermetic homes, exactly like the user's
 * terminal: HOME stays the REAL-looking fixture home holding the unit,
 * PBOSS_HOME points at a different hermetic home — the owner's exact
 * machine shape in miniature.
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync,
  symlinkSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { probeDaemon } from "../src/daemon-probe";
import {
  parseUnitPbossHome,
  parsePlistPbossHome,
  bootServiceControlsCurrentHome,
} from "../src/startup-manager";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "index.ts");

/* ── harness ─────────────────────────────────────────────────────────────── */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) {
    hardKillDaemon(h);
    rmSync(h, { recursive: true, force: true });
  }
});

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function socketOf(home: string): string {
  return join(home, "daemon.sock");
}

async function waitResponsive(home: string, timeoutMs = 20_000): Promise<boolean> {
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
  const pidFile = join(home, "daemon.pid");
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

/**
 * The owner's machine in miniature: a "real" HOME holding an installed
 * user unit (pinning ITS .pboss), while the CLI runs against a DIFFERENT
 * hermetic PBOSS_HOME — plus a systemctl shim on PATH that logs every
 * invocation. One look at the log settles whether the manager was ever
 * touched: the entire contract of this file is that it stays EMPTY.
 */
function foreignHomeMachine(): { unitHome: string; cliHome: string; shimDir: string; log: string; env: () => Record<string, string> } {
  const unitHome = mkdtempSync(join(tmpdir(), "pboss-fh-unit-"));
  const cliHome = mkdtempSync(join(tmpdir(), "pboss-fh-cli-"));
  const shimDir = mkdtempSync(join(tmpdir(), "pboss-fh-shim-"));
  homes.push(unitHome, cliHome, shimDir);

  // The installed unit — shaped like the generator's real output: it PINS
  // the home it serves.
  mkdirSync(join(unitHome, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(
    join(unitHome, ".config", "systemd", "user", "pboss.service"),
    `[Unit]\nDescription=ProcBoss Process Manager\n\n[Service]\nEnvironment=PBOSS_HOME=${join(unitHome, ".pboss")}\n`,
  );

  // The tell-tale shim: a healthy-looking manager (exit 0) that only logs.
  // OLD code, start path: accepts the start → waits 30s on the wrong
  // socket → throws. OLD code, stop path: stops the unit's (other home's)
  // daemon. NEW code: never invoked.
  const log = join(shimDir, "systemctl.log");
  writeFileSync(join(shimDir, "systemctl"), ["#!/bin/sh", `echo "$@" >> ${JSON.stringify(log)}`, "exit 0", ""].join("\n"));
  chmodSync(join(shimDir, "systemctl"), 0o755);

  const env = () => ({
    ...process.env,
    HOME: unitHome,
    PBOSS_HOME: cliHome,
    SUDO_USER: "",
    TERM: "dumb",
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
  });
  return { unitHome, cliHome, shimDir, log, env };
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

/** `pboss kill` through the CLI — clean teardown (apps stop, files swept). */
async function cliKill(env: Record<string, string>) {
  const p = spawnCli(["kill"], env);
  await drain(p);
  await p.exited;
}

/* ── unit: the parsers read exactly what the generator writes ───────────── */

describe("boot-service home: parseUnitPbossHome (the generator's unit text)", () => {
  test("the real generated shape yields the pinned home", () => {
    const text = [
      "[Unit]",
      "Description=ProcBoss Process Manager",
      "",
      "[Service]",
      "Environment=PATH=/usr/local/bin:/usr/bin",
      "Environment=PBOSS_HOME=/home/ra/.pboss",
      "Restart=always",
      "",
    ].join("\n");
    expect(parseUnitPbossHome(text)).toBe("/home/ra/.pboss");
  });

  test("a unit WITHOUT the pinned home is unverifiable — null", () => {
    expect(parseUnitPbossHome("[Unit]\n[Service]\nRestart=always\n")).toBeNull();
    expect(parseUnitPbossHome("")).toBeNull();
  });

  test("surrounding whitespace is trimmed, not part of the home", () => {
    expect(parseUnitPbossHome("[Service]\nEnvironment=PBOSS_HOME= /srv/x/.pboss \n")).toBe("/srv/x/.pboss");
  });
});

describe("boot-service home: parsePlistPbossHome (the generator's plist text)", () => {
  test("the real generated shape yields the pinned home", () => {
    const plist = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\"><dict>",
      "    <key>Label</key><string>com.pboss.daemon</string>",
      "    <key>EnvironmentVariables</key><dict>",
      "        <key>PBOSS_HOME</key>",
      "        <string>/Users/ra/.pboss</string>",
      "    </dict>",
      "</dict></plist>",
    ].join("\n");
    expect(parsePlistPbossHome(plist)).toBe("/Users/ra/.pboss");
  });

  test("XML-escaped homes unescape before comparing (escapeXml's reverse)", () => {
    const plist = "<key>PBOSS_HOME</key><string>/srv/a&amp;b/.pboss</string>";
    expect(parsePlistPbossHome(plist)).toBe("/srv/a&b/.pboss");
  });

  test("a plist without the key is unverifiable — null", () => {
    expect(parsePlistPbossHome("<plist><dict><key>Label</key><string>x</string></dict></plist>")).toBeNull();
  });
});

/* ── unit: the predicate, fixture-driven (Linux unit dir) ──────────────── */

describe("boot-service home: bootServiceControlsCurrentHome (fixtures)", () => {
  const savedHome = process.env.PBOSS_HOME;

  afterAll(() => {
    if (savedHome === undefined) delete process.env.PBOSS_HOME;
    else process.env.PBOSS_HOME = savedHome;
  });

  function makeUnitDir(pinnedHome: string | null): string {
    const unitDir = mkdtempSync(join(tmpdir(), "pboss-homescope-"));
    homes.push(unitDir);
    if (pinnedHome !== null) {
      writeFileSync(
        join(unitDir, "pboss.service"),
        `[Unit]\n[Service]\nEnvironment=PBOSS_HOME=${pinnedHome}\n`,
      );
    }
    return unitDir;
  }

  test.skipIf(process.platform === "win32")(
    "a unit pinning the CLI's home: the service controls it",
    async () => {
      const mine = mkdtempSync(join(tmpdir(), "pboss-mine-"));
      homes.push(mine);
      process.env.PBOSS_HOME = mine;
      try {
        expect(await bootServiceControlsCurrentHome({ unitDir: makeUnitDir(mine) })).toBeTrue();
        // Trailing separators are cosmetic.
        expect(await bootServiceControlsCurrentHome({ unitDir: makeUnitDir(`${mine}/`) })).toBeTrue();
      } finally {
        if (savedHome === undefined) delete process.env.PBOSS_HOME;
        else process.env.PBOSS_HOME = savedHome;
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a unit pinning a DIFFERENT home: it does not (the 54-failure shape)",
    async () => {
      const mine = mkdtempSync(join(tmpdir(), "pboss-mine2-"));
      const other = mkdtempSync(join(tmpdir(), "pboss-other-"));
      homes.push(mine, other);
      process.env.PBOSS_HOME = mine;
      try {
        expect(await bootServiceControlsCurrentHome({ unitDir: makeUnitDir(other) })).toBeFalse();
      } finally {
        if (savedHome === undefined) delete process.env.PBOSS_HOME;
        else process.env.PBOSS_HOME = savedHome;
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "unverifiable answers false: no pinned home, no unit, unreadable path",
    async () => {
      const mine = mkdtempSync(join(tmpdir(), "pboss-mine3-"));
      homes.push(mine);
      process.env.PBOSS_HOME = mine;
      try {
        // A unit without the Environment line.
        expect(await bootServiceControlsCurrentHome({ unitDir: makeUnitDir(null) })).toBeFalse();
        // No unit at all.
        const empty = mkdtempSync(join(tmpdir(), "pboss-empty-"));
        homes.push(empty);
        expect(await bootServiceControlsCurrentHome({ unitDir: empty })).toBeFalse();
      } finally {
        if (savedHome === undefined) delete process.env.PBOSS_HOME;
        else process.env.PBOSS_HOME = savedHome;
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "symlinked spellings of the same home still match (realpath comparison)",
    async () => {
      const real = mkdtempSync(join(tmpdir(), "pboss-real-"));
      const linkParent = mkdtempSync(join(tmpdir(), "pboss-link-"));
      const link = join(linkParent, "aliased");
      symlinkSync(real, link);
      homes.push(real, linkParent);
      process.env.PBOSS_HOME = link;
      try {
        // The unit pins the REAL path; the CLI spells it through the alias.
        expect(await bootServiceControlsCurrentHome({ unitDir: makeUnitDir(real) })).toBeTrue();
      } finally {
        if (savedHome === undefined) delete process.env.PBOSS_HOME;
        else process.env.PBOSS_HOME = savedHome;
      }
    },
  );
});

/* ── e2e: the owner's machine shape — unit exists, serves ANOTHER home ──── */

describe("boot-service home e2e: a foreign-home unit is invisible to the daemon lifecycle", () => {
  test.skipIf(process.platform === "win32")(
    "pboss start (implicit launchDaemon) spawns DIRECTLY — no systemctl, no 30s burn, exit 0",
    async () => {
      const { cliHome, log, env } = foreignHomeMachine();

      // A real app to start (this brings the daemon up on demand — the
      // exact path the 54 failures ran through).
      const appDir = mkdtempSync(join(tmpdir(), "pboss-fh-app-"));
      homes.push(appDir);
      writeFileSync(join(appDir, "server.js"), "setInterval(() => {}, 1000);\n");

      const t0 = Date.now();
      const p = spawnCli(["start", "./server.js", "--name", "fh-app"], env(), appDir);
      const { out, err } = await drain(p);
      const code = await p.exited;
      const elapsed = Date.now() - t0;

      // OLD code: systemctl invoked, then a full 30s liveness wait on the
      // wrong socket, then "The daemon did not come up through systemd
      // within 30s" and exit 1.
      expect(code).toBe(0);
      expect(stripAnsi(out)).toContain("fh-app");
      expect(stripAnsi(err)).not.toContain("did not come up");
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(""); // the manager was NEVER touched
      expect(await waitResponsive(cliHome)).toBeTrue(); // THIS home's daemon
      // The direct-spawn signature: only that path creates the log sinks.
      expect(existsSync(join(cliHome, "daemon.out.log"))).toBeTrue();
      // The fix's whole point: no liveness budget burned.
      expect(elapsed).toBeLessThan(20_000);

      await cliKill(env());
      expect(await waitGone(cliHome)).toBeTrue();
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "pboss daemon stop NEVER stands down the other home's service",
    async () => {
      const { cliHome, log, env } = foreignHomeMachine();

      // A daemon on THIS home (direct spawn — proven above).
      const s = spawnCli(["daemon", "start"], env());
      await drain(s);
      await s.exited;
      expect(await waitResponsive(cliHome)).toBeTrue();

      // OLD code side effect: `systemctl --user stop pboss` — stopping the
      // UNIT's (other home's) daemon, invisible to this CLI's socket.
      const p = spawnCli(["daemon", "stop"], env());
      const { out } = await drain(p);
      expect(await p.exited).toBe(0);
      expect(stripAnsi(out)).toContain("Daemon stopped");
      expect(await waitGone(cliHome)).toBeTrue();
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(""); // the manager was NEVER touched
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "pboss daemon restart stops-then-spawns directly — the manager stays out of it",
    async () => {
      const { cliHome, log, env } = foreignHomeMachine();

      const s = spawnCli(["daemon", "start"], env());
      await drain(s);
      await s.exited;
      expect(await waitResponsive(cliHome)).toBeTrue();
      const pid1 = parseInt(readFileSync(join(cliHome, "daemon.pid"), "utf8").trim());

      const p = spawnCli(["daemon", "restart"], env());
      const { out } = await drain(p);
      expect(await p.exited).toBe(0);
      expect(stripAnsi(out)).toContain("Daemon restarted");
      expect(await waitResponsive(cliHome)).toBeTrue();
      const pid2 = parseInt(readFileSync(join(cliHome, "daemon.pid"), "utf8").trim());
      expect(pid2).not.toBe(pid1); // a NEW daemon, not the survivor
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(""); // the manager was NEVER touched

      await cliKill(env());
      expect(await waitGone(cliHome)).toBeTrue();
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "pboss daemon status scopes Service: to this home — none, not the other home's manager",
    async () => {
      const { cliHome, env } = foreignHomeMachine();

      const s = spawnCli(["daemon", "start"], env());
      await drain(s);
      await s.exited;
      expect(await waitResponsive(cliHome)).toBeTrue();

      const p = spawnCli(["daemon", "status"], env());
      const { out } = await drain(p);
      expect(await p.exited).toBe(0);
      const text = stripAnsi(out);
      expect(text).toContain("Daemon:    running");
      // The unit IS installed on this machine — but not for THIS home.
      expect(text).toContain("Service:   none");

      await cliKill(env());
      expect(await waitGone(cliHome)).toBeTrue();
    },
    60_000,
  );
});

/* ── static pin: the lifecycle sites only ask the home-scoped kind ─────── */

describe("boot-service home: static pins (the decision sites stay home-scoped)", () => {
  test("api.ts and index.ts never consult the RAW bootServiceKind()", async () => {
    const read = async (f: string) =>
      (await Bun.file(join(REPO, "src", f)).text());
    for (const f of ["api.ts", "index.ts"]) {
      const text = await read(f);
      const uses = text.match(/bootServiceKindForCurrentHome|bootServiceKind\b/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) {
        // Every mention is the scoped variant (the raw name never appears
        // without the ForCurrentHome suffix).
        expect(u.startsWith("bootServiceKindForCurrentHome")).toBe(true);
      }
    }
  });

  test("index.ts never consults the RAW bootServiceInstalled() — the hint too", async () => {
    const text = await Bun.file(join(REPO, "src", "index.ts")).text();
    const uses =
      text.match(/bootServiceInstalledForCurrentHome|bootServiceInstalled\b/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      // A unit pinned to another home must not buy a false "persistence
      // on" hint — the scoped presence answers for THIS home only.
      expect(u.startsWith("bootServiceInstalledForCurrentHome")).toBe(true);
    }
  });

  test("the generator writes the pinned home into every unit it can produce", () => {
    // Source-text pin: the unit template must keep embedding
    // Environment=PBOSS_HOME — the whole scoping contract reads that line.
    const text = readFileSync(join(REPO, "src", "startup-manager.ts"), "utf8");
    expect(text).toContain("Environment=PBOSS_HOME=${");
  });
});
