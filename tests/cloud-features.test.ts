/**
 * Cloud feature tests — the agent-side additions to the wire surface:
 *
 *   - classifyCrash (crash-reason enrichment)
 *   - health-check status → CloudProcessReport + health.failing/recovered
 *   - execOneOff (process.exec primitive: output, timeout, caps)
 *   - searchLogFiles (log.search across live + rotated + gzipped)
 *   - new CloudCommand handlers (env.get/set, cron.*, namespace.*,
 *     process.scale, log.search, config.alerts.*) via executeCommand
 *   - the issuedBy audit passthrough (command → result echo)
 *   - CronJobManager setEnabled + onJobResult → reportCronOutcome events
 *   - reportState wiring: threshold events land in the outbox exactly once
 *   - a real-binary CLI e2e for `pboss alerts show/set/test`
 */

import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-cloudfeat-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;

// BOUND constants (shared bun test process — first import wins)
const { ALERT_THRESHOLDS_FILE } = await import("../src/constants");
const cloud = await import("../src/cloud");
const { CloudAgent, mapProcessState, diffEvents, classifyCrash, execOneOff } = cloud;
const { searchLogFiles } = await import("../src/log-manager");
const { CronJobManager } = await import("../src/cron-jobs");
const { DEFAULT_THRESHOLD_CONFIG, ThresholdMonitor } = await import("../src/threshold-monitor");
const { loadThresholdConfig } = await import("../src/threshold-monitor");
import type { ProcessState, CronJob } from "../src/types";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  // only OUR files in the BOUND home — never the whole shared home
  for (const f of [ALERT_THRESHOLDS_FILE, join(TEST_HOME, "env-registry.json"), join(TEST_HOME, "cron.json")]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
  if ((globalThis as unknown as { __cloudfeatHome?: string }).__cloudfeatHome !== TEST_HOME) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

// expose for cleanup logic (the bound home may differ from TEST_HOME)
(globalThis as unknown as { __cloudfeatHome?: string }).__cloudfeatHome = TEST_HOME;
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pboss-cf-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/* ── crash classification ─────────────────────────────────────────────── */

describe("classifyCrash", () => {
  test("SIGKILL and exit 137 both tag likely OOM", () => {
    expect(classifyCrash(null, "SIGKILL")).toBe("likely OOM");
    expect(classifyCrash(137, null)).toBe("likely OOM");
    expect(classifyCrash(-137, null)).toBe("likely OOM");
  });

  test("non-zero exit with no signal → uncaught exception", () => {
    expect(classifyCrash(1, null)).toBe("uncaught exception");
    expect(classifyCrash(3, undefined)).toBe("uncaught exception");
  });

  test("SIGTERM and clean exits carry no guess", () => {
    expect(classifyCrash(0, null)).toBeUndefined();
    expect(classifyCrash(1, "SIGTERM")).toBeUndefined();
    expect(classifyCrash(null, null)).toBeUndefined();
  });
});

/* ── health status → cloud ────────────────────────────────────────────── */

describe("health-check status in reports and events", () => {
  const state = (name = "api") =>
    ({
      id: 1,
      name,
      status: "online",
      pm_id: 0,
      monit: { cpu: 5, memory: 10 * 1024 * 1024 },
      pboss_env: { script: "s.ts", restart_time: 0, unstable_restarts: 0, pm_uptime: Date.now() },
    }) as unknown as ProcessState;

  test("mapProcessState carries healthStatus + healthFails when given", () => {
    const r = mapProcessState(state(), { status: "unhealthy", consecutiveFails: 3 });
    expect(r.healthStatus).toBe("unhealthy");
    expect(r.healthFails).toBe(3);
    // absent when the process has no healthCheckUrl
    const bare = mapProcessState(state());
    expect(bare.healthStatus).toBeUndefined();
    expect(bare.healthFails).toBeUndefined();
  });

  const rep = (health?: string, fails?: number) => ({
    name: "api",
    script: "s.ts",
    pmId: 0,
    status: "online" as const,
    cpu: 0,
    mem: 10,
    restarts: 0,
    crashes: 0,
    uptimeSec: 5,
    healthStatus: health as "healthy" | "unhealthy" | "unknown" | undefined,
    healthFails: fails,
  });

  test("diffEvents: healthy → unhealthy fires health.failing with the fail count", () => {
    const prev = new Map([["api", rep("healthy", 0)]]);
    const evs = diffEvents(prev, [rep("unhealthy", 3)]);
    const failing = evs.find((e) => e.kind === "health.failing");
    expect(failing).toBeDefined();
    expect(failing!.process).toBe("api");
    expect(failing!.detail).toContain("3 consecutive");
    expect(failing!.metricValue).toBe(3);
  });

  test("diffEvents: unhealthy → healthy fires health.recovered", () => {
    const prev = new Map([["api", rep("unhealthy", 4)]]);
    const evs = diffEvents(prev, [rep("healthy", 0)]);
    expect(evs.some((e) => e.kind === "health.recovered")).toBe(true);
  });

  test("unknown never fires an event (nothing to say before the first check)", () => {
    const prev = new Map([["api", rep("unknown", 0)]]);
    expect(diffEvents(prev, [rep("unhealthy", 1)]).length).toBe(0);
    const prev2 = new Map([["api", rep(undefined)]]);
    expect(diffEvents(prev2, [rep("healthy", 0)]).length).toBe(0);
  });
});

/* ── one-off exec (process.exec) ───────────────────────────────────────── */

describe("execOneOff", () => {
  test("captures stdout/stderr and the exit code", async () => {
    const dir = scratch("exec");
    const r = await execOneOff("echo hello; echo oops 1>&2", { cwd: dir, timeoutSec: 10 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.stderr.trim()).toBe("oops");
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("hard timeout kills a stuck command and says so", async () => {
    const dir = scratch("exec-timeout");
    const r = await execOneOff("sleep 30", { cwd: dir, timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  test("a failing command reports its exit code", async () => {
    const dir = scratch("exec-fail");
    const r = await execOneOff("exit 42", { cwd: dir, timeoutSec: 5 });
    expect(r.exitCode).toBe(42);
  });

  test("huge output is capped, not ballooned", async () => {
    const dir = scratch("exec-cap");
    const r = await execOneOff("yes 0123456789 | head -c 5242880", { cwd: dir, timeoutSec: 10 });
    expect(r.stdout.length).toBeLessThanOrEqual(256 * 1024 + 64); // cap + decoder slack
    expect(r.truncated).toBe(true);
  }, 20_000);
});

/* ── log search (log.search) ──────────────────────────────────────────── */

describe("searchLogFiles", () => {
  function writeLog(dir: string, name: string, lines: string[]): string {
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }
  const line = (ts: string, msg: string) => JSON.stringify({ ts, msg });

  test("matches across the live file, rotations and gzip; range filters", async () => {
    const dir = scratch("logsearch");
    const live = writeLog(dir, "api-0-out.log", [
      line("2026-09-14T10:00:00Z", "boot ok"),
      line("2026-09-14T10:01:00Z", "ERROR payment failed code=X17"),
      line("2026-09-14T10:02:00Z", "request served"),
    ]);
    writeLog(dir, "api-0-out.log.1", [
      line("2026-09-08T09:00:00Z", "ERROR payment failed code=X99"),
      line("2026-09-08T09:05:00Z", "healthy"),
    ]);
    // a gzipped rotation
    const gzRaw = [
      line("2026-09-01T08:00:00Z", "ERROR payment failed code=X01"),
      line("2026-09-01T08:05:00Z", "noise"),
    ].join("\n") + "\n";
    writeFileSync(join(dir, "api-0-out.log.2.gz"), Bun.gzipSync(new TextEncoder().encode(gzRaw)));

    // everything, newest file first
    let res = await searchLogFiles([live], "payment failed", { maxResults: 10 });
    expect(res.matches.length).toBe(3);
    expect(res.scannedFiles).toEqual(["api-0-out.log", "api-0-out.log.1", "api-0-out.log.2.gz"]);
    expect(res.matches[0]!.line).toContain("X17"); // live file first
    expect(res.matches[2]!.line).toContain("X01"); // oldest last

    // time range: only Sept 14
    res = await searchLogFiles([live], "payment failed", {
      from: Date.parse("2026-09-14T00:00:00Z"),
    });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0]!.line).toContain("X17");
    // to: only the old ones
    res = await searchLogFiles([live], "payment failed", {
      to: Date.parse("2026-09-02T00:00:00Z"),
    });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0]!.line).toContain("X01");

    // maxResults truncates honestly
    res = await searchLogFiles([live], "ERROR", { maxResults: 1 });
    expect(res.matches.length).toBe(1);
    expect(res.truncated).toBe(true);
  });

  test("an invalid regex degrades to a literal match, never throws", async () => {
    const dir = scratch("logsearch-regex");
    const live = writeLog(dir, "api-0-error.log", [line("2026-09-14T10:00:00Z", "bad (thing) happened")]);
    // "(oops[" is an invalid regex — the fallback escapes it instead of throwing
    const res = await searchLogFiles([live], "(oops[", { maxResults: 5 });
    expect(res.matches.length).toBe(0);
    // "bad (thing" is ALSO invalid (unbalanced paren) — escaped, it matches literally
    const res2 = await searchLogFiles([live], "bad (thing", { maxResults: 5 });
    expect(res2.matches.length).toBe(1);
  });

  test("pre-JSON log lines ([ISO] msg) still match and filter by time", async () => {
    const dir = scratch("logsearch-old");
    const live = writeLog(dir, "api-0-out.log", [
      "[2026-09-14T09:59:00.000Z] legacy ERROR boom",
      "[2026-09-14T10:00:00.000Z] legacy ok",
    ]);
    const res = await searchLogFiles([live], "boom", { from: Date.parse("2026-09-14T09:30:00Z") });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0]!.ts).toBe(Date.parse("2026-09-14T09:59:00.000Z"));
  });
});

/* ── CloudAgent command surface (executeCommand, private → as any) ────── */

describe("CloudAgent — new cloud commands", () => {
  type AgentT = InstanceType<typeof CloudAgent>;
  type CronT = InstanceType<typeof CronJobManager>;
  function makeAgent(pm: unknown, cron?: CronT): AgentT {
    return new CloudAgent(pm as never, {
      cronJobManager: cron,
      thresholdMonitor: new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG),
    });
  }

  function withRecordingPm(over: Record<string, unknown> = {}) {
    const calls: Record<string, unknown[]> = {};
    const record = (name: string) => (...args: unknown[]) => {
      calls[name] = args;
      return over[name] ?? [];
    };
    const state = (name = "api") =>
      ({
        id: 1,
        name,
        status: "online",
        pm_id: 0,
        pid: 123,
        monit: { cpu: 5, memory: 10 * 1024 * 1024 },
        pboss_env: {
          script: "s.ts",
          cwd: "/tmp",
          env: { TOKEN: "x" },
          restart_time: 0,
          unstable_restarts: 0,
          pm_uptime: Date.now(),
        },
      }) as unknown as ProcessState;
    const pm = {
      list: () => [state()],
      getLogs: async () => [],
      watchProcessLogs: () => undefined,
      healthChecker: { getStatus: () => null },
      getMetricsHistory: () => [],
      restart: record("restart"),
      stop: record("stop"),
      startTarget: record("startTarget"),
      scale: record("scale"),
      searchProcessLogs: async (name: string, query: string) => ({
        matches: [{ file: `${name}-out.log`, ts: null, line: query, level: "out" as const }],
        scannedFiles: [`${name}-out.log`],
        truncated: false,
      }),
      ...Object.fromEntries(
        Object.entries(over).map(([k, v]) => [k, typeof v === "function" ? v : () => v])
      ),
    };
    return { pm, calls, state };
  }

  const run = (agent: AgentT, type: string, payload: Record<string, unknown>) =>
    (agent as unknown as { executeCommand(c: { id: string; type: string; payload: Record<string, unknown> }): Promise<unknown> }).executeCommand({
      id: "cmd_test",
      type,
      payload,
    });

  afterEach(() => {
    try { if (existsSync(join(TEST_HOME, "env-registry.json"))) unlinkSync(join(TEST_HOME, "env-registry.json")); } catch {}
  });

  test("env.get returns KEYS ONLY by default (values redacted)", async () => {
    const { pm } = withRecordingPm();
    // seed the registry through the real EnvManager path (env.set)
    const agent = makeAgent(pm);
    await run(agent, "env.set", { process: "api", vars: { SECRET: "hunter2", PORT: "8080" } });
    const res = (await run(agent, "env.get", { process: "api" })) as {
      process: string;
      vars: Record<string, string>;
    };
    expect(res.vars.SECRET).toBe("••••");
    expect(res.vars.PORT).toBe("••••");
    // explicit opt-in reveals them (the dashboard's edit flow)
    const resValues = (await run(agent, "env.get", { process: "api", values: true })) as {
      vars: Record<string, string>;
    };
    expect(resValues.vars.SECRET).toBe("hunter2");
  });

  test("env.set writes through EnvManager and restarts only when asked", async () => {
    const { pm, calls } = withRecordingPm();
    const agent = makeAgent(pm);
    const res = (await run(agent, "env.set", {
      process: "api",
      vars: { NEW_KEY: "v" },
      restart: true,
    })) as { written: number; restarted: boolean };
    expect(res.written).toBe(1);
    expect(res.restarted).toBe(true);
    expect(calls.restart?.[0]).toBe("api");

    const { calls: calls2 } = withRecordingPm();
    const agent2 = makeAgent(calls2 ? pm : pm); // same shape; restart recorded per-agent pm
    const res2 = (await run(agent2, "env.set", { process: "api", vars: { K2: "v" } })) as {
      restarted: boolean;
    };
    expect(res2.restarted).toBe(false);

    // invalid key names are refused before anything is written
    await expect(
      run(agent, "env.set", { process: "api", vars: { "bad-key!": "x" } })
    ).rejects.toThrow(/not a valid env key/);
  });

  test("cron.list / cron.run / cron.enable / cron.disable against the real manager", async () => {
    const mgr = new CronJobManager();
    const job = await mgr.add({ schedule: "everyday@3", command: "echo hi" });
    const { pm } = withRecordingPm();
    const agent = makeAgent(pm, mgr);

    const list = (await run(agent, "cron.list", {})) as { jobs: CronJob[] };
    expect(list.jobs.length).toBe(1);
    expect(list.jobs[0]!.name).toBe(job.name);

    // disable: keeps the definition, never fires
    const disabled = (await run(agent, "cron.disable", { target: job.name })) as CronJob;
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRun).toBeNull();

    const enabled = (await run(agent, "cron.enable", { target: job.name })) as CronJob;
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRun).not.toBeNull();

    // run now (out of schedule) — the manager executes it
    const ran = (await run(agent, "cron.run", { target: job.name })) as CronJob;
    expect(ran.runCount).toBe(1);
    expect(ran.lastExitCode).toBe(0);
  });

  test("cron commands fail honestly without a cron manager", async () => {
    const { pm } = withRecordingPm();
    const agent = makeAgent(pm); // no cronJobManager
    await expect(run(agent, "cron.list", {})).rejects.toThrow(/not available/);
  });

  test("namespace.start/stop/restart route to the process manager", async () => {
    const { pm, calls } = withRecordingPm();
    const agent = makeAgent(pm);
    await run(agent, "namespace.restart", { namespace: "shop" });
    expect(calls.restart?.[0]).toBe("shop");
    await run(agent, "namespace.stop", { namespace: "shop" });
    expect(calls.stop?.[0]).toBe("shop");
    await run(agent, "namespace.start", { namespace: "shop" });
    expect(calls.startTarget?.[0]).toBe("shop");
    // missing namespace → honest error
    await expect(run(agent, "namespace.stop", {})).rejects.toThrow(/requires a namespace/);
  });

  test("process.scale validates and routes", async () => {
    const { pm, calls } = withRecordingPm();
    const agent = makeAgent(pm);
    await run(agent, "process.scale", { target: "api", instances: 4 });
    expect(calls.scale).toEqual(["api", 4]);
    await expect(run(agent, "process.scale", { target: "api", instances: 0 })).rejects.toThrow(/instances/);
    await expect(run(agent, "process.scale", { target: "api", instances: 999 })).rejects.toThrow(/instances/);
  });

  test("process.exec runs in the process's cwd with its env", async () => {
    const dir = scratch("execcmd");
    const { pm, state } = withRecordingPm();
    const s = state();
    s.pboss_env!.cwd = dir;
    (pm as unknown as { list(): unknown[] }).list = () => [s];
    const agent = makeAgent(pm);
    const res = (await run(agent, "process.exec", {
      target: "api",
      command: "echo $TOKEN",
      timeoutSec: 5,
    })) as { stdout: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("x"); // TOKEN from the process env
  });

  test("log.search delegates to the manager and passes the range", async () => {
    const { pm } = withRecordingPm();
    const agent = makeAgent(pm);
    const res = (await run(agent, "log.search", {
      target: "api",
      query: "boom",
      from: 123,
      to: 456,
      maxResults: 50,
    })) as { matches: unknown[]; scannedFiles: string[] };
    expect(res.matches.length).toBe(1);
    expect(res.scannedFiles[0]).toBe("api-out.log");
    await expect(run(agent, "log.search", { target: "api" })).rejects.toThrow(/requires a query/);
  });

  test("config.alerts.get/set — the cloud writes the same shape the CLI does", async () => {
    const { pm } = withRecordingPm();
    const agent = makeAgent(pm);
    const before = (await run(agent, "config.alerts.get", {})) as {
      system: { cpuPercent: { trigger: number } };
      effective: unknown[];
    };
    expect(before.system.cpuPercent.trigger).toBe(85); // built-in default
    expect(before.effective.length).toBe(1); // the one stub process

    const after = (await run(agent, "config.alerts.set", {
      target: "system",
      patch: { cpuPercent: { trigger: 70 } },
    })) as { system: { cpuPercent: { trigger: number } } };
    expect(after.system.cpuPercent.trigger).toBe(70);
    // persisted (the file survives the in-memory agent)
    expect(existsSync(ALERT_THRESHOLDS_FILE)).toBe(true);
    expect(loadThresholdConfig(ALERT_THRESHOLDS_FILE).system.cpuPercent.trigger).toBe(70);
  });
});

