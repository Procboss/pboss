import { describe, test, expect, afterEach } from "bun:test";
import {
  StartupManager,
  buildWindowsTaskRegistrationScript,
  buildWindowsRunKeyAddCommand,
  buildWindowsRunKeyRemoveCommand,
  buildWindowsRunKeyQueryCommand,
  buildWindowsDaemonLauncherVbs,
  windowsDaemonLauncherPath,
  WINDOWS_DAEMON_LAUNCHER_NAME,
  parseWindowsRunKeyQuery,
  WINDOWS_RUN_KEY,
} from "../src/startup-manager";
import { ClusterManager } from "../src/cluster-manager";
import { LogManager } from "../src/log-manager";
import { treeKill } from "../src/utils";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { readFileSync, readdirSync } from "fs";
import type { ProcessDescription } from "../src/types";

const SAVED_USERNAME = process.env.USERNAME;

afterEach(() => {
  if (SAVED_USERNAME === undefined) delete process.env.USERNAME;
  else process.env.USERNAME = SAVED_USERNAME;
});

describe("Windows Support & Cross-Platform Compatibility", () => {
  describe("StartupManager for Windows", () => {
    test("generates Windows Task Scheduler configuration", async () => {
      const startup = new StartupManager();
      const output = await startup.generate("win32");

      expect(output).toContain("PBOSS Windows Startup Configuration");
      expect(output).toContain("schtasks /create");
      expect(output).toContain("PBOSS_Daemon");
      expect(output).toContain("Register-ScheduledTask");
      expect(output).toContain("resurrect");
      expect(output).toContain("# pboss startup install");
      // The onlogon trigger is restricted to THIS user's logon, and the
      // manual commands stay registerable from an unelevated shell.
      expect(output).toContain('/sc onlogon /ru "%USERNAME%" /f /rl limited');
      expect(output).toContain("New-ScheduledTaskTrigger -AtLogOn -User");
      expect(output).toContain("-RunLevel Limited");
      expect(output).not.toContain("/rl highest");
      // Boot persistence starts the daemon through the HIDDEN wscript
      // launcher — a raw console program would pop a visible cmd window
      // at every logon (owner report 2026-09-15).
      expect(output).toContain("wscript.exe //B");
      expect(output).toContain(WINDOWS_DAEMON_LAUNCHER_NAME);
    });
  });

  describe("Windows task registration script (what install() executes)", () => {
    // buildWindowsTaskRegistrationScript is a pure function — the exact
    // PowerShell that `pboss startup install` runs on Windows — so it can
    // be pinned here without a Windows host.

    test("compiled install: binary + __daemon, per-user trigger, fail-fast", () => {
      delete process.env.USERNAME;
      process.env.USERNAME = "zak";
      try {
        const script = buildWindowsTaskRegistrationScript([
          "C:\\Program Files\\pboss\\pboss.exe",
          "__daemon",
        ]);
        // Execute/Argument are separate values — no /tr quoting hell.
        expect(script).toContain(
          "-Execute 'C:\\Program Files\\pboss\\pboss.exe' -Argument '__daemon'"
        );
        // Trigger + principal are bound to the invoking user; RunLevel
        // Limited keeps registration possible from an unelevated shell.
        expect(script).toContain("New-ScheduledTaskTrigger -AtLogOn -User 'zak'");
        expect(script).toContain(
          "New-ScheduledTaskPrincipal -UserId 'zak' -LogonType Interactive -RunLevel Limited"
        );
        // Failures must be terminating or the exit code stays 0.
        expect(script).toContain("$ErrorActionPreference = 'Stop'");
        expect(script).toContain("Register-ScheduledTask -TaskName 'PBOSS_Daemon'");
        expect(script).toContain("-Force");
      } finally {
        process.env.USERNAME = SAVED_USERNAME;
      }
    });

    test("script install: paths with spaces are double-quoted inside -Argument", () => {
      delete process.env.USERNAME;
      process.env.USERNAME = "zak";
      try {
        const script = buildWindowsTaskRegistrationScript([
          "C:\\Program Files\\Bun\\bun.exe",
          "run",
          "C:\\Users\\zak b\\daemon.ts",
        ]);
        expect(script).toContain("-Execute 'C:\\Program Files\\Bun\\bun.exe'");
        expect(script).toContain("-Argument 'run \"C:\\Users\\zak b\\daemon.ts\"'");
      } finally {
        process.env.USERNAME = SAVED_USERNAME;
      }
    });

    test("single quotes in values are escaped PowerShell-style ('')", () => {
      delete process.env.USERNAME;
      process.env.USERNAME = "za'k";
      try {
        const script = buildWindowsTaskRegistrationScript(["pboss.exe", "__daemon"], "PBO'SS");
        expect(script).toContain("-User 'za''k'");
        expect(script).toContain("-TaskName 'PBO''SS'");
        // Task name default is untouched.
        expect(buildWindowsTaskRegistrationScript(["pboss.exe", "__daemon"])).toContain(
          "-TaskName 'PBOSS_Daemon'"
        );
      } finally {
        process.env.USERNAME = SAVED_USERNAME;
      }
    });

    test("no USERNAME: still registers, just without a user-restricted trigger", () => {
      delete process.env.USERNAME;
      const script = buildWindowsTaskRegistrationScript(["pboss.exe", "__daemon"]);
      expect(script).toContain("New-ScheduledTaskTrigger -AtLogOn");
      expect(script).not.toContain("-User ");
      expect(script).toContain("New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Limited");
    });

    test("RunLevel Limited, never Highest — Highest needs an elevated shell (issue #35)", () => {
      // Registering a task whose principal demands Highest privileges fails
      // "Access is denied" (0x80070005) from a normal shell, and the
      // per-user installer always runs unelevated — issue #35's root cause.
      // The daemon is user-land only, so it never needs the elevated token.
      // Permanent ban, same spirit as the postinstall redirect-token ban.
      delete process.env.USERNAME;
      const unelevated = buildWindowsTaskRegistrationScript(["pboss.exe", "__daemon"]);
      process.env.USERNAME = "zak";
      let withUser: string;
      try {
        withUser = buildWindowsTaskRegistrationScript(["pboss.exe", "__daemon"]);
      } finally {
        process.env.USERNAME = SAVED_USERNAME;
      }
      for (const script of [unelevated, withUser]) {
        expect(script).toContain("-RunLevel Limited");
        expect(script).not.toContain("Highest");
      }
    });
  });

  describe("Windows hidden daemon launcher — the wscript/VBS shim", () => {
    // Owner report 2026-09-15 (issue #36 follow-up): right after installing
    // on Windows, a cmd window appeared running the daemon ("Daemon
    // listening on C:\Users\...\.pboss\daemon.sock"). Root cause: Task
    // Scheduler and the Registry Run key can only LAUNCH a program — a
    // console program launched that way gets a VISIBLE console, right
    // after install (schtasks /run) and again at every logon. The fix: the
    // task action and Run key value become `wscript.exe //B <vbs>`, where
    // the generated VBS starts the daemon with a hidden window and
    // appends its output to the daemon log files. wscript is a windowless
    // GUI binary — the one launch vehicle on Windows that never shows a
    // console. Pinned off-Windows as pure functions + source inspection.

    test("VBS: hidden fire-and-forget Run, compiled install (owner's shape)", () => {
      const vbs = buildWindowsDaemonLauncherVbs(
        ["C:\\Users\\razzb\\AppData\\Local\\pboss\\pboss.exe", "__daemon"],
        "C:\\Users\\razzb\\.pboss\\daemon.out.log",
        "C:\\Users\\razzb\\.pboss\\daemon.err.log"
      );
      // wscript never shows error dialogs at logon.
      expect(vbs).toContain("Option Explicit");
      // The whole point: hidden window (0), do not wait (False).
      expect(vbs).toContain('sh.Run q & comspec & q & " /c " & q & line & q, 0, False');
      // The executed line: daemon + __daemon, output APPENDED to the same
      // daemon log files the direct CLI spawn path writes (" are doubled
      // for the VBS string literal).
      expect(vbs).toContain(
        'line = "C:\\Users\\razzb\\AppData\\Local\\pboss\\pboss.exe __daemon 1>> ""C:\\Users\\razzb\\.pboss\\daemon.out.log"" 2>> ""C:\\Users\\razzb\\.pboss\\daemon.err.log"""'
      );
      // cmd is resolved through %ComSpec%, never a bare "cmd" guess.
      expect(vbs).toContain('comspec = sh.ExpandEnvironmentStrings("%ComSpec%")');
      expect(vbs).not.toContain("\ncmd /");
    });

    test("VBS: script install with spaces — tokens quoted, VBS-escaped", () => {
      const vbs = buildWindowsDaemonLauncherVbs(
        ["C:\\Program Files\\Bun\\bun.exe", "run", "C:\\Users\\zak b\\daemon.ts"],
        "C:\\Users\\zak b\\.pboss\\daemon.out.log",
        "C:\\Users\\zak b\\.pboss\\daemon.err.log"
      );
      expect(vbs).toContain(
        'line = """C:\\Program Files\\Bun\\bun.exe"" run ""C:\\Users\\zak b\\daemon.ts"" 1>> ""C:\\Users\\zak b\\.pboss\\daemon.out.log"" 2>> ""C:\\Users\\zak b\\.pboss\\daemon.err.log"""'
      );
    });

    test("VBS survives cmd /c quote stripping: outer pair strips, inner stays", () => {
      // cmd /? rule: with more than two quotes after /c, the FIRST and LAST
      // quotes are stripped. The VBS wraps the line in exactly one outer
      // pair, so the stripped result is the intact daemon line.
      const vbs = buildWindowsDaemonLauncherVbs(
        ["C:\\Program Files\\pboss\\pboss.exe", "__daemon"],
        "C:\\pb home\\daemon.out.log",
        "C:\\pb home\\daemon.err.log"
      );
      const m = vbs.match(/line = "(.*)"/)!;
      const line = m[1]!.replace(/""/g, '"'); // de-VBS-escape
      const afterCmd = ("\"" + line + "\"").slice(1, -1); // cmd strips first+last
      expect(afterCmd).toBe(line); // the executed line is EXACTLY the built line
      expect(afterCmd.startsWith('"C:\\Program Files\\pboss\\pboss.exe"')).toBe(true);
      expect(afterCmd).toContain('1>> "C:\\pb home\\daemon.out.log"');
      expect(afterCmd).toContain('2>> "C:\\pb home\\daemon.err.log"');
    });

    test("VBS: empty daemon command is rejected (same guard as task/Run key)", () => {
      expect(() => buildWindowsDaemonLauncherVbs([], "a", "b")).toThrow("executable");
    });

    test("launcher path lives in the pboss home", () => {
      expect(windowsDaemonLauncherPath()).toContain(WINDOWS_DAEMON_LAUNCHER_NAME);
      expect(WINDOWS_DAEMON_LAUNCHER_NAME).toBe("daemon-launch.vbs");
    });

    test("Run key value for the launcher: wscript //B with quoted VBS path", () => {
      const argv = buildWindowsRunKeyAddCommand([
        "wscript.exe",
        "//B",
        "C:\\Users\\zak b\\.pboss\\daemon-launch.vbs",
      ]);
      expect(argv).toContain('wscript.exe //B "C:\\Users\\zak b\\.pboss\\daemon-launch.vbs"');
    });

    test("task action for the launcher: wscript, not the raw daemon exe", () => {
      delete process.env.USERNAME;
      const script = buildWindowsTaskRegistrationScript([
        "wscript.exe",
        "//B",
        "C:\\Users\\zak b\\.pboss\\daemon-launch.vbs",
      ]);
      expect(script).toContain("-Execute 'wscript.exe'");
      expect(script).toContain(
        "-Argument '//B \"C:\\Users\\zak b\\.pboss\\daemon-launch.vbs\"'"
      );
    });

    test("install() wires BOTH persistence mechanisms through the launcher", () => {
      const src = readFileSync(join(import.meta.dir, "..", "src", "startup-manager.ts"), "utf8");
      // The launcher command is the wscript shim...
      expect(src).toContain('["wscript.exe", "//B"');
      // ...passed to the task registration AND the Run key fallback.
      expect(src).toContain("buildWindowsTaskRegistrationScript(launcherCmd");
      expect(src).toContain("buildWindowsRunKeyAddCommand(launcherCmd");
      // The VBS is written BEFORE anything can fire it.
      const writeIdx = src.indexOf("this.writeWindowsDaemonLauncher(daemonCmd)");
      const taskIdx = src.indexOf("buildWindowsTaskRegistrationScript(launcherCmd");
      const runKeyIdx = src.indexOf("buildWindowsRunKeyAddCommand(launcherCmd");
      expect(writeIdx).toBeGreaterThan(0);
      expect(taskIdx).toBeGreaterThan(writeIdx);
      expect(runKeyIdx).toBeGreaterThan(writeIdx);
      // Degrades honestly: a failed VBS write falls back to the raw command
      // (visible, but persistence still works).
      expect(src).toContain("launcherCmd = daemonCmd");
    });

    test("uninstall() removes the launcher with the task and Run key", () => {
      const src = readFileSync(join(import.meta.dir, "..", "src", "startup-manager.ts"), "utf8");
      const uninstallSrc = src.slice(
        src.indexOf("async uninstall("),
        src.indexOf("async status(")
      );
      expect(uninstallSrc).toContain("windowsDaemonLauncherPath()");
      expect(uninstallSrc).toContain("rmSync");
      expect(uninstallSrc).toContain(WINDOWS_DAEMON_LAUNCHER_NAME);
    });
  });

  describe("Windows Registry Run key fallback (denied task registration)", () => {
    // Owner report 2026-09-14, Windows install: Register-ScheduledTask fails
    // "Access is denied" even for a per-user task, the CLI still exited 0,
    // and the installer printed "✓ Boot persistence enabled" for a machine
    // with no persistence. The Run key is the fallback: same logon trigger,
    // zero Task Scheduler permissions. These are pure functions — the exact
    // reg.exe argv `pboss startup install` runs on Windows — pinned here
    // without a Windows host.

    test("compiled install: exe + __daemon, path with spaces quoted", () => {
      const argv = buildWindowsRunKeyAddCommand([
        "C:\\Users\\razzb\\AppData\\Local\\pboss\\pboss.exe",
        "__daemon",
      ]);
      expect(argv[0]).toBe("add");
      expect(argv[1]).toBe(WINDOWS_RUN_KEY);
      expect(argv).toContain("/v");
      expect(argv).toContain("PBOSS_Daemon");
      expect(argv).toContain("REG_SZ");
      // No spaces in the exe path → no quotes needed.
      expect(argv).toContain(
        "C:\\Users\\razzb\\AppData\\Local\\pboss\\pboss.exe __daemon"
      );
      // /f — re-running startup install must overwrite, not fail.
      expect(argv[argv.length - 1]).toBe("/f");

      const spaced = buildWindowsRunKeyAddCommand([
        "C:\\Program Files\\pboss\\pboss.exe",
        "__daemon",
      ]);
      expect(spaced).toContain('"C:\\Program Files\\pboss\\pboss.exe" __daemon');
    });

    test("script install: bun path and daemon path both quoted when spaced", () => {
      const argv = buildWindowsRunKeyAddCommand([
        "C:\\Program Files\\Bun\\bun.exe",
        "run",
        "C:\\Users\\zak b\\daemon.ts",
      ]);
      expect(argv).toContain(
        '"C:\\Program Files\\Bun\\bun.exe" run "C:\\Users\\zak b\\daemon.ts"'
      );
    });

    test("empty daemon command is rejected (same guard as the task script)", () => {
      expect(() => buildWindowsRunKeyAddCommand([])).toThrow("executable");
    });

    test("remove and query target the same value in the same key", () => {
      expect(buildWindowsRunKeyRemoveCommand()).toEqual([
        "delete",
        WINDOWS_RUN_KEY,
        "/v",
        "PBOSS_Daemon",
        "/f",
      ]);
      expect(buildWindowsRunKeyQueryCommand()).toEqual([
        "query",
        WINDOWS_RUN_KEY,
        "/v",
        "PBOSS_Daemon",
      ]);
    });

    test("the Run key is HKCU — per-user, no elevation possible to need", () => {
      expect(WINDOWS_RUN_KEY).toBe(
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
      );
    });

    test("parseWindowsRunKeyQuery extracts the command from reg query output", () => {
      const output = [
        "",
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "    PBOSS_Daemon    REG_SZ    \"C:\\Program Files\\pboss\\pboss.exe\" __daemon",
        "",
      ].join("\r\n");
      expect(parseWindowsRunKeyQuery(output)).toBe(
        '"C:\\Program Files\\pboss\\pboss.exe" __daemon'
      );
    });

    test("parseWindowsRunKeyQuery: no REG_SZ line (not installed) is null", () => {
      expect(parseWindowsRunKeyQuery("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
      expect(parseWindowsRunKeyQuery("")).toBeNull();
    });
  });

  describe("Windows install must not lie about persistence (exit code honesty)", () => {
    // install() THROWS when both the task and the Run key fail, so the CLI
    // exits nonzero and install.ps1 prints its warning branch instead of
    // "✓ Boot persistence enabled". The pinned strings live in
    // src/startup-manager.ts install(); here we pin the installer side.

    test("install.ps1 gates the ✓ boot persistence line on the exit code", () => {
      const ps1 = readFileSync(join(import.meta.dir, "..", "scripts", "install.ps1"), "utf8");
      const okIdx = ps1.indexOf("✓ Boot persistence enabled");
      const gateIdx = ps1.indexOf("if ($LASTEXITCODE -eq 0) {");
      expect(okIdx).toBeGreaterThan(0);
      expect(gateIdx).toBeGreaterThan(0);
      // The success line sits INSIDE the exit-code-0 branch, after the gate.
      expect(okIdx).toBeGreaterThan(gateIdx);
      // And the honest warning branch exists for the nonzero case.
      expect(ps1).toContain("⚠ Boot persistence could not be configured automatically");
      expect(ps1).toContain("pboss startup install");
    });

    test("install.ps1 source build skips lifecycle scripts (no postinstall parse bomb)", () => {
      const ps1 = readFileSync(join(import.meta.dir, "..", "scripts", "install.ps1"), "utf8");
      expect(ps1).toContain("bun install --ignore-scripts");
    });

    test("package.json postinstall carries no shell redirect tokens", () => {
      // Bun 1.4.2's Windows shell fails to parse `>/dev/null 2>&1` in a
      // lifecycle script ("expected a command or assignment but got:
      // 'Redirect'") — the script must stay free of redirects and use only
      // `|| exit 0`, which parses everywhere (bun shell, sh, cmd).
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
      const postinstall = pkg.scripts.postinstall;
      expect(postinstall).toBe("bun src/postinstall.ts || exit 0");
      expect(postinstall).not.toMatch(/\/dev\/null|2>&1|>/);
    });
  });

  describe("ClusterManager on Windows", () => {
    test("builds worker command with python on Windows", () => {
      const cm = new ClusterManager();
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      try {
        const config: ProcessDescription = {
          id: 0,
          name: "py-app",
          script: "C:\\apps\\script.py",
          args: [],
          cwd: "C:\\apps",
          env: {},
          instances: 1,
          execMode: "fork",
          autorestart: true,
          maxRestarts: 10,
          minUptime: 1000,
          watch: false,
          mergeLogs: false,
          raw: false,
          killTimeout: 5000,
          restartDelay: 0,
        };

        const cmd = cm.buildWorkerCommand(config);
        expect(cmd[0]).toBe("python");
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });

    test("builds worker command with cmd.exe for .bat and .cmd on Windows", () => {
      const cm = new ClusterManager();
      const config: ProcessDescription = {
        id: 0,
        name: "bat-app",
        script: "C:\\scripts\\run.bat",
        args: ["arg1"],
        cwd: "C:\\scripts",
        env: {},
        instances: 1,
        execMode: "fork",
        autorestart: true,
        maxRestarts: 10,
        minUptime: 1000,
        watch: false,
        mergeLogs: false,
        raw: false,
        killTimeout: 5000,
        restartDelay: 0,
      };

      const cmd = cm.buildWorkerCommand(config);
      expect(cmd[0]).toBe("cmd.exe");
      expect(cmd[1]).toBe("/c");
    });

    test("builds worker command with powershell.exe for .ps1 on Windows", () => {
      const cm = new ClusterManager();
      const config: ProcessDescription = {
        id: 0,
        name: "ps-app",
        script: "C:\\scripts\\run.ps1",
        args: [],
        cwd: "C:\\scripts",
        env: {},
        instances: 1,
        execMode: "fork",
        autorestart: true,
        maxRestarts: 10,
        minUptime: 1000,
        watch: false,
        mergeLogs: false,
        raw: false,
        killTimeout: 5000,
        restartDelay: 0,
      };

      const cmd = cm.buildWorkerCommand(config);
      expect(cmd[0]).toBe("powershell.exe");
      expect(cmd).toContain("-File");
    });

    test("builds worker command with resolved bun for js/ts", () => {
      const cm = new ClusterManager();
      const config: ProcessDescription = {
        id: 0,
        name: "ts-app",
        script: "./server.ts",
        args: ["--port", "3000"],
        cwd: "/app",
        env: {},
        instances: 1,
        execMode: "fork",
        autorestart: true,
        maxRestarts: 10,
        minUptime: 1000,
        watch: false,
        mergeLogs: false,
        raw: false,
        killTimeout: 5000,
        restartDelay: 0,
      };

      const cmd = cm.buildWorkerCommand(config);
      // Interpreter is resolved to the absolute system Bun path (works under
      // minimal-PATH environments like systemd).
      const bunPath = Bun.which("bun")!;
      expect(bunPath).toBeTruthy();
      expect(cmd[0]).toBe(bunPath);
      expect(cmd[1]).toBe("run");
      expect(cmd).toContain("--port");
      expect(cmd).toContain("3000");
    });
  });

  describe("LogManager cross-platform rotation with Bun.gzipSync", () => {
    const TEST_DIR = join(tmpdir(), `pboss-win-log-test-${Date.now()}`);

    test("rotates and compresses logs using native Bun.gzipSync without external gzip CLI", async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const logFile = join(TEST_DIR, "test-app-0-out.log");
      const lm = new LogManager();

      // Write content exceeding maxSize
      const content = "Hello World! ".repeat(100);
      await writeFile(logFile, content);

      await lm.rotate(logFile, {
        maxSize: 50,
        retain: 3,
        compress: true,
      });

      // Give background tasks a moment to complete
      await Bun.sleep(150);

      // Verify log file was truncated
      const currentLog = await readFile(logFile, "utf-8");
      expect(currentLog).toBe("");

      // Verify compressed archive exists
      const gzFile = Bun.file(`${logFile}.1.gz`);
      expect(await gzFile.exists()).toBe(true);

      // Verify compressed file can be decompressed
      const gzBuffer = await gzFile.arrayBuffer();
      const decompressed = Bun.gunzipSync(new Uint8Array(gzBuffer));
      const decompressedText = new TextDecoder().decode(decompressed);
      expect(decompressedText).toBe(content);

      await rm(TEST_DIR, { recursive: true, force: true });
    });

    test("reads logs without external tail utility", async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const lm = new LogManager();
      const outFile = join(TEST_DIR, "read-test-out.log");
      const errFile = join(TEST_DIR, "read-test-err.log");

      await lm.appendJSONLog(outFile, "Line 1");
      await lm.appendJSONLog(outFile, "Line 2");
      await lm.appendJSONLog(outFile, "Line 3");
      await lm.forceFlush();

      const logs = await lm.readLogs("read-test", 0, 2, outFile, errFile);
      expect(logs).toHaveLength(2);
      expect(logs[0]!.msg).toBe("Line 2");
      expect(logs[1]!.msg).toBe("Line 3");

      await rm(TEST_DIR, { recursive: true, force: true });
    });

    test("handles Windows CRLF line breaks in log files", async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const lm = new LogManager();
      const outFile = join(TEST_DIR, "crlf-test-out.log");
      const errFile = join(TEST_DIR, "crlf-test-err.log");

      const rawContent = '{"ts":"2026-01-01T00:00:00.000Z","msg":"Windows log 1"}\r\n{"ts":"2026-01-01T00:00:01.000Z","msg":"Windows log 2"}\r\n';
      await writeFile(outFile, rawContent);

      const logs = await lm.readLogs("crlf-test", 0, 10, outFile, errFile);
      expect(logs).toHaveLength(2);
      expect(logs[0]!.msg).toBe("Windows log 1");
      expect(logs[1]!.msg).toBe("Windows log 2");

      await rm(TEST_DIR, { recursive: true, force: true });
    });
  });

  describe("treeKill on Windows", () => {
    test("handles treeKill call safely", async () => {
      // Test that treeKill resolves without throwing for invalid/non-existent PID
      await expect(treeKill(999999)).resolves.toBeUndefined();
    });
  });

  describe("Daemon Startup on Windows", () => {
    test("starts Daemon without accessing server.url on Unix socket", async () => {
      const Daemon = (await import("../src/daemon")).default;
      const { DAEMON_SOCKET } = await import("../src/constants");
      const dm = new Daemon();
      await dm.initialize(false);

      expect(dm.initialized).toBe(true);
      expect(dm.getServerOpts().unix).toBe(DAEMON_SOCKET);
    });
  });

  describe("Daemon spawn detachment (issue #36)", () => {
    // Owner report 2026-09-15, Windows with NO persistence installed: `pboss
    // start` brought the daemon up, then it died the instant the CLI process
    // exited. Root cause: the daemon Bun.spawn calls lacked `detached: true`
    // — unref() only stops Bun's event loop from WAITING on the child; it
    // does not detach the OS process (POSIX: no setsid; Windows: no
    // UV_PROCESS_DETACHED, child tied to the parent's lifetime). The daemon
    // must outlive every CLI invocation that starts it.
    //
    // Pinned off-Windows by source inspection (same pattern as the
    // install.ps1 / postinstall pins): every spawn that redirects to the
    // DAEMON LOG FILES is a daemon launch, and each must be detached.

    test("every daemon-launch spawn is detached (api.ts + startup-manager.ts)", () => {
      for (const rel of ["src/api.ts", "src/startup-manager.ts"]) {
        const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
        const blocks = src
          .split("Bun.spawn(")
          .slice(1)
          .map((rest) => rest.slice(0, rest.indexOf("});")));
        const daemonLaunches = blocks.filter((b) => b.includes("stdout: outLog"));
        expect(daemonLaunches.length).toBeGreaterThan(0);
        for (const block of daemonLaunches) {
          expect(block).toContain("detached: true");
        }
      }
    });

    test("every detached daemon spawn also hides its window (windowsHide)", () => {
      // Owner report 2026-09-15, the follow-up to #36: the detached daemon
      // now SURVIVES the CLI — but on Windows a detached console child
      // gets its own VISIBLE cmd.exe window (the console running the
      // daemon that appeared after install). detached keeps it alive;
      // windowsHide keeps it invisible. Both, always, together.
      for (const rel of ["src/api.ts", "src/startup-manager.ts"]) {
        const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
        const blocks = src
          .split("Bun.spawn(")
          .slice(1)
          .map((rest) => rest.slice(0, rest.indexOf("});")));
        const detached = blocks.filter((b) => b.includes("detached: true"));
        expect(detached.length).toBeGreaterThan(0);
        for (const block of detached) {
          expect(block).toContain("windowsHide: true");
        }
      }
    });

    test("detached daemon spawns never opt into IPC (incompatible with detach)", () => {
      for (const rel of ["src/api.ts", "src/startup-manager.ts"]) {
        const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
        const blocks = src
          .split("Bun.spawn(")
          .slice(1)
          .map((rest) => rest.slice(0, rest.indexOf("});")));
        for (const block of blocks) {
          if (block.includes("detached: true")) {
            expect(block).not.toContain("ipc");
          }
        }
      }
    });
  });

  describe("Daemon children spawn hidden — the console-less-parent rule (issue #36, 2026-09-15 second follow-up)", () => {
    // Owner report: "pboss start still opens a separate cli terminal even
    // though it must be in silent background on windows." 1.4.3 detached the
    // daemon and 1.4.4 hid it — so on Windows the daemon now has NO console
    // at all. But a console child of a console-less parent gets a brand-new
    // VISIBLE console window: every app `pboss start` launched, every cluster
    // worker, every cron tick, every taskkill, every git/deploy/module child
    // the daemon spawned popped a terminal. The fix is one rule:
    //
    //   EVERY spawn made from inside the daemon carries `windowsHide: true`.
    //
    // Pinned off-Windows by source inspection. windowsHide is not even PARSED
    // on POSIX (Bun reads it Windows-only), so the pins change nothing here —
    // they freeze the Windows contract only. CLI-side spawns (upgrade, deploy,
    // cloud login, startup install) intentionally keep their visible console:
    // their parent is the user's own terminal.

    const DAEMON_ONLY_SPAWN_FILES = [
      "src/process-container.ts", // user apps (fork mode)
      "src/cluster-manager.ts", // cluster workers
      "src/cron-jobs.ts", // cron commands
      "src/module-manager.ts", // module installs (git/npm)
      "src/cloud.ts", // deploy-job exec + cloud git primitives
    ] as const;

    test("every Bun.spawn in daemon-only modules hides its window", () => {
      for (const rel of DAEMON_ONLY_SPAWN_FILES) {
        const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
        const blocks = src
          .split("Bun.spawn(")
          .slice(1)
          .map((rest) => rest.slice(0, rest.indexOf("});")));
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
          expect(block).toContain("windowsHide: true");
        }
      }
    });

    test("treeKill's taskkill runs hidden (daemon-side console tool)", () => {
      const src = readFileSync(join(import.meta.dir, "..", "src/utils.ts"), "utf8");
      const blocks = src
        .split("Bun.spawn(")
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf("});")));
      const taskkill = blocks.filter((b) => b.includes("taskkill"));
      expect(taskkill.length).toBeGreaterThan(0);
      for (const block of taskkill) {
        expect(block).toContain("windowsHide: true");
      }
    });

    test("deploy-job children (node:child_process) run hidden", () => {
      const src = readFileSync(join(import.meta.dir, "..", "src/deploy-job.ts"), "utf8");
      const blocks = src
        .split("spawn(")
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf("});")));
      // every real spawn call passes a cwd — the import destructure and
      // execFile GC line do not.
      const spawns = blocks.filter((b) => b.includes("cwd"));
      expect(spawns.length).toBeGreaterThanOrEqual(2);
      for (const block of spawns) {
        expect(block).toContain("windowsHide: true");
      }
    });

    test("supervised app spawns are hidden but NEVER detached", () => {
      // windowsHide and detached answer DIFFERENT questions: hidden = no
      // console window; detached = daemon stops owning the child. Apps must
      // stay owned (restart supervision, treeKill reachability). Cargo-culting
      // `detached: true` onto app spawns would recreate issue #36's death
      // semantics in reverse — unwatched, unkilled processes.
      for (const rel of ["src/process-container.ts", "src/cluster-manager.ts"]) {
        const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
        const blocks = src
          .split("Bun.spawn(")
          .slice(1)
          .map((rest) => rest.slice(0, rest.indexOf("});")));
        for (const block of blocks) {
          expect(block).toContain("windowsHide: true");
          expect(block).not.toContain("detached: true");
        }
      }
    });
  });

  describe("Daemon liveness vs the EBUSY reboot bug (issue #36, 2026-09-15 third follow-up)", () => {
    // Owner report 2026-09-15: after reboot on Windows, `pboss logs -f`
    // died with "Error: EBUSY: resource busy or locked, open". Root cause
    // chain: (1) isDaemonAlive() gated on Bun.file(DAEMON_SOCKET).exists()
    // — but Bun.file().exists() OPENs the path, and a unix socket file
    // cannot be opened (ENXIO on POSIX, a sharing violation on Windows
    // AF_UNIX reparse points), so it returned false for a LIVE socket and
    // isDaemonAlive() permanently said "dead"; (2) every command then went
    // to launchDaemon() and spawned a DUPLICATE daemon redirecting
    // stdout/stderr into daemon.out.log / daemon.err.log; (3) on Windows
    // the logon task's launcher chain (wscript → cmd /c "... 1>> out
    // 2>> err") keeps cmd.exe's redirect handles on those exact files for
    // the daemon's whole lifetime — the duplicate's log-file open hit a
    // sharing violation and the CLI died with the reported EBUSY.
    //
    // Pinned off-Windows by source inspection (this sandbox is Linux).

    test("no code path asks Bun.file() about the socket file — stat or connect only", () => {
      // Bun.file(...).exists() is blind to socket files (it opens the
      // path; sockets refuse open). Every socket-path check in src/ must
      // be stat-based (fs existsSync/unlinkSync) or connect-based
      // (probeDaemon's fetch). DAEMON_SOCKET as a Bun.file() argument is
      // the banned shape.
      const srcFiles = readdirSync(join(import.meta.dir, "..", "src")).filter((f) =>
        f.endsWith(".ts")
      );
      let checked = 0;
      for (const f of srcFiles) {
        const src = readFileSync(join(import.meta.dir, "..", "src", f), "utf8");
        checked++;
        expect(src).not.toContain("Bun.file(DAEMON_SOCKET)");
        expect(src).not.toMatch(/Bun\.file\(\s*DAEMON_SOCKET/);
      }
      expect(checked).toBeGreaterThan(10);
    });

    test("isDaemonAlive's socket check is stat-based (existsSync), not open-based", () => {
      const src = readFileSync(join(import.meta.dir, "..", "src", "api.ts"), "utf8");
      const alive = src.slice(
        src.indexOf("async isDaemonAlive()"),
        src.indexOf("async isDaemonAlive()") + 1400
      );
      expect(alive).toContain("existsSync(DAEMON_SOCKET)");
      expect(alive).not.toContain("Bun.file(DAEMON_SOCKET)");
    });

    test("launchDaemon re-probes before spawning (logon-task race guard)", () => {
      // isDaemonAlive() can legitimately miss a mid-boot daemon (the PID
      // file is written just before the socket answers). launchDaemon
      // must probeDaemon() once more and bow out instead of spawning a
      // doomed duplicate that races the real one for the socket.
      const src = readFileSync(join(import.meta.dir, "..", "src", "api.ts"), "utf8");
      const launch = src.slice(
        src.indexOf("async launchDaemon()"),
        src.indexOf("async launchDaemon()") + 1200
      );
      expect(launch).toContain("const raced = await probeDaemon()");
      expect(launch).toContain("if (raced)");
    });

    test("every log-file daemon spawn has an EBUSY fallback (silent stdio retry)", () => {
      // The wscript → cmd /c launcher holds daemon.out.log / daemon.err.log
      // for the daemon's lifetime on Windows; a racing duplicate's log-file
      // open gets EBUSY. Both direct daemon spawns (api.launchDaemon and
      // the Run-key branch of bringUpWindowsDaemon) must fall back to
      // stdio "ignore" instead of failing the command.
      for (const rel of ["src/api.ts", "src/startup-manager.ts"]) {
        const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
        // the log-redirecting spawn is wrapped in try { ... }
        expect(src).toMatch(/try\s*\{\s*\n\s*proc = Bun\.spawn\((spawnArgs|daemonCmd),\s*\{\s*\n\s*stdout: outLog,/);
        // and the catch re-spawns with silent stdio
        expect(src).toContain('retrying with silent stdio');
        expect(src).toMatch(/proc = Bun\.spawn\((spawnArgs|daemonCmd),\s*\{\s*\n\s*stdout: "ignore",/);
      }
    });
  });
});
