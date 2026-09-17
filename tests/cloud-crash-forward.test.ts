/**
 * Crash forwarding — the owner's repro: a process that crashed and STOPPED
 * produced no alert. Root cause: the cloud only learned about crashes the
 * SNAPSHOT diff happened to catch reading "errored" — a non-autorestart
 * crash ends "stopped" (handleExit forces it back), and an auto-restarted
 * one looks "online" again by the next report. The container's
 * process:crashed event (issue #32: fired the moment ANY non-deliberate
 * exit happens, raw exit facts attached) was never bridged to the cloud.
 *
 * The fix under test:
 *   1. directCrashEvent — the pure mapping (clean exit 0 self-exits are
 *      NOT crashes; exit facts + classifyCrash reason ride the event).
 *   2. CloudAgent attaches a process:crashed listener on start() and
 *      pushes the crash into the event outbox immediately (log tail
 *      attached) — delivery rides the next state report.
 *   3. The redundant diff-derived "errored" crash for the same exit is
 *      dropped (the ×N occurrence counter must not double-count), while
 *      an "errored" transition with NO direct report still fires (the
 *      fallback for start failures stays alive).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ProcessManager } from "../src/process-manager";
import type { ProcessState } from "../src/types";

// isolate the credential file BEFORE importing cloud.ts (PBOSS_HOME is
// read at module load)
const home = mkdtempSync(join(tmpdir(), "pboss-crash-forward-"));
process.env.PBOSS_HOME = home;
delete process.env.PBOSS_CLOUD_REPORT_MS;
// type-only import: erased at compile time, so the module (and its
// PBOSS_HOME read) only loads in the dynamic import below
import type { CloudConfig, CloudEventReport } from "../src/cloud";
const { CloudAgent, directCrashEvent } = await import("../src/cloud");
type CloudAgent = InstanceType<typeof CloudAgent>;

/** A process state snapshot the fake pm serves to reportState. */
const procState = (name: string, status: string): ProcessState =>
  ({
    name,
    status,
    pm_id: 0,
    pid: 1234,
    monit: { cpu: 0, memory: 0 },
    pboss_env: { script: "demo.js" },
  }) as unknown as ProcessState;

/**
 * A fake pm that is BOTH an emitter (the crash-forwarding path) and a
 * snapshot source (the diff path) — list() is mutable so tests can flip
 * the observed status after emitting a crash.
 */
function makeFakePm() {
  const pm = new EventEmitter();
  let states: ProcessState[] = [];
  // the ProcessManager surface reportState touches (an emitter for the
  // crash path + list/getLogs for the report path), merged onto the
  // object the agent receives
  Object.assign(pm, {
    list: () => states,
    getLogs: async () => [
      { name: "demo", id: 1, ts: new Date().toISOString(), msg: "Error: Bunda bad" },
    ],
    watchProcessLogs: () => undefined,
  });
  return {
    pm: pm as unknown as ProcessManager,
    setStates(next: ProcessState[]) {
      states = next;
    },
    emitCrash(name: string, extra: Record<string, unknown>) {
      pm.emit("process:crashed", {
        event: "process:crashed",
        source: "crash",
        at: Date.now(),
        process: procState(name, "online"),
        ...extra,
      });
    },
  };
}

/** A fake cloud: hello on open, collects every state frame's events. */
function startFakeCloud() {
  const frames: Array<{ events?: CloudEventReport[] }> = [];
  const sockets = new Set<{ send: (data: string) => void }>();
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      const path = new URL(req.url).pathname;
      if (path === "/ws/agent") {
        if (bunServer.upgrade(req)) return;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "hello", serverId: "srv_crashfwd", now: Date.now() }));
      },
      message(_ws, raw) {
        const frame = JSON.parse(String(raw)) as { type?: string; report?: { events?: CloudEventReport[] } };
        if (frame.type === "state") frames.push({ events: frame.report?.events ?? [] });
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    frames,
    stop() {
      server.stop(true);
    },
  };
}

