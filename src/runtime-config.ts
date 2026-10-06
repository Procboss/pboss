/**
 * ProcBoss (pboss) — the persistent, user-selected runtime configuration.
 * https://procboss.com
 * License: GPL-3.0-only
 *
 * ONE canonical contract, shared by every component that touches runtimes:
 *
 *   The USER chooses the runtime (node | bun | deno). ProcBoss remembers it
 *   in `~/.pboss/.runtime` (plain text, one lowercase word — PBOSS_HOME
 *   overrides the directory). The wrapper (bin/pboss.sh / bin/pboss.ps1)
 *   reads it and dispatches to the runtime-specific entrypoint
 *   (dist/cli.node.js / cli.bun.js / cli.deno.js).
 *
 * Resolution order (mirrored by the wrappers, pinned by tests):
 *   1. `~/.pboss/.runtime`            — persistent, survives upgrades
 *   2. `--runtime=<x>` (pre-`--`)     — one-invocation override; initializes
 *                                        the file when none exists, never
 *                                        silently overwrites an existing one
 *   3. interactive selection          — first run; Node is the default
 *
 * The system NEVER infers the runtime from whatever happens to be on PATH
 * (spec: runtime selection is an explicit ProcBoss configuration).
 *
 * The shell/PowerShell wrappers implement the same scan/validation in their
 * own language (a shell script cannot import TypeScript); tests/wrapper.test.ts
 * pins the runtime LIST and the exact error texts so the implementations can
 * never drift apart.
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { PBOSS_HOME } from "./constants";
import { getRuntime } from "./runtime";
import { DENO_MIN_DEP_AGE_FLAG, fetchDenoEligibility } from "./deno-eligibility";

const R = getRuntime();

/* ── the canonical list (one set of supported runtimes, everywhere) ─────── */

/** The supported ProcBoss runtimes — the single source of truth for TS code. */
export const SUPPORTED_RUNTIMES = ["node", "bun", "deno"] as const;
export type RuntimeChoice = (typeof SUPPORTED_RUNTIMES)[number];

/** Short labels used in prompts and override notices ("Node", not "Node.js"). */
export function runtimeLabel(name: RuntimeChoice): string {
  switch (name) {
    case "node":
      return "Node";
    case "bun":
      return "Bun";
    case "deno":
      return "Deno";
  }
}

/** The persistent selection file. PBOSS_HOME overrides ~/.pboss (tests, portability). */
export const RUNTIME_FILE = join(PBOSS_HOME, ".runtime");

