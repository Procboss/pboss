/**
 * Issue #38 regression suite — the published bin works on ANY runtime mix.
 *
 * Report (2026-10): a fresh Ubuntu with ONLY Bun (no Node.js anywhere):
 *
 *   curl -fsSL https://bun.sh/install | bash
 *   bun install -g pboss          # success
 *   pboss --version
 *   → /usr/bin/env: 'node': No such file or directory      (exit 127)
 *
 * Root cause across every published release ≤ 1.5.3: dist/cli.js shipped
 * `#!/usr/bin/env node` and the package's bin pointed straight at it —
 * the kernel ran env, env searched PATH for node, and a Bun-only machine
 * died before a single line of pboss executed. The shebang cannot be
 * fixed by choosing a different single runtime (`env bun` flips the same
 * failure onto Node-only machines), because npm links ONE file as the bin.
 *
 * The fix — the runtime-aware wrapper architecture (1.6.0):
 *
 *   - The package's bin IS bin/pboss.sh, a POSIX sh wrapper (kernel-resolved
 *     `#!/bin/sh`, present everywhere POSIX). IT dispatches to the
 *     runtime-specific entrypoint (dist/cli.node.js / cli.bun.js /
 *     cli.deno.js) after resolving the user's explicit choice: the
 *     --runtime flag, then the persistent ~/.pboss/.runtime, then the
 *     interactive first-run prompt.
 *   - The wrapper never needs a JS runtime to START — the shell always runs.
 *
 * The contract under test, against the REAL packed-and-installed package:
 *
 *   1. `npm pack` → `npm install -g` the tarball (exactly what a user gets)
 *      links a bin that is the sh wrapper.
 *   2. On a scrubbed PATH holding ONLY Bun (the report's machine),
 *      `pboss --version` answers — no node anywhere.
 *   3. The same install answers on a Node-only and a Deno-only machine.
 *   4. `--runtime=<x>` initializes ~/.pboss/.runtime; plain `pboss`
 *      dispatches through it afterwards without asking again.
 *   5. Nothing regressed for npm machines with BOTH runtimes (the
 *      node-shebang direct entries still run under node/bun/deno).
 *
 * https://github.com/Procboss/pboss/issues/38
 */
import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const POSIX = process.platform !== "win32";

/**
 * Pack the repo and install it globally into a temp prefix — the exact
 * artifact a user gets from the registry (the build must already have run;
 * this suite rebuilds it to pin the ARTIFACT, not the source).
 */
