/**
 * ProcBoss (pboss) — installation mode detection.
 *
 * pboss ships in these flavors and this module tells them apart at runtime:
 *
 *   1. Compiled standalone executable (`bun build --compile`, produced by
 *      `build:bin` / `build:all`). The Bun runtime is embedded inside the
 *      binary — no system runtime is required. The daemon is started by
 *      re-executing the binary itself: `<pboss> __daemon`.
 *
 *   2. Package install (npm/bun/deno global installs, `bun add -g pboss`,
 *      a git checkout). pboss runs on whatever runtime executes it — Bun,
 *      Node, or Deno (the runtime adapter layer picks each runtime's
 *      native APIs). The daemon is started by re-executing the ENTRY that
 *      is currently running, under the SAME runtime:
 *        bun  → [<bun>, "run", <entry>]      (source TS or bundled JS)
 *        node → [<node>, <entry>]            (bundled dist/cli.js)
 *        deno → [<deno>, "run", -A, <entry>] (bundled dist/cli.js)
 *
 * All code that needs to spawn pboss itself (the daemon, startup scripts,
 * systemd/launchd/schtasks generators, module installs) must go through the
 * helpers here so every flavor keeps working.
 *
 * Runtime detection here follows the architecture: the runtime EXECUTING
 * pboss decides; nothing is persisted, and the installer never chooses.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { join, dirname, win32 as pathWin32 } from "path";
import { createRequire } from "node:module";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { ignore } from "./error-handling";
import { getRuntime } from "./runtime";
import type { RuntimeName } from "./runtime";

/**
 * True when pboss is running as a compiled standalone executable.
 *
 * Only the Bun toolchain compiles pboss today; under Node/Deno installs
 * this is always false. Detection: in a `bun build --compile` binary,
 * `Bun.main` lives under the virtual `$bunfs` filesystem.
 */
export const IS_COMPILED: boolean =
  (typeof Bun !== "undefined" &&
    typeof Bun.main === "string" &&
    Bun.main.includes("$bunfs")) ||
  false;

/**
 * The absolute path of the executable currently running pboss: the compiled
 * pboss binary itself (compiled install), or the system runtime (bun/node/
 * deno) executing the package. Always absolute and symlink-resolved by the
 * runtime.
 */
export const PBOSS_EXECUTABLE: string = process.execPath;

