import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, accessSync, constants } from "fs";
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
 * Target-selection contract (owner request, 2026-09-10): "why don't we save
 * pboss to /usr/local/bin instead?" — /usr/local/bin is on PATH for every
 * user out of the box, so the installer PREFERS it (as root, or via sudo
 * elevating only the binary copy) and keeps ~/.local/bin purely as the
 * no-sudo fallback. Upgrades never move an existing install: the stamp
 * written at install time (channel.json installDir) is the anchor step 1
 * re-reads on the next run.
 *
 * The functional sims below are machine-independent (Task 67 lesson): temp
 * HOME, a stub `id`, and stub `sudo` binaries on PATH — never the real
 * /usr/local/bin, never the real sudo, no password prompts.
 */

/** Extract step 1 (target selection) from the real script. */
function step1(endMarker: string): string {
  const start = sh.indexOf('INVOKE_USER="${SUDO_USER:-}"');
  const end = sh.indexOf(endMarker);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sh.slice(start, end);
}

const MKDIR_LINE = 'elev mkdir -p "$INSTALL_DIR"';

/** A dir of stub executables injected at the FRONT of PATH. */
function stubDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pboss-installer-stubs-"));
  for (const [name, body] of Object.entries(files)) {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/bash\n${body}\n`);
    chmodSync(f, 0o755);
  }
  return dir;
}

/** `id` stub: FAKE_UID / FAKE_USER control who we pretend to be. */
const ID_STUB = `case "$1" in
  -un) echo "\${FAKE_USER:-testuser}" ;;
  *) echo "\${FAKE_UID:-1000}" ;;
