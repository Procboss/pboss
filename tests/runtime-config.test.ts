/**
 * The persistent, user-selected runtime configuration (the wrapper
 * architecture's core contract).
 *
 *   ~/.pboss/.runtime — plain text, one lowercase word (node | bun | deno)
 *   --runtime=<x>     — one-invocation override; initializes when absent,
 *                       never silently overwrites an existing selection
 *   pboss runtime     — status: the configured selection + executing engine
 *   pboss runtime change — the interactive switcher (atomic; installs the
 *                       runtime and the published package before committing)
 *
 * Unit cases cover the canonical list, normalization, the flag scan (both
 * spellings, the `--` sentinel, missing values), the .runtime round-trip
 * and the install-command table (deno's entry subpath!). E2E cases run the
 * real CLI on a hermetic PBOSS_HOME — same harness as issue-28/34/config-file.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SUPPORTED_RUNTIMES,
  isValidRuntime,
  normalizeRuntime,
  scanRuntimeFlag,
  readConfiguredRuntime,
  readRuntimeFileRaw,
  writeRuntimeSelection,
  unsupportedRuntimeMessage,
  invalidRuntimeConfigMessage,
  pbossInstallArgv,
  resolvePbossInstallArgv,
  runtimeSpawnArgv,
  nodeDistPlatform,
  extractNodeTarballName,
  firstRunPromptText,
  runtimeChangePromptText,
  parseRuntimeAnswer,
} from "../src/runtime-config";

/* ── unit: the canonical list ────────────────────────────────────────────── */

describe("runtime-config: the canonical runtime list", () => {
  test("exactly node, bun, deno — one set everywhere", () => {
    expect([...SUPPORTED_RUNTIMES]).toEqual(["node", "bun", "deno"]);
  });

  test("validation normalizes: trim + lowercase", () => {
    expect(isValidRuntime("node")).toBe(true);
    expect(isValidRuntime("  Bun ")).toBe(true);
    expect(isValidRuntime("DENO\n")).toBe(true);
    expect(isValidRuntime("xyz")).toBe(false);
    expect(isValidRuntime("")).toBe(false);
    expect(isValidRuntime(null)).toBe(false);
  });

  test("normalizeRuntime is trim + lowercase (writers use it)", () => {
    expect(normalizeRuntime("  Bun\r\n")).toBe("bun");
    expect(normalizeRuntime("NODE")).toBe("node");
  });
});

/* ── unit: the exact spec texts ─────────────────────────────────────────── */

describe("runtime-config: the spec error texts", () => {
  test("unsupported runtime (an invalid --runtime value)", () => {
    expect(unsupportedRuntimeMessage("xyz")).toBe(
      "Unsupported runtime: xyz\n\nSupported runtimes:\n  node\n  bun\n  deno",
    );
  });

  test("invalid runtime configuration (a broken .runtime file)", () => {
    expect(invalidRuntimeConfigMessage("oops")).toBe(
      "Invalid ProcBoss runtime configuration: oops\n\nSupported runtimes:\n  node\n  bun\n  deno",
    );
  });

  test("the first-run prompt matches the spec layout, Node defaulting", () => {
    expect(firstRunPromptText()).toBe(
      "Kindly select your runtime:\n\n  1. Node\n  2. Bun\n  3. Deno\n\nSelect runtime [1]: ",
    );
    expect(runtimeChangePromptText("bun")).toContain("Current runtime: Bun");
    expect(runtimeChangePromptText(null)).toContain("Current runtime: none configured");
  });

  test("prompt answers: numbers, names, and the Enter default (node)", () => {
    expect(parseRuntimeAnswer("")).toBe("node");
    expect(parseRuntimeAnswer("1")).toBe("node");
    expect(parseRuntimeAnswer("2")).toBe("bun");
    expect(parseRuntimeAnswer("3")).toBe("deno");
    expect(parseRuntimeAnswer(" Bun ")).toBe("bun");
    expect(parseRuntimeAnswer("node")).toBe("node");
    expect(parseRuntimeAnswer("42")).toBeNull();
  });
});

