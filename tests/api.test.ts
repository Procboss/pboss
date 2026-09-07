// tests/api.test.ts

import { describe, test, expect, beforeEach, afterEach, mock, spyOn, jest } from "bun:test";
import {
  PBoss,
  PBossError,
  pboss as pbossSingleton,
  list,
  describe as describeProc,
  getProcesses,
  readSavedProcesses,
  logs,
  metrics,
  prometheus,
} from "../src/api";
import type { DaemonResponse, ProcessState, MetricSnapshot } from "../src/types";

// ────────────────────────────────────────────────────────────────────────────
// Helpers & Fixtures
// ────────────────────────────────────────────────────────────────────────────

function makeProcess(overrides: Partial<ProcessState> = {}): ProcessState {
  return {
    id: 0,
    name: "test-app",
    script: "/abs/path/app.ts",
    status: "online",
    pid: 1234,
    pm_id: 0,
    instances: 1,
    namespace: "default",
    restarts: 0,
    uptime: 10000,
    memory: 50_000_000,
    cpu: 1.5,
    created_at: Date.now(),
    ...overrides,
  } as ProcessState;
}

function makeMetricSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    timestamp: Date.now(),
    processes: [],
    system: { cpu: 10, memory: 40, loadavg: [1, 1, 1] },
    ...overrides,
  } as MetricSnapshot;
}

function okResponse(data: any = {}, type: string = "response"): DaemonResponse {
  return { success: true, data, id: "test-id", type } as DaemonResponse;
}

function errResponse(error: string = "Something went wrong", type: string = "response"): DaemonResponse {
  return { success: false, error, id: "test-id", type } as DaemonResponse;
}

// ────────────────────────────────────────────────────────────────────────────
// Test suite
// ────────────────────────────────────────────────────────────────────────────

