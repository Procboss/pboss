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

import { join, dirname, win32 as pathWin32 } from "path";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { ignore } from "./error-handling";

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
 *
 * PATH alone is not enough: pboss daemons regularly run where no login
 * shell ever touched their environment — systemd/launchd units ship a
 * minimal PATH without per-user bin dirs, so `~/.bun/bin` (the default
 * `curl bun.sh/install` location for user installs) is invisible to
 * Bun.which even though Bun is right there. The search therefore falls
 * back through every well-known location, in priority order:
 *
 *   1. PATH (Bun.which — spawn-time PATH of the current process)
 *   2. $BUN_INSTALL/bin            (set by the official installer)
 *   3. <home>/.bun/bin             (default user install)
 *   4. /usr/local/bin, /usr/bin, /opt/bun/bin
 *   5. /opt/homebrew/bin           (macOS Homebrew, not on the default PATH)
 *
 * Returns null when no Bun exists — only acceptable when `IS_COMPILED` is
 * true (the embedded runtime covers pboss itself, but not user scripts).
 */
export function findBun(): string | null {
  const candidates = bunSearchCandidates({
    whichResult: Bun.which("bun") ?? undefined,
    home: process.env.HOME || homedir(),
    bunInstall: process.env.BUN_INSTALL,
    platform: process.platform,
  });
  for (const candidate of candidates) {
    try {
      // throwIfNoEntry: false — a missing candidate is normal, not an error.
      const st = statSync(candidate, { throwIfNoEntry: false });
      if (st?.isFile()) return candidate;
    } catch (err) {
      ignore(`stat Bun candidate ${candidate}`, err);
    }
  }
  return null;
}

/** Input for bunSearchCandidates — every field is injectable for tests. */
export interface BunSearchContext {
  /** PATH hit from Bun.which (spawn-time PATH of the caller's process). */
  whichResult?: string;
  /** Home directory to check for the default `~/.bun/bin` user install. */
  home?: string;
  /** $BUN_INSTALL — the install PREFIX (contains bin/), set by bun.sh. */
  bunInstall?: string;
  /** Node platform name (process.platform). */
  platform?: string;
}

/**
 * Ordered, de-duplicated absolute Bun candidates for a search context.
 * Pure: no filesystem or environment access, so tests can pin the exact
 * discovery order without touching the host.
 */
export function bunSearchCandidates(ctx: BunSearchContext): string[] {
  const isWin = ctx.platform === "win32";
  const exe = isWin ? "bun.exe" : "bun";
  const home = ctx.home || "";
  const bunInstall = ctx.bunInstall || "";
  // User-provided roots (home, BUN_INSTALL) carry the TARGET platform's
  // shape — join them with that platform's separator so win32 candidates
  // are well-formed even when generated on a POSIX host (and vice versa).
  // The fixed system roots below are POSIX-only locations, joined plainly.
  const userJoin = isWin ? pathWin32.join : join;

  const candidates: (string | undefined)[] = [
    ctx.whichResult,
    bunInstall && userJoin(bunInstall, "bin", exe),
    home && userJoin(home, ".bun", "bin", exe),
    join("/usr/local/bin", exe),
    join("/usr/bin", exe),
    join("/opt/bun/bin", exe),
    // Homebrew on Apple Silicon installs to /opt/homebrew, which is NOT on
    // the PATH a launchd agent gets — only /usr/local/bin (Intel) is.
    ctx.platform === "darwin" ? join("/opt/homebrew/bin", exe) : undefined,
  ];

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
  }
  return unique;
}

/**
 * Where findBun looks — one human-readable line for error messages.
 */
export function bunSearchDescription(): string {
  return (
    "PATH, $BUN_INSTALL/bin, ~/.bun/bin, /usr/local/bin, /usr/bin, " +
    "/opt/bun/bin" +
    (process.platform === "darwin" ? ", /opt/homebrew/bin" : "")
  );
}

/**
 * Prepend the discovered Bun's bin dir to PATH when it is missing.
 *
 * The daemon calls this at startup: daemons spawned by systemd/launchd
 * units (or by an older unit file generated before the multi-location
 * search existed) run with a minimal PATH, and worker children inherit
 * the daemon's environment — `bun`-by-name lookups inside those children
 * would fail even though findBun() can resolve the absolute path. Returns
 * true when PATH was amended.
 */
export function enrichPathWithBun(): boolean {
  const bun = findBun();
  if (!bun) return false;

  const dir = dirname(bun);
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = (process.env.PATH ?? "")
    .split(sep)
    .filter((p) => p.length > 0);
  if (parts.includes(dir)) return false;

  process.env.PATH = [dir, ...parts].join(sep);
  return true;
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