/* ── issuedBy passthrough (audit correlation) ─────────────────────────── */

describe("issuedBy audit passthrough", () => {
  test("the agent echoes the cloud-stamped identity on the command result", async () => {
    const pm = {
      list: () => [],
      getLogs: async () => [],
      watchProcessLogs: () => undefined,
      healthChecker: { getStatus: () => null },
      getMetricsHistory: () => [],
    } as unknown as never;
    const agent = new CloudAgent(pm, {
      thresholdMonitor: new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG),
    });
    const sent: Array<Record<string, unknown>> = [];
    (agent as unknown as { sendFrame(f: unknown): boolean }).sendFrame = (f: unknown) => {
      sent.push(f as Record<string, unknown>);
      return true;
    };
    await (agent as unknown as {
      handleCommand(c: unknown): Promise<void>;
    }).handleCommand({
      id: "cmd_audit",
      type: "process.list",
      payload: {},
      issuedBy: "user_abc",
    } as never);
    const frame = sent.find((f) => f.type === "command-result") as unknown as {
      result: { commandId: string; success: boolean; issuedBy?: string };
    };
    expect(frame).toBeDefined();
    expect(frame.result.commandId).toBe("cmd_audit");
    expect(frame.result.success).toBe(true);
    expect(frame.result.issuedBy).toBe("user_abc"); // echoed unmodified
  });
});

