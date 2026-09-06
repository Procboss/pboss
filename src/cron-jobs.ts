/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Standalone cron jobs — scheduled shell commands that run independently
 * of any managed process.
 *
 * Jobs are created with `pboss cron run <schedule> <command>` (or the
 * `crons` array in an ecosystem file), persisted in `~/.pboss/cron.json`,
 * and executed by the daemon's scheduler:
 *
 *   - Recurring jobs carry a 5-field cron expression — or a 6-field one
 *     when seconds matter (every-second → `* * * * * *`); next-run times
 *     are computed by the mature `cron-parser` library.
 *   - One-shot jobs (today@23:10, tomorrow@8:00, on-date@24-10-2026-23:10)
 *     carry an absolute timestamp and are marked completed after firing.
 *   - The scheduler sleeps until the earliest next run (setTimeout) with a
 *     periodic watchdog rescan, so firing is precise to ~250ms (second-level
 *     schedules included) and robust against clock adjustments.
 *   - Runs missed while the daemon was down are skipped (like classic
 *     cron); the job simply reschedules to its next future occurrence.
 *   - Output of every run is appended to ~/.pboss/logs/cron/<name>.log.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { mkdirSync, appendFileSync, openSync, closeSync, existsSync } from "node:fs";
import { join } from "path";
import { CRON_FILE, CRON_LOG_DIR, CRON_LATE_WINDOW_MS, CRON_WATCHDOG_INTERVAL_MS } from "./constants";
import { parseSchedule, nextCronRun, nextCronRuns } from "./cron-expr";
import type { CronJob, CronJobConfig } from "./types";

const TWO_SP = "  ";

