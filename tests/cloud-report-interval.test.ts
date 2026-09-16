import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_REPORT_INTERVAL_MS } from "../src/constants";
import type { ProcessManager } from "../src/process-manager";

/**
 * The 1.5 pricing pass — tier-driven report cadence.
 *
 *   1. The DEFAULT heartbeat is 60s (was 10s): the cloud, not the agent,
 *      owns the cadence now — every state response carries the owner's
 *      plan tier as `reportIntervalSec` and the gateway relays changes
 *      down as a `report-interval` frame.
 *   2. The frame re-arms the running timer (plan upgrade → faster
 *      reporting lands on the next tick, no relink).
 *   3. An explicit LOCAL pin (constructor params or
 *      PBOSS_CLOUD_REPORT_MS) outranks the cloud: self-hosted operators
 *      and tests keep their own cadence.
 *   4. Bounds: [1s, 1h] — a corrupt frame can't park the agent on a
 *      1ms spin or a 25-day silence.
 */

// isolate the credential file BEFORE importing cloud.ts (PBOSS_HOME is
// read at module load; enroll() writes cloud.json)
const home = mkdtempSync(join(tmpdir(), "pboss-report-interval-"));
process.env.PBOSS_HOME = home;
// make sure no stray pin leaks in from the runner env
delete process.env.PBOSS_CLOUD_REPORT_MS;
// type-only import: erased at compile time, so the module (and its
// PBOSS_HOME read) only loads in the dynamic import below
import type { CloudConfig } from "../src/cloud";
const { CloudAgent: AgentCtor } = await import("../src/cloud");
type CloudAgent = InstanceType<typeof AgentCtor>;

const stubPm = {
  list: () => [],
  getLogs: async () => [],
  watchProcessLogs: () => undefined,
} as unknown as ProcessManager;

const cfg = (url: string): CloudConfig => ({
  cloudUrl: url,
  serverId: "srv_interval",
  serverSecret: "pbs_test",
  serverName: "interval-test",
});

type Frame = Record<string, unknown> & { type?: string };

/** A fake cloud: hello on open, records agent frames, lets tests push
 *  frames (report-interval) at the live socket. */
function startTierCloud() {
  const stateFrames: number[] = []; // arrival timestamps of state frames
  // bun's serve() hands out ServerWebSocket — duck-typed is enough here
  const sockets = new Set<{ send: (data: string) => void }>();
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      const path = new URL(req.url).pathname;
      if (path === "/ws/agent") {
        if (bunServer.upgrade(req)) return;
        return new Response("upgrade failed", { status: 500 });
      }
      if (path === "/api/agent/enroll" && req.method === "POST") {
        return Response.json({
          serverId: "srv_interval",
          serverSecret: "pbs_enroll",
          serverName: "interval-test",
          reportIntervalSec: 1,
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "hello", serverId: "srv_interval", now: Date.now() }));
      },
      message(_ws, raw) {
        const frame = JSON.parse(String(raw)) as Frame;
        if (frame.type === "state") stateFrames.push(Date.now());
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get stateFrames() {
      return stateFrames;
    },
    push(frame: Frame): boolean {
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify(frame));
          return true;
        } catch {
          /* next socket */
        }
      }
      return false;
    },
    stop() {
      server.stop(true);
    },
  };
}

const agents: CloudAgent[] = [];
const clouds: Array<ReturnType<typeof startTierCloud>> = [];

afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop({ revoke: false, quiet: true });
  for (const c of clouds.splice(0)) c.stop();
});

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(30);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe("CloudAgent report interval — the 1.5 tier heartbeat", () => {
  test("the default heartbeat is 60s (the cloud retunes it per plan)", () => {
    expect(CLOUD_REPORT_INTERVAL_MS).toBe(60_000);
  });

  test("a report-interval frame re-arms the running timer", async () => {
    const cloud = startTierCloud();
    clouds.push(cloud);
    // no pin: the agent starts on the 60s default — the ONLY way another
    // state frame arrives within seconds is the tier directive
    const agent = new AgentCtor(stubPm);
    agents.push(agent);
    agent.start(cfg(cloud.url));
    await until(() => cloud.stateFrames.length >= 1, 5_000, "initial state frame");

    const before = cloud.stateFrames.length;
    expect(cloud.push({ type: "report-interval", sec: 1 })).toBe(true);
    await until(() => cloud.stateFrames.length >= before + 2, 5_000, "frames at the 1s tier cadence");
  }, 15_000);

  test("an explicit local pin outranks the cloud directive", async () => {
    const cloud = startTierCloud();
    clouds.push(cloud);
    const agent = new AgentCtor(stubPm, { reportIntervalMs: 300 });
    agents.push(agent);
    agent.start(cfg(cloud.url));
    await until(() => cloud.stateFrames.length >= 1, 5_000, "initial state frame");

    // the cloud says 60s — the pin says 300ms. The pin must win: plenty
    // of frames keep flowing.
    expect(cloud.push({ type: "report-interval", sec: 60 })).toBe(true);
    await until(() => cloud.stateFrames.length >= 5, 5_000, "frames at the pinned 300ms cadence");
  }, 15_000);

  test("bounds: sub-second and sub-day directives are refused", () => {
    const agent = new AgentCtor(stubPm);
    agents.push(agent);
    expect(agent.setReportInterval(500)).toBe(false); // < 1s
    expect(agent.setReportInterval(7_200_000)).toBe(false); // > 1h
    expect(agent.setReportInterval(Number.NaN)).toBe(false);
    expect(agent.setReportInterval(5_000)).toBe(true);
    expect(agent.setReportInterval(5_000)).toBe(false); // unchanged is a no-op
  });

  test("the pin also guards the direct call; force overrides it", () => {
    const pinned = new AgentCtor(stubPm, { reportIntervalMs: 1_000 });
    agents.push(pinned);
    expect(pinned.setReportInterval(30_000)).toBe(false);
    expect(pinned.setReportInterval(30_000, { force: true })).toBe(true);
  });

  test("enrollment adopts the tier cadence from the response", async () => {
    const cloud = startTierCloud();
    clouds.push(cloud);
    const agent = new AgentCtor(stubPm); // no pin — enroll's sec applies
    agents.push(agent);
    const linked = await agent.enroll("pbc_test_token", cloud.url);
    expect(linked.serverId).toBe("srv_interval");
    agent.start(agent.config!);
    // initial frame on start, then the enrolled 1s cadence takes over —
    // vs the 60s default it would sit silent for the test's whole life
    await until(() => cloud.stateFrames.length >= 3, 5_000, "frames at the enrolled 1s cadence");
  }, 15_000);
});

// credential-file isolation cleanup (the enroll test wrote cloud.json)
process.on("exit", () => {
  rmSync(home, { recursive: true, force: true });
});