const cfg = (url: string): CloudConfig => ({
  cloudUrl: url,
  serverId: "srv_crashfwd",
  serverSecret: "pbs_test",
  serverName: "crash-forward-test",
});

const agents: CloudAgent[] = [];
const clouds: Array<ReturnType<typeof startFakeCloud>> = [];

afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop({ revoke: false, quiet: true });
  for (const c of clouds.splice(0)) c.stop();
  rmSync(home, { recursive: true, force: true });
});

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Unique (by delivery id) events of a kind across all frames — the fake
 *  cloud never acks, so un-acked events ride every subsequent frame. */
const uniqueByKind = (frames: Array<{ events?: CloudEventReport[] }>, kind: string) => {
  const byId = new Map<string, CloudEventReport>();
  for (const f of frames) {
    for (const ev of f.events ?? []) {
      if (ev.kind === kind && ev.id) byId.set(ev.id, ev);
    }
  }
  return [...byId.values()];
};

describe("directCrashEvent — the pure mapping", () => {
  const ev = (extra: Record<string, unknown>) =>
    ({ event: "process:crashed", source: "crash", at: 1_758_000_000_000, process: procState("demo", "online"), ...extra }) as never;

  test("an uncaught exception (exit 1) forwards with its reason", () => {
    const crash = directCrashEvent(ev({ exitCode: 1, exitSignal: null, willRestart: false }));
    expect(crash).not.toBeNull();
    expect(crash!.kind).toBe("crash");
    expect(crash!.process).toBe("demo");
    expect(crash!.exitCode).toBe(1);
    expect(crash!.signal).toBeNull();
    expect(crash!.reason).toBe("uncaught exception");
    // the cause rides the detail — the cloud's occurrenceDetail() extracts
    // "exit 1" from it for the expander's per-reading line
    expect(crash!.detail).toBe("process crashed (exit 1)");
    expect(crash!.at).toBe(1_758_000_000_000);
  });

  test("a scheduled auto-restart says so in the detail", () => {
    const crash = directCrashEvent(ev({ exitCode: 1, exitSignal: null, willRestart: true }));
    expect(crash!.detail).toBe("process crashed (exit 1) — auto-restart scheduled");
  });

  test("SIGKILL classifies as likely OOM", () => {
    const crash = directCrashEvent(ev({ exitCode: null, exitSignal: "SIGKILL", willRestart: false }));
    expect(crash!.reason).toBe("likely OOM");
    expect(crash!.exitCode).toBeNull();
    expect(crash!.signal).toBe("SIGKILL");
    expect(crash!.detail).toBe("process crashed (SIGKILL)");
  });

  test("a clean self-exit (exit 0, no signal) is NOT a crash", () => {
    expect(directCrashEvent(ev({ exitCode: 0, exitSignal: null, willRestart: false }))).toBeNull();
  });

  test("an exit-0-with-signal still forwards (something killed it)", () => {
    const crash = directCrashEvent(ev({ exitCode: 0, exitSignal: "SIGTERM", willRestart: false }));
    expect(crash).not.toBeNull();
    expect(crash!.signal).toBe("SIGTERM");
  });
});

