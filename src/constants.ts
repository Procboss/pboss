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
export const LOG_DIR = join(PBOSS_HOME, "logs");
export const PID_DIR = join(PBOSS_HOME, "pids");
export const DUMP_FILE = join(PBOSS_HOME, "dump.json");
export const METRICS_DIR = join(PBOSS_HOME, "metrics");
export const MODULE_DIR = join(PBOSS_HOME, "modules");
export const CONFIG_FILE = join(PBOSS_HOME, "config.json");
export const DASHBOARD_PORT = 9615;
export const METRICS_PORT = 9616;

export const ALL_DIRS = [PBOSS_HOME, LOG_DIR, PID_DIR, METRICS_DIR, MODULE_DIR];

export const DEFAULT_KILL_TIMEOUT = 5000;
export const DEFAULT_MIN_UPTIME = 1000;
export const DEFAULT_MAX_RESTARTS = 16;
export const DEFAULT_RESTART_DELAY = 0;
export const DEFAULT_LOG_MAX_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_LOG_RETAIN = 5;
export const MONITOR_INTERVAL = 1000;
export const HEALTH_CHECK_INTERVAL = 30000;
