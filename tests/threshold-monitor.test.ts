/**
 * Resource threshold monitor tests — the hysteresis state machine
 * (normal → watching → triggered → clearing → normal), the rate-based
 * memory/handle checks, the rolling restart-loop window, and the config
 * merge surface (file + ecosystem overrides + alertDisabled).
 *
 * All pure: ThresholdMonitor is fed synthetic snapshots with an injected
 * clock — no timers, no sockets, no file system (config file round-trips
 * use an explicit temp path).
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThresholdMonitor,
  DEFAULT_THRESHOLD_CONFIG,
  loadThresholdConfig,
  saveThresholdConfig,
  patchThresholdConfig,
  effectiveProcessThresholds,
  SYSTEM_PROCESS_NAME,
} from "../src/threshold-monitor";
import type { CloudProcessReport } from "../src/cloud";

function proc(name: string, over: Partial<CloudProcessReport> = {}): CloudProcessReport {
  return {
    name,
    script: "s.ts",
    pmId: 0,
    status: "online",
    cpu: 5,
    mem: 100,
    restarts: 0,
    crashes: 0,
    uptimeSec: 100,
    ...over,
  };
}

const NO_EXTRA = new Map();
const T0 = 1_700_000_000_000; // arbitrary fixed epoch

function sys(over: { cpu?: number; memUsed?: number; memTotal?: number } = {}) {
  return { cpu: 10, memUsed: 2_000, memTotal: 8_000, ...over };
}

/* ── level metrics: the state machine ────────────────────────────────── */

describe("ThresholdMonitor — level metrics (CPU)", () => {
  test("trigger → sustained hold → fires exactly ONE cpu.spike", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // default: trigger 95, clear 80, sustained 30s — evaluate at 10s ticks
    let evs = m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0);
    expect(evs.length).toBe(0); // watching, not yet sustained

    evs = m.evaluate([proc("api", { cpu: 97 })], sys(), NO_EXTRA, T0 + 10_000);
    expect(evs.length).toBe(0);

    evs = m.evaluate([proc("api", { cpu: 97 })], sys(), NO_EXTRA, T0 + 30_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("cpu.spike");
    expect(evs[0]!.process).toBe("api");
    expect(evs[0]!.metricValue).toBe(97);
    expect(evs[0]!.thresholdValue).toBe(95);

    // still elevated on later ticks: no duplicate firing (the cloud dedups
    // delivery, but the monitor itself must not spam either)
    evs = m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0 + 40_000);
    expect(evs.length).toBe(0);
  });

  test("a blip (drops back before sustained) fires nothing", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    let evs = m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0);
    expect(evs.length).toBe(0);
    // drops under the trigger before 30s elapse
    evs = m.evaluate([proc("api", { cpu: 50 })], sys(), NO_EXTRA, T0 + 20_000);
    expect(evs.length).toBe(0);
    // crosses again — the streak restarts
    evs = m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0 + 30_000);
    expect(evs.length).toBe(0);
    evs = m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0 + 65_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("cpu.spike");
  });

  test("triggered → clear-hold → cpu.recovered with durationSec", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0);
    m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0 + 30_000); // fires
    // drop under the CLEAR level (80): clearing begins
    let evs = m.evaluate([proc("api", { cpu: 60 })], sys(), NO_EXTRA, T0 + 40_000);
    expect(evs.length).toBe(0);
    // boundary zone (between clear 80 and trigger 95) while clearing → still
    // recovering, no event (hysteresis — cannot flap at the trigger edge)
    evs = m.evaluate([proc("api", { cpu: 85 })], sys(), NO_EXTRA, T0 + 50_000);
    expect(evs.length).toBe(0);
    // clear-hold of 30s elapsed → recovered
    evs = m.evaluate([proc("api", { cpu: 60 })], sys(), NO_EXTRA, T0 + 75_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("cpu.recovered");
    expect(evs[0]!.process).toBe("api");
    // elevated since the CROSSING (T0), not since the event fired
    expect(evs[0]!.durationSec).toBe(75);
  });

  test("long-running condition re-emits the heartbeat (10 min default)", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0);
    m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0 + 30_000); // fire
    const evs = m.evaluate([proc("api", { cpu: 96 })], sys(), NO_EXTRA, T0 + 30_000 + 600_000);
    // cpu.sustained ALSO fires here (its 300s sustained elapsed at this
    // late tick) — the heartbeat assertion is about the spike family
    const hb = evs.filter((e) => e.kind === "cpu.spike");
    expect(hb.length).toBe(1);
    expect(hb[0]!.detail).toContain("still elevated");
    // duration counts from the CROSSING (T0), so 630s here, not 600
    expect(hb[0]!.durationSec).toBe(630);
  });

  test("cpu.sustained is its own (lower, longer) condition", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // 75% — above sustained's 70 trigger but below spike's 95
    m.evaluate([proc("api", { cpu: 75 })], sys(), NO_EXTRA, T0);
    const evs = m.evaluate([proc("api", { cpu: 75 })], sys(), NO_EXTRA, T0 + 300_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("cpu.sustained");
    expect(evs[0]!.thresholdValue).toBe(70);
  });
});