describe("CloudAgent crash forwarding — the live path", () => {
  test("a process:crashed emission lands in the next state report", async () => {
    const cloud = startFakeCloud();
    clouds.push(cloud);
    const fake = makeFakePm();
    const agent = new CloudAgent(fake.pm, { reportIntervalMs: 100 });
    agents.push(agent);
    fake.setStates([procState("demo", "online")]);
    agent.start(cfg(cloud.url));

    // the link must be confirmed before frames flow — the first state
    // frame is that proof
    await until(() => cloud.frames.length > 0, 5_000, "first state frame");

    fake.emitCrash("demo", { exitCode: 1, exitSignal: null, willRestart: false });
    await until(() => uniqueByKind(cloud.frames, "crash").length > 0, 2_000, "crash event delivered");

    const crashes = uniqueByKind(cloud.frames, "crash");
    expect(crashes.length).toBe(1);
    expect(crashes[0]!.process).toBe("demo");
    expect(crashes[0]!.exitCode).toBe(1);
    expect(crashes[0]!.reason).toBe("uncaught exception");
    expect(crashes[0]!.detail).toBe("process crashed (exit 1)");
    // the log tail rides the event (the cloud's CrashReport analysis)
    expect(crashes[0]!.logTail).toEqual(["Error: Bunda bad"]);
    // delivery id present — the cloud acks/dedups on it
    expect(typeof crashes[0]!.id).toBe("string");
  });

  test("the diff-derived 'errored' crash for the same exit is suppressed (no ×2)", async () => {
    const cloud = startFakeCloud();
    clouds.push(cloud);
    const fake = makeFakePm();
    const agent = new CloudAgent(fake.pm, { reportIntervalMs: 100 });
    agents.push(agent);
    fake.setStates([procState("demo", "online")]);
    agent.start(cfg(cloud.url));
    await until(() => cloud.frames.length > 0, 5_000, "first state frame");

    // the crash ends "errored" (gaveUp) — the diff WOULD derive a second
    // crash event for the same exit on the next snapshot
    fake.emitCrash("demo", { exitCode: 1, exitSignal: null, willRestart: false });
    fake.setStates([procState("demo", "errored")]);

    await until(() => uniqueByKind(cloud.frames, "crash").length > 0, 2_000, "crash event delivered");
    // several more report cycles with the process reading "errored"
    await Bun.sleep(450);
    const crashes = uniqueByKind(cloud.frames, "crash");
    expect(crashes.length).toBe(1);
    // and it is the DIRECT event (its detail), not the diff's duplicate
    expect(crashes[0]!.detail).toBe("process crashed (exit 1)");
  });

  test("an 'errored' transition with NO direct crash still reports (start failures)", async () => {
    const cloud = startFakeCloud();
    clouds.push(cloud);
    const fake = makeFakePm();
    const agent = new CloudAgent(fake.pm, { reportIntervalMs: 100 });
    agents.push(agent);
    fake.setStates([procState("demo", "online")]);
    agent.start(cfg(cloud.url));
    await until(() => cloud.frames.length > 0, 5_000, "first state frame");

    // no process:crashed emission — just the status flip the old path saw
    fake.setStates([procState("demo", "errored")]);
    await until(() => uniqueByKind(cloud.frames, "crash").length > 0, 2_000, "diff crash delivered");
    const crashes = uniqueByKind(cloud.frames, "crash");
    expect(crashes.length).toBe(1);
    expect(crashes[0]!.detail).toBe("process errored");
  });

  test("a clean self-exit emits nothing to the cloud", async () => {
    const cloud = startFakeCloud();
    clouds.push(cloud);
    const fake = makeFakePm();
    const agent = new CloudAgent(fake.pm, { reportIntervalMs: 100 });
    agents.push(agent);
    fake.setStates([procState("demo", "online")]);
    agent.start(cfg(cloud.url));
    await until(() => cloud.frames.length > 0, 5_000, "first state frame");

    fake.emitCrash("demo", { exitCode: 0, exitSignal: null, willRestart: false });
    await Bun.sleep(300);
    expect(uniqueByKind(cloud.frames, "crash")).toHaveLength(0);
  });

  test("an unlinked agent does not queue crash events", async () => {
    const fake = makeFakePm();
    const agent = new CloudAgent(fake.pm, { reportIntervalMs: 100 });
    agents.push(agent);
    // never started — the guard must leave the outbox empty
    fake.emitCrash("demo", { exitCode: 1, exitSignal: null, willRestart: false });
    await Bun.sleep(50);
    expect(agent.status().pendingEvents).toBe(0);
  });
});
