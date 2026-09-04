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

export type ProcessStatus =
  | "online"
  | "stopping"
  | "stopped"
  | "errored"
  | "launching"
  | "waiting-restart"
  | "one-launch-status";

export type ExecMode = "fork" | "cluster";

export interface ProcessDescription {
  id: number;
  name: string;
  script: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  instances: number;
  execMode: ExecMode;
  autorestart: boolean;
  maxRestarts: number;
  minUptime: number;
  maxMemoryRestart?: number;
  watch: boolean;
  watchPaths?: string[];
  ignoreWatch?: string[];
  cronRestart?: string;
  interpreter?: string;
  interpreterArgs?: string[];
  mergeLogs: boolean;
  /** Also forward child stdout/stderr to pboss's own stdout/stderr. */
  raw: boolean;
  logDateFormat?: string;
  errorFile?: string;
  outFile?: string;
  pidFile?: string;
  killTimeout: number;
  restartDelay: number;
  listenTimeout?: number;
  shutdownWithMessage?: boolean;
  treekill?: boolean;
  port?: number;
  // Cluster specific
  clusterMode?: boolean;
  reusePort?: boolean;
  // Health check
  healthCheckUrl?: string;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
  healthCheckMaxFails?: number;
  // Log rotation
  logMaxSize?: number;
  logRetain?: number;
  logCompress?: boolean;
  // Graceful
  gracefulListenTimeout?: number;
  waitReady?: boolean;
  // Deploy
  deployConfig?: DeployConfig;
  // Source map
  sourceMapSupport?: boolean;
  // Node args compatibility
  nodeArgs?: string[];
  // Namespace
  namespace?: string;
  // Version tracking
  version?: string;
  versioningConfig?: VersioningConfig;
}

export interface VersioningConfig {
  currentVersion?: string;
  previousVersions?: string[];
  maxVersions?: number;
}

export interface ProcessEnvMeta extends ProcessDescription {
  status: ProcessStatus;
  pm_uptime: number;
  restart_time: number;
  unstable_restarts: number;
  created_at: number;
  pm_id: number;
  version?: string;
  axm_monitor?: Record<string, any>;
  axm_actions?: any[];
}

export interface ProcessState {
  id: number;
  name: string;
  namespace?: string;
  status: ProcessStatus;
  pid?: number;
  pm_id: number;
  monit: {
    memory: number;
    cpu: number;
    handles?: number;
    eventLoopLatency?: number;
  };
  pboss_env: ProcessEnvMeta;
  bm2_env?: ProcessEnvMeta;
}

export interface StartOptions {
  name?: string;
  script: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  instances?: number;
  execMode?: ExecMode;
  autorestart?: boolean;
  maxRestarts?: number;
  minUptime?: number;
  maxMemoryRestart?: string | number;
  watch?: boolean | string[];
  ignoreWatch?: string[];
  interpreter?: string;
  interpreterArgs?: string[];
  mergeLogs?: boolean;
  /** Also forward child stdout/stderr to pboss's own stdout/stderr. */
  raw?: boolean;
  logDateFormat?: string;
  errorFile?: string;
  outFile?: string;
  killTimeout?: number;
  restartDelay?: number;
  cron?: string;
  port?: number;
  healthCheckUrl?: string;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
  healthCheckMaxFails?: number;
  logMaxSize?: string | number;
  logRetain?: number;
  logCompress?: boolean;
  waitReady?: boolean;
  listenTimeout?: number;
  namespace?: string;
  nodeArgs?: string[];
  sourceMapSupport?: boolean;
}

export interface EcosystemConfig {
  apps: StartOptions[];
  noDaemon?: boolean;
  deploy?: Record<string, DeployConfig>;
}

export interface DeployConfig {
  user: string;
  host: string | string[];
  ref: string;
  repo: string;
  path: string;
  preDeploy?: string;
  postDeploy?: string;
  preSetup?: string;
  postSetup?: string;
  ssh_options?: string;
  env?: Record<string, string>;
}

export interface DaemonMessage {
  type: string;
  data?: any;
  id?: string;
  mode?: "stream" | "http"
}

export interface DaemonResponse {
  type: string;
  data?: any;
  success: boolean;
  error?: string;
  id?: string;
}

export interface MetricSnapshot {
  timestamp: number;
  processes: Array<{
    id: number;
    name: string;
    pid?: number;
    cpu: number;
    memory: number;
    eventLoopLatency?: number;
    handles?: number;
    status: ProcessStatus;
    restarts: number;
    uptime: number;
  }>;
  system: {
    totalMemory: number;
    freeMemory: number;
    cpuCount: number;
    loadAvg: number[];
    platform: string;
  };
}

export interface LogRotateOptions {
  maxSize: number;
  retain: number;
  compress: boolean;
  dateFormat?: string;
}

export interface HealthCheckConfig {
  url: string;
  interval: number;
  timeout: number;
  maxFails: number;
}

export interface DashboardState {
  processes: ProcessState[];
  metrics: MetricSnapshot;
  logs: Record<string, { out: string; err: string }>;
}

export type LogEntry = {
  ts: string;
  level?: "err" | "out",
  msg: string;
};

export interface LogItem {
  name: string;
  id: number;
  ts: string;
  msg: string;
  level?: "err" | "out";
}
