import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

const REPO = join(dirname(import.meta.path), "..");
const SH_PATH = join(REPO, "scripts", "install.sh");
const PS1_PATH = join(REPO, "scripts", "install.ps1");
const CMD_PATH = join(REPO, "scripts", "install.cmd");
const sh = readFileSync(SH_PATH, "utf8");
const ps1 = readFileSync(PS1_PATH, "utf8");
const cmd = readFileSync(CMD_PATH, "utf8");

/**
 * The universal installer's runtime policy (runtime-agnostic architecture):
 *
 *   - The installer's ONLY runtime responsibility: ensure AT LEAST ONE of
 *     Bun / Node / Deno exists. Any one → do nothing. None → install Bun.
 *   - It NEVER selects a runtime, NEVER persists one (no PBOSS_RUNTIME), and
 *     multiple installed runtimes are NOT a conflict.
 *   - It installs the PUBLISHED package globally (bun install -g pboss /
 *     npm install -g pboss / deno install -g npm:pboss) — no git clone,
 *     no source compilation, no Bun build toolchain.
 *   - The PATH self-heal and the no-root contract stay exactly as they were.
 *
 * The functional sims are machine-independent (Task 67 lesson): temp HOME
 * and stub `id`/`bun`/`node`/`deno`/`curl` on PATH — never the real
 * installer's network side, never a real global install.
 */

/** Extract step 2 (runtime presence) from the real script. */
function stepRuntime(): string {
  const start = sh.indexOf("# 2. Runtime presence");
  const end = sh.indexOf("# 3. Install the published pboss package");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sh.slice(start, end);
}

/** Extract step 5 (PATH self-heal) from the real script. */
function step5(): string {
  const start = sh.indexOf('if [ -n "$PM_DIR" ] && [[ ":$PATH:" != *":$PM_DIR:"* ]]; then');
  const end = sh.indexOf("# 6. Boot persistence");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sh.slice(start, end);
}

/** A dir of stub executables injected at the FRONT of PATH. */
function stubDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pboss-installer-stubs-"));
  for (const [name, body] of Object.entries(files)) {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/bash\n${body}\n`);
    chmodSync(f, 0o755);
  }
  // The shell itself must resolve inside the hermetic PATH (pipes spawn
  // `bash` by name) — a symlink, never a stub, so it behaves exactly like
  // the real one.
  symlinkSync("/bin/bash", join(dir, "bash"));
  return dir;
}

/** `id` stub: FAKE_UID / FAKE_USER control who we pretend to be. */
const ID_STUB = `case "$1" in
  -un) echo "\${FAKE_USER:-testuser}" ;;
  *) echo "\${FAKE_UID:-1000}" ;;
