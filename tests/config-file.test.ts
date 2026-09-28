/**
 * Custom config/ecosystem file suite — `--config` drives EVERY command.
 *
 * The owner's ask: a custom js/ts config/ecosystem file, example
 *   pboss start --config ./any.js
 * must treat any.js as the CONFIG, never as the file to invoke — whatever
 * the file is called. `start --config` has honored that since issue #28;
 * this suite pins it and covers the extension to the fleet vocabulary:
 *   pboss restart --config ./any.js   (restarts the apps the file names)
 *   pboss stop     --config ./any.js
 *   pboss reload   --config ./any.js
 *   pboss delete   --config ./any.js
 * plus the PM2-parity positional form on fleet commands
 * (pboss restart ecosystem.config.js).
 *
 * Contract under test:
 *   - ANY file name works via the flag (any.js, conf.ts, mixed.config.js)
 *     in all three spellings: --config <file>, -c <file>, --config=<file>
 *   - the flag may sit anywhere (issue #34's position-independence rule)
 *   - fleet sweeps act on the app NAMES the file defines; a stopped app
 *     comes back on restart, an unregistered app is reported as a miss
 *     without blocking the sweep, and zero successes is a failure (exit 1)
 *   - a positional fleet target is only a config when it LOOKS like one
 *     (known extension .json or a conventional name pattern) — arbitrary
 *     names must go through the flag, exactly like start
 *   - static pins keep all five commands on the shared extractConfigFlag
 *
 * E2E cases run the real CLI (`bun run src/index.ts …`) on a fresh hermetic
 * PBOSS_HOME, exactly like the user's terminal (same harness as issue-28/34).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // cwd = home so RELATIVE config paths (./any.js) resolve exactly like
    // the user's terminal in the owner's repro.
    cwd: home,
  });
}

/**
 * Strip ANSI escapes (color/bold/dim) — the CLI's `color()` helper emits
 * them UNCONDITIONALLY, and a FORCE_COLOR env (set by the harness, the
 * user's shell, or CI) makes even the table borders carry escape codes.
 * Every text assertion therefore runs on STRIPPED output: adjacency checks
 * like `│ name │` or `fork <pid>` would otherwise break on the codes
 * wedged between the border and the cell (reproduced with FORCE_COLOR=1,
 * which failed exactly like the owner's machine did).
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { out: stripAnsi(out + err), code: code ?? 0 };
}

/** Kill the daemon (daemon-mode cases spawn one) and sweep app children. */
async function cleanup(home: string) {
  try {
    await runCli(["kill"], home);
  } catch {
    /* daemon never started */
  }
  try {
    const sweep = Bun.spawn(["pkill", "-f", home], { stdout: "ignore", stderr: "ignore" });
    await sweep.exited;
  } catch {
    /* pkill unavailable — best effort */
  }
  rmSync(home, { recursive: true, force: true });
}

async function freshHome(prefix: string): Promise<string> {
  return mkdtempSync(join(tmpdir(), `pboss-config-${prefix}-`));
}

/** A config with the given app names pointing at a shared sleep script. */
function writeConfig(home: string, file: string, names: string[]) {
  const script = join(home, "worker.js");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const body = names.map((n) => `{ name: ${JSON.stringify(n)}, script: "./worker.js" }`).join(", ");
  writeFileSync(join(home, file), `module.exports = { apps: [${body}] };\n`);
  return join(home, file);
}

/**
 * The pid the process table shows for `name` — STRUCTURAL, not regex:
 * the (already ANSI-stripped) row is split on the │ borders, and the pid
 * is read from its column (cells: id, name, namespace, version, mode,
 * pid, …). Returns undefined when the app is absent or shows no pid
 * (stopped rows print "-").
 */
function tablePid(out: string, name: string): number | undefined {
  for (const line of out.split("\n")) {
    if (!line.includes("│")) continue;
    const cells = line.split("│").map((c) => c.trim());
    if (cells[2] !== name) continue;
    const pid = parseInt(cells[6] ?? "");
    return Number.isFinite(pid) ? pid : undefined;
  }
  return undefined;
}