/* ── unit: the --runtime flag scan (the wrappers' twin) ─────────────────── */

describe("runtime-config: scanRuntimeFlag", () => {
  test("no flag → argv untouched", () => {
    const r = scanRuntimeFlag(["start", "app.js", "--name", "x"]);
    expect(r.explicit).toBe(false);
    expect(r.missingValue).toBe(false);
    expect(r.rest).toEqual(["start", "app.js", "--name", "x"]);
  });

  test("= form anywhere, both spellings", () => {
    expect(scanRuntimeFlag(["--runtime=bun", "list"]).value).toBe("bun");
    expect(scanRuntimeFlag(["list", "--runtime", "bun"]).value).toBe("bun");
    expect(scanRuntimeFlag(["--runtime", "deno", "list"]).rest).toEqual(["list"]);
    expect(scanRuntimeFlag(["list", "--runtime=bun"]).rest).toEqual(["list"]);
  });

  test("the flag is consumed exactly once (value pairs skip their value)", () => {
    const r = scanRuntimeFlag(["--runtime", "bun", "start", "app.js"]);
    expect(r.value).toBe("bun");
    expect(r.rest).toEqual(["start", "app.js"]);
  });

  test("everything after `--` is untouchable — the app's own argv", () => {
    const r = scanRuntimeFlag(["start", "app.js", "--", "--runtime=bun"]);
    expect(r.explicit).toBe(false);
    expect(r.rest).toEqual(["start", "app.js", "--", "--runtime=bun"]);
  });

  test("a value flag at the end is a missing value, not a guess", () => {
    const r = scanRuntimeFlag(["list", "--runtime"]);
    expect(r.missingValue).toBe(true);
    expect(r.explicit).toBe(false);
    expect(r.rest).toEqual(["list", "--runtime"]);
  });
});

/* ── unit: the .runtime file ────────────────────────────────────────────── */

describe("runtime-config: the .runtime file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pboss-rtfile-"));
  const file = join(dir, ".runtime");

  test("absent → null; write + read round-trips; case is normalized", async () => {
    expect(await readConfiguredRuntime(file)).toBeNull();
    expect(await readRuntimeFileRaw(file)).toBeNull();
    await writeRuntimeSelection("bun", file);
    expect(await readConfiguredRuntime(file)).toBe("bun");
    expect(await readRuntimeFileRaw(file)).toBe("bun");
    // plain text, one lowercase word, trailing newline
    expect(readFileSync(file, "utf8")).toBe("bun\n");
  });

  test("present but invalid → throws the spec-20 message (never a guess)", async () => {
    writeFileSync(file, "xyz\n", "utf8");
    await expect(readConfiguredRuntime(file)).rejects.toThrow(
      "Invalid ProcBoss runtime configuration: xyz",
    );
    expect(await readRuntimeFileRaw(file)).toBe("xyz");
  });

  test("mixed-case hand-edited values are normalized on read", async () => {
    writeFileSync(file, "Bun", "utf8");
    expect(await readConfiguredRuntime(file)).toBe("bun");
  });

  test("re-writing is atomic (no leftover temp files)", async () => {
    await writeRuntimeSelection("node", file);
    await writeRuntimeSelection("deno", file);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(await readConfiguredRuntime(file)).toBe("deno");
  });
});

/* ── unit: the install command table ───────────────────────────────────── */

