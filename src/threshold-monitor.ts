/**
 * ProcBoss (pboss) — Resource Threshold Monitor
 *
 * The agent-side alerting engine: turns the metric samples the cloud
 * agent already collects every report tick (10s) into threshold events
 * (CPU spikes, memory leaks, restart loops, event-loop blocking, handle
 * growth, whole-box pressure) that ride the EXISTING event outbox —
 * ack, dedup, TTL and cap are inherited, not rebuilt.
 *
 * Pure by design: evaluate() takes snapshots in, returns CloudEventReport[]
 * out, and knows nothing about WebSockets. The same monitor can drive a
 * local surface (CLI) with no cloud link at all.
 *
 * Each (process, metric) pair — and (server, metric) for the system ones —
 * runs a small hysteresis state machine:
 *
 *   normal → watching → triggered → clearing → normal
 *
 *   normal → watching      sample crosses the trigger level (streak starts)
 *   watching → triggered   streak held ≥ sustainedSec → EMIT the alert
 *   watching → normal      sample dropped back before the streak elapsed
 *                          (a blip, not a condition — no event)
 *   triggered → clearing   sample under the CLEAR level (lower than trigger
 *                          so it cannot flap at the boundary)
 *   clearing → normal      clear-streak held ≥ sustainedSec → EMIT .recovered
 *                          with the total elevated duration
 *   triggered (stays)      re-emits a low-frequency "still elevated"
 *                          heartbeat (default every 10 min)
 *
 * Restart-loop is the exception: a rolling count over a window, not a
 * level — it arms once when the count is reached and self-clears as old
 * restarts age out of the window (no recovered event by design).
 *
 * State lives in memory only, keyed by process name + metric. A daemon
 * restart simply re-learns over the next few samples — no persistence, no
 * stale alerts after a reboot.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ALERT_THRESHOLDS_FILE } from "./constants";
import { ignore } from "./error-handling";
import type { CloudEventReport, CloudProcessReport } from "./cloud";

/* ── configuration shape (mirrors ~/.pboss/alert-thresholds.json) ─────── */

/** A level metric: cross `trigger` to arm, drop under `clear` to recover. */
export interface ThresholdLevel {
  trigger: number;
  clear: number;
  /** The streak must hold this long before the alert fires (blips pass). */
  sustainedSec: number;
}

/** Memory-spike detection: growth RATE within a window, plus an absolute
 *  floor so tiny processes cannot flap on 3MB blips. */
export interface MemSpikeConfig {
  /** Percent growth within the window that counts as a spike. */
  trigger: number;
  /** Growth rate below this (percent per window) counts as calmed down. */
  clear: number;
  windowSec: number;
  /** Absolute growth floor in MB — cancels the spike on small processes. */
  minDeltaMB: number;
}

/** Memory near the ceiling: only meaningful with a configured limit. */
export interface MemHighConfig extends ThresholdLevel {
  /** Optional absolute ceiling (MB) for processes without maxMemoryRestart
   *  — off by default: without a limit "high" is unknowable per-app. */
  absoluteMB?: number | null;
}

/** Restart/crash loop: N restarts inside a rolling window. */
export interface RestartLoopConfig {
  count: number;
  windowSec: number;
}

/** Handle/FD growth: relative to a baseline sampled `baselineWindowSec`
 *  ago (no ulimit knowledge needed), with an absolute noise floor. */
export interface HandleGrowthConfig {
  multiplier: number;
  /** Clear ratio (× baseline). */
  clearMultiplier: number;
  minAbsolute: number;
  baselineWindowSec: number;
  sustainedSec: number;
}

/** Per-process thresholds (also the `defaults` block). */
export interface ProcessThresholds {
  cpuSpikePercent: ThresholdLevel;
  cpuSustainedPercent: ThresholdLevel;
  memSpikeGrowthPercent: MemSpikeConfig;
  memHighPercentOfLimit: MemHighConfig;
  restartLoop: RestartLoopConfig;
  eventLoopLatencyMs: ThresholdLevel;
  handleGrowth: HandleGrowthConfig;
}

/** Whole-server thresholds (the `system` block). */
export interface SystemThresholds {
  cpuPercent: ThresholdLevel;
  /** Trigger = free memory at or BELOW this percent; clear = above. */
  memFreePercent: ThresholdLevel;
}

