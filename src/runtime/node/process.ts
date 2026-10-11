/**
 * ProcBoss (pboss) — Node process adapter.
 *
 * Node-native process spawning via node:child_process spawn (async only —
 * the 2026-10-11 async mandate removed spawnSync: a blocking spawn stalls
 * the daemon's whole event loop). Node's child streams are adapted to web
 * ReadableStreams ONCE at spawn time so the rest of pboss deals with one
 * shape; the native stream itself stays the source.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type {
  PBChild,
  PBFileSink,
  PBProcessRuntime,
  PBSpawnOptions,
  PBCaptured,
} from "../core/types.ts";

/** node's StdioOptions for one channel. */
type NodeStdio = "pipe" | "ignore" | "inherit" | import("node:fs").WriteStream;

function nodeStdio(target: PBFileSink | string | undefined, fallback: "pipe" | "ignore"): NodeStdio {
  if (target === undefined) return fallback;
  if (target === "pipe" || target === "ignore" || target === "inherit") return target;
  // PBFileSink → the createWriteStream minted by node/filesystem.sink()
  return target as unknown as import("node:fs").WriteStream;
}

export function createNodeProcess(): PBProcessRuntime {
  return {
    spawn(cmd: string[], opts: PBSpawnOptions = {}): PBChild {
      const outSink = typeof opts.stdout === "object" && opts.stdout !== null ? (opts.stdout as PBFileSink) : null;
      const errSink = typeof opts.stderr === "object" && opts.stderr !== null ? (opts.stderr as PBFileSink) : null;
      const sinks = [outSink, errSink].filter(
        (s, i, all): s is PBFileSink => s !== null && all.indexOf(s) === i
      );

      /**
       * Release the sink streams. node:child_process PIPES a stream stdio
       * target (no fd dup like Bun/Deno), so this must NOT run before the
       * child is done — hooked on "close" (the event AFTER exit AND stdio
       * drain, so no buffered output is lost). Without it every spawn with
       * a sink leaked one fd for this process's whole lifetime (a cron
       * job's every-second run drained the daemon's fd budget). Idempotent
       * by construction — sink.close() no-ops an already-ended stream.
       */
      const releaseSinks = () => {
        for (const sink of sinks) {
          try {
            void sink.close?.().catch(() => {
              /* a half-dead stream's end() — nothing left to save */
            });
          } catch {
            /* already destroyed — nothing to release */
          }
        }
      };

      let child;
      try {
        child = spawn(cmd[0]!, cmd.slice(1), {
          cwd: opts.cwd,
          env: opts.env,
          stdio: [
            opts.stdin === "pipe" ? "pipe" : "ignore",
            nodeStdio(opts.stdout, "pipe"),
            nodeStdio(opts.stderr, "pipe"),
          ],
          detached: opts.detached,
          windowsHide: opts.windowsHide,
        });
      } catch (err) {
        // The spawn never happened — the sinks were never wired to a child.
        releaseSinks();
        throw err;
      }
      // Synchronous spawn failure (bad argv/env shape) threw above; an
      // async one (ENOENT) fires "error" and THEN "close" — one hook
      // releases the sinks for both endings, after stdio has drained.
      child.on("close", releaseSinks);

      const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code ?? null));
        child.on("error", () => resolve(null)); // spawn failure (ENOENT …)
      });

      return {
        pid: child.pid,
        exited,
        stdout: child.stdout ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>) : null,
        stderr: child.stderr ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>) : null,
        kill(signal = "SIGTERM") {
          try {
            child.kill(signal as never);
          } catch {
            // already-dead children throw on some platforms — kill is
            // best-effort everywhere else in pboss too
          }
        },
        unref() {
          child.unref();
        },
      };
    },

    async capture(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<PBCaptured> {
      const child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code ?? null));
        child.on("error", () => resolve(null));
      });
      return { stdout, stderr, exitCode };
    },
  };
}
