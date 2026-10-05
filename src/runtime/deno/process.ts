/**
 * ProcBoss (pboss) — Deno process adapter.
 *
 * Deno-native process spawning: Deno.Command (types: ./deno-shim.d.ts —
 * under real Deno the native types apply). The child's web streams are
 * already the adapter's shape. `kill` after exit throws in Deno — wrapped
 * best-effort. `spawnSync` has no Deno native equivalent (Command.output()
 * is async) — callers use capture() instead.
 *
 * File-sink redirection goes through a REAL OS fd, not a pipe: Deno.Command
 * has no file-path stdio, but it accepts a raw fd (node:fs openSync — the
 * Deno-native FsFile exposes no rid anymore). The child dups the fd at
 * spawn and the parent closes its copy immediately after — the redirect
 * is kernel-owned. The previous piped+pump design tied a DETACHED child's
 * stdout/stderr to the CLI parent's lifetime: when the parent exited, the
 * daemon's next stdout write hit a broken pipe and killed it silently
 * (empty log files, socket bound, process gone).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { closeSync, openSync } from "node:fs";
import type { PBChild, PBProcessRuntime, PBCaptured, PBSpawnOptions, PBFileSink } from "../core/types";
import { ignore } from "../../error-handling";

/** Map adapter stdio tokens to Deno's ("ignore" is Bun/Node vocabulary). */
function denoStdio(t: PBSpawnOptions["stdout"]): "piped" | "inherit" | "null" {
  if (t === "pipe") return "piped";
  if (t === "inherit") return "inherit";
  return "null"; // "ignore" and unset
}

export function createDenoProcess(): PBProcessRuntime {
  return {
    spawn(cmd: string[], opts: PBSpawnOptions = {}): PBChild {
      // File-sink redirection through a real append-mode fd (see the header
      // comment): kernel-owned, survives the parent, no background pump.
      const outSink = typeof opts.stdout === "object" ? (opts.stdout as PBFileSink) : null;
      const errSink = typeof opts.stderr === "object" ? (opts.stderr as PBFileSink) : null;

      let outFd: number | undefined;
      let errFd: number | undefined;
      if (outSink) {
        outFd = openSync(outSink.__pbFileSink, "a");
      }
      if (errSink) {
        // Two sinks may point at the same path (stdout+stderr to one log):
        // a separate append-mode fd keeps both writers independent.
        errFd = openSync(errSink.__pbFileSink, "a");
      }

      const command = new Deno.Command(cmd[0]!, {
        args: cmd.slice(1),
        cwd: opts.cwd,
        env: opts.env ?? Deno.env.toObject(),
        stdin: "null",
        stdout: outSink ? outFd! : denoStdio(opts.stdout ?? "pipe"),
        stderr: errSink ? errFd! : denoStdio(opts.stderr ?? "pipe"),
      });
      const child = command.spawn();

      // The child holds its own dup from spawn; drop the parent copies so
      // the fds do not leak into every later spawn this process performs.
      if (outFd !== undefined) {
        try { closeSync(outFd); } catch (err) { ignore("close stdout sink fd", err); }
      }
      if (errFd !== undefined) {
        try { closeSync(errFd); } catch (err) { ignore("close stderr sink fd", err); }
      }

      const exited = child.status.then((s) => s.code ?? null);

      return {
        pid: child.pid,
        exited,
        stdout: outSink ? null : child.stdout,
        stderr: errSink ? null : child.stderr,
        kill(signal = "SIGTERM") {
          try {
            child.kill(signal);
          } catch {
            // already exited — kill is best-effort everywhere in pboss
          }
        },
        unref() {
          // Deno children are not auto-reaped and do not hold the event
          // loop — nothing to unref; detached semantics are the default.
        },
      };
    },

    spawnSync(): never {
      throw new Error(
        "spawnSync is not available under Deno (no synchronous spawn API) — use capture()"
      );
    },

    async capture(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<PBCaptured> {
      const command = new Deno.Command(cmd[0]!, {
        args: cmd.slice(1),
        cwd: opts.cwd,
        env: opts.env ?? Deno.env.toObject(),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const out = await command.output();
      return {
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
        exitCode: out.code ?? null,
      };
    },
  };
}
