/**
 * ProcBoss (pboss) — cluster / multiple-instance manager.
 *
 * pboss's instance model is PROCESS-BASED: each worker is an independent
 * OS process carrying PBOSS_WORKER_ID/NODE_APP_INSTANCE env (and a PORT
 * offset when a base port is configured). The runtime-specific half — the
 * spawning itself — goes through the runtime adapter, so every runtime
 * uses ITS native process API (Bun.spawn / node:child_process /
 * Deno.Command). The instance semantics (worker env, restart accounting,
 * per-worker logs) are runtime-independent core logic and stay here.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */
import type { ProcessDescription } from "./types";
import { getCpuCount, readEnvFileOverrides } from "./utils";
import {
  resolveScriptInterpreter,
  commandRuntime,
  findBun,
  nodeSupportsTypeStripping,
  runtimeCommandPrefix,
} from "./install-mode";
import { effectiveProcessRuntime } from "./runtime-overrides";
import { mergeDenoPermissions } from "./deno-permissions";
import { getRuntime } from "./runtime";
import type { PBChild } from "./runtime";
import path from "path"

const R = getRuntime();

export class ClusterManager {
   private workers: Map<number, Map<number, PBChild>> = new Map();

   resolveInstances(instances: number | string | undefined): number {
     if (instances === undefined || instances === 0) return 1;
     if (typeof instances === "string") {
       if (instances === "max" || instances === "-1") return getCpuCount();
       return parseInt(instances) || 1;
     }
     if (instances === -1) return getCpuCount();
     return instances;
   }

   createWorkerEnv(
     baseEnv: Record<string, string>,
     workerId: number,
     totalWorkers: number,
     basePort?: number
   ): Record<string, string> {
     return {
       ...baseEnv,
       PBOSS_CLUSTER: "true",
       PBOSS_WORKER_ID: String(workerId),
       PBOSS_INSTANCES: String(totalWorkers),
       BM2_CLUSTER: "true",
       BM2_WORKER_ID: String(workerId),
       BM2_INSTANCES: String(totalWorkers),
       NODE_APP_INSTANCE: String(workerId),
       ...(basePort ? { PORT: String(basePort + workerId) } : {}),
     };
   }

