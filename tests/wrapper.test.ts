/**
 * The bin wrapper contract (bin/pboss.sh + bin/pboss.ps1).
 *
 * The package's bin IS the wrapper: it reads the persistent user selection
 * (~/.pboss/.runtime) or an explicit --runtime flag, and dispatches to the
 * runtime-specific entrypoint (dist/cli.node.js / cli.bun.js / cli.deno.js).
 *
 * Source pins keep the wrapper honest (shebangs, the resolution order, the
 * dispatch table, "$@" forwarding, the `--` sentinel, PBOSS_HOME support, the
 * exact spec error texts) and the runtime LIST is pinned IDENTICAL across
 * every implementation — pboss.sh, pboss.ps1, install.sh, install.ps1 and
 * src/runtime-config.ts (spec §19: one canonical set of supported runtimes).
 *
 * E2E cases run the REAL wrapper through a fake package layout on scrubbed
 * PATH farms — the bun-only machine of issue #38, a node-only machine, a
 * deno-only machine — plus byte-exact argument-forwarding checks and the
 * interactive first-run prompt over a real pty. A final block dispatches the
 * REAL built entries (dist/cli.*.js) per runtime when dist/ exists — that is
 * the layer that catches bundle breakage the echo probes cannot see.
 *
 * Host runtimes are resolved ONCE, up front, and every farm test declares its
 * needs via test.skipIf — a machine without deno REPORTS the deno tests as
 * skipped instead of silently passing them (the Task 227 lesson: a silent
 * skip shipped a broken deno entry as green).
 */
import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const SH = readFileSync(join(ROOT, "bin", "pboss.sh"), "utf8");
const PS1 = readFileSync(join(ROOT, "bin", "pboss.ps1"), "utf8");
const INSTALL_SH = readFileSync(join(ROOT, "scripts", "install.sh"), "utf8");
const INSTALL_PS1 = readFileSync(join(ROOT, "scripts", "install.ps1"), "utf8");

const POSIX = process.platform !== "win32";
/** `script` (util-linux) gives the interactive tests a real pty. */
const HAS_SCRIPT = POSIX && !!Bun.which("script");
/** The host's runtimes — resolved once; skipIf gates every farm on its needs. */
const BUN_BIN = Bun.which("bun");
const NODE_BIN = Bun.which("node");
const DENO_BIN = Bun.which("deno");
/** dist/ is a BUILD ARTIFACT (gitignored): `bun run ./scripts/build-dist.ts`.
 *  The real-entry block below runs when it exists; the issue-38 suite builds
 *  and packs it for the registry install path. */
const DIST_BUILT = existsSync(join(ROOT, "dist", "cli.js"));

/* ── source pins: the wrapper IS the architecture ──────────────────────── */

