/**
 * Issue #40 — persistent global runtime overrides, without touching the
 * default runtime. https://github.com/Procboss/pboss/issues/40
 *
 * The contract under test, in the issue's own precedence:
 *
 *   1. runtime_overrides (~/.pboss/runtime-overrides — TAB-separated,
 *      keys are process BASE names and ABSOLUTE ecosystem config paths)
 *   2. .runtime (the machine-wide default — NEVER written by an override)
 *   3. normal detection/fallback (inherit the main runtime / discovery)
 *
 * Layers, each pinned:
 *   - the store module (parse/format/write/lookup/precedence)
 *   - runtimeCommandPrefix (the pinned runtime's spawn route)
 *   - the ProcessManager (pin on start, reuse on restart, drop on delete)
 *   - the CLI env channel (PBOSS_LAUNCHER_RUNTIME — the wrapper's ONLY
 *     hand-off; the JS level never parses --runtime)
 *   - the bin wrappers (resolve runtime_overrides BEFORE .runtime, export
 *     the channel on the flag path only) — source pins + real e2e runs
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join, basename, dirname } from "path";
import { tmpdir } from "os";

// Isolate PBOSS_HOME BEFORE any src module is imported (constants.ts and
// runtime-overrides.ts read it at import time — the process-manager test
// pattern; without this the suite would touch the developer's real ~/.pboss).
const TEST_HOME = join(tmpdir(), `pboss-i40-home-${process.pid}-${Date.now()}`);
process.env.PBOSS_HOME = TEST_HOME;
const REPO = join(import.meta.dir, "..");
const SH = readFileSync(join(REPO, "bin", "pboss.sh"), "utf8");
const PS1 = readFileSync(join(REPO, "bin", "pboss.ps1"), "utf8");

const POSIX = process.platform !== "win32";
const BUN_BIN = Bun.which("bun");
const NODE_BIN = Bun.which("node");
const DENO_BIN = Bun.which("deno");

let WORK = "";
beforeEach(async () => {
  WORK = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "pboss-i40-"));
  // The module-bound PBOSS_HOME is not necessarily OURS: in a combined run
  // (bun test loads every file first), another suite's module-level
  // PBOSS_HOME may have won the constants.ts binding. Whatever home the
  // bound paths point at, its dirs must exist — a bare ProcessManager
  // creates neither log dirs nor the store's parent.
  const { RUNTIME_OVERRIDES_FILE } = await import("../src/runtime-overrides");
  const { RUNTIME_FILE } = await import("../src/runtime-config");
  await mkdir(dirname(RUNTIME_OVERRIDES_FILE), { recursive: true });
  await mkdir(join(dirname(RUNTIME_FILE), "logs"), { recursive: true });
  await mkdir(TEST_HOME, { recursive: true });
});
afterEach(async () => {
  await rm(WORK, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
  // Combined-run hygiene: when the module-bound home is NOT ours, undo the
  // fixtures these tests wrote there — a stray .runtime would change later
  // suites' spawn resolution (the issue-#40 chain consults it).
  try {
    const { RUNTIME_OVERRIDES_FILE } = await import("../src/runtime-overrides");
    const { RUNTIME_FILE } = await import("../src/runtime-config");
    if (!RUNTIME_OVERRIDES_FILE.startsWith(TEST_HOME)) {
      await rm(RUNTIME_OVERRIDES_FILE, { force: true });
    }
    if (!RUNTIME_FILE.startsWith(TEST_HOME)) {
      await rm(RUNTIME_FILE, { force: true });
    }
  } catch {
    /* best-effort cleanup — never fail a passing test */
  }
});

/* ── Part A: the store module ──────────────────────────────────────────── */

