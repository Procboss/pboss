/**
 * ProcBoss (pboss) — JavaScript & TypeScript Process Manager
 * A production-grade, runtime-agnostic process manager — Bun, Node.js and Deno.
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
import type { ProcessContainer } from "./process-container";
import { treeKill } from "./utils";
import { ignore } from "./error-handling";
import { getRuntime } from "./runtime";
const R = getRuntime();

export class GracefulReload {
  async reload(
    containers: ProcessContainer[],
    options: {
      delay?: number;
      listenTimeout?: number;
    } = {}
  ): Promise<void> {
    const delay = options.delay || 1000;
    const listenTimeout = options.listenTimeout || 3000;
  
    for (let i = 0; i < containers.length; i++) {
      const container = containers[i];
      if (!container) continue;

      // node:cluster apps (owner rule, 2026-09-29): the wrapper primary owns
      // a zero-downtime rolling reload — SIGHUP replaces each worker with a
      // confirmed-online replacement before retiring the old one. Nothing to
      // stop/start here; pboss just signals. (Windows has no SIGHUP — those
      // installs fall through to the stop/start cycle below.)
      if (
        container.config.nodeCluster &&
        process.platform !== "win32" &&
        container.pid
      ) {
        console.log(
          `[pboss] Graceful reload: ${container.name} (${i + 1}/${containers.length}) — node:cluster rolling`
        );
        try {
          process.kill(container.pid, "SIGHUP");
        } catch (err) {
          ignore("SIGHUP node:cluster wrapper", err);
        }
        await R.misc.sleep(delay);
        continue;
      }

      const oldPid = container.pid;
  
      console.log(`[pboss] Graceful reload: reloading ${container.name} (${i + 1}/${containers.length})`);
  
      // Captured BEFORE start() — the old generation's process object (for
      // an online container start() is a no-op, so this stays current).
      const oldProcess = container.process;
      const startPromise = container.start();
  
      if (container.config.waitReady) {
        let checkReady: ReturnType<typeof setInterval> | null = null;
        await Promise.race([
          new Promise<void>((resolve) => {
            checkReady = setInterval(() => {
              if (container.status === "online") {
                if (checkReady) clearInterval(checkReady);
                resolve();
              }
            }, 100);
          }),
          R.misc.sleep(listenTimeout),
        ]);
        if (checkReady) clearInterval(checkReady);
      } else {
        await startPromise;
        await R.misc.sleep(delay);
      }
  
      if (oldPid) {
        // Issue #32: pboss itself is terminating the old generation — that
        // exit must NOT surface as a `process:crashed` event (crashed is
        // reserved for exits pboss did not initiate). handleExit resets the
        // flag when it runs; the exited reset also covers the case where
        // handleExit is suppressed mid-restart.
        (container as any).stopInitiated = true;
        if (oldProcess) {
          oldProcess.exited
            .then(() => {
              if ((container as any).stopInitiated) (container as any).stopInitiated = false;
            })
            .catch((err: unknown) =>
              ignore("reset stopInitiated after reload kill", err)
            );
        }
        try {
          if (container.config.treekill !== false) {
            await treeKill(oldPid, "SIGTERM");
          } else {
            process.kill(oldPid, "SIGTERM" as any);
          }
        } catch (err) {
          // Old process already gone — reload continues with the new one.
          ignore(`SIGTERM old pid ${oldPid} during reload`, err);
        }
      }
  
      if (i < containers.length - 1) {
        await R.misc.sleep(delay);
      }
    }
  
    console.log(`[pboss] Graceful reload complete`);
  }
}