esac`;

/** sudo stub flavors: unavailable, passwordless, or recording-everything. */
const SUDO_FAIL = `exit 1`;
const SUDO_PASS = `exit 0`;
const SUDO_RECORD = `echo "$@" >> "\${SUDO_LOG:-/dev/null}"
exit 0`;

/**
 * Run an extracted step-1 slice as a non-root (faked) user with a temp HOME.
 * `withMkdir` appends the real (elev-aware) mkdir line; `extra` injects env.
 */
function runStep1(
  block: string,
  home: string,
  stubs: Record<string, string>,
  extra: Record<string, string> = {},
  withMkdir = false,
): { code: number; out: string } {
  const dir = stubDir(stubs);
  try {
    const harness =
      block +
      (withMkdir ? `\n${MKDIR_LINE}` : "") +
      '\nprintf "RESOLVED=%s|PREFIX=%s" "$INSTALL_DIR" "$SUDO_PREFIX"';
    const proc = Bun.spawnSync(["bash", "-c", harness], {
      env: {
        ...process.env,
        HOME: home,
        SUDO_USER: "",
        PATH: `${dir}:${process.env.PATH}`,
        ...extra,
      },
    });
    return { code: proc.exitCode, out: proc.stdout.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install.sh: the /usr/local/bin-first target contract", () => {
  test("no INSTALL_DIR assignment after the step-1 mkdir (the stale-override bug class)", () => {
    const mkdirIdx = sh.indexOf(MKDIR_LINE);
    expect(mkdirIdx).toBeGreaterThan(0);
    // Every assignment lives inside step 1…
    const assignments = [...sh.matchAll(/^\s*INSTALL_DIR=/gm)];
    expect(assignments.length).toBeGreaterThanOrEqual(4);
    for (const m of assignments) {
      expect(m.index!).toBeLessThan(mkdirIdx);
    }
    // …and nothing re-assigns the target after the mkdir.
    expect(/^\s*INSTALL_DIR=/m.test(sh.slice(mkdirIdx))).toBe(false);
  });

  test("all four selection branches exist (override, root, stamped, fallback)", () => {
    expect(sh).toContain('INSTALL_DIR="${PBOSS_INSTALL_DIR}"');
    expect(sh).toContain('INSTALL_DIR="/usr/local/bin"');
    expect(sh).toContain('INSTALL_DIR="$STAMPED_DIR"');
    expect(sh).toContain('INSTALL_DIR="$HOME/.local/bin"');
    // The stamp a previous run re-reads in step 1 is written in step 4b.
    expect(sh).toContain('"channel":"universal","by":"install.sh","installDir":"%s"');
    expect(sh).toContain('"installDir" *: *"');
  });

  test("sudo is only ever the four sanctioned forms (probe, prompt, elev, run_as_user)", () => {
    // Comments and echo MESSAGE lines may mention sudo in prose; only code
    // lines can invoke it.
    const lines = sh
      .split("\n")
      .filter((l) => /\bsudo\b/.test(l))
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => !/\becho\b/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    const allowed = [
      /command -v sudo /, // existence probe
      /sudo -n true /, // passwordless probe
      /sudo -v /, // one interactive prompt
      /sudo "\$@"/, // elev()
      /sudo -u "\$INVOKE_USER" env/, // legacy root pipe → per-user service
      /SUDO_PREFIX="sudo"/, // the prefix ASSIGNMENT (not an invocation)
    ];
    for (const line of lines) {
      expect(allowed.some((re) => re.test(line))).toBe(true);
    }
  });

  test("every privileged install operation goes through elev()", () => {
    expect(sh).toContain(MKDIR_LINE);
    expect(sh).toContain('elev rm -f "$INSTALL_DIR/pboss"');
    expect(sh).toContain('elev cp "$TMP_DIR/pboss" "$INSTALL_DIR/pboss"');
    expect(sh).toContain('elev chmod 755 "$INSTALL_DIR/pboss"');
    // The binary copy is the ONLY elevated step — the daemon, state and
    // boot service stay per-user (run_as_user drops root back to the user).
    expect(sh).toContain('sudo -u "$INVOKE_USER" env PATH="$PATH" HOME="$INVOKE_HOME" "$@"');
  });

  test("the legacy per-user copy is cleaned up when pboss moves system-wide", () => {
    expect(sh).toContain('LEGACY_LOCAL="$INVOKE_HOME/.local/bin/pboss"');
    expect(sh).toContain("Removed the old per-user copy");
    // …but never when the fallback itself is the target.
    expect(sh).toContain('[ "$INSTALL_DIR" != "$INVOKE_HOME/.local/bin" ]');
  });

  test("PBOSS_NO_SUDO and PBOSS_INSTALL_DIR overrides are honored", () => {
    expect(sh).toContain('[ "${PBOSS_NO_SUDO:-}" = "1" ] && return 1');
    expect(sh).toContain('if [ -n "${PBOSS_INSTALL_DIR:-}" ]; then');
  });

  test("the PATH self-heal exists for the ~/.local/bin fallback", () => {
    expect(sh).toContain("PATH self-healed in");
    expect(sh).toContain('"$INVOKE_HOME/.bashrc"');
    expect(sh).toContain('"$INVOKE_HOME/.profile"');
    expect(sh).toContain('"$INVOKE_HOME/.zshrc"');
  });

  test("bash syntax is valid", () => {
    const proc = Bun.spawnSync(["bash", "-n", SH_PATH]);
    expect(proc.exitCode).toBe(0);
  });
});

describe("install.sh: target resolution (functional, machine-independent)", () => {
  // The script consults the REAL filesystem when deciding whether
  // /usr/local/bin is usable directly (no sudo round-trip) — the test
  // computes the same answer so it is deterministic on every machine.
  const fsWritable = (p: string) => {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const systemBinWritable = existsSync("/usr/local/bin")
    ? fsWritable("/usr/local/bin")
    : fsWritable("/usr/local");

  test("non-root without sudo → system path when directly writable, else ~/.local/bin", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-local-"));
    try {
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(block, home, { id: ID_STUB, sudo: SUDO_FAIL }, {}, true);
      expect(code).toBe(0);
      // A fresh ~/.local/bin (not yet existing, writable parent) must NOT
      // trigger the not-writable warning or any sudo prompt.
      expect(out).not.toContain("Cannot write");
      expect(out).not.toContain("sudo may ask");
      if (systemBinWritable) {
        expect(out).toContain("writable without sudo");
        expect(out).toContain("RESOLVED=/usr/local/bin|");
      } else {
        expect(out).toContain("no root required");
        expect(out).toContain("no sudo available");
        expect(out.endsWith(`RESOLVED=${home}/.local/bin|PREFIX=`)).toBe(true);
        expect(existsSync(join(home, ".local", "bin"))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("non-root with passwordless sudo → /usr/local/bin, elevated only if needed", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-sudo-"));
    try {
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(block, home, { id: ID_STUB, sudo: SUDO_PASS });
      expect(code).toBe(0);
      expect(out).toContain("system-wide to /usr/local/bin");
      expect(out).toContain("on PATH for every user");
      expect(out).toContain("RESOLVED=/usr/local/bin|");
      expect(out.endsWith(`|PREFIX=${systemBinWritable ? "" : "sudo"}`)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("root (legacy sudo pipe) → /usr/local/bin, no elevation prefix", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-root-"));
    try {
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(
        block,
        home,
        { id: ID_STUB },
        { FAKE_UID: "0", FAKE_USER: "root" },
      );
      expect(code).toBe(0);
      expect(out).toContain("Running as root — installing system-wide");
      expect(out.endsWith("RESOLVED=/usr/local/bin|PREFIX=")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a stamped previous install is refreshed in place — sudo is never even probed", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-stamped-"));
    const sudoLog = join(home, "sudo.log");
    try {
      const target = join(home, "custom-prefix");
      mkdirSync(target, { recursive: true });
      mkdirSync(join(home, ".pboss"), { recursive: true });
      writeFileSync(
        join(home, ".pboss", "channel.json"),
        JSON.stringify({ channel: "universal", by: "install.sh", installDir: target }),
      );
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(
        block,
        home,
        { id: ID_STUB, sudo: SUDO_RECORD },
        { SUDO_LOG: sudoLog },
        true,
      );
      expect(code).toBe(0);
      expect(out).toContain(`Refreshing the existing install at ${target}`);
      expect(out).toContain("upgrades never move pboss");
      expect(out.endsWith(`RESOLVED=${target}|PREFIX=`)).toBe(true);
      // The whole point: an in-place upgrade must not prompt for sudo.
      expect(existsSync(sudoLog)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PBOSS_INSTALL_DIR wins over every heuristic", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-override-"));
    const sudoLog = join(home, "sudo.log");
    try {
      const target = join(home, "opt-pboss");
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(
        block,
        home,
        { id: ID_STUB, sudo: SUDO_RECORD },
        { PBOSS_INSTALL_DIR: target, SUDO_LOG: sudoLog },
        true,
      );
      expect(code).toBe(0);
      expect(out).toContain("PBOSS_INSTALL_DIR");
      expect(out.endsWith(`RESOLVED=${target}|PREFIX=`)).toBe(true);
      expect(existsSync(target)).toBe(true);
      // A writable custom target needs no sudo at all.
      expect(existsSync(sudoLog)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PBOSS_NO_SUDO=1 forces the per-user fallback even with sudo available", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-nosudo-"));
    try {
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(
        block,
        home,
        { id: ID_STUB, sudo: SUDO_PASS },
        { PBOSS_NO_SUDO: "1" },
        true,
      );
      expect(code).toBe(0);
      expect(out).toContain("no root required");
      // PBOSS_NO_SUDO bypasses the system path entirely — even when it is
      // directly writable (the sandbox case) the install is per-user.
      expect(out).not.toContain("/usr/local/bin");
      expect(out.endsWith(`RESOLVED=${home}/.local/bin|PREFIX=`)).toBe(true);
      expect(existsSync(join(home, ".local", "bin"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("unwritable target + password-requiring sudo → the prompt is announced, then elevated", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-prompt-"));
    const sudoLog = join(home, "sudo.log");
    try {
      // An unwritable custom target (chmod 555) forces the sudo path; the
      // stub answers `sudo -n true` with failure but `sudo -v` with success
      // — the password-requiring machine shape.
      const locked = join(home, "locked-bin");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o555);
      const dir = stubDir({
        id: ID_STUB,
        sudo: `case "$*" in
  "-n true") exit 1 ;;
  *) echo "$@" >> "\${SUDO_LOG:-/dev/null}" ; exit 0 ;;
