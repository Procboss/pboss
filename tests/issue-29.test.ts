/**
 * Issue #29 regression suite — `pboss start` with no target auto-detects a
 * config file in the current working directory.
 * https://github.com/Procboss/pboss/issues/29
 *
 * Priority order (first existing file wins):
 *   ecosystem.config.{json,js,ts} > pboss.config.{json,js,ts} >
 *   bm2.config.{json,js,ts} > pm2.config.{json,js,ts}
 *
 * The contract under test:
 *   - bare `pboss start` loads the FIRST candidate in that order
 *   - an explicit target always wins (script start, explicit config, or a
 *     name/namespace resume target — issue #27 behavior is untouched)
 *   - when no config is found the start falls through to the normal
 *     resolution flow, and only errors — with the issue's exact guidance
 *     text — when nothing at all can be resolved
 *
 * E2E cases run the real CLI (`bun run src/index.ts …`) on a fresh hermetic
 * PBOSS_HOME, exactly like the user's terminal (same harness as issue-28).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_FILE_CANDIDATES, findDefaultConfigFile, loadEcosystemConfig } from "../src/api";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // cwd = home so auto-detection scans exactly the directory the user's
    // terminal would be in.
    cwd: home,
  });
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
  const dec = new TextDecoder();
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { out, err, code: code ?? 0 };
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
  return mkdtempSync(join(tmpdir(), `pboss-issue29-${prefix}-`));
}

/** An app script that stays alive, so the supervisor has something to run. */
function writeApp(home: string, name = "web.ts") {
  const script = join(home, name);
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  return script;
}

/** Names that actually ended up in the daemon's dump.json. */
function dumpNames(home: string): string[] {
  const dump = join(home, "dump.json");
  if (!existsSync(dump)) return [];
  try {
    const entries = JSON.parse(readFileSync(dump, "utf-8")) as any[];
    return entries.map((e) => e.config?.name ?? e.name).filter((n) => n !== undefined);
  } catch {
    return []; // mid-write — callers poll where it matters
  }
}

/** Wait until dump.json contains `name` (bounded). */
async function waitForDumpEntry(home: string, name: string, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (dumpNames(home).includes(name)) return true;
    await Bun.sleep(50);
  }
  return dumpNames(home).includes(name);
}

/** The config files the issue lists, as the exact strings it lists them. */
const JS = (app: string) => `module.exports = { apps: [{ name: ${JSON.stringify(app)} }] };\n`;
const TS = (app: string) => `export default { apps: [{ name: ${JSON.stringify(app)} }] };\n`;
const JSON_CFG = (app: string) => `{ "apps": [{ "name": ${JSON.stringify(app)} }] }\n`;