/** Derive a filesystem-safe job name from a command string. */
function slugify(command: string): string {
  const slug = command
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|&;<>()$`'"]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
    .replace(/-+/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "");
  return slug || "job";
}

/** Timestamp prefix for log headers, ISO-ish local time. */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class CronJobManager {
  private jobs = new Map<number, CronJob>();
  private nextId = 1;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private runningIds = new Set<number>();

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Load persisted jobs and start the scheduler. */
  async start(): Promise<void> {
    await this.load();
    // Recompute next runs for recurring jobs (missed while the daemon was
    // down) so a stale nextRun from a previous session does not fire late.
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!job.enabled || job.state === "completed") continue;
      if (job.oneShot) {
        if (job.at !== undefined && job.at < now - CRON_LATE_WINDOW_MS) {
          job.state = "completed";
          job.nextRun = null;
          job.lastError = `missed — daemon was not running at ${stamp(job.at)}`;
        }
      } else if (job.cron) {
        job.nextRun = nextCronRun(job.cron);
      }
    }
    this.startWatchdog();
    this.scheduleWake();
    await this.save();
  }

  stop(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.wakeTimer = null;
    this.watchdog = null;
  }

  // ── persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!existsSync(CRON_FILE)) return;
    try {
      const data = JSON.parse(await Bun.file(CRON_FILE).text());
      if (!Array.isArray(data)) return;
      for (const raw of data) {
        const job = raw as CronJob;
        if (typeof job?.id !== "number" || typeof job?.command !== "string") continue;
        this.jobs.set(job.id, job);
        if (job.id >= this.nextId) this.nextId = job.id + 1;
      }
    } catch (err: any) {
      console.error(`[pboss] Failed to load ${CRON_FILE}: ${err?.message ?? err}`);
    }
  }

  async save(): Promise<void> {
    const arr = Array.from(this.jobs.values()).sort((a, b) => a.id - b.id);
    await Bun.write(CRON_FILE, JSON.stringify(arr, null, 2));
  }

  // ── public API (used by the daemon RPC) ──────────────────────────────────

  /** Register a new scheduled command. */
  async add(input: CronJobConfig): Promise<CronJob> {
    if (!input.command || typeof input.command !== "string") {
      throw new Error("cron job needs a command to run");
    }
    if (!input.schedule || typeof input.schedule !== "string") {
      throw new Error("cron job needs a schedule — e.g. everyday@9:11");
    }

    const parsed = parseSchedule(input.schedule);

    const job: CronJob = {
      id: this.nextId++,
      name: input.name?.trim() || this.uniqueName(slugify(input.command)),
      schedule: parsed.source,
      command: input.command,
      cwd: input.cwd || process.cwd(),
      cron: parsed.cron,
      at: parsed.at,
      oneShot: parsed.kind === "once",
      description: parsed.description,
      enabled: input.enabled !== false,
      state: "scheduled",
      createdAt: Date.now(),
      nextRun: null,
      lastRun: null,
      lastExitCode: null,
      lastError: null,
      runCount: 0,
    };

    this.recomputeNext(job);
    if (job.nextRun === null) {
      // Disabled from the start (enabled: false in an ecosystem file).
      job.state = job.enabled ? "scheduled" : "disabled";
    }

    this.jobs.set(job.id, job);
    await this.save();
    this.scheduleWake();
    return job;
  }

  /** Remove a job by numeric id or name. Returns the removed job or null. */
  async remove(target: string | number): Promise<CronJob | null> {
    const job = this.find(target);
    if (!job) return null;
    this.jobs.delete(job.id);
    await this.save();
    this.scheduleWake();
    return job;
  }

  /** All jobs, ordered by id. */
  list(): CronJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.id - b.id);
  }

  /** Preview the next `count` run times of a job. */
  next(target: string | number, count = 3): number[] {
    const job = this.find(target);
    if (!job) return [];
    if (job.oneShot) {
      return job.state === "completed" || job.at === undefined ? [] : [job.at];
    }
    if (!job.cron) return [];
    return nextCronRuns(job.cron, count);
  }

  /** Run a job immediately (does not advance its schedule). */
  async trigger(target: string | number): Promise<CronJob> {
    const job = this.find(target);
    if (!job) throw new Error(`No cron job found for "${target}" — see pboss cron list`);
    await this.execute(job);
    await this.save();
    return job;
  }

  /**
   * Upsert jobs from an ecosystem file's `crons` array. Matching is by name
   * (or the derived slug), so re-starting a config updates schedules in
   * place instead of duplicating jobs.
   */
  async syncFromConfig(crons: CronJobConfig[] | undefined): Promise<{ added: number; updated: number }> {
    let added = 0;
    let updated = 0;
    if (!Array.isArray(crons)) return { added, updated };

    for (const cfg of crons) {
      if (!cfg?.schedule || !cfg?.command) {
        throw new Error(
          'Every crons[] entry needs "schedule" and "command" — e.g. { schedule: "everyday@9:11", command: "bun backup.ts" }'
        );
      }
      const parsed = parseSchedule(cfg.schedule);
      const name = cfg.name?.trim() || slugify(cfg.command);
      const existing = this.list().find((j) => j.name === name);

      if (existing) {
        const changed =
          existing.schedule !== parsed.source || existing.command !== cfg.command;
        existing.schedule = parsed.source;
        existing.description = parsed.description;
        existing.command = cfg.command;
        existing.cwd = cfg.cwd || existing.cwd;
        existing.cron = parsed.cron;
        existing.at = parsed.at;
        existing.oneShot = parsed.kind === "once";
        if (cfg.enabled !== undefined) existing.enabled = cfg.enabled;
        existing.state = existing.enabled ? "scheduled" : "disabled";
        if (existing.oneShot && existing.at !== undefined && existing.at < Date.now()) {
          existing.state = "completed";
          existing.nextRun = null;
        } else {
          this.recomputeNext(existing);
        }
        if (changed) updated++;
      } else {
        await this.add({ ...cfg, name });
        added++;
      }
    }

    await this.save();
    this.scheduleWake();
    return { added, updated };
  }

  // ── scheduler ────────────────────────────────────────────────────────────

  /** Sleep until the earliest next run (plus a small precision buffer). */
  private scheduleWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;

    let earliest: number | null = null;
    for (const job of this.jobs.values()) {
      if (!job.enabled || job.nextRun == null) continue;
      if (earliest === null || job.nextRun < earliest) earliest = job.nextRun;
    }
    if (earliest === null) return;

    const delay = Math.max(0, earliest - Date.now() + 250);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.wake();
    }, delay);
    // Never hold the event loop open just for a scheduled job.
    if (typeof this.wakeTimer === "object" && this.wakeTimer && "unref" in this.wakeTimer) {
      (this.wakeTimer as any).unref();
    }
  }

  /**
   * Safety net: periodically re-arm the wake timer (guards against clock
   * jumps, DST transitions, and jobs added by other code paths).
   */
  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      this.scheduleWake();
    }, CRON_WATCHDOG_INTERVAL_MS);
    if (typeof this.watchdog === "object" && this.watchdog && "unref" in this.watchdog) {
      (this.watchdog as any).unref();
    }
  }

  /** Fire every job whose time has come. */
  private async wake(): Promise<void> {
    const now = Date.now();
    const due: Array<Promise<void>> = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled || job.nextRun == null) continue;
      if (job.nextRun > now) continue;
      if (this.runningIds.has(job.id)) continue;

      const late = now - job.nextRun;
      if (late > CRON_LATE_WINDOW_MS) {
        // Missed while the daemon was asleep — skip, reschedule forward.
        this.recomputeNext(job);
        continue;
      }

      due.push(this.execute(job));
    }

    if (due.length > 0) await Promise.all(due);
    await this.save();
    this.scheduleWake();
  }

  /** Compute a job's next run time (in-place). */
  private recomputeNext(job: CronJob): void {
    if (!job.enabled) {
      job.nextRun = null;
      job.state = job.state === "completed" ? "completed" : "disabled";
      return;
    }
    if (job.oneShot) {
      if (job.at === undefined) {
        job.nextRun = null;
        return;
      }
      job.nextRun = job.at > Date.now() ? job.at : null;
      job.state = job.nextRun === null ? "completed" : "scheduled";
      return;
    }
    if (job.cron) {
      job.nextRun = nextCronRun(job.cron);
      job.state = "scheduled";
    } else {
      job.nextRun = null;
    }
  }

  // ── execution ────────────────────────────────────────────────────────────

  /** Execute a job's command, capturing output to its log file. */
  private async execute(job: CronJob): Promise<void> {
    if (this.runningIds.has(job.id)) return;
    this.runningIds.add(job.id);

    const started = Date.now();
    job.lastRun = started;
    job.runCount++;
    job.lastError = null;

    const logFile = join(CRON_LOG_DIR, `${job.name}.log`);
    let exitCode: number | null = null;

    try {
      mkdirSync(CRON_LOG_DIR, { recursive: true });
      appendFileSync(
        logFile,
        `[${stamp(started)}] ▶ pboss cron "${job.name}" (${job.schedule})${TWO_SP}cwd: ${job.cwd}\n`
      );

      const isWin = process.platform === "win32";
      const argv = isWin
        ? ["cmd", "/d", "/s", "/c", job.command]
        : ["/bin/sh", "-c", job.command];

      const fd = openSync(logFile, "a");
      try {
        const proc = Bun.spawn(argv, {
          cwd: job.cwd,
          stdout: fd,
          stderr: fd,
          stdin: "ignore",
          env: { ...process.env, PBOSS_CRON_JOB: job.name },
        });
        exitCode = await proc.exited;
      } finally {
        closeSync(fd);
      }

      appendFileSync(
        logFile,
        `[${stamp(Date.now())}] ✔ exit code ${exitCode ?? "?"} after ${((Date.now() - started) / 1000).toFixed(1)}s\n`
      );
    } catch (err: any) {
      job.lastError = err?.message ?? String(err);
      try {
        appendFileSync(logFile, `[${stamp(Date.now())}] ✖ spawn failed: ${job.lastError}\n`);
      } catch {}
    }

    job.lastExitCode = exitCode;
    this.runningIds.delete(job.id);

    // Advance the schedule.
    if (job.oneShot) {
      job.state = "completed";
      job.nextRun = null;
    } else {
      this.recomputeNext(job);
    }

    this.scheduleWake();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Find a job by numeric id (or numeric string) or exact name. */
  private find(target: string | number): CronJob | null {
    const key = String(target);
    if (/^\d+$/.test(key)) {
      const job = this.jobs.get(parseInt(key, 10));
      if (job) return job;
    }
    return this.list().find((j) => j.name === key) ?? null;
  }

  /** Deduplicate a candidate name against existing jobs (backup → backup-2). */
  private uniqueName(base: string): string {
    if (!this.list().some((j) => j.name === base)) return base;
    let n = 2;
    while (this.list().some((j) => j.name === `${base}-${n}`)) n++;
    return `${base}-${n}`;
  }
}