/** Validate a runtime name after normalization (trim + lowercase). */
export function isValidRuntime(value: string | null | undefined): value is RuntimeChoice {
  return (
    typeof value === "string" &&
    (SUPPORTED_RUNTIMES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

/** Trim + lowercase — the normalized spelling every writer uses (spec §1). */
export function normalizeRuntime(value: string): string {
  return value.trim().toLowerCase();
}

/** The exact "Unsupported runtime" error text (spec §1 — an invalid flag value). */
export function unsupportedRuntimeMessage(value: string): string {
  return (
    `Unsupported runtime: ${value}\n\n` +
    "Supported runtimes:\n" +
    "  node\n" +
    "  bun\n" +
    "  deno"
  );
}

/** The exact "Invalid runtime configuration" error text (spec §20 — a bad .runtime). */
export function invalidRuntimeConfigMessage(value: string): string {
  return (
    `Invalid ProcBoss runtime configuration: ${value}\n\n` +
    "Supported runtimes:\n" +
    "  node\n" +
    "  bun\n" +
    "  deno"
  );
}

/* ── the .runtime file ─────────────────────────────────────────────────── */

/**
 * Read the persisted selection. Null when absent. Throws
 * (invalidRuntimeConfigMessage) when present but unparseable — a broken
 * config must NEVER be silently replaced with a guess (spec §20).
 */
export async function readConfiguredRuntime(file: string = RUNTIME_FILE): Promise<RuntimeChoice | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null; // absent — first run, or wiped
  }
  const normalized = normalizeRuntime(raw);
  if (!isValidRuntime(normalized)) {
    throw new Error(invalidRuntimeConfigMessage(raw.trim()));
  }
  return normalized;
}

/** Read the raw (trimmed) file content without validating — for status display. */
export async function readRuntimeFileRaw(file: string = RUNTIME_FILE): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Persist the selection atomically (tmp + rename): a torn write must never
 * leave the machine without a runtime choice mid-upgrade.
 */
export async function writeRuntimeSelection(
  runtime: RuntimeChoice,
  file: string = RUNTIME_FILE,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${runtime}\n`, "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows rename-over-existing can race an AV scan; retry once via
    // unlink+rename before giving up.
    try {
      await unlink(file);
      await rename(tmp, file);
    } catch {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }
}

/* ── the --runtime flag (mirrors the wrappers' scan; spec §16/§17) ──────── */

export type RuntimeFlagScan = {
  /** True when a --runtime flag appeared before the `--` sentinel. */
  explicit: boolean;
  /** The raw value as typed (unvalidated). */
  value: string | null;
  /** True when `--runtime` was the last pre-sentinel token (missing value). */
  missingValue: boolean;
  /** argv with the flag (and its value) removed — everything else verbatim. */
  rest: string[];
};

/**
 * Scan argv for `--runtime=<x>` / `--runtime <x>` anywhere before `--`.
 * Everything after `--` belongs to the command's own argv and is NEVER
 * touched (the same rule the CLI's start-flag parser applies).
 */
export function scanRuntimeFlag(argv: string[]): RuntimeFlagScan {
  const rest: string[] = [];
  let explicit = false;
  let value: string | null = null;
  let missingValue = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest.push(...argv.slice(i)); // sentinel + everything after, verbatim
      break;
    }
    if (arg === "--runtime") {
      const next = argv[i + 1];
      if (next === undefined) {
        missingValue = true; // value flag at the end — the caller errors
        rest.push(arg);
      } else {
        explicit = true;
        value = next;
        i += 2;
        continue;
      }
    } else if (arg.startsWith("--runtime=")) {
      explicit = true;
      value = arg.slice("--runtime=".length);
      i += 1;
      continue;
    } else {
      rest.push(arg);
    }
    i += 1;
  }
  return { explicit, value, missingValue, rest };
}

/* ── engine + entrypoint plumbing ──────────────────────────────────────── */

/** The dist entry a runtime dispatches to (bin/pboss.sh's dispatch table). */
export function runtimeEntryFile(runtime: RuntimeChoice): string {
  return `cli.${runtime}.js`;
}

/**
 * Absolute path of the per-runtime entry SIBLING to the executing module,
 * or null when this layout ships no built entries (a source checkout).
 */
export function siblingRuntimeEntry(runtime: RuntimeChoice): string | null {
  const main = R.misc.mainPath();
  if (!main) return null;
  const candidate = join(dirname(main), runtimeEntryFile(runtime));
  return existsSync(candidate) ? candidate : null;
}

/**
 * Spawn argv that launches a runtime entry: plain `[<rt>, entry, ...]` for
 * node/bun; `deno run -A` (the entry needs Deno's permissions up front).
 */
export function runtimeSpawnArgv(runtime: RuntimeChoice, entry: string, args: string[]): string[] {
  if (runtime === "deno") return [runtime, "run", "-A", entry, ...args];
  return [runtime, entry, ...args];
}

/* ── ensuring a runtime exists (installer + `pboss runtime change`) ─────── */

/** Is the runtime on PATH, or at its well-known per-user location? */
export function runtimeAvailable(runtime: RuntimeChoice): boolean {
  if (R.misc.which(runtime)) return true;
  if (runtime === "bun") return existsSync(join(homedir(), ".bun", "bin", "bun"));
  if (runtime === "deno") return existsSync(join(homedir(), ".deno", "bin", "deno"));
  return false;
}

/** The rootless, official installer command for a runtime (POSIX). */
export function runtimeInstallCommand(runtime: RuntimeChoice): string[] {
  switch (runtime) {
    case "bun":
      return ["bash", "-c", "curl -fsSL https://bun.sh/install | bash"];
    case "deno":
      return ["bash", "-c", "curl -fsSL https://deno.land/install.sh | sh"];
    case "node":
      // Node has no official one-line installer — its rootless path is the
      // dist tarball, handled by installNodeRootless() below (multi-step).
      return [];
  }
}

/* ── Node's rootless install (the one runtime without a one-liner) ─────── */

/** Map the host to nodejs.org's platform/arch naming; null = unsupported. */
export function nodeDistPlatform(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  if (!os) return null;
  if (arch === "x64" || arch === "amd64") return `${os}-x64`;
  if (arch === "arm64" || arch === "aarch64") return `${os}-arm64`;
  return null;
}

/**
 * Extract the tarball name from a nodejs.org dist directory listing
 * (`https://nodejs.org/dist/latest-v22.x/` → `node-v22.14.0-linux-x64.tar.xz`).
 * Exported for tests; null when the listing holds no match.
 */
export function extractNodeTarballName(listing: string, platformTag: string): string | null {
  const m = listing.match(new RegExp(`node-v\\d+\\.\\d+\\.\\d+-${platformTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tar\\.xz`));
  return m?.[0] ?? null;
}

/** The LTS major the rootless installer pins (bump with each release cycle). */
export const NODE_INSTALL_MAJOR = "v22";

/**
 * Install Node.js rootlessly: the official dist tarball unpacked under
 * ~/.local/opt/node with symlinks in ~/.local/bin (no package manager, no
 * root — the same contract as the Bun/Deno installers). Returns the added
 * PATH dir, or null when the host cannot be served a tarball (Windows:
 * the PowerShell installer handles it instead).
 */
export async function installNodeRootless(
  opts: { fetcher?: typeof fetch; run?: (cmd: string[]) => Promise<number> } = {},
): Promise<string | null> {
  const platformTag = nodeDistPlatform(process.platform, process.arch);
  if (!platformTag) return null;
  const fetcher = opts.fetcher ?? fetch;
  const run = opts.run ?? defaultInstallSpawn;

  const base = `https://nodejs.org/dist/latest-${NODE_INSTALL_MAJOR}.x`;
  let listing: string;
  try {
    const res = await fetcher(`${base}/`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    listing = await res.text();
  } catch {
    return null;
  }
  const file = extractNodeTarballName(listing, platformTag);
  if (!file) return null;

  const home = homedir();
  const dest = join(home, ".local", "opt", "node");
  const binDir = join(home, ".local", "bin");
  const code = await run([
    "bash",
    "-c",
    [
      `set -e`,
      `tmp=$(mktemp -d)`,
      `curl -fsSL "${base}/${file}" -o "$tmp/node.tar.xz"`,
      `mkdir -p "${dest}"`,
      `tar -xJf "$tmp/node.tar.xz" -C "${dest}" --strip-components=1`,
      `mkdir -p "${binDir}"`,
      `for b in node npm npx corepack; do ln -sf "${dest}/bin/$b" "${binDir}/$b" 2>/dev/null || true; done`,
      `rm -rf "$tmp"`,
    ].join("\n"),
  ]);
  return code === 0 ? binDir : null;
}

async function defaultInstallSpawn(cmd: string[]): Promise<number> {
  const proc = R.process.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) ?? -1;
}

/* ── installing pboss FOR a runtime (spec §4: the published package) ─────── */

/** The command that installs/updates the published package for a runtime.
 *  `bypass` (deno only): pass Deno's own age-hold escape hatch so the spec
 *  resolves the release just published instead of falling back. */
export function pbossInstallArgv(runtime: RuntimeChoice, version?: string, bypass = false): string[] {
  const spec = version ? `pboss@${version}` : "pboss@latest";
  switch (runtime) {
    case "node":
      return ["npm", "install", "-g", spec];
    case "bun":
      return ["bun", "add", "-g", spec];
    case "deno":
      // Deno executes npm package bins as MODULES, so the .sh wrapper cannot
      // serve that path — deno installs the PUBLISHED entry subpath directly
      // (verified: `deno install -g -f -A --name pboss npm:pboss/deno-entry`
      // runs dist/cli.deno.js with args forwarded). -f replaces an existing
      // install (deno refuses to overwrite otherwise).
      const argv = ["deno", "install", "-g", "-f", "-A"];
      if (bypass) argv.push(DENO_MIN_DEP_AGE_FLAG);
      argv.push("--name", "pboss", `npm:pboss${version ? `@${version}` : ""}/deno-entry`);
      return argv;
  }
}

/**
 * A resolved install command for the published package — with the delivery
 * vehicle made explicit. `via` differs from the runtime ONLY on the deno
 * npm fallback: npm delivers the package (the bin wrapper), deno executes
 * it at run time (the persistent .runtime selection is unchanged).
 */
export interface PbossInstallCommand {
  argv: string[];
  /** The ecosystem command in argv: the runtime's own, or npm on fallback. */
  via: RuntimeChoice | "npm";
  /** The one honest line to print when via is not the runtime itself. */
  note?: string;
}

/**
 * Resolve the install command for a runtime, honoring Deno's npm
 * supply-chain window (versions published < 24 h ago are unresolvable —
 * see deno-eligibility.ts). When the local deno knows Deno's own escape
 * hatch (`--minimum-dependency-age=0`, probed — never version-guessed),
 * the command carries the flag and pins the registry's TRUE latest: the
 * version package.json carried into the publish installs immediately.
 * Older denos keep the window-aware pin; when no deno-entry-capable
 * version is resolvable yet, npm delivers the package (the bin wrapper
 * dispatches to deno at run time) and the command says so.
 *
 * `minDepAgeProber` defaults to "no flag" — deterministic for tests; the
 * live caller (the runtime-change flow) passes the real probe so the
 * bypass engages exactly when the local deno supports it.
 */
export async function resolvePbossInstallArgv(
  runtime: RuntimeChoice,
  version?: string,
  fetcher: typeof fetch = fetch,
  minDepAgeProber: () => Promise<boolean> = async () => false,
): Promise<PbossInstallCommand> {
  if (runtime !== "deno") {
    return { argv: pbossInstallArgv(runtime, version), via: runtime };
  }

  // An explicit version is the user's own pin — honored as-is, with the
  // flag when available (a freshly published pin would otherwise error).
  if (version) {
    const bypass = await minDepAgeProber();
    return { argv: pbossInstallArgv("deno", version, bypass), via: "deno" };
  }

  const [eligibility, bypass] = await Promise.all([
    fetchDenoEligibility(fetcher),
    minDepAgeProber(),
  ]);

  if (bypass) {
    // Deno ≥ 2.9: the flag disables the hold for this resolution —
    // install the registry's true latest; unpinned + flag when the
    // registry could not be read.
    return {
      argv: pbossInstallArgv("deno", eligibility?.latest ?? undefined, true),
      via: "deno",
      note:
        eligibility?.latest === undefined
          ? "Could not read the registry ahead of the install — installing the unpinned spec with Deno's age hold disabled."
          : "Deno's 24-hour supply-chain hold is bypassed for this install (--minimum-dependency-age=0).",
    };
  }

  if (eligibility === null) {
    // Registry unreachable: degrade to the unpinned spec and let Deno's own
    // resolution decide (safe once 1.6.0 is outside the window).
    return {
      argv: pbossInstallArgv("deno"),
      via: "deno",
      note: "Could not read the registry ahead of the install — Deno may resolve an older version.",
    };
  }

  if (eligibility.best !== null) {
    return {
      argv: pbossInstallArgv("deno", eligibility.best),
      via: "deno",
      note:
        eligibility.best !== eligibility.latest
          ? `Deno's 24-hour supply-chain hold: installing v${eligibility.best} ` +
            `(latest is v${eligibility.latest}, resolvable ${eligibility.holdUntil ?? "soon"}).`
          : undefined,
    };
  }

  // No deno-resolvable version exports ./deno-entry yet — the one-time
  // transition after a deno-support release. npm delivers the package; the
  // wrapper dispatches to deno at run time; the selection stays deno.
  return {
    argv: pbossInstallArgv("node"),
    via: "npm",
    note:
      "Deno's 24-hour supply-chain protection is holding back every pboss version " +
      `that supports Deno (latest v${eligibility.latest ?? "?"} becomes resolvable ` +
      `${eligibility.holdUntil ?? "within 24 hours"}) — installing through npm as the delivery ` +
      "vehicle; pboss still RUNS on Deno (the runtime selection stays deno).",
  };
}

/* ── interactive selection (spec §2 first-run, §12 runtime change) ─────── */

/** The first-run prompt, exactly as the wrappers print it. */
export function firstRunPromptText(): string {
  return (
    "Kindly select your runtime:\n\n" +
    "  1. Node\n" +
    "  2. Bun\n" +
    "  3. Deno\n\n" +
    "Select runtime [1]: "
  );
}

/** The `runtime change` prompt, with the current runtime shown (spec §12). */
export function runtimeChangePromptText(current: RuntimeChoice | null): string {
  const currentLine = current
    ? `Current runtime: ${runtimeLabel(current)}\n\n`
    : "Current runtime: none configured\n\n";
  return (
    currentLine +
    "Select a new runtime:\n\n" +
    "  1. Node\n" +
    "  2. Bun\n" +
    "  3. Deno\n\n" +
    "Select runtime [1]: "
  );
}

/** Map a prompt answer to a runtime. Empty → node (the default). */
export function parseRuntimeAnswer(answer: string): RuntimeChoice | null {
  const a = normalizeRuntime(answer);
  switch (a) {
    case "":
    case "1":
    case "node":
      return "node";
    case "2":
    case "bun":
      return "bun";
    case "3":
    case "deno":
      return "deno";
    default:
      return null;
  }
}

/** The non-interactive failure text when nothing is configured (spec §2). */
export function nonInteractiveRuntimeMessage(): string {
  return (
    "ProcBoss needs a runtime selection.\n\n" +
    "Run pboss with one of:\n\n" +
    "  --runtime=node\n" +
    "  --runtime=bun\n" +
    "  --runtime=deno\n\n" +
    "(or run `pboss` in an interactive terminal once — the choice is saved to\n" +
    " ~/.pboss/.runtime and never asked again)"
  );
}

/**
 * Ask the user to pick a runtime (readline over stdin; Node default on the
 * empty answer). Throws in non-interactive environments — the caller decides
 * whether that is fatal (`runtime change`) or impossible (headless boot).
 */
export async function promptRuntimeSelection(promptText: string): Promise<RuntimeChoice> {
  if (!process.stdin.isTTY) {
    throw new Error(nonInteractiveRuntimeMessage());
  }
  process.stdout.write(promptText);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once("line", (line: string) => resolve(line));
      rl.once("close", () => resolve(""));
    });
    const parsed = parseRuntimeAnswer(answer);
    if (!parsed) {
      throw new Error(unsupportedRuntimeMessage(answer.trim()));
    }
    return parsed;
  } finally {
    rl.close();
  }
}

