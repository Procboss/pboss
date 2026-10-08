/**
 * tsx integration — Node.js TypeScript support (v1.5.1).
 *
 * The problem this pins: Node's `--experimental-strip-types` only handles
 * ERASABLE TypeScript syntax — enums, namespaces, parameter properties and
 * friends are rejected outright. A TypeScript worker that lands on Node
 * (no Bun, no Deno on the machine) used to fail on exactly that.
 *
 * The contract under test:
 *   1. decideScriptInterpreter — the pure chain: bun → deno → node, and
 *      node+TypeScript resolves through tsx when usable, falling back to
 *      `--experimental-strip-types` only when no tsx exists.
 *   2. findTsx routes, in priority order: app-local devDependency → tsx
 *      executable on PATH → pboss's own shipped optionalDependency.
 *   3. pboss SHIPS tsx (optionalDependencies) — the graph route finds a
 *      real, runnable cli.
 *   4. An explicit --interpreter stays VERBATIM — no tsx injection over a
 *      user's deliberate choice.
 *
 * Route 3 and the app/PATH routes run in controlled subprocesses with
 * explicit PATH/HOME (the runtime-discovery pattern): Bun.which resolves
 * against the spawn-time env, so that is the only faithful way to fake the
 * machine's view. The pure decision runs in-process — no environment can
 * hide a fixed system location from a live probe, which is exactly why it
 * was separated out.
 *
 * The node binary itself is never hardcoded: findNode() resolves the
 * machine's REAL node (nvm/fnm/volta/homebrew machines keep it outside
 * /usr/bin, where a hardcoded path made every probe die with ENOENT and
 * the in-process findTsx — which validates the node path — return null).
 * Machines with no node at all have nothing under test: the probes skip
 * instead of failing.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isTypeScriptFile,
  decideScriptInterpreter,
  findTsx,
  findNode,
  resolveScriptInterpreter,
} from "../src/install-mode";
import { ClusterManager } from "../src/cluster-manager";
import type { ProcessDescription } from "../src/types";

const ROOT = join(import.meta.dir, "..");

// The node on THIS machine, resolved exactly the way production resolves
// it (findNode: the runtime's which() + the /usr/local/bin fallback) — the
// tests used to hardcode /usr/bin/node, which silently assumed a
// distro-packaged install. Null on node-less machines: the probe tests
// skip (nothing to test), the pure ones run regardless.
const NODE_BIN = await findNode();
const nodeTest = NODE_BIN ? test : test.skip;

function makeConfig(
  script: string,
  overrides: Partial<ProcessDescription> = {}
): ProcessDescription {
  return {
    id: 0,
    name: "test-proc",
    script,
    args: [],
    cwd: "/app",
    env: {},
    instances: 1,
    execMode: "fork",
    autorestart: true,
    maxRestarts: 10,
    minUptime: 1000,
    ...overrides,
  } as ProcessDescription;
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-tsx-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. The pure interpreter chain
// ---------------------------------------------------------------------------

describe("decideScriptInterpreter: the chain (pure)", () => {
  const NONE = { bun: null, deno: null, node: null, tsx: null };

  test("bun always wins — TS or not, tsx present or not", () => {
    expect(decideScriptInterpreter("app.ts", { ...NONE, bun: "/usr/local/bin/bun" })).toEqual([
      "/usr/local/bin/bun", "run",
    ]);
  });

  test("deno is next — TS-native, no tsx consulted (deny-by-default, quiet)", () => {
    expect(decideScriptInterpreter("app.ts", { ...NONE, deno: "/home/u/.deno/bin/deno" })).toEqual([
      "/home/u/.deno/bin/deno", "run", "--quiet",
    ]);
  });

  test("node + TypeScript + tsx → runs THROUGH tsx", () => {
    expect(
      decideScriptInterpreter("server.ts", {
        ...NONE,
        node: "/usr/bin/node",
        tsx: { cmd: ["/usr/bin/node", "/x/node_modules/tsx/dist/cli.mjs"], source: "app" },
      })
    ).toEqual(["/usr/bin/node", "/x/node_modules/tsx/dist/cli.mjs"]);
  });

  test("node + TypeScript + NO tsx → the strip-types fallback survives", () => {
    expect(decideScriptInterpreter("server.ts", { ...NONE, node: "/usr/bin/node" })).toEqual([
      "/usr/bin/node", "--experimental-strip-types",
    ]);
  });

  test("node + JavaScript → plain node, no tsx, no flags", () => {
    expect(decideScriptInterpreter("server.js", { ...NONE, node: "/usr/bin/node" })).toEqual([
      "/usr/bin/node",
    ]);
    expect(decideScriptInterpreter("server.mjs", { ...NONE, node: "/usr/bin/node" })).toEqual([
      "/usr/bin/node",
    ]);
    expect(decideScriptInterpreter("server.cjs", { ...NONE, node: "/usr/bin/node" })).toEqual([
      "/usr/bin/node",
    ]);
  });

  test("nothing found → the actionable error naming every search", () => {
    let err: unknown;
    try {
      decideScriptInterpreter("app.ts", NONE);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("no JavaScript/TypeScript runtime was found");
    expect((err as Error).message).toContain("Looked for Bun");
    expect((err as Error).message).toContain("https://bun.sh");
    expect((err as Error).message).toContain("--interpreter none");
  });
});

describe("isTypeScriptFile", () => {
  test("ts/tsx/jsx/mts are TypeScript; js/mjs/cjs and dotfiles are not", () => {
    for (const f of ["a.ts", "a.tsx", "a.jsx", "a.mts", "/x/y/z.TS"]) {
      expect(isTypeScriptFile(f)).toBe(true);
    }
    for (const f of ["a.js", "a.mjs", "a.cjs", "a.py", "noext", ".ts/whatever"]) {
      expect(isTypeScriptFile(f)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. findTsx — the three routes
// ---------------------------------------------------------------------------

/** A fixture tsx package in <dir>/node_modules/tsx: package.json + bin file. */
function fixtureTsxIn(dir: string, version = "9.9.9"): string {
  const pkgDir = join(dir, "node_modules", "tsx");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "tsx", version, bin: "./dist/cli.mjs" })
  );
  writeFileSync(join(pkgDir, "dist", "cli.mjs"), "// fixture tsx cli\n");
  return join(pkgDir, "dist", "cli.mjs");
}

