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
 *   6. a valid every-minute expression REALLY FIRES at the next minute
 *      boundary (the real setTimeout, the real clock — no fakes), and the
 *      chain re-arms after firing so cancel() is the only stop.
 *
 * The fire test pays the honest minute-boundary price (up to 60s of wall
 * clock) once; everything else is instant.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CronManager } from "../src/cron-manager";

const REPO = join(import.meta.dir, "..");

const scratchTimers: ReturnType<typeof setTimeout>[] = [];
afterAll(() => {
  for (const t of scratchTimers) clearTimeout(t);
});

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

describe("CronManager — the fire itself (real clock, no fakes)", () => {
  test(
    "an every-minute expression FIRES at the next minute boundary, and the chain re-arms until cancel()",
    async () => {
      const cm = new CronManager();
      let fired = 0;

      cm.schedule(11, "* * * * *", () => { fired++; });

      // The delay is next-minute-boundary minus now — at most 60s away.
      // Poll for the fire with the honest cap.
      const deadline = Date.now() + 70_000;
      while (fired === 0 && Date.now() < deadline) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 250);
          scratchTimers.push(t);
        });
      }
      expect(fired).toBe(1);

      // After firing, the chain has re-armed the NEXT occurrence — the
      // listing proves a live timer exists again…
      expect(cm.listJobs()).toEqual([{ processId: 11, expression: "* * * * *" }]);
      // …and cancel() is what tears it down (the only stop).
      cm.cancel(11);
      expect(cm.listJobs()).toEqual([]);
    },
    75_000,
  );
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