describe("PBoss API", () => {
  let pboss: PBoss;
  let sendMock: ReturnType<typeof spyOn>;

  beforeEach(() => {
    pboss = new PBoss();
    // Mock `send` so we never touch real sockets / daemon
    sendMock = spyOn(pboss, "send");
    // Default: pretend we're connected
    (pboss as any)._connected = true;
  });

  afterEach(() => {
    pboss.stopPolling();
    sendMock.mockRestore();
  });

  // ───────────────────── Connection lifecycle ─────────────────────────

  describe("connect()", () => {
    test("sets connected = true and emits daemon:connected on success", async () => {
      const aliveSpy = spyOn(pboss as any, "isDaemonAlive").mockResolvedValue(true);
      sendMock.mockResolvedValue(okResponse({ pid: 42 }, "ping"));

      const events: string[] = [];
      pboss.on("daemon:connected", () => events.push("daemon:connected"));

      const result = await pboss.connect();

      expect(result).toBe(pboss);
      expect(pboss.connected).toBe(true);
      expect(pboss.daemonPid).toBe(42);
      expect(events).toContain("daemon:connected");

      aliveSpy.mockRestore();
    });

    test("launches daemon when not alive", async () => {
      const aliveSpy = spyOn(pboss as any, "isDaemonAlive").mockResolvedValue(false);
      const launchSpy = spyOn(pboss as any, "launchDaemon").mockResolvedValue(undefined);
      sendMock.mockResolvedValue(okResponse({ pid: 99 }, "ping"));

      await pboss.connect();

      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(pboss.connected).toBe(true);

      aliveSpy.mockRestore();
      launchSpy.mockRestore();
    });

    test("throws when ping fails after connection", async () => {
      const aliveSpy = spyOn(pboss as any, "isDaemonAlive").mockResolvedValue(true);
      sendMock.mockResolvedValue(errResponse("ping failed", "ping"));

      await expect(pboss.connect()).rejects.toThrow("Failed to connect to pboss daemon");

      aliveSpy.mockRestore();
    });
  });

  describe("disconnect()", () => {
    test("sets connected = false and emits daemon:disconnected", async () => {
      (pboss as any)._connected = true;
      const events: string[] = [];
      pboss.on("daemon:disconnected", () => events.push("daemon:disconnected"));

      await pboss.disconnect();

      expect(pboss.connected).toBe(false);
      expect(events).toContain("daemon:disconnected");
    });

    test("stops polling on disconnect", async () => {
      const stopSpy = spyOn(pboss, "stopPolling");
      await pboss.disconnect();
      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });

  // ───────────────────── Process management ─────────────────────────

  describe("start()", () => {
    test("sends start message and returns process list", async () => {
      const procs = [makeProcess({ name: "api" })];
      sendMock.mockResolvedValue(okResponse(procs, "start"));

      const result = await pboss.start({ script: "./app.ts", name: "api" });

      expect(result).toEqual(procs);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "start" })
      );
    });

    test("resolves script path to absolute", async () => {
      sendMock.mockResolvedValue(okResponse([], "start"));

      await pboss.start({ script: "./relative/app.ts", name: "test" });

      const callData = sendMock.mock.calls[0][0].data;
      expect(callData.script).toMatch(/^\//); // absolute path
      expect(callData.script).not.toContain("./");
    });

    test("emits process:start event", async () => {
      const procs = [makeProcess()];
      sendMock.mockResolvedValue(okResponse(procs, "start"));

      const emitted: ProcessState[][] = [];
      pboss.on("process:start", (p) => emitted.push(p));

      await pboss.start({ script: "./app.ts", name: "test" });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(procs);
    });

    test("throws PBossError on daemon failure", async () => {
      sendMock.mockResolvedValue(errResponse("script not found", "start"));

      await expect(pboss.start({ script: "./nope.ts" })).rejects.toThrow(PBossError);
    });
  });

  describe("startEcosystem()", () => {
    test("sends ecosystem message with resolved paths", async () => {
      const procs = [makeProcess({ name: "a" }), makeProcess({ name: "b" })];
      sendMock.mockResolvedValue(okResponse(procs, "ecosystem"));

      const config = {
        apps: [
          { script: "./a.ts", name: "a" },
          { script: "./b.ts", name: "b" },
        ],
      };

      const result = await pboss.startEcosystem(config);

      expect(result).toEqual(procs);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ecosystem" })
      );
      // Scripts should be resolved
      for (const app of config.apps) {
        expect(app.script).toMatch(/^\//);
      }
    });

    test("emits process:start event", async () => {
      sendMock.mockResolvedValue(okResponse([], "ecosystem"));
      const emitted: any[] = [];
      pboss.on("process:start", (p) => emitted.push(p));

      await pboss.startEcosystem({ apps: [{ script: "./a.ts" }] });

      expect(emitted).toHaveLength(1);
    });
  });

  describe("stop()", () => {
    test("sends stop with target", async () => {
      const procs = [makeProcess({ status: "stopped" as any })];
      sendMock.mockResolvedValue(okResponse(procs, "stop"));

      const result = await pboss.stop("my-app");

      expect(result).toEqual(procs);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stop", data: { target: "my-app" } })
      );
    });

    test("sends stopAll when target is 'all'", async () => {
      sendMock.mockResolvedValue(okResponse([], "stopAll"));

      await pboss.stop("all");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stopAll", data: undefined })
      );
    });

    test("defaults to 'all' when no target given", async () => {
      sendMock.mockResolvedValue(okResponse([], "stopAll"));

      await pboss.stop();

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stopAll" })
      );
    });

    test("accepts numeric target and converts to string", async () => {
      sendMock.mockResolvedValue(okResponse([], "stop"));

      await pboss.stop(3);

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stop", data: { target: "3" } })
      );
    });

    test("emits process:stop event", async () => {
      sendMock.mockResolvedValue(okResponse([], "stop"));
      const emitted: any[] = [];
      pboss.on("process:stop", (p) => emitted.push(p));

      await pboss.stop("test");

      expect(emitted).toHaveLength(1);
    });
  });

  describe("restart()", () => {
    test("sends restart with target", async () => {
      sendMock.mockResolvedValue(okResponse([], "restart"));

      await pboss.restart("my-app");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "restart", data: { target: "my-app" } })
      );
    });

    test("sends restartAll when target is 'all'", async () => {
      sendMock.mockResolvedValue(okResponse([], "restartAll"));

      await pboss.restart("all");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "restartAll", data: undefined })
      );
    });

    test("defaults to 'all'", async () => {
      sendMock.mockResolvedValue(okResponse([], "restartAll"));
      await pboss.restart();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "restartAll" })
      );
    });

    test("emits process:restart event", async () => {
      sendMock.mockResolvedValue(okResponse([], "restart"));
      const emitted: any[] = [];
      pboss.on("process:restart", (p) => emitted.push(p));
      await pboss.restart("app");
      expect(emitted).toHaveLength(1);
    });
  });

  describe("reload()", () => {
    test("sends reload with target", async () => {
      sendMock.mockResolvedValue(okResponse([], "reload"));

      await pboss.reload("my-app");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "reload", data: { target: "my-app" } })
      );
    });

    test("sends reloadAll when target is 'all'", async () => {
      sendMock.mockResolvedValue(okResponse([], "reloadAll"));
      await pboss.reload();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "reloadAll" })
      );
    });

    test("emits process:reload event", async () => {
      sendMock.mockResolvedValue(okResponse([], "reload"));
      const emitted: any[] = [];
      pboss.on("process:reload", (p) => emitted.push(p));
      await pboss.reload("app");
      expect(emitted).toHaveLength(1);
    });
  });

  describe("delete()", () => {
    test("sends delete with target", async () => {
      sendMock.mockResolvedValue(okResponse([], "delete"));

      await pboss.delete("my-app");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delete", data: { target: "my-app" } })
      );
    });

    test("sends deleteAll when target is 'all'", async () => {
      sendMock.mockResolvedValue(okResponse([], "deleteAll"));
      await pboss.delete();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "deleteAll" })
      );
    });

    test("emits process:delete event", async () => {
      sendMock.mockResolvedValue(okResponse([], "delete"));
      const emitted: any[] = [];
      pboss.on("process:delete", (p) => emitted.push(p));
      await pboss.delete("app");
      expect(emitted).toHaveLength(1);
    });
  });

  describe("scale()", () => {
    test("sends scale with target and count", async () => {
      const procs = [makeProcess(), makeProcess({ id: 1, pm_id: 1 })];
      sendMock.mockResolvedValue(okResponse(procs, "scale"));

      const result = await pboss.scale("my-app", 4);

      expect(result).toEqual(procs);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "scale",
          data: { target: "my-app", count: 4 },
        })
      );
    });

    test("converts numeric target to string", async () => {
      sendMock.mockResolvedValue(okResponse([], "scale"));
      await pboss.scale(0, 2);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { target: "0", count: 2 },
        })
      );
    });

    test("emits process:scale event", async () => {
      sendMock.mockResolvedValue(okResponse([], "scale"));
      const emitted: any[] = [];
      pboss.on("process:scale", (p) => emitted.push(p));
      await pboss.scale("app", 3);
      expect(emitted).toHaveLength(1);
    });
  });

  describe("sendSignal()", () => {
    test("sends signal command", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "signal"));

      await pboss.sendSignal("my-app", "SIGHUP");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "signal",
          data: { target: "my-app", signal: "SIGHUP" },
        })
      );
    });

    test("converts numeric target to string", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "signal"));
      await pboss.sendSignal(2, "SIGTERM");
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { target: "2", signal: "SIGTERM" },
        })
      );
    });
  });

  describe("reset()", () => {
    test("sends reset with target", async () => {
      sendMock.mockResolvedValue(okResponse([], "reset"));

      await pboss.reset("my-app");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "reset",
          data: { target: "my-app" },
        })
      );
    });

    test("defaults to 'all'", async () => {
      sendMock.mockResolvedValue(okResponse([], "reset"));
      await pboss.reset();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { target: "all" },
        })
      );
    });
  });

  // ───────────────────── Introspection ──────────────────────────────

  describe("list()", () => {
    test("returns array of process states", async () => {
      const procs = [makeProcess({ name: "a" }), makeProcess({ name: "b", id: 1 })];
      sendMock.mockResolvedValue(okResponse(procs, "list"));

      const result = await pboss.list();

      expect(result).toEqual(procs);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "list" })
      );
    });

    test("returns empty array when no processes", async () => {
      sendMock.mockResolvedValue(okResponse([], "list"));
      const result = await pboss.list();
      expect(result).toEqual([]);
    });
  });

  describe("describe()", () => {
    test("sends describe with target", async () => {
      const proc = makeProcess({ name: "api" });
      sendMock.mockResolvedValue(okResponse([proc], "describe"));

      const result = await pboss.describe("api");

      expect(result).toEqual([proc]);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "describe",
          data: { target: "api" },
        })
      );
    });

    test("accepts numeric target", async () => {
      sendMock.mockResolvedValue(okResponse([], "describe"));
      await pboss.describe(0);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { target: "0" } })
      );
    });
  });

  // ───────────────────── Logs ───────────────────────────────────────

  describe("logs()", () => {
    test("retrieves logs with default parameters", async () => {
      const logData = [{ name: "app", id: 0, ts: "2026-09-04T00:00:00.000Z", msg: "hello\n", level: "out" as const }];
      sendMock.mockResolvedValue(okResponse(logData, "logs"));

      const result = await pboss.logs();

      expect(result).toEqual(logData);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "logs",
          data: { target: "all", lines: 20 },
        })
      );
    });

    test("accepts custom target and line count", async () => {
      sendMock.mockResolvedValue(okResponse([], "logs"));

      await pboss.logs("my-app", 100);

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { target: "my-app", lines: 100 },
        })
      );
    });

    test("emits log:data event", async () => {
      const logData = [{ name: "app", id: 0, ts: "2026-09-04T00:00:00.000Z", msg: "log line", level: "out" as const }];
      sendMock.mockResolvedValue(okResponse(logData, "logs"));

      const emitted: any[] = [];
      pboss.on("log:data", (logs) => emitted.push(logs));

      await pboss.logs();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(logData);
    });
  });

  describe("flush()", () => {
    test("sends flush with target", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "flush"));

      await pboss.flush("my-app");

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "flush",
          data: { target: "my-app" },
        })
      );
    });

    test("sends flush without target when omitted", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "flush"));

      await pboss.flush();

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "flush",
          data: undefined,
        })
      );
    });

    test("sends flush with numeric target", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "flush"));
      await pboss.flush(0);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { target: "0" } })
      );
    });
  });

  // ───────────────────── Monitoring ─────────────────────────────────

  describe("metrics()", () => {
    test("returns metric snapshot and emits event", async () => {
      const snapshot = makeMetricSnapshot();
      sendMock.mockResolvedValue(okResponse(snapshot, "metrics"));

      const emitted: MetricSnapshot[] = [];
      pboss.on("metrics", (s) => emitted.push(s));

      const result = await pboss.metrics();

      expect(result).toEqual(snapshot);
      expect(emitted).toHaveLength(1);
    });
  });

  describe("metricsHistory()", () => {
    test("sends metricsHistory with default seconds", async () => {
      sendMock.mockResolvedValue(okResponse([], "metricsHistory"));

      await pboss.metricsHistory();

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "metricsHistory",
          data: { seconds: 300 },
        })
      );
    });

    test("sends metricsHistory with custom seconds", async () => {
      sendMock.mockResolvedValue(okResponse([], "metricsHistory"));

      await pboss.metricsHistory(60);

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { seconds: 60 },
        })
      );
    });
  });

  describe("prometheus()", () => {
    test("returns prometheus-formatted string", async () => {
      const promText = '# HELP pboss_cpu CPU usage\npboss_cpu{name="app"} 1.5\n';
      sendMock.mockResolvedValue(okResponse(promText, "prometheus"));

      const result = await pboss.prometheus();

      expect(result).toBe(promText);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "prometheus" })
      );
    });
  });

  describe("startPolling() / stopPolling()", () => {
    test("starts periodic metrics fetching", async () => {
      sendMock.mockResolvedValue(okResponse(makeMetricSnapshot(), "metrics"));

      const emitted: any[] = [];
      pboss.on("metrics", (s) => emitted.push(s));

      pboss.startPolling(50);

      // Wait enough for a couple ticks
      await Bun.sleep(160);
      pboss.stopPolling();

      expect(emitted.length).toBeGreaterThanOrEqual(2);
    });

    test("emits error event when metrics call fails during polling", async () => {
      sendMock.mockRejectedValue(new Error("connection lost"));

      const errors: Error[] = [];
      
      pboss.on("error", (e) => errors.push(e));

      pboss.startPolling(50);

      await Bun.sleep(100);
      pboss.stopPolling();

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]?.message).toBe("connection lost");
    });

    test("stopPolling clears the interval", () => {
      pboss.startPolling(100);
      expect((pboss as any)._pollTimer).not.toBeNull();

      pboss.stopPolling();
      expect((pboss as any)._pollTimer).toBeNull();
    });

    test("startPolling replaces existing timer", () => {
      pboss.startPolling(100);
      const first = (pboss as any)._pollTimer;

      pboss.startPolling(200);
      const second = (pboss as any)._pollTimer;

      expect(second).not.toBe(first);
      pboss.stopPolling();
    });
  });

  // ───────────────────── Persistence ────────────────────────────────

  describe("save()", () => {
    test("sends save command", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "save"));

      await pboss.save();

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "save" })
      );
    });
  });

  describe("resurrect()", () => {
    test("sends resurrect and returns restored processes", async () => {
      const procs = [makeProcess()];
      sendMock.mockResolvedValue(okResponse(procs, "resurrect"));

      const result = await pboss.resurrect();

      expect(result).toEqual(procs);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "resurrect" })
      );
    });
  });

  // ───────────────────── Dashboard ──────────────────────────────────

  describe("dashboard()", () => {
    test("starts dashboard with default ports", async () => {
      sendMock.mockResolvedValue(okResponse({ port: 9100, metricsPort: 9101 }, "dashboard"));

      const result = await pboss.dashboard();

      expect(result).toEqual({ port: 9100, metricsPort: 9101 });
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "dashboard" })
      );
    });

    test("starts dashboard with custom ports", async () => {
      sendMock.mockResolvedValue(okResponse({ port: 3000, metricsPort: 3001 }, "dashboard"));

      const result = await pboss.dashboard(3000, 3001);

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { port: 3000, metricsPort: 3001 },
        })
      );
    });
  });

  describe("dashboardStop()", () => {
    test("sends dashboardStop command", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "dashboardStop"));
      await pboss.dashboardStop();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "dashboardStop" })
      );
    });
  });

  // ───────────────────── Modules ────────────────────────────────────

  describe("moduleInstall()", () => {
    test("installs module and returns path", async () => {
      sendMock.mockResolvedValue(okResponse({ path: "/home/.pboss/modules/foo" }, "moduleInstall"));

      const result = await pboss.moduleInstall("foo");

      expect(result).toEqual({ path: "/home/.pboss/modules/foo" });
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "moduleInstall",
          data: { module: "foo" },
        })
      );
    });
  });

  describe("moduleUninstall()", () => {
    test("sends moduleUninstall command", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "moduleUninstall"));
      await pboss.moduleUninstall("foo");
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "moduleUninstall",
          data: { module: "foo" },
        })
      );
    });
  });

  describe("moduleList()", () => {
    test("returns list of installed modules", async () => {
      const modules = [{ name: "foo", version: "1.0.0" }];
      sendMock.mockResolvedValue(okResponse(modules, "moduleList"));

      const result = await pboss.moduleList();

      expect(result).toEqual(modules);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "moduleList" })
      );
    });
  });

  // ───────────────────── Daemon lifecycle ───────────────────────────

  describe("ping()", () => {
    test("returns daemon pid and uptime", async () => {
      sendMock.mockResolvedValue(okResponse({ pid: 42, uptime: 12345 }, "ping"));

      const result = await pboss.ping();

      expect(result).toEqual({ pid: 42, uptime: 12345 });
    });
  });

  describe("kill()", () => {
    test("cleans up state and emits daemon:killed even with no daemon alive", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "kill"));
      (pboss as any)._connected = true;
      (pboss as any)._daemonPid = 42;

      const events: string[] = [];
      pboss.on("daemon:killed", () => events.push("daemon:killed"));

      await pboss.kill();

      expect(pboss.connected).toBe(false);
      expect(pboss.daemonPid).toBeNull();
      expect(events).toContain("daemon:killed");
    });

    test("never spawns when no daemon is alive (ExecStop idempotency)", async () => {
      // The old path went through send(), whose auto-start would SPAWN a
      // fresh daemon just to kill it — wasteful and, under systemd's
      // ExecStop, an extra competing daemon.
      const launchSpy = spyOn(pboss as any, "launchDaemon");

      await pboss.kill();

      expect(sendMock).not.toHaveBeenCalled();
      expect(launchSpy).not.toHaveBeenCalled();
      launchSpy.mockRestore();
    });

    test("sends kill and waits for the daemon to be gone when one is alive", async () => {
      // fetch call 1: probe (alive) · call 2: the kill request · call 3+:
      // follow-up probes (gone) — the bounded wait must observe the exit.
      let calls = 0;
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
        calls++;
        const alive = calls <= 2;
        return {
          ok: true,
          json: async () =>
            alive
              ? { success: true, data: { pid: 42, uptime: 5 } }
              : { success: false },
        } as any;
      }) as unknown as typeof fetch);

      const events: string[] = [];
      pboss.on("daemon:killed", () => events.push("daemon:killed"));

      await pboss.kill();

      expect(events).toContain("daemon:killed");
      expect(pboss.connected).toBe(false);
      expect(calls).toBeGreaterThanOrEqual(3);
      fetchSpy.mockRestore();
    });

    test("stops polling on kill", async () => {
      sendMock.mockResolvedValue(okResponse(undefined, "kill"));
      const stopSpy = spyOn(pboss, "stopPolling");

      await pboss.kill();

      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });

  describe("daemonReload()", () => {
    test("sends daemonReload and returns result", async () => {
      sendMock.mockResolvedValue(okResponse("daemon reloaded", "daemonReload"));

      const result = await pboss.daemonReload();

      expect(result).toBe("daemon reloaded");
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "daemonReload" })
      );
    });
  });

  // ───────────────────── Error handling ─────────────────────────────

  describe("PBossError", () => {
    test("is thrown on failed daemon responses", async () => {
      const failedResponse = errResponse("process not found", "list");
      sendMock.mockResolvedValue(failedResponse);

      try {
        await pboss.list();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PBossError);
        expect((err as PBossError).command).toBe("list");
        expect((err as PBossError).message).toBe("process not found");
        expect((err as PBossError).response!).toEqual(failedResponse);
      }
    });

    test("uses default message when error field is missing", async () => {
      sendMock.mockResolvedValue({ success: false, id: "x", type: "stop" } as DaemonResponse);

      try {
        await pboss.stop("app");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PBossError);
        expect((err as PBossError).message).toContain('Command "stop" failed');
      }
    });
  });

  // ───────────────────── sendOrThrow / send internals ───────────────

  describe("sendOrThrow()", () => {
    test("returns response data when successful", async () => {
      const procs = [makeProcess({ name: "bar" })];
      sendMock.mockResolvedValue(okResponse(procs, "list"));

      const result = await pboss.list();
      expect(result).toEqual(procs);
    });

    test("propagates transport-level errors from send()", async () => {
      sendMock.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(pboss.list()).rejects.toThrow("ECONNREFUSED");
    });
  });

  // ───────────────────── Target routing patterns ────────────────────

  describe("target routing (all vs specific)", () => {
    const methodConfigs = [
      { method: "stop", allType: "stopAll", specificType: "stop" },
      { method: "restart", allType: "restartAll", specificType: "restart" },
      { method: "reload", allType: "reloadAll", specificType: "reload" },
      { method: "delete", allType: "deleteAll", specificType: "delete" },
    ] as const;

    for (const { method, allType, specificType } of methodConfigs) {
      test(`${method}() sends "${allType}" for "all" target`, async () => {
        sendMock.mockResolvedValue(okResponse([], allType));
        await (pboss as any)[method]("all");
        expect(sendMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: allType, data: undefined })
        );
      });

      test(`${method}() sends "${specificType}" for named target`, async () => {
        sendMock.mockResolvedValue(okResponse([], specificType));
        await (pboss as any)[method]("my-app");
        expect(sendMock).toHaveBeenCalledWith(
          expect.objectContaining({
            type: specificType,
            data: { target: "my-app" },
          })
        );
      });

      test(`${method}() defaults to "all"`, async () => {
        sendMock.mockResolvedValue(okResponse([], allType));
        await (pboss as any)[method]();
        expect(sendMock).toHaveBeenCalledWith(
          expect.objectContaining({ type: allType })
        );
      });
    }
  });

  // ───────────────────── Property accessors & options ───────────────

  describe("property accessors", () => {
    test("connected is false by default on fresh instance", () => {
      const fresh = new PBoss();
      expect(fresh.connected).toBe(false);
    });

    test("daemonPid is null by default", () => {
      const fresh = new PBoss();
      expect(fresh.daemonPid).toBeNull();
    });

    test("supports noDaemon option", () => {
      const foreground = new PBoss({ noDaemon: true });
      expect(foreground.noDaemon).toBe(true);
    });
  });

  // ───────────────────── Daemon helpers ─────────────────────────────

  describe("daemon helper methods", () => {
    test("isDaemonRunning returns boolean", () => {
      expect(typeof pboss.isDaemonRunning()).toBe("boolean");
    });

    test("startDaemon calls launchDaemon when not alive", async () => {
      const aliveSpy = spyOn(pboss as any, "isDaemonAlive").mockResolvedValue(false);
      const launchSpy = spyOn(pboss as any, "launchDaemon").mockResolvedValue(undefined);

      await pboss.startDaemon();

      expect(launchSpy).toHaveBeenCalledTimes(1);
      aliveSpy.mockRestore();
      launchSpy.mockRestore();
    });

    test("startDaemon skips launchDaemon when already alive", async () => {
      const aliveSpy = spyOn(pboss as any, "isDaemonAlive").mockResolvedValue(true);
      const launchSpy = spyOn(pboss as any, "launchDaemon").mockResolvedValue(undefined);

      await pboss.startDaemon();

      expect(launchSpy).toHaveBeenCalledTimes(0);
      aliveSpy.mockRestore();
      launchSpy.mockRestore();
    });
  });

  // ───────────────────── Direct & static API access ─────────────────

  describe("Direct process reading & static methods", () => {
    test("readSavedProcesses returns empty array when dump file does not exist", async () => {
      const procs = await readSavedProcesses();
      expect(Array.isArray(procs)).toBe(true);
    });

    test("getProcesses returns array without throwing", async () => {
      const procs = await getProcesses();
      expect(Array.isArray(procs)).toBe(true);
    });

    test("PBoss.getProcesses() static method works", async () => {
      const procs = await PBoss.getProcesses();
      expect(Array.isArray(procs)).toBe(true);
    });

    test("PBoss.readSavedProcesses() static method works", async () => {
      const procs = await PBoss.readSavedProcesses();
      expect(Array.isArray(procs)).toBe(true);
    });

    test("PBoss.getInstance() returns shared singleton", () => {
      const inst1 = PBoss.getInstance();
      const inst2 = PBoss.getDefaultInstance();
      expect(inst1).toBe(inst2);
      expect(pbossSingleton).toBe(inst1);
    });

    test("standalone list() and describe() functions are exported", () => {
      expect(typeof list).toBe("function");
      expect(typeof describeProc).toBe("function");
      expect(typeof logs).toBe("function");
      expect(typeof metrics).toBe("function");
      expect(typeof prometheus).toBe("function");
      expect(typeof getProcesses).toBe("function");
      expect(typeof readSavedProcesses).toBe("function");
    });
  });
});
