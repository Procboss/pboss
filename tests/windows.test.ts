import { describe, test, expect } from "bun:test";
import { StartupManager } from "../src/startup-manager";
import { ClusterManager } from "../src/cluster-manager";
import { LogManager } from "../src/log-manager";
import { treeKill } from "../src/utils";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import type { ProcessDescription } from "../src/types";

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

    test("builds worker command with bun for js/ts", () => {
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
      expect(cmd[0]).toBe("bun");
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
});