describe("findTsx: app-local devDependency wins over pboss's own copy", () => {
  nodeTest("resolves the app's node_modules/tsx and its bin entry", async () => {
    const appDir = scratch("app");
    const cli = fixtureTsxIn(appDir);
    const res = await findTsx(NODE_BIN!, join(appDir, "server.ts"));
    expect(res).not.toBeNull();
    expect(res!.source).toBe("app");
    expect(res!.cmd).toEqual([NODE_BIN!, cli]);
  });

  nodeTest("a broken bin field is a miss, not an error (node probe)", () => {
    const appDir = scratch("appbroken");
    const pkgDir = join(appDir, "node_modules", "tsx");
    mkdirSync(pkgDir, { recursive: true });
    // A tsx package WITHOUT a bin field: under node's strict resolution the
    // app route reads THIS fixture, misses, and falls through to the next
    // route (the repo's own copy) — never throwing.
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "tsx" }));
    const { code, out } = runNodeProbe(
      `const r = await findTsx(${JSON.stringify(NODE_BIN!)}, ${JSON.stringify(join(appDir, "server.ts"))});\nconsole.log("__JSON__" + JSON.stringify(r));`,
      { PATH: "/usr/bin:/bin", HOME: scratch("brokenHome") }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.slice(out.indexOf("__JSON__") + 8).trim());
    expect(parsed.source).toBe("pboss");
  });
});

/**
 * Probe runner: runs a TS script under NODE + the repo's tsx with a
 * controlled env, returns stdout.
 *
 * Why node and not bun (the test runner): findTsx only ever executes in
 * production when the machine has NO bun and NO deno — i.e. under pboss on
 * Node. Bun's createRequire additionally resolves bare specifiers from its
 * global install cache, which would make the app route never miss and the
 * route order untestable; node gives the strict climb the real machine sees.
 */