   /**
    * Build the full worker command line. Async: JS/TS scripts resolve their
    * interpreter through the runtime discovery chain (which may stat several
    * candidate paths) — never blocking the daemon's event loop.
    */
   async buildWorkerCommand(config: ProcessDescription): Promise<string[]> {
     const cmd: string[] = [];
     // Runtime-unique features bookkeeping (deno permissions): routeEnd marks
     // where the interpreter/interpreter-args (or pboss's RESOLVED route)
     // region ends — before node-args. routeIsResolved is true only when the
     // region was built by pboss's own resolution, whose `deno run -A` default
     // is strippable the moment the user states a permission list; a
     // user-stated -A (via --interpreter-args) is never stripped, only
     // deduplicated against.
     let routeIsResolved = false;

     if (config.interpreter) {
       if (config.interpreter !== "none" && config.interpreter !== "binary" && config.interpreter !== "direct") {
         cmd.push(config.interpreter);
         if (config.interpreterArgs) cmd.push(...config.interpreterArgs);
       }
     } else {
       const ext = path.extname(config.script).slice(1).toLowerCase();
       if (ext === "ts" || ext === "tsx" || ext === "jsx" || ext === "mjs" || ext === "cjs" || ext === "js") {
         // Issue #40 — an unstated interpreter resolves through the override
         // chain BEFORE the inherit/discovery fallback: 1) runtime-overrides
         // (the process's own name / cluster base, then its ecosystem config
         // path), 2) ~/.pboss/.runtime (the machine-wide default), 3) the
         // previous inherit/discovery behavior. A STATED interpreter (the
         // branch above) always wins — the app-level setting stays the most
         // explicit, per-app choice, distinct from this global mechanism.
         const pinned = await effectiveProcessRuntime(config.name, config.ecosystemPath);
         cmd.push(...(pinned
           ? await runtimeCommandPrefix(pinned, config.script)
           : await resolveScriptInterpreter(config.script)));
       } else if (ext === "py") {
         cmd.push(process.platform === "win32" ? "python" : "python3");
       } else if (ext === "go") {
         cmd.push("go", "run");
       } else if (ext === "rb") {
         cmd.push("ruby");
       } else if (ext === "php") {
         cmd.push("php");
       } else if (ext === "jar") {
         cmd.push("java", "-jar");
       } else if (ext === "bat" || ext === "cmd") {
         cmd.push("cmd.exe", "/c");
       } else if (ext === "ps1") {
         cmd.push("powershell.exe", "-ExecutionPolicy", "Bypass", "-File");
       } else if (ext === "sh" || ext === "bash") {
         cmd.push(process.platform === "win32" ? "bash" : "sh");
       } else if (ext === "exe" || ext === "bin" || ext === "") {
         // Standalone compiled executable (Go, Rust, C/C++, Swift, etc.) — executed directly
       } else {
         cmd.push(...await resolveScriptInterpreter(config.script));
       }
       // The extension branches above (python/go/ruby/… resolutions) are all
       // pboss's own choices — non-deno by construction, so marking the whole
       // else-branch "resolved" is safe for the -A strip (only the deno route
       // ever carries one).
       routeIsResolved = true;
     }

     const routeEnd = cmd.length;

     if (config.nodeArgs?.length) {
       cmd.push(...config.nodeArgs);
     }

     // ── Runtime-unique features (owner request, 2026-10-06) ─────────────
     // A permission list is a DENO-only concept, translated here at the ONE
     // place every app command is assembled (fork + cluster per-instance;
     // the node:cluster wrapper uses buildNodeClusterCommand below —
     // node-only by contract). mergeDenoPermissions returns the prefix
     // unchanged for every non-deno runtime (bun/node have no permission
     // model), never duplicates a permission the user already stated in
     // interpreter/node args, and replaces pboss's own `deno run -A` default
     // with the specific list.
     if (config.permissions?.length) {
       const merged = mergeDenoPermissions(cmd, config.permissions, {
         defaultAllEnd: routeIsResolved ? routeEnd : 0,
       });
       // merged may be the SAME array (non-deno runtimes return the prefix
       // untouched) — never clear-and-refill cmd, or the shared reference
       // empties itself: append the script to the returned array instead.
       if (merged !== cmd) {
         cmd.length = 0;
         cmd.push(...merged);
       }
     }

     cmd.push(path.resolve(config.script));
     if (config.args?.length) cmd.push(...config.args);

     return cmd;
   }