/* ── system-wide metrics (the "__system__" sentinel) ─────────────────── */

describe("ThresholdMonitor — system metrics", () => {
  test("system.cpu.high fires on sustained saturation, recovers as system.recovered", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // default system cpu: trigger 85, clear 65, sustained 300s
    m.evaluate([], { cpu: 90, memUsed: 2000, memTotal: 8000 }, NO_EXTRA, T0);
    const evs = m.evaluate([], { cpu: 90, memUsed: 2000, memTotal: 8000 }, NO_EXTRA, T0 + 300_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("system.cpu.high");
    expect(evs[0]!.process).toBe(SYSTEM_PROCESS_NAME);

    // free memory 75% — well clear of the mem trigger; cpu drops to 40
    let r = m.evaluate([], { cpu: 40, memUsed: 2000, memTotal: 8000 }, NO_EXTRA, T0 + 400_000);
    expect(r.length).toBe(0); // clearing
    r = m.evaluate([], { cpu: 40, memUsed: 2000, memTotal: 8000 }, NO_EXTRA, T0 + 720_000);
    expect(r.length).toBe(1);
    expect(r[0]!.kind).toBe("system.recovered");
    expect(r[0]!.process).toBe(SYSTEM_PROCESS_NAME);
  });

  test("system.mem.high fires when free RAM is under the floor (inverted direction)", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // default: trigger when free <= 10%, clear when free > 20%, sustained 120s
    // 7600/8000 used → 5% free
    m.evaluate([], { cpu: 5, memUsed: 7600, memTotal: 8000 }, NO_EXTRA, T0);
    const evs = m.evaluate([], { cpu: 5, memUsed: 7600, memTotal: 8000 }, NO_EXTRA, T0 + 120_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("system.mem.high");

    // 82.5% free → far above the 20% clear level
    let r = m.evaluate([], { cpu: 5, memUsed: 1400, memTotal: 8000 }, NO_EXTRA, T0 + 130_000);
    expect(r.length).toBe(0);
    r = m.evaluate([], { cpu: 5, memUsed: 1400, memTotal: 8000 }, NO_EXTRA, T0 + 260_000);
    expect(r.length).toBe(1);
    expect(r[0]!.kind).toBe("system.recovered");
  });
});

/* ── memory: spike (rate) and high (level vs limit) ───────────────────── */

describe("ThresholdMonitor — memory metrics", () => {
  test("mem.spike: ≥40% growth AND ≥20MB within the window fires; small apps don't", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // 100MB → 150MB = 50% growth + 50MB — a leak
    m.evaluate([proc("api", { mem: 100 })], sys(), NO_EXTRA, T0);
    const evs = m.evaluate([proc("api", { mem: 150 })], sys(), NO_EXTRA, T0 + 60_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("mem.spike");
    expect(evs[0]!.detail).toContain("50%");
  });

  test("mem.spike: percent-wise large but tiny in MB → no event (minDeltaMB floor)", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // 5MB → 8MB is 60% growth but only 3MB — a blip on a small process
    m.evaluate([proc("tiny", { mem: 5 })], sys(), NO_EXTRA, T0);
    const evs = m.evaluate([proc("tiny", { mem: 8 })], sys(), NO_EXTRA, T0 + 60_000);
    expect(evs.length).toBe(0);
  });

  test("mem.spike recovery fires when the growth rate calms down", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    m.evaluate([proc("api", { mem: 100 })], sys(), NO_EXTRA, T0);
    const spike = m.evaluate([proc("api", { mem: 150 })], sys(), NO_EXTRA, T0 + 60_000);
    expect(spike.filter((e) => e.kind === "mem.spike").length).toBe(1);
    // the 100MB baseline ages out of the 60s window: growth collapses
    // (152 vs 150 ≈ 1%) and the recovery fires on the SAME sliding logic
    const evs = m.evaluate([proc("api", { mem: 152 })], sys(), NO_EXTRA, T0 + 121_000);
    const recovered = evs.find((e) => e.kind === "mem.recovered");
    expect(recovered).toBeDefined();
    expect(recovered!.detail).toContain("calmed");
  });

  test("mem.high: fires at 85% of maxMemoryRestart (early warning), never without a limit", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // with a 200MB limit, 180MB = 90% of it — sustained 60s
    const extra = new Map([["api", { maxMemoryMB: 200 }]]);
    m.evaluate([proc("api", { mem: 180 })], sys(), extra, T0);
    const evs = m.evaluate([proc("api", { mem: 180 })], sys(), extra, T0 + 60_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("mem.high");
    expect(evs[0]!.detail).toContain("90%");

    // without any ceiling: same memory, no event
    const m2 = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    m2.evaluate([proc("api", { mem: 180 })], sys(), NO_EXTRA, T0);
    expect(m2.evaluate([proc("api", { mem: 180 })], sys(), NO_EXTRA, T0 + 60_000).length).toBe(0);
  });
});