export interface ThresholdConfig {
  system: SystemThresholds;
  defaults: ProcessThresholds;
  /** Per-process overrides (name → partial thresholds). */
  overrides: Record<string, Partial<ProcessThresholds>>;
}

/* ── defaults (the brief's table, verbatim) ───────────────────────────── */

export const DEFAULT_THRESHOLD_CONFIG: ThresholdConfig = {
  system: {
    // 1-min load ÷ cores ≥ 0.85 (the agent's sys.cpu is exactly that,
    // expressed as a percent) — the box as a whole is saturated.
    cpuPercent: { trigger: 85, clear: 65, sustainedSec: 300 },
    // < 10% free RAM is OOM-killer risk for everything on the box.
    memFreePercent: { trigger: 10, clear: 20, sustainedSec: 120 },
  },
  defaults: {
    // Short bursts to ~90% are normal (GC, startup); 95%+ held for half
    // a minute is a runaway loop or a stuck request.
    cpuSpikePercent: { trigger: 95, clear: 80, sustainedSec: 30 },
    // 5 minutes at 70%+ = capacity-constrained, not just busy.
    cpuSustainedPercent: { trigger: 70, clear: 55, sustainedSec: 300 },
    // ≥ 40% growth within 60s AND ≥ 20MB absolute — the MB floor stops a
    // 5MB→8MB blip on a tiny process from counting as a leak.
    memSpikeGrowthPercent: { trigger: 40, clear: 10, windowSec: 60, minDeltaMB: 20 },
    // Early warning BEFORE the auto-restart-at-100% fires — turns a
    // silent maxMemoryRestart into an actionable alert.
    memHighPercentOfLimit: { trigger: 85, clear: 70, sustainedSec: 60, absoluteMB: null },
    // 5 restarts in a rolling 5 minutes (same rule of thumb pm2 uses).
    restartLoop: { count: 5, windowSec: 300 },
    // 100ms of blocked event loop is user-visible latency.
    eventLoopLatencyMs: { trigger: 100, clear: 50, sustainedSec: 30 },
    // 3× the value from 10 min ago AND ≥ 200 open handles, held 5 min.
    handleGrowth: {
      multiplier: 3,
      clearMultiplier: 1.5,
      minAbsolute: 200,
      baselineWindowSec: 600,
      sustainedSec: 300,
    },
  },
  overrides: {},
};

/** "Still elevated" heartbeat while a condition stays triggered. */
export const ALERT_HEARTBEAT_SEC = 600;

/** The process name on server-wide events — a name no real process
 *  should ever hold (pboss rejects "__" names? no — it is simply a
 *  sentinel the cloud displays as "system"). */
export const SYSTEM_PROCESS_NAME = "__system__";

/* ── config file ──────────────────────────────────────────────────────── */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Deep-merge a user's partial level config onto a default one. */
function mergeLevel(
  raw: Record<string, unknown> | undefined,
  dflt: ThresholdLevel
): ThresholdLevel {
  if (!raw) return dflt;
  return {
    trigger: num(raw.trigger, dflt.trigger),
    clear: num(raw.clear, dflt.clear),
    sustainedSec: num(raw.sustainedSec, dflt.sustainedSec),
  };
}

function mergeMemSpike(
  raw: Record<string, unknown> | undefined,
  dflt: MemSpikeConfig
): MemSpikeConfig {
  if (!raw) return dflt;
  return {
    trigger: num(raw.trigger, dflt.trigger),
    clear: num(raw.clear, dflt.clear),
    windowSec: num(raw.windowSec, dflt.windowSec),
    minDeltaMB: num(raw.minDeltaMB, dflt.minDeltaMB),
  };
}

function mergeMemHigh(
  raw: Record<string, unknown> | undefined,
  dflt: MemHighConfig
): MemHighConfig {
  const base = mergeLevel(raw, dflt);
  return {
    ...base,
    absoluteMB:
      raw?.absoluteMB === null
        ? null
        : raw?.absoluteMB === undefined
          ? (dflt.absoluteMB ?? null)
          : num(raw.absoluteMB, dflt.absoluteMB ?? 0),
  };
}

function mergeRestartLoop(
  raw: Record<string, unknown> | undefined,
  dflt: RestartLoopConfig
): RestartLoopConfig {
  if (!raw) return dflt;
  return { count: num(raw.count, dflt.count), windowSec: num(raw.windowSec, dflt.windowSec) };
}

