import { describe, test, expect } from "bun:test";
import { ClusterManager } from "../src/cluster-manager";
import type { ProcessDescription } from "../src/types";

function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function parseMemory(str: string): number {
  const match = str.match(/^([\d.]+)(B|KB|MB|GB)$/);
  if (!match) return 0;
  const value = parseFloat(match[1]!);
  const unit = match[2]!;
  switch (unit) {
    case "B": return value;
    case "KB": return value * 1024;
    case "MB": return value * 1024 * 1024;
    case "GB": return value * 1024 * 1024 * 1024;
    default: return 0;
  }
}

function makeConfig(script: string, overrides: Partial<ProcessDescription> = {}): ProcessDescription {
  return {
    id: 0,
    name: "test-proc",
    script,
    args: [],
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
    ...overrides,
  };
}

describe("Cluster Utilities", () => {
  describe("formatMemory", () => {
    test("formats bytes", () => {
      expect(formatMemory(500)).toBe("500B");
    });

    test("formats kilobytes", () => {
      expect(formatMemory(2048)).toBe("2.0KB");
    });

    test("formats megabytes", () => {
      expect(formatMemory(5 * 1024 * 1024)).toBe("5.0MB");
    });

    test("formats gigabytes", () => {
      expect(formatMemory(2 * 1024 * 1024 * 1024)).toBe("2.0GB");
    });

    test("formats fractional values", () => {
      expect(formatMemory(1536)).toBe("1.5KB");
    });
  });

  describe("parseMemory", () => {
    test("parses bytes", () => {
      expect(parseMemory("500B")).toBe(500);
    });

    test("parses kilobytes", () => {
      expect(parseMemory("2.0KB")).toBe(2048);
    });

    test("parses megabytes", () => {
      expect(parseMemory("5.0MB")).toBe(5 * 1024 * 1024);
    });

    test("parses gigabytes", () => {
      expect(parseMemory("2.0GB")).toBe(2 * 1024 * 1024 * 1024);
    });

    test("returns 0 for invalid input", () => {
      expect(parseMemory("invalid")).toBe(0);
    });
  });

  describe("Instance count calculation", () => {
    test("max uses available CPUs", () => {
      const cpuCount = navigator.hardwareConcurrency || 4;
      expect(cpuCount).toBeGreaterThan(0);
    });

    test("calculates instance count", () => {
      const cpuCount = navigator.hardwareConcurrency || 4;
      const requested: string = "max";
      const instances = requested === "max" ? cpuCount : parseInt(requested);
      expect(instances).toBe(cpuCount);
    });

    test("numeric instance count", () => {
      const requested: string = "4";
      const instances = requested === "max" ? 0 : parseInt(requested);
      expect(instances).toBe(4);
    });
  });

  describe("Multi-Language and Binary Command Building", () => {
    const cm = new ClusterManager();

    test("builds command for Go script", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./main.go"));
      expect(cmd[0]).toBe("go");
      expect(cmd[1]).toBe("run");
    });

    test("builds command for Python script", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./app.py"));
      expect(cmd[0]).toMatch(/python/);
    });

    test("builds command for Ruby script", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./server.rb"));
      expect(cmd[0]).toBe("ruby");
    });

    test("builds command for PHP script", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./index.php"));
      expect(cmd[0]).toBe("php");
    });

    test("builds command for Java JAR", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./app.jar"));
      expect(cmd[0]).toBe("java");
      expect(cmd[1]).toBe("-jar");
    });

    test("builds command for native standalone binary (no extension)", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./my-compiled-go-binary"));
      expect(cmd[0]).toContain("my-compiled-go-binary");
    });

    test("builds command with custom interpreter like node or deno", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./server.js", { interpreter: "node", interpreterArgs: ["--max-old-space-size=2048"] }));
      expect(cmd[0]).toBe("node");
      expect(cmd[1]).toBe("--max-old-space-size=2048");
    });

    test("builds command for direct binary when interpreter is 'none'", () => {
      const cmd = cm.buildWorkerCommand(makeConfig("./service", { interpreter: "none" }));
      expect(cmd[0]).toContain("service");
    });
  });
});
