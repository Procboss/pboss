import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "node:path";

// Isolate PBOSS_HOME BEFORE the modules under test are imported, so
// CRON_FILE / CRON_LOG_DIR land inside a throwaway directory.
const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-cronjobs-${Date.now()}`));
process.env.PBOSS_HOME = TEST_HOME;

const cronJobsModule = await import("../src/cron-jobs");
const CronJobManager = cronJobsModule.CronJobManager;
type CronJobManagerInstance = InstanceType<typeof CronJobManager>;
const { CRON_FILE, CRON_LOG_DIR } = await import("../src/constants");

afterAll(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

function freshManager(): CronJobManagerInstance {
  return new CronJobManager();
}

describe("CronJobManager — add / persist / list", () => {
  test("add() creates a recurring job with a computed nextRun and persists it", async () => {
    const mgr = freshManager();
    const job = await mgr.add({ schedule: "everyday@23:30", command: "echo nightly" });

    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe("echo-nightly"); // slug of the full command
    expect(job.cron).toBe("30 23 * * *");
    expect(job.oneShot).toBe(false);
    expect(job.nextRun).toBeGreaterThan(Date.now());
    expect(new Date(job.nextRun!).getHours()).toBe(23);
    expect(new Date(job.nextRun!).getMinutes()).toBe(30);

    // persisted
    expect(existsSync(CRON_FILE)).toBe(true);
    const saved = JSON.parse(readFileSync(CRON_FILE, "utf-8"));
    expect(Array.isArray(saved)).toBe(true);
    expect(saved[0].name).toBe("echo-nightly");
    expect(saved[0].command).toBe("echo nightly");
  });

  test("duplicate commands get suffixed names (echo, echo-2)", async () => {
    const mgr = freshManager();
    await mgr.add({ schedule: "everyday@1", command: "echo one" });
    const second = await mgr.add({ schedule: "everyday@2", command: "echo one" });
    expect(second.name).toBe("echo-one-2");
  });

  test("explicit --name is honored", async () => {
    const mgr = freshManager();
    const job = await mgr.add({ schedule: "every-sunday@10:10", command: "sh cleanup.sh", name: "cleanup" });
    expect(job.name).toBe("cleanup");
    expect(job.cron).toBe("10 10 * * 0");
  });

  test("invalid schedule throws a helpful error", async () => {
    const mgr = freshManager();
    await expect(mgr.add({ schedule: "whenever", command: "echo hi" })).rejects.toThrow(/Unknown schedule/i);
  });

  test("one-shot job carries an absolute timestamp", async () => {
    const mgr = freshManager();
    const future = new Date();
    future.setDate(future.getDate() + 1);
    const p = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${p(future.getDate())}-${p(future.getMonth() + 1)}-${future.getFullYear()}`;
    const job = await mgr.add({ schedule: `onDate@${dateStr}-23:10`, command: "node migrate.js" });
    expect(job.oneShot).toBe(true);
    expect(job.at!).toBeGreaterThan(Date.now());
    expect(job.nextRun).toBe(job.at ?? null);
  });
});

describe("CronJobManager — remove / next", () => {
  test("remove by name and by id", async () => {
    const mgr = freshManager();
    const a = await mgr.add({ schedule: "everyday@1", command: "echo a", name: "alpha" });
    const b = await mgr.add({ schedule: "everyday@2", command: "echo b", name: "beta" });
    expect(mgr.list()).toHaveLength(2);

    // remove by id first
    const removedById = await mgr.remove(String(b.id));
    expect(removedById?.id).toBe(b.id);
    expect(mgr.list()).toHaveLength(1);

    const removed = await mgr.remove("alpha");
    expect(removed?.name).toBe("alpha");
    expect(removed?.id).toBe(a.id);
    expect(mgr.list()).toHaveLength(0);
    expect(await mgr.remove("nonexistent")).toBeNull();
  });

  test("next() previews upcoming runs", async () => {
    const mgr = freshManager();
    await mgr.add({ schedule: "0 3 * * *", command: "echo daily", name: "daily" });
    const times = mgr.next("daily", 4);
    expect(times).toHaveLength(4);
    expect(times[0]!).toBeGreaterThan(Date.now());
    // strictly increasing
    expect(times[1]!).toBeGreaterThan(times[0]!);
    // all at 03:00
    for (const t of times) {
      expect(new Date(t).getHours()).toBe(3);
      expect(new Date(t).getMinutes()).toBe(0);
    }
  });
});