function mergeHandleGrowth(
  raw: Record<string, unknown> | undefined,
  dflt: HandleGrowthConfig
): HandleGrowthConfig {
  if (!raw) return dflt;
  return {
    multiplier: num(raw.multiplier, dflt.multiplier),
    clearMultiplier: num(raw.clearMultiplier, dflt.clearMultiplier),
    minAbsolute: num(raw.minAbsolute, dflt.minAbsolute),
    baselineWindowSec: num(raw.baselineWindowSec, dflt.baselineWindowSec),
    sustainedSec: num(raw.sustainedSec, dflt.sustainedSec),
  };
}

function mergeProcessThresholds(
  raw: Record<string, unknown> | undefined,
  dflt: ProcessThresholds
): ProcessThresholds {
  if (!raw) return dflt;
  return {
    cpuSpikePercent: mergeLevel(raw.cpuSpikePercent as never, dflt.cpuSpikePercent),
    cpuSustainedPercent: mergeLevel(raw.cpuSustainedPercent as never, dflt.cpuSustainedPercent),
    memSpikeGrowthPercent: mergeMemSpike(raw.memSpikeGrowthPercent as never, dflt.memSpikeGrowthPercent),
    memHighPercentOfLimit: mergeMemHigh(raw.memHighPercentOfLimit as never, dflt.memHighPercentOfLimit),
    restartLoop: mergeRestartLoop(raw.restartLoop as never, dflt.restartLoop),
    eventLoopLatencyMs: mergeLevel(raw.eventLoopLatencyMs as never, dflt.eventLoopLatencyMs),
    handleGrowth: mergeHandleGrowth(raw.handleGrowth as never, dflt.handleGrowth),
  };
}

/**
 * Read ~/.pboss/alert-thresholds.json onto the defaults. Tolerant: a
 * missing file, partial JSON or wrong types all degrade to the defaults
 * (recorded, never thrown — alerting must not take the daemon down).
 */
export function loadThresholdConfig(path = ALERT_THRESHOLDS_FILE): ThresholdConfig {
  const base = DEFAULT_THRESHOLD_CONFIG;
  try {
    if (!existsSync(path)) return base;
    const raw = JSON.parse(readFileSync(path, "utf-8") as string) as Record<string, unknown>;
    const overrides: Record<string, Partial<ProcessThresholds>> = {};
    if (raw.overrides && typeof raw.overrides === "object") {
      for (const [name, o] of Object.entries(raw.overrides as Record<string, unknown>)) {
        if (o && typeof o === "object") {
          overrides[name] = mergeProcessThresholds(o as never, base.defaults);
        }
      }
    }
    return {
      system: {
        cpuPercent: mergeLevel(
          (raw.system as never as Record<string, unknown>)?.cpuPercent as never,
          base.system.cpuPercent
        ),
        memFreePercent: mergeLevel(
          (raw.system as never as Record<string, unknown>)?.memFreePercent as never,
          base.system.memFreePercent
        ),
      },
      defaults: mergeProcessThresholds(raw.defaults as never, base.defaults),
      overrides,
    };
  } catch (err) {
    ignore(`read threshold config ${path}`, err);
    return base;
  }
}

/** Persist the full config (mkdir-safe, best-effort chmod like cloud.json). */
export function saveThresholdConfig(
  cfg: ThresholdConfig,
  path = ALERT_THRESHOLDS_FILE
): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    // exists already — writeFileSync reports the honest error below
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

/**
 * Apply a partial patch (CLI `pboss alerts set` / cloud `config.alerts.set`)
 * onto a config. `target` is a process name, `"system"`, or absent for the
 * defaults block. Returns the NEW config (pure — input untouched).
 */
export function patchThresholdConfig(
  cfg: ThresholdConfig,
  target: string | undefined,
  patch: Record<string, unknown>
): ThresholdConfig {
  const next: ThresholdConfig = JSON.parse(JSON.stringify(cfg));
  if (target === "system") {
    next.system = {
      cpuPercent: mergeLevel(patch.cpuPercent as never, next.system.cpuPercent),
      memFreePercent: mergeLevel(patch.memFreePercent as never, next.system.memFreePercent),
    };
    return next;
  }
  const merged = mergeProcessThresholds(patch as never, next.defaults);
  if (target) {
    next.overrides[target] = merged;
  } else {
    next.defaults = merged;
  }
  return next;
}

