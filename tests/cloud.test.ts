/**
 * Cloud agent unit tests — protocol mapping, SSE parsing, event diffing,
 * and the config file round-trip. Network behaviour (streams, reconnects)
 * is covered by the end-to-end flow against a live daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SseParser,
  mapProcessState,
  buildStateReport,
  diffEvents,
  startOptionsFromState,
  saveCloudConfig,
  loadCloudConfig,
  clearCloudConfig,
} from "../src/cloud";
import { CLOUD_FILE } from "../src/constants";
import { rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "path";
import type { ProcessState } from "../src/types";

function fakeState(overrides: Partial<ProcessState> = {}): ProcessState {
  return {
    id: 0,
    name: "web",
    status: "online",
    pid: 4242,
    pm_id: 0,
    monit: { memory: 150 * 1024 * 1024, cpu: 7 },
    pboss_env: {
      id: 0,
      name: "web",
      script: "server.ts",
      args: [],
      cwd: "/srv",
      env: {},
      instances: 1,
      execMode: "fork",
      autorestart: true,
      maxRestarts: 16,
      minUptime: 1000,
      watch: false,
      ignoreWatch: [],
      mergeLogs: false,
      raw: false,
      killTimeout: 5000,
      restartDelay: 0,
      created_at: Date.now(),
      restart_time: 2,
      unstable_restarts: 1,
      // pm_uptime is the epoch-ms START timestamp — a 45-second-old process
      // started 45s ago (mapProcessState computes now - start).
      pm_uptime: Date.now() - 45_000,
      status: "online",
      pm_id: 0,
    },
    ...overrides,
  } as ProcessState;
}

/* ── SseParser ────────────────────────────────────────────────────────── */

describe("SseParser", () => {
  test("parses complete frames", () => {
    const p = new SseParser();
    const events = p.push(
      'event: command\ndata: {"id":"cmd_1","type":"process.list","payload":{}}\n\n' +
        "event: hello\ndata: {\"a\":1}\n\n"
    );
    expect(events.length).toBe(2);
    expect(events[0]!.event).toBe("command");
    expect(JSON.parse(events[0]!.data).id).toBe("cmd_1");
    expect(events[1]!.event).toBe("hello");
  });

  test("reassembles frames split across chunks", () => {
    const p = new SseParser();
    const frame = 'event: command\ndata: {"id":"cmd_2","type":"process.stop","payload":{"target":"api"}}\n\n';
    const first = p.push(frame.slice(0, 25));
    expect(first.length).toBe(0); // incomplete — nothing yet
    const second = p.push(frame.slice(25));
    expect(second.length).toBe(1);
    expect(JSON.parse(second[0]!.data).payload.target).toBe("api");
  });

  test("ignores comments and keepalive pings", () => {
    const p = new SseParser();
    const events = p.push(": ping\n\n" + "retry: 3000\n\n");
    expect(events.length).toBe(0);
  });

  test("multi-line data joins with newlines", () => {
    const p = new SseParser();
    const events = p.push("event: x\ndata: line1\ndata: line2\n\n");
    expect(events[0]!.data).toBe("line1\nline2");
  });

  test("handles CRLF line endings", () => {
    const p = new SseParser();
    const events = p.push("event: cmd\r\ndata: {\"ok\":true}\r\n\r\n");
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe("cmd");
    expect(JSON.parse(events[0]!.data).ok).toBe(true);
  });

  test("defaults to message event name", () => {
    const p = new SseParser();
    const events = p.push('data: {"x":9}\n\n');
    expect(events[0]!.event).toBe("message");
  });
});

/* ── process mapping ─────────────────────────────────────────────────── */

describe("mapProcessState", () => {
  test("maps a healthy process", () => {
    const r = mapProcessState(fakeState());
    expect(r.name).toBe("web");
    expect(r.script).toBe("server.ts");
    expect(r.status).toBe("online");
    expect(r.cpu).toBe(7);
    expect(r.mem).toBe(150);
    expect(r.restarts).toBe(2);
    expect(r.crashes).toBe(1);
    expect(r.uptimeSec).toBe(45);
    expect(r.pid).toBe(4242);
    expect(r.pmId).toBe(0);
  });

  test("maps launching/waiting-restart as online", () => {
    expect(mapProcessState(fakeState({ status: "launching" })).status).toBe("online");
    expect(mapProcessState(fakeState({ status: "waiting-restart" })).status).toBe("online");
  });

  test("maps errored and stopped", () => {
    expect(mapProcessState(fakeState({ status: "errored" })).status).toBe("errored");
    expect(mapProcessState(fakeState({ status: "stopping" })).status).toBe("stopped");
  });

  test("tolerates missing monit/pboss_env", () => {
    const bare = { id: 1, name: "x", status: "stopped", pm_id: 3 } as ProcessState;
    const r = mapProcessState(bare);
    expect(r.cpu).toBe(0);
    expect(r.mem).toBe(0);
    expect(r.restarts).toBe(0);
    expect(r.uptimeSec).toBe(0);
    expect(r.script).toBe("");
  });
});

