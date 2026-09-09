/**
 * Issue #28 regression suite — the `noDaemon` option in a config file must
 * behave exactly like the `--no-daemon` CLI flag.
 * https://github.com/Procboss/pboss/issues/28
 *
 * Reproduction from the issue:
 *   procboss.config.js:  `module.exports = { noDaemon: true }`
 *   `procboss start --config procboss.config.js`
 *
 * Before the fix this started a background DAEMON and executed the config
 * file itself as a plain script: the `--config` flag was not recognized, its
 * VALUE was mistaken for the positional target, and `procboss.config.js`
 * did not match the config-file name detection — so every option inside
 * the file (`noDaemon` included) was silently ignored.
 *
 * These tests run the real CLI (`bun run src/index.ts …`) on a fresh
 * hermetic PBOSS_HOME, exactly like the user's terminal.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEcosystemConfig } from "../src/api";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // cwd = home so RELATIVE config paths resolve exactly like the user's
    // terminal in the issue repro (`start --config procboss.config.js`).
    cwd: home,
  });
}

/**
 * Incrementally capture a subprocess's stdout/stderr so output can be
 * inspected WHILE the process is still alive (a foreground start blocks
 * forever — awaiting `Response.text()` would deadlock).
 */
function capture(proc: Bun.Subprocess) {
  const dec = new TextDecoder();
  const state = { out: "", err: "" };
  const drain = async (stream: unknown, key: "out" | "err") => {
    // Bun types stdout/stderr as fd | ReadableStream | undefined — only the
    // stream form is readable here (we spawned with "pipe").
    if (!stream || typeof stream !== "object") return;
    try {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        state[key] += dec.decode(value);
      }
    } catch {
      /* stream torn down by kill() */
    }
  };
  const done = Promise.all([drain(proc.stdout, "out"), drain(proc.stderr, "err")]);
  return {
    outText: () => state.out,
    errText: () => state.err,
    done,
  };
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
  const cap = capture(proc);
  await proc.exited;
  await cap.done;
  return { out: cap.outText(), err: cap.errText(), code: proc.exitCode ?? 0 };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freshHome(prefix: string): Promise<string> {
  return mkdtempSync(join(tmpdir(), `pboss-issue28-${prefix}-`));
}

/** An app script that stays alive, so the supervisor has something to run. */
function writeApp(home: string, name = "web.ts") {
  const script = join(home, name);
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  return script;
}