esac`,
      });
      try {
        const block = step1(MKDIR_LINE);
        const proc = Bun.spawnSync(
          [
            "bash",
            "-c",
            block +
              '\nprintf "RESOLVED=%s|PREFIX=%s" "$INSTALL_DIR" "$SUDO_PREFIX"',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              SUDO_USER: "",
              PATH: `${dir}:${process.env.PATH}`,
              PBOSS_INSTALL_DIR: locked,
              SUDO_LOG: sudoLog,
            },
          },
        );
        expect(proc.exitCode).toBe(0);
        const out = proc.stdout.toString();
        // The announcement fires BEFORE the prompt (bare prompts read as
        // attacks), and the elevation actually happened.
        expect(out).toContain("sudo may ask for your password");
        expect(out).toContain("it elevates only the pboss binary copy");
        expect(out).not.toContain("Cannot write");
        expect(out.endsWith(`RESOLVED=${locked}|PREFIX=sudo`)).toBe(true);
        expect(readFileSync(sudoLog, "utf8")).toBe("-v\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stamped system target + broken sudo degrades to ~/.local/bin with the honest warning", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-degrade-"));
    try {
      const locked = join(home, "locked-bin");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o555);
      mkdirSync(join(home, ".pboss"), { recursive: true });
      writeFileSync(
        join(home, ".pboss", "channel.json"),
        JSON.stringify({ channel: "universal", by: "install.sh", installDir: locked }),
      );
      const block = step1(MKDIR_LINE);
      const { code, out } = runStep1(block, home, { id: ID_STUB, sudo: SUDO_FAIL }, {}, true);
      expect(code).toBe(0);
      expect(out).toContain("Cannot write");
      expect(out).toContain("two pboss binaries");
      expect(out.endsWith(`RESOLVED=${home}/.local/bin|PREFIX=`)).toBe(true);
      expect(existsSync(join(home, ".local", "bin"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install.sh: PATH self-heal (the ~/.local/bin fallback)", () => {
  function step5(): string {
    const start = sh.indexOf('if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then');
    const end = sh.indexOf("# 6. Boot persistence");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return sh.slice(start, end);
  }

  test("appends the export to existing bash rc files and says so", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal-"));
    try {
      writeFileSync(join(home, ".bashrc"), "# existing bashrc\n");
      writeFileSync(join(home, ".profile"), "# existing profile\n");
      const proc = Bun.spawnSync(["bash", "-c", step5()], {
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/bash",
          PATH: "/usr/bin:/bin",
          INSTALL_DIR: `${home}/.local/bin`,
          INVOKE_HOME: home,
        },
      });
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout.toString();
      expect(out).toContain("PATH self-healed in .bashrc .profile");
      const expected = `export PATH="${home}/.local/bin:$PATH"`;
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(expected);
      expect(readFileSync(join(home, ".profile"), "utf8")).toContain(expected);
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(
        "# Added by the ProcBoss installer — keep pboss on PATH",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("idempotent: a second run appends nothing, and zsh heals its own rc", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal2-"));
    try {
      writeFileSync(join(home, ".zshrc"), "# existing zshrc\n");
      const env = {
        ...process.env,
        HOME: home,
        SHELL: "/bin/zsh",
        PATH: "/usr/bin:/bin",
        INSTALL_DIR: `${home}/.local/bin`,
        INVOKE_HOME: home,
      };
      const first = Bun.spawnSync(["bash", "-c", step5()], { env });
      expect(first.exitCode).toBe(0);
      expect(first.stdout.toString()).toContain("PATH self-healed in .zshrc");
      const afterFirst = readFileSync(join(home, ".zshrc"), "utf8");
      const second = Bun.spawnSync(["bash", "-c", step5()], { env });
      expect(second.exitCode).toBe(0);
      const afterSecond = readFileSync(join(home, ".zshrc"), "utf8");
      expect(afterSecond).toBe(afterFirst); // nothing appended twice
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a profile that already references the dir is left alone", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal3-"));
    try {
      writeFileSync(join(home, ".bashrc"), 'export PATH="$HOME/.local/bin:$PATH"\n');
      const proc = Bun.spawnSync(["bash", "-c", step5()], {
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/bash",
          PATH: "/usr/bin:/bin",
          INSTALL_DIR: `${home}/.local/bin`,
          INVOKE_HOME: home,
        },
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("Note:"); // honest note, no heal
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(
        'export PATH="$HOME/.local/bin:$PATH"\n',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install.ps1: same contract on Windows", () => {
  test("$installDir is decided exactly once (the elevation if/else)", () => {
    const assignments = ps1.match(/^\s*\$installDir = Join-Path/gm) ?? [];
    expect(assignments).toHaveLength(2);
  });

  test("non-elevated default is the per-user LOCALAPPDATA dir", () => {
    expect(ps1).toContain('Join-Path $env:LOCALAPPDATA "pboss"');
  });

  test("elevated legacy path is ProgramFiles", () => {
    expect(ps1).toContain('Join-Path $env:ProgramFiles "pboss"');
  });

  test("compile output lands in the chosen dir", () => {
    expect(ps1).toContain('Join-Path $installDir "pboss.exe"');
  });

  test("PATH scope follows the branch (User vs Machine)", () => {
    expect(ps1).toContain("[System.EnvironmentVariableTarget]::User");
    expect(ps1).toContain("[System.EnvironmentVariableTarget]::Machine");
  });
});

describe("install.cmd: launcher only, no target logic of its own", () => {
  test("delegates to install.ps1 (comments may explain, code must not decide)", () => {
    expect(cmd).toContain("install.ps1");
    // Strip REM comment lines: the remaining code must be delegation only.
    const code = cmd
      .split("\n")
      .filter((l) => !/^\s*REM/i.test(l))
      .join("\n");
    expect(/LOCALAPPDATA|ProgramFiles/i.test(code)).toBe(false);
    expect(code).toMatch(/powershell .*install\.ps1/);
  });
});

/**
 * Reinstall contract (owner report: "after pboss reinstalls, it fails to
 * detect existing cloud connections"): the machine credential in
 * ~/.pboss/cloud.json is the permanent cache — every installer must CHECK
 * for it and say so, so a reinstalled machine never looks unlinked.
 */
describe("installers detect an existing cloud link (the permanent cache)", () => {
  test("install.sh checks the credential before the success banner", () => {
    const bannerIdx = sh.indexOf("successfully installed");
    const checkIdx = sh.indexOf('"$INVOKE_HOME/.pboss/cloud.json"');
    expect(checkIdx).toBeGreaterThan(0);
    expect(checkIdx).toBeLessThan(bannerIdx);
    expect(sh).toContain("Existing cloud link detected — the daemon will resume it automatically.");
    expect(sh).toContain("pboss cloud status");
  });

  test("install.ps1 checks the credential before the success banner", () => {
    const bannerIdx = ps1.indexOf("successfully installed");
    const checkIdx = ps1.indexOf('Join-Path $env:USERPROFILE ".pboss\\cloud.json"');
    expect(checkIdx).toBeGreaterThan(0);
    expect(checkIdx).toBeLessThan(bannerIdx);
    expect(ps1).toContain("Existing cloud link detected");
  });
});
