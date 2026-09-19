import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessState } from "../src/types";

/**
 * pboss 1.4.7 — per-process resource facts on the state report.
 *
 * The cloud now COLLECTS per-process usage history and runs its own
 * per-process alerting + AI optimization advice off it. The raw inputs
 * (event-loop lag, open handles, the maxMemoryRestart ceiling, the
 * ecosystem alertDisabled switch) always lived on ProcessState — they
 * fed the local threshold monitor only. These tests pin the WIRE side:
 * mapProcessState must carry them on every CloudProcessReport, absent
 * (not zero, not null) when the box never measured them.
 */

// isolate the credential file BEFORE importing cloud.ts (PBOSS_HOME is
// read at module load)
const home = mkdtempSync(join(tmpdir(), "pboss-report-extras-"));
process.env.PBOSS_HOME = home;
delete process.env.PBOSS_CLOUD_REPORT_MS;
// type-only import: erased at compile time, so the module (and its
// PBOSS_HOME read) only loads in the dynamic import below
const { mapProcessState } = await import("../src/cloud");

let cleanup = home;
afterEach(() => {
  // best-effort — the runner may reuse the box across tests
  try {
    rmSync(cleanup, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

const envOver = (over: Record<string, unknown>) =>
  ({ script: "worker.ts", restart_time: 0, pm_uptime: Date.now(), unstable_restarts: 0, ...over }) as unknown as ProcessState["pboss_env"];

const baseState = (over: Partial<ProcessState> & { pboss_env?: ProcessState["pboss_env"] }): ProcessState =>
  ({
    name: "api-worker",
    status: "online",
    pid: 4242,
    pm_id: 3,
    monit: { memory: 268_435_456, cpu: 12 },
    pboss_env: envOver({}),
    ...over,
  }) as unknown as ProcessState;

describe("mapProcessState — resource facts on the wire (1.4.7)", () => {
  test("event-loop latency + handles ride the report, rounded and floored", () => {
    const p = mapProcessState(
      baseState({
        monit: { memory: 1, cpu: 5, eventLoopLatency: 37.6, handles: 214 },
      }),
    );
    expect(p.eventLoopMs).toBe(38);
    expect(p.handles).toBe(214);
  });

  test("maxMemoryRestart becomes memLimitMB in MB", () => {
    const p = mapProcessState(
      baseState({ pboss_env: envOver({ maxMemoryRestart: 536_870_912 }) }),
    );
    expect(p.memLimitMB).toBe(512);
  });

  test("a zero/garbage maxMemoryRestart stays undefined, not 0", () => {
    expect(
      mapProcessState(
        baseState({ pboss_env: envOver({ maxMemoryRestart: 0 }) }),
      ).memLimitMB,
    ).toBeUndefined();
    expect(
      mapProcessState(
        baseState({ pboss_env: envOver({ maxMemoryRestart: -5 }) }),
      ).memLimitMB,
    ).toBeUndefined();
  });

  test("alertDisabled rides as true only when the operator set it", () => {
    expect(
      mapProcessState(
        baseState({ pboss_env: envOver({ alertDisabled: true }) }),
      ).alertsDisabled,
    ).toBe(true);
    // absent flag → absent wire field (the cloud treats undefined as
    // "alerts on" — the default)
    expect(mapProcessState(baseState({})).alertsDisabled).toBeUndefined();
  });

  test("unmeasured extras are ABSENT, never zeroed", () => {
    const p = mapProcessState(baseState({}));
    expect(p.eventLoopMs).toBeUndefined();
    expect(p.handles).toBeUndefined();
    expect(p.memLimitMB).toBeUndefined();
    // the core numbers the cloud always had stay intact
    expect(p.cpu).toBe(12);
    expect(p.mem).toBe(256); // 268435456 bytes → 256 MB
    expect(p.name).toBe("api-worker");
  });

  test("negative/NaN event-loop garbage never reaches the wire", () => {
    expect(
      mapProcessState(
        baseState({ monit: { memory: 1, cpu: 1, eventLoopLatency: -4 } }),
      ).eventLoopMs,
    ).toBe(0);
    expect(
      mapProcessState(
        baseState({ monit: { memory: 1, cpu: 1, eventLoopLatency: Number.NaN } }),
      ).eventLoopMs,
    ).toBeUndefined();
  });
});