/* ── event-loop latency ───────────────────────────────────────────────── */

describe("ThresholdMonitor — event-loop latency", () => {
  test("100ms+ sustained 30s → eventloop.latency, recovery via eventloop.recovered", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    const extra = new Map([["api", { eventLoopLatency: 140 }]]);
    m.evaluate([proc("api")], sys(), extra, T0);
    const evs = m.evaluate([proc("api")], sys(), extra, T0 + 30_000);
    expect(evs.length).toBe(1);
    expect(evs[0]!.kind).toBe("eventloop.latency");
    expect(evs[0]!.metricValue).toBe(140);

    const calm = new Map([["api", { eventLoopLatency: 10 }]]);
    m.evaluate([proc("api")], sys(), calm, T0 + 40_000);
    const rec = m.evaluate([proc("api")], sys(), calm, T0 + 80_000);
    expect(rec.length).toBe(1);
    expect(rec[0]!.kind).toBe("eventloop.recovered");
  });
});

/* ── handle growth (baseline-relative) ────────────────────────────────── */

describe("ThresholdMonitor — handle/FD growth", () => {
  test("no baseline, no alert — 3× the 10-min-ago value held 5min fires handles.leak", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    const base = new Map([[
      "api",
      { handles: 100 },
    ]]);
    m.evaluate([proc("api")], sys(), base, T0);
    m.evaluate([proc("api")], sys(), base, T0 + 60_000);
    // 300 handles at t+120s: 3× t0 — but the baseline window (600s) has
    // not elapsed, so there is no "10 min ago" sample to compare against
    const grown = new Map([["api", { handles: 300 }]]);
    let evs = m.evaluate([proc("api")], sys(), grown, T0 + 120_000);
    expect(evs.filter((e) => e.kind === "handles.leak").length).toBe(0);

    // at t+600s the t0 baseline is exactly 10 min old: 300 ≥ 3× and the
    // sustained clock starts; 300s later it fires
    evs = m.evaluate([proc("api")], sys(), grown, T0 + 600_000);
    expect(evs.filter((e) => e.kind === "handles.leak").length).toBe(0);
    evs = m.evaluate([proc("api")], sys(), grown, T0 + 900_000);
    expect(evs.filter((e) => e.kind === "handles.leak").length).toBe(1);
    expect(evs[0]!.detail).toContain("3×");
  });

  test("recovery when the ratio falls under 1.5× baseline", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    const base = new Map([["api", { handles: 100 }]]);
    m.evaluate([proc("api")], sys(), base, T0);
    const grown = new Map([["api", { handles: 300 }]]);
    m.evaluate([proc("api")], sys(), grown, T0 + 600_000); // baseline ready → watching
    m.evaluate([proc("api")], sys(), grown, T0 + 900_000); // sustained 300s → fires
    const calm = new Map([["api", { handles: 120 }]]);
    m.evaluate([proc("api")], sys(), calm, T0 + 910_000); // clearing starts
    const rec = m.evaluate([proc("api")], sys(), calm, T0 + 1_220_000); // 310s held
    const recovered = rec.find((e) => e.kind === "handles.recovered");
    expect(recovered).toBeDefined();
  });

  test("a PERSISTENT leak keeps its frozen baseline (does not self-dissolve)", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    const base = new Map([["api", { handles: 100 }]]);
    m.evaluate([proc("api")], sys(), base, T0);
    const grown = new Map([["api", { handles: 300 }]]);
    m.evaluate([proc("api")], sys(), grown, T0 + 600_000); // watching (baseline 100 frozen)
    m.evaluate([proc("api")], sys(), grown, T0 + 900_000); // fires
    // 30 minutes of sustained leak — the pre-leak samples are LONG out of
    // the window, but the frozen baseline keeps the condition honest
    const evs = m.evaluate([proc("api")], sys(), grown, T0 + 2_700_000);
    const heartbeats = evs.filter((e) => e.kind === "handles.leak");
    expect(heartbeats.length).toBe(1); // still-elevated heartbeat
    expect(heartbeats[0]!.detail).toContain("still growing");
  });
});

