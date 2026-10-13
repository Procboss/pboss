/**
 * CronManager — the per-process `--cron-restart` engine (unit).
 *
 * The gap this closes (audit 2026-10-08): `--cron-restart` was only ever
 * asserted as a PARSED OPTION (process-manager tests pin `cronRestart`
 * landing in the config) — the engine that actually fires it (this class)
 * had no test at all, and neither did the process-container wiring.
 *
 * The contract under test:
 *   1. schedule() arms a job (listJobs is the observable state);
 *   2. re-scheduling the same process REPLACES its timer (schedule calls
 *      cancel first — one job per process, never a stack);
 *   3. cancel() clears the armed timer AND the listing;
 *   4. cancelAll() sweeps every job (the daemon's shutdown path);
 *   5. an expression parseCron rejects (wrong field count) is caught,
 *      logged, and NEVER arms — a bad --cron-restart cannot take the
 *      daemon down;
 *   6. a firing job re-arms its next occurrence inside the same timer
 *      callback — the chain never ends on its own, so cancel() is the
 *      only stop (pinned at the source level).
 *
 * The real-clock fire test that used to live here is gone (owner decision,
 * 2026-10-13): waiting for a minute boundary cost up to 60s of wall clock
 * and flaked on shared CI runners (the 2026-10-13 run failed it at the
 * 6.2s boundary mark). The fire chain is now pinned at the source level —
 * every test in this file is instant.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CronManager } from "../src/cron-manager";

const REPO = join(import.meta.dir, "..");

describe("CronManager — arming, replacement, cancellation", () => {
  test("schedule() arms one job per process id (listJobs is the truth)", () => {
    const cm = new CronManager();
    cm.schedule(7, "0 4 * * *", () => {});
    expect(cm.listJobs()).toEqual([{ processId: 7, expression: "0 4 * * *" }]);
  });

  test("re-scheduling the same process REPLACES the timer — never a stack", () => {
    const cm = new CronManager();
    cm.schedule(1, "0 4 * * *", () => {});
    cm.schedule(1, "30 5 * * 1", () => {});
    const jobs = cm.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.expression).toBe("30 5 * * 1"); // the NEW schedule won
  });

  test("cancel() clears the armed timer and the listing", () => {
    const cm = new CronManager();
    cm.schedule(3, "0 4 * * *", () => {});
    cm.cancel(3);
    expect(cm.listJobs()).toEqual([]);
    cm.cancel(3); // idempotent — no throw on an unknown id
  });

  test("cancelAll() sweeps every armed job (the daemon shutdown path)", () => {
    const cm = new CronManager();
    cm.schedule(1, "0 4 * * *", () => {});
    cm.schedule(2, "0 5 * * *", () => {});
    cm.schedule(9, "0 6 * * *", () => {});
    cm.cancelAll();
    expect(cm.listJobs()).toEqual([]);
  });

  test("an expression with the wrong field count is caught, logged, and NEVER arms", () => {
    const cm = new CronManager();
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      cm.schedule(4, "* * * *", () => {}); // 4 fields — parseCron rejects
    } finally {
      console.error = orig;
    }
    // The schedule error was reported, not thrown into the caller…
    expect(errors.length).toBe(1);
    // …and the job never armed.
    expect(cm.listJobs()).toEqual([]);
  });
});

describe("CronManager — the fire chain (source pins)", () => {
  test("a firing job re-arms its NEXT occurrence in the same timer callback", () => {
    const text = readFileSync(join(REPO, "src", "cron-manager.ts"), "utf8");
    // The timer body IS the fire contract: the user callback runs, then
    // the chain arms the next occurrence before returning to the event
    // loop — so a job never ends on its own, and cancel()/cancelAll()
    // are the only stops.
    expect(text).toContain("const timer = setTimeout(() => {");
    expect(text).toContain("callback();");
    expect(text).toContain("scheduleNext(); // Schedule the next occurrence");
  });

  test("a re-arm that computes a past delay never arms a negative timer", () => {
    const text = readFileSync(join(REPO, "src", "cron-manager.ts"), "utf8");
    // A late fire (loaded box) or a stepped clock can put nextDate behind
    // now: the guard pushes the retry a full minute out instead of arming
    // a timer that is already due (which would spin the chain hot).
    expect(text).toContain("if (delay < 0) {");
    expect(text).toContain("setTimeout(scheduleNext, 60000);");
  });
});

describe("CronManager — the process-container wiring (source pins)", () => {
  test("--cron-restart schedules restart(\"cron\") through THIS engine", () => {
    const text = readFileSync(join(REPO, "src", "process-container.ts"), "utf8");
    // The feature's one wiring: config.cronRestart → cronManager.schedule
    // → restart("cron") with the visible console line.
    expect(text).toContain("if (this.config.cronRestart) {");
    expect(text).toContain('this.cronManager.schedule(this.id, this.config.cronRestart, () => {');
    expect(text).toContain('this.restart("cron");');
    expect(text).toContain("Cron restart triggered for ${this.name}");
  });

  test("stop/teardown cancels the schedule — a stopped process never fires", () => {
    const text = readFileSync(join(REPO, "src", "process-container.ts"), "utf8");
    expect(text).toContain("this.cronManager.cancel(this.id);");
  });

  test("ProcessManager hands the SAME engine to every container (one map, cancelAll sweeps all)", () => {
    const text = readFileSync(join(REPO, "src", "process-manager.ts"), "utf8");
    expect(text).toContain("public cronManager: CronManager;");
    expect(text).toContain("this.cronManager = new CronManager();");
    expect(text).toContain("this.cronManager.cancelAll();");
  });
});