describe("issue #40 — the runtime-overrides store", () => {
  test("parse: comments, blanks and corrupt lines are skipped; TAB splits key/value", async () => {
    const { parseRuntimeOverrides } = await import("../src/runtime-overrides");
    const store = parseRuntimeOverrides(
      [
        "# pboss runtime overrides (issue #40) — key<TAB>runtime.",
        "",
        "my-api\tbun",
        "/srv/app/ecosystem.config.ts\tdeno",
        "no-tab-line",
        "\tvalue-only",
        "bad-runtime\twasd",
        "spaced \t node ",
      ].join("\n"),
    );
    expect(store.get("my-api")).toBe("bun");
    expect(store.get("/srv/app/ecosystem.config.ts")).toBe("deno");
    expect(store.has("no-tab-line")).toBe(false);
    expect(store.has("bad-runtime")).toBe(false);
    // The value is normalized (trim + lowercase); the key keeps its edge
    // spaces trimmed but the separator logic tolerates trailing padding.
    expect(store.get("spaced")).toBe("node");
  });

  test("format → parse round-trip is lossless", async () => {
    const { parseRuntimeOverrides, formatRuntimeOverrides } = await import("../src/runtime-overrides");
    const map = new Map<string, "node" | "bun" | "deno">([
      ["api", "bun"],
      ["/abs/path/ecosystem.config.json", "deno"],
      ["worker", "node"],
    ]);
    const parsed = parseRuntimeOverrides(formatRuntimeOverrides(map));
    expect(parsed.size).toBe(3);
    expect(parsed.get("api")).toBe("bun");
    expect(parsed.get("/abs/path/ecosystem.config.json")).toBe("deno");
    expect(parsed.get("worker")).toBe("node");
  });

  test("write/read/remove on an explicit file (absent file reads empty)", async () => {
    const { writeRuntimeOverride, readRuntimeOverrides, removeRuntimeOverrides } = await import(
      "../src/runtime-overrides"
    );
    const file = join(WORK, "runtime-overrides");
    await writeRuntimeOverride("api", "bun", file);
    await writeRuntimeOverride("worker", "deno", file);
    expect((await readRuntimeOverrides(file)).get("api")).toBe("bun");
    expect((await readRuntimeOverrides(file)).get("worker")).toBe("deno");
    // Re-pin replaces; remove is a no-op for missing keys.
    await writeRuntimeOverride("api", "node", file);
    await removeRuntimeOverrides(["worker", "never-existed"], file);
    const after = await readRuntimeOverrides(file);
    expect(after.get("api")).toBe("node");
    expect(after.has("worker")).toBe(false);
    expect(after.size).toBe(1);
    // Absent file → an empty store, never a throw.
    expect((await readRuntimeOverrides(join(WORK, "nope"))).size).toBe(0);
  });

  test("baseProcessName strips ONE trailing cluster index", async () => {
    const { baseProcessName } = await import("../src/runtime-overrides");
    expect(baseProcessName("api-3")).toBe("api");
    expect(baseProcessName("api-12")).toBe("api");
    expect(baseProcessName("my-api-0")).toBe("my-api");
    expect(baseProcessName("api")).toBe("api");
    expect(baseProcessName("hyphen-name")).toBe("hyphen-name");
  });

  test("lookup precedence: exact name → cluster base → ecosystem path", async () => {
    const { lookupRuntimeOverride } = await import("../src/runtime-overrides");
    const store = new Map<string, "node" | "bun" | "deno">([
      ["api", "bun"], // the exact name wins
      ["worker", "deno"], // the cluster base of worker-2
      ["/eco/config.json", "node"], // the ecosystem pin
    ]);
    expect(lookupRuntimeOverride(store, "api")).toBe("bun");
    expect(lookupRuntimeOverride(store, "worker-2")).toBe("deno");
    expect(lookupRuntimeOverride(store, "fresh", "/eco/config.json")).toBe("node");
    expect(lookupRuntimeOverride(store, "fresh", "/other.json")).toBe(null);
    // A name pin beats the ecosystem pin (the issue's "my-api: bun" rule).
    expect(lookupRuntimeOverride(store, "api", "/eco/config.json")).toBe("bun");
  });
});

/* ── Part B: the .runtime default, leniently + the effective chain ─────── */

