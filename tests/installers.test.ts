import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
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
 * No-root target contract (owner request, 2026-09-10): "we still dont need
 * root … no need for /usr/local/bin — if ~/.local/bin is not in PATH in
 * ~/.bashrc, then add it." The installer NEVER invokes sudo: a plain user
 * installs to ~/.local/bin, and when that dir is not on PATH the installer
 * appends the export to the shell rc (~/.bashrc / ~/.zshrc — created when
 * missing) plus the login profile when it exists, instead of printing a
 * manual note. Running the installer AS root (the legacy sudo pipe) still
 * installs system-wide to /usr/local/bin — but sudo is never required.
 *
 * The functional sims are machine-independent (Task 67 lesson): temp HOME
 * and a stub `id` on PATH — never the real sudo, never a /usr/local/bin
 * write, no password prompts.
 */

/** Extract step 1 (target selection) from the real script. */
function step1(): string {
  const start = sh.indexOf('INVOKE_USER="${SUDO_USER:-}"');
  const end = sh.indexOf("# 2. Bun build toolchain");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sh.slice(start, end);
}

/** Extract step 5 (PATH self-heal) from the real script. */
function step5(): string {
  const start = sh.indexOf('if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then');
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
  return dir;
}

/** `id` stub: FAKE_UID / FAKE_USER control who we pretend to be. */
const ID_STUB = `case "$1" in
  -un) echo "\${FAKE_USER:-testuser}" ;;
  *) echo "\${FAKE_UID:-1000}" ;;
esac`;

/** sudo stub that records every invocation — the regression proof: after
 *  a non-root install the log file must still NOT exist. */
const SUDO_RECORD = `echo "$@" >> "\${SUDO_LOG:-/dev/null}"
exit 0`;

/**
 * Run an extracted slice with a temp HOME and stubbed `id`. `sudo` is also
 * stubbed to a recorder so tests can prove it is never invoked.
 */
function runSlice(
  block: string,
  home: string,
  extra: Record<string, string> = {},
): { code: number; out: string; sudoLog: string } {
  const sudoLog = join(home, "sudo-probe.log");
  const dir = stubDir({ id: ID_STUB, sudo: SUDO_RECORD });
  try {
    const proc = Bun.spawnSync(["bash", "-c", block], {
      env: {
        ...process.env,
        HOME: home,
        SUDO_USER: "",
        SUDO_LOG: sudoLog,
        PATH: `${dir}:/usr/bin:/bin`,
        ...extra,
      },
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), sudoLog };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install.sh: the no-root target contract", () => {
  test("INSTALL_DIR is assigned exactly twice (root + non-root branches)", () => {
    const assignments = sh.match(/^\s*INSTALL_DIR=/gm) ?? [];
    expect(assignments).toHaveLength(2);
    expect(sh).toContain('INSTALL_DIR="/usr/local/bin"');
    expect(sh).toContain('INSTALL_DIR="$HOME/.local/bin"');
  });

  test("no INSTALL_DIR assignment after the step-1 mkdir (the stale-override bug class)", () => {
    const mkdirIdx = sh.indexOf('mkdir -p "$INSTALL_DIR"');
    expect(mkdirIdx).toBeGreaterThan(0);
    expect(/^\s*INSTALL_DIR=/m.test(sh.slice(mkdirIdx))).toBe(false);
  });

  test("the sudo machinery is GONE — the installer never probes, prompts, or elevates", () => {
    for (const gone of [
      "probe_sudo",
      "SUDO_PREFIX",
      "CAN_SUDO",
      "target_writable",
      "STAMPED_DIR",
      "PBOSS_INSTALL_DIR",
      "PBOSS_NO_SUDO",
      "elev ",
      "sudo -n true",
      "sudo -v",
    ]) {
      expect(sh).not.toContain(gone);
    }
    // The one remaining sudo in CODE is the legacy root pipe dropping back
    // to the invoking user for the per-user service (root-only, step 6).
    const codeLines = sh
      .split("\n")
      .filter((l) => /\bsudo\b/.test(l))
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => !/\becho\b/.test(l));
    expect(codeLines).toHaveLength(1);
    expect(codeLines[0]).toContain('sudo -u "$INVOKE_USER" env');
  });

  test("the channel stamp records the channel, not the install dir", () => {
    expect(sh).toContain('"channel":"universal","by":"install.sh","stampedAt":%s');
    expect(sh).not.toContain("installDir");
  });

  test("the PATH self-heal appends to (or creates) the user's rc files", () => {
    expect(sh).toContain('rc_primary="$INVOKE_HOME/.bashrc"');
    expect(sh).toContain('rc_login="$INVOKE_HOME/.profile"');
    expect(sh).toContain('rc_primary="$INVOKE_HOME/.zshrc"');
    expect(sh).toContain('rc_login="$INVOKE_HOME/.zprofile"');
    expect(sh).toContain("Added ${INSTALL_DIR} to PATH in");
    expect(sh).toContain("open a NEW terminal");
  });

  test("bash syntax is valid", () => {
    const proc = Bun.spawnSync(["bash", "-n", SH_PATH]);
    expect(proc.exitCode).toBe(0);
  });
});