/* ── cron outcomes → cloud events ─────────────────────────────────────── */

describe("cron outcomes become cloud events", () => {
  test("failed runs push cron.failed; one-shot completions push cron.completed; recurring success is silent", async () => {
    const pm = {
      list: () => [],
      getLogs: async () => [],
      watchProcessLogs: () => undefined,
      healthChecker: { getStatus: () => null },
      getMetricsHistory: () => [],
    } as unknown as never;
    const agent = new CloudAgent(pm, {
      thresholdMonitor: new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG),
    });
    // the agent must be "running" for outcomes to enqueue — start() with a
    // refused transport still sets running=true before bailing on the link
    (agent as unknown as { running: boolean }).running = true;

    const failedJob = { name: "backup", schedule: "everyday@3", oneShot: false, lastError: null } as CronJob;
    agent.reportCronOutcome(failedJob, 2);
    const completed = { name: "migrate", schedule: "today@23:00", oneShot: true, lastError: null } as CronJob;
    agent.reportCronOutcome(completed, 0);
    const recurringOk = { name: "ping", schedule: "every-30-seconds", oneShot: false, lastError: null } as CronJob;
    agent.reportCronOutcome(recurringOk, 0);

    const outbox = (agent as unknown as { outbox: { kind: string; process: string; exitCode?: number | null; detail?: string }[] }).outbox;
    expect(outbox.map((e) => e.kind)).toEqual(["cron.failed", "cron.completed"]);
    expect(outbox[0]!.detail ?? "").toContain("backup");
    expect(outbox[0]!.exitCode).toBe(2);
    expect(outbox[1]!.process).toBe("migrate");
  });

  test("CronJobManager.onJobResult fires with the job and exit code", async () => {
    const seen: Array<[string, number | null]> = [];
    const mgr = new CronJobManager();
    mgr.onJobResult = (job, code) => seen.push([job.name, code]);
    await mgr.add({ schedule: "everyday@3", command: "exit 7" });
    const job = await mgr.trigger("exit-7");
    expect(job.lastExitCode).toBe(7);
    expect(seen).toEqual([["exit-7", 7]]);
  });
});