describe("CronJobManager — execution", () => {
  test("trigger() runs the command and captures the exit code + log", async () => {
    const mgr = freshManager();
    await mgr.add({ schedule: "everyday@3", command: "echo pboss-cron-test", name: "sayer" });

    const job = await mgr.trigger("sayer");
    expect(job.runCount).toBe(1);
    expect(job.lastExitCode).toBe(0);
    expect(job.lastError).toBeNull();

    const logPath = join(CRON_LOG_DIR, "sayer.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("pboss-cron-test");
    expect(log).toContain("▶ pboss cron \"sayer\"");
    expect(log).toContain("exit code 0");
  });

  test("trigger() records a failing exit code", async () => {
    const mgr = freshManager();
    await mgr.add({ schedule: "everyday@3", command: "exit 42", name: "failer" });
    const job = await mgr.trigger("failer");
    expect(job.lastExitCode).toBe(42);
  });

  test("wake() fires due jobs within the late window and advances the schedule", async () => {
    const mgr = freshManager();
    const job = await mgr.add({ schedule: "0 4 * * *", command: "echo due", name: "duejob" });

    // Simulate the scheduled moment arriving (5 seconds ago, well inside the
    // 120s late window) by nudging nextRun into the recent past.
    job.nextRun = Date.now() - 5_000;

    await (mgr as any).wake();

    expect(job.runCount).toBe(1);
    expect(job.lastExitCode).toBe(0);
    // rescheduled to the next future 04:00
    expect(job.nextRun).toBeGreaterThan(Date.now());
    expect(new Date(job.nextRun!).getHours()).toBe(4);
  });

  test("wake() skips jobs that missed while the daemon was down (beyond late window)", async () => {
    const mgr = freshManager();
    const job = await mgr.add({ schedule: "0 4 * * *", command: "echo missed", name: "missedjob" });

    // nextRun is 10 minutes in the past — beyond the late window.
    job.nextRun = Date.now() - 10 * 60_000;

    await (mgr as any).wake();

    expect(job.runCount).toBe(0);
    expect(job.nextRun).toBeGreaterThan(Date.now());
  });

  test("one-shot job completes after firing", async () => {
    const mgr = freshManager();
    const job = await mgr.add({ schedule: "everyday@3", command: "echo once", name: "oneshot" });
    // turn it into a due one-shot
    job.oneShot = true;
    job.at = Date.now() - 3_000;
    job.nextRun = job.at;

    await (mgr as any).wake();

    expect(job.runCount).toBe(1);
    expect(job.state).toBe("completed");
    expect(job.nextRun).toBeNull();
    expect(mgr.next("oneshot", 3)).toHaveLength(0);
  });
});

describe("CronJobManager — restart recovery", () => {
  test("start() marks stale one-shots as missed and refreshes recurring nextRuns", async () => {
    const now = Date.now();
    const staleOneShot = {
      id: 1, name: "stale", schedule: "onDate@1-1-2020-10:00", command: "echo stale",
      cwd: TEST_HOME, at: now - 60 * 60_000, oneShot: true, description: "once",
      enabled: true, state: "scheduled", createdAt: now, nextRun: now - 60 * 60_000,
      lastRun: null, lastExitCode: null, runCount: 0,
    };
    const staleRecurring = {
      id: 2, name: "rec", schedule: "0 4 * * *", command: "echo rec", cron: "0 4 * * *",
      cwd: TEST_HOME, oneShot: false, description: "cron: 0 4 * * *",
      enabled: true, state: "scheduled", createdAt: now, nextRun: now - 30 * 60_000,
      lastRun: null, lastExitCode: null, runCount: 0,
    };
    writeFileSync(CRON_FILE, JSON.stringify([staleOneShot, staleRecurring], null, 2));

    const mgr = freshManager();
    await mgr.start();

    const one = mgr.list().find((j) => j.name === "stale")!;
    expect(one.state).toBe("completed");
    expect(one.lastError).toMatch(/missed/i);
    expect(one.nextRun).toBeNull();

    const rec = mgr.list().find((j) => j.name === "rec")!;
    expect(rec.runCount).toBe(0); // did NOT fire
    expect(rec.nextRun).toBeGreaterThan(Date.now());
    expect(new Date(rec.nextRun!).getHours()).toBe(4);

    mgr.stop();
  });
});

describe("CronJobManager — ecosystem sync", () => {
  test("syncFromConfig adds new jobs and updates changed ones in place", async () => {
    const mgr = freshManager();
    const res1 = await mgr.syncFromConfig([
      { schedule: "everyday@9:11", command: "bun backup.ts", name: "backup" },
      { schedule: "every-sunday@10:10", command: "sh cleanup.sh", name: "cleanup" },
    ]);
    expect(res1.added).toBe(2);
    expect(res1.updated).toBe(0);
    expect(mgr.list()).toHaveLength(2);

    // Same names, one changed schedule → update, not duplicate
    const res2 = await mgr.syncFromConfig([
      { schedule: "everyday@10:11", command: "bun backup.ts", name: "backup" },
      { schedule: "every-sunday@10:10", command: "sh cleanup.sh", name: "cleanup" },
    ]);
    expect(res2.added).toBe(0);
    expect(res2.updated).toBe(1);
    expect(mgr.list()).toHaveLength(2);

    const backup = mgr.list().find((j) => j.name === "backup")!;
    expect(backup.schedule).toBe("everyday@10:11");
    expect(backup.cron).toBe("11 10 * * *");
  });

  test("syncFromConfig validates entries", async () => {
    const mgr = freshManager();
    await expect(
      mgr.syncFromConfig([{ command: "echo no-schedule" }] as any)
    ).rejects.toThrow(/schedule/i);
  });
});