describe("install.sh: target resolution (functional, machine-independent)", () => {
  test("non-root → ~/.local/bin, dir created, sudo NEVER invoked", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-local-"));
    try {
      const { code, out, sudoLog } = runSlice(
        step1() + '\nprintf "RESOLVED=%s" "$INSTALL_DIR"',
        home,
      );
      expect(code).toBe(0);
      expect(out).toContain("no root required");
      expect(out).toContain("Installing as testuser");
      expect(out).toContain(`RESOLVED=${home}/.local/bin`);
      expect(existsSync(join(home, ".local", "bin"))).toBe(true);
      // The owner's contract: a plain-user install must never touch sudo.
      expect(existsSync(sudoLog)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("root (legacy sudo pipe) → /usr/local/bin", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-root-"));
    try {
      // No mkdir is executed here: never write toward the real /usr/local/bin.
      const block = step1().replace('mkdir -p "$INSTALL_DIR"', "") +
        '\nprintf "RESOLVED=%s" "$INSTALL_DIR"';
      const { code, out } = runSlice(block, home, { FAKE_UID: "0", FAKE_USER: "root" });
      expect(code).toBe(0);
      expect(out).toContain("Running as root — installing system-wide");
      expect(out).toContain("sudo is NOT needed");
      expect(out).toContain("RESOLVED=/usr/local/bin");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install.sh: PATH self-heal (add ~/.local/bin to the rc — no root)", () => {
  function runStep5(home: string, shell = "/bin/bash", path = "/usr/bin:/bin") {
    const proc = Bun.spawnSync(["bash", "-c", step5()], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: shell,
        PATH: path,
        INSTALL_DIR: `${home}/.local/bin`,
        INVOKE_HOME: home,
      },
    });
    expect(proc.exitCode).toBe(0);
    return proc.stdout.toString();
  }

  test("the owner's field report: ~/.bashrc without the dir gets the export appended", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal-"));
    try {
      writeFileSync(join(home, ".bashrc"), "# existing bashrc\n");
      writeFileSync(join(home, ".profile"), "# existing profile\n");
      const out = runStep5(home);
      expect(out).toContain("Added");
      expect(out).toContain(".bashrc");
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

  test("a MISSING ~/.bashrc is created (the ask is 'add it', not 'note it') — a missing ~/.profile is not", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal2-"));
    try {
      const out = runStep5(home);
      expect(out).toContain("Added");
      expect(existsSync(join(home, ".bashrc"))).toBe(true);
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(
        `export PATH="${home}/.local/bin:$PATH"`,
      );
      expect(existsSync(join(home, ".profile"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("idempotent: a second run appends nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal3-"));
    try {
      writeFileSync(join(home, ".bashrc"), "# existing bashrc\n");
      runStep5(home);
      const afterFirst = readFileSync(join(home, ".bashrc"), "utf8");
      runStep5(home);
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(afterFirst);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an rc that already references the dir — $HOME or ~/ spelling — is left alone", () => {
    for (const spelling of ['export PATH="$HOME/.local/bin:$PATH"', "export PATH=~/.local/bin:$PATH"]) {
      const home = mkdtempSync(join(tmpdir(), "pboss-path-heal4-"));
      try {
        writeFileSync(join(home, ".bashrc"), `${spelling}\n`);
        const out = runStep5(home);
        expect(out).toContain("Note:");
        expect(out).toContain("already in your shell profile");
        expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(`${spelling}\n`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test("zsh users heal ~/.zshrc (creating it), never .bashrc", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal5-"));
    try {
      const out = runStep5(home, "/bin/zsh");
      expect(out).toContain(".zshrc");
      expect(existsSync(join(home, ".zshrc"))).toBe(true);
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(
        `export PATH="${home}/.local/bin:$PATH"`,
      );
      expect(existsSync(join(home, ".bashrc"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the dir already on the current PATH → nothing is touched", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-path-heal6-"));
    try {
      const out = runStep5(home, "/bin/bash", `/usr/bin:/bin:${home}/.local/bin`);
      expect(out).not.toContain("Added");
      expect(existsSync(join(home, ".bashrc"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install.sh: step 1 + step 5 in sequence (the curl | bash shape)", () => {
  test("non-root install: binary dir created AND the rc healed in one run", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-e2e-"));
    try {
      writeFileSync(join(home, ".bashrc"), "# stock ubuntu bashrc\n");
      const { code, out, sudoLog } = runSlice(
        step1() + "\n" + step5(),
        home,
      );
      expect(code).toBe(0);
      expect(out).toContain("no root required");
      expect(out).toContain("Added");
      expect(existsSync(join(home, ".local", "bin"))).toBe(true);
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(
        `export PATH="${home}/.local/bin:$PATH"`,
      );
      expect(existsSync(sudoLog)).toBe(false);
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