/* ── reportState wiring: threshold events reach the outbox once ───────── */

describe("reportState pushes threshold events through the outbox", () => {
  test("a CPU spike condition enqueues exactly one cpu.spike (no re-fire per tick)", async () => {
    const mkState = (cpu: number) =>
      ({
        id: 1,
        name: "api",
        status: "online",
        pm_id: 0,
        monit: { cpu, memory: 50 * 1024 * 1024 },
        pboss_env: {
          script: "s.ts",
          restart_time: 0,
          unstable_restarts: 0,
          pm_uptime: Date.now(),
        },
      }) as unknown as ProcessState;
    let cpu = 97;
    const pm = {
      list: () => [mkState(cpu)],
      getLogs: async () => [],
      watchProcessLogs: () => undefined,
      healthChecker: { getStatus: () => null },
      getMetricsHistory: () => [],
    } as unknown as never;
    const agent = new CloudAgent(pm, {
      thresholdMonitor: new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG),
    });
    // make reportState runnable without a link
    (agent as unknown as { running: boolean }).running = true;
    (agent as unknown as { cfg: unknown }).cfg = { serverId: "srv", cloudUrl: "http://127.0.0.1:1", serverSecret: "s" };

    const rs = () =>
      (agent as unknown as { reportState(): Promise<void> }).reportState();
    await rs(); // tick 1: watching
    await rs(); // tick 2 (real time — a few ms apart; sustained is 30s)
    // the monitor's streak only fires after 30s of REAL time between ticks
    // — simulate by rewinding the streak's clock:
    const streaks = (agent as unknown as { thresholds: { streaks: Map<string, { since: number }> } }).thresholds.streaks;
    const s = streaks.get("api\0cpuSpike");
    expect(s).toBeDefined();
    s!.since = Date.now() - 31_000; // 31s of sustained
    await rs();

    const outbox = (agent as unknown as { outbox: { kind: string }[] }).outbox;
    const spikes = outbox.filter((e) => e.kind === "cpu.spike");
    expect(spikes.length).toBe(1);
    // a further tick does not re-fire (still elevated, heartbeat is 10 min)
    await rs();
    expect(outbox.filter((e) => e.kind === "cpu.spike").length).toBe(1);
  });
});

