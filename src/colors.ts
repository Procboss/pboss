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

export function color(text: string, type: string) {
  const codes: Record<string, string> = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
  };
  return (codes[type] || "") + text + codes.reset;
}

export function statusColor(status: string): string {
  switch (status) {
    case "online":
      return "green";
    case "stopped":
      return "gray";
    case "errored":
      return "red";
    case "launching":
    case "waiting-restart":
      return "yellow";
    case "stopping":
      return "magenta";
    // Issue #33: dependency/system-service states (`pboss deps`).
    case "running":
    case "active":
      return "green";
    case "failed":
    case "not-found":
      return "red";
    case "partial":
    case "inactive":
    case "activating":
    case "unavailable":
      return "yellow";
    default:
      return "white";
  }
}