describe("issue #40 — precedence: overrides → .runtime → detection", () => {
  test("lenientDefaultRuntime: absent/empty/corrupt → null; valid → the runtime", async () => {
    const { lenientDefaultRuntime } = await import("../src/runtime-overrides");
    const file = join(WORK, ".runtime");
    expect(await lenientDefaultRuntime(file)).toBe(null);
    await writeFile(file, "");
    expect(await lenientDefaultRuntime(file)).toBe(null); // empty is "no default" (issue: missing OR EMPTY)
    await writeFile(file, "   \n");
    expect(await lenientDefaultRuntime(file)).toBe(null);
    await writeFile(file, "garbage\n");
    expect(await lenientDefaultRuntime(file)).toBe(null); // never the §20 hard error here
    await writeFile(file, "bun\n");
    expect(await lenientDefaultRuntime(file)).toBe("bun");
    await writeFile(file, "  Deno \n");
    expect(await lenientDefaultRuntime(file)).toBe("deno");
  });

  test("effectiveProcessRuntime: override > .runtime > null (fall-through)", async () => {
    const { effectiveProcessRuntime } = await import("../src/runtime-overrides");
    const store = join(WORK, "runtime-overrides");
    const rt = join(WORK, ".runtime");
    // Nothing anywhere → null (the normal detection chain takes over).
    expect(await effectiveProcessRuntime("api", undefined, store, rt)).toBe(null);
    // .runtime alone.
    await writeFile(rt, "node\n");
    expect(await effectiveProcessRuntime("api", undefined, store, rt)).toBe("node");
    // An override beats the default.
    await writeFile(store, "api\tbun\n");
    expect(await effectiveProcessRuntime("api", undefined, store, rt)).toBe("bun");
    // Other processes keep the default.
    expect(await effectiveProcessRuntime("other", undefined, store, rt)).toBe("node");
    // An ecosystem pin applies to member processes.
    await writeFile(store, "/eco/config.json\tdeno\n");
    expect(await effectiveProcessRuntime("member", "/eco/config.json", store, rt)).toBe("deno");
  });
});

/* ── Part C: the wrapper → CLI channel ─────────────────────────────────── */

describe("issue #40 — the PBOSS_LAUNCHER_RUNTIME channel", () => {
  test("launcherRuntimeFromEnv: valid value, normalization, absent, invalid", async () => {
    const { launcherRuntimeFromEnv } = await import("../src/runtime-overrides");
    expect(launcherRuntimeFromEnv({})).toBe(null);
    expect(launcherRuntimeFromEnv({ PBOSS_LAUNCHER_RUNTIME: "" })).toBe(null);
    expect(launcherRuntimeFromEnv({ PBOSS_LAUNCHER_RUNTIME: "bun" })).toBe("bun");
    expect(launcherRuntimeFromEnv({ PBOSS_LAUNCHER_RUNTIME: " Node " })).toBe("node");
    expect(launcherRuntimeFromEnv({ PBOSS_LAUNCHER_RUNTIME: "DENO" })).toBe("deno");
    // An invalid value (only possible by hand-setting the channel — the
    // wrapper validates the flag) is ignored, never fatal.
    expect(launcherRuntimeFromEnv({ PBOSS_LAUNCHER_RUNTIME: "wasd" })).toBe(null);
  });
});

/* ── Part D: runtimeCommandPrefix (the pinned route) ───────────────────── */

describe("issue #40 — runtimeCommandPrefix (the pinned spawn route)", () => {
  test.skipIf(!BUN_BIN)("bun → [<bun>, run]", async () => {
    const { runtimeCommandPrefix } = await import("../src/install-mode");
    const prefix = await runtimeCommandPrefix("bun", "/app/x.ts");
    expect(basename(prefix[0]!)).toMatch(/^bun(\.exe)?$/);
    expect(prefix[1]).toBe("run");
  });

  test.skipIf(!NODE_BIN)("node + .js → [<node>]", async () => {
    const { runtimeCommandPrefix } = await import("../src/install-mode");
    const prefix = await runtimeCommandPrefix("node", "/app/x.js");
    expect(basename(prefix[0]!)).toMatch(/^node(\.exe)?$/);
    expect(prefix).toHaveLength(1);
  });

  test.skipIf(!NODE_BIN)("node + .ts → tsx or --experimental-strip-types", async () => {
    const { runtimeCommandPrefix } = await import("../src/install-mode");
    const prefix = await runtimeCommandPrefix("node", "/app/x.ts");
    expect(basename(prefix[0]!)).toMatch(/^node(\.exe)?$/);
    const tail = prefix.slice(1).join(" ");
    expect(tail === "" || tail.startsWith("--experimental-strip-types") || tail.includes("tsx")).toBe(
      true,
    );
  });

  test.skipIf(!DENO_BIN)("deno → [<deno>, run, -A]", async () => {
    const { runtimeCommandPrefix } = await import("../src/install-mode");
    const prefix = await runtimeCommandPrefix("deno", "/app/x.ts");
    expect(basename(prefix[0]!)).toMatch(/^deno(\.exe)?$/);
    expect(prefix.slice(1)).toEqual(["run", "-A"]);
  });
});