/** Kill the CLI proc, then sweep any orphaned children by unique home path. */
async function cleanup(home: string, procs: Bun.Subprocess[] = []) {
  for (const proc of procs) {
    try {
      proc.kill();
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
  // The app children reference scripts inside `home`, whose path is unique
  // per test — pkill -f on that path reaches exactly our orphans.
  try {
    const sweep = Bun.spawn(["pkill", "-f", home], { stdout: "ignore", stderr: "ignore" });
    await sweep.exited;
  } catch {
    /* pkill unavailable — best effort */
  }
  // Sweep any daemon (only spawned by the daemon-mode regression case).
  try {
    await runCli(["kill"], home);
  } catch {
    /* daemon never started */
  }
  rmSync(home, { recursive: true, force: true });
}

/**
 * Run `pboss start …` and verify the foreground contract from the issue:
 * the CLI keeps running (blocks), the app from the config is started, and
 * NO daemon is spawned (no daemon.sock / daemon.pid in the hermetic home).
 */
async function expectForegroundStart(args: string[], home: string, app: string) {
  const proc = spawnCli(args, home);
  const cap = capture(proc);

  try {
    // Wait until the CLI has started the app (bounded), then verify it is
    // still alive — a foreground start must block, not exit.
    const dump = join(home, "dump.json");
    let started = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (existsSync(dump)) {
        try {
          const entries = JSON.parse(readFileSync(dump, "utf-8")) as any[];
          started = entries.some((e) => (e.config?.name ?? e.name) === app);
        } catch {
          /* mid-write — retry */
        }
      }
      if (started) break;
      await Bun.sleep(50);
    }
    // The process table prints after the dump is written — wait for it too.
    const tableDeadline = Date.now() + 10_000;
    while (Date.now() < tableDeadline && !cap.outText().includes(app)) {
      if (!isRunning(proc.pid)) break; // exited early — assertions below fail
      await Bun.sleep(50);
    }
    expect(started).toBe(true);
    expect(isRunning(proc.pid)).toBe(true);

    // The daemon must NOT have been spawned: foreground mode hosts the
    // supervisor inside the CLI process itself.
    expect(existsSync(join(home, "daemon.sock"))).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    // The config was honored (the app from the file is running) and the CLI
    // did not treat the config as a script or complain about unknown flags.
    expect(cap.outText()).toContain(app);
    expect(cap.outText()).not.toContain("procboss.config");
    expect(cap.errText()).not.toContain("Unknown flag");
  } finally {
    // Always tear down — a failed assertion must not leak processes.
    await cleanup(home, [proc]);
    await cap.done;
  }
}

describe("Issue #28 — noDaemon from the config file", () => {
  test("loadEcosystemConfig defaults a missing apps array to []", async () => {
    const home = await freshHome("unit");
    try {
      const configPath = join(home, "procboss.config.js");
      // The issue's exact minimal example: top-level option only, no apps.
      writeFileSync(configPath, "module.exports = { noDaemon: true };\n");
      const config = await loadEcosystemConfig(configPath);
      expect(config.noDaemon).toBe(true);
      expect(Array.isArray(config.apps)).toBe(true);
      expect(config.apps).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(
    "start --config procboss.config.js honors noDaemon (the issue's exact repro)",
    async () => {
      const home = await freshHome("flag");
      const app = writeApp(home);
      writeFileSync(
        join(home, "procboss.config.js"),
        `module.exports = { noDaemon: true, apps: [{ name: "web", script: ${JSON.stringify(app)} }] };\n`
      );
      await expectForegroundStart(["start", "--config", "procboss.config.js"], home, "web");
    },
    90000
  );

  test(
    "start --config=<file> (equals form) honors noDaemon",
    async () => {
      const home = await freshHome("eq");
      const app = writeApp(home);
      writeFileSync(
        join(home, "procboss.json"),
        `{ "noDaemon": true, "apps": [{ "name": "web", "script": ${JSON.stringify(app)} }] }\n`
      );
      await expectForegroundStart(["start", "--config=procboss.json"], home, "web");
    },
    90000
  );

  test(
    "start procboss.config.js (positional) is detected as a config, not a script",
    async () => {
      const home = await freshHome("pos");
      const app = writeApp(home);
      writeFileSync(
        join(home, "procboss.config.js"),
        `module.exports = { noDaemon: true, apps: [{ name: "web", script: ${JSON.stringify(app)} }] };\n`
      );
      await expectForegroundStart(["start", "procboss.config.js"], home, "web");
    },
    90000
  );

  test(
    "per-app noDaemon (documented under Process options) switches to foreground",
    async () => {
      const home = await freshHome("perapp");
      const app = writeApp(home);
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "web", script: ${JSON.stringify(app)}, noDaemon: true }] };\n`
      );
      await expectForegroundStart(["start", "ecosystem.config.js"], home, "web");
    },
    90000
  );

  test(
    "a config with only noDaemon and no apps starts (and blocks) without crashing",
    async () => {
      const home = await freshHome("minimal");
      writeFileSync(join(home, "minimal.config.js"), "module.exports = { noDaemon: true };\n");
      const proc = spawnCli(["start", "--config", "minimal.config.js"], home);
      const cap = capture(proc);

      // Give the CLI a moment; it must stay alive (foreground) and not crash
      // with the old "undefined is not an object (evaluating 'config.apps.map')".
      await Bun.sleep(2500);
      try {
        expect(isRunning(proc.pid)).toBe(true);
        expect(cap.errText()).not.toContain("config.apps.map");
        expect(cap.errText()).not.toContain("Error:");
        expect(existsSync(join(home, "daemon.sock"))).toBe(false);
      } finally {
        await cleanup(home, [proc]);
        await cap.done;
      }
    },
    90000
  );

  test("--config without a value fails with a clear error", async () => {
    const home = await freshHome("noval");
    try {
      const res = await runCli(["start", "--config"], home);
      expect(res.code).toBe(1);
      expect(res.err).toContain("--config requires a config file path");
    } finally {
      await cleanup(home);
    }
  });

  test(
    "regression: a config WITHOUT noDaemon still runs in daemon mode and returns",
    async () => {
      const home = await freshHome("daemonmode");
      const app = writeApp(home);
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "web", script: ${JSON.stringify(app)} }] };\n`
      );
      try {
        const res = await runCli(["start", "ecosystem.config.js"], home);
        expect(res.code).toBe(0);
        expect(res.out).toContain("web");
        // Daemon mode: the CLI returned, the daemon socket exists.
        expect(existsSync(join(home, "daemon.sock"))).toBe(true);
      } finally {
        await cleanup(home);
      }
    },
    90000
  );

  test(
    "regression: --no-daemon on a plain script start still blocks in foreground",
    async () => {
      const home = await freshHome("cliflag");
      const app = writeApp(home, "direct.ts");
      const proc = spawnCli(["start", app, "--name", "direct", "--no-daemon"], home);
      const cap = capture(proc);

      try {
        const dump = join(home, "dump.json");
        const deadline = Date.now() + 20_000;
        let started = false;
        while (Date.now() < deadline) {
          if (existsSync(dump)) {
            try {
              const entries = JSON.parse(readFileSync(dump, "utf-8")) as any[];
              started = entries.some((e) => (e.config?.name ?? e.name) === "direct");
            } catch {
              /* mid-write */
            }
          }
          if (started) break;
          await Bun.sleep(50);
        }
        expect(started).toBe(true);
        expect(isRunning(proc.pid)).toBe(true);
        expect(existsSync(join(home, "daemon.sock"))).toBe(false);
        // The process table prints after the dump — wait for it (see helper).
        const tableDeadline = Date.now() + 10_000;
        while (Date.now() < tableDeadline && !cap.outText().includes("direct")) {
          if (!isRunning(proc.pid)) break; // exited early — assertion below fails
          await Bun.sleep(50);
        }
        expect(cap.outText()).toContain("direct");
      } finally {
        await cleanup(home, [proc]);
        await cap.done;
      }
    },
    90000
  );
});
