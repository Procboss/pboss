/**
 * ProcBoss (pboss) — Bun process adapter.
 *
 * Bun-native process spawning: Bun.spawn, async only (the 2026-10-11
 * async mandate removed the synchronous variant entirely — a blocking
 * spawn stalls the daemon's whole event loop). This module (like every adapter module) has
 * ZERO top-level side effects and never touches another runtime's globals
 * — it is only ever loaded by the Bun adapter, and every function here
 * calls the real Bun APIs directly (pinned by tests/runtime-adapter.test.ts
 * to prevent a future node-compat regression).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type { PBChild, PBFileSink, PBSpawnOptions, PBCaptured, PBProcessRuntime } from "../core/types.ts";
import { ignore } from "../../error-handling.ts";

/** Bun's stdio tokens are the adapter's already; file sinks pass their fd. */
function bunStdio(target: PBFileSink | string | undefined | null, fallback: "pipe" | "ignore") {
  if (target === undefined || target === null) return fallback;
  if (typeof target === "string") return target;
  return target.fd as number; // append-mode fd — natively accepted by Bun.spawn
}

export function createBunProcess(): PBProcessRuntime {
  return {
    spawn(cmd: string[], opts: PBSpawnOptions = {}): PBChild {
      const outSink = typeof opts.stdout === "object" && opts.stdout !== null ? (opts.stdout as PBFileSink) : null;
      const errSink = typeof opts.stderr === "object" && opts.stderr !== null ? (opts.stderr as PBFileSink) : null;
      let proc;
      try {
        proc = Bun.spawn(cmd, {
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
      } finally {
        // Bun.spawn has dup'd every sink fd into the child by the time it
        // returns (or never will — the finally also covers a throwing
        // spawn): the parent's FileHandle copies are dead weight now, and
        // DROPPING them was never safe. An unclosed FileHandle that reaches
        // garbage collection THROWS ERR_INVALID_STATE under Bun (the
        // 2026-10-12 suite fallout: a cron job's log sink collected mid-run
        // failed dozens of unrelated tests at random GC timings), and until
        // collection each one pins an fd in this process — the daemon leaked
        // one per cron run. close() is async and idempotent (same object as
        // stdout AND stderr closes once); voided fire-and-forget — the
        // redirect is kernel-owned by the child's dup either way.
        const released = new Set<unknown>();
        for (const sink of [outSink, errSink]) {
          if (!sink || released.has(sink)) continue;
          released.add(sink);
          try {
            void sink.close?.().catch((err: unknown) => ignore("close sink fd", err));
          } catch (err) {
            ignore("close sink fd", err);
          }
        }
      }
      return proc as unknown as PBChild;
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