/* ── real-binary CLI e2e — pboss alerts show/set/reset/test ───────────── */

describe("CLI e2e — pboss alerts (real daemon, real binary)", () => {
  const ROOT = import.meta.dir.replace("/tests", "");
  const CLI = join(ROOT, "src", "index.ts");

  function runCli(args: string[], home: string) {
    const proc = Bun.spawn(["bun", "run", CLI, ...args], {
      env: { ...process.env, PBOSS_HOME: home, PBOSS_CLOUD_URL: "http://127.0.0.1:19999" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      cwd: ROOT,
    });
    return Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited,
    ]).then(([out, err, code]) => ({ out, err, code }));
  }

  test("show renders defaults; set --system persists; reset clears; test fires one synthetic event", async () => {
    const home = mkdtempSync(join(tmpdir(), `pboss-alerts-e2e-${process.pid}-`));
    mkdirSync(join(home, "logs"), { recursive: true });
    scratchDirs.push(home);
    try {
      const show = await runCli(["alerts", "show"], home);
      expect(show.code).toBe(0);
      expect(show.out).toContain("Server-wide (system) thresholds");
      expect(show.out).toContain("cpu.spike");
      expect(show.out).toContain("Defaults (every process without overrides)");
      expect(show.out).toContain("(no processes running)");

      const set = await runCli(["alerts", "set", "--system", "--cpu", "70"], home);
      expect(set.code).toBe(0);
      expect(set.out).toContain("System thresholds updated");
      const file = join(home, "alert-thresholds.json");
      expect(existsSync(file)).toBe(true);
      const saved = JSON.parse((await Bun.file(file).text()) as string);
      expect(saved.system.cpuPercent.trigger).toBe(70);
      expect(saved.system.cpuPercent.clear).toBe(65); // untouched default

      // show reflects the new value (live from the daemon)
      const show2 = await runCli(["alerts", "show"], home);
      expect(show2.out).toContain("70%");

      // reset --system clears back to defaults
      const reset = await runCli(["alerts", "reset", "--system"], home);
      expect(reset.code).toBe(0);
      expect(reset.out).toContain("cleared (system)");
      const saved2 = JSON.parse((await Bun.file(file).text()) as string);
      expect(saved2.system.cpuPercent.trigger).toBe(85);

      // test: fires one synthetic event end-to-end (no link → queued, honestly)
      const testRun = await runCli(["alerts", "test", "api", "cpu"], home);
      expect(testRun.code).toBe(0);
      expect(testRun.out).toContain("Test alert queued");
      expect(testRun.out).toContain("cpu.spike");

      // an unknown kind fails honestly
      const bad = await runCli(["alerts", "test", "api", "nonsense"], home);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("unknown alert kind");
    } finally {
      try { rmSync(join(home, "daemon.sock"), { force: true }); } catch {}
    }
  }, 120_000);
});
