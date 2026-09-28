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
import { symlink, cp, rm, readdir, stat } from "fs/promises";
import { findBun, findNpm } from "./install-mode";
import type { ProcessManager } from "./process-manager";
import { getRuntime } from "./runtime";
const R = getRuntime();

/** Async existence probe (stat — no sync syscalls on the daemon's loop). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

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
      const { exitCode } = await R.process.capture(["git", "clone", moduleNameOrPath, targetDir]);
      void exitCode;
    } else if (path.isAbsolute(moduleNameOrPath) || moduleNameOrPath.startsWith(".")) {
      // Local path - symlink / junction / copy fallback
      try {
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        await symlink(moduleNameOrPath, targetDir, symlinkType);
      } catch {
        await cp(moduleNameOrPath, targetDir, { recursive: true });
      }
    } else {
      // npm package — install with Bun when available, npm otherwise
      // (compiled standalone installs may not have a system Bun).
      const [installer, installVerb] = await resolveModuleInstaller();
      await R.process.capture([installer, installVerb, moduleNameOrPath], { cwd: MODULE_DIR });
    }

    // Install deps
    if (await pathExists(join(targetDir, "package.json"))) {
      const [installer] = await resolveModuleInstaller();
      const proc = R.process.spawn([installer, "install"], {
        cwd: targetDir,
        stdout: "pipe", stderr: "pipe",
        // windowsHide: console-less-daemon rule (see git clone above).
        windowsHide: true,
      });
      await proc.exited;
    }

    // Load
    await this.load(targetDir);
    return targetDir;
  }

  async load(modulePath: string): Promise<void> {
    try {
      const pkg = (await R.filesystem.readJSON(join(modulePath, "package.json"))) as { main?: string; module?: string; name?: string; version?: string };
      const main = pkg.main || pkg.module || "index.ts";
      const mod: PBossModule = (await import(join(modulePath, main))).default;

      if (!mod.name) mod.name = pkg.name ?? "unknown";
      if (!mod.version) mod.version = pkg.version ?? "0.0.0";

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
    if (await pathExists(modPath)) {
      await rm(modPath, { recursive: true, force: true });
    }
   }

   async loadAll(): Promise<void> {
     if (!(await pathExists(MODULE_DIR))) return;
     const entries = await readdir(MODULE_DIR);
     for (const entry of entries) {
       const modPath = join(MODULE_DIR, entry);
       if (await pathExists(join(modPath, "package.json"))) {
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

/**
 * Pick the package manager for module installs: the system Bun when present
 * (fast, matches pboss), otherwise npm — compiled standalone installs do not
 * require a system Bun, so npm is the fallback there.
 *
 * Returns [executable, add-verb], e.g. ["/usr/local/bin/bun", "add"] or
 * ["/usr/bin/npm", "install"]. Throws a clear error when neither exists.
 */
async function resolveModuleInstaller(): Promise<[string, string]> {
  const bun = await findBun();
  if (bun) return [bun, "add"];

  const npm = findNpm();
  if (npm) return [npm, "install"];

  throw new Error(
    "Cannot install modules: neither `bun` nor `npm` was found on this system. " +
      "pboss is running as a compiled standalone binary, so module installation " +
      "needs a separate package manager. Install Bun (https://bun.sh) or Node.js/npm."
  );
}
