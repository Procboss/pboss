/**
 * ProcBoss (pboss) — installation mode detection.
 *
 * pboss ships in these flavors and this module tells them apart at runtime:
 *
 *   1. Compiled standalone executable (`bun build --compile`, e.g.
 *      `bun build --compile --minify --bytecode ./src/index.ts --outfile
 *      dist/pboss`). The Bun runtime is embedded inside the binary — no
 *      system runtime is required. The daemon is started by re-executing
 *      the binary itself: `<pboss> __daemon`.
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
 * All filesystem access in this module is ASYNC (node:fs/promises — shared
 * code that Bun and Deno implement natively themselves, the same rule the
 * sync node:fs uses) so interpreter resolution never blocks the event loop
 * of the daemon performing it.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { join, dirname, win32 as pathWin32, basename } from "path";
import { createRequire } from "node:module";
import { stat, readFile } from "fs/promises";
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

/** True when the file is TypeScript (run through tsx/strip-types on Node). */
export function isTypeScriptFile(script: string): boolean {
  const ext = script.slice(script.lastIndexOf(".") + 1).toLowerCase();
  return ext === "ts" || ext === "tsx" || ext === "jsx" || ext === "mts";
}

/**
 * True when the script is a JavaScript/TypeScript file — the only kind an
 * app runtime (bun/node/deno) can execute, and therefore the only kind that
 * can run as a node:cluster group. Mirrors the extension list
 * buildWorkerCommand routes to interpreter resolution.
 */
export function isJsTsFile(script: string): boolean {
  const ext = script.slice(script.lastIndexOf(".") + 1).toLowerCase();
  return ["js", "mjs", "cjs", "ts", "tsx", "jsx", "mts", "cts"].includes(ext);
}

/**
 * Which JS runtime does a command's interpreter run? Reads the FIRST token
 * the way an OS would (basename, case-insensitive, .exe-tolerant) so both
 * resolved routes (["/usr/local/bin/bun", "run"]) and stated interpreters
 * (["node"], ["C:\\Program Files\\nodejs\\node.exe"]) classify. Anything
 * else (python, "none", a custom binary) is not one of the three.
 */
export function commandRuntime(cmd: string[]): RuntimeName | null {
  if (!cmd || !cmd[0]) return null;
  // A path can carry EITHER separator style regardless of the host OS — a
  // Windows-style "C:\...\node.exe" must classify on Linux too.
  const bin = basename(cmd[0]).toLowerCase();
  const winBin = pathWin32.basename(cmd[0]).toLowerCase();
  const names = [bin, winBin];
  if (names.includes("bun") || names.includes("bun.exe")) return "bun";
  if (names.includes("deno") || names.includes("deno.exe")) return "deno";
  if (names.some((n) => /^(node|nodejs)(\.exe)?$/.test(n))) return "node";
  return null;
}

/**
 * Does `path` exist and name a regular file? Async stat, never throws.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // missing/unreadable candidate is normal, not an error
    return false;
  }
}

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
export async function findBun(): Promise<string | null> {
  const candidates = bunSearchCandidates({
    whichResult: getRuntime().misc.which("bun") ?? undefined,
    home: process.env.HOME || homedir(),
    bunInstall: process.env.BUN_INSTALL,
    platform: process.platform,
  });
  return firstExistingFile(candidates);
}

/**
 * Async first-match over ordered candidates — every candidate is statted
 * in parallel (no serialization), and the first existing one in CANDIDATE
 * ORDER wins, preserving the documented discovery priority.
 */
