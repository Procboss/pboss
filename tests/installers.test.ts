import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
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
 * Owner-reported bug (2026-09-09): install.sh printed
 * "✓ Installing as ra — no root required (/home/ra/.local/bin)" and then
 * died on `cp: cannot create regular file '/usr/local/bin/pboss': Permission
 * denied`. Cause: a stale step-3 override re-assigned INSTALL_DIR after the
 * per-user decision had already been announced.
 *
 * The contract under test: the install target chosen (and announced) in
 * step 1 is the target the binary is actually written to. No later
 * re-assignment may exist in any installer.
 */
describe("install.sh: the announced target IS the install target", () => {
  test("INSTALL_DIR is assigned exactly twice (root + non-root branches)", () => {
    // 3+ assignments = a later override exists = the bug class.
    const assignments = sh.match(/^\s*INSTALL_DIR="/gm) ?? [];
    expect(assignments).toHaveLength(2);
    // Sharper: nothing may re-assign the target after step 1's mkdir —
    // the stale override that caused the bug sat between the compile and cp.
    const mkdirIdx = sh.indexOf('mkdir -p "$INSTALL_DIR"');
    expect(mkdirIdx).toBeGreaterThan(0);
    expect(/^\s*INSTALL_DIR=/m.test(sh.slice(mkdirIdx))).toBe(false);
  });

  test("the system path is assigned only inside the root branch", () => {
    const systemAssignments = sh.match(/^\s*INSTALL_DIR="\/usr\/local\/bin"\s*$/gm) ?? [];
    expect(systemAssignments).toHaveLength(1);

    const rootBranch = sh.indexOf('if [ "$(id -u)" -eq 0 ]; then');
    const elseBranch = sh.indexOf("else", rootBranch);
    const assignment = sh.indexOf('INSTALL_DIR="/usr/local/bin"', rootBranch);
    expect(assignment).toBeGreaterThan(rootBranch);
    expect(assignment).toBeLessThan(elseBranch);
  });

  test("the per-user branch installs to $HOME/.local/bin", () => {
    expect(sh).toContain('INSTALL_DIR="$HOME/.local/bin"');
  });

  test("the binary is copied to the chosen dir, not a hardcoded path", () => {
    expect(sh).toContain('cp "$TMP_DIR/pboss" "$INSTALL_DIR/pboss"');
    expect(sh).toContain('chmod 755 "$INSTALL_DIR/pboss"');
  });

  test("bash syntax is valid", () => {
    const proc = Bun.spawnSync(["bash", "-n", SH_PATH]);
    expect(proc.exitCode).toBe(0);
  });

  test("non-root run resolves ~/.local/bin and creates it (functional)", () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-installer-target-"));
    try {
      // Extract step 1 (target selection) from the real script and run it
      // as this non-root user with a temp HOME — the owner's exact scenario.
      const start = sh.indexOf('INVOKE_USER="${SUDO_USER:-}"');
      const mkdirLine = 'mkdir -p "$INSTALL_DIR"';
      const end = sh.indexOf(mkdirLine) + mkdirLine.length;
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const block = sh.slice(start, end);

      const proc = Bun.spawnSync(
        ["bash", "-c", `${block}\nprintf "RESOLVED=%s" "$INSTALL_DIR"`],
        { env: { ...process.env, HOME: home, SUDO_USER: "" } },
      );
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout.toString();
      // The step-1 message the user sees names the user and "no root".
      expect(out).toContain("no root required");
      // ...and the resolved target matches the announced one.
      expect(out.endsWith(`RESOLVED=${home}/.local/bin`)).toBe(true);
      // The directory actually gets created before any cp.
      expect(existsSync(join(home, ".local", "bin"))).toBe(true);
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
