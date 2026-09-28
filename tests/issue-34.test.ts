/**
 * Issue #34 regression suite — `pboss start` flags may appear ANYWHERE:
 * `pboss start ./server.mjs --name procboss_dev` worked, but
 * `pboss start --name procboss_dev ./server.mjs` failed with
 * "Error: no script at <cwd>/procboss_dev and no process or namespace named
 *  "procboss_dev" is registered".
 *
 * Root cause: cmdStart found the positional target with a naive
 * "first arg that doesn't start with -" scan, so a value-taking flag's VALUE
 * (--name procboss_dev) stole the target slot and was then executed as a
 * script path / resume name.
 *
 * The contract under test:
 *   - flags (and their values) may precede, follow, or surround the script
 *   - the flag's value goes to the FLAG, never to the target slot
 *   - a value flag without a script still triggers issue #29 auto-detection
 *   - the `--` sentinel ends target scanning (matches parseStartFlags)
 *   - a genuinely missing script after flags reports the REAL positional
 *   - `cron next` accepts --count before the job name (same bug class)
 *   - START_VALUE_FLAGS stays in sync with parseStartFlags (static pin)
 *
 * E2E cases run the real CLI (`bun run src/index.ts …`) on a fresh hermetic
 * PBOSS_HOME, exactly like the user's terminal (same harness as issue-29).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
    // cwd = home so auto-detection scans exactly the directory the user's
    // terminal would be in.
    cwd: home,
  });
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
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
  return mkdtempSync(join(tmpdir(), `pboss-issue34-${prefix}-`));
}

/**
 * An app script that stays alive AND leaves proof of WHICH script booted:
 * a `<name>.ran` sentinel next to itself, written once at startup.
 */
function writeApp(home: string, name = "server.ts") {
  const script = join(home, name);
  writeFileSync(
    script,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `writeFileSync(join(import.meta.dir, ${JSON.stringify(`${name}.ran`)}), "ok");`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join("\n")
  );
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

/** Wait until the app's startup sentinel exists (bounded). */
async function waitForRan(home: string, name = "server.ts", ms = 20_000): Promise<boolean> {
  const sentinel = join(home, `${name}.ran`);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(sentinel)) return true;
    await Bun.sleep(50);
  }
  return existsSync(sentinel);
}

describe("Issue #34 — unit: START_VALUE_FLAGS mirrors parseStartFlags", () => {
  // index.ts has no import guard (it runs main() on import), so the scanner
  // cannot be unit-imported — instead the SOURCE is pinned textually, the
  // same way readme.test.ts pins the docs. Two extractions must agree:
  //   1. the literals listed in START_VALUE_FLAGS
  //   2. the case labels in parseStartFlags whose body consumes args[++i]
  // Any flag added to one list but not the other fails here.

  function extractScannerFlags(): Set<string> {
    const src = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    const m = src.match(/const START_VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\);/);
    if (!m) throw new Error("START_VALUE_FLAGS not found in src/index.ts");
    return new Set([...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
  }

  function extractParserValueFlags(): Set<string> {
    const src = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    const start = src.indexOf("parseStartFlags(args: string[]");
    const end = src.indexOf("// Commands", start);
    const region = src.slice(start, end === -1 ? undefined : end);

    const valueFlags = new Set<string>();
    const pending: string[] = [];
    let consumesValue = false;
    for (const line of region.split("\n")) {
      const caseMatch = line.match(/^\s*case\s+"([^"]+)":/);
      if (caseMatch) {
        pending.push(caseMatch[1]!);
        continue;
      }
      if (line.includes("args[++i]")) consumesValue = true;
      if (/^\s*break;/.test(line)) {
        if (consumesValue) for (const f of pending) valueFlags.add(f);
        pending.length = 0;
        consumesValue = false;
      }
    }
    return valueFlags;
  }

  test("every value-consuming flag in parseStartFlags is in the scanner set", () => {
    const scanner = extractScannerFlags();
    const parser = extractParserValueFlags();
    expect(scanner.size).toBeGreaterThan(0);
    expect(parser.size).toBeGreaterThan(0);
    const missing = [...parser].filter((f) => !scanner.has(f));
    expect(missing).toEqual([]);
  });

  test("the scanner set has no stray entries (only --config/-c are extra, by design)", () => {
    const scanner = extractScannerFlags();
    const parser = extractParserValueFlags();
    const extras = [...scanner].filter(
      (f) => !parser.has(f) && f !== "--config" && f !== "-c"
    );
    expect(extras).toEqual([]);
  });

  test("the report's flags are covered: --name/-n consume a value, --watch does not", () => {
    const parser = extractParserValueFlags();
    expect(parser.has("--name")).toBe(true);
    expect(parser.has("-n")).toBe(true);
    expect(parser.has("--cwd")).toBe(true);
    expect(parser.has("--namespace")).toBe(true);
    expect(parser.has("--watch")).toBe(false);
    expect(parser.has("--raw")).toBe(false);
  });
});