/**
 * Effective thresholds for one process: defaults ← file override ←
 * ecosystem/StartOptions alert fields. `alertDisabled` suppresses every
 * process metric for that app.
 */
export interface ProcessAlertOptions {
  alertCpuSpikePercent?: number;
  alertCpuSustainedPercent?: number;
  alertMemSpikeGrowthPercent?: number;
  alertMemHighPercent?: number;
  alertMemHighMB?: number;
  alertDisabled?: boolean;
}

export function effectiveProcessThresholds(
  cfg: ThresholdConfig,
  processName: string,
  opts?: ProcessAlertOptions
): ProcessThresholds {
  let t = mergeProcessThresholds(
    cfg.overrides[processName] as never,
    cfg.defaults
  );
  if (opts?.alertCpuSpikePercent !== undefined) {
    t.cpuSpikePercent = { ...t.cpuSpikePercent, trigger: opts.alertCpuSpikePercent };
  }
  if (opts?.alertCpuSustainedPercent !== undefined) {
    t.cpuSustainedPercent = { ...t.cpuSustainedPercent, trigger: opts.alertCpuSustainedPercent };
  }
  if (opts?.alertMemSpikeGrowthPercent !== undefined) {
    t.memSpikeGrowthPercent = {
      ...t.memSpikeGrowthPercent,
      trigger: opts.alertMemSpikeGrowthPercent,
    };
  }
  if (opts?.alertMemHighPercent !== undefined) {
    t.memHighPercentOfLimit = { ...t.memHighPercentOfLimit, trigger: opts.alertMemHighPercent };
  }
  if (opts?.alertMemHighMB !== undefined) {
    t.memHighPercentOfLimit = { ...t.memHighPercentOfLimit, absoluteMB: opts.alertMemHighMB };
  }
  return t;
}

/* ── the monitor ──────────────────────────────────────────────────────── */

/** Extra per-process facts the report already computed (no new polling). */
export interface ProcessExtra {
  eventLoopLatency?: number;
  handles?: number;
  /** maxMemoryRestart in MB (bytes ÷ 1024²) — absent when unconfigured. */
  maxMemoryMB?: number;
  /** Ecosystem/StartOptions alert fields for this process. */
  alerts?: ProcessAlertOptions;
}

type Phase = "normal" | "watching" | "triggered" | "clearing";

interface Streak {
  phase: Phase;
  since: number;
  /** When the condition actually fired (durationSec on recovery). */
  elevatedSince: number;
  /** Last emitted event time (heartbeat throttle while triggered). */
  lastEventAt: number;
  /** Handle-growth baseline, FROZEN while a streak is live. */
  baseline?: number;
}

interface RateState {
  /** (t, value) ring used by the growth metrics. */
  samples: Array<{ t: number; v: number }>;
  phase: "normal" | "triggered";
  elevatedSince: number;
}

interface LoopState {
  lastRestarts: number;
  restarts: number[];
  armed: boolean;
}

export type MetricFamilies =
  | "cpu"
  | "mem"
  | "eventloop"
  | "handles"
  | "system";

/** Wire kinds per family — single `.recovered` per family, per the protocol. */
const FAMILY_RECOVERED: Record<MetricFamilies, CloudEventReport["kind"]> = {
  cpu: "cpu.recovered",
  mem: "mem.recovered",
  eventloop: "eventloop.recovered",
  handles: "handles.recovered",
  system: "system.recovered",
};

export class ThresholdMonitor {
  private config: ThresholdConfig;
  private streaks = new Map<string, Streak>();
  private rates = new Map<string, RateState>();
  private loops = new Map<string, LoopState>();
  /** Last-seen samples per process name — lets us prune vanished state. */
  private seen = new Set<string>();

  constructor(config: ThresholdConfig = loadThresholdConfig()) {
    this.config = config;
  }

  /** Hot-reload (config.alerts.set / `pboss alerts set`) — in-flight
   *  streaks keep running against the new levels. */
  updateConfig(config: ThresholdConfig): void {
    this.config = config;
  }

  get currentConfig(): ThresholdConfig {
    return this.config;
  }