describe("runtime-config: install commands", () => {
  test("node → npm, bun → bun (the published package, globally)", () => {
    expect(pbossInstallArgv("node")).toEqual(["npm", "install", "-g", "pboss@latest"]);
    expect(pbossInstallArgv("bun")).toEqual(["bun", "add", "-g", "pboss@latest"]);
    expect(pbossInstallArgv("node", "1.6.0")).toEqual(["npm", "install", "-g", "pboss@1.6.0"]);
  });

  test("deno → the published ENTRY SUBPATH (deno runs bins as modules)", () => {
    expect(pbossInstallArgv("deno")).toEqual([
      "deno",
      "install",
      "-g",
      "-f",
      "-A",
      "--name",
      "pboss",
      "npm:pboss/deno-entry",
    ]);
    // version pins ride the specifier, not a flag
    expect(pbossInstallArgv("deno", "1.6.0").at(-1)).toBe("npm:pboss@1.6.0/deno-entry");
  });

  test("deno launches need the permission flags; node/bun are plain", () => {
    expect(runtimeSpawnArgv("deno", "/x/cli.deno.js", ["a"])).toEqual([
      "deno",
      "run",
      "-A",
      "/x/cli.deno.js",
      "a",
    ]);
    expect(runtimeSpawnArgv("node", "/x/cli.node.js", ["a"])).toEqual(["node", "/x/cli.node.js", "a"]);
  });

  test("the node rootless install maps platforms and finds tarballs", () => {
    expect(nodeDistPlatform("linux", "x64")).toBe("linux-x64");
    expect(nodeDistPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(nodeDistPlatform("win32", "x64")).toBeNull();
    const listing = `<a href="node-v22.14.0-linux-x64.tar.xz">node-v22.14.0-linux-x64.tar.xz</a>
      <a href="node-v22.14.0-linux-arm64.tar.xz">node-v22.14.0-linux-arm64.tar.xz</a>
      <a href="SHASUMS256.txt">SHASUMS256.txt</a>`;
    expect(extractNodeTarballName(listing, "linux-x64")).toBe("node-v22.14.0-linux-x64.tar.xz");
    expect(extractNodeTarballName(listing, "darwin-arm64")).toBeNull();
  });
});

/* ── e2e: the real CLI on a hermetic PBOSS_HOME ─────────────────────────── */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: home,
  });
}

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
  return { out: stripAnsi(out), err: stripAnsi(err), code: code ?? 0 };
}

describe("runtime-config: e2e — --runtime on the real CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "pboss-rtcli-"));
  const runtimeFile = join(home, ".runtime");

  test("--runtime=bun with no selection INITIALIZES it and runs", async () => {
    const r = await runCli(["--runtime=bun", "--version"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pboss v");
    expect(readFileSync(runtimeFile, "utf8")).toBe("bun\n");
  });

  test("--runtime=X with a DIFFERENT selection: override notice, file untouched", async () => {
    const r = await runCli(["--runtime=node", "--version"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Using Node for this invocation.");
    expect(r.out).toContain("Configured runtime remains: Bun");
    expect(r.out).toContain("To permanently change the runtime:");
    expect(r.out).toContain("pboss runtime change");
    expect(readFileSync(runtimeFile, "utf8")).toBe("bun\n"); // NOT overwritten
  });

  test("--runtime=X matching the selection: no noise, just runs", async () => {
    const r = await runCli(["--runtime=bun", "--version"], home);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Configured runtime remains");
    expect(r.out).toContain("pboss v");
  });

  test("invalid values die with the exact unsupported-runtime text", async () => {
    const r = await runCli(["--runtime=xyz", "--version"], home);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Unsupported runtime: xyz");
    expect(r.err).toContain("Supported runtimes:");
  });

  test("a bare --runtime (no value) is a usage error", async () => {
    const r = await runCli(["--runtime"], home);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toContain("--runtime requires a value");
  });

  test("the flag works in any position, and after `--` it is the app's", async () => {
    expect((await runCli(["--version", "--runtime=bun"], home)).code).toBe(0);
    // NOTE: `bun run script -- X` eats the FIRST `--` as its own separator —
    // the doubled `--` is what delivers a literal leading `--` to the CLI
    // (node dist/cli.js -- X has no such artifact; same rule as the
    // start-flag parser's sentinel).
    const sentinel = await runCli(["--", "--", "--runtime=bun"], home);
    expect(sentinel.code).toBe(1); // bare `--` becomes the command → unknown
    expect(sentinel.out + sentinel.err).toContain("Unknown command: --");
  });

  test("no flag + no selection: direct invocation never prompts (tests/CI safe)", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "pboss-rtnone-"));
    const r = await runCli(["--version"], fresh); // stdin is "ignore"
    expect(r.code).toBe(0);
    expect(r.out).toContain("pboss v");
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe("runtime-config: e2e — pboss runtime (status)", () => {
  const home = mkdtempSync(join(tmpdir(), "pboss-rtstatus-"));

  test("status shows the configured selection and the executing engine", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".runtime"), "bun\n", "utf8");
    const r = await runCli(["runtime"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Configured runtime: Bun");
    expect(r.out).toContain("Executing engine:");
    expect(r.out).toContain("Bun");
  });

  test("status with no selection says so and teaches the commands", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "pboss-rtfresh-"));
    const r = await runCli(["runtime"], fresh);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Configured runtime: none");
    expect(r.out).toContain("pboss runtime change");
    rmSync(fresh, { recursive: true, force: true });
  });

  test("a broken .runtime is reported, never guessed", async () => {
    const broken = mkdtempSync(join(tmpdir(), "pboss-rtbroken-"));
    writeFileSync(join(broken, ".runtime"), "kubernetes\n", "utf8");
    const r = await runCli(["runtime"], broken);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Invalid ProcBoss runtime configuration: kubernetes");
    rmSync(broken, { recursive: true, force: true });
  });
});