esac`;

/** A runtime stub: prints its name so we can see it being probed. */
const RUNTIME_STUB = `echo "stub-$0 ran with $@" >> "\${STUB_LOG:-/dev/null}"\nexit 0`;

/** curl stub: records every URL — proves no runtime gets downloaded. */
const CURL_STUB = `echo "curl $*" >> "\${STUB_LOG:-/dev/null}"\nexit 1`;

/**
 * Run a slice with a temp HOME, stubbed `id`/`curl` and a configurable set
 * of "installed" runtimes. Returns the stub log (everything the stubs saw).
 */
function runSlice(
  block: string,
  home: string,
  opts: { runtimes?: string[]; extra?: Record<string, string> } = {},
): { code: number; out: string; log: string } {
  const log = join(home, "stub.log");
  const files: Record<string, string> = {
    id: ID_STUB,
    curl: CURL_STUB,
  };
  for (const rt of opts.runtimes ?? []) {
    files[rt] = RUNTIME_STUB;
  }
  const dir = stubDir(files);
  try {
    // NOTE: the PATH carries ONLY the stub dir — the host's real
    // node/bun must not leak into "is a runtime present?" decisions.
    const proc = Bun.spawnSync(["bash", "-c", block], {
      env: {
        ...process.env,
        HOME: home,
        SUDO_USER: "",
        STUB_LOG: log,
        PATH: dir,
        ...opts.extra,
      },
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString() + proc.stderr.toString(),
      log: existsSync(log) ? readFileSync(log, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── The runtime policy (architecture spec §14–§21) ───────────────────────

describe("install.sh: runtime presence policy", () => {
  test("no runtime at all → Bun is installed (the only runtime side effect)", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-policy-"));
    try {
      // Slice: the detection + the "none found" branch up to the install
      // (curl stubbed — it records instead of downloading).
      const block = stepRuntime() + '\necho "BRANCH-DONE"\n';
      const r = runSlice(block, home, { runtimes: [] });
      // The branch body references curl (stubbed) — the slice proves the
      // IF fires: the script says it is installing Bun.
      expect(r.out).toContain("No supported runtime found");
      expect(r.out).toContain("installing Bun");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const [label, runtimes] of [
    ["bun", ["bun"]],
    ["node", ["node"]],
    ["deno", ["deno"]],
    ["bun + node", ["bun", "node"]],
    ["bun + node + deno", ["bun", "node", "deno"]],
  ] as const) {
    test(`${label} present → nothing installed, nothing selected`, () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-policy-"));
      try {
        const block = stepRuntime() + '\necho "BRANCH-DONE"\n';
        const r = runSlice(block, home, { runtimes: [...runtimes] });
        expect(r.out).toContain("A supported runtime is present — nothing installed, nothing selected");
        // No runtime download happened (curl stub stayed silent).
        expect(r.log).not.toContain("bun.sh/install");
        // Each PRESENT runtime was reported as found (no "not found" line).
        for (const rt of runtimes) expect(r.out).not.toContain(`${rt} not found`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("the none-found condition tests ALL THREE runtimes before installing Bun", () => {
    expect(sh).toContain('if [ -z "$HAS_BUN" ] && [ -z "$HAS_NODE" ] && [ -z "$HAS_DENO" ]; then');
  });

  test("no priority chain — the installer never ranks runtimes", () => {
    // The forbidden shape: a case/elseif that prefers bun over node over deno
    // FOR RUNTIME SELECTION. (The package-manager choice is install-only
    // and is allowed — it installs the npm package, it does not pick a
    // runtime for pboss.)
    const runtimeSection = stepRuntime();
    expect(runtimeSection).not.toMatch(/prefer|priority|rank/i);
  });

  test("never persists a runtime choice (no PBOSS_RUNTIME is ever set)", () => {
    expect(sh).not.toMatch(/export\s+PBOSS_RUNTIME|PBOSS_RUNTIME=/);
    expect(ps1).not.toMatch(/\$env:PBOSS_RUNTIME/);
  });
});

describe("install.sh: published package, no source compilation", () => {
  test("installs the published package globally via an available package manager", () => {
    expect(sh).toContain("bun install -g");
    expect(sh).toContain("npm install -g");
    expect(sh).toContain("deno install -g");
    expect(sh).toContain("npm:${PKG_SPEC}");
  });

  test("NO git clone, NO source archive, NO compiling", () => {
    expect(sh).not.toContain("git clone");
    expect(sh).not.toContain("archive/refs/heads");
    expect(sh).not.toContain("bun build");
    expect(sh).not.toContain("--compile");
    expect(sh).not.toContain("Compiling");
    expect(ps1).not.toContain("git");
    expect(ps1).not.toContain("Expand-Archive");
    expect(ps1).not.toContain("bun build");
  });

  test("the package-manager choice is documented as install-only", () => {
    expect(sh).toContain("installs ONLY the npm package");
    expect(sh).toContain("not a runtime selection");
  });

  test("verifies pboss and reports the EXECUTING runtime (not a selection)", () => {
    expect(sh).toContain('command -v pboss');
    expect(sh).toContain('--runtime 2>/dev/null');
  });

  test("version-exact installs: PBOSS_VERSION pins the package spec", () => {
    expect(sh).toContain('[ -n "$PBOSS_VERSION" ] && PKG_SPEC="pboss@${PBOSS_VERSION}"');
  });

  test("bash syntax is valid", () => {
    const proc = Bun.spawnSync(["bash", "-n", SH_PATH]);
    expect(proc.exitCode).toBe(0);
  });
});

// ─── The no-root contract (unchanged from the old installer) ──────────────

describe("install.sh: no-root contract", () => {
  test("INSTALL_DIR references are gone — the package manager owns the bin dir now", () => {
    expect(sh).not.toContain("INSTALL_DIR=");
  });

  test("the sudo machinery is GONE from the install path — one drop-back exception", () => {
    // The ONLY sudo use left: root invoking for the per-user boot service.
    const codeLines = sh
      .split("\n")
      .filter((l) => /\bsudo\b/.test(l))
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => !/\becho\b/.test(l));
    expect(codeLines.length).toBe(1);
    expect(codeLines[0]).toContain('sudo -u "$INVOKE_USER" env');
  });

  test("the channel stamp records the channel (upgrade re-runs this installer)", () => {
    expect(sh).toContain('"channel":"universal","by":"install.sh","stampedAt":%s');
  });

  test("PATH self-heal: appends to (or creates) the user's rc files", () => {
    expect(sh).toContain('rc_primary="$INVOKE_HOME/.bashrc"');
    expect(sh).toContain('rc_login="$INVOKE_HOME/.profile"');
    expect(sh).toContain('rc_primary="$INVOKE_HOME/.zshrc"');
    expect(sh).toContain('rc_login="$INVOKE_HOME/.zprofile"');
    expect(sh).toContain("Added ${PM_DIR} to PATH in");
    expect(sh).toContain("open a NEW terminal");
  });

  test("PATH self-heal sim: a missing ~/.bashrc is created; a missing ~/.profile is not", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-heal-"));
    try {
      const block = step5();
      const proc = Bun.spawnSync(["bash", "-c", block], {
        env: {
          ...process.env,
          HOME: home,
          INVOKE_HOME: home,
          PM_DIR: join(home, ".bun", "bin"),
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/bash",
        },
      });
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout.toString();
      expect(out).toContain("Added");
      expect(existsSync(join(home, ".bashrc"))).toBe(true);
      expect(existsSync(join(home, ".profile"))).toBe(false);
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(
        `export PATH="${join(home, ".bun", "bin")}:$PATH"`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PATH self-heal sim: an rc already referencing the dir is left alone", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-heal-"));
    try {
      const pmDir = join(home, ".bun", "bin");
      writeFileSync(join(home, ".bashrc"), `export PATH="$HOME/.bun/bin:$PATH"\n`);
      const block = step5();
      const proc = Bun.spawnSync(["bash", "-c", block], {
        env: {
          ...process.env,
          HOME: home,
          INVOKE_HOME: home,
          PM_DIR: pmDir,
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/bash",
        },
      });
      const out = proc.stdout.toString();
      expect(out).toContain("already in your shell profile");
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(
        `export PATH="$HOME/.bun/bin:$PATH"\n`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── install.ps1: the same policy on Windows ─────────────────────────────

describe("install.ps1: same runtime policy as the shell installer", () => {
  test("detects bun, node AND deno — any one is enough", () => {
    expect(ps1).toContain("Get-Command bun");
    expect(ps1).toContain("Get-Command node");
    expect(ps1).toContain("Get-Command deno");
  });

  test("installs Bun ONLY when NO runtime exists", () => {
    expect(ps1).toContain("if (-not ($bunCmd -or $nodeCmd -or $denoCmd))");
    expect(ps1).toContain("install.ps1");
  });

  test("installs the published package, never compiles", () => {
    expect(ps1).toContain("bun install -g");
    expect(ps1).toContain("npm install -g");
    expect(ps1).toContain("deno install -g");
    expect(ps1).not.toContain("git");
    expect(ps1).not.toContain("Expand-Archive");
    expect(ps1).not.toContain("bun build");
  });

  test("reports the executing runtime at the end", () => {
    expect(ps1).toContain("pboss --runtime");
  });

  test("the shell and PowerShell installers agree on the policy text", () => {
    const shPolicy = sh.includes("Ensure at least one supported runtime exists");
    const ps1Policy = ps1.includes("Ensure at least one supported runtime exists");
    expect(shPolicy).toBe(true);
    expect(ps1Policy).toBe(true);
  });
});

describe("install.cmd: the launcher delegates to install.ps1", () => {
  test("still just invokes the PowerShell installer", () => {
    expect(cmd).toContain("install.ps1");
  });
});