function runNodeProbe(body: string, env: Record<string, string>): { code: number; out: string } {
  if (!NODE_BIN) throw new Error("runNodeProbe reached on a node-less machine (the test should have skipped)");
  const dir = scratch("probe");
  // "type": "module" — the probe uses top-level await; without it tsx
  // transpiles .ts to CJS and refuses TLA.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const script = join(dir, "probe.ts");
  writeFileSync(
    script,
    `import { findTsx } from ${JSON.stringify(join(ROOT, "src", "install-mode"))};\n${body}\n`
  );
  const proc = Bun.spawnSync(
    [NODE_BIN, join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), script],
    { env, stdout: "pipe", stderr: "pipe" }
  );
  return { code: proc.exitCode, out: proc.stdout.toString() };
}

describe("findTsx: PATH route (probe subprocess)", () => {
  nodeTest("a real tsx executable on PATH is used directly (POSIX shebang script)", () => {
    const home = scratch("pathhome");
    const tsxDir = join(home, "bin");
    mkdirSync(tsxDir, { recursive: true });
    const tsxPath = join(tsxDir, "tsx");
    writeFileSync(tsxPath, "#!/bin/sh\nexit 0\n");
    chmodSync(tsxPath, 0o755);

    const appDir = scratch("pathapp"); // no app-local tsx
    const { code, out } = runNodeProbe(
      `const r = await findTsx(${JSON.stringify(NODE_BIN!)}, ${JSON.stringify(join(appDir, "server.ts"))});\nconsole.log("__JSON__" + JSON.stringify(r));`,
      { PATH: `${tsxDir}:/usr/bin:/bin`, HOME: home }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.slice(out.indexOf("__JSON__") + 8).trim());
    expect(parsed.source).toBe("path");
    expect(parsed.cmd).toEqual([tsxPath]);
  });

  nodeTest("app-local beats a tsx that is also on PATH", () => {
    const home = scratch("prioHome");
    const tsxDir = join(home, "bin");
    mkdirSync(tsxDir, { recursive: true });
    const tsxPath = join(tsxDir, "tsx");
    writeFileSync(tsxPath, "#!/bin/sh\nexit 0\n");
    chmodSync(tsxPath, 0o755);

    const appDir = scratch("prioApp");
    const cli = fixtureTsxIn(appDir);
    const { code, out } = runNodeProbe(
      `const r = await findTsx(${JSON.stringify(NODE_BIN!)}, ${JSON.stringify(join(appDir, "server.ts"))});\nconsole.log("__JSON__" + JSON.stringify(r));`,
      { PATH: `${tsxDir}:/usr/bin:/bin`, HOME: home }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.slice(out.indexOf("__JSON__") + 8).trim());
    expect(parsed.source).toBe("app");
    expect(parsed.cmd).toEqual([NODE_BIN!, cli]);
  });
});

// ---------------------------------------------------------------------------
// 3. pboss ships tsx — the optionalDependency is real and resolvable
// ---------------------------------------------------------------------------

