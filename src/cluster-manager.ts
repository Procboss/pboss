/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */
import type { Subprocess } from "bun";
import type { ProcessDescription } from "./types";
import { getCpuCount } from "./utils";
import { findBun } from "./install-mode";
import path from "path"
 
export class ClusterManager {
   private workers: Map<number, Map<number, Subprocess>> = new Map();
 
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
 
   buildWorkerCommand(config: ProcessDescription): string[] {
     const cmd: string[] = [];
 
     if (config.interpreter) {
       if (config.interpreter !== "none" && config.interpreter !== "binary" && config.interpreter !== "direct") {
         cmd.push(config.interpreter);
         if (config.interpreterArgs) cmd.push(...config.interpreterArgs);
       }
     } else {
       const ext = path.extname(config.script).slice(1).toLowerCase();
       if (ext === "ts" || ext === "tsx" || ext === "jsx" || ext === "mjs" || ext === "cjs" || ext === "js") {
         cmd.push(resolveBunForScript(config.script));
         cmd.push("run");
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
         cmd.push(resolveBunForScript(config.script));
         cmd.push("run");
       }
     }
 
     if (config.nodeArgs?.length) {
       cmd.push(...config.nodeArgs);
     }
 
     cmd.push(path.resolve(config.script));
     if (config.args?.length) cmd.push(...config.args);
 
     return cmd;
   }
 
   spawnWorker(
     config: ProcessDescription,
     workerId: number,
     totalWorkers: number,
     logStreams: { stdout: "pipe" | "inherit"; stderr: "pipe" | "inherit" }
   ): Subprocess {
     const cmd = this.buildWorkerCommand(config);
     const env = this.createWorkerEnv(
       { ...process.env as Record<string, string>, ...config.env },
       workerId,
       totalWorkers,
       config.port
     );
 
     const proc = Bun.spawn(cmd, {
       cwd: config.cwd || process.cwd(),
       env,
       stdout: logStreams.stdout,
       stderr: logStreams.stderr,
       stdin: "ignore",
     });
 
     if (!this.workers.has(config.id)) {
       this.workers.set(config.id, new Map());
     }
     this.workers.get(config.id)!.set(workerId, proc);
 
     return proc;
   }
 
   getWorkers(processId: number): Map<number, Subprocess> | undefined {
     return this.workers.get(processId);
   }
 
   removeWorker(processId: number, workerId: number) {
     this.workers.get(processId)?.delete(workerId);
   }
 
   removeAllWorkers(processId: number) {
     this.workers.delete(processId);
   }
 }

/**
 * Resolve the Bun interpreter for a JS/TS worker script.
 *
 * Uses the absolute path of the system Bun so spawned workers survive
 * minimal-PATH environments (systemd, launchd, containers). On compiled
 * installs the system Bun is optional — if it is missing we fail with an
 * actionable message instead of a confusing ENOENT on a bare `bun` name.
 */
function resolveBunForScript(script: string): string {
  const bun = findBun();
  if (!bun) {
    throw new Error(
      `Cannot run "${script}": the Bun runtime was not found on this system. ` +
        "pboss itself is running as a compiled standalone binary, so executing " +
        "JavaScript/TypeScript worker scripts requires a separate Bun installation. " +
        "Install Bun from https://bun.sh, or select another runtime with " +
        "--interpreter (e.g. --interpreter node, --interpreter none for binaries)."
    );
  }
  return bun;
}