describe("custom config file — start --config: ANY file name, every spelling", () => {
  test("start --config ./any.js / -c / --config= all start the file's apps", async () => {
    const home = await freshHome("start");
    try {
      writeConfig(home, "any.js", ["cfg_probe_a", "cfg_probe_b"]);

      // The owner's exact repro: an ARBITRARY file name via the flag.
      const r1 = await runCli(["start", "--config", "./any.js"], home);
      expect(r1.code).toBe(0);
      expect(r1.out).toContain("cfg_probe_a");
      expect(r1.out).toContain("cfg_probe_b");
      expect(r1.out).toContain("online");

      // Short form.
      await runCli(["delete", "--config", "./any.js"], home);
      const r2 = await runCli(["start", "-c", "./any.js"], home);
      expect(r2.code).toBe(0);
      expect(r2.out).toContain("cfg_probe_a");

      // Equals form, and the flag AFTER other tokens.
      await runCli(["delete", "--config", "./any.js"], home);
      const r3 = await runCli(["start", "--config=./any.js"], home);
      expect(r3.code).toBe(0);
      expect(r3.out).toContain("cfg_probe_b");

      // Without the flag the same file is just a script to invoke — the
      // flag is what makes it a config (the owner's "instead of the file
      // to invoke" distinction). Executing any.js as a plain script runs
      // module.exports and exits; the apps it DEFINES never start.
      const r4 = await runCli(["start", "./any.js"], home);
      expect(r4.out).not.toContain("cfg_probe_a");
      expect(r4.out).not.toContain("cfg_probe_b");
    } finally {
      await cleanup(home);
    }
  }, 60_000);

  test("start --config with a .ts config file", async () => {
    const home = await freshHome("ts");
    try {
      writeConfig(home, "conf.ts", ["cfg_ts_probe"]);
      const r = await runCli(["start", "--config", "./conf.ts"], home);
      expect(r.code).toBe(0);
      expect(r.out).toContain("cfg_ts_probe");
      expect(r.out).toContain("online");
    } finally {
      await cleanup(home);
    }
  }, 60_000);
});