  /**
   * One evaluation pass — call once per report tick with the data
   * buildStateReport() already computed. Pure output: the events to
   * enqueue (the caller owns ids/delivery).
   */
  evaluate(
    processes: CloudProcessReport[],
    sys: { cpu: number; memUsed: number; memTotal: number },
    extra: Map<string, ProcessExtra>,
    now: number = Date.now()
  ): CloudEventReport[] {
    const events: CloudEventReport[] = [];
    this.seen = new Set(processes.map((p) => p.name));

    for (const p of processes) {
      const x = extra.get(p.name) ?? {};
      // Restart-loop tracking runs for every process regardless of status
      // (the counter climbs while crashing); level metrics only make
      // sense while the process is online.
      this.trackRestartLoop(p, events, now);
      if (p.status !== "online") continue;
      const t = effectiveProcessThresholds(this.config, p.name, x.alerts);
      if (x.alerts?.alertDisabled === true) continue;

      this.levelMetric(events, `${p.name}\0cpuSpike`, "cpu", "cpu.spike", p.name, p.cpu, t.cpuSpikePercent, "above", now, "%");
      this.levelMetric(events, `${p.name}\0cpuSustained`, "cpu", "cpu.sustained", p.name, p.cpu, t.cpuSustainedPercent, "above", now, "%");
      this.levelMetric(events, `${p.name}\0eventLoop`, "eventloop", "eventloop.latency", p.name, x.eventLoopLatency ?? 0, t.eventLoopLatencyMs, "above", now, "ms");
      this.memoryMetrics(events, p, x, t, now);
      this.handleMetric(events, p, x, t, now);
    }

    // System-wide metrics — "__system__" is the sentinel process name.
    this.levelMetric(events, "__system__\0sysCpu", "system", "system.cpu.high", SYSTEM_PROCESS_NAME, sys.cpu, this.config.system.cpuPercent, "above", now, "%");
    const freePct = sys.memTotal > 0
      ? Math.max(0, Math.round(((sys.memTotal - sys.memUsed) / sys.memTotal) * 100))
      : 100;
    this.levelMetric(events, "__system__\0sysMem", "system", "system.mem.high", SYSTEM_PROCESS_NAME, freePct, this.config.system.memFreePercent, "below", now, "% free");

    this.prune();
    return events;
  }

  /** Effective thresholds for `pboss alerts show` (defaults + overrides
   *  merged, plus the live process list with their per-app overrides). */
  summary(processes: CloudProcessReport[], extra: Map<string, ProcessExtra>): {
    system: SystemThresholds;
    defaults: ProcessThresholds;
    overrides: Record<string, Partial<ProcessThresholds>>;
    effective: Array<{ process: string; disabled: boolean; thresholds: ProcessThresholds }>;
  } {
    return {
      system: this.config.system,
      defaults: this.config.defaults,
      overrides: this.config.overrides,
      effective: processes.map((p) => {
        const x = extra.get(p.name) ?? {};
        return {
          process: p.name,
          disabled: x.alerts?.alertDisabled === true,
          thresholds: effectiveProcessThresholds(this.config, p.name, x.alerts),
        };
      }),
    };
  }

  /**
   * A synthetic event for `pboss alerts test <process> <kind>` — verifies
   * the whole delivery chain (outbox → cloud → Telegram/Discord/webhook)
   * without waiting for a real spike. Never touches evaluation state.
   */
  syntheticEvent(process: string, kind: string, now: number = Date.now()): CloudEventReport | null {
    const aliases: Record<string, CloudEventReport["kind"]> = {
      "cpu.spike": "cpu.spike", "cpu-spike": "cpu.spike", cpu: "cpu.spike",
      "cpu.sustained": "cpu.sustained", "cpu-sustained": "cpu.sustained",
      "mem.spike": "mem.spike", "mem-spike": "mem.spike", mem: "mem.spike",
      "mem.high": "mem.high", "mem-high": "mem.high",
      "restart.loop": "restart.loop", "restart-loop": "restart.loop", restart: "restart.loop",
      "eventloop.latency": "eventloop.latency", eventloop: "eventloop.latency",
      "handles.leak": "handles.leak", handles: "handles.leak",
      "system.cpu.high": "system.cpu.high", "system-cpu": "system.cpu.high",
      "system.mem.high": "system.mem.high", "system-mem": "system.mem.high",
    };
    const k = aliases[kind.toLowerCase()];
    if (!k) return null;
    return {
      kind: k,
      process: k.startsWith("system.") ? SYSTEM_PROCESS_NAME : process,
      at: now,
      detail: "synthetic test alert (pboss alerts test) — verifies the delivery chain",
      metricValue: 0,
      thresholdValue: 0,
    };
  }