async function firstExistingFile(candidates: string[]): Promise<string | null> {
  const hits = await Promise.all(
    candidates.map(async (candidate) => ((await isFile(candidate)) ? candidate : null))
  );
  return hits.find((h): h is string => h !== null) ?? null;
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
export async function enrichPathWithBun(): Promise<boolean> {
  const bun = await findBun();
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
export async function findDeno(): Promise<string | null> {
  const R = getRuntime();
  const candidates = [
    R.misc.which("deno"),
    join(process.env.HOME || homedir(), ".deno", "bin", process.platform === "win32" ? "deno.exe" : "deno"),
  ].filter((c): c is string => !!c);
  return firstExistingFile(candidates);
}

/**
 * Locate the system Node runtime (for running JS workers when no TS-native
 * runtime is available). `process.execPath` is Node itself when pboss runs
 * under Node.
 */
export async function findNode(): Promise<string | null> {
  if (RUNTIME_NAME === "node") return PBOSS_EXECUTABLE;
  const R = getRuntime();
  const candidate = R.misc.which("node");
  if (candidate) return candidate;
  // process.execPath under Bun IS bun, not node — only trust which().
  const fallback = join("/usr/local/bin", process.platform === "win32" ? "node.exe" : "node");
  return (await isFile(fallback)) ? fallback : null;
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

/** Where a usable tsx was found — see findTsx for the routes. */
export type TsxSource = "app" | "path" | "pboss";

/** A resolved tsx runner: the exact interpreter prefix for a TS worker. */
export interface TsxResolution {
  /**
   * The command prefix in front of the script: `[node, <tsx cli>]` for
   * package resolutions (works everywhere — spawning node with a real .mjs
   * argument needs no shell and no shim), or `[<tsx>]` for a direct
   * executable on POSIX PATH (its shebang re-execs node itself).
   */
  cmd: string[];
  /** Which route found it. */
  source: TsxSource;
}

/**
 * Locate a usable tsx (https://github.com/privatenumber/tsx) for running
 * TypeScript under Node — Node's own `--experimental-strip-types` handles
 * only erasable syntax, while tsx runs full TypeScript (enums, namespaces,
 * decorators, tsconfig paths). Searched in order:
 *
 *   1. app-local  — tsx in the worker's own node_modules (the app picked
 *                   its version; resolved through Node resolution from the
 *                   script's directory)
 *   2. PATH       — a real `tsx` executable on PATH. POSIX only: npm's
 *                   Windows shims are .cmd files that cannot be spawned
 *                   without a shell (route 3 covers Windows installs).
 *   3. pboss      — the tsx pboss itself ships as an optionalDependency
 *                   (resolved through pboss's own node_modules, next to
 *                   the installed package)
 *
 * Returns null when no tsx is usable — the caller falls back to Node's
 * type stripping. Never throws: a broken resolution is just a miss.
 */
export async function findTsx(
  node: string,
  script: string
): Promise<TsxResolution | null> {
  // 1. App-local devDependency — the app's own version wins.
  const appTsx = await tsxFromModuleGraph(join(dirname(script), "pboss-probe.js"), node);
  if (appTsx) return { cmd: appTsx, source: "app" };

  // 2. Real executable on PATH (POSIX; a shebang script re-execs node).
  if (process.platform !== "win32") {
    const onPath = getRuntime().misc.which("tsx");
    if (onPath) return { cmd: [onPath], source: "path" };
  }

  // 3. pboss's own optionalDependency.
  const pbossTsx = await tsxFromModuleGraph(import.meta.url, node);
  if (pbossTsx) return { cmd: pbossTsx, source: "pboss" };

  return null;
}

/**
 * `[node, <tsx cli>]` for a tsx package resolvable from `fromFile`'s
 * directory — or null. Reads the package's bin field (string or object
 * form) so the CLI entry is whatever that tsx version actually ships.
 */
async function tsxFromModuleGraph(
  fromFile: string,
  node: string
): Promise<string[] | null> {
  try {
    const req = createRequire(fromFile);
    const pkgJsonPath = req.resolve("tsx/package.json");
    const pkgDir = dirname(pkgJsonPath);
    const pkg = JSON.parse(
      new TextDecoder().decode(await readFile(pkgJsonPath))
    ) as { bin?: string | Record<string, string> };
    // bin: "./dist/cli.mjs" | { tsx: "./dist/cli.mjs" }
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsx;
    if (!binRel) return null;
    const cli = join(pkgDir, binRel);
    if (!(await isFile(cli))) return null;
    // The cli must actually run under the node we resolved — a missing node
    // (checked by the caller before us) makes this whole route pointless.
    if (!(await isFile(node))) return null;
    return [node, cli];
  } catch (err) {
    // Unresolvable, unreadable, or not tsx-shaped — a miss, not an error.
    ignore(`resolve tsx from ${fromFile}`, err);
    return null;
  }
}

/**
 * The pure decision half of resolveScriptInterpreter: given the discovered
 * runtimes (and tsx, when a Node is in play), pick the interpreter prefix.
 * Separated from the I/O so the chain is unit-testable on machines where a
 * fixed system location hides the "no bun" case from a live probe.
 */
export function decideScriptInterpreter(
  script: string,
  found: { bun: string | null; deno: string | null; node: string | null; tsx: TsxResolution | null }
): string[] {
  if (found.bun) return [found.bun, "run"];
  if (found.deno) return [found.deno, "run", "-A"];
  if (found.node) {
    if (isTypeScriptFile(script)) {
      // tsx runs FULL TypeScript under Node — enums, namespaces, decorators,
      // tsconfig paths — everything strip-types rejects. Use it whenever a
      // usable copy exists; the stripping flag remains the zero-dependency
      // fallback (verified by the caller via nodeSupportsTypeStripping).
      if (found.tsx) return found.tsx.cmd;
      return [found.node, "--experimental-strip-types"];
    }
    return [found.node];
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
 * The pure half of the unstated-runtime default (owner rule, 2026-09-29): an
 * app whose runtime was not stated inherits the MAIN runtime running pboss.
 * Returns null when there is no JS main runtime to inherit (a compiled
 * standalone binary) — the machine-wide discovery chain takes over there.
 * Separated from the I/O half (findTsx probing) for the same testability
 * reason as decideScriptInterpreter.
 */
export function inheritMainRuntime(
  script: string,
  main: { name: RuntimeName; exec: string } | null,
  tsx: TsxResolution | null
): string[] | null {
  if (!main) return null;
  if (main.name === "bun") return [main.exec, "run"];
  if (main.name === "deno") return [main.exec, "run", "-A"];
  // node — TypeScript needs tsx (full TS) or type stripping
  if (isTypeScriptFile(script)) {
    return tsx ? tsx.cmd : [main.exec, "--experimental-strip-types"];
  }
  return [main.exec];
}

/**
 * The interpreter command prefix for a JS/TS worker script when the user did
 * not choose one explicitly (owner rule, 2026-09-29):
 *
 *   1. UNSTATED → inherit the MAIN runtime running pboss — `bun run` when
 *      pboss runs under Bun, `deno run -A` under Deno, and Node under Node
 *      (TypeScript through tsx when usable, else --experimental-strip-types).
 *      The app matches its supervisor by default.
 *
 *   2. Compiled install — no JS main runtime of its own, so the machine-wide
 *      discovery chain picks one:
 *        Bun   — `bun run` (TS-native; pboss's original worker runtime)
 *        Deno  — `deno run -A` (TS-native)
 *        Node  — plain for .js/.mjs/.cjs; for .ts/.tsx/.jsx/.mts, tsx when
 *                usable (app-local, on PATH, or shipped with pboss), else
 *                `--experimental-strip-types` on Node ≥ 22.6
 *
 * Throws an actionable error when nothing can run the script — the message
 * names what was searched, exactly like the old Bun-only error did.
 */
export async function resolveScriptInterpreter(script: string): Promise<string[]> {
  // 1. Inherit the main runtime (the owner's default). A compiled binary is
  //    its own executable — PBOSS_EXECUTABLE would spawn the pboss binary,
  //    not a JS runtime, so those installs fall through to discovery.
  if (RUNTIME_NAME === "node") {
    const tsx = isTypeScriptFile(script) ? await findTsx(PBOSS_EXECUTABLE, script) : null;
    return inheritMainRuntime(script, { name: "node", exec: PBOSS_EXECUTABLE }, tsx)!;
  }
  if (RUNTIME_NAME === "deno") {
    return inheritMainRuntime(script, { name: "deno", exec: PBOSS_EXECUTABLE }, null)!;
  }
  if (RUNTIME_NAME === "bun" && !IS_COMPILED) {
    return inheritMainRuntime(script, { name: "bun", exec: PBOSS_EXECUTABLE }, null)!;
  }

  // 2. Compiled install — machine-wide discovery.
  const bun = await findBun();
  if (bun) return [bun, "run"];

  const deno = await findDeno();
  if (deno) return [deno, "run", "-A"];

  const node = await findNode();
  if (!node) {
    return decideScriptInterpreter(script, { bun, deno, node, tsx: null });
  }
  const tsx = isTypeScriptFile(script) ? await findTsx(node, script) : null;
  return decideScriptInterpreter(script, { bun, deno, node, tsx });
}

/**
 * The `bun` executable to use for spawning pboss source files (bun script
 * installs only). Prefers the resolved system Bun; throws with a clear
 * message if it is missing, because a bun script install cannot work
 * without it.
 */
async function requireBun(): Promise<string> {
  const bun = await findBun();
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
export async function currentEntryPath(): Promise<string | null> {
  const R = getRuntime();
  const main = R.misc.mainPath();
  if (main) {
    if (await isFile(main)) return main;
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
      if (resolved && (await isFile(resolved))) return resolved;
    } catch (err) {
      ignore("resolve pboss/dist/cli.js for daemon entry", err);
    }
  }
  return main && (await isFile(main)) ? main : null;
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
export async function daemonSpawnCommand(): Promise<string[]> {
  if (IS_COMPILED) {
    return [PBOSS_EXECUTABLE, "__daemon"];
  }

  const R = getRuntime();
  if (R.name === "bun") {
    const bun = await requireBun();
    const daemonScript = join(import.meta.dir, "daemon.ts");
    if (await isFile(daemonScript)) {
      return [bun, "run", daemonScript];
    }
    const entry = R.misc.mainPath();
    if (entry && (await isFile(entry))) {
      return [bun, "run", entry, "__daemon"];
    }
    throw new Error(
      "Cannot locate the pboss daemon entry for this bun install — reinstall pboss."
    );
  }

  const entry = await currentEntryPath();
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
export async function cliSpawnCommand(...args: string[]): Promise<string[]> {
  if (IS_COMPILED) {
    return [PBOSS_EXECUTABLE, ...args];
  }

  const R = getRuntime();
  if (R.name === "bun") {
    const bun = await requireBun();
    const cliEntry = join(import.meta.dir, "index.ts");
    if (await isFile(cliEntry)) {
      return [bun, "run", cliEntry, ...args];
    }
    const entry = R.misc.mainPath();
    if (entry && (await isFile(entry))) {
      return [bun, "run", entry, ...args];
    }
    throw new Error("Cannot locate the pboss CLI entry for this bun install — reinstall pboss.");
  }

  const entry = await currentEntryPath();
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
export async function installModeDescription(): Promise<string> {
  const R = getRuntime();
  const runtimeName = R.name === "node" ? "Node.js" : R.name === "deno" ? "Deno" : "Bun";
  if (IS_COMPILED) {
    const hasBun = (await findBun()) !== null;
    return hasBun
      ? `compiled standalone binary (${PBOSS_EXECUTABLE}) — the embedded Bun runtime is used; the system Bun is optional`
      : `compiled standalone binary (${PBOSS_EXECUTABLE}) — no system runtime required`;
  }
  return `package install running on the system ${runtimeName} runtime (${PBOSS_EXECUTABLE})`;
}
