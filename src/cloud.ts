/**
 * ProcBoss (pboss) — Cloud Agent
 *
 * Links this machine's pboss daemon to ProcBoss Cloud over an
 * OUTBOUND-ONLY WebSocket connection (/ws/agent). The cloud never reaches
 * into the user's network.
 *
 * One full-duplex socket carries everything:
 *   agent → cloud:  state reports (10s), command results, live log frames
 *   cloud → agent:  commands (restart/stop/…), log.watch / log.unwatch
 *
 * Enrollment: `pboss cloud connect` (device code) or the legacy single-use
 * token is exchanged once for a permanent per-server credential stored in
 * `~/.pboss/cloud.json` (0600). Reconnection is automatic with backoff;
 * close code 4001 means the credential was revoked — the agent unlinks
 * itself instead of retrying forever.
 *
 * Wire protocol is mirrored on the cloud side (src/lib/cloud/protocol.ts).
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { platform, arch, hostname, totalmem, freemem, loadavg, cpus } from "node:os";
import { dirname } from "node:path";
import { VERSION, CLOUD_FILE, CLOUD_DEFAULT_URL, CLOUD_REPORT_INTERVAL_MS } from "./constants";
import { getSystemInfo, colorize } from "./utils";
import { ignore } from "./error-handling";
import type { ProcessManager } from "./process-manager";
import type { ProcessState, StartOptions, LogItem } from "./types";
import { runDeployJob, cancelDeployJob, deployJobRunning, gitInfoForProcess } from "./deploy-job";

/**
 * Inbound-silence watchdog. The cloud pings the agent (app-level `ping`
 * frames) every ~15s. A socket can die WITHOUT a close frame — NAT timeout,
 * network switch, half-open TCP — and then the agent would sit on a
 * "connected" socket forever: sends are buffered locally and never arrive,
 * the dashboard says offline while the agent thinks it is healthy. When no
 * frame has arrived for this long (and the server has demonstrated that it
 * pings), the agent closes the dead socket itself and the runStream loop
 * dials fresh. Env override: PBOSS_CLOUD_WATCHDOG_MS (tests).
 */
export const CLOUD_INBOUND_WATCHDOG_MS = 45_000;

/**
 * Event outbox cap (see CloudAgent.reportState): the newest events are kept
 * when a long outage overflows the buffer. Crash events with log tails are
 * the payload that matters — a few hundred KB worst case, bounded.
 */
export const CLOUD_EVENT_OUTBOX_MAX = 200;

/**
 * How long an un-acked event stays queued before the agent gives up on it.
 * A cloud that never acks (older than the event-ack extension) would leave
 * the outbox growing forever — stale events are dropped instead of being
 * re-delivered to a server that has clearly moved on.
 */
export const CLOUD_EVENT_TTL_MS = 10 * 60_000;

/**
 * Hello deadline. The cloud sends a `hello` frame the instant the
 * authenticated upstream upgrade completes. Some reverse proxies answer
 * the WebSocket upgrade THEMSELVES (a 101 within milliseconds) and then
 * dial the origin without forwarding the Authorization header — the origin
 * rejects, and the client sits on an open socket that leads nowhere: a
 * "mirage" open. Until hello arrives, the agent refuses to call itself
 * connected, send frames, or reset the backoff. Env override:
 * PBOSS_CLOUD_HELLO_TIMEOUT_MS (tests).
 */
export const CLOUD_HELLO_TIMEOUT_MS = 10_000;

/**
 * A confirmed link that lived at least this long counts as stable — when it
 * eventually drops, the retry counter resets, so "N retries" reads as
 * "N since the last stable link", not a scary lifetime total. Env override:
 * PBOSS_CLOUD_STABLE_LINK_MS (tests).
 */
export const CLOUD_STABLE_LINK_MS = 60_000;

export interface CloudAgentOptions {
  /** Shrink the inbound watchdog (tests). Default 45s, env overridable. */
  inboundWatchdogMs?: number;
  /** Report cadence in ms (tests). Default 10s, env overridable. */
  reportIntervalMs?: number;
  /** Hello-confirmation deadline in ms (tests). Default 10s, env overridable. */
  helloTimeoutMs?: number;
  /** How long a link must hold to count as stable (tests). Default 60s. */
  stableLinkMs?: number;
}

/* ── config file ──────────────────────────────────────────────────────── */

export interface CloudConfig {
  cloudUrl: string;
  serverId: string;
  serverSecret: string;
  serverName?: string;
}