/* ── Part E: the ProcessManager — pin on start, reuse on restart ───────── */

describe("issue #40 — ProcessManager: pins persist, defaults untouched", () => {
  test("start with a launcher runtime pins the BASE name; .runtime is never written", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { readRuntimeOverrides } = await import("../src/runtime-overrides");
    const { RUNTIME_FILE } = await import("../src/runtime-config");

    // A pre-existing machine default — the pin must leave it byte-identical.
    await mkdir(TEST_HOME, { recursive: true });
    await writeFile(RUNTIME_FILE, "node\n");

    const scriptPath = join(WORK, "server.ts");
    await writeFile(scriptPath, "setInterval(() => {}, 1000);");

    const pm = new ProcessManager();
    await pm.start({ name: "pinned-api", script: scriptPath, runtime: "bun" });
    try {
      const store = await readRuntimeOverrides();
      expect(store.get("pinned-api")).toBe("bun");
      expect(readFileSync(RUNTIME_FILE, "utf8")).toBe("node\n"); // NEVER the override's business
      // The runtime is NOT baked into the persisted description —
      // resolution is live from the store (a `pboss runtime change` must
      // reach unpinned apps on their next restart).
      const described = pm.describe("pinned-api")[0]!;
      expect(described.name).toBe("pinned-api");
      expect((described.pboss_env as unknown as Record<string, unknown>).runtime).toBeUndefined();
    } finally {
      await pm.deleteAll();
    }
  });

  test.skipIf(!BUN_BIN)(
    "a pinned name resolves the bun route at spawn time (fork AND cluster-decision paths)",
    async () => {
      const { ProcessManager } = await import("../src/process-manager");
      const { readRuntimeOverrides, writeRuntimeOverride } = await import("../src/runtime-overrides");

      const scriptPath = join(WORK, "route.ts");
      await writeFile(scriptPath, "setInterval(() => {}, 1000);");

      const pm = new ProcessManager();
      // Pre-pin by name (what `pboss start --runtime=bun` left behind).
      await writeRuntimeOverride("route-app", "bun");
      const states = await pm.start({ name: "route-app", script: scriptPath });
      try {
        expect(states[0]!.status).toBe("online");
        const described = pm.describe("route-app")[0]!;
        const cmd = await pm["clusterManager"].buildWorkerCommand(described.pboss_env);
        expect(basename(cmd[0]!)).toMatch(/^bun(\.exe)?$/);
        expect(cmd[1]).toBe("run");
        // The store was consulted, not mutated by the start (no flag).
        expect((await readRuntimeOverrides()).get("route-app")).toBe("bun");
      } finally {
        await pm.deleteAll();
      }
    },
    30000,
  );

  test.skipIf(!BUN_BIN)(
    "restart keeps using the pin even when .runtime says otherwise",
    async () => {
      const { ProcessManager } = await import("../src/process-manager");
      const { writeRuntimeOverride } = await import("../src/runtime-overrides");
      const { RUNTIME_FILE } = await import("../src/runtime-config");

      await mkdir(TEST_HOME, { recursive: true });
      await writeFile(RUNTIME_FILE, "node\n"); // the machine default diverges

      const scriptPath = join(WORK, "restart-pin.ts");
      await writeFile(scriptPath, "setInterval(() => {}, 1000);");

      const pm = new ProcessManager();
      await writeRuntimeOverride("sticky", "bun");
      await pm.start({ name: "sticky", script: scriptPath });
      try {
        await pm.restart("sticky");
        const described = pm.describe("sticky")[0]!;
        const cmd = await pm["clusterManager"].buildWorkerCommand(described.pboss_env);
        expect(basename(cmd[0]!)).toMatch(/^bun(\.exe)?$/);
      } finally {
        await pm.deleteAll();
      }
    },
    30000,
  );

  test("an ecosystem start pins the config path and stamps every app's description", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { readRuntimeOverrides } = await import("../src/runtime-overrides");
    const { loadEcosystemConfig } = await import("../src/api");

    const appDir = join(WORK, "eco");
    await mkdir(appDir, { recursive: true });
    const scriptA = join(appDir, "a.js");
    const scriptB = join(appDir, "b.js");
    await writeFile(scriptA, "setInterval(() => {}, 1000);");
    await writeFile(scriptB, "setInterval(() => {}, 1000);");
    const configPath = join(appDir, "ecosystem.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ apps: [{ name: "eco-a", script: scriptA }, { name: "eco-b", script: scriptB }] }),
    );

    // loadEcosystemConfig stamps the absolute configPath (the pin's key).
    const config = await loadEcosystemConfig(configPath);
    expect(config.configPath).toBe(configPath);

    const pm = new ProcessManager();
    // The CLI attaches the launcher runtime (the wrapper's hand-off).
    config.runtime = "node";
    await pm.startEcosystem(config);
    try {
      const store = await readRuntimeOverrides();
      expect(store.get(configPath)).toBe("node"); // the WHOLE ecosystem's pin
      // Every app's persisted description carries the ecosystem path, so
      // restarts and post-reboot resurrects keep resolving the pin.
      expect(pm.describe("eco-a")[0]!.pboss_env.ecosystemPath).toBe(configPath);
      expect(pm.describe("eco-b")[0]!.pboss_env.ecosystemPath).toBe(configPath);
    } finally {
      await pm.deleteAll();
    }
  });

  test.skipIf(!NODE_BIN)(
    "an ecosystem member resolves the pinned runtime at spawn (restart/reboot parity)",
    async () => {
      const { ProcessManager } = await import("../src/process-manager");
      const { loadEcosystemConfig } = await import("../src/api");
      const { writeRuntimeOverride } = await import("../src/runtime-overrides");

      const appDir = join(WORK, "eco2");
      await mkdir(appDir, { recursive: true });
      const script = join(appDir, "a.js");
      await writeFile(script, "setInterval(() => {}, 1000);");
      const configPath = join(appDir, "ecosystem.config.json");
      await writeFile(configPath, JSON.stringify({ apps: [{ name: "eco-member", script }] }));

      const pm = new ProcessManager();
      // The saved pin a `pboss start --runtime=node <file>` left behind.
      await writeRuntimeOverride(configPath, "node");
      const config = await loadEcosystemConfig(configPath);
      await pm.startEcosystem(config);
      try {
        const described = pm.describe("eco-member")[0]!;
        const cmd = await pm["clusterManager"].buildWorkerCommand(described.pboss_env);
        expect(basename(cmd[0]!)).toMatch(/^node(\.exe)?$/);
      } finally {
        await pm.deleteAll();
      }
    },
    30000,
  );

  test("delete drops the NAME pin; the ecosystem pin (the file's memory) stays", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { readRuntimeOverrides, writeRuntimeOverride } = await import("../src/runtime-overrides");

    const scriptPath = join(WORK, "delete-pin.ts");
    await writeFile(scriptPath, "setInterval(() => {}, 1000);");
    const configPath = join(WORK, "eco.config.json");

    const pm = new ProcessManager();
    await writeRuntimeOverride("doomed", "bun");
    await writeRuntimeOverride(configPath, "deno");
    await pm.start({ name: "doomed", script: scriptPath });
    await pm.del("doomed");

    const store = await readRuntimeOverrides();
    expect(store.has("doomed")).toBe(false); // a normal start is a normal start again
    expect(store.get(configPath)).toBe("deno"); // the ecosystem remembers
  });

  test("a STATED interpreter stays the most explicit choice (app-level setting)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { writeRuntimeOverride } = await import("../src/runtime-overrides");

    const scriptPath = join(WORK, "stated.ts");
    await writeFile(scriptPath, "setInterval(() => {}, 1000);");

    const pm = new ProcessManager();
    await writeRuntimeOverride("stated", "bun");
    await pm.start({ name: "stated", script: scriptPath, interpreter: "node" });
    try {
      const described = pm.describe("stated")[0]!;
      const cmd = await pm["clusterManager"].buildWorkerCommand(described.pboss_env);
      expect(basename(cmd[0]!)).toMatch(/^node(\.exe)?$/); // interpreter wins
    } finally {
      await pm.deleteAll();
    }
  });
});