/* ── unit: resolvePbossInstallArgv (Deno's supply-chain window) ─────────── */

describe("runtime-config: resolvePbossInstallArgv (the deno window)", () => {
  /** A fetcher serving one packument (or a rejection). */
  const serving = (body: unknown) =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch;
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const packument = (ages: Record<string, number>, latest: string) => ({
    versions: Object.fromEntries(Object.keys(ages).map((v) => [v, {}])),
    time: Object.fromEntries(Object.entries(ages).map(([v, h]) => [v, ago(h)])),
    "dist-tags": { latest },
  });

  test("node/bun: plain ecosystem commands, no registry read", async () => {
    const calls: string[] = [];
    const counting = (async () => { calls.push("called"); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const node = await resolvePbossInstallArgv("node", undefined, counting);
    const bun = await resolvePbossInstallArgv("bun", undefined, counting);
    expect(node.argv).toEqual(["npm", "install", "-g", "pboss@latest"]);
    expect(bun.argv).toEqual(["bun", "add", "-g", "pboss@latest"]);
    expect(node.via).toBe("node");
    expect(bun.via).toBe("bun");
    expect(calls).toEqual([]); // the window is a deno-only concern
  });

  test("deno + explicit version: the user's own pin, no registry read", async () => {
    const counting = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    const r = await resolvePbossInstallArgv("deno", "1.6.2", counting);
    expect(r.argv.at(-1)).toBe("npm:pboss@1.6.2/deno-entry");
    expect(r.via).toBe("deno");
    expect(r.note).toBeUndefined();
  });

  test("deno: pins the newest resolvable version; a fresh latest gets the hold note", async () => {
    // 1.6.0 old, 1.6.1 two hours old, latest = 1.6.1.
    const r = await resolvePbossInstallArgv(
      "deno", undefined,
      serving(packument({ "1.5.3": 24 * 7, "1.6.0": 24 * 9, "1.6.1": 2 }, "1.6.1")),
    );
    expect(r.argv.at(-1)).toBe("npm:pboss@1.6.0/deno-entry");
    expect(r.via).toBe("deno");
    expect(r.note).toContain("supply-chain hold");
    expect(r.note).toContain("v1.6.0");
  });

  test("deno: best === latest → no note", async () => {
    const r = await resolvePbossInstallArgv(
      "deno", undefined,
      serving(packument({ "1.6.0": 24 * 9, "1.6.1": 24 * 2 }, "1.6.1")),
    );
    expect(r.argv.at(-1)).toBe("npm:pboss@1.6.1/deno-entry");
    expect(r.via).toBe("deno");
    expect(r.note).toBeUndefined();
  });

  test("deno: no resolvable deno-entry version → npm delivery + the honest note", async () => {
    // The owner's transition state: 1.5.3 old (no ./deno-entry), 1.6.0 fresh.
    const r = await resolvePbossInstallArgv(
      "deno", undefined,
      serving(packument({ "1.5.3": 24 * 7, "1.6.0": 16 }, "1.6.0")),
    );
    expect(r.argv).toEqual(["npm", "install", "-g", "pboss@latest"]);
    expect(r.via).toBe("npm");
    expect(r.note).toContain("holding back");
    expect(r.note).toContain("delivery vehicle");
  });

  test("deno: registry unreachable → unpinned spec + the honest note", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const r = await resolvePbossInstallArgv("deno", undefined, failing);
    expect(r.argv.at(-1)).toBe("npm:pboss/deno-entry");
    expect(r.via).toBe("deno");
    expect(r.note).toContain("Could not read the registry");
  });

  /* ── the age-hold bypass (Deno ≥ 2.9 knows --minimum-dependency-age) ─── */

  test("deno + bypass: the registry's TRUE latest installs with the flag — no window pin", async () => {
    // The owner's exact report state: 1.6.1 published 2 h ago (inside the
    // window — unpinned would silently land on 1.5.3, a broken shim).
    const r = await resolvePbossInstallArgv(
      "deno", undefined,
      serving(packument({ "1.5.3": 24 * 7, "1.6.0": 24 * 10, "1.6.1": 2 }, "1.6.1")),
      async () => true,
    );
    expect(r.argv).toEqual([
      "deno", "install", "-g", "-f", "-A",
      "--minimum-dependency-age=0",
      "--name", "pboss", "npm:pboss@1.6.1/deno-entry",
    ]);
    expect(r.via).toBe("deno");
    expect(r.note).toContain("bypassed");
    // The window pin is GONE — 1.6.0 must not appear.
    expect(r.argv.at(-1)).not.toContain("1.6.0");
  });

  test("deno + bypass: registry unreachable → the unpinned spec STILL carries the flag", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const r = await resolvePbossInstallArgv("deno", undefined, failing, async () => true);
    expect(r.argv).toEqual([
      "deno", "install", "-g", "-f", "-A",
      "--minimum-dependency-age=0",
      "--name", "pboss", "npm:pboss/deno-entry",
    ]);
    expect(r.via).toBe("deno");
    expect(r.note).toContain("age hold disabled");
  });

  test("deno + explicit version + bypass: the user's pin carries the flag too", async () => {
    const counting = (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    const r = await resolvePbossInstallArgv("deno", "1.6.1", counting, async () => true);
    expect(r.argv).toEqual([
      "deno", "install", "-g", "-f", "-A",
      "--minimum-dependency-age=0",
      "--name", "pboss", "npm:pboss@1.6.1/deno-entry",
    ]);
    expect(r.via).toBe("deno");
    expect(r.note).toBeUndefined();
  });

  test("deno, NO bypass (old deno): the window pin survives unchanged", async () => {
    // Same fresh-latest fixture as the bypass test, but the prober says
    // the local deno has no flag — the newest RESOLVABLE version pins.
    const r = await resolvePbossInstallArgv(
      "deno", undefined,
      serving(packument({ "1.5.3": 24 * 7, "1.6.0": 24 * 10, "1.6.1": 2 }, "1.6.1")),
      async () => false,
    );
    expect(r.argv.at(-1)).toBe("npm:pboss@1.6.0/deno-entry");
    expect(r.argv).not.toContain("--minimum-dependency-age=0");
    expect(r.note).toContain("supply-chain hold");
  });

  test("pbossInstallArgv: bypass only ever touches the deno form", () => {
    expect(pbossInstallArgv("node", undefined, true)).toEqual(["npm", "install", "-g", "pboss@latest"]);
    expect(pbossInstallArgv("bun", undefined, true)).toEqual(["bun", "add", "-g", "pboss@latest"]);
    expect(pbossInstallArgv("deno")).toEqual([
      "deno", "install", "-g", "-f", "-A", "--name", "pboss", "npm:pboss/deno-entry",
    ]);
    expect(pbossInstallArgv("deno", "1.6.1", true)).toEqual([
      "deno", "install", "-g", "-f", "-A", "--minimum-dependency-age=0",
      "--name", "pboss", "npm:pboss@1.6.1/deno-entry",
    ]);
  });
});
