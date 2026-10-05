import { describe, test, expect } from "bun:test";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "fs";
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
 * The universal installer's runtime-aware contract:
 *
 *   - The USER selects the runtime: --runtime=<node|bun|deno> explicitly, or
 *     the interactive prompt (Node on Enter). Never inferred from PATH.
 *   - Invalid values die with the exact supported list BEFORE installing
 *     anything.
 *   - The selected runtime is installed when missing (bun/deno official
 *     installers; node = the official dist tarball, rootless).
 *   - The PUBLISHED package is installed through the selected runtime's own
 *     package ecosystem — npm / bun / deno install -g — never a clone.
 *   - The installer then calls `pboss --runtime=<x> --version`, which
 *     persists the selection to ~/.pboss/.runtime.
 *
 * The functional sims are machine-independent (Task 67 lesson): temp HOME and
 * stub `node`/`npm`/`bun`/`deno`/`curl`/`pboss` on PATH — never the real
 * installer's network side, never a real global install. The stubs sit in
 * FRONT of the host PATH so the real runtimes never leak into "is the
 * runtime present?" decisions.
 */

const POSIX = process.platform !== "win32";

/** A dir of stub executables injected at the FRONT of PATH. */
function stubDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pboss-installer-stubs-"));
  for (const [name, body] of Object.entries(files)) {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
  }
  // The shell itself must resolve inside the hermetic PATH (pipes spawn
  // `sh`/`bash` by name) — a symlink, never a stub, so it behaves exactly
  // like the real one.
  symlinkSync("/bin/sh", join(dir, "sh"));
  symlinkSync("/bin/bash", join(dir, "bash"));
  return dir;
}

/** A runtime/PM stub: records its argv, exit 0. */
const LOG = `echo "$0 $*" >> "\${STUB_LOG:-/dev/null}"`

/** Strip ANSI escapes (the installer colorizes unconditionally). */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b/g, "");
}

/** npm stub: records, answers the prefix, and "links" a stub pboss. */
function npmStub(): string {
  return `case "$1" in
  config)
    case "$3" in
      prefix) echo "$STUB_NPM_PREFIX" ;;
      *) echo "" ;;
    esac ;;
  install)
    ${LOG}
    mkdir -p "$STUB_NPM_PREFIX/bin"
    printf '%s\\n' '#!/bin/sh' 'echo "pboss $*" >> "\${STUB_LOG:-/dev/null}"' 'echo "pboss v9.9.9"' > "$STUB_NPM_PREFIX/bin/pboss"
    chmod +x "$STUB_NPM_PREFIX/bin/pboss"
    ;;
esac
exit 0`;
}

/** A runtime stub (bun/deno): records installs, "links" pboss next to itself
 *  (the installer derives the PM bin dir from the runtime's own location). */
function runtimeStub(): string {
  return `if [ "$1" = "install" ] || [ "$1" = "add" ]; then
  ${LOG}
  d=$(dirname "$0")
  mkdir -p "$d"
  printf '%s\\n' '#!/bin/sh' 'echo "pboss $*" >> "\${STUB_LOG:-/dev/null}"' 'echo "pboss v9.9.9"' > "$d/pboss"
  chmod +x "$d/pboss"
fi
exit 0`;
}

/** A bun stub that mirrors real Bun >= 1.4: it refuses to install when its
 * global state holds a nameless ("") dependency entry — the exact poison a
 * `bun add -g .` inside a package directory leaves behind. */
function bunPoisonAwareStub(): string {
  return `gp="\${BUN_INSTALL:-\$HOME/.bun}/install/global/package.json"
if [ -f "\$gp" ] && grep -q '^[[:space:]]*""[[:space:]]*:' "\$gp" 2>/dev/null; then
  echo "error: refusing to install dependency with unsafe name" >&2
  exit 1
fi
if [ "\$1" = "install" ] || [ "\$1" = "add" ]; then
  ${LOG}
  d=\$(dirname "\$0")
  mkdir -p "\$d"
  printf '%s\\n' '#!/bin/sh' 'echo "pboss \$*" >> "\${STUB_LOG:-/dev/null}"' 'echo "pboss v9.9.9"' > "\$d/pboss"
  chmod +x "\$d/pboss"
fi
exit 0`;
}