describe("Issue #29 — unit: candidate order and detection", () => {
  test("CONFIG_FILE_CANDIDATES is the issue's exact 12-file priority list", () => {
    expect([...CONFIG_FILE_CANDIDATES]).toEqual([
      "ecosystem.config.json",
      "ecosystem.config.js",
      "ecosystem.config.ts",
      "pboss.config.json",
      "pboss.config.js",
      "pboss.config.ts",
      "bm2.config.json",
      "bm2.config.js",
      "bm2.config.ts",
      "pm2.config.json",
      "pm2.config.js",
      "pm2.config.ts",
    ]);
  });

  test("the issue's example: ecosystem.config.js beats pboss.config.json and pm2.config.js", async () => {
    const home = await freshHome("unit-example");
    try {
      writeFileSync(join(home, "ecosystem.config.js"), JS("eco"));
      writeFileSync(join(home, "pboss.config.json"), JSON_CFG("pboss"));
      writeFileSync(join(home, "pm2.config.js"), JS("pm2"));
      expect(await findDefaultConfigFile(home)).toBe(join(home, "ecosystem.config.js"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no ecosystem: pboss.config.json is used, as the issue specifies", async () => {
    const home = await freshHome("unit-fallback");
    try {
      writeFileSync(join(home, "pboss.config.json"), JSON_CFG("pboss"));
      expect(await findDefaultConfigFile(home)).toBe(join(home, "pboss.config.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("extension priority within a prefix: .json > .js > .ts", async () => {
    const home = await freshHome("unit-ext");
    try {
      writeFileSync(join(home, "ecosystem.config.ts"), TS("ts"));
      writeFileSync(join(home, "ecosystem.config.js"), JS("js"));
      writeFileSync(join(home, "ecosystem.config.json"), JSON_CFG("json"));
      expect(await findDefaultConfigFile(home)).toBe(join(home, "ecosystem.config.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prefix priority: pboss > bm2 > pm2 when ecosystem is absent", async () => {
    const home = await freshHome("unit-prefix");
    try {
      writeFileSync(join(home, "bm2.config.ts"), TS("bm2"));
      writeFileSync(join(home, "pm2.config.json"), JSON_CFG("pm2"));
      writeFileSync(join(home, "pboss.config.js"), JS("pboss"));
      expect(await findDefaultConfigFile(home)).toBe(join(home, "pboss.config.js"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns undefined when no candidate exists — non-candidate names are ignored", async () => {
    const home = await freshHome("unit-none");
    try {
      // Recognized when passed EXPLICITLY, but never auto-detected.
      writeFileSync(join(home, "procboss.config.json"), JSON_CFG("x"));
      writeFileSync(join(home, "app.json"), JSON_CFG("x"));
      writeFileSync(join(home, "ecosystem.json"), JSON_CFG("x"));
      expect(await findDefaultConfigFile(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a directory named like a candidate is not detected (regular files only)", async () => {
    const home = await freshHome("unit-dir");
    try {
      mkdirSync(join(home, "ecosystem.config.json"));
      expect(await findDefaultConfigFile(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the detected .ts path loads through loadEcosystemConfig with cwd defaulted", async () => {
    const home = await freshHome("unit-load");
    try {
      writeApp(home, "web.ts");
      writeFileSync(
        join(home, "ecosystem.config.ts"),
        `export default { apps: [{ name: "web", script: "./web.ts" }] };\n`
      );
      const detected = await findDefaultConfigFile(home);
      expect(detected).toBe(join(home, "ecosystem.config.ts"));
      const config = await loadEcosystemConfig(detected!);
      expect(config.apps[0]!.script).toBe(join(home, "web.ts"));
      expect(config.apps[0]!.cwd).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Issue #29 — e2e: bare `pboss start` auto-detection", () => {
  test(
    "the issue's example: ecosystem.config.js is loaded, pb/pm2 configs are not",
    async () => {
      const home = await freshHome("e2e-example");
      const ecoApp = writeApp(home, "eco.ts");
      const otherApp = writeApp(home, "other.ts");
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(ecoApp)} }] };\n`
      );
      writeFileSync(
        join(home, "pboss.config.json"),
        `{ "apps": [{ "name": "pboss-web", "script": ${JSON.stringify(otherApp)} }] }\n`
      );
      writeFileSync(
        join(home, "pm2.config.js"),
        `module.exports = { apps: [{ name: "pm2-web", script: ${JSON.stringify(otherApp)} }] };\n`
      );
      try {
        const res = await runCli(["start"], home);
        expect(res.code).toBe(0);
        // Only the ecosystem app started (poll: the daemon persists the
        // fleet right after the start resolves).
        expect(await waitForDumpEntry(home, "eco-web")).toBe(true);
        expect(dumpNames(home)).not.toContain("pboss-web");
        expect(dumpNames(home)).not.toContain("pm2-web");
        expect(res.out).toContain("eco-web");
        expect(res.out).not.toContain("pboss-web");
        // The dim hint names the file that was picked (stderr keeps stdout
        // parseable).
        expect(res.err).toContain("auto-detected");
        expect(res.err).toContain("ecosystem.config.js");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "no ecosystem: pboss.config.json is auto-detected (.json loader path)",
    async () => {
      const home = await freshHome("e2e-pbjson");
      const app = writeApp(home);
      writeFileSync(
        join(home, "pboss.config.json"),
        `{ "apps": [{ "name": "pb-web", "script": ${JSON.stringify(app)} }] }\n`
      );
      try {
        const res = await runCli(["start"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "pb-web")).toBe(true);
        expect(res.err).toContain("pboss.config.json");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "bm2.config.ts is auto-detected (.ts loader path, ESM default export)",
    async () => {
      const home = await freshHome("e2e-bm2ts");
      const app = writeApp(home);
      writeFileSync(
        join(home, "bm2.config.ts"),
        `export default { apps: [{ name: "bm2-web", script: ${JSON.stringify(app)} }] };\n`
      );
      try {
        const res = await runCli(["start"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "bm2-web")).toBe(true);
        expect(res.err).toContain("bm2.config.ts");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "pm2.config.js is auto-detected as the lowest-priority prefix",
    async () => {
      const home = await freshHome("e2e-pm2js");
      const app = writeApp(home);
      writeFileSync(
        join(home, "pm2.config.js"),
        `module.exports = { apps: [{ name: "pm2-web", script: ${JSON.stringify(app)} }] };\n`
      );
      try {
        const res = await runCli(["start"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "pm2-web")).toBe(true);
        expect(res.err).toContain("pm2.config.js");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "explicit `pboss start pboss.config.json` beats the higher-priority detected file",
    async () => {
      const home = await freshHome("e2e-explicit");
      const ecoApp = writeApp(home, "eco.ts");
      const pbApp = writeApp(home, "pb.ts");
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(ecoApp)} }] };\n`
      );
      writeFileSync(
        join(home, "pboss.config.json"),
        `{ "apps": [{ "name": "pb-web", "script": ${JSON.stringify(pbApp)} }] }\n`
      );
      try {
        const res = await runCli(["start", "pboss.config.json"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "pb-web")).toBe(true);
        expect(dumpNames(home)).not.toContain("eco-web");
        // An explicit target means no auto-detection hint is printed.
        expect(res.err).not.toContain("auto-detected");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "an explicit script beats detection: `pboss start ./direct.ts` in a dir with a config",
    async () => {
      const home = await freshHome("e2e-script");
      const ecoApp = writeApp(home, "eco.ts");
      const direct = writeApp(home, "direct.ts");
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(ecoApp)} }] };\n`
      );
      try {
        const res = await runCli(["start", direct, "--name", "direct"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "direct")).toBe(true);
        expect(dumpNames(home)).not.toContain("eco-web");
        expect(res.err).not.toContain("auto-detected");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "flags-only invocation (no positional) still auto-detects",
    async () => {
      const home = await freshHome("e2e-flags");
      const app = writeApp(home);
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(app)} }] };\n`
      );
      try {
        // --raw is a valueless flag: there is no positional to start, so
        // detection must fire (and raw suppresses only the table print).
        const res = await runCli(["start", "--raw"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "eco-web")).toBe(true);
        expect(res.err).toContain("ecosystem.config.js");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "no config found: falls through to the resolution flow and errors with the issue's text",
    async () => {
      const home = await freshHome("e2e-nothing");
      try {
        // A non-candidate config must NOT be picked up: the flow continues
        // to executable/application resolution and fails there.
        writeFileSync(join(home, "procboss.config.json"), JSON_CFG("x"));
        const res = await runCli(["start"], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain("No PBoss configuration file or application was found.");
        expect(res.err).toContain(
          "Please provide a config file, executable script, or application to start."
        );
        // Nothing was started and no daemon was spawned on the error path.
        expect(existsSync(join(home, "dump.json"))).toBe(false);
        expect(existsSync(join(home, "daemon.sock"))).toBe(false);
      } finally {
        await cleanup(home);
      }
    },
    60000
  );

  test(
    "an explicit target that cannot be resolved still fails honestly (detection does not hijack)",
    async () => {
      const home = await freshHome("e2e-missing");
      const ecoApp = writeApp(home, "eco.ts");
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(ecoApp)} }] };\n`
      );
      try {
        const res = await runCli(["start", "./missing.ts"], home);
        expect(res.code).toBe(1);
        // The explicit-miss error, NOT the "no configuration found" one —
        // the user named a target, so auto-detection stays out of the way.
        expect(res.err).toContain("no script at");
        expect(res.err).not.toContain("No PBoss configuration file or application was found.");
        expect(dumpNames(home)).not.toContain("eco-web");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );
});
