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

import path, { join } from "path";
import { MODULE_DIR } from "./constants";
import { existsSync, readdirSync, symlinkSync, cpSync, rmSync } from "fs";
import type { ProcessManager } from "./process-manager";

export interface PBossModule {
  name: string;
  version: string;
  init(pm: ProcessManager): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

export class ModuleManager {
  private modules: Map<string, PBossModule> = new Map();
  private pm: ProcessManager;

  constructor(pm: ProcessManager) {
    this.pm = pm;
  }

  async install(moduleNameOrPath: string): Promise<string> {
    const targetDir = join(MODULE_DIR, moduleNameOrPath.replace(/[^a-zA-Z0-9_-]/g, "_"));

    if (moduleNameOrPath.startsWith("http") || moduleNameOrPath.startsWith("git")) {
      // Clone from git
      const proc = Bun.spawn(["git", "clone", moduleNameOrPath, targetDir], {
        stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
    } else if (path.isAbsolute(moduleNameOrPath) || moduleNameOrPath.startsWith(".")) {
      // Local path - symlink / junction / copy fallback
      try {
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        symlinkSync(moduleNameOrPath, targetDir, symlinkType);
      } catch {
        cpSync(moduleNameOrPath, targetDir, { recursive: true });
      }
    } else {
      // npm package
      const proc = Bun.spawn(["bun", "add", moduleNameOrPath], {
        cwd: MODULE_DIR,
        stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
    }

    // Install deps
    if (existsSync(join(targetDir, "package.json"))) {
      const proc = Bun.spawn(["bun", "install"], {
        cwd: targetDir,
        stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
    }

    // Load
    await this.load(targetDir);
    return targetDir;
  }

  async load(modulePath: string): Promise<void> {
    try {
      const pkg = await Bun.file(join(modulePath, "package.json")).json();
      const main = pkg.main || pkg.module || "index.ts";
      const mod: PBossModule = (await import(join(modulePath, main))).default;

      if (!mod.name) mod.name = pkg.name;
      if (!mod.version) mod.version = pkg.version;

      await mod.init(this.pm);
      this.modules.set(mod.name, mod);
      console.log(`[pboss] Module loaded: ${mod.name}@${mod.version}`);
    } catch (err: any) {
      console.error(`[pboss] Failed to load module ${modulePath}:`, err.message);
    }
  }
 
   async uninstall(name: string): Promise<void> {
     const mod = this.modules.get(name);
     if (mod?.destroy) await mod.destroy();
     this.modules.delete(name);
 
    const modPath = join(MODULE_DIR, name);
    if (existsSync(modPath)) {
      rmSync(modPath, { recursive: true, force: true });
    }
   }
 
   async loadAll(): Promise<void> {
     if (!existsSync(MODULE_DIR)) return;
     const entries = readdirSync(MODULE_DIR);
     for (const entry of entries) {
       const modPath = join(MODULE_DIR, entry);
       if (existsSync(join(modPath, "package.json"))) {
         await this.load(modPath);
       }
     }
   }
 
   list(): Array<{ name: string; version: string }> {
     return Array.from(this.modules.values()).map((m) => ({
       name: m.name,
       version: m.version,
     }));
   }
 }
