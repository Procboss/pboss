/**
 * Issue #32 — a real internal event system (process manager → daemon →
 * client/modules). https://github.com/Procboss/pboss/issues/32
 *
 * The contract under test:
 *
 * ProcessManager (module-facing, in-process):
 *   1. `pm.on("process:start"|"process:stop", …)` fires on real operator
 *      transitions, with a state snapshot, exactly once per process.
 *   2. A manual restart fires EXACTLY ONE `process:restart` (source
 *      "user") — the internal stop phase stays silent, no duplicates.
 *   3. A SIGKILLed supervised process fires `process:crashed`
 *      (willRestart: true) and then `process:restart` (source "crash")
 *      when the autorestart brings it back — with zero polling.
 *   4. `off()` removes a listener: no events are delivered afterwards.
 *   5. The unstable-restart budget exhausting fires `process:errored`.
 *   6. `pm.subscribeEvents()` SSE-frames every event and detaches ALL of
 *      its listeners when the AbortSignal fires (no leaked listeners).
 *   7. A module's `init(pm)` receives real events through the very
 *      ProcessManager the ModuleManager hands it.
 *
 * End-to-end (real daemon subprocess + real client processes):
 *   8. TWO separate PBoss clients both receive `process:restart` when
 *      EITHER one triggers it — not just the caller.
 *   9. An autonomous crash (kill -9) is seen by the client that made no
 *      call at all (crashed + restart with source "crash").
 *  10. Killing the daemon ends the clients' event streams cleanly
 *      (`daemon:disconnected`, no dangling state); disconnecting a
 *      client detaches its daemon-side subscription.
 *
 * PBOSS_HOME discipline: Part A runs against whatever home constants
 * bound (shared module registries across files in one `bun test` run —
 * same as issue-31); Part B is fully hermetic because the daemon AND the
 * client driver run as SEPARATE processes with an explicit temp home.
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-issue32-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;

// The BOUND home — NOT necessarily TEST_HOME (shared module registries).
const BOUND = await import("../src/constants");
const BOUND_HOME = BOUND.PBOSS_HOME;
const { PROCESS_EVENT_KINDS } = await import("../src/events");
type PbossProcessEvent = import("../src/events").PbossProcessEvent;

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  if (BOUND_HOME !== TEST_HOME) rmSync(TEST_HOME, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-issue32-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

function stayAliveScript(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "setInterval(() => {}, 1000);\n");
  return p;
}

/** Poll until `predicate` holds, or fail after `ms`. */
async function until(predicate: () => boolean, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(60);
  }
  return predicate();
}