describe("buildStateReport", () => {
  test("carries machine facts and processes", () => {
    const r = buildStateReport("srv_1", [fakeState()]);
    expect(r.serverId).toBe("srv_1");
    expect(r.status).toBe("online");
    expect(r.processes.length).toBe(1);
    expect(r.events).toEqual([]);
    expect(r.agentVersion).toContain("pboss/");
    expect(r.bunVersion).toBe(Bun.version);
    expect(r.memTotal).toBeGreaterThan(0);
    expect(r.cpu).toBeGreaterThanOrEqual(0);
    expect(r.cpu).toBeLessThanOrEqual(100);
  });
});

/* ── event diffing ───────────────────────────────────────────────────── */

describe("diffEvents", () => {
  const proc = (name: string, status: string, restarts = 0) => ({
    name,
    script: "s.ts",
    pmId: 0,
    status: status as "online" | "stopped" | "errored",
    cpu: 0,
    mem: 0,
    restarts,
    crashes: 0,
    uptimeSec: 0,
  });

  test("new process emits online", () => {
    const events = diffEvents(new Map(), [proc("api", "online")]);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("online");
    expect(events[0]!.process).toBe("api");
  });

  test("online → errored emits crash", () => {
    const prev = new Map([["api", proc("api", "online")]]);
    const events = diffEvents(prev, [proc("api", "errored")]);
    expect(events.some((e) => e.kind === "crash" && e.process === "api")).toBe(true);
  });

  test("online → stopped emits stopped", () => {
    const prev = new Map([["api", proc("api", "online")]]);
    const events = diffEvents(prev, [proc("api", "stopped")]);
    expect(events.some((e) => e.kind === "stopped")).toBe(true);
  });

  test("stopped → online emits online", () => {
    const prev = new Map([["api", proc("api", "stopped")]]);
    const events = diffEvents(prev, [proc("api", "online")]);
    expect(events.some((e) => e.kind === "online")).toBe(true);
  });

  test("restart count increase emits restart", () => {
    const prev = new Map([["api", proc("api", "online", 3)]]);
    const events = diffEvents(prev, [proc("api", "online", 4)]);
    expect(events.some((e) => e.kind === "restart")).toBe(true);
  });

  test("no changes → no events", () => {
    const prev = new Map([["api", proc("api", "online", 3)]]);
    expect(diffEvents(prev, [proc("api", "online", 3)]).length).toBe(0);
  });
});

/* ── start options reconstruction ─────────────────────────────────────── */

describe("startOptionsFromState", () => {
  test("rebuilds StartOptions from pboss_env", () => {
    const opts = startOptionsFromState(fakeState());
    expect(opts.script).toBe("server.ts");
    expect(opts.name).toBe("web");
    expect(opts.cwd).toBe("/srv");
    expect(opts.execMode).toBe("fork");
    expect(opts.autorestart).toBe(true);
    expect(opts.maxRestarts).toBe(16);
  });
});

/* ── config file ─────────────────────────────────────────────────────── */

describe("cloud config file", () => {
  // CLOUD_FILE is resolved at import time against the module's PBOSS_HOME,
  // so the round-trip runs against the module's own path (and cleans up).

  test("save → load round-trip; clear removes", () => {
    const cfg = {
      cloudUrl: "https://procboss.com",
      serverId: "srv_abc",
      serverSecret: "pbs_secret",
      serverName: "prod-01",
    };
    saveCloudConfig(cfg);
    const loaded = loadCloudConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.serverId).toBe("srv_abc");
    expect(loaded!.serverSecret).toBe("pbs_secret");
    expect(loaded!.cloudUrl).toBe("https://procboss.com");
    clearCloudConfig();
    expect(loadCloudConfig()).toBeNull();
  });

  test("resolveCloudUrl trims trailing slashes and honors override", async () => {
    const { resolveCloudUrl } = await import("../src/cloud");
    expect(resolveCloudUrl("https://procboss.com///")).toBe("https://procboss.com");
    expect(resolveCloudUrl(undefined)).toBe("https://procboss.com");
  });
});