  /* ── level metrics (cpu spike/sustained, eventloop, memHigh, system) ── */

  private levelMetric(
    out: CloudEventReport[],
    key: string,
    family: MetricFamilies,
    kind: CloudEventReport["kind"],
    process: string,
    value: number,
    level: ThresholdLevel,
    direction: "above" | "below",
    now: number,
    unit: string
  ): void {
    let s = this.streaks.get(key);
    if (!s) {
      s = { phase: "normal", since: now, elevatedSince: now, lastEventAt: 0 };
      this.streaks.set(key, s);
    }
    const crossed =
      direction === "above" ? value >= level.trigger : value <= level.trigger;
    const calmed =
      direction === "above" ? value < level.clear : value > level.clear;

    if (s.phase === "normal" || s.phase === "clearing") {
      if (crossed) {
        s.phase = "watching";
        s.since = now;
      } else if (s.phase === "clearing" && now - s.since >= level.sustainedSec * 1000) {
        // the clear-streak held — the condition is over
        s.phase = "normal";
        out.push({
          kind: FAMILY_RECOVERED[family],
          process,
          at: now,
          detail: `${kind} recovered (held under the clear level for ${level.sustainedSec}s)`,
          metricValue: round1(value),
          thresholdValue: level.clear,
          durationSec: Math.round((now - s.elevatedSince) / 1000),
        });
      }
      return;
    }

    if (s.phase === "watching") {
      if (!crossed) {
        // dropped back before the streak elapsed — a blip, not a condition
        s.phase = "normal";
        return;
      }
      if (now - s.since >= level.sustainedSec * 1000) {
        s.phase = "triggered";
        s.elevatedSince = s.since;
        s.lastEventAt = now;
        out.push({
          kind,
          process,
          at: now,
          detail: `${process} ${labelOf(kind)} — ${round1(value)}${unit} (threshold ${level.trigger}${unit}, held ${Math.round((now - s.since) / 1000)}s)`,
          metricValue: round1(value),
          thresholdValue: level.trigger,
        });
      }
      return;
    }

    // triggered — heartbeat while it stays elevated, recovered via clear
    if (calmed) {
      s.phase = "clearing";
      s.since = now;
      return;
    }
    if (crossed && now - s.lastEventAt >= ALERT_HEARTBEAT_SEC * 1000) {
      s.lastEventAt = now;
      out.push({
        kind,
        process,
        at: now,
        detail: `still elevated: ${round1(value)}${unit} (threshold ${level.trigger}${unit}, ${Math.round((now - s.elevatedSince) / 1000)}s so far)`,
        metricValue: round1(value),
        thresholdValue: level.trigger,
        durationSec: Math.round((now - s.elevatedSince) / 1000),
      });
    }
  }

  /* ── memory metrics: spike (rate) + high (level vs limit) ───────────── */

