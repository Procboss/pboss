/**
 * ProcBoss (pboss) — Bun process adapter.
 *
 * Bun-native process spawning: Bun.spawn / Bun.spawnSync. This module (like
 * every adapter module) has ZERO top-level side effects and never touches
 * another runtime's globals — it is only ever loaded by the Bun adapter, and
 * every function here calls the real Bun APIs directly (pinned by
 * tests/runtime-adapter.test.ts to prevent a future node-compat regression).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type { PBChild, PBFileSink, PBSpawnOptions, PBCaptured, PBProcessRuntime } from "../core/types.ts";

/** Bun's stdio tokens are the adapter's already; file sinks pass their fd. */
function bunStdio(target: PBFileSink | string | undefined, fallback: "pipe" | "ignore") {
  if (target === undefined) return fallback;
  if (typeof target === "string") return target;
  return target.fd as number; // append-mode fd — natively accepted by Bun.spawn
}

export function createBunProcess(): PBProcessRuntime {
  return {
    spawn(cmd: string[], opts: PBSpawnOptions = {}): PBChild {
      const proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        // undefined → the LIVE process.env (Bun snapshots an env: undefined
        // instead of tracking mutations — callers that mutate PATH in-process
        // rely on the live object, exactly like the pre-adapter code did).
        env: (opts.env as Record<string, string> | undefined) ?? process.env,
        stdin: opts.stdin ?? "ignore",
        stdout: bunStdio(opts.stdout, "pipe") as "pipe",
        stderr: bunStdio(opts.stderr, "pipe") as "pipe",
        detached: opts.detached,
        windowsHide: opts.windowsHide,
      });
      return proc as unknown as PBChild;
    },

    spawnSync(cmd: string[], opts: { cwd?: string } = {}) {
      const r = Bun.spawnSync(cmd, {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      return {
        stdout: String(r.stdout ?? ""),
        stderr: String(r.stderr ?? ""),
        exitCode: r.exitCode ?? null,
      };
    },

    async capture(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<PBCaptured> {
      const proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  };
}