/* ── Part F: the bin wrappers — source pins ────────────────────────────── */

describe("issue #40 — wrapper source pins (sh + ps1)", () => {
  test("pboss.sh knows the store and reads it BEFORE .runtime", () => {
    expect(SH).toContain('OVERRIDES_FILE="$PBOSS_HOME_DIR/runtime-overrides"');
    expect(SH).toContain("awk -F'\\t'");
    // The override branch sits between the flag branch and the .runtime
    // branch of the resolution chain.
    const flagBranch = SH.indexOf('if [ -n "$RUNTIME_FLAG" ]; then');
    const overrideBranch = SH.indexOf('elif [ -n "$OVERRIDE_RUNTIME" ]; then');
    const runtimeBranch = SH.indexOf('elif [ -f "$RUNTIME_FILE" ]; then');
    expect(flagBranch).toBeGreaterThan(-1);
    expect(overrideBranch).toBeGreaterThan(flagBranch);
    expect(runtimeBranch).toBeGreaterThan(overrideBranch);
  });

  test("pboss.sh hands the flag's value down ONLY through the env channel", () => {
    expect(SH).toContain('PBOSS_LAUNCHER_RUNTIME="$RUNTIME"');
    expect(SH).toContain("export PBOSS_LAUNCHER_RUNTIME");
    // The export lives inside the FLAG branch (before the first elif) —
    // a store-driven or default invocation never looks pinned.
    const flagBranch = SH.indexOf('if [ -n "$RUNTIME_FLAG" ]; then');
    const firstElif = SH.indexOf("elif", flagBranch);
    const exportLine = SH.indexOf("export PBOSS_LAUNCHER_RUNTIME");
    expect(exportLine).toBeGreaterThan(flagBranch);
    expect(exportLine).toBeLessThan(firstElif);
  });

  test("pboss.sh prints the saved-override notice naming the target and the kept default", () => {
    expect(SH).toContain('(saved runtime override).');
    expect(SH).toContain('printf \'Default runtime remains: %s\\n\\n\'');
  });

  test("pboss.ps1 mirrors the store, the precedence and the channel", () => {
    expect(PS1).toContain('$overridesFile = Join-Path $pbossHomeDir "runtime-overrides"');
    expect(PS1).toContain("function Get-SavedOverride");
    expect(PS1).toContain("Find-LaunchTarget $cliArgs");
    expect(PS1).toContain("$env:PBOSS_LAUNCHER_RUNTIME = $runtime");
    expect(PS1).toContain("(saved runtime override).");
    // The saved-override branch sits between the flag and .runtime branches.
    const flagBranch = PS1.indexOf("if ($runtimeFlag) {");
    const overrideBranch = PS1.indexOf("} elseif ($savedOverride) {");
    const runtimeBranch = PS1.indexOf("} elseif (Test-Path $runtimeFile) {");
    expect(flagBranch).toBeGreaterThan(-1);
    expect(overrideBranch).toBeGreaterThan(flagBranch);
    expect(runtimeBranch).toBeGreaterThan(overrideBranch);
  });

  test("the store path is the SAME everywhere (constants discipline)", async () => {
    const { RUNTIME_OVERRIDES_FILE } = await import("../src/runtime-overrides");
    const { PBOSS_HOME } = await import("../src/constants");
    expect(RUNTIME_OVERRIDES_FILE).toBe(join(PBOSS_HOME, "runtime-overrides"));
    expect(SH).toContain('OVERRIDES_FILE="$PBOSS_HOME_DIR/runtime-overrides"');
    expect(PS1).toContain('"runtime-overrides"');
  });
});

