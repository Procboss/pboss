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
import type { ProcessContainer } from "./process-container";
import { treeKill } from "./utils";

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
      
      const oldPid = container.pid;
  
      console.log(`[pboss] Graceful reload: reloading ${container.name} (${i + 1}/${containers.length})`);
  
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
          Bun.sleep(listenTimeout),
        ]);
        if (checkReady) clearInterval(checkReady);
      } else {
        await startPromise;
        await Bun.sleep(delay);
      }
  
      if (oldPid) {
        try {
          if (container.config.treekill !== false) {
            await treeKill(oldPid, "SIGTERM");
          } else {
            process.kill(oldPid, "SIGTERM" as any);
          }
        } catch {}
      }
  
      if (i < containers.length - 1) {
        await Bun.sleep(delay);
      }
    }
  
    console.log(`[pboss] Graceful reload complete`);
  }
}