/** Attach one collector to every event kind on `pm`. */
function collectAll(pm: import("../src/process-manager").ProcessManager): PbossProcessEvent[] {
  const events: PbossProcessEvent[] = [];
  for (const kind of PROCESS_EVENT_KINDS) {
    (pm.on as (k: string, l: (e: PbossProcessEvent) => void) => void)(kind, (e) =>
      events.push(e)
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// Part A — ProcessManager-level events (what modules receive via init(pm))
// ---------------------------------------------------------------------------
describe("ProcessManager events (issue #32)", () => {
  let pm: import("../src/process-manager").ProcessManager;
  let events: PbossProcessEvent[];
  let dir: string;

  afterEach(async () => {
    try {
      if (pm) await pm.deleteAll();
    } catch {
      /* empty fleet */
    }
    pm = undefined!;
    events = undefined!;
  });

  test("process:start and process:stop fire once per process with state snapshots", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("startstop");
    pm = new ProcessManager();
    events = collectAll(pm);

    const script = stayAliveScript(dir, "api.ts");
    await pm.start({ name: "api", script, minUptime: 100, restartDelay: 50 });

    const starts = events.filter((e) => e.event === "process:start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.source).toBe("user");
    expect(starts[0]!.process.name).toBe("api");
    expect(starts[0]!.process.status).toBe("online");
    expect(starts[0]!.at).toBeGreaterThan(0);

    await pm.stop("api");
    const stops = events.filter((e) => e.event === "process:stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.source).toBe("user");
    expect(stops[0]!.process.status).toBe("stopped");
  });

  test("a manual restart fires EXACTLY ONE process:restart (source user) — no synthetic duplicates", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("restart");
    pm = new ProcessManager();
    events = collectAll(pm);

    const script = stayAliveScript(dir, "web.ts");
    await pm.start({ name: "web", script, minUptime: 100, restartDelay: 50 });
    events.length = 0; // drop the start event

    await pm.restart("web");
    await Bun.sleep(400); // let any (wrong) duplicates arrive

    const restarts = events.filter((e) => e.event === "process:restart");
    expect(restarts).toHaveLength(1);
    expect(restarts[0]!.source).toBe("user");
    expect(restarts[0]!.process.name).toBe("web");
    // The restart's internal stop phase must NOT surface as process:stop.
    expect(events.filter((e) => e.event === "process:stop")).toHaveLength(0);
  });

  test("a SIGKILLed process fires process:crashed (willRestart) then process:restart with source crash", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("crash");
    pm = new ProcessManager();
    events = collectAll(pm);

    const script = stayAliveScript(dir, "victim.ts");
    const states = await pm.start({
      name: "victim",
      script,
      minUptime: 100,
      restartDelay: 50,
    });
    const pid = states[0]!.pid;
    events.length = 0; // drop the start event

    // Autonomous kill — the supervisor notices on its own, no pboss call.
    process.kill(pid!, "SIGKILL");

    expect(await until(() => events.some((e) => e.event === "process:crashed"))).toBe(true);
    const crashed = events.find((e) => e.event === "process:crashed")!;
    expect(crashed.source).toBe("crash");
    expect(crashed.willRestart).toBe(true);
    // Raw exit facts are attached (exit code and/or signal).
    expect(crashed.exitCode !== null || crashed.exitSignal !== null).toBe(true);

    expect(
      await until(() => events.some((e) => e.event === "process:restart" && e.source === "crash"))
    ).toBe(true);
    const back = events.find((e) => e.event === "process:restart" && e.source === "crash")!;
    expect(back.process.name).toBe("victim");
    expect(back.process.status).toBe("online");
  });

  test("off() removes a listener — no events are delivered afterwards", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("off");
    pm = new ProcessManager();

    const seen: PbossProcessEvent[] = [];
    const handler = (e: PbossProcessEvent) => seen.push(e);
    pm.on("process:crashed", handler);
    expect(pm.listenerCount("process:crashed")).toBe(1);

    pm.off("process:crashed", handler);
    expect(pm.listenerCount("process:crashed")).toBe(0);

    const script = stayAliveScript(dir, "quiet.ts");
    const states = await pm.start({
      name: "quiet",
      script,
      minUptime: 100,
      restartDelay: 50,
    });
    process.kill(states[0]!.pid!, "SIGKILL");

    // The crash + restart happen (state proves it), but the removed
    // listener hears nothing.
    const container = (pm as any).processes.get(states[0]!.id);
    await until(() => container.status === "online", 10000);
    await Bun.sleep(300);
    expect(seen).toHaveLength(0);
  });

  test("process:errored fires when the unstable-restart budget is exhausted", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("errored");
    pm = new ProcessManager();
    events = collectAll(pm);

    const looper = join(dir, "looper.ts");
    writeFileSync(looper, "process.exit(1);\n");

    await pm.start({
      name: "looper",
      script: looper,
      minUptime: 2000,
      maxRestarts: 2,
      restartDelay: 10,
    });

    expect(await until(() => events.some((e) => e.event === "process:errored"), 15000)).toBe(true);
    const errored = events.find((e) => e.event === "process:errored")!;
    expect(errored.source).toBe("crash");
    expect(errored.reason).toContain("max consecutive unstable restarts");
  });

  test("process:delete fires when a process is removed from the list", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("delete");
    pm = new ProcessManager();
    events = collectAll(pm);

    const script = stayAliveScript(dir, "gone.ts");
    await pm.start({ name: "gone", script, minUptime: 100, restartDelay: 50 });
    events.length = 0;

    await pm.del("gone");
    const deletes = events.filter((e) => e.event === "process:delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.source).toBe("user");
    expect(deletes[0]!.process.name).toBe("gone");
  });

  test("subscribeEvents() SSE-frames events and detaches every listener on AbortSignal", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    dir = scratch("sse");
    pm = new ProcessManager();

    let controller!: ReadableStreamDefaultController;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const reader = stream.getReader();
    const ac = new AbortController();

    await pm.subscribeEvents(controller, ac.signal);

    // One subscription = exactly one listener per event kind.
    for (const kind of PROCESS_EVENT_KINDS) {
      expect(pm.listenerCount(kind)).toBe(1);
    }

    const script = stayAliveScript(dir, "sse-app.ts");
    await pm.start({ name: "sse-app", script, minUptime: 100, restartDelay: 50 });

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    // subscribeEvents enqueues string frames ("data: {...}\n\n").
    const frame = typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array);
    expect(frame.startsWith("data: ")).toBe(true);
    const parsed = JSON.parse(frame.replace(/^data:\s*/, "").trim()) as PbossProcessEvent;
    expect(parsed.event).toBe("process:start");
    expect(parsed.process.name).toBe("sse-app");
    expect(parsed.source).toBe("user");

    // Abort (client disconnect) → every listener of this subscription is
    // removed from the ProcessManager — nothing leaks.
    ac.abort();
    for (const kind of PROCESS_EVENT_KINDS) {
      expect(pm.listenerCount(kind)).toBe(0);
    }

    // Enqueueing onto the (closed) stream after detach is a silent no-op,
    // not a crash — the supervisor keeps running.
    await pm.deleteAll();
  });

  test("a module's init(pm) receives real events through the ModuleManager's pm", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { ModuleManager } = await import("../src/module-manager");
    dir = scratch("module");
    pm = new ProcessManager();

    // A minimal real module on disk — the README's log-shipper shape:
    // it reacts the instant something happens instead of polling.
    const modDir = join(dir, "i32-mod");
    mkdirSync(modDir);
    writeFileSync(
      join(modDir, "package.json"),
      JSON.stringify({ name: "i32-mod", version: "1.0.0", main: "index.ts" })
    );
    writeFileSync(
      join(modDir, "index.ts"),
      [
        "export default {",
        "  name: 'i32-mod',",
        "  version: '1.0.0',",
        "  seen: [] as any[],",
        "  async init(pm: any) {",
        "    pm.on('process:crashed', (e: any) => { (this as any).seen.push(e); });",
        "  },",
        "};",
        "",
      ].join("\n")
    );

    const mm = new ModuleManager(pm);
    await mm.load(modDir);
    expect(mm.list().map((m) => m.name)).toContain("i32-mod");

    const modObject = (await import(join(modDir, "index.ts"))).default as {
      seen: PbossProcessEvent[];
    };

    const script = stayAliveScript(dir, "watched.ts");
    const states = await pm.start({
      name: "watched",
      script,
      minUptime: 100,
      restartDelay: 50,
    });
    process.kill(states[0]!.pid!, "SIGKILL");

    expect(
      await until(() => (modObject.seen ?? []).some((e) => e.event === "process:crashed"))
    ).toBe(true);
    const seen = modObject.seen.find((e) => e.event === "process:crashed")!;
    expect(seen.process.name).toBe("watched");
    expect(seen.willRestart).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part B — end-to-end over the REAL daemon (unix socket), two real clients
// ---------------------------------------------------------------------------
describe("daemon event stream, two real clients (issue #32)", () => {
  function spawnDaemon(home: string) {
    return Bun.spawn(["bun", "run", CLI, "__daemon"], {
      env: { ...process.env, PBOSS_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  }

  /** The client driver: a SEPARATE process, so its constants bind to `home`. */
  function clientDriverScript(dir: string): string {
    const p = join(dir, "e2e-client.ts");
    writeFileSync(
      p,
      [
        `const SRC = process.env.PBOSS_SRC!;`,
        `const APP = process.env.APP_SCRIPT!;`,
        `const { PBoss } = await import(SRC + "/api.ts");`,
        `const { DAEMON_SOCKET } = await import(SRC + "/constants.ts");`,
        ``,
        `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));`,
        `async function until(pred: () => boolean, ms = 15000): Promise<boolean> {`,
        `  const deadline = Date.now() + ms;`,
        `  while (Date.now() < deadline) {`,
        `    if (pred()) return true;`,
        `    await sleep(60);`,
        `  }`,
        `  return pred();`,
        `}`,
        ``,
        `const KINDS = ${JSON.stringify([...PROCESS_EVENT_KINDS])};`,
        `const eventsA: any[] = [];`,
        `const eventsB: any[] = [];`,
        ``,
        `const a = new PBoss();`,
        `const b = new PBoss();`,
        `await a.connect();`,
        `await b.connect();`,
        ``,
        `const report: any = {`,
        `  bothConnected: a.connected && b.connected,`,
        `  aStart: false,`,
        `  bStart: false,`,
        `  aRestartCount: 0,`,
        `  bRestartCount: 0,`,
        `  restartSource: null,`,
        `  bCrashed: false,`,
        `  bCrashRestart: false,`,
        `  aDisconnectedOnKill: false,`,
        `  aStreamCleaned: false,`,
        `};`,
        ``,
        `for (const k of KINDS) {`,
        `  a.on(k as any, (e: any) => eventsA.push(e));`,
        `  b.on(k as any, (e: any) => eventsB.push(e));`,
        `}`,
        ``,
        `// 1. Caller A starts a process — client B (which made no call) sees it.`,
        `await a.start({ script: APP, name: "i32-app", minUptime: 100, restartDelay: 50 });`,
        `report.aStart = await until(() =>`,
        `  eventsA.some((e) => e.event === "process:start" && e.process?.name === "i32-app")`,
        `);`,
        `report.bStart = await until(() =>`,
        `  eventsB.some((e) => e.event === "process:start" && e.process?.name === "i32-app")`,
        `);`,
        ``,
        `// 2. Caller A restarts — BOTH receive it, exactly once each.`,
        `await a.restart("i32-app");`,
        `await until(() => eventsB.some((e) => e.event === "process:restart"));`,
        `await sleep(400); // let any (wrong) duplicates arrive`,
        `report.aRestartCount = eventsA.filter((e) => e.event === "process:restart").length;`,
        `report.bRestartCount = eventsB.filter((e) => e.event === "process:restart").length;`,
        `report.restartSource =`,
        `  eventsB.find((e) => e.event === "process:restart")?.source ?? null;`,
        ``,
        `// 3. Autonomous crash (kill -9) — B hears crashed + restart(crash).`,
        `const list = await a.list();`,
        `const pid = list.find((s: any) => s.name === "i32-app")?.pid;`,
        `if (pid) process.kill(pid, "SIGKILL");`,
        `report.bCrashed = await until(() =>`,
        `  eventsB.some((e) => e.event === "process:crashed")`,
        `);`,
        `report.bCrashRestart = await until(() =>`,
        `  eventsB.some((e) => e.event === "process:restart" && e.source === "crash")`,
        `);`,
        ``,
        `// 4. Kill the daemon OUT from under client A (raw request — NOT`,
        `// a.kill(), which would close A's stream first). A's stream must`,
        `// end cleanly: daemon:disconnected fires and the stream detaches.`,
        `a.on("daemon:disconnected", () => { report.aDisconnectedOnKill = true; });`,
        `await b.disconnect(); // B detaches its daemon-side subscription`,
        `try {`,
        `  await fetch("http://localhost/", {`,
        `    method: "POST",`,
        `    headers: { "Content-Type": "application/json" },`,
        `    body: JSON.stringify({ type: "kill", id: "e2e-kill" }),`,
        `    unix: DAEMON_SOCKET,`,
        `  });`,
        `} catch { /* daemon may exit before responding — success path */ }`,
        `await until(() => report.aDisconnectedOnKill, 15000);`,
        `report.aStreamCleaned = (a as any)._eventStream === null;`,
        ``,
        `console.log("E2E_RESULT:" + JSON.stringify(report));`,
        `process.exit(0);`,
        ``,
      ].join("\n")
    );
    return p;
  }

  async function waitResponsive(home: string, timeoutMs = 15_000): Promise<boolean> {
    const { probeDaemon } = await import("../src/daemon-probe");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probeDaemon(join(home, "daemon.sock"))) return true;
      await Bun.sleep(150);
    }
    return false;
  }

  test.skipIf(process.platform === "win32")(
    "two clients, autonomous events, clean daemon-death cleanup — end to end",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-issue32-e2e-"));
      scratchDirs.push(home);
      const driverDir = scratch("driver");
      const appScript = stayAliveScript(driverDir, "i32-app.ts");
      const driver = clientDriverScript(driverDir);

      const daemon = spawnDaemon(home);
      const up = await waitResponsive(home);
      expect(up).toBeTrue();

      const client = Bun.spawn(["bun", "run", driver], {
        env: {
          ...process.env,
          PBOSS_HOME: home,
          PBOSS_SRC: join(ROOT, "src"),
          APP_SCRIPT: appScript,
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });

      const [out, err] = await Promise.all([
        new Response(client.stdout).text(),
        new Response(client.stderr).text(),
      ]);
      const clientExit = await client.exited;

      // The daemon must be gone (the raw kill request stopped it) and
      // must not have crashed on its own.
      const daemonExit = await daemon.exited;

      const line = out.split("\n").find((l) => l.startsWith("E2E_RESULT:"));
      if (!line) {
        throw new Error(
          `client driver produced no result (exit ${clientExit}, daemon exit ${daemonExit})\n` +
            `stdout: ${out.slice(0, 2000)}\nstderr: ${err.slice(0, 2000)}`
        );
      }
      const report = JSON.parse(line.slice("E2E_RESULT:".length));

      // Acceptance #2: two separate clients, both receive the restart.
      expect(report.bothConnected).toBe(true);
      expect(report.aStart).toBe(true);
      expect(report.bStart).toBe(true);
      expect(report.aRestartCount).toBe(1);
      expect(report.bRestartCount).toBe(1);
      expect(report.restartSource).toBe("user");

      // Acceptance #3: autonomous crash seen by the client that made no call.
      expect(report.bCrashed).toBe(true);
      expect(report.bCrashRestart).toBe(true);

      // Acceptance #6: daemon death ends the stream cleanly, no dangling.
      expect(report.aDisconnectedOnKill).toBe(true);
      expect(report.aStreamCleaned).toBe(true);
      expect(clientExit).toBe(0);
      expect(daemonExit).toBe(0);
    },
    120_000
  );
});
