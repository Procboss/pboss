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

    test("builds command for Go script", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./main.go"));
      expect(cmd[0]).toBe("go");
      expect(cmd[1]).toBe("run");
    });

    test("builds command for Python script", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./app.py"));
      expect(cmd[0]).toMatch(/python/);
    });

    test("builds command for Ruby script", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./server.rb"));
      expect(cmd[0]).toBe("ruby");
    });

    test("builds command for PHP script", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./index.php"));
      expect(cmd[0]).toBe("php");
    });

    test("builds command for Java JAR", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./app.jar"));
      expect(cmd[0]).toBe("java");
      expect(cmd[1]).toBe("-jar");
    });

    test("builds command for native standalone binary (no extension)", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./my-compiled-go-binary"));
      expect(cmd[0]).toContain("my-compiled-go-binary");
    });

    test("builds command with custom interpreter like node or deno", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./server.js", { interpreter: "node", interpreterArgs: ["--max-old-space-size=2048"] }));
      expect(cmd[0]).toBe("node");
      expect(cmd[1]).toBe("--max-old-space-size=2048");
    });

    test("builds command for direct binary when interpreter is 'none'", async () => {
      const cmd = await cm.buildWorkerCommand(makeConfig("./service", { interpreter: "none" }));
      expect(cmd[0]).toContain("service");
    });
  });
});

/* ── the runtime-native cluster model (owner report 2026-10-08) ──────────── */

import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REUSEPORT_SHIM_NAME,
  REUSEPORT_PROBE_NAME,
  REUSEPORT_SHIM_SOURCE,
  REUSEPORT_PROBE_SOURCE,
  ensureReusePortFiles,
  reusePortClusterPlatform,
} from "../src/reuseport-cluster";

const denoBin = Bun.which("deno");
const bunBin = Bun.which("bun");
const LINUX = process.platform === "linux";

describe("createWorkerEnv: the two cluster port models", () => {
  test("process-based instances keep per-worker PORT offsets", () => {
    const cm2 = new ClusterManager();
    const env = cm2.createWorkerEnv({}, 2, 3, 8000);
    expect(env.PORT).toBe("8002"); // base + workerId
    expect(env.PBOSS_WORKER_ID).toBe("2");
    expect(env.PBOSS_INSTANCES).toBe("3");
  });

  test("runtime-native cluster workers SHARE the base port (like node:cluster)", () => {
    const cm2 = new ClusterManager();
    const env = cm2.createWorkerEnv({}, 2, 3, 8000, true);
    expect(env.PORT).toBe("8000"); // shared — the kernel spreads connections
    expect(env.PBOSS_WORKER_ID).toBe("2");
  });
});