  private memoryMetrics(
    out: CloudEventReport[],
    p: CloudProcessReport,
    x: ProcessExtra,
    t: ProcessThresholds,
    now: number
  ): void {
    const cfg = t.memSpikeGrowthPercent;
    let r = this.rates.get(`${p.name}\0mem`);
    if (!r) {
      r = { samples: [], phase: "normal", elevatedSince: now };
      this.rates.set(`${p.name}\0mem`, r);
    }
    r.samples.push({ t: now, v: p.mem });
    const cutoff = now - cfg.windowSec * 1000;
    while (r.samples.length > 2 && r.samples[0]!.t < cutoff) r.samples.shift();

    const oldest = r.samples[0];
    if (oldest && oldest.v > 0 && oldest.t <= cutoff) {
      const pct = ((p.mem - oldest.v) / oldest.v) * 100;
      const deltaMB = p.mem - oldest.v;
      const spiking = pct >= cfg.trigger && deltaMB >= cfg.minDeltaMB;
      const calmed = pct < cfg.clear;
      if (r.phase === "normal" && spiking) {
        r.phase = "triggered";
        r.elevatedSince = now;
        out.push({
          kind: "mem.spike",
          process: p.name,
          at: now,
          detail: `memory grew ${Math.round(pct)}% (+${Math.round(deltaMB)}MB) in ${cfg.windowSec}s — possible leak (${p.mem}MB now)`,
          metricValue: round1(pct),
          thresholdValue: cfg.trigger,
        });
      } else if (r.phase === "triggered" && calmed) {
        r.phase = "normal";
        out.push({
          kind: "mem.recovered",
          process: p.name,
          at: now,
          detail: "memory growth calmed below the clear rate",
          metricValue: round1(pct),
          thresholdValue: cfg.clear,
          durationSec: Math.round((now - r.elevatedSince) / 1000),
        });
      }
    }

    // memHigh — only with a ceiling: maxMemoryRestart (from the process
    // config) or an explicit alertMemHighMB override. Without a limit
    // "high" is unknowable per-app, so it stays off by default. The level
    // machine runs on PERCENT-OF-LIMIT so the configured trigger/clear
    // (85/70) mean what they say.
    const limitMB = x.maxMemoryMB ?? t.memHighPercentOfLimit.absoluteMB ?? undefined;
    if (limitMB !== undefined && limitMB > 0 && p.mem >= 0) {
      const pctOfLimit = (p.mem / limitMB) * 100;
      const before = out.length;
      this.levelMetric(
        out,
        `${p.name}\0memHigh`,
        "mem",
        "mem.high",
        p.name,
        pctOfLimit,
        { trigger: t.memHighPercentOfLimit.trigger, clear: t.memHighPercentOfLimit.clear, sustainedSec: t.memHighPercentOfLimit.sustainedSec },
        "above",
        now,
        "% of limit"
      );
      // enrich the just-pushed mem.high with the MB facts (detail reads
      // better with both numbers; metricValue stays the percent)
      const last = out[out.length - 1];
      if (out.length > before && last && last.kind === "mem.high" && last.process === p.name) {
        last.detail = `${p.name} at ${Math.round(pctOfLimit)}% of its ${Math.round(limitMB)}MB limit (${p.mem}MB) — early warning before the maxMemoryRestart auto-restart`;
      }
    }
  }

  /* ── handle/FD growth (baseline-relative) ───────────────────────────── */

  private handleMetric(
    out: CloudEventReport[],
    p: CloudProcessReport,
    x: ProcessExtra,
    t: ProcessThresholds,
    now: number
  ): void {
    if (x.handles === undefined || x.handles <= 0) return;
    const cfg = t.handleGrowth;
    let r = this.rates.get(`${p.name}\0handles`);
    if (!r) {
      r = { samples: [], phase: "normal", elevatedSince: now };
      this.rates.set(`${p.name}\0handles`, r);
    }
    r.samples.push({ t: now, v: x.handles });
    const cutoff = now - cfg.baselineWindowSec * 1000;
    while (r.samples.length > 2 && r.samples[0]!.t < cutoff) r.samples.shift();

    let s = this.streaks.get(`${p.name}\0handles`);
    if (!s) {
      s = { phase: "normal", since: now, elevatedSince: now, lastEventAt: 0, baseline: undefined };
      this.streaks.set(`${p.name}\0handles`, s);
    }

    // The baseline FROZES when a streak starts: a persistent leak would
    // otherwise become its own baseline once the pre-leak samples age out
    // of the window (10 min later, "3× the value from 10 min ago" is 1×
    // and the alert silently dissolves). While normal, the baseline is
    // recomputed from the live window each tick.
    const baselineSample = r.samples[0];
    const windowBaseline =
      baselineSample && baselineSample.t <= cutoff && baselineSample.v > 0
        ? baselineSample.v
        : undefined;
    const baseline = s.phase === "normal" ? windowBaseline : s.baseline;
    if (baseline === undefined || baseline <= 0) return; // no baseline yet
    if (s.phase === "normal" && windowBaseline !== undefined) s.baseline = windowBaseline;

    const ratio = x.handles / baseline;
    const elevated = ratio >= cfg.multiplier && x.handles >= cfg.minAbsolute;
    const calmed = ratio < cfg.clearMultiplier;

    if (s.phase === "normal" || s.phase === "clearing") {
      if (elevated) {
        if (s.phase === "normal") {
          s.phase = "watching";
          s.since = now;
          s.baseline = baseline; // freeze for the life of this streak
        }
      } else if (s.phase === "clearing" && calmed && now - s.since >= cfg.sustainedSec * 1000) {
        s.phase = "normal";
        out.push({
          kind: "handles.recovered",
          process: p.name,
          at: now,
          detail: `handle count back to ${Math.round(ratio * 100)}% of baseline`,
          metricValue: x.handles,
          thresholdValue: Math.round(baseline * cfg.clearMultiplier),
          durationSec: Math.round((now - s.elevatedSince) / 1000),
        });
      }
      return;
    }
    if (s.phase === "watching") {
      if (!elevated) {
        s.phase = "normal";
        return;
      }
      if (now - s.since >= cfg.sustainedSec * 1000) {
        s.phase = "triggered";
        s.elevatedSince = s.since;
        s.lastEventAt = now;
        out.push({
          kind: "handles.leak",
          process: p.name,
          at: now,
          detail: `${x.handles} open handles — ${Math.round(ratio * 100) / 100}× the ${cfg.baselineWindowSec}s-ago baseline (${baseline}), held ${Math.round((now - s.since) / 1000)}s`,
          metricValue: x.handles,
          thresholdValue: Math.round(baseline * cfg.multiplier),
        });
      }
      return;
    }
    // triggered
    if (calmed) {
      s.phase = "clearing";
      s.since = now;
    } else if (now - s.lastEventAt >= ALERT_HEARTBEAT_SEC * 1000) {
      s.lastEventAt = now;
      out.push({
        kind: "handles.leak",
        process: p.name,
        at: now,
        detail: `still growing: ${x.handles} open handles (${Math.round(ratio * 100) / 100}× baseline)`,
        metricValue: x.handles,
        thresholdValue: Math.round(baseline * cfg.multiplier),
        durationSec: Math.round((now - s.elevatedSince) / 1000),
      });
    }
  }

