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
import { resolveScriptInterpreter, findBun } from "./install-mode";
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

     if (config.interpreter) {
       if (config.interpreter !== "none" && config.interpreter !== "binary" && config.interpreter !== "direct") {
         cmd.push(config.interpreter);
         if (config.interpreterArgs) cmd.push(...config.interpreterArgs);
       }
     } else {
       const ext = path.extname(config.script).slice(1).toLowerCase();
       if (ext === "ts" || ext === "tsx" || ext === "jsx" || ext === "mjs" || ext === "cjs" || ext === "js") {
         cmd.push(...await resolveScriptInterpreter(config.script));
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
     }

     if (config.nodeArgs?.length) {
       cmd.push(...config.nodeArgs);
     }

     cmd.push(path.resolve(config.script));
     if (config.args?.length) cmd.push(...config.args);

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
