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

import type { HealthCheckConfig } from "./types";

export class HealthChecker {
  private checks: Map<number, {
    config: HealthCheckConfig;
    timer: ReturnType<typeof setInterval>;
    consecutiveFails: number;
    lastStatus: "healthy" | "unhealthy" | "unknown";
    lastCheck: number;
    lastResponseTime: number;
  }> = new Map();

  startCheck(
    processId: number,
    config: HealthCheckConfig,
    onUnhealthy: (processId: number, reason: string) => void
  ) {
    this.stopCheck(processId);

    const state: {
      config: HealthCheckConfig;
      timer: ReturnType<typeof setInterval>;
      consecutiveFails: number;
      lastStatus: "healthy" | "unhealthy" | "unknown";
      lastCheck: number;
      lastResponseTime: number;
    } = {
      config,
      consecutiveFails: 0,
      lastStatus: "unknown",
      lastCheck: 0,
      lastResponseTime: 0,
      timer: setInterval(async () => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), config.timeout);

          const response = await fetch(config.url, {
            signal: controller.signal,
            method: "GET",
          });

          clearTimeout(timeout);
          state.lastResponseTime = Date.now() - start;
          state.lastCheck = Date.now();

          if (response.ok) {
            state.consecutiveFails = 0;
            state.lastStatus = "healthy";
          } else {
            state.consecutiveFails++;
            state.lastStatus = "unhealthy";
          }
        } catch {
          state.consecutiveFails++;
          state.lastStatus = "unhealthy";
          state.lastResponseTime = Date.now() - start;
          state.lastCheck = Date.now();
        }

        if (state.consecutiveFails >= config.maxFails) {
          onUnhealthy(processId, `Health check failed ${state.consecutiveFails} times consecutively`);
          state.consecutiveFails = 0;
        }
      }, config.interval),
    };

    this.checks.set(processId, state);
  }

  stopCheck(processId: number) {
    const check = this.checks.get(processId);
    if (check) {
      clearInterval(check.timer);
      this.checks.delete(processId);
    }
  }

  getStatus(processId: number) {
    const check = this.checks.get(processId);
    if (!check) return null;
    return {
      status: check.lastStatus,
      lastCheck: check.lastCheck,
      lastResponseTime: check.lastResponseTime,
      consecutiveFails: check.consecutiveFails,
    };
  }

  stopAll() {
    for (const [id] of this.checks) {
      this.stopCheck(id);
    }
  }
}