/** A bun stub that always fails (any install attempt). */
function bunFailingStub(): string {
  return `if [ "\$1" = "install" ] || [ "\$1" = "add" ]; then
  echo "bun \$*" >> "\${STUB_LOG:-/dev/null}"
fi
echo "error: refusing to install dependency with unsafe name" >&2
exit 1`;
}

/** Run the REAL installer with a temp HOME + stubbed PATH. */
function runInstaller(
  args: string[],
  opts: {
    runtimes?: string[];
    extraEnv?: Record<string, string>;
    customStubs?: Record<string, string>;
  } = {},
): { code: number; out: string; err: string; log: string } {
  const home = mkdtempSync(join(tmpdir(), "pboss-inst-home-"));
  const log = join(home, "stub.log");
  const files: Record<string, string> = {
    id: `case "$1" in -un) echo "testuser" ;; *) echo "1000" ;; esac`,
    curl: `echo "curl $*" >> "$STUB_LOG"; exit 1`, // runtime downloads must be opt-in
    npm: npmStub(),
  };
  for (const rt of opts.runtimes ?? []) {
    files[rt] = runtimeStub();
  }
  for (const [name, body] of Object.entries(opts.customStubs ?? {})) {
    files[name] = body; // custom stubs win over the generic ones
  }
  const dir = stubDir(files);
  const prefix = join(home, ".npm-global");
  try {
    const proc = Bun.spawnSync(["sh", SH_PATH, ...args], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: home,
        TERM: "dumb",
        STUB_LOG: log,
        STUB_NPM_PREFIX: prefix,
        SHELL: "/bin/bash",
        ...opts.extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return {
      code: proc.exitCode ?? -1,
      out: stripAnsi(new TextDecoder().decode(proc.stdout)),
      err: stripAnsi(new TextDecoder().decode(proc.stderr)),
      log: existsSync(log) ? readFileSync(log, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/* ── source pins ─────────────────────────────────────────────────────────── */

describe("installers: the runtime-aware contract (source pins)", () => {
  test("pure POSIX sh — the documented pipe is `| sh`", () => {
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain("set -e");
  });

  test("explicit runtime selection with both spellings + --help", () => {
    expect(sh).toContain("--runtime=*)");
    expect(sh).toContain("--runtime) EXPECT_VALUE=1");
    expect(sh).toContain("[--runtime=node|bun|deno]");
  });

  test("the interactive prompt: Node is the default on Enter", () => {
    expect(sh).toContain("Kindly select your runtime:");
    expect(sh).toContain("Select runtime [1]: ");
    expect(sh).toContain('"" | 1 | node) RUNTIME="node"');
    expect(sh).toContain('2 | bun) RUNTIME="bun"');
    expect(sh).toContain('3 | deno) RUNTIME="deno"');
  });

  test("invalid values: the exact spec text, before anything installs", () => {
    expect(sh).toContain("Unsupported runtime: %s");
    expect(sh).toContain("Supported runtimes:");
  });

  test("non-interactive without a runtime: the spec error", () => {
    expect(sh).toContain("ProcBoss needs a runtime selection.");
    expect(sh).toContain("--runtime=node");
  });

  test("the selected runtime is installed when missing (never switched)", () => {
    expect(sh).toContain('ProcBoss requires $(runtime_display "$RUNTIME"), but');
    expect(sh).toContain("Attempting to install $(runtime_display");
    expect(sh).toContain("Unable to install $(runtime_display");
    // bun + deno: the official one-line installers; node: the dist tarball.
    expect(sh).toContain("https://bun.sh/install");
    expect(sh).toContain("https://deno.land/install.sh");
    expect(sh).toContain("https://nodejs.org/dist/latest-v22.x");
  });

  test("the PUBLISHED package installs through the selected ecosystem", () => {
    expect(sh).toContain("npm install -g");
    expect(sh).toContain("bun install -g") /* bun's own block */ ;
    expect(sh).toContain('"$RUNTIME_BIN" install -g "$PKG_SPEC"');
    // deno: the published ENTRY subpath (deno runs bins as modules).
    expect(sh).toContain("npm:pboss/deno-entry");
    expect(sh).toContain("--name pboss");
  });

  test("the installer initializes the selection through pboss itself", () => {
    expect(sh).toContain('"$PBOSS_BIN" --runtime="$RUNTIME" --version');
    expect(sh).toContain("Runtime persisted: ${RUNTIME}");
  });

  test("PBOSS_VERSION pins the exact release", () => {
    expect(sh).toContain('[ -n "$PBOSS_VERSION" ] && PKG_SPEC="pboss@${PBOSS_VERSION}"');
  });

  test("the channel stamp + PATH self-heal + boot persistence stay", () => {
    expect(sh).toContain('"channel":"universal"');
    expect(sh).toContain("Added by the ProcBoss installer");
    expect(sh).toContain("pboss startup install");
  });

  test("the PowerShell installer mirrors the contract", () => {
    expect(ps1).toContain("param(");
    expect(ps1).toContain("[string]$Runtime");
    expect(ps1).toContain("Kindly select your runtime:");
    expect(ps1).toContain("Unsupported runtime:");
    expect(ps1).toContain("npm:pboss/deno-entry");
    expect(ps1).toContain("--runtime=$selected --version");
    // The Windows-only extra: wrapper shims (npm's own .cmd cannot run .sh).
    expect(ps1).toContain("pboss.ps1");
    expect(ps1).toContain("pboss.cmd");
  });

  test("install.cmd still bootstraps the PowerShell installer", () => {
    expect(cmd).toContain("powershell");
    expect(cmd).toContain("install.ps1");
  });
});

/* ── functional sims (stubs, no network, no real install) ─────────────────── */

describe("installers: sims — the explicit runtime flow", () => {
  test(
    "--runtime=node: npm installs the published package; pboss initializes the selection",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime=node"], { runtimes: ["node"] });
      expect(r.code).toBe(0);
      expect(r.out).toContain("Selected runtime: node");
      // The published package via npm (the unwritable-prefix sim takes the
      // --prefix spelling — both are the same npm global install).
      expect(r.log).toContain("npm install -g");
      expect(r.log).toContain("pboss");
      // The initializer call — this is what persists ~/.pboss/.runtime.
      expect(r.log).toContain("pboss --runtime=node --version");
      expect(r.out).toContain("pboss is available");
    },
    30000,
  );

  test(
    "--runtime=bun: bun installs the package (node being present changes nothing)",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime=bun"], { runtimes: ["bun", "node"] });
      expect(r.code).toBe(0);
      expect(r.out).toContain("Selected runtime: bun");
      expect(r.log).toContain("bun install -g pboss");
      expect(r.log).toContain("pboss --runtime=bun --version");
      // node was present AND ignored — the selection is authoritative.
      expect(r.log).not.toContain("npm install -g");
    },
    30000,
  );

  test(
    "--runtime=deno: the published entry subpath, --name pboss",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime=deno"], { runtimes: ["deno", "node"] });
      expect(r.code).toBe(0);
      expect(r.log).toContain("deno install -g -f -A --name pboss npm:pboss/deno-entry");
      expect(r.log).toContain("pboss --runtime=deno --version");
      expect(r.log).not.toContain("npm install -g");
    },
    30000,
  );

  test(
    "PBOSS_VERSION pins the exact release for every ecosystem",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime=node"], {
        runtimes: ["node"],
        extraEnv: { PBOSS_VERSION: "1.6.0" },
      });
      expect(r.code).toBe(0);
      expect(r.log).toContain("npm install -g");
      expect(r.log).toContain("pboss@1.6.0");
    },
    30000,
  );

  test(
    "an invalid runtime exits BEFORE installing anything",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime=kubernetes"], { runtimes: ["node", "bun"] });
      expect(r.code).toBe(1);
      expect(r.err).toContain("Unsupported runtime: kubernetes");
      expect(r.err).toContain("Supported runtimes:");
      expect(r.log).not.toContain("install");
      expect(r.out).not.toContain("Installing");
    },
    30000,
  );

  test(
    "a missing value for --runtime is a usage error",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime"], { runtimes: ["node"] });
      expect(r.code).toBe(1);
      expect(r.err).toContain("--runtime requires a value");
    },
    30000,
  );

  test(
    "no runtime + headless stdin: the spec error, exit 1, nothing installed",
    () => {
      if (!POSIX) return;
      const r = runInstaller([], { runtimes: ["node"] });
      expect(r.code).toBe(1);
      expect(r.err).toContain("ProcBoss needs a runtime selection.");
      expect(r.err).toContain("--runtime=node");
      expect(r.err).toContain("--runtime=bun");
      expect(r.err).toContain("--runtime=deno");
      expect(r.log).not.toContain("install");
    },
    30000,
  );

  test(
    "a MISSING selected runtime is installed (bun via the official installer)",
    () => {
      if (!POSIX) return;
      // No runtimes on the farm; curl stub FAILS → the install attempt fails
      // honestly and nothing else is touched.
      const r = runInstaller(["--runtime=bun"], {});
      expect(r.code).toBe(1);
      expect(r.out).toContain("Attempting to install Bun...");
      expect(r.err).toContain("Unable to install Bun automatically.");
      expect(r.err).toContain("Please install Bun and run:");
      expect(r.log).toContain("curl -fsSL https://bun.sh/install"); // it tried
    },
    30000,
  );

  test(
    "a missing NODE is installed from the official dist (tarball path)",
    () => {
      if (!POSIX) return;
      // A hermetic tool farm WITHOUT node: real tools (awk, grep, tar …) as
      // symlinks, a failing curl stub, and NO node anywhere on PATH.
      const home = mkdtempSync(join(tmpdir(), "pboss-inst-nodefarm-"));
      const farm = mkdtempSync(join(tmpdir(), "pboss-inst-tools-"));
      const log = join(home, "stub.log");
      try {
        for (const t of [
          "awk", "grep", "tr", "cat", "mkdir", "dirname", "basename", "date",
          "uname", "mktemp", "tar", "ln", "rm", "chown", "head",
        ]) {
          try {
            symlinkSync(`/usr/bin/${t}`, join(farm, t));
          } catch {
            /* best-effort — the farm skips what the host lacks */
          }
        }
        symlinkSync("/bin/sh", join(farm, "sh"));
        symlinkSync("/bin/bash", join(farm, "bash"));
        writeFileSync(
          join(farm, "curl"),
          `#!/bin/sh\necho "curl $*" >> "${log}"\nexit 1\n`,
        );
        chmodSync(join(farm, "curl"), 0o755);
        const proc = Bun.spawnSync(["sh", SH_PATH, "--runtime=node"], {
          env: { PATH: farm, HOME: home, TERM: "dumb", STUB_LOG: log },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        const out = stripAnsi(new TextDecoder().decode(proc.stdout));
        const err = stripAnsi(new TextDecoder().decode(proc.stderr));
        expect(proc.exitCode).toBe(1);
        expect(out).toContain("Attempting to install Node...");
        // The dist tarball path was tried (the curl stub records the URL).
        expect(readFileSync(log, "utf8")).toContain("nodejs.org/dist/latest-v22.x");
        expect(err).toContain("Unable to install Node.js automatically");
      } finally {
        rmSync(farm, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    30000,
  );
});

/* ── the Bun global-state heal + the npm fallback ────────────────────────── */

describe("installers: the Bun global-state heal + npm fallback (source pins)", () => {
  test("both installers name the Bun failure and its cure", () => {
    // The exact Bun >= 1.4 error the heal answers:
    expect(sh).toContain("refusing to install dependency with unsafe name");
    expect(ps1).toContain("refusing to install dependency with unsafe name");
    // The cause, stated for the user:
    expect(sh).toContain("bun add -g .");
    expect(ps1).toContain("bun add -g .");
    // The heal itself: drop the nameless entry + the stale lockfile.
    expect(sh).toContain("heal_bun_global_state");
    expect(sh).toContain('rm -f "$_BH/install/global/bun.lock"');
    expect(ps1).toContain('PSObject.Properties.Remove("")');
    expect(ps1).toContain("Remove-Item $bunGlobalLock -Force");
  });

  test("a failed bun install falls back to npm — channel-faithfully", () => {
    expect(sh).toContain("falling back to npm");
    expect(ps1).toContain("falling back to npm");
    // The channel stamp records what can actually upgrade pboss here.
    expect(sh).toContain('PM_CHOICE="npm"');
    expect(ps1).toContain('$pmChoice = "npm"');
  });

  test("no npm to fall back on: the manual recovery steps", () => {
    expect(sh).toContain("npm was not found to fall back on");
    expect(ps1).toContain("npm was not found to fall back on");
    expect(sh).toContain("Re-run this installer");
    expect(ps1).toContain("Re-run this installer");
  });

  test("the upgrade rule is stated at the end: pboss upgrade only", () => {
    expect(sh).toContain("Upgrade ONLY through pboss itself");
    expect(ps1).toContain("upgrade ONLY through pboss itself");
    expect(sh).toContain("never npm/bun update -g");
    expect(ps1).toContain("never npm/bun update -g");
  });
});

describe("installers: sims — the Bun heal + fallback", () => {
  test(
    "--runtime=bun: a poisoned Bun global state is healed, then installs",
    () => {
      if (!POSIX) return;
      const bunHome = mkdtempSync(join(tmpdir(), "pboss-bun-poison-"));
      const globalDir = join(bunHome, "install", "global");
      mkdirSync(globalDir, { recursive: true });
      const globalPkg = join(globalDir, "package.json");
      // The poison (a nameless entry) + a legitimate entry that must survive.
      writeFileSync(
        globalPkg,
        JSON.stringify({ dependencies: { "": "./", "left-alone": "^1.0.0" } }, null, 2) + "\n",
      );
      writeFileSync(join(globalDir, "bun.lock"), '{ "stale": true }\n');
      try {
        const r = runInstaller(["--runtime=bun"], {
          customStubs: { bun: bunPoisonAwareStub() },
          extraEnv: { BUN_INSTALL: bunHome },
        });
        expect(r.code).toBe(0);
        expect(r.out).toContain("Bun global state healed");
        // The poison is gone; the legitimate entry survives; the lock was removed.
        const healed = readFileSync(globalPkg, "utf8");
        expect(healed).not.toMatch(/^\s*""\s*:/m);
        expect(healed).toContain("left-alone");
        expect(existsSync(join(globalDir, "bun.lock"))).toBe(false);
        // ... and the install itself ran on the healed state.
        expect(r.log).toContain("bun install -g pboss");
        expect(r.log).toContain("pboss --runtime=bun --version");
      } finally {
        rmSync(bunHome, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "--runtime=bun: a hard bun failure falls back to npm",
    () => {
      if (!POSIX) return;
      const r = runInstaller(["--runtime=bun"], {
        customStubs: { bun: bunFailingStub() },
        runtimes: ["node"],
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain("falling back to npm");
      // It tried bun first; npm delivered; the runtime selection is intact.
      expect(r.log).toContain("bun install -g pboss");
      expect(r.log).toContain("npm install -g pboss");
      expect(r.log).toContain("pboss --runtime=bun --version");
    },
    30000,
  );

  test(
    "--runtime=bun: no npm to fall back on — the manual hint, exit 1",
    () => {
      if (!POSIX) return;
      // A tool farm WITHOUT node/npm anywhere on PATH (the "missing NODE"
      // pattern): real utilities, a bun that hard-fails, nothing to fall
      // back on.
      const home = mkdtempSync(join(tmpdir(), "pboss-inst-nofallback-"));
      const farm = mkdtempSync(join(tmpdir(), "pboss-inst-tools2-"));
      const log = join(home, "stub.log");
      try {
        for (const t of [
          "awk", "grep", "tr", "cat", "mkdir", "dirname", "basename", "date",
          "uname", "mktemp", "ln", "rm", "chown", "head", "id",
        ]) {
          try {
            symlinkSync(`/usr/bin/${t}`, join(farm, t));
          } catch {
            /* best-effort — the farm skips what the host lacks */
          }
        }
        symlinkSync("/bin/sh", join(farm, "sh"));
        symlinkSync("/bin/bash", join(farm, "bash"));
        writeFileSync(join(farm, "bun"), `#!/bin/sh\n${bunFailingStub()}\n`);
        chmodSync(join(farm, "bun"), 0o755);
        const proc = Bun.spawnSync(["sh", SH_PATH, "--runtime=bun"], {
          env: { PATH: farm, HOME: home, TERM: "dumb", STUB_LOG: log },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        const err = stripAnsi(new TextDecoder().decode(proc.stderr));
        expect(proc.exitCode).toBe(1);
        expect(err).toContain("npm was not found to fall back on");
        expect(err).toContain("Re-run this installer");
      } finally {
        rmSync(farm, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    30000,
  );
});
