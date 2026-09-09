/**
 * Cloud agent unit tests — protocol mapping, ws URL/crash-tail helpers,
 * and the config file round-trip. Network behaviour (streams, reconnects)
 * is covered by the end-to-end flow against a live daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mapProcessState,
  buildStateReport,
  diffEvents,
  startOptionsFromState,
  wsUrlOf,
  crashLogTail,
  saveCloudConfig,
  loadCloudConfig,
  clearCloudConfig,
  assertSecureCloudUrl,
  isLoopbackHost,
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

/* ── ws url + crash tail helpers ────────────────────────────────── */

describe("wsUrlOf", () => {
  test("maps http(s) cloud URLs onto the agent WS endpoint", () => {
    expect(wsUrlOf("https://procboss.com")).toBe("wss://procboss.com/ws/agent");
    expect(wsUrlOf("http://localhost:3000")).toBe("ws://localhost:3000/ws/agent");
    expect(wsUrlOf("https://example.org/")).toBe("wss://example.org/ws/agent");
  });
});

describe("crashLogTail", () => {
  test("takes the last N non-empty messages", () => {
    const logs = Array.from({ length: 40 }, (_, i) => ({
      name: "api",
      id: 0,
      ts: String(i),
      msg: `line ${i}`,
    }));
    const tail = crashLogTail(logs, 30);
    expect(tail.length).toBe(30);
    expect(tail[0]).toBe("line 10");
    expect(tail[29]).toBe("line 39");
    expect(crashLogTail([])).toEqual([]);
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

/* ── transport security: TLS is not optional off-loopback ───────────── */

describe("cloud transport security (assertSecureCloudUrl)", () => {
  const saved = process.env.PBOSS_CLOUD_ALLOW_INSECURE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PBOSS_CLOUD_ALLOW_INSECURE;
    else process.env.PBOSS_CLOUD_ALLOW_INSECURE = saved;
  });

  test("https and wss URLs always pass", () => {
    expect(() => assertSecureCloudUrl("https://procboss.com")).not.toThrow();
    expect(() => assertSecureCloudUrl("wss://procboss.com/ws/agent")).not.toThrow();
  });

  test("plain http/ws to loopback passes (tests, local self-hosted clouds)", () => {
    expect(() => assertSecureCloudUrl("http://127.0.0.1:8080")).not.toThrow();
    expect(() => assertSecureCloudUrl("http://localhost:3000")).not.toThrow();
    expect(() => assertSecureCloudUrl("http://[::1]:3000")).not.toThrow();
    expect(() => assertSecureCloudUrl("ws://localhost:9")).not.toThrow();
  });

  test("plain http/ws to a real host is REFUSED (credential + commands at stake)", () => {
    expect(() => assertSecureCloudUrl("http://procboss.com")).toThrow(/plaintext/);
    expect(() => assertSecureCloudUrl("http://cloud.example.internal:3000")).toThrow(/plaintext/);
    expect(() => assertSecureCloudUrl("ws://192.168.1.10:3000/ws/agent")).toThrow(/plaintext/);
  });

  test("garbage URLs are refused as invalid, not as insecure", () => {
    expect(() => assertSecureCloudUrl("not a url")).toThrow(/not a valid cloud URL/);
  });

  test("PBOSS_CLOUD_ALLOW_INSECURE=1 is the explicit, loud opt-out", () => {
    process.env.PBOSS_CLOUD_ALLOW_INSECURE = "1";
    expect(() => assertSecureCloudUrl("http://cloud.example.internal:3000")).not.toThrow();
    // anything but the exact value "1" does not opt in
    process.env.PBOSS_CLOUD_ALLOW_INSECURE = "true";
    expect(() => assertSecureCloudUrl("http://cloud.example.internal:3000")).toThrow(/plaintext/);
  });

  test("isLoopbackHost recognizes every loopback spelling", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.42.0.9",
      "::1",
      "[::1]",
      "0.0.0.0",
      "db.localhost",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of [
      "procboss.com",
      "192.168.1.10",
      "10.0.0.5",
      "172.17.0.1",
      "example.internal",
      "",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