   /**
   * The command for a node:cluster app's PRIMARY wrapper (owner rule,
   * 2026-09-29): `node [flags] <wrapper>`. The wrapper runs under the same
   * Node — and the same node flags — the app's workers get, because
   * cluster workers inherit the primary's execArgv: `--experimental-strip-types`
   * and `--import tsx` propagate from here to every worker, while an
   * argv-based tsx CLI cannot (its loader lives in argv, not execArgv).
   *
   * The interpreter route mirrors buildWorkerCommand exactly so a cluster
   * app and a single instance of the same app resolve the same runtime.
   *
   * Deno permissions are deliberately NOT translated here: node:cluster is
   * Node-only by contract (this method throws for any non-node route), and
   * permissions are a deno-unique feature — ignored under Node by design.
   */
  async buildNodeClusterCommand(
    config: ProcessDescription,
    wrapperPath: string
  ): Promise<string[]> {
    let route: string[];
    if (
      config.interpreter &&
      config.interpreter !== "none" &&
      config.interpreter !== "binary" &&
      config.interpreter !== "direct"
    ) {
      route = [config.interpreter];
    } else {
      // Issue #40: the same override chain as buildWorkerCommand's js/ts
      // branch — a cluster app and a single instance of the same app must
      // resolve the same runtime.
      const pinned = await effectiveProcessRuntime(config.name, config.ecosystemPath);
      route = pinned
        ? await runtimeCommandPrefix(pinned, config.script)
        : await resolveScriptInterpreter(config.script);
    }
    if (commandRuntime(route) !== "node") {
      // Defensive: the ProcessManager only sets nodeCluster after resolving
      // the app runtime to Node. A config that reaches here anyway is a bug
      // or a hand-edited dump — fail loudly instead of spawning a non-node
      // primary for a node app.
      throw new Error(
        `node:cluster mode requires the app to run under Node (resolved: ${route.join(" ")}). ` +
          "Remove nodeCluster from the saved process list or start the app with --interpreter node."
      );
    }

    const [nodeBin, ...routeRest] = route;
    const inheritedFlags: string[] = [];
    let sawTsxCli = false;
    for (const piece of routeRest) {
      if (piece.startsWith("-")) {
        inheritedFlags.push(piece); // --experimental-strip-types etc. — execArgv, propagates
      } else {
        sawTsxCli = true; // the tsx CLI is argv-based — cannot reach cluster workers
      }
    }
    if (sawTsxCli) {
      // tsx route: workers cannot inherit a CLI loader. Strip types covers
      // every TS construct Node can strip when the Node supports it; full
      // TS (enums, namespaces, decorators) needs the user's own execArgv:
      //   pboss start app.ts --interpreter node --node-args "--import tsx"
      if (await nodeSupportsTypeStripping(nodeBin!)) {
        inheritedFlags.push("--experimental-strip-types");
      } else {
        throw new Error(
          `Cannot cluster "${config.script}" under Node: the tsx loader cannot propagate to node:cluster workers ` +
            "and this Node cannot strip types (Node < 22.6). " +
            'Start it with --node-args "--import tsx" (Node 20.6+), a newer Node, or without cluster mode.'
        );
      }
    }

    const cmd = [nodeBin!];
    if (config.interpreterArgs?.length) cmd.push(...config.interpreterArgs);
    if (config.nodeArgs?.length) cmd.push(...config.nodeArgs);
    cmd.push(...inheritedFlags);
    cmd.push(wrapperPath);
    return cmd;
  }

  async spawnWorker(
     config: ProcessDescription,
     workerId: number,
     totalWorkers: number,
     logStreams: { stdout: "pipe" | "inherit"; stderr: "pipe" | "inherit" }
   ): Promise<PBChild> {
     const cmd = await this.buildWorkerCommand(config);
     const env = this.createWorkerEnv(
       {
         ...(process.env as Record<string, string>),
         ...config.env,
         // Same rule as fork mode: the app dir's .env is re-read at every
         // (re)spawn and takes precedence over the start-time snapshot.
         ...await readEnvFileOverrides(config.cwd),
       },
       workerId,
       totalWorkers,
       config.port
     );

     // The runtime adapter's NATIVE spawn — Bun.spawn / node:child_process
     // / Deno.Command, picked once at startup, no per-call branching.
     const proc = R.process.spawn(cmd, {
       cwd: config.cwd || process.cwd(),
       env,
       stdout: logStreams.stdout,
       stderr: logStreams.stderr,
       stdin: "ignore",
       // windowsHide (issue #36 follow-up): cluster workers spawn from the
       // console-less daemon — without this flag each worker gets its own
       // VISIBLE console window on Windows. Same contract as fork mode:
       // hidden, piped output, still supervised (NOT detached).
       windowsHide: true,
     });

     if (!this.workers.has(config.id)) {
       this.workers.set(config.id, new Map());
     }
     this.workers.get(config.id)!.set(workerId, proc);

     return proc;
   }

   getWorkers(processId: number): Map<number, PBChild> | undefined {
     return this.workers.get(processId);
   }

   removeWorker(processId: number, workerId: number) {
     this.workers.get(processId)?.delete(workerId);
   }

   removeAllWorkers(processId: number) {
     this.workers.delete(processId);
   }
}

export { findBun };