/** The runtime executing pboss right now. */
export const RUNTIME_NAME: RuntimeName = getRuntime().name;

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
 *   1. PATH (the runtime's native which — spawn-time PATH of this process)
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
    whichResult: getRuntime().misc.which("bun") ?? undefined,
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
  /** PATH hit from the runtime's which (spawn-time PATH of the caller). */
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
 * Locate the system Deno runtime (for running TS workers when Bun is
 * absent). Same PATH-plus-well-known-locations rule as findBun.
 */
export function findDeno(): string | null {
  const R = getRuntime();
  const candidates = [
    R.misc.which("deno"),
    join(process.env.HOME || homedir(), ".deno", "bin", process.platform === "win32" ? "deno.exe" : "deno"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const st = statSync(candidate, { throwIfNoEntry: false });
      if (st?.isFile()) return candidate;
    } catch (err) {
      ignore(`stat Deno candidate ${candidate}`, err);
    }
  }
  return null;
}

/**
 * Locate the system Node runtime (for running JS workers when no TS-native
 * runtime is available). `process.execPath` is Node itself when pboss runs
 * under Node.
 */
export function findNode(): string | null {
  if (RUNTIME_NAME === "node") return PBOSS_EXECUTABLE;
  const R = getRuntime();
  const candidate = R.misc.which("node");
  if (candidate) return candidate;
  try {
    // process.execPath under Bun IS bun, not node — only trust which().
    const fallback = join("/usr/local/bin", process.platform === "win32" ? "node.exe" : "node");
    const st = statSync(fallback, { throwIfNoEntry: false });
    if (st?.isFile()) return fallback;
  } catch (err) {
    ignore("stat node fallback candidate", err);
  }
  return null;
}

/**
 * Can this Node run TypeScript via type stripping (Node ≥ 22.6)? Pure,
 * version-string based — cheap and testable.
 */
export function nodeSupportsTypeStripping(nodePath: string, capture: (cmd: string[]) => Promise<{ stdout: string }> = (cmd) => getRuntime().process.capture(cmd)): Promise<boolean> {
  return capture([nodePath, "--version"]).then(
    (r) => {
      const m = r.stdout.trim().match(/^v(\d+)\.(\d+)/);
      if (!m) return false;
      const [major, minor] = [parseInt(m[1]!), parseInt(m[2]!)];
      return major > 22 || (major === 22 && minor >= 6);
    },
    () => false
  );
}

/**
 * Locate the system npm. Used as a fallback for module installs on compiled
 * installs where Bun is absent.
 */
export function findNpm(): string | null {
  return getRuntime().misc.which("npm");
}

/**
 * The interpreter command prefix for a JS/TS worker script when the user did
 * not choose one explicitly. Preference order (the established pboss
 * behavior first, then every other TS-native runtime, then Node's type
 * stripping):
 *
 *   1. Bun   — `bun run` (TS-native; pboss's original worker runtime)
 *   2. Deno  — `deno run -A` (TS-native)
 *   3. Node  — plain for .js/.mjs/.cjs; `--experimental-strip-types` for
 *              .ts/.tsx/.jsx on Node ≥ 22.6
 *
 * Throws an actionable error when nothing can run the script — the message
 * names what was searched, exactly like the old Bun-only error did.
 */
export function resolveScriptInterpreter(script: string): string[] {
  const bun = findBun();
  if (bun) return [bun, "run"];

  const deno = findDeno();
  if (deno) return [deno, "run", "-A"];

  const node = findNode();
  if (node) {
    const ext = script.slice(script.lastIndexOf(".") + 1).toLowerCase();
    if (["ts", "tsx", "jsx", "mts"].includes(ext)) {
      // Verified lazily by the caller (nodeSupportsTypeStripping) — this
      // function stays synchronous; the flag is always safe to pass on
      // Node ≥ 22.6 and on newer Node it is a no-op.
      return [node, "--experimental-strip-types"];
    }
    return [node];
  }

  throw new Error(
    `Cannot run "${script}": no JavaScript/TypeScript runtime was found on this system. ` +
      `Looked for Bun (${bunSearchDescription()}), Deno (PATH, ~/.deno/bin) and Node (PATH). ` +
      "Install one from https://bun.sh, https://deno.com or https://nodejs.org, " +
      "or select another interpreter with --interpreter (e.g. --interpreter node, " +
      "--interpreter none for standalone binaries)."
  );
}

/**
 * The `bun` executable to use for spawning pboss source files (bun script
 * installs only). Prefers the resolved system Bun; throws with a clear
 * message if it is missing, because a bun script install cannot work
 * without it.
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
 * The entry module currently executing pboss — the file to re-execute to
 * start the daemon under the SAME runtime (the runtime adapter picked the
 * native APIs; the daemon must match).
 *
 *   bun  → Bun.main (source .ts or bundled .js)
 *   node → process.argv[1], when the entry IS the CLI (bin shim runs it);
 *          falls back to resolving the package layout for library users
 *   deno → Deno.mainModule (npm: cached file)
 */
export function currentEntryPath(): string | null {
  const R = getRuntime();
  const main = R.misc.mainPath();
  if (main) {
    if (existsSync(main)) return main;
    // A bun build --compile binary reports a $bunfs path — IS_COMPILED
    // covers that before we get here, but stay honest if it slips through.
    if (main.includes("$bunfs")) return null;
  }

  if (RUNTIME_NAME === "node") {
    // Library consumer (argv[1] is the user's app): resolve the package
    // layout through Node's resolution against this module.
    try {
      const req = createRequire(import.meta.url ?? `${process.cwd()}/`);
      const resolved = req.resolve("pboss/dist/cli.js");
      if (resolved && existsSync(resolved)) return resolved;
    } catch (err) {
      ignore("resolve pboss/dist/cli.js for daemon entry", err);
    }
  }
  return main && existsSync(main) ? main : null;
}

/**
 * Spawn command that starts the pboss daemon, honoring the installation mode
 * and the RUNTIME EXECUTING PBOSS:
 *
 *  - compiled:  `[<pboss binary>, "__daemon"]` — no system runtime needed.
 *  - bun:       `[<bun>, "run", <daemon.ts>]` when sources are on disk
 *               (the classic script install), else `[<bun>, "run", <entry>]`.
 *  - node:      `[<node>, <dist entry>, "__daemon"]`
 *  - deno:      `[<deno>, "run", "-A", <dist entry>, "__daemon"]`
 */
export function daemonSpawnCommand(): string[] {
  if (IS_COMPILED) {
    return [PBOSS_EXECUTABLE, "__daemon"];
  }

  const R = getRuntime();
  if (R.name === "bun") {
    const bun = requireBun();
    const daemonScript = join(import.meta.dir, "daemon.ts");
    if (existsSync(daemonScript)) {
      return [bun, "run", daemonScript];
    }
    const entry = R.misc.mainPath();
    if (entry && existsSync(entry)) {
      return [bun, "run", entry, "__daemon"];
    }
    throw new Error(
      "Cannot locate the pboss daemon entry for this bun install — reinstall pboss."
    );
  }

  const entry = currentEntryPath();
  if (!entry) {
    throw new Error(
      `Cannot locate the pboss entry module to start the daemon under ${R.name} — reinstall pboss.`
    );
  }
  if (R.name === "node") {
    return [PBOSS_EXECUTABLE, entry, "__daemon"];
  }
  return [PBOSS_EXECUTABLE, "run", "-A", entry, "__daemon"];
}

/**
 * Spawn command that runs a pboss CLI subcommand (`resurrect`, `reload`,
 * `kill`, ...), honoring the installation mode and executing runtime.
 */
export function cliSpawnCommand(...args: string[]): string[] {
  if (IS_COMPILED) {
    return [PBOSS_EXECUTABLE, ...args];
  }

  const R = getRuntime();
  if (R.name === "bun") {
    const bun = requireBun();
    const cliEntry = join(import.meta.dir, "index.ts");
    if (existsSync(cliEntry)) {
      return [bun, "run", cliEntry, ...args];
    }
    const entry = R.misc.mainPath();
    if (entry && existsSync(entry)) {
      return [bun, "run", entry, ...args];
    }
    throw new Error("Cannot locate the pboss CLI entry for this bun install — reinstall pboss.");
  }

  const entry = currentEntryPath();
  if (!entry) {
    throw new Error(
      `Cannot locate the pboss entry module for a CLI spawn under ${R.name} — reinstall pboss.`
    );
  }
  if (R.name === "node") {
    return [PBOSS_EXECUTABLE, entry, ...args];
  }
  return [PBOSS_EXECUTABLE, "run", "-A", entry, ...args];
}

/**
 * Human-readable description of the detected installation, used in startup
 * script comments so users can see why a config looks the way it does.
 */
export function installModeDescription(): string {
  const R = getRuntime();
  const runtimeName = R.name === "node" ? "Node.js" : R.name === "deno" ? "Deno" : "Bun";
  if (IS_COMPILED) {
    const hasBun = findBun() !== null;
    return hasBun
      ? `compiled standalone binary (${PBOSS_EXECUTABLE}) — the embedded Bun runtime is used; the system Bun is optional`
      : `compiled standalone binary (${PBOSS_EXECUTABLE}) — no system runtime required`;
  }
  return `package install running on the system ${runtimeName} runtime (${PBOSS_EXECUTABLE})`;
}