/* ── the CLI-side `--runtime` handling (spec §7 step 2, §16) ────────────── */

/**
 * The entry-level --runtime contract, shared by every JS entry
 * (dist/cli.js, dist/cli.<runtime>.js, and the dev sources):
 *
 *   no flag                     → argv untouched (the wrapper already resolved
 *                                 the runtime; direct invocations simply run)
 *   --runtime=<x>, no .runtime  → validate, ENSURE the runtime, SAVE it,
 *                                 then run under it (re-exec when the current
 *                                 engine differs)
 *   --runtime=<x>, .runtime set → one-invocation override: print the notice,
 *                                 do NOT overwrite the file, re-exec under it
 *
 * Returns the argv the CLI should run with (the flag consumed).
 */
export async function handleRuntimeFlag(
  argv: string[],
  opts: { file?: string; spawnFn?: (cmd: string[]) => Promise<number> } = {},
): Promise<string[]> {
  const scan = scanRuntimeFlag(argv);
  if (scan.missingValue) {
    process.stderr.write("--runtime requires a value: node | bun | deno\n");
    process.exit(1);
  }
  if (!scan.explicit || scan.value === null) return argv;

  const raw = scan.value;
  const runtime = normalizeRuntime(raw);
  if (!isValidRuntime(runtime)) {
    process.stderr.write(`${unsupportedRuntimeMessage(raw)}\n`);
    process.exit(1);
  }

  // Initialize-or-override against the persisted selection (spec §16).
  const configured = await readRuntimeFileRaw(opts.file);
  if (configured === null || configured === "") {
    await writeRuntimeSelection(runtime, opts.file);
  } else if (isValidRuntime(configured)) {
    // Guard proved the normalized form is one of the three; keep the label
    // honest without re-widening the type.
    const configuredRuntime = normalizeRuntime(configured) as RuntimeChoice;
    if (configuredRuntime !== runtime) {
      process.stdout.write(
        `Using ${runtimeLabel(runtime)} for this invocation.\n\n` +
          `Configured runtime remains: ${runtimeLabel(configuredRuntime)}\n\n` +
          "To permanently change the runtime:\n" +
          "  pboss runtime change\n\n",
      );
    }
  }

  // When the current engine is not the requested runtime, hand the
  // invocation to the runtime-specific entry (the wrapper's dispatch step —
  // direct invocations get the same behavior).
  const current = R.name;
  if (runtime !== current) {
    const entry = siblingRuntimeEntry(runtime);
    if (entry) {
      const spawnFn = opts.spawnFn ?? defaultInstallSpawn;
      const code = await spawnFn(runtimeSpawnArgv(runtime, entry, scan.rest));
      process.exit(code);
    }
    process.stderr.write(
      `This pboss layout ships no built ${runtimeLabel(runtime)} entry — continuing under ${runtimeLabel(current)}.\n`,
    );
  }
  return scan.rest;
}
