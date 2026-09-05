import { describe, test, expect } from "bun:test";
import {
  IS_COMPILED,
  PBOSS_EXECUTABLE,
  findBun,
  findNpm,
  daemonSpawnCommand,
  cliSpawnCommand,
  installModeDescription,
} from "../src/install-mode";
import { StartupManager } from "../src/startup-manager";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Install-mode detection and the startup-manager / daemon command resolution.
 *
 * pboss ships in two flavors:
 *  1. Compiled standalone executable — Bun embedded, system Bun optional.
 *  2. Script install (npm / bun add -g) — system Bun required.
 *
 * These tests run under `bun test`, i.e. the script-install flavor: the host
 * process is the system Bun runtime. The compiled flavor is exercised by the
 * standalone smoke test (build:bin + run with a Bun-less PATH).
 */
describe("Installation mode detection", () => {
  test("detects script mode when hosted by the system Bun runtime", () => {
    // bun test always runs via the system Bun, so this flavor is script mode.
    expect(IS_COMPILED).toBe(false);
  });

  test("PBOSS_EXECUTABLE is the Bun runtime in script mode", () => {
    expect(PBOSS_EXECUTABLE).toBe(process.execPath);
    expect(Bun.which("bun")).toBeTruthy();
  });

  test("findBun resolves the system Bun and never throws", () => {
    const bun = findBun();
    expect(bun).toBe(Bun.which("bun"));
  });

  test("findNpm returns a path or null without throwing", () => {
    expect(["string", "null"]).toContain(typeof findNpm());
  });

  test("daemonSpawnCommand uses bun + daemon.ts in script mode", () => {
    const cmd = daemonSpawnCommand();
    const bun = Bun.which("bun")!;

    expect(cmd[0]).toBe(bun);
    expect(cmd[1]).toBe("run");

    // The daemon script must be a real on-disk file in script mode (it would
    // be a virtual $bunfs path in compiled mode — never usable by systemd).
    const daemonScript = cmd[2]!;
    expect(daemonScript.endsWith("daemon.ts")).toBe(true);
    expect(daemonScript.includes("$bunfs")).toBe(false);
    expect(existsSync(daemonScript)).toBe(true);
  });

  test("cliSpawnCommand appends subcommands after the entry", () => {
    const cmd = cliSpawnCommand("resurrect");
    expect(cmd[0]).toBe(Bun.which("bun")!);
    expect(cmd[1]).toBe("run");
    expect(cmd[2]!.endsWith("index.ts")).toBe(true);
    expect(cmd[3]).toBe("resurrect");
  });

  test("installModeDescription names the flavor", () => {
    const desc = installModeDescription();
    expect(desc).toContain("script install");
    expect(desc).toContain("Bun");
  });
});

describe("StartupManager honors install mode", () => {
  test("systemd unit references bun + daemon.ts (script mode)", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("linux");

    const bun = Bun.which("bun")!;
    expect(out).toContain(`ExecStart=${bun} run `);
    expect(out).toContain("daemon.ts");
    expect(out).toContain("ExecStartPost=");
    expect(out).toContain("resurrect");
    expect(out).toContain("ExecReload=");
    expect(out).toContain("reload all");
    expect(out).toContain("ExecStop=");
    expect(out).toContain("kill");
    // No virtual compiled-filesystem paths may leak into service files.
    expect(out.includes("$bunfs")).toBe(false);
  });

  test("systemd unit PATH includes the Bun directory (script mode)", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("linux");

    const bunDir = join(Bun.which("bun")!, "..");
    expect(out).toContain(`Environment=PATH=`);
    expect(out).toContain(bunDir);
  });

  test("launchd plist ProgramArguments come from the daemon command", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("darwin");

    const bun = Bun.which("bun")!;
    expect(out).toContain(`<string>${bun}</string>`);
    expect(out).toContain("<string>run</string>");
    expect(out).toContain("<string>com.pboss.daemon</string>");
    expect(out).not.toContain("${bunPath}");
  });

  test("windows config quotes the resolved daemon command", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("win32");

    expect(out).toContain("PBOSS Windows Startup Configuration");
    expect(out).toContain("schtasks /create");
    expect(out).toContain("PBOSS_Daemon");
    expect(out).toContain("Register-ScheduledTask");
    expect(out).toContain("resurrect");
    // The /tr value quotes the whole command line; individual tokens are
    // quoted only when they contain spaces (paths without spaces stay bare).
    const bun = Bun.which("bun")!;
    const daemonScript = daemonSpawnCommand()[2]!;
    const trValue = [bun, "run", daemonScript]
      .map((t) => (/\s/.test(t) ? `"${t}"` : t))
      .join(" ");
    expect(out).toContain(`/tr "${trValue}"`);
    expect(trValue).toContain(bun);
    expect(trValue).toContain(daemonScript);
  });

  test("generated configs record the detected install mode", async () => {
    const startup = new StartupManager();
    for (const os of ["linux", "darwin", "win32"]) {
      const out = await startup.generate(os);
      expect(out).toContain(`# Install mode: ${installModeDescription()}`);
    }
  });
});