function installRealPackage(): { prefix: string; home: string; farm: string } {
  const farm = mkdtempSync(join(tmpdir(), "pboss-issue38-"));
  const prefix = join(farm, "prefix");
  const home = join(farm, "home");
  mkdirSync(home, { recursive: true });

  const build = spawnSync("bun", ["run", join(ROOT, "scripts", "build-dist.ts")], {
    cwd: ROOT,
    stdio: "pipe",
  });
  if (build.status !== 0) throw new Error("build-dist.ts failed — cannot pack");

  const pack = spawnSync("npm", ["pack", "--pack-destination", farm, "--silent"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  if (pack.status !== 0) throw new Error("npm pack failed");
  const tarball = join(farm, "pboss-1.6.0.tgz");

  const install = spawnSync(
    "npm",
    ["install", "-g", tarball, "--prefix", prefix, "--no-fund", "--no-audit", "--loglevel=error"],
    { stdio: "pipe" },
  );
  if (install.status !== 0) {
    throw new Error(`npm install -g failed: ${install.stderr?.toString()}`);
  }
  return { prefix, home, farm };
}

/** A scrubbed PATH dir with ONLY the listed runtimes + the POSIX toolbox. */
function scrubFarm(runtimes: string[]): string | null {
  const dir = mkdtempSync(join(tmpdir(), "pboss-issue38-bin-"));
  for (const rt of runtimes) {
    const bin = rt === "bun" ? Bun.which("bun") : rt === "node" ? Bun.which("node") : rt === "deno" ? Bun.which("deno") : null;
    if (!bin) {
      rmSync(dir, { recursive: true, force: true });
      return null; // host lacks the runtime — scenario cannot be built
    }
    symlinkSync(bin, join(dir, rt));
  }
  for (const t of ["cat", "tr", "readlink", "dirname", "mkdir"]) {
    try {
      symlinkSync(`/bin/${t}`, join(dir, t));
    } catch {
      /* non-Linux hosts — POSIX cases skip below anyway */
    }
  }
  return dir;
}

function runPboss(
  prefix: string,
  scrub: string,
  home: string,
  args: string[],
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([join(prefix, "bin", "pboss"), ...args], {
    env: { PATH: scrub, HOME: home, PBOSS_HOME: home },
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

describe("Issue #38 — the packed-and-installed package on any runtime mix", () => {
  test(
    "the bin npm links IS the sh wrapper (not a runtime-specific JS file)",
    () => {
      if (!POSIX) return;
      const { prefix, farm } = installRealPackage();
      try {
        const linked = join(prefix, "lib", "node_modules", "pboss", "bin", "pboss.sh");
        const wrapper = readFileSync(linked, "utf8");
        expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
        // The dispatch table — one entry per runtime.
        expect(wrapper).toContain("cli.node.js");
        expect(wrapper).toContain("cli.bun.js");
        expect(wrapper).toContain("cli.deno.js");
        // package.json's bin points at the wrapper.
        const pkg = JSON.parse(readFileSync(join(prefix, "lib", "node_modules", "pboss", "package.json"), "utf8"));
        expect(pkg.bin).toEqual({ pboss: "bin/pboss.sh" });
      } finally {
        rmSync(farm, { recursive: true, force: true });
      }
    },
    120000,
  );

  test(
    "THE REPORT'S MACHINE: ONLY Bun on PATH — pboss answers (no node error)",
    () => {
      if (!POSIX) return;
      const { prefix, home, farm } = installRealPackage();
      const scrub = scrubFarm(["bun"]);
      if (!scrub) return;
      try {
        // Pre-fix (≤1.5.3): "/usr/bin/env: 'node': No such file or directory" (127)
        const r = runPboss(prefix, scrub, home, ["--runtime=bun", "--version"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("pboss v");
        expect(r.err).not.toContain("No such file or directory");
        // The selection persisted — plain invocations dispatch without asking.
        expect(readFileSync(join(home, ".runtime"), "utf8")).toBe("bun\n");
        const plain = runPboss(prefix, scrub, home, ["--version"]);
        expect(plain.code).toBe(0);
        expect(plain.out).toContain("pboss v");
      } finally {
        rmSync(farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    120000,
  );

  test(
    "a Node-only machine and a Deno-only machine answer too",
    () => {
      if (!POSIX) return;
      const { prefix, home, farm } = installRealPackage();
      try {
        const nodeOnly = scrubFarm(["node"]);
        if (nodeOnly) {
          try {
            const r = runPboss(prefix, nodeOnly, home, ["--runtime=node", "--version"]);
            expect(r.code).toBe(0);
            expect(r.out).toContain("pboss v");
          } finally {
            rmSync(nodeOnly, { recursive: true, force: true });
          }
        }
        const denoOnly = scrubFarm(["deno"]);
        if (denoOnly) {
          try {
            const home2 = join(farm, "home-deno");
            mkdirSync(home2, { recursive: true });
            const r = runPboss(prefix, denoOnly, home2, ["--runtime=deno", "--version"]);
            expect(r.code).toBe(0);
            expect(r.out).toContain("pboss v");
            expect(readFileSync(join(home2, ".runtime"), "utf8")).toBe("deno\n");
          } finally {
            rmSync(denoOnly, { recursive: true, force: true });
          }
        }
      } finally {
        rmSync(farm, { recursive: true, force: true });
      }
    },
    120000,
  );

  test(
    "unconfigured + headless: the honest error (never a runtime guess)",
    () => {
      if (!POSIX) return;
      const { prefix, home, farm } = installRealPackage();
      const scrub = scrubFarm(["bun"]);
      if (!scrub) return;
      try {
        const r = runPboss(prefix, scrub, home, ["--version"]);
        expect(r.code).toBe(1);
        expect(r.err).toContain("ProcBoss needs a runtime selection.");
        expect(r.err).toContain("--runtime=bun");
        // Nothing was written by the failed run.
        expect(() => readFileSync(join(home, ".runtime"), "utf8")).toThrow();
      } finally {
        rmSync(farm, { recursive: true, force: true });
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    120000,
  );

  test(
    "no Node regression: the direct entries still run under their runtimes",
    () => {
      if (!POSIX) return;
      const { farm } = installRealPackage();
      try {
        const pkg = join(farm, "prefix", "lib", "node_modules", "pboss");
        const node = Bun.which("node");
        const bun = Bun.which("bun");
        if (node) {
          const r = Bun.spawnSync([node, join(pkg, "dist", "cli.node.js"), "--version"], {
            stdout: "pipe", stderr: "pipe", stdin: "ignore",
          });
          expect(r.exitCode).toBe(0);
          expect(new TextDecoder().decode(r.stdout)).toContain("pboss v");
        }
        if (bun) {
          const r = Bun.spawnSync([bun, join(pkg, "dist", "cli.bun.js"), "--version"], {
            stdout: "pipe", stderr: "pipe", stdin: "ignore",
          });
          expect(r.exitCode).toBe(0);
          expect(new TextDecoder().decode(r.stdout)).toContain("pboss v");
        }
        // The legacy dist/cli.js entry keeps working (boot units pin it).
        if (bun) {
          const r = Bun.spawnSync([bun, join(pkg, "dist", "cli.js"), "--version"], {
            stdout: "pipe", stderr: "pipe", stdin: "ignore",
          });
          expect(r.exitCode).toBe(0);
          expect(new TextDecoder().decode(r.stdout)).toContain("pboss v");
        }
      } finally {
        rmSync(farm, { recursive: true, force: true });
      }
    },
    120000,
  );
});
