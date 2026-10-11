/**
 * ProcBoss (pboss) — Deno process adapter.
 *
 * Deno-native process spawning: Deno.Command (types: ./deno-shim.d.ts —
 * under real Deno the native types apply). The child's web streams are
 * already the adapter's shape. `kill` after exit throws in Deno — wrapped
 * best-effort. There is NO synchronous spawn in this adapter (the
 * 2026-10-11 async mandate removed the throwing stub; callers use
 * capture()).
 *
 * File-sink redirection goes through a REAL OS fd opened ASYNC by the
 * adapter's own sink() (node:fs/promises open — the Deno-native FsFile
 * exposes no rid anymore, so the sanctioned node-compat file API is it).
 * The child dups the fd at spawn and the parent closes its copy right
 * after — the redirect is kernel-owned. The previous piped+pump design
 * tied a DETACHED child's stdout/stderr to the CLI parent's lifetime:
 * when the parent exited, the daemon's next stdout write hit a broken
 * pipe and killed it silently (empty log files, socket bound, process
 * gone).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type { PBChild, PBProcessRuntime, PBCaptured, PBSpawnOptions, PBFileSink } from "../core/types.ts";
import { ignore } from "../../error-handling.ts";

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
      // The fd was opened ASYNC by the sink (2026-10-11 mandate) — spawn
      // itself performs no filesystem I/O.
      const outSink = typeof opts.stdout === "object" && opts.stdout !== null ? (opts.stdout as PBFileSink) : null;
      const errSink = typeof opts.stderr === "object" && opts.stderr !== null ? (opts.stderr as PBFileSink) : null;

      let child;
      try {
        const command = new Deno.Command(cmd[0]!, {
          args: cmd.slice(1),
          cwd: opts.cwd,
          env: opts.env ?? Deno.env.toObject(),
          stdin: "null",
          stdout: outSink ? outSink.fd! : denoStdio(opts.stdout ?? "pipe"),
          stderr: errSink ? errSink.fd! : denoStdio(opts.stderr ?? "pipe"),
        });
        child = command.spawn();
      } finally {
        // The child holds its own dup from spawn; the parent copies (the
        // sinks' FileHandles) must not leak into every later spawn this
        // process performs — and a throwing spawn releases them instead of
        // orphaning them (an unclosed handle rides GC and, under Bun's
        // node:fs/promises, that throws). close() is async — voided
        // fire-and-forget; the fd is already dup'd into the child, and
        // FileHandle.close() is idempotent when both sinks are the same
        // object.
        for (const sink of [outSink, errSink]) {
          if (!sink) continue;
          try {
            void (sink.close?.() ?? Promise.resolve()).catch((err: unknown) =>
              ignore("close sink fd", err)
            );
          } catch (err) {
            ignore("close sink fd", err);
          }
        }
      }

      const exited = child.status.then((s) => s.code ?? null);

      // Deno's ChildProcess getters THROW for any stdio that is not
      // "piped" — "inherit" streams live to the user, "null" (our "ignore")
      // discards, an fd sink redirects; none leaves a stream to read. The
      // PBChild contract is Bun/Node's (null when there is nothing to
      // read), so the getters are touched ONLY for piped children. The old
      // eager access crashed every inherit/ignore spawn under Deno: the
      // getter fired while building this very object, so `pboss upgrade`
      // died inside defaultSpawn before the channel command ever ran, and
      // `runtime change`/startup/cloud spawns the same way (owner report,
      // 2026-10-07).
      const outPiped = outSink === null && (opts.stdout ?? "pipe") === "pipe";
      const errPiped = errSink === null && (opts.stderr ?? "pipe") === "pipe";

      return {
        pid: child.pid,
        exited,
        stdout: outPiped ? child.stdout : null,
        stderr: errPiped ? child.stderr : null,
        kill(signal = "SIGTERM") {
          try {
            child.kill(signal);
          } catch {
            // already exited — kill is best-effort everywhere in pboss
          }
        },
        unref() {
          // Deno has NO unref for children — and contrary to what this
          // comment once claimed, a spawned child DOES hold the event loop
          // until it exits (verified empirically, 2026-10-07: a bare
          // Deno.Command().spawn() with stdio "null" and no .status access
          // still pins the loop). Detached children therefore outlive this
          // process the only way Deno allows: the parent EXITS (the CLI
          // entries do that explicitly under deno — see src/main.ts), the
          // child is orphaned to init and keeps running.
        },
      };
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
