/**
 * ProcBoss (pboss) — Deno process adapter.
 *
 * Deno-native process spawning: Deno.Command (types: ./deno-shim.d.ts —
 * under real Deno the native types apply). The child's web streams are
 * already the adapter's shape. `kill` after exit throws in Deno — wrapped
 * best-effort. `spawnSync` has no Deno native equivalent (Command.output()
 * is async) — callers use capture() instead.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

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
      // File-sink redirection: Deno.Command has no file stdio, so the child
      // spawns piped and a background pump streams into the file (append).
      const outSink = typeof opts.stdout === "object" ? (opts.stdout as PBFileSink) : null;
      const errSink = typeof opts.stderr === "object" ? (opts.stderr as PBFileSink) : null;

      const command = new Deno.Command(cmd[0]!, {
        args: cmd.slice(1),
        cwd: opts.cwd,
        env: opts.env ?? Deno.env.toObject(),
        stdin: "null",
        stdout: outSink ? "piped" : denoStdio(opts.stdout ?? "pipe"),
        stderr: errSink ? "piped" : denoStdio(opts.stderr ?? "pipe"),
      });
      const child = command.spawn();

      const pump = async (stream: ReadableStream<Uint8Array> | null, path: string) => {
        if (!stream) return;
        try {
          const file = await Deno.open(path, { write: true, create: true, append: true });
          await stream.pipeTo(file.writable);
        } catch (err) {
          ignore(`pump child output to ${path}`, err);
        }
      };
      if (outSink) pump(child.stdout, outSink.__pbFileSink);
      if (errSink) pump(child.stderr, errSink.__pbFileSink);

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