export function loadCloudConfig(): CloudConfig | null {
  try {
    if (!existsSync(CLOUD_FILE)) return null;
    const raw = JSON.parse(readFileSync(CLOUD_FILE, "utf-8") as string) as Partial<CloudConfig>;
    if (!raw.cloudUrl || !raw.serverId || !raw.serverSecret) return null;
    return {
      cloudUrl: String(raw.cloudUrl).replace(/\/+$/, ""),
      serverId: String(raw.serverId),
      serverSecret: String(raw.serverSecret),
      serverName: raw.serverName ? String(raw.serverName) : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCloudConfig(cfg: CloudConfig): void {
  // mkdir first: the daemon normally ran ensureDirs(), but a fresh
  // machine (or a test) can reach this write before anything created
  // ~/.pboss — a missing credential because of a missing DIRECTORY is a
  // bug, not an acceptable failure mode.
  try {
    mkdirSync(dirname(CLOUD_FILE), { recursive: true, mode: 0o700 });
  } catch {
    // exists already, or a parent we cannot create — writeFileSync below
    // reports the honest error.
  }
  writeFileSync(CLOUD_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(CLOUD_FILE, 0o600);
  } catch (err) {
    // Best-effort — some filesystems reject chmod; the credential is still
    // written, and the failure is recorded instead of vanishing.
    ignore(`chmod cloud credential ${CLOUD_FILE} 0600`, err);
  }
}

export function clearCloudConfig(): void {
  try {
    if (existsSync(CLOUD_FILE)) unlinkSync(CLOUD_FILE);
  } catch (err) {
    ignore(`unlink cloud config ${CLOUD_FILE}`, err);
  }
}

export function resolveCloudUrl(explicit?: string): string {
  const url = (explicit || process.env.PBOSS_CLOUD_URL || CLOUD_DEFAULT_URL).trim();
  return url.replace(/\/+$/, "");
}

/* ── transport security (pm2's posture: never silent plaintext) ───────── */

/** Loopback hostnames — plain http/ws is acceptable only for these. */
export function isLoopbackHost(host: string): boolean {
  const h = String(host).toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost") ||
    /^127\./.test(h)
  );
}

/**
 * Refuse a plaintext transport to a non-loopback cloud. The machine
 * credential, command frames, and log lines all cross this URL: without
 * TLS a network observer can steal the credential and a MITM can inject
 * process commands (restart/stop/delete/deploy). https/wss always pass;
 * loopback passes (tests, self-hosted local clouds); anything else needs
 * the operator's explicit `PBOSS_CLOUD_ALLOW_INSECURE=1` — and then the
 * risk is said out loud, never silently accepted.
 */
export function assertSecureCloudUrl(cloudUrl: string): void {
  let proto: string;
  let host: string;
  try {
    const u = new URL(cloudUrl);
    proto = u.protocol;
    host = u.hostname;
  } catch {
    throw new Error(`not a valid cloud URL: ${cloudUrl}`);
  }
  if (proto === "https:" || proto === "wss:") return;
  if (isLoopbackHost(host)) return;
  if (process.env.PBOSS_CLOUD_ALLOW_INSECURE === "1") {
    console.error(
      colorize(
        `☁  cloud: WARNING — ${proto}//${host} is UNENCRYPTED (PBOSS_CLOUD_ALLOW_INSECURE=1): the credential and command frames are readable and forgeable on the wire.`,
        "yellow"
      )
    );
    return;
  }
  throw new Error(
    `refusing plaintext transport to ${cloudUrl}: use an https:// cloud URL, or set PBOSS_CLOUD_ALLOW_INSECURE=1 to accept the risk`
  );
}

/** https://… → wss://…, http://… → ws://…, and the agent endpoint path. */
export function wsUrlOf(cloudUrl: string): string {
  const base = cloudUrl.replace(/\/+$/, "");
  const wsBase = base.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  return `${wsBase}/ws/agent`;
}

/* ── fleet view (`pboss cloud servers`, via the daemon's machine credential) ── */

export interface CloudFleetServer {
  id: string;
  name: string;
  host: string;
  status: string;
  os: string;
  agentVersion: string;
  cpu: number;
  memUsed: number;
  memTotal: number;
  lastSeen: string;
  enrolled: boolean;
}

/**
 * GET /api/agent/servers with the machine credential — the linked server's
 * owner's fleet with live presence. Runs inside the daemon (the CLI asks
 * over the socket): the machine secret never leaves this process except
 * toward the cloud itself.
 */
export async function fetchFleet(cfg: CloudConfig): Promise<CloudFleetServer[]> {
  assertSecureCloudUrl(cfg.cloudUrl);
  const res = await fetch(`${cfg.cloudUrl}/api/agent/servers`, {
    headers: {
      Authorization: `Bearer ${cfg.serverId}.${cfg.serverSecret}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401) {
    throw new Error("the machine credential was revoked — re-link with `pboss cloud connect`");
  }
  if (!res.ok) {
    throw new Error(`fleet request failed (HTTP ${res.status})`);
  }
  const body = (await res.json().catch((err: unknown) => {
    ignore("parse fleet response", err);
    return {};
  })) as { servers?: CloudFleetServer[] };
  return Array.isArray(body.servers) ? body.servers : [];
}

/* ── wire types (mirror of the cloud's protocol.ts) ───────────────────── */

export type CloudProcessStatus = "online" | "stopped" | "errored";

export interface CloudProcessReport {
  name: string;
  script: string;
  pmId: number;
  status: CloudProcessStatus;
  pid?: number;
  cpu: number;
  mem: number;
  restarts: number;
  crashes: number;
  uptimeSec: number;
  /** Exit facts (present after the process has exited once). */
  exitCode?: number | null;
  signal?: string | null;
}

export interface CloudEventReport {
  kind: "crash" | "restart" | "online" | "stopped";
  process: string;
  at: number;
  detail?: string;
  /** Crash enrichment — drives the cloud's crash reports. */
  exitCode?: number | null;
  signal?: string | null;
  logTail?: string[];
  /**
   * Delivery id (agent-assigned, stable across re-sends): the cloud acks
   * ingested events by id (`event-ack` frame) and dedups on it, so an event
   * can be re-sent after a blackout without double-alerting. Absent on
   * events from agents older than the ack extension (the cloud then simply
   * never acks or dedups them).
   */
  id?: string;
}

export interface CloudStateReport {
  serverId: string;
  status: "online" | "degraded" | "offline";
  hostname: string;
  os: string;
  arch: string;
  bunVersion: string;
  agentVersion: string;
  cpu: number;
  memUsed: number;
  memTotal: number;
  processes: CloudProcessReport[];
  events: CloudEventReport[];
}

export interface CloudCommand {
  id: string;
  type:
    | "process.list"
    | "process.start"
    | "process.stop"
    | "process.restart"
    | "process.kill"
    | "process.delete"
    | "process.logs"
    | "process.deploy"
    | "server.info"
    | "server.deploy"
    /* auto-deploy pipeline (long-running; see deploy-job.ts) */
    | "process.gitinfo"
    | "deploy.run"
    | "deploy.cancel";
  payload: Record<string, unknown>;
}

export interface CloudCommandResult {
  commandId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Frames the cloud sends down the socket. */
export type CloudServerFrame =
  | { type: "hello"; serverId: string; now: number }
  | { type: "command"; command: CloudCommand }
  | { type: "log.watch"; process: string }
  | { type: "log.unwatch"; process: string }
  | { type: "ping"; now: number }
  /** Ingested-event receipt: the agent may drop these ids from its outbox. */
  | { type: "event-ack"; ids: string[] };

/** Frames the agent sends up. */
export type CloudAgentFrame =
  | { type: "state"; report: CloudStateReport }
  | { type: "command-result"; result: CloudCommandResult }
  | { type: "log"; process: string; lines: { t: number; level?: string; msg: string }[] }
  | { type: "deploy.progress"; progress: DeployProgressPayload }
  | { type: "pong"; now: number };

/* ── auto-deploy wire shapes (mirror of the cloud's protocol.ts) ──────── */

/** The deploy.run payload — one deployment job, end to end. */
export interface DeployRunPayload {
  deploymentId: string;
  /** Tokenized clone URL (x-access-token form) — fetch auth ONLY. */
  repoUrl: string;
  /** Credential-free URL — what .git/config's origin is kept at. */
  cleanRepoUrl: string;
  branch: string;
  /** EXACT identity — the agent refuses ambiguous branch states. */
  commitSha: string;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string;
  workdir: string | null;
  env: Record<string, string>;
  runtime: "bun" | "node";
  mode: "new" | "update" | "rollback";
  processName: string;
  buildTimeoutSec: number;
}

/** deploy.progress frames — step matches the cloud's pipeline states,
 * "done" is terminal (success flag + agent-reported facts). */
export interface DeployProgressPayload {
  deploymentId: string;
  step: "cloning" | "installing" | "building" | "deploying" | "starting" | "done";
  logs?: string[];
  error?: string;
  success?: boolean;
  commit?: string;
  durationMs?: number;
}

/** The cloud closes the socket with this code when the credential is revoked. */
export const WS_CLOSE_REVOKED = 4001;

/* ── pure mapping helpers (unit-tested) ───────────────────────────────── */

export function mapProcessState(p: ProcessState): CloudProcessReport {
  const status: CloudProcessStatus =
    p.status === "online" || p.status === "launching" || p.status === "waiting-restart"
      ? "online"
      : p.status === "errored"
        ? "errored"
        : "stopped";
  const env = p.pboss_env ?? p.bm2_env;
  return {
    name: p.name,
    script: env?.script ?? "",
    pmId: p.pm_id ?? 0,
    status,
    pid: p.pid,
    cpu: Math.round(p.monit?.cpu ?? 0),
    mem: Math.round((p.monit?.memory ?? 0) / (1024 * 1024)),
    restarts: env?.restart_time ?? 0,
    crashes: env?.unstable_restarts ?? 0,
    // pm_uptime is the epoch-ms START timestamp (process-container sets it to
    // startedAt) — same math the CLI's own uptime column uses: now - start.
    uptimeSec: Math.max(0, Math.round((Date.now() - (env?.pm_uptime ?? Date.now())) / 1000)),
    exitCode: env?.last_exit_code ?? undefined,
    signal: env?.last_exit_signal ?? undefined,
  };
}

export function systemSnapshot(): { cpu: number; memUsed: number; memTotal: number } {
  const cores = cpus().length || 1;
  const load = loadavg()[0] ?? 0;
  const cpu = Math.max(0, Math.min(100, Math.round((load / cores) * 100)));
  const total = Math.round(totalmem() / (1024 * 1024));
  const used = Math.max(0, Math.round((totalmem() - freemem()) / (1024 * 1024)));
  return { cpu, memUsed: used, memTotal: total };
}

export function buildStateReport(
  serverId: string,
  processes: ProcessState[],
): CloudStateReport {
  const sys = systemSnapshot();
  return {
    serverId,
    status: "online",
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    bunVersion: Bun.version,
    agentVersion: `pboss/${VERSION}`,
    cpu: sys.cpu,
    memUsed: sys.memUsed,
    memTotal: sys.memTotal,
    processes: processes.map(mapProcessState),
    events: [],
  };
}

/** Derive human-meaningful events from two consecutive snapshots. */
export function diffEvents(
  prev: Map<string, CloudProcessReport>,
  next: CloudProcessReport[],
): CloudEventReport[] {
  const events: CloudEventReport[] = [];
  const now = Date.now();
  for (const p of next) {
    const before = prev.get(p.name);
    if (!before) {
      events.push({ kind: "online", process: p.name, at: now, detail: "process discovered" });
      continue;
    }
    if (before.status !== "errored" && p.status === "errored") {
      events.push({
        kind: "crash",
        process: p.name,
        at: now,
        detail: "process errored",
        exitCode: p.exitCode ?? null,
        signal: p.signal ?? null,
      });
    } else if (before.status === "online" && p.status === "stopped") {
      events.push({ kind: "stopped", process: p.name, at: now, detail: "process stopped" });
    } else if (
      (before.status === "stopped" || before.status === "errored") &&
      p.status === "online"
    ) {
      events.push({ kind: "online", process: p.name, at: now, detail: "process came online" });
    }
    if (p.restarts > before.restarts) {
      events.push({
        kind: "restart",
        process: p.name,
        at: now,
        detail: `restart #${p.restarts}`,
      });
    }
  }
  return events.slice(0, 50);
}

/** Rebuild StartOptions from a (stopped) process's persisted env. */
export function startOptionsFromState(p: ProcessState): StartOptions {
  const env = p.pboss_env ?? p.bm2_env;
  return {
    name: p.name,
    script: env?.script ?? "",
    args: env?.args ?? [],
    cwd: env?.cwd,
    env: env?.env,
    instances: env?.instances,
    execMode: env?.execMode,
    autorestart: env?.autorestart,
    maxRestarts: env?.maxRestarts,
    minUptime: env?.minUptime,
    maxMemoryRestart: env?.maxMemoryRestart,
    watch: env?.watch,
    ignoreWatch: env?.ignoreWatch,
    interpreter: env?.interpreter,
    interpreterArgs: env?.interpreterArgs,
    mergeLogs: env?.mergeLogs,
    raw: env?.raw,
    logDateFormat: env?.logDateFormat,
    errorFile: env?.errorFile,
    outFile: env?.outFile,
    killTimeout: env?.killTimeout,
    restartDelay: env?.restartDelay,
    port: env?.port,
  };
}

/** Lines of crash-context the agent attaches to crash events (raw text). */
export function crashLogTail(logs: LogItem[], max = 30): string[] {
  return logs
    .slice(-max)
    .map((l) => l.msg ?? "")
    .filter((s) => s.length > 0);
}

/* ── the agent ────────────────────────────────────────────────────────── */

export interface CloudAgentStatus {
  configured: boolean;
  cloudUrl: string | null;
  serverId: string | null;
  serverName: string | null;
  connected: boolean;
  streamState: "connecting" | "connected" | "backoff" | "stopped";
  reconnects: number;
  /** ms until the next dial attempt while in backoff (null otherwise). */
  nextRetryInMs: number | null;
  lastReportAt: number | null;
  lastReportAgeMs: number | null;
  processes: number;
  /** Events observed but not yet delivered (blackout buffer depth). */
  pendingEvents: number;
  lastError: string | null;
}

/**
 * One-line verdict for the post-upgrade / post-install link check: the
 * machine's cloud link exists (or doesn't) and what state it is in right
 * now. Shared by `pboss upgrade`'s verification step and the docs' contract.
 * Structural on purpose: the daemon RPC's status shape widens `streamState`
 * to string on its way through JSON.
 */
export function describeCloudLink(status: {
  configured: boolean;
  serverId: string | null;
  serverName: string | null;
  streamState: string;
  nextRetryInMs: number | null;
  lastError: string | null;
}): string {
  if (!status.configured) {
    return "no cloud link on this machine — link with `pboss cloud connect`";
  }
  const name = status.serverName ?? status.serverId ?? "?";
  switch (status.streamState) {
    case "connected":
      return `cloud link resumed: ${name} — connected, command channel live`;
    case "connecting":
      return `cloud link resumed: ${name} — connecting…`;
    case "backoff": {
      const inSec = Math.max(1, Math.round((status.nextRetryInMs ?? 0) / 1000));
      return `cloud link resumed: ${name} — reconnecting (next try in ~${inSec}s)`;
    }
    default:
      return `cloud link present: ${name} — stopped${status.lastError ? ` (${status.lastError})` : ""}`;
  }
}

export class CloudAgent {
  private pm: ProcessManager;
  private cfg: CloudConfig | null = null;
  private running = false;
  private ws: WebSocket | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private reconnects = 0;
  /** When the next dial fires while in backoff (status display). */
  private nextRetryAt: number | null = null;
  /** The cloud's hello frame confirms the link is REAL, not a proxy mirage. */
  private linkConfirmed = false;
  private confirmedAt = 0;
  private helloTimeoutMs: number;
  private stableLinkMs: number;
  private streamState: CloudAgentStatus["streamState"] = "stopped";
  private lastReport: CloudStateReport | null = null;
  private lastReportAt: number | null = null;
  private lastError: string | null = null;
  private lastSnapshot = new Map<string, CloudProcessReport>();
  private reportNow: (() => void) | null = null;
  /** Active log tails (process name → stop function), driven by log.watch. */
  private logTails = new Map<string, () => void>();
  /** Inbound-silence watchdog state: last frame time + server-ping proof. */
  private lastInboundAt = 0;
  private sawServerPing = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogMs: number;
  private reportIntervalMs: number;
  /**
   * Event outbox — crash/restart/online/stopped events, each stamped with a
   * delivery id, held until the cloud acks ingestion (`event-ack`). The
   * pm2 agent's offline queue made reliable: state is re-sent whole every
   * cycle, but EVENTS are transitions — miss one and the dashboard never
   * sees the crash. At-least-once delivery + cloud-side id dedup.
   */
  private outbox: CloudEventReport[] = [];

  constructor(pm: ProcessManager, opts: CloudAgentOptions = {}) {
    this.pm = pm;
    const envMs = Number.parseInt(process.env.PBOSS_CLOUD_WATCHDOG_MS ?? "", 10);
    this.watchdogMs =
      opts.inboundWatchdogMs ??
      (Number.isFinite(envMs) && envMs > 0 ? envMs : CLOUD_INBOUND_WATCHDOG_MS);
    const envReport = Number.parseInt(process.env.PBOSS_CLOUD_REPORT_MS ?? "", 10);
    this.reportIntervalMs =
      opts.reportIntervalMs ??
      (Number.isFinite(envReport) && envReport > 0 ? envReport : CLOUD_REPORT_INTERVAL_MS);
    const envHello = Number.parseInt(process.env.PBOSS_CLOUD_HELLO_TIMEOUT_MS ?? "", 10);
    this.helloTimeoutMs =
      opts.helloTimeoutMs ??
      (Number.isFinite(envHello) && envHello > 0 ? envHello : CLOUD_HELLO_TIMEOUT_MS);
    const envStable = Number.parseInt(process.env.PBOSS_CLOUD_STABLE_LINK_MS ?? "", 10);
    this.stableLinkMs =
      opts.stableLinkMs ??
      (Number.isFinite(envStable) && envStable > 0 ? envStable : CLOUD_STABLE_LINK_MS);
  }

  get config(): CloudConfig | null {
    return this.cfg;
  }

  status(): CloudAgentStatus {
    const cfg = this.cfg;
    return {
      configured: Boolean(cfg),
      cloudUrl: cfg?.cloudUrl ?? null,
      serverId: cfg?.serverId ?? null,
      serverName: cfg?.serverName ?? null,
      connected: this.streamState === "connected",
      streamState: this.streamState,
      reconnects: this.reconnects,
      nextRetryInMs: this.nextRetryAt ? Math.max(0, this.nextRetryAt - Date.now()) : null,
      lastReportAt: this.lastReportAt,
      lastReportAgeMs: this.lastReportAt ? Date.now() - this.lastReportAt : null,
      processes: this.lastReport?.processes.length ?? 0,
      pendingEvents: this.outbox.length,
      lastError: this.lastError,
    };
  }

  /** Link this machine: exchange the enrollment token for a credential. */
  async enroll(token: string, cloudUrl: string): Promise<{ serverId: string; serverName: string }> {
    // The enrollment exchange carries the single-use token — TLS is not
    // negotiable for non-loopback targets (see assertSecureCloudUrl).
    assertSecureCloudUrl(cloudUrl);
    const res = await fetch(`${cloudUrl}/api/agent/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        bunVersion: Bun.version,
        pbossVersion: VERSION,
      }),
    });
    const body = (await res.json().catch((err: unknown) => {
      ignore("parse enrollment response JSON", err);
      return {} as Record<string, string>;
    })) as {
      serverId?: string;
      serverSecret?: string;
      serverName?: string;
      error?: string;
    };
    if (!res.ok || !body.serverId || !body.serverSecret) {
      throw new Error(body.error ?? `enrollment failed (HTTP ${res.status})`);
    }
    const cfg: CloudConfig = {
      cloudUrl,
      serverId: body.serverId,
      serverSecret: body.serverSecret,
      serverName: body.serverName,
    };
    saveCloudConfig(cfg);
    this.cfg = cfg;
    return { serverId: cfg.serverId, serverName: cfg.serverName ?? cfg.serverId };
  }

  /**
   * Start (or restart) the connection loops from a saved config.
   *
   * Never throws: the daemon calls this on BOOT with whatever it found in
   * ~/.pboss/cloud.json — a credential whose transport is refused (say, a
   * plaintext http:// cloud URL) must degrade to "configured, link stopped,
   * reason visible in `pboss cloud status`", not crash the daemon process
   * that the whole machine depends on. The interactive paths (enroll) still
   * fail loudly; the daemon's boot path fails honestly instead.
   */
  start(cfg: CloudConfig): void {
    this.stop({ revoke: false, quiet: true });
    this.cfg = cfg;
    try {
      assertSecureCloudUrl(cfg.cloudUrl);
    } catch (err) {
      this.running = false;
      this.streamState = "stopped";
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(
        colorize(`☁  cloud: link NOT started — ${this.lastError}`, "yellow")
      );
      return;
    }
    this.running = true;
    this.streamState = "connecting";
    // A manual (re)start dials immediately — the backoff ladder restarts too.
    this.backoffMs = 1000;
    this.nextRetryAt = null;
    console.log(
      colorize(`☁  cloud: connecting to ${cfg.cloudUrl} (${cfg.serverName ?? cfg.serverId})`, "cyan")
    );
    void this.runStream();
    this.reportTimer = setInterval(() => this.reportNow?.(), this.reportIntervalMs);
    this.reportNow = () => void this.reportState().catch((err: unknown) => ignore("cloud state report (interval)", err));
    void this.reportState().catch((err: unknown) => ignore("cloud state report (initial)", err));
    this.startWatchdog();
  }

  /**
   * The reinstall/upgrade contract, in one method: if this agent is not
   * currently running a link but a machine credential sits in
   * ~/.pboss/cloud.json (the permanent credential cache — it survives
   * binary swaps, reinstalls and upgrades by design), pick the link up
   * NOW. Returns whether a link exists at all (already running, or
   * freshly resumed from disk).
   *
   * Called from the daemon whenever the CLI asks for cloud status — a
   * daemon that booted BEFORE the credential existed (fresh install
   * racing a dotfiles sync / backup restore / manual migration) must not
   * answer "not linked" while the credential sits on disk unread.
   */
  resumeFromDisk(): boolean {
    if (this.cfg) return true; // already linked in memory (possibly erroring)
    const cfg = loadCloudConfig();
    if (!cfg) return false;
    this.start(cfg); // never throws (see start)
    return true;
  }

  /** Stop the agent. `revoke` also kills the credential server-side. */
  async stop(opts: { revoke: boolean; quiet?: boolean }): Promise<void> {
    this.running = false;
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.reportNow = null;
    this.stopWatchdog();
    this.closeSocket(1000, "agent stopped");
    this.streamState = "stopped";
    this.linkConfirmed = false;
    this.nextRetryAt = null;
    if (opts.revoke && this.cfg) {
      const cfg = this.cfg;
      try {
        await fetch(`${cfg.cloudUrl}/api/agent/disconnect`, {
          method: "POST",
          headers: this.authHeader(cfg),
        });
      } catch (err) {
        // Network gone — the credential file is cleared below anyway, but
        // record it so a persistent reachability problem stays visible.
        ignore("revoke cloud credential (agent disconnect)", err);
      }
      clearCloudConfig();
      if (!opts.quiet) {
        console.log(colorize("☁  cloud: credential revoked, this machine is unlinked", "cyan"));
      }
    }
    this.cfg = null;
  }

  private authHeader(cfg: CloudConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${cfg.serverId}.${cfg.serverSecret}`,
      "Content-Type": "application/json",
    };
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        // already closing — nothing to do
      }
    }
  }

  /* ── inbound-silence watchdog (half-open socket detector) ────────── */

  private startWatchdog(): void {
    this.stopWatchdog();
    const tick = Math.max(100, Math.min(1_000, Math.floor(this.watchdogMs / 3)));
    this.watchdogTimer = setInterval(() => {
      if (!this.running || this.streamState !== "connected") return;
      // Only enforced once the server has PROVEN it pings on this connection
      // — an older cloud that never pings must not be churn-reconnected.
      if (!this.sawServerPing) return;
      const silentFor = Date.now() - this.lastInboundAt;
      if (silentFor > this.watchdogMs) {
        this.lastError = `no frames from the cloud for ${Math.round(silentFor / 1000)}s — reconnecting`;
        console.log(
          colorize(
            `☁  cloud: silent for ${Math.round(silentFor / 1000)}s (dead link?) — reconnecting`,
            "yellow"
          )
        );
        // No close frame will ever arrive — force the socket down so
        // serveWebSocket resolves and runStream dials fresh.
        this.closeSocket(1000, "inbound watchdog");
      }
    }, tick);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /* ── command + log channel (WebSocket, full-duplex) ─────────────────── */

  private async runStream(): Promise<void> {
    while (this.running && this.cfg) {
      const cfg = this.cfg;
      this.streamState = "connecting";
      this.linkConfirmed = false;
      let closedWith: { code: number; reason: string } | null = null;
      let helloTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const ws = await this.dialWebSocket(cfg);
        if (!this.running || this.cfg !== cfg) {
          this.closeSocket(1000, "superseded");
          return;
        }
        this.ws = ws;
        // streamState stays "connecting" until the cloud's `hello` frame
        // CONFIRMS the link (see confirmLink): some reverse proxies answer
        // the WebSocket upgrade themselves and never establish the
        // authenticated upstream — a "mirage" open. An agent that trusted
        // the open event alone once reported connected while every frame
        // vanished into the proxy, and the fake open reset the backoff
        // every cycle: a ~3s flap, hundreds of retries per hour.
        this.lastInboundAt = Date.now();
        this.sawServerPing = false;
        helloTimer = setTimeout(() => {
          if (this.ws !== ws || this.linkConfirmed || !this.running) return;
          this.lastError =
            "cloud completed the WebSocket upgrade but never confirmed the link (no hello frame) — " +
            "a reverse proxy may be stripping the agent handshake";
          console.log(
            colorize(
              `☁  cloud: open but unconfirmed for ${Math.round(this.helloTimeoutMs / 1000)}s — redialing`,
              "yellow"
            )
          );
          this.closeSocket(1000, "hello timeout");
        }, this.helloTimeoutMs);

        closedWith = await this.serveWebSocket(ws);
        if (helloTimer) clearTimeout(helloTimer);
      } catch (err: any) {
        if (helloTimer) clearTimeout(helloTimer);
        if (!this.running) return;
        this.lastError = err?.message ?? String(err);
      }
      if (!this.running || !this.cfg) return;

      // Revoked: the cloud told us to go away — unlink, don't retry.
      if (closedWith?.code === WS_CLOSE_REVOKED) {
        this.handleRevoked();
        return;
      }

      // Post-mortem: surface WHY a confirmed link died. The generic
      // "websocket not open — state report skipped" once masked this for
      // hours (a stream of handshake 401s read as unexplained flapping).
      if (closedWith && this.linkConfirmed) {
        if (closedWith.reason === "replaced") {
          this.lastError =
            "cloud replaced this connection — another daemon linking with the same credential?";
        } else if (closedWith.code !== 1000) {
          this.lastError = `cloud closed the connection (code ${closedWith.code}${closedWith.reason ? `: ${closedWith.reason}` : ""})`;
        }
      }
      // A link that held ≥ stableLinkMs was healthy: its death resets the
      // counter, so "N retries" means "N since the last stable link".
      if (this.linkConfirmed && Date.now() - this.confirmedAt >= this.stableLinkMs) {
        this.reconnects = 0;
      }

      this.streamState = "backoff";
      this.reconnects++;
      // Jitter (75–125%): after a cloud-side blip, every agent in a fleet
      // exits backoff at the same instant — the synchronized retry storm
      // is what actually takes the gateway down. Spreading the retries
      // turns a thundering herd into a trickle.
      const delay = Math.floor(this.backoffMs * (0.75 + Math.random() * 0.5));
      this.nextRetryAt = Date.now() + delay;
      await sleep(delay);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      this.nextRetryAt = null;
    }
  }

  /** Dial /ws/agent; resolves with the OPEN socket (auth included). */
  private dialWebSocket(cfg: CloudConfig): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const url = wsUrlOf(cfg.cloudUrl);
      // The credential rides two transports: the Authorization header
      // (well-behaved proxies) AND the `?agent=` query param — some
      // reverse proxies (preview tunnels, corporate gateways) strip
      // Authorization from WebSocket upgrades but forward the URL. The
      // cloud reads whichever arrives; both carry the same Bearer token.
      const authedUrl =
        url +
        (url.includes("?") ? "&" : "?") +
        `agent=${encodeURIComponent(`${cfg.serverId}.${cfg.serverSecret}`)}`;
      // Bun's WebSocket client accepts extra handshake headers.
      const ws = new WebSocket(authedUrl, { headers: this.authHeader(cfg) } as never);
      const failTimer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // not open — close is a no-op that triggers onclose below
        }
        reject(new Error(`websocket handshake timeout (${url})`));
      }, 15_000);
      ws.onopen = () => {
        clearTimeout(failTimer);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(failTimer);
        reject(new Error(`websocket error (dialing ${url})`));
      };
      ws.onclose = (ev) => {
        clearTimeout(failTimer);
        reject(new Error(`websocket closed during handshake (code ${ev.code})`));
      };
    });
  }

  /** Serve frames on an open socket; resolves when the socket closes. */
  private serveWebSocket(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      ws.onmessage = (ev) => {
        if (this.ws !== ws) return; // a superseded socket's frames are noise
        this.lastInboundAt = Date.now();
        this.handleFrame(String(ev.data));
      };
      ws.onclose = (ev) => {
        // tails are per-connection state; watch frames re-arrive on reconnect
        this.stopAllLogTails();
        resolve({ code: ev.code, reason: String(ev.reason ?? "") });
      };
      ws.onerror = () => {
        // onclose follows; nothing to do here
      };
    });
  }

  private handleFrame(raw: string): void {
    let frame: CloudServerFrame | null = null;
    try {
      frame = JSON.parse(raw) as CloudServerFrame;
    } catch {
      return; // not JSON — ignore (forward-compat: unknown frames too)
    }
    if (!frame?.type) return;
    switch (frame.type) {
      case "hello":
        // handshake ack — registration is confirmed, the link is real
        this.confirmLink();
        break;
      case "command": {
        const cmd = frame.command;
        if (cmd?.id && cmd.type) {
          void this.handleCommand(cmd);
        }
        break;
      }
      case "log.watch":
        if (frame.process) this.startLogTail(frame.process);
        break;
      case "log.unwatch":
        if (frame.process) this.stopLogTail(frame.process);
        break;
      case "ping":
        this.sawServerPing = true;
        this.sendFrame({ type: "pong", now: Date.now() });
        break;
      case "event-ack":
        if (Array.isArray(frame.ids)) this.handleEventAck(frame.ids);
        break;
      default:
        break;
    }
  }

  /** The cloud's hello frame: the link is REAL (authenticated upstream). */
  private confirmLink(): void {
    if (this.linkConfirmed) return;
    this.linkConfirmed = true;
    this.confirmedAt = Date.now();
    this.streamState = "connected";
    this.backoffMs = 1000; // only a CONFIRMED link resets the ladder
    this.lastError = null;
    console.log(
      colorize("☁  cloud: connected — command channel live (cloud-confirmed)", "green")
    );
    // Fresh state right after (re)connecting — the dashboard lights up.
    void this.reportState().catch((err: unknown) =>
      ignore("cloud state report (post-connect)", err)
    );
  }

  /** Best-effort frame send — drops silently when the socket is closed. */
  private sendFrame(frame: CloudAgentFrame): boolean {
    const ws = this.ws;
    // Frames only flow on a CONFIRMED link: an unconfirmed open may be a
    // proxy mirage whose buffer would swallow them — sendFrame returning
    // true would then lie about delivery.
    if (!ws || !this.linkConfirmed || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      ignore("send cloud frame", err);
      return false;
    }
  }

  private handleRevoked(): void {
    this.running = false;
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.stopWatchdog();
    this.closeSocket(WS_CLOSE_REVOKED, "revoked");
    this.stopAllLogTails();
    this.outbox.length = 0; // unlinking — held events are moot
    this.streamState = "stopped";
    clearCloudConfig();
    this.cfg = null;
    console.error(
      colorize(
        "☁  cloud: credential revoked from the dashboard — re-link with `pboss cloud connect`",
        "yellow"
      )
    );
  }

  /* ── state reporting (every 10s and after each command) ─────────────── */

  private async reportState(): Promise<void> {
    if (!this.running || !this.cfg) return;
    const states = this.pm.list();
    const report = buildStateReport(this.cfg.serverId, states);
    // Events are TRANSITIONS — computed at observation time (true
    // timestamps, fresh crash log tails), stamped with a delivery id, and
    // queued. Sending is best-effort; DELIVERY is acked: the cloud replies
    // `event-ack` per ingested id, and only then does an event leave the
    // outbox. A crash that happens mid-blackout — even in the blind window
    // before the watchdog notices the dead socket — is therefore re-sent
    // after reconnect and still reaches the dashboard (the cloud dedups
    // by id, so at-least-once never becomes double-alerting).
    const events = diffEvents(this.lastSnapshot, report.processes);
    this.lastSnapshot = new Map(report.processes.map((p) => [p.name, p]));
    // crash events carry the log tail for the cloud's crash reports
    for (const ev of events) {
      if (ev.kind !== "crash") continue;
      try {
        const logs = await this.pm.getLogs(ev.process, 30);
        ev.logTail = crashLogTail(logs);
      } catch (err) {
        ignore(`read log tail for crash (${ev.process})`, err);
      }
    }
    if (events.length > 0) {
      for (const ev of events) ev.id ??= randomUUID();
      this.outbox.push(...events);
    }
    // Prune: TTL (a cloud that never acks has moved on) and hard cap.
    if (this.outbox.length > 0) {
      const cutoff = Date.now() - CLOUD_EVENT_TTL_MS;
      this.outbox = this.outbox.filter((ev) => ev.at >= cutoff);
      if (this.outbox.length > CLOUD_EVENT_OUTBOX_MAX) {
        this.outbox.splice(0, this.outbox.length - CLOUD_EVENT_OUTBOX_MAX);
      }
    }
    report.events = this.outbox.slice(0, 50);
    this.lastReport = report;

    if (this.sendFrame({ type: "state", report })) {
      this.lastReportAt = Date.now();
      // The outbox is NOT trimmed here — sendFrame returning true only
      // means the frame entered the local socket buffer, not that the
      // cloud ingested it. The ack owns the trim.
    } else {
      // Only when nothing more specific is on record: this generic skip
      // once MASKED the real failure for hours (the dial was being 401'd
      // upstream; the status just said "websocket not open").
      if (!this.lastError) {
        this.lastError =
          this.outbox.length > 0
            ? `websocket not open — ${this.outbox.length} event(s) queued for the next connection`
            : "websocket not open — state report skipped";
      }
    }
  }

  /** The cloud ingested these event ids — retire them from the outbox. */
  private handleEventAck(ids: string[]): void {
    if (ids.length === 0) return;
    const done = new Set(ids);
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((ev) => !(ev.id && done.has(ev.id)));
    if (this.outbox.length !== before && this.outbox.length === 0) {
      // last held event just retired — clear the stale error
      if (this.lastError?.includes("queued")) this.lastError = null;
    }
  }

  /* ── live log tails (log.watch / log.unwatch) ───────────────────────── */

  private startLogTail(process: string): void {
    if (this.logTails.has(process)) return; // idempotent — multiple watchers share one tail
    const stop = this.pm.watchProcessLogs(process, (lines) => {
      this.sendFrame({ type: "log", process, lines });
    });
    if (stop) {
      this.logTails.set(process, stop);
    }
  }

  private stopLogTail(process: string): void {
    const stop = this.logTails.get(process);
    stop?.();
    this.logTails.delete(process);
  }

  private stopAllLogTails(): void {
    for (const stop of this.logTails.values()) stop();
    this.logTails.clear();
  }

  /* ── command execution (local, against this daemon's process engine) ── */

  private async handleCommand(cmd: CloudCommand): Promise<void> {
    let result: CloudCommandResult;
    try {
      const data = await this.executeCommand(cmd);
      result = { commandId: cmd.id, success: true, data };
    } catch (err: any) {
      result = { commandId: cmd.id, success: false, error: err?.message ?? String(err) };
    }
    this.sendFrame({ type: "command-result", result });
    // the dashboard expects fresh state right after a command
    await this.reportState().catch((err: unknown) => ignore("cloud state report (post-command)", err));
  }

  private async executeCommand(cmd: CloudCommand): Promise<unknown> {
    const target = typeof cmd.payload?.target === "string" ? cmd.payload.target : "";
    switch (cmd.type) {
      case "process.list":
        return this.pm.list().map(mapProcessState);

      case "process.start": {
        if (!target) throw new Error("process.start requires a target");
        const state = this.findState(target);
        if (!state) throw new Error(`no process named "${target}"`);
        if (state.status === "online") throw new Error(`"${target}" is already online`);
        const opts = startOptionsFromState(state);
        return (await this.pm.start(opts)).map(mapProcessState);
      }

      case "process.stop":
        if (!target) throw new Error("process.stop requires a target");
        return (await this.pm.stop(target)).map(mapProcessState);

      case "process.kill":
        // force-stop (SIGKILL path): unlike process.stop there is no
        // graceful SIGTERM window — for a wedged process. The process
        // row survives (unlike process.delete).
        if (!target) throw new Error("process.kill requires a target");
        return (await this.pm.kill(target)).map(mapProcessState);

      case "process.restart":
        if (!target) throw new Error("process.restart requires a target");
        return (await this.pm.restart(target)).map(mapProcessState);

      case "process.delete":
        if (!target) throw new Error("process.delete requires a target");
        return (await this.pm.del(target)).map(mapProcessState);

      case "process.logs": {
        const lines = Math.min(500, Math.max(10, Number(cmd.payload?.lines) || 200));
        const logs: LogItem[] = await this.pm.getLogs(target || "all", lines);
        return logs;
      }

      case "process.deploy":
      case "server.deploy": {
        const scope =
          cmd.type === "server.deploy"
            ? this.pm.list().filter((p) => p.status === "online" || p.status === "stopped")
            : [this.findState(target)].filter(Boolean) as ProcessState[];
        if (cmd.type === "process.deploy" && scope.length === 0) {
          throw new Error(`no process named "${target}"`);
        }
        const results: Array<Record<string, unknown>> = [];
        for (const p of scope) {
          const env = p.pboss_env ?? p.bm2_env;
          const cwd = env?.cwd || (env?.script ? dirname(env.script) : "");
          const t0 = Date.now();
          const pull = await gitPull(cwd); // throws honest errors on a bad repo
          let restart: boolean = false;
          if (pull.pulled) {
            await this.pm.restart(p.name);
            restart = true;
          }
          results.push({
            process: p.name,
            commit: pull.commit,
            message: pull.message,
            branch: pull.branch,
            remote: pull.remote,
            pulled: pull.pulled,
            restart,
            durationMs: Date.now() - t0,
          });
        }
        // single-process deploys unwrap; server deploys return the list
        if (cmd.type === "process.deploy" && results.length === 1) return results[0];
        return results;
      }

      case "server.info": {
        const sys = getSystemInfo();
        return {
          hostname: sys.hostname,
          platform: sys.platform,
          cpuCount: sys.cpuCount,
          totalMemory: sys.totalMemory,
          freeMemory: sys.freeMemory,
          loadAvg: sys.loadAvg,
          uptime: sys.uptime,
          bunVersion: Bun.version,
          pbossVersion: VERSION,
          processes: this.pm.list().length,
          cloud: { serverId: this.cfg!.serverId, url: this.cfg!.cloudUrl },
        };
      }

      /* ── auto-deploy pipeline (long-running; see deploy-job.ts) ── */

      case "process.gitinfo": {
        if (!target) throw new Error("process.gitinfo requires a target");
        return gitInfoForProcess(this.pm, target);
      }

      case "deploy.run": {
        // FAST-ACK pattern: the command result returns the moment the job
        // is accepted; the pipeline itself streams deploy.progress frames
        // and ends with a terminal done frame (the cloud's 20s command
        // timeout could never carry a full build).
        const p = cmd.payload as unknown as DeployRunPayload;
        if (!p?.deploymentId || !p.commitSha || !p.processName || !p.repoUrl) {
          throw new Error("deploy.run requires deploymentId, repoUrl, commitSha, processName");
        }
        if (deployJobRunning(p.deploymentId)) {
          return { accepted: true, alreadyRunning: true };
        }
        void runDeployJob(
          { sendFrame: (frame) => this.sendFrame(frame), pm: this.pm },
          p,
        ).catch((err: unknown) => {
          // runDeployJob reports its own failures through progress frames;
          // this catch is for errors BEFORE the first frame (e.g. mkdir)
          this.sendFrame({
            type: "deploy.progress",
            progress: {
              deploymentId: p.deploymentId,
              step: "done",
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        });
        return { accepted: true };
      }

      case "deploy.cancel": {
        const id = typeof cmd.payload?.deploymentId === "string" ? cmd.payload.deploymentId : "";
        if (!id) throw new Error("deploy.cancel requires deploymentId");
        return { cancelled: cancelDeployJob(id) };
      }

      default:
        throw new Error(`unknown command type: ${(cmd as CloudCommand).type}`);
    }
  }

  private findState(target: string): ProcessState | undefined {
    const list = this.pm.list();
    return list.find(
      (p) => p.name === target || String(p.pm_id) === target || String(p.id) === target
    );
  }
}

/**
 * `git pull --ff-only` in a working directory — the cloud deploy primitive.
 * Returns the HEAD commit/message/branch and whether anything was pulled.
 * Honest errors: not a repo / pull refused / git missing.
 */
export async function gitPull(
  cwd: string
): Promise<{
  pulled: boolean;
  commit: string;
  message: string;
  branch: string;
  remote: string | null;
}> {
  if (!cwd) throw new Error("no working directory for this process");
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        `git ${args[0]} failed in ${cwd}: ${(stderr || stdout).trim().split("\n")[0]?.slice(0, 160)}`
      );
    }
    return stdout.trim();
  };

  // a .git dir (or worktree file) must exist — honest error otherwise
  const check = await Bun.spawn(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await check.exited) !== 0) {
    throw new Error(
      `${cwd} is not a git repository — the cloud can only deploy git checkouts`
    );
  }

  const pullOut = await git("pull", "--ff-only");
  const pulled = !/^already up to date/i.test(pullOut.split("\n")[0] ?? "");
  const commit = (await git("rev-parse", "--short", "HEAD")) || "";
  const message = (await git("log", "-1", "--pretty=%s")) || "";
  const branch = (await git("branch", "--show-current")) || "(detached)";
  let remoteRaw = "";
  try {
    remoteRaw = await git("config", "--get", "remote.origin.url");
  } catch (err) {
    // no origin remote configured — the deploy still works; the repo shows as null
    ignore(`read remote origin url (${cwd})`, err);
  }
  const remote = remoteRaw ? remoteRaw.replace(/\.git$/, "") : null;
  return { pulled, commit, message, branch, remote };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