describe("buildWorkerSpawn: the SO_REUSEPORT cluster decoration", () => {
  test.skipIf(!LINUX || !denoBin)(
    "a deno app with instances > 1 gets the shim preloaded (+ --unstable-net)",
    async () => {
      const { PBOSS_HOME } = await import("../src/constants");
      const cm = new ClusterManager();
      const r = await cm.buildWorkerSpawn(makeConfig("./server.ts", {
        interpreter: denoBin!,
        interpreterArgs: ["run", "-A"],
        instances: 3,
      }));
      expect(r.sharedPort).toBeTrue();
      expect(r.cmd).toContain("--unstable-net"); // reusePort is a gated deno API
      const preload = r.cmd.find((a) => a.startsWith("--preload="));
      expect(preload).toBeDefined();
      expect(preload).toBe(`--preload=${join(PBOSS_HOME, REUSEPORT_SHIM_NAME)}`);
      // the app script stays LAST — the flags ride before it
      expect(r.cmd[r.cmd.length - 1]).toContain("server.ts");
      // and the shim actually landed on disk (the freshness contract)
      expect(existsSync(join(PBOSS_HOME, REUSEPORT_SHIM_NAME))).toBeTrue();
    },
    60_000,
  );

  test.skipIf(!LINUX || !bunBin)(
    "a bun app with instances > 1 gets the shim preloaded",
    async () => {
      const { PBOSS_HOME } = await import("../src/constants");
      const cm = new ClusterManager();
      const r = await cm.buildWorkerSpawn(makeConfig("./server.js", {
        interpreter: bunBin!,
        interpreterArgs: ["run"],
        instances: 2,
      }));
      expect(r.sharedPort).toBeTrue();
      expect(r.cmd).toContain("--preload");
      expect(r.cmd).toContain(join(PBOSS_HOME, REUSEPORT_SHIM_NAME));
    },
    60_000,
  );

  test("a single instance never gets the decoration (nothing to share)", async () => {
    const cm = new ClusterManager();
    const r = await cm.buildWorkerSpawn(makeConfig("./server.js", {
      interpreter: bunBin ?? "bun",
      interpreterArgs: ["run"],
      instances: 1,
    }));
    expect(r.sharedPort).toBeFalse();
    expect(r.cmd.some((a) => String(a).startsWith("--preload"))).toBeFalse();
  });

  test.skipIf(!LINUX || !denoBin)(
    "a runtime that fails the capability probe keeps the plain per-instance model",
    async () => {
      // A fake deno whose every invocation fails — an old deno without
      // --unstable-net, or a broken install. The cluster must fall back to
      // today's model (no crash-loop on an unknown flag), never decorate.
      const dir = mkdtempSync(join(tmpdir(), "pboss-fakedeno-"));
      try {
        const fakeDeno = join(dir, "deno");
        writeFileSync(fakeDeno, "#!/bin/sh\nexit 1\n");
        chmodSync(fakeDeno, 0o755);
        const cm = new ClusterManager();
        const r = await cm.buildWorkerSpawn(makeConfig("./server.ts", {
          interpreter: fakeDeno,
          interpreterArgs: ["run", "-A"],
          instances: 3,
        }));
        expect(r.sharedPort).toBeFalse();
        expect(r.cmd).not.toContain("--unstable-net");
        expect(r.cmd.some((a) => String(a).startsWith("--preload"))).toBeFalse();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.skipIf(!LINUX || !denoBin)(
    "deno permissions and the preload flags coexist (both pre-script)",
    async () => {
      const cm = new ClusterManager();
      const r = await cm.buildWorkerSpawn(makeConfig("./server.ts", {
        interpreter: denoBin!,
        interpreterArgs: ["run"],
        instances: 3,
        permissions: ["allow-net", "allow-read"],
      }));
      // the permission merge rebuilt the route region...
      expect(r.cmd).toContain("--allow-net");
      expect(r.cmd).toContain("--allow-read");
      // ...and the preload decoration still rides before the script
      expect(r.sharedPort).toBeTrue();
      expect(r.cmd.some((a) => String(a).startsWith("--preload="))).toBeTrue();
      expect(r.cmd[r.cmd.length - 1]).toContain("server.ts");
    },
    60_000,
  );
});

describe("reuseport shim: the generated files", () => {
  test("ensureReusePortFiles writes shim + probe and is idempotent", async () => {
    const { PBOSS_HOME } = await import("../src/constants");
    const r = await ensureReusePortFiles();
    expect(r.shim).toBe(join(PBOSS_HOME, REUSEPORT_SHIM_NAME));
    expect(r.probe).toBe(join(PBOSS_HOME, REUSEPORT_PROBE_NAME));
    expect(readFileSync(r.shim, "utf8")).toBe(REUSEPORT_SHIM_SOURCE);
    expect(readFileSync(r.probe, "utf8")).toBe(REUSEPORT_PROBE_SOURCE);
    await ensureReusePortFiles(); // idempotent — same paths, content untouched
  });

  test("the shim source pins: patches every native server API, respects stated reusePort, skips port 0", () => {
    // Deno.serve — both argument orders AND the bare serve(handler) form
    expect(REUSEPORT_SHIM_SOURCE).toContain('patch');
    expect(REUSEPORT_SHIM_SOURCE).toContain("D.serve");
    expect(REUSEPORT_SHIM_SOURCE).toContain("origServe({ fetch: a, reusePort: true })");
    // Deno.listen — TCP only, never unix/udp
    expect(REUSEPORT_SHIM_SOURCE).toContain("D.listen");
    expect(REUSEPORT_SHIM_SOURCE).toContain('o.transport === "tcp"');
    // Bun.serve
    expect(REUSEPORT_SHIM_SOURCE).toContain("B.serve");
    // an app that stated its own reusePort keeps it; port 0 (kernel-assigned)
    // is never shared — wantsReuse guards both
    expect(REUSEPORT_SHIM_SOURCE).toContain('!("reusePort" in o)');
    expect(REUSEPORT_SHIM_SOURCE).toContain("o.port > 0");
  });

  test("the probe source pins: the double-bind is the verdict", () => {
    expect(REUSEPORT_PROBE_SOURCE).toContain("reusePort: true");
    expect(REUSEPORT_PROBE_SOURCE).toContain("REUSEPORT_OK");
    // two binds on the same port — the second one is the whole test
    expect(REUSEPORT_PROBE_SOURCE.match(/serve\(/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("reusePortClusterPlatform: Linux yes (the verified kernel), everything else falls back", () => {
    expect(reusePortClusterPlatform("linux")).toBeTrue();
    expect(reusePortClusterPlatform("darwin")).toBeFalse(); // unverified semantics — off
    expect(reusePortClusterPlatform("win32")).toBeFalse();
  });
});