describe("pboss's own tsx (optionalDependencies)", () => {
  test("package.json declares tsx as an optional dependency (^4)", async () => {
    const pkg = JSON.parse(await Bun.file(join(ROOT, "package.json")).text()) as {
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.optionalDependencies?.tsx).toMatch(/^\^4\./);
  });

  nodeTest("the graph route resolves the shipped copy from the repo (probe subprocess)", () => {
    // No app-local tsx, nothing on PATH — the pboss route must find the
    // copy bun install placed in the repo's node_modules.
    const appDir = scratch("graphApp");
    const { code, out } = runNodeProbe(
      `const r = await findTsx(${JSON.stringify(NODE_BIN!)}, ${JSON.stringify(join(appDir, "server.ts"))});\nconsole.log("__JSON__" + JSON.stringify(r));`,
      { PATH: "/usr/bin:/bin", HOME: scratch("graphHome") }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.slice(out.indexOf("__JSON__") + 8).trim());
    expect(parsed.source).toBe("pboss");
    expect(parsed.cmd[0]).toBe(NODE_BIN!);
    expect(parsed.cmd[1]).toContain(join("node_modules", "tsx"));
    expect(parsed.cmd[1]).toMatch(/cli\.mjs$/);
  });

  nodeTest("the shipped cli actually runs TypeScript under node (enum — non-erasable syntax)", async () => {
    // Prove the exact command pboss would spawn works: node <tsx cli> app.ts
    // with syntax --experimental-strip-types REJECTS.
    const pkgJson = JSON.parse(await Bun.file(join(ROOT, "package.json")).text()) as {
      optionalDependencies?: Record<string, string>;
    };
    expect(pkgJson.optionalDependencies?.tsx).toBeTruthy();

    const probe = runNodeProbe(
      `import { createRequire } from "node:module";\n` +
        `const req = createRequire(${JSON.stringify(join(ROOT, "src", "install-mode.ts"))});\n` +
        `const pkgPath = req.resolve("tsx/package.json");\n` +
        `const { dirname, join } = await import("node:path");\n` +
        `const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(pkgPath));\n` +
        `console.log("__JSON__" + JSON.stringify({ cli: join(dirname(pkgPath), pkg.bin) }));`,
      { PATH: "/usr/bin:/bin", HOME: scratch("cliHome") }
    );
    expect(probe.code).toBe(0);
    const { cli } = JSON.parse(probe.out.slice(probe.out.indexOf("__JSON__") + 8).trim());

    const appDir = scratch("realrun");
    const app = join(appDir, "enum-app.ts");
    writeFileSync(
      app,
      "enum Color { Red, Green }\nconst c: Color = Color.Green;\nconsole.log(\"ENUM_OK\", c);\n"
    );
    const proc = Bun.spawnSync([NODE_BIN!, cli, app], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("ENUM_OK 1");
  });
});

// ---------------------------------------------------------------------------
// 4. The wiring — buildWorkerCommand, --interpreter verbatim
// ---------------------------------------------------------------------------

describe("buildWorkerCommand honors the chain and explicit interpreters", () => {
  const cm = new ClusterManager();

  test("an explicit --interpreter node runs TypeScript VERBATIM (no tsx injected)", async () => {
    const cmd = await cm.buildWorkerCommand(makeConfig("app.ts", { interpreter: "node" }));
    expect(cmd[0]).toBe("node");
    expect(cmd.slice(0, 2)).toEqual(["node", expect.stringContaining("app.ts")]);
  });

  test("interpreter 'none' executes the binary directly", async () => {
    const cmd = await cm.buildWorkerCommand(makeConfig("./svc", { interpreter: "none" }));
    expect(cmd[0]).toContain("svc");
  });

  test("resolveScriptInterpreter (live) prefers bun when it exists — the documented chain", async () => {
    // In the test environment bun IS the executing runtime, so the chain
    // must resolve bun first — pin that the tsx addition never reordered it.
    const cmd = await resolveScriptInterpreter("whatever.ts");
    expect(cmd[1]).toBe("run");
  });
});

// ---------------------------------------------------------------------------
// 5. Static source pins
// ---------------------------------------------------------------------------

describe("source pins: the tsx integration cannot silently regress", () => {
  test("install-mode resolves tsx through package.json + bin (version-tolerant)", async () => {
    const src = await Bun.file(join(ROOT, "src", "install-mode.ts")).text();
    expect(src).toContain('req.resolve("tsx/package.json")');
    expect(src).toContain("pkg.bin");
    // The chain: tsx BEFORE the strip-types fallback.
    const tsxIdx = src.indexOf("if (found.tsx) return found.tsx.cmd;");
    const stripIdx = src.indexOf('return [found.node, "--experimental-strip-types"];');
    expect(tsxIdx).toBeGreaterThan(0);
    expect(stripIdx).toBeGreaterThan(tsxIdx);
  });

  test("cluster-manager awaits the (now async) interpreter resolution", async () => {
    const src = await Bun.file(join(ROOT, "src", "cluster-manager.ts")).text();
    expect(src).toContain("await resolveScriptInterpreter(config.script)");
  });
});