  /* ── restart/crash loop (rolling count) ─────────────────────────────── */

  private trackRestartLoop(
    p: CloudProcessReport,
    out: CloudEventReport[],
    now: number
  ): void {
    const cfg = this.config.defaults.restartLoop;
    let l = this.loops.get(p.name);
    if (!l) {
      l = { lastRestarts: p.restarts, restarts: [], armed: false };
      this.loops.set(p.name, l);
    }
    if (p.restarts > l.lastRestarts) {
      for (let i = 0; i < p.restarts - l.lastRestarts; i++) l.restarts.push(now);
      l.lastRestarts = p.restarts;
    } else if (p.restarts < l.lastRestarts) {
      // deleted + recreated with a reset counter — continuity restarts
      l.lastRestarts = p.restarts;
      l.restarts = [];
      l.armed = false;
    }
    const cutoff = now - cfg.windowSec * 1000;
    l.restarts = l.restarts.filter((t) => t >= cutoff);
    if (!l.armed && l.restarts.length >= cfg.count) {
      l.armed = true;
      out.push({
        kind: "restart.loop",
        process: p.name,
        at: now,
        detail: `${l.restarts.length} restarts in the last ${cfg.windowSec}s — crash loop`,
        metricValue: l.restarts.length,
        thresholdValue: cfg.count,
      });
    } else if (l.armed && l.restarts.length < cfg.count) {
      // self-clearing: old restarts aged out of the window (no event —
      // the cloud's alert row stays resolvable by the human)
      l.armed = false;
    }
  }

  /** Drop state for processes that vanished (delete) — bounded memory. */
  private prune(): void {
    for (const key of this.streaks.keys()) {
      const name = key.split("\0")[0]!;
      if (name !== SYSTEM_PROCESS_NAME && !this.seen.has(name)) {
        this.streaks.delete(key);
      }
    }
    for (const key of this.rates.keys()) {
      const name = key.split("\0")[0]!;
      if (!this.seen.has(name)) this.rates.delete(key);
    }
    for (const name of this.loops.keys()) {
      if (!this.seen.has(name)) this.loops.delete(name);
    }
  }
}

/* ── small helpers ────────────────────────────────────────────────────── */

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function labelOf(kind: string): string {
  switch (kind) {
    case "cpu.spike": return "CPU spiked";
    case "cpu.sustained": return "CPU sustained high";
    case "eventloop.latency": return "event loop blocked";
    case "system.cpu.high": return "system CPU saturated";
    case "system.mem.high": return "system memory low";
    default: return kind;
  }
}