describe("Issue #34 — e2e: `pboss start` flags anywhere", () => {
  test(
    "the report's exact repro: --name BEFORE the script starts it under that name",
    async () => {
      const home = await freshHome("repro");
      writeApp(home);
      try {
        const res = await runCli(["start", "--name", "procboss_dev", "./server.ts"], home);
        expect(res.code).toBe(0);
        // The flag's VALUE went to the flag, not the target slot…
        expect(await waitForDumpEntry(home, "procboss_dev")).toBe(true);
        // …and the script itself actually ran.
        expect(await waitForRan(home)).toBe(true);
        // The pre-fix failure mode is gone for good.
        expect(res.err).not.toContain("no script at");
        expect(res.err).not.toContain("no process or namespace named");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "control: script BEFORE --name keeps working (the old good path)",
    async () => {
      const home = await freshHome("control");
      writeApp(home);
      try {
        const res = await runCli(["start", "./server.ts", "--name", "trailing"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "trailing")).toBe(true);
        expect(await waitForRan(home)).toBe(true);
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "short form: -n before the script",
    async () => {
      const home = await freshHome("short");
      writeApp(home);
      try {
        const res = await runCli(["start", "-n", "shorty", "./server.ts"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "shorty")).toBe(true);
        expect(await waitForRan(home)).toBe(true);
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "several value flags before the script (sandwich order)",
    async () => {
      const home = await freshHome("sandwich");
      const app = writeApp(home);
      try {
        const res = await runCli(
          ["start", "--name", "sandwich", "--cwd", home, app],
          home
        );
        expect(res.code).toBe(0);
        // --cwd's value (home) must not have been mistaken for the target:
        // the app — whose path is the LAST arg — is what started.
        expect(await waitForDumpEntry(home, "sandwich")).toBe(true);
        expect(await waitForRan(home)).toBe(true);
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "a value flag alone is NOT a target: `start --name x` still auto-detects a config (#29 interplay)",
    async () => {
      const home = await freshHome("autodetect");
      const ecoApp = writeApp(home, "eco.ts");
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(ecoApp)} }] };\n`
      );
      try {
        // Pre-fix: "x" was seen as a target → no detection → resume error on
        // a name that isn't registered. Post-fix: detection fires.
        const res = await runCli(["start", "--name", "x"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "eco-web")).toBe(true);
        expect(res.err).toContain("auto-detected");
        expect(res.err).toContain("ecosystem.config.js");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "the `--` sentinel ends target scanning — script args after it are not the target",
    async () => {
      const home = await freshHome("sentinel");
      const ecoApp = writeApp(home, "eco.ts");
      writeFileSync(
        join(home, "ecosystem.config.js"),
        `module.exports = { apps: [{ name: "eco-web", script: ${JSON.stringify(ecoApp)} }] };\n`
      );
      try {
        // No target BEFORE the `--` → nothing named → auto-detection fires,
        // exactly like parseStartFlags treats post-`--` tokens (script args).
        const res = await runCli(["start", "--name", "api", "--", "./server.ts"], home);
        expect(res.code).toBe(0);
        expect(await waitForDumpEntry(home, "eco-web")).toBe(true);
        expect(res.err).toContain("auto-detected");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test(
    "a genuinely missing script after flags reports the REAL positional, not the flag value",
    async () => {
      const home = await freshHome("missing");
      try {
        const res = await runCli(["start", "--name", "ghost", "./missing.ts"], home);
        expect(res.code).toBe(1);
        expect(res.err).toContain("no script at");
        // The miss is reported against the positional script…
        expect(res.err).toContain("missing.ts");
        // …not against the flag's value.
        expect(res.err).not.toContain("ghost");
      } finally {
        await cleanup(home);
      }
    },
    60000
  );
});

describe("Issue #34 — e2e: `cron next` flags anywhere (same bug class)", () => {
  test(
    "--count before, after, and in = form all find the job",
    async () => {
      const home = await freshHome("cronnext");
      try {
        const add = await runCli(
          ["cron", "run", "every-second", "echo hi", "--name", "t34c"],
          home
        );
        expect(add.code).toBe(0);

        const first = await runCli(["cron", "next", "--count", "2", "t34c"], home);
        expect(first.code).toBe(0);
        expect(first.out).toContain("Next 2 runs of t34c");

        const last = await runCli(["cron", "next", "t34c", "--count", "2"], home);
        expect(last.code).toBe(0);
        expect(last.out).toContain("Next 2 runs of t34c");

        const eq = await runCli(["cron", "next", "--count=2", "t34c"], home);
        expect(eq.code).toBe(0);
        expect(eq.out).toContain("Next 2 runs of t34c");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );
});