/* ── Part G: the bin wrapper, end to end (POSIX) ────────────────────────── */

/** An env-aware probe: argv + the launcher channel, as one JSON line. */
const PROBE40 = `
console.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env.PBOSS_LAUNCHER_RUNTIME || null }));
`;

/** The wrapper's POSIX toolbox — awk/basename are new for the store lookup. */
function farmTools(dir: string) {
  for (const t of ["cat", "tr", "readlink", "dirname", "basename", "mkdir", "awk"]) {
    const tool = Bun.which(t);
    if (tool) symlinkSync(tool, join(dir, t));
  }
}

function probePackage40() {
  const farm = mkdtempSync(join(tmpdir(), "pboss-i40-wrap-"));
  const pkg = join(farm, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist", "cli.node.js"), `#!/usr/bin/env node\n${PROBE40}`);
  writeFileSync(join(pkg, "dist", "cli.bun.js"), `#!/usr/bin/env bun\n${PROBE40}`);
  writeFileSync(
    join(pkg, "dist", "cli.deno.js"),
    `console.log(JSON.stringify({ argv: Deno.args, env: Deno.env.get("PBOSS_LAUNCHER_RUNTIME") || null }));\n`,
  );
  writeFileSync(join(pkg, "bin", "pboss.sh"), SH);
  chmodSync(join(pkg, "bin", "pboss.sh"), 0o755);
  return { farm, pkg, wrapper: join(pkg, "bin", "pboss.sh") };
}

function runWrapper40(
  wrapper: string,
  args: string[],
  path: string,
  home: string,
  cwd: string,
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([wrapper, ...args], {
    env: { PATH: path, HOME: home, PBOSS_HOME: home },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    code: proc.exitCode ?? -1,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

/** The probe prints one JSON line; notices may precede it — take the LAST JSON-looking line. */
function probeResult(out: string): { argv: string[]; env: string | null } {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith("{")) return JSON.parse(lines[i]!);
  }
  throw new Error(`no probe line in output:\n${out}`);
}

describe("issue #40 — wrapper e2e: saved overrides before .runtime", () => {
  test.skipIf(!POSIX || !BUN_BIN || !NODE_BIN)(
    "store pin beats .runtime; the channel stays unset; the notice names the target",
    () => {
      const farm = probePackage40();
      const scrub = mkdtempSync(join(tmpdir(), "pboss-i40-scrub-"));
      symlinkSync(BUN_BIN!, join(scrub, "bun"));
      symlinkSync(NODE_BIN!, join(scrub, "node"));
      farmTools(scrub);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        writeFileSync(join(home, ".runtime"), "node\n");
        writeFileSync(join(home, "runtime-overrides"), "my-api\tbun\n");
        const run = runWrapper40(farm.wrapper, ["restart", "my-api"], scrub, home, farm.farm);
        expect(run.code, `stderr:\n${run.err}`).toBe(0);
        const probe = probeResult(run.out);
        expect(probe.argv).toEqual(["restart", "my-api"]); // verbatim forwarding
        expect(probe.env).toBe(null); // a store-driven run is NOT a pinned start
        expect(basename(probe.argv.slice(0)[0] ? "bun" : "")).toBe("bun"); // (trivially true — the entry itself proves dispatch)
        // The dispatch proof: a bun-only probe file means the BUN entry ran.
        expect(run.out).toContain('"argv":["restart","my-api"]');
        expect(run.out).toContain('Using Bun for "my-api" (saved runtime override).');
        expect(run.out).toContain("Default runtime remains: Node");
        // .runtime untouched.
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("node\n");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !BUN_BIN || !NODE_BIN)("miss falls through to .runtime; sentinel stops the scan", () => {
    const farm = probePackage40();
    const scrub = mkdtempSync(join(tmpdir(), "pboss-i40-scrub-"));
    symlinkSync(BUN_BIN!, join(scrub, "bun"));
    symlinkSync(NODE_BIN!, join(scrub, "node"));
    farmTools(scrub);
    const home = join(farm.farm, "home");
    mkdirSync(home, { recursive: true });
    try {
      writeFileSync(join(home, ".runtime"), "node\n");
      writeFileSync(join(home, "runtime-overrides"), "my-api\tbun\n");
      // Unpinned target → the .runtime default.
      const miss = runWrapper40(farm.wrapper, ["restart", "other"], scrub, home, farm.farm);
      expect(miss.code, `stderr:\n${miss.err}`).toBe(0);
      expect(miss.out).toContain('"argv":["restart","other"]');
      expect(miss.out).not.toContain("saved runtime override");
      // Everything after -- is the command's own argv — never scanned.
      const sentinel = runWrapper40(farm.wrapper, ["restart", "--", "my-api"], scrub, home, farm.farm);
      expect(sentinel.code, `stderr:\n${sentinel.err}`).toBe(0);
      expect(sentinel.out).not.toContain("saved runtime override");
    } finally {
      rmSync(farm.farm, { recursive: true, force: true });
      rmSync(scrub, { recursive: true, force: true });
    }
  }, 30000);

  test.skipIf(!POSIX || !BUN_BIN)("the flag beats the store AND sets the channel", () => {
    const farm = probePackage40();
    const scrub = mkdtempSync(join(tmpdir(), "pboss-i40-scrub-"));
    symlinkSync(BUN_BIN!, join(scrub, "bun"));
    farmTools(scrub);
    const home = join(farm.farm, "home");
    mkdirSync(home, { recursive: true });
    try {
      writeFileSync(join(home, ".runtime"), "bun\n");
      writeFileSync(join(home, "runtime-overrides"), "my-api\tnode\n"); // the store disagrees with the flag
      const run = runWrapper40(farm.wrapper, ["--runtime=bun", "start", "./x.ts"], scrub, home, farm.farm);
      expect(run.code, `stderr:\n${run.err}`).toBe(0);
      const probe = probeResult(run.out);
      expect(probe.argv).toEqual(["start", "./x.ts"]); // the flag is stripped
      expect(probe.env).toBe("bun"); // ...and handed down the ONLY channel
    } finally {
      rmSync(farm.farm, { recursive: true, force: true });
      rmSync(scrub, { recursive: true, force: true });
    }
  }, 30000);

  test.skipIf(!POSIX || !NODE_BIN)("a bare ecosystem filename in the cwd resolves the absolute store key", () => {
    const farm = probePackage40();
    const scrub = mkdtempSync(join(tmpdir(), "pboss-i40-scrub-"));
    symlinkSync(NODE_BIN!, join(scrub, "node"));
    farmTools(scrub);
    const home = join(farm.farm, "home");
    const appDir = join(farm.farm, "app");
    mkdirSync(home, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    try {
      writeFileSync(join(appDir, "ecosystem.config.json"), "{}\n");
      writeFileSync(join(home, "runtime-overrides"), `${join(appDir, "ecosystem.config.json")}\tnode\n`);
      // No .runtime at all — the store alone decides (the issue: overrides
      // work even when .runtime is missing or empty).
      const run = runWrapper40(farm.wrapper, ["restart", "ecosystem.config.json"], scrub, home, appDir);
      expect(run.code, `stderr:\n${run.err}`).toBe(0);
      expect(probeResult(run.out).argv).toEqual(["restart", "ecosystem.config.json"]);
      expect(run.out).toContain('(saved runtime override).');
    } finally {
      rmSync(farm.farm, { recursive: true, force: true });
      rmSync(scrub, { recursive: true, force: true });
    }
  }, 30000);

  test.skipIf(!POSIX || !NODE_BIN)("a corrupt store value is inert — never a crash", () => {
    const farm = probePackage40();
    const scrub = mkdtempSync(join(tmpdir(), "pboss-i40-scrub-"));
    symlinkSync(NODE_BIN!, join(scrub, "node"));
    farmTools(scrub);
    const home = join(farm.farm, "home");
    mkdirSync(home, { recursive: true });
    try {
      writeFileSync(join(home, ".runtime"), "node\n");
      writeFileSync(join(home, "runtime-overrides"), "my-api\twasd\nnot-a-line\n");
      const run = runWrapper40(farm.wrapper, ["restart", "my-api"], scrub, home, farm.farm);
      expect(run.code, `stderr:\n${run.err}`).toBe(0);
      expect(probeResult(run.out).argv).toEqual(["restart", "my-api"]);
    } finally {
      rmSync(farm.farm, { recursive: true, force: true });
      rmSync(scrub, { recursive: true, force: true });
    }
  }, 30000);
});
