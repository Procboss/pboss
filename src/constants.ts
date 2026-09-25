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
 
import { homedir } from "os";
import { join } from "path";
import packageJson from '../package.json' assert { type: 'json' };


export const APP_NAME = packageJson.name;
export const VERSION = packageJson.version;

export const PBOSS_HOME = process.env.PBOSS_HOME || join(homedir(), ".pboss");
export const BM2_HOME = PBOSS_HOME; // Backwards compatibility alias
export const DAEMON_SOCKET = join(PBOSS_HOME, "daemon.sock");
export const DAEMON_PID_FILE = join(PBOSS_HOME, "daemon.pid");
export const DAEMON_OUT_LOG_FILE = join(PBOSS_HOME, "daemon.out.log");
export const DAEMON_ERR_LOG_FILE = join(PBOSS_HOME, "daemon.err.log");
/**
 * The boot resurrect's own logs. The Windows launcher (daemon-launch.vbs)
 * starts the daemon and then runs `pboss resurrect --wait` — that second
 * command writes here, deliberately NOT into daemon.out/err.log: the
 * daemon's cmd.exe redirect handles stay on those files for its whole
 * lifetime, and a second handle on them is the EBUSY sharing-violation
 * class (issue #36, 2026-09-15). When apps did not come back after a
 * reboot on Windows, resurrect.err.log is where the reason lives.
 */
export const RESURRECT_OUT_LOG_FILE = join(PBOSS_HOME, "resurrect.out.log");
export const RESURRECT_ERR_LOG_FILE = join(PBOSS_HOME, "resurrect.err.log");
export const LOG_DIR = join(PBOSS_HOME, "logs");
export const PID_DIR = join(PBOSS_HOME, "pids");
export const DUMP_FILE = join(PBOSS_HOME, "dump.json");
export const CRON_FILE = join(PBOSS_HOME, "cron.json");
export const CRON_LOG_DIR = join(PBOSS_HOME, "logs", "cron");
export const METRICS_DIR = join(PBOSS_HOME, "metrics");
export const MODULE_DIR = join(PBOSS_HOME, "modules");
export const CONFIG_FILE = join(PBOSS_HOME, "config.json");
export const DASHBOARD_PORT = 9615;
export const METRICS_PORT = 9616;

/** Cloud link state (per-server credential, written 0600). */
export const CLOUD_FILE = join(PBOSS_HOME, "cloud.json");
/** Resource threshold alert config (`pboss alerts`), same dir pattern. */
export const ALERT_THRESHOLDS_FILE = join(PBOSS_HOME, "alert-thresholds.json");
/** User login state (`pboss login`), 0600 — separate from the machine credential. */
export const CLOUD_USER_FILE = join(PBOSS_HOME, "cloud-user.json");
/** Default ProcBoss Cloud endpoint — the production cloud at
 *  https://procboss.com. Override with --url (a bare host is accepted:
 *  "procboss.com" means https://procboss.com, loopback means http) or
 *  PBOSS_CLOUD_URL for the whole machine. */
export const CLOUD_DEFAULT_URL = "https://procboss.com";
/** How often the cloud agent posts a full state report. The 1.5 default:
 *  60s — but the cloud overrides it per account (the `report-interval`
 *  frame carries the owner's plan tier: Free 5min, Basic/Growth 60s,
 *  Pro 30s, Business 15s). PBOSS_CLOUD_REPORT_MS pins it locally. */
export const CLOUD_REPORT_INTERVAL_MS = 60_000;

export const ALL_DIRS = [PBOSS_HOME, LOG_DIR, PID_DIR, METRICS_DIR, MODULE_DIR, CRON_LOG_DIR];

/** Jobs later than this behind schedule are treated as missed (daemon was down). */
export const CRON_LATE_WINDOW_MS = 120_000;
/** Safety-net rescan interval for the cron scheduler. */
export const CRON_WATCHDOG_INTERVAL_MS = 60_000;

export const DEFAULT_KILL_TIMEOUT = 5000;
export const DEFAULT_MIN_UPTIME = 1000;
export const DEFAULT_MAX_RESTARTS = 16;
export const DEFAULT_RESTART_DELAY = 0;
export const DEFAULT_LOG_MAX_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_LOG_RETAIN = 5;
export const MONITOR_INTERVAL = 1000;
export const HEALTH_CHECK_INTERVAL = 30000;