describe("wrapper: bin/pboss.sh contract (source pins)", () => {
  test("kernel-resolved shebang: /bin/sh — POSIX-guaranteed, PATH-independent", () => {
    // #!/bin/sh is opened by the KERNEL, so the wrapper runs even on a
    // PATH that holds nothing but the chosen runtime (issue #38's farm).
    expect(SH.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("PBOSS_HOME overrides ~/.pboss (tests, portability)", () => {
    expect(SH).toContain('${PBOSS_HOME:-$HOME/.pboss}');
  });

  test("dispatch table: each runtime gets its OWN entrypoint", () => {
    expect(SH).toContain('exec node "$CLI" "$@"');
    expect(SH).toContain('exec bun "$CLI" "$@"');
    expect(SH).toContain('exec deno run -A "$CLI" "$@"');
    expect(SH).toContain('CLI="$PKG_DIR/dist/cli.node.js"');
    expect(SH).toContain('CLI="$PKG_DIR/dist/cli.bun.js"');
    expect(SH).toContain('CLI="$PKG_DIR/dist/cli.deno.js"');
  });

  test("resolution order: flag first, then the persistent selection", () => {
    const flagPos = SH.indexOf('if [ -n "$RUNTIME_FLAG" ]');
    const filePos = SH.indexOf("elif [ -f ");
    expect(flagPos).toBeGreaterThan(0);
    expect(filePos).toBeGreaterThan(flagPos);
  });

  test("arguments are forwarded VERBATIM via \"$@\" (spaces, quotes, --)", () => {
    // The wrapper never rebuilds argv — it scans read-only and execs with
    // the original positional parameters intact.
    expect(SH.match(/"\$@"/g)?.length).toBeGreaterThanOrEqual(4); // each dispatch + help
    expect(SH).toContain("--) break ;;");
  });

  test("the package dir is resolved through the symlink chain (npm links)", () => {
    expect(SH).toContain('while [ -L "$SELF" ]');
    expect(SH).toContain("readlink");
  });

  test("invalid values die with the exact spec texts — never a guess", () => {
    expect(SH).toContain("Unsupported runtime: $RUNTIME_FLAG");
    expect(SH).toContain("Invalid ProcBoss runtime configuration:");
    expect(SH).toContain("--runtime requires a value: node | bun | deno");
    expect(SH).toContain("ProcBoss needs a runtime selection.");
  });

  test("the first-run prompt matches the spec (Node on Enter)", () => {
    expect(SH).toContain("Kindly select your runtime:");
    expect(SH).toContain("Select runtime [1]: ");
    expect(SH).toContain('"" | 1 | node) RUNTIME="node"');
  });

  test("missing runtime at dispatch: the escape hatches are named", () => {
    expect(SH).toContain("ProcBoss requires Bun, but Bun was not found.");
    expect(SH).toContain("pboss --runtime=node");
    expect(SH).toContain("to choose again");
  });
});

describe("wrapper: bin/pboss.ps1 contract (source pins)", () => {
  test("pwsh shebang; dispatch table mirrors the sh twin", () => {
    expect(PS1.startsWith("#!/usr/bin/env pwsh\n")).toBe(true);
    expect(PS1).toContain('& node $cli @args');
    expect(PS1).toContain('& bun $cli @args');
    expect(PS1).toContain('& deno run -A $cli @args');
    expect(PS1).toContain('cli.node.js');
    expect(PS1).toContain('cli.bun.js');
    expect(PS1).toContain('cli.deno.js');
  });

  test("same resolution order + spec texts as the sh twin", () => {
    expect(PS1).toContain("$env:PBOSS_HOME");
    expect(PS1).toContain("Unsupported runtime:");
    expect(PS1).toContain("Invalid ProcBoss runtime configuration:");
    expect(PS1).toContain("Kindly select your runtime:");
    // Read-Host renders the prompt with its own colon: "Select runtime [1]:"
    expect(PS1).toContain('Read-Host "Select runtime [1]"');
    expect(PS1).toContain("ProcBoss needs a runtime selection.");
  });

  test("PS 5.1-safe: no null-coalescing operator", () => {
    // `??` is PowerShell 7+ only; Windows ships 5.1 by default.
    expect(PS1).not.toContain("??");
  });
});

/* ── the canonical runtime list is IDENTICAL everywhere (spec §19) ──────── */

describe("wrapper: one runtime list across every implementation", () => {
  /** Extract the three runtime words from a source's case/if structure. */
  function extractRuntimes(src: string): string[] {
    // shell: `node | bun | deno)` patterns
    const shCases = src.match(/node \| bun \| deno\)/g) ?? [];
    if (shCases.length > 0) return ["node", "bun", "deno"];
    // powershell: `-eq "node" -or -eq "bun" -or -eq "deno"`
    if (src.includes('-eq "node" -or $n -eq "bun" -or $n -eq "deno"')) return ["node", "bun", "deno"];
    // TypeScript: SUPPORTED_RUNTIMES literal
    const ts = src.match(/\[(["'])(node|bun|deno)\1, *(["'])(?!$)(\3|[...]+)/);
    void ts;
    return [];
  }

  test("the wrappers, the installers and the TS module all list node/bun/deno", async () => {
    const tsConfig = await import("../src/runtime-config");
    expect([...tsConfig.SUPPORTED_RUNTIMES]).toEqual(["node", "bun", "deno"]);
    for (const [name, src] of [
      ["bin/pboss.sh", SH],
      ["bin/pboss.ps1", PS1],
      ["scripts/install.sh", INSTALL_SH],
      ["scripts/install.ps1", INSTALL_PS1],
    ] as const) {
      expect(extractRuntimes(src)).toEqual(["node", "bun", "deno"]);
      expect(src).toContain("node");
      expect(src).toContain("bun");
      expect(src).toContain("deno");
      void name;
    }
  });

  test("no implementation accepts a non-runtime as valid (no wildcards)", () => {
    for (const src of [SH, PS1, INSTALL_SH, INSTALL_PS1]) {
      expect(src).not.toMatch(/case .*\*\) RUNTIME=/);
    }
  });
});

/* ── e2e: the REAL wrapper on scrubbed PATH farms ──────────────────────── */

/** The real entry's --runtime contract, mirrored in the probe (same rule):
 *  strip the flag like the CLI does, and INITIALIZE ~/.pboss/.runtime when
 *  none exists (the save the real entry performs). */
const PROBE_STRIP = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const a = process.argv.slice(2);
const out = [];
let rt = null;
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--") { out.push(...a.slice(i)); break; }
  if (a[i] === "--runtime") { rt = a[i + 1]; i++; continue; }
  if (a[i].startsWith("--runtime=")) { rt = a[i].slice(10); continue; }
  out.push(a[i]);
}
if (rt) {
  const home = process.env.PBOSS_HOME || join(process.env.HOME || "", ".pboss");
  const file = join(home, ".runtime");
  if (!existsSync(file)) { mkdirSync(home, { recursive: true }); writeFileSync(file, rt.trim().toLowerCase() + "\\n"); }
}
console.log(JSON.stringify(out));
`;

/** A fake package layout with the REAL wrapper + echo-probe entries. */
function probePackage() {
  const farm = mkdtempSync(join(tmpdir(), "pboss-wrap-"));
  const pkg = join(farm, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", type: "module" }));
  // Echo argv as JSON — proves byte-exact forwarding through the wrapper.
  // The --runtime flag is stripped the same way the real entry strips it.
  // (The REAL built entries are exercised by their own describe block below;
  //  the registry install path — build, pack, install, run — lives in
  //  tests/issue-38.test.ts.)
  writeFileSync(join(pkg, "dist", "cli.node.js"), `#!/usr/bin/env node\n${PROBE_STRIP}`);
  writeFileSync(join(pkg, "dist", "cli.bun.js"), `#!/usr/bin/env bun\n${PROBE_STRIP}`);
  writeFileSync(
    join(pkg, "dist", "cli.deno.js"),
    // The same --runtime contract as the node/bun probes, in Deno-native
    // APIs: strip the flag, and INITIALIZE ~/.pboss/.runtime when none
    // exists (the save the real entry performs — the assertion the deno
    // farm reads back after dispatch).
    `const a = Deno.args; const out = [];\nlet rt = null;\nfor (let i = 0; i < a.length; i++) {\n  if (a[i] === "--") { out.push(...a.slice(i)); break; }\n  if (a[i] === "--runtime") { rt = a[i + 1]; i++; continue; }\n  if (a[i].startsWith("--runtime=")) { rt = a[i].slice(10); continue; }\n  out.push(a[i]);\n}\nif (rt) {\n  const home = Deno.env.get("PBOSS_HOME") || (Deno.env.get("HOME") + "/.pboss");\n  const file = home + "/.runtime";\n  let exists = true;\n  try { Deno.readTextFileSync(file); } catch { exists = false; }\n  if (!exists) { Deno.mkdirSync(home, { recursive: true }); Deno.writeTextFileSync(file, rt.trim().toLowerCase() + "\\n"); }\n}\nconsole.log(JSON.stringify(out));\n`,
  );
  writeFileSync(join(pkg, "bin", "pboss.sh"), SH);
  chmodSync(join(pkg, "bin", "pboss.sh"), 0o755);
  const bin = join(farm, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(pkg, "bin", "pboss.sh"), join(bin, "pboss"));
  return { farm, pkg, bin };
}

/** A scrubbed PATH dir holding ONLY the given runtime + the POSIX tools. */
function runtimeFarm(runtimes: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pboss-rtfarm-"));
  for (const rt of runtimes) {
    const target = rt === "bun" ? BUN_BIN : rt === "node" ? NODE_BIN : rt === "deno" ? DENO_BIN : null;
    // Unreachable in practice: every farm test skipIf-gates on the runtimes
    // it needs — a miss here is a wiring bug, so fail loudly, never pass.
    if (!target) throw new Error(`host lacks ${rt} — the farm cannot be built`);
    symlinkSync(target, join(dir, rt));
  }
  // The wrapper's own toolbox (sh itself comes from the kernel's /bin/sh).
  // Resolved through PATH, not a hardcoded /bin: on macOS tr, readlink and
  // dirname live in /usr/bin — a /bin-only farm would starve the wrapper.
  for (const t of ["cat", "tr", "readlink", "dirname", "mkdir"]) {
    const tool = Bun.which(t);
    if (tool) symlinkSync(tool, join(dir, t));
  }
  return dir;
}

function runWrapper(
  wrapper: string,
  args: string[],
  path: string,
  home: string,
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([wrapper, ...args], {
    env: { PATH: path, HOME: home, PBOSS_HOME: home },
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

describe("wrapper: e2e — runtime farms", () => {
  test.skipIf(!POSIX || !BUN_BIN)(
    "bun-ONLY machine (issue #38's report): flag init, persist, dispatch",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["bun"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        // Unconfigured + headless → the honest error, exit 1.
        const headless = runWrapper(farm.bin + "/pboss", ["--version"], scrub, home);
        expect(headless.code).toBe(1);
        expect(headless.err).toContain("ProcBoss needs a runtime selection.");

        // The flag initializes the selection and dispatches — NO node needed.
        const init = runWrapper(farm.bin + "/pboss", ["--runtime=bun", "a", "b"], scrub, home);
        expect(init.code, `wrapper stderr:\n${init.err}`).toBe(0);
        expect(init.out.trim()).toBe('["a","b"]');
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("bun\n");
        // Plain invocation now dispatches without asking.
        const plain = runWrapper(farm.bin + "/pboss", ["x"], scrub, home);
        expect(plain.code).toBe(0);
        expect(plain.out.trim()).toBe('["x"]');
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !NODE_BIN)(
    "node-ONLY machine: same flow under node",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["node"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        const init = runWrapper(farm.bin + "/pboss", ["--runtime=node", "hello"], scrub, home);
        expect(init.code, `wrapper stderr:\n${init.err}`).toBe(0);
        expect(init.out.trim()).toBe('["hello"]');
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("node\n");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !DENO_BIN)(
    "deno-ONLY machine: deno run -A dispatch with args",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["deno"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        const init = runWrapper(farm.bin + "/pboss", ["--runtime=deno", "d1", "d2"], scrub, home);
        expect(init.code, `wrapper stderr:\n${init.err}`).toBe(0);
        expect(init.out.trim()).toBe('["d1","d2"]');
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("deno\n");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !BUN_BIN)(
    "invalid .runtime → the spec-20 error, exit 1 (never a guess)",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["bun"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".runtime"), "xyz\n", "utf8");
      try {
        const r = runWrapper(farm.bin + "/pboss", ["--version"], scrub, home);
        expect(r.code).toBe(1);
        expect(r.err).toContain("Invalid ProcBoss runtime configuration: xyz");
        expect(r.err).toContain("Supported runtimes:");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !BUN_BIN)(
    "invalid --runtime → the unsupported-runtime error, exit 1",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["bun"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        const r = runWrapper(farm.bin + "/pboss", ["--runtime=kubernetes", "x"], scrub, home);
        expect(r.code).toBe(1);
        expect(r.err).toContain("Unsupported runtime: kubernetes");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !BUN_BIN || !NODE_BIN)(
    "argument forwarding is BYTE-EXACT: spaces, quotes, empty, --, unicode",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["bun", "node"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".runtime"), "bun\n", "utf8");
      try {
        const args = [
          "start",
          "app.js",
          "--name",
          "my app",
          "--",
          "--runtime=node",
          "quoted 'arg'",
          "",
          'a b "c"',
          "tab\targ",
          "ünïcode",
        ];
        const r = runWrapper(farm.bin + "/pboss", args, scrub, home);
        expect(r.code, `wrapper stderr:\n${r.err}`).toBe(0);
        // The post-`--` --runtime is the APP's flag — never consumed.
        expect(JSON.parse(r.out.trim())).toEqual(args);
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !BUN_BIN || !NODE_BIN)(
    "flag override beats the persisted selection (dispatch follows the flag)",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["bun", "node"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".runtime"), "bun\n", "utf8");
      try {
        // .runtime says bun; the flag says node → the probe runs under NODE.
        // (The echo probes are runtime-agnostic; distinguish by entry marker.)
        writeFileSync(
          join(farm.pkg, "dist", "cli.node.js"),
          `#!/usr/bin/env node\nconsole.log("ENTRY-NODE ");\n${PROBE_STRIP}`,
        );
        const r = runWrapper(farm.bin + "/pboss", ["--runtime=node", "q"], scrub, home);
        expect(r.code, `wrapper stderr:\n${r.err}`).toBe(0);
        expect(r.out).toContain("ENTRY-NODE");
        expect(r.out).toContain('["q"]');
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("bun\n"); // untouched
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );

  test.skipIf(!POSIX || !NODE_BIN)(
    "missing runtime at dispatch → the escape-hatch error names them",
    () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["node"]); // bun NOT on this farm
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".runtime"), "bun\n", "utf8");
      try {
        const r = runWrapper(farm.bin + "/pboss", ["list"], scrub, home);
        expect(r.code).toBe(1);
        expect(r.err).toContain("ProcBoss requires Bun, but Bun was not found.");
        expect(r.err).toContain("pboss --runtime=node");
        expect(r.err).toContain("to choose again");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30000,
  );
});

/* ── e2e: the interactive first-run prompt over a real pty ─────────────── */

describe("wrapper: e2e — interactive first-run (pty)", () => {
  async function runPty(command: string, input: string): Promise<{ out: string; code: number }> {
    // `script` allocates a real pty; the answer is written to its stdin so
    // the wrapper's interactive read sees exactly what a user typed.
    const proc = Bun.spawn(["script", "-qec", command, "/dev/null"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    proc.stdin.write(input);
    proc.stdin.end();
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code: code ?? -1 };
  }

  test.skipIf(!POSIX || !HAS_SCRIPT || !BUN_BIN)(
    "selecting 2 persists bun and dispatches",
    async () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["bun"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        const r = await runPty(
          `env PATH=${scrub} HOME=${home} PBOSS_HOME=${home} ${farm.bin}/pboss --version`,
          "2\n",
        );
        expect(r.out).toContain("Kindly select your runtime:");
        expect(r.out).toContain("Select runtime [1]:");
        // The echo probe dispatched under bun, flag stripped.
        expect(r.out.trim().endsWith('["--version"]')).toBe(true);
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("bun\n");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    60000,
  );

  test.skipIf(!POSIX || !HAS_SCRIPT || !BUN_BIN || !NODE_BIN)(
    "Enter defaults to Node (the spec default)",
    async () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["node", "bun"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        const r = await runPty(
          `env PATH=${scrub} HOME=${home} PBOSS_HOME=${home} ${farm.bin}/pboss --version`,
          "\n",
        );
        expect(r.out.trim().endsWith('["--version"]')).toBe(true);
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("node\n");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    60000,
  );

  test.skipIf(!POSIX || !HAS_SCRIPT || !BUN_BIN || !NODE_BIN)(
    "an invalid interactive answer re-reports the supported list",
    async () => {
      const farm = probePackage();
      const scrub = runtimeFarm(["node", "bun"]);
      const home = join(farm.farm, "home");
      mkdirSync(home, { recursive: true });
      try {
        const r = await runPty(
          `env PATH=${scrub} HOME=${home} PBOSS_HOME=${home} ${farm.bin}/pboss --version`,
          "42\n",
        );
        expect(r.out).toContain("Unsupported runtime: 42");
        expect(r.out).toContain("Supported runtimes:");
      } finally {
        rmSync(farm.farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    60000,
  );
});

/* ── e2e: the REAL built entries, dispatched per runtime ─────────────────
 *
 * The echo probes above prove the WRAPPER (resolution, forwarding, saves)
 * but never import the shared core — they cannot see bundle-level breakage.
 * This block dispatches the REAL dist/cli.*.js entries under each available
 * runtime on a scrubbed PATH, asserting the full product path: entry →
 * core → --runtime save → version answer. It is the layer that catches
 * Deno's ESM strictness (bare `from "events"` is a hard error there, while
 * Node and Bun accept it — the 1.6.0 deno entry shipped broken until the
 * build gained the node:-prefix rewrite).
 *
 * dist/ is a build artifact: on a fresh clone run
 * `bun run ./scripts/build-dist.ts` (the issue-38 suite builds it too when
 * it packs). Without dist the block REPORTS as skipped, never passes. */
describe("wrapper: e2e — the REAL built entries (needs dist/)", () => {
  function runEntry(bin: string, args: string[], path: string, home: string) {
    const proc = Bun.spawnSync([bin, ...args], {
      env: { PATH: path, HOME: home, PBOSS_HOME: home },
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

  const cases: [runtime: string, bin: string | null, entryArgs: (entry: string) => string[]][] = [
    ["node", NODE_BIN, (e) => [e, "--runtime=node", "--version"]],
    ["bun", BUN_BIN, (e) => [e, "--runtime=bun", "--version"]],
    // deno's entry always runs through `deno run -A` (no shebang can carry
    // the permission flags) — exactly how bin/pboss.sh dispatches it.
    ["deno", DENO_BIN, (e) => ["run", "-A", e, "--runtime=deno", "--version"]],
  ];

  for (const [runtime, bin, entryArgs] of cases) {
    test.skipIf(!POSIX || !DIST_BUILT || !bin)(
      `real ${runtime} entry: answers --version and saves the selection`,
      () => {
        const farm = mkdtempSync(join(tmpdir(), "pboss-realfarm-"));
        const scrub = runtimeFarm([runtime]);
        const home = join(farm, "home");
        mkdirSync(home, { recursive: true });
        try {
          const entry = join(ROOT, "dist", `cli.${runtime}.js`);
          const r = runEntry(bin!, entryArgs(entry), scrub, home);
          expect(r.code, `entry stderr:\n${r.err}`).toBe(0);
          expect(r.out).toMatch(/pboss v\d+\.\d+\.\d+/);
          expect(readFileSync(join(home, ".runtime"), "utf8")).toBe(`${runtime}\n`);
        } finally {
          rmSync(farm, { recursive: true, force: true });
          rmSync(scrub, { recursive: true, force: true });
        }
      },
      30000,
    );
  }
});