/* ── restart loop (rolling window) ────────────────────────────────────── */

describe("ThresholdMonitor — restart loop", () => {
  test("5 restarts within 5 minutes arm ONCE; aging out re-arms the detector", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    // the counter's first OBSERVATION is the baseline — what matters is
    // the climb after that, exactly like a daemon that starts mid-life
    let restarts = 0;
    const tick = (t: number) => {
      restarts++;
      return m.evaluate([proc("api", { restarts })], sys(), NO_EXTRA, t);
    };
    tick(T0); // restarts=1 — baseline, nothing recorded
    let evs: { kind: string }[] = [];
    for (let i = 2; i <= 6; i++) {
      evs = tick(T0 + i * 10_000); // recorded restarts #2..#6 = 5 in window
    }
    expect(evs.filter((e) => e.kind === "restart.loop").length).toBe(1);

    // more crashing within the window: still one event (armed)
    evs = tick(T0 + 70_000);
    expect(evs.filter((e) => e.kind === "restart.loop").length).toBe(0);

    // the recorded restarts happened by t+70s — they age out of the 300s
    // window at t+370s; by t+400s the count is 0 and the detector re-arms
    evs = m.evaluate([proc("api", { restarts })], sys(), NO_EXTRA, T0 + 400_000);
    expect(evs.filter((e) => e.kind === "restart.loop").length).toBe(0);
    // then a NEW burst of 5 quick restarts re-arms and fires again
    for (let i = 1; i <= 5; i++) {
      evs = m.evaluate([proc("api", { restarts: restarts + i })], sys(), NO_EXTRA, T0 + 401_000 + i * 1000);
    }
    expect(evs.filter((e) => e.kind === "restart.loop").length).toBe(1);
  });

  test("counter reset (process deleted + recreated) never false-arms", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    m.evaluate([proc("api", { restarts: 10 })], sys(), NO_EXTRA, T0);
    // recreated with restarts back at 0, then climbs 1..4 → never 5-in-window
    let evs: { kind: string }[] = [];
    for (let i = 1; i <= 4; i++) {
      evs = m.evaluate([proc("api", { restarts: i })], sys(), NO_EXTRA, T0 + i * 10_000);
    }
    expect(evs.filter((e) => e.kind === "restart.loop").length).toBe(0);
  });
});

/* ── config: file, patch, merge, disable ──────────────────────────────── */

