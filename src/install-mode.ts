/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Installation mode detection.
 *
 * pboss ships in two flavors and this module tells them apart at runtime:
 *
 *   1. Compiled standalone executable (`bun build --compile`, produced by the
 *      one-line installer and `build:bin`). The Bun runtime is
 *      embedded inside the binary — a system-wide Bun installation is NOT
 *      required. The daemon is started by re-executing the binary itself:
 *      `<pboss> __daemon`.
 *
 *   2. Script install (npm / `bun add -g pboss`, or a git checkout). pboss runs
 *      on the system's Bun runtime, which is therefore required. The daemon is
 *      started as `<bun> run <daemon.ts>`.
 *
 * All code that needs to spawn pboss itself (the daemon, startup scripts,
 * systemd/launchd/schtasks generators, module installs) must go through the
 * helpers here so both flavors keep working.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { join } from "path";
import { existsSync } from "fs";

/**
 * Executable names that mean the current host process is the Bun runtime
 * itself (script install), as opposed to a compiled pboss binary.
 */
const BUN_HOST_NAMES = new Set([
  "bun",
  "bun.exe",
  "bunx",
  "bunx.exe",
  "bun-debug",
  "bun-debug.exe",
]);

/**
 * True when pboss is running as a compiled standalone executable.
 *
 * Detection (verified against Bun 1.3.x):
 *  - In a `bun build --compile` binary, `Bun.main` / `import.meta.dir` live
 *    under the virtual `$bunfs` filesystem, and `process.execPath` points at
 *    the compiled binary itself (not at a `bun` executable).
 *  - In script mode, `process.execPath` is the system `bun` binary and module
 *    paths are real on-disk locations.
 */
export const IS_COMPILED: boolean =
  (typeof Bun.main === "string" && Bun.main.includes("$bunfs")) ||
  !BUN_HOST_NAMES.has(
    (process.execPath.split(/[\\/]/).pop() || "").toLowerCase()
  );

/**
 * The absolute path of the executable currently running pboss:
 * the compiled pboss binary itself (compiled install), or the system Bun
 * runtime (script install). Always absolute and symlink-resolved by Bun.
 */
export const PBOSS_EXECUTABLE: string = process.execPath;

/**
 * Locate the system Bun runtime.
 * Returns null when Bun is not installed — which is only acceptable when
 * `IS_COMPILED` is true (the embedded runtime covers pboss itself, but not
 * user scripts that need a `bun` interpreter).
 */
export function findBun(): string | null {
  return Bun.which("bun") ?? null;
}

/**
 * Locate the system npm. Used as a fallback for module installs on compiled
 * installs where Bun is absent.
 */
export function findNpm(): string | null {
  return Bun.which("npm") ?? null;
}

/**
 * The `bun` executable to use for spawning pboss source files (script install
 * only). Prefers the resolved system Bun; throws with a clear message if it
 * is missing, because a script install cannot work without it.
 */
function requireBun(): string {
  const bun = findBun();
  if (!bun) {
    throw new Error(
      "The system Bun runtime is required for this script install of pboss " +
        "but was not found on PATH. Reinstall pboss or ensure `bun` is available."
    );
  }
  return bun;
}

/**
 * Spawn command that starts the pboss daemon, honoring the installation mode:
 *
 *  - compiled: `[<pboss binary>, "__daemon"]` — no system Bun needed.
 *  - script:   `[<bun>, "run", <daemon.ts>]`, falling back to re-executing
 *              the CLI entry (`[<bun>, "run", <entry>, "__daemon"]`) when the
 *              source tree layout is unusual.
 */
export function daemonSpawnCommand(): string[] {
  if (IS_COMPILED) {
    return [PBOSS_EXECUTABLE, "__daemon"];
  }

  const bun = requireBun();
  const daemonScript = join(import.meta.dir, "daemon.ts");
  if (existsSync(daemonScript)) {
    return [bun, "run", daemonScript];
  }
  // Unusual script layout (bundled without sources): re-execute the entry.
  return [bun, "run", Bun.main, "__daemon"];
}

/**
 * Spawn command that runs a pboss CLI subcommand (`resurrect`, `reload`,
 * `kill`, ...), honoring the installation mode.
 *
 *  - compiled: `[<pboss binary>, ...args]`
 *  - script:   `[<bun>, "run", <index.ts>, ...args]`
 */
export function cliSpawnCommand(...args: string[]): string[] {
  if (IS_COMPILED) {
    return [PBOSS_EXECUTABLE, ...args];
  }

  const bun = requireBun();
  const cliEntry = join(import.meta.dir, "index.ts");
  if (existsSync(cliEntry)) {
    return [bun, "run", cliEntry, ...args];
  }
  // Unusual script layout: re-execute the running entry.
  return [bun, "run", Bun.main, ...args];
}

/**
 * Human-readable description of the detected installation, used in startup
 * script comments so users can see why a config looks the way it does.
 */
export function installModeDescription(): string {
  if (IS_COMPILED) {
    const hasBun = findBun() !== null;
    return hasBun
      ? `compiled standalone binary (${PBOSS_EXECUTABLE}) — the embedded Bun runtime is used; the system Bun is optional`
      : `compiled standalone binary (${PBOSS_EXECUTABLE}) — no system Bun required`;
  }
  const bun = findBun();
  return bun
    ? `script install running on the system Bun runtime (${bun})`
    : `script install — system Bun runtime expected but not found on PATH`;
}