describe("custom config file — fleet commands sweep the file's apps", () => {
  test("restart --config: running apps restart with a NEW pid, stopped apps come back", async () => {
    const home = await freshHome("restart");
    try {
      writeConfig(home, "any.js", ["cfg_res"]);
      const s = await runCli(["start", "--config", "./any.js"], home);
      expect(s.code).toBe(0);
      const pid1 = tablePid(s.out, "cfg_res");
      expect(pid1).toBeGreaterThan(0);

      const r = await runCli(["restart", "--config", "./any.js"], home);
      expect(r.code).toBe(0);
      expect(r.out).toContain("✓ Restarted 1 app from ./any.js");
      expect(tablePid(r.out, "cfg_res")).toBeGreaterThan(0);
      expect(tablePid(r.out, "cfg_res")).not.toBe(pid1);

      // restart on a registered-but-stopped app starts it (restart's
      // existing name semantics, unchanged by the config path).
      await runCli(["stop", "cfg_res"], home);
      const r2 = await runCli(["restart", "--config", "./any.js"], home);
      expect(r2.code).toBe(0);
      expect(r2.out).toContain("online");
    } finally {
      await cleanup(home);
    }
  }, 60_000);

  test("restart --config: an unregistered app is a reported miss, not a blocker", async () => {
    const home = await freshHome("miss");
    try {
      writeConfig(home, "mixed.config.js", ["cfg_live", "cfg_ghost"]);
      await runCli(["start", "--config", "./mixed.config.js"], home);
      await runCli(["delete", "cfg_ghost"], home); // stale entry in the file

      const r = await runCli(["restart", "--config", "./mixed.config.js"], home);
      expect(r.code).toBe(0); // the live app was still restarted
      expect(r.out).toContain("✓ Restarted 1 app from ./mixed.config.js");
      expect(r.out).toContain("not registered, nothing to restart: cfg_ghost");
    } finally {
      await cleanup(home);
    }
  }, 60_000);

  test("stop / reload / delete --config operate on the whole file", async () => {
    const home = await freshHome("fleet");
    try {
      writeConfig(home, "any.js", ["cfg_f1", "cfg_f2"]);
      await runCli(["start", "--config", "./any.js"], home);

      const st = await runCli(["stop", "--config", "./any.js"], home);
      expect(st.code).toBe(0);
      expect(st.out).toContain("✓ Stopped 2 apps from ./any.js");
      expect(st.out).toContain("stopped");

      const rl = await runCli(["reload", "--config", "./any.js"], home);
      expect(rl.code).toBe(0);
      expect(rl.out).toContain("✓ Reloaded 2 apps from ./any.js");
      expect(rl.out).toContain("online");

      const dl = await runCli(["delete", "--config", "./any.js", "--force"], home);
      expect(dl.code).toBe(0);
      expect(dl.out).toContain("✓ Deleted 2 apps from ./any.js");
      const ls = await runCli(["list"], home);
      expect(ls.out).toContain("No processes running");
    } finally {
      await cleanup(home);
    }
  }, 120_000);

  test("fleet --config with nothing registered fails honestly with the start hint", async () => {
    const home = await freshHome("empty-fleet");
    try {
      writeConfig(home, "any.js", ["cfg_none"]);
      const r = await runCli(["restart", "--config", "./any.js"], home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("none of the apps in ./any.js are registered");
      expect(r.out).toContain("pboss start --config ./any.js");
    } finally {
      await cleanup(home);
    }
  }, 60_000);

  test("positional fleet targets: conventional names and .json work (PM2 parity)", async () => {
    const home = await freshHome("positional");
    try {
      writeConfig(home, "ecosystem.config.js", ["cfg_pos"]);
      writeFileSync(
        join(home, "fleet.config.json"),
        JSON.stringify({ apps: [{ name: "cfg_json", script: "./worker.js" }] })
      );

      const s = await runCli(["start", "ecosystem.config.js"], home);
      expect(s.code).toBe(0);

      const r = await runCli(["restart", "ecosystem.config.js"], home);
      expect(r.code).toBe(0);
      expect(r.out).toContain("✓ Restarted 1 app from ecosystem.config.js");

      // A .json extension is a config on fleet commands too.
      const s2 = await runCli(["start", "--config", "./fleet.config.json"], home);
      expect(s2.code).toBe(0);
      const st = await runCli(["stop", "./fleet.config.json"], home);
      expect(st.code).toBe(0);
      expect(st.out).toContain("✓ Stopped 1 app from ./fleet.config.json");
    } finally {
      await cleanup(home);
    }
  }, 60_000);
});

describe("custom config file — failure paths stay honest", () => {
  test("missing value, missing file, and a file with no apps", async () => {
    const home = await freshHome("failures");
    try {
      writeConfig(home, "any.js", ["cfg_x"]);

      const noValue = await runCli(["start", "--config"], home);
      expect(noValue.code).toBe(1);
      expect(noValue.out).toContain("requires a config file path");

      const missing = await runCli(["start", "--config", "./nope.js"], home);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("Ecosystem file not found");

      writeFileSync(join(home, "bare.config.js"), "module.exports = { noDaemon: false };\n");
      const noApps = await runCli(["restart", "--config", "./bare.config.js"], home);
      expect(noApps.code).toBe(1);
      expect(noApps.out).toContain("defines no apps to restart");
    } finally {
      await cleanup(home);
    }
  }, 60_000);
});

describe("custom config file — static pins (all commands share the extraction)", () => {
  // index.ts has no import guard (it runs main() on import), so the wiring
  // is pinned textually, the same way readme.test.ts pins the docs.
  const src = readFileSync(CLI, "utf-8");

  test("start, stop, restart, reload and delete all route --config through extractConfigFlag", () => {
    // 5 command wirings + the helper's own definition.
    const uses = src.match(/extractConfigFlag\(args\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const cmd of ["async cmdStart(", "async cmdStop(", "async cmdRestart(", "async cmdReload(", "async cmdDelete("]) {
      expect(src).toContain(cmd);
    }
    for (const verb of ['"stop"', '"restart"', '"reload"', '"delete"']) {
      expect(src).toContain(`runFleetOnConfig(${verb}`);
    }
  });

  test("--config stays a value flag for start's target scan (issue #34 pin)", () => {
    expect(src).toContain('"--config", "-c",');
  });

  test("an arbitrary positional on a fleet command is NOT a config (flag required)", () => {
    // looksLikeEcosystemTarget must keep requiring the conventional hints
    // or a .json extension — ./any.js as a positional stays a process NAME.
    const fn = src.match(/function looksLikeEcosystemTarget[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn).toContain(".json");
    expect(fn).toContain("ECOSYSTEM_NAME_HINTS");
    const hints = src.match(/const ECOSYSTEM_NAME_HINTS = \[[\s\S]*?\];/)?.[0] ?? "";
    expect(hints).toContain('"ecosystem"');
    expect(hints).toContain('"pboss.config"');
  });
});