describe("threshold config — load / save / patch / merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "pboss-thr-"));

  test("missing file → built-in defaults; partial JSON merges onto defaults", () => {
    const cfg = loadThresholdConfig(join(dir, "none.json"));
    expect(cfg).toEqual(DEFAULT_THRESHOLD_CONFIG);

    const p = join(dir, "partial.json");
    writeFileSync(
      p,
      JSON.stringify({ system: { cpuPercent: { trigger: 70 } }, overrides: { "my-api": { cpuSpikePercent: { trigger: 90 } } } })
    );
    const merged = loadThresholdConfig(p);
    expect(merged.system.cpuPercent.trigger).toBe(70);
    expect(merged.system.cpuPercent.clear).toBe(65); // default kept
    expect(merged.defaults.cpuSpikePercent.trigger).toBe(95); // untouched
    expect(merged.overrides["my-api"]!.cpuSpikePercent!.trigger).toBe(90);
  });

  test("corrupt JSON degrades to defaults (alerting never throws)", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{not json");
    expect(loadThresholdConfig(p)).toEqual(DEFAULT_THRESHOLD_CONFIG);
  });

  test("save → load round-trip", () => {
    const p = join(dir, "roundtrip.json");
    const cfg = patchThresholdConfig(DEFAULT_THRESHOLD_CONFIG, "my-api", {
      cpuSpikePercent: { trigger: 90 },
    });
    saveThresholdConfig(cfg, p);
    const loaded = loadThresholdConfig(p);
    expect(loaded.overrides["my-api"]!.cpuSpikePercent!.trigger).toBe(90);
    expect(loaded.overrides["my-api"]!.cpuSpikePercent!.sustainedSec).toBe(30);
  });

  test("patchThresholdConfig: system / process / defaults targets", () => {
    const systemPatched = patchThresholdConfig(DEFAULT_THRESHOLD_CONFIG, "system", {
      cpuPercent: { trigger: 80 },
    });
    expect(systemPatched.system.cpuPercent.trigger).toBe(80);

    const procPatched = patchThresholdConfig(DEFAULT_THRESHOLD_CONFIG, "my-api", {
      restartLoop: { count: 3 },
    });
    expect(procPatched.overrides["my-api"]!.restartLoop!.count).toBe(3);
    expect(procPatched.defaults.restartLoop.count).toBe(5); // defaults untouched

    const defaultsPatched = patchThresholdConfig(DEFAULT_THRESHOLD_CONFIG, undefined, {
      eventLoopLatencyMs: { trigger: 50 },
    });
    expect(defaultsPatched.defaults.eventLoopLatencyMs.trigger).toBe(50);
    expect(defaultsPatched.overrides).toEqual({});
  });

  test("effectiveProcessThresholds: defaults ← file override ← StartOptions fields", () => {
    const cfg = patchThresholdConfig(DEFAULT_THRESHOLD_CONFIG, "my-api", {
      cpuSpikePercent: { trigger: 90 },
    });
    const t = effectiveProcessThresholds(cfg, "my-api", {
      alertCpuSpikePercent: 85,
      alertMemHighMB: 512,
    });
    expect(t.cpuSpikePercent.trigger).toBe(85); // StartOptions wins
    expect(t.cpuSpikePercent.clear).toBe(80); // default clear kept
    expect(t.memHighPercentOfLimit.absoluteMB).toBe(512);
    const plain = effectiveProcessThresholds(cfg, "other");
    expect(plain.cpuSpikePercent.trigger).toBe(95); // defaults for everyone else
  });

  test("hot-reload: updateConfig changes the trigger level mid-stream", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    m.evaluate([proc("api", { cpu: 80 })], sys(), NO_EXTRA, T0); // below 95
    expect(m.evaluate([proc("api", { cpu: 80 })], sys(), NO_EXTRA, T0 + 30_000).length).toBe(0);
    const next = patchThresholdConfig(DEFAULT_THRESHOLD_CONFIG, "api", {
      cpuSpikePercent: { trigger: 75 },
    });
    m.updateConfig(next);
    // 80 now crosses the lowered trigger — watching starts, then 30s of
    // sustained fires (filter: cpu.sustained never fires at 80 < 70… it
    // does — 80 ≥ 70; so filter for the spike kind specifically)
    m.evaluate([proc("api", { cpu: 80 })], sys(), NO_EXTRA, T0 + 60_000);
    const evs = m.evaluate([proc("api", { cpu: 80 })], sys(), NO_EXTRA, T0 + 90_000);
    expect(evs.filter((e) => e.kind === "cpu.spike").length).toBe(1);
  });

  test("alertDisabled suppresses every process metric (not system ones)", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    const extra = new Map<string, { alerts: { alertDisabled: true } }>([
      ["api", { alerts: { alertDisabled: true } }],
    ]);
    m.evaluate([proc("api", { cpu: 99, mem: 900 })], sys(), extra, T0);
    expect(m.evaluate([proc("api", { cpu: 99, mem: 900 })], sys(), extra, T0 + 60_000).length).toBe(0);
  });
});

/* ── synthetic test events ────────────────────────────────────────────── */

describe("syntheticEvent (pboss alerts test)", () => {
  test("aliases resolve; system kinds use the __system__ sentinel; unknown → null", () => {
    const m = new ThresholdMonitor(DEFAULT_THRESHOLD_CONFIG);
    expect(m.syntheticEvent("api", "cpu")!.kind).toBe("cpu.spike");
    expect(m.syntheticEvent("api", "restart")!.kind).toBe("restart.loop");
    expect(m.syntheticEvent("api", "system-mem")!.process).toBe(SYSTEM_PROCESS_NAME);
    expect(m.syntheticEvent("api", "mem-high")!.kind).toBe("mem.high");
    expect(m.syntheticEvent("api", "nonsense")).toBeNull();
  });
});
