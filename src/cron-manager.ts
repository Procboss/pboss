/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */
import { parseCron } from "./utils";

export class CronManager {
  private jobs: Map<number, {
    expression: string;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  schedule(processId: number, expression: string, callback: () => void) {
    this.cancel(processId);

    const scheduleNext = () => {
      try {
        const cron = parseCron(expression);
        const nextDate = cron.next();
        const delay = nextDate.getTime() - Date.now();

        if (delay < 0) {
          // Schedule for next minute at least
          setTimeout(scheduleNext, 60000);
          return;
        }

        const timer = setTimeout(() => {
          callback();
          scheduleNext(); // Schedule the next occurrence
        }, delay);

        this.jobs.set(processId, { expression, timer });
      } catch (err) {
        console.error(`[pboss] Cron schedule error for process ${processId}:`, err);
      }
    };

    scheduleNext();
  }

  cancel(processId: number) {
    const job = this.jobs.get(processId);
    if (job) {
      clearTimeout(job.timer);
      this.jobs.delete(processId);
    }
  }

  cancelAll() {
    for (const [id] of this.jobs) {
      this.cancel(id);
    }
  }

  listJobs() {
    const result: Array<{ processId: number; expression: string }> = [];
    for (const [id, job] of this.jobs) {
      result.push({ processId: id, expression: job.expression });
    }
    return result;
  }
}
