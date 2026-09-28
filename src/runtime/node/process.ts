/**
 * ProcBoss (pboss) — Node process adapter.
 *
 * Node-native process spawning via node:child_process (spawn / spawnSync).
 * Node's child streams are adapted to web ReadableStreams ONCE at spawn
 * time so the rest of pboss deals with one shape; the native stream itself
 * stays the source.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import type {
  PBChild,
  PBFileSink,
  PBProcessRuntime,
  PBSpawnOptions,
  PBCaptured,
} from "../core/types";

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
      const child = spawn(cmd[0]!, cmd.slice(1), {
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

    spawnSync(cmd: string[], opts: { cwd?: string } = {}) {
      const r = spawnSync(cmd[0]!, cmd.slice(1), {
        cwd: opts.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.status ?? null,
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
