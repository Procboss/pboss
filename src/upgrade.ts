/**
 * Self-update (`pboss upgrade`).
 *
 * The rule the owner cares about: whatever channel installed pboss must also
 * UPGRADE pboss. A machine that installed via the universal installer must
 * not end up with a second copy from npm, and vice versa. Two mechanisms
 * make that possible:
 *
 *   1. A channel stamp written at install time (`~/.pboss/channel.json`) —
 *      the installers (install.sh, install.ps1, npm/bun postinstall, the
 *      Homebrew formula) all record how they got here.
 *   2. Runtime heuristics for machines linked BEFORE stamps existed (or
 *      where the stamp was wiped): the executable's own location tells the
 *      truth — /snap/pboss is snap, /opt/homebrew/Cellar/pboss is brew,
 *      a compiled binary in /usr/local/bin is the universal install, a
 *      node_modules path is a package-manager install. And for deno —
 *      whose global installs land in deno's npm cache (a path no rule
 *      matches) and never run npm's postinstall (so no stamp is ever
 *      written) — the runtime ACTUALLY EXECUTING pboss is the one signal
 *      that cannot be stale.
 *
 * ABOVE BOTH (the runtime-aware architecture): the persistent user-selected
 * runtime in `~/.pboss/.runtime` decides WHICH package ecosystem upgrades
 * the package — node → npm, bun → bun, deno → deno (spec §14). The runtime
 * is the user's explicit, persistent choice; the channel stamp only breaks
 * ties for machines that predate it. One inversion: when the runtime
 * EXECUTING pboss is Deno (a `deno install -g` machine, where the
 * wrapper-only .runtime file was never consulted and cannot speak for the
 * install), the live runtime wins over any stale selection or stamp —
 * see resolveUpgradeChannel().
 */

import { mkdir, readFile, writeFile, stat } from "fs/promises";
import { existsSync, copyFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "node:url";
import { PBOSS_HOME } from "./constants";
import { ignore } from "./error-handling";
import { DENO_MIN_DEP_AGE_FLAG, helpTextSupportsMinDepAge } from "./deno-eligibility";
import { getRuntime } from "./runtime";
const R = getRuntime();

/** Where the install channel is recorded (written by installers). */
export const CHANNEL_FILE = join(PBOSS_HOME, "channel.json");

export type InstallChannel =
  | "universal" // curl | bash (linux/macOS) or install.ps1 (windows)
  | "npm" // npm install -g pboss
  | "bun" // bun add -g pboss
  | "deno" // deno install -g npm:pboss/deno-entry
  | "brew" // brew install pboss
  | "snap" // snap install pboss
  | "source" // git checkout run through bun directly
  | "unknown";

/** Marker payload the installers write. */
export type ChannelStamp = {
  channel: InstallChannel;
  /** For package-manager stamps: which package manager owns the install.
   *  "deno" appears on the universal installer's deno path (install.sh
   *  stamps PM_CHOICE — the installer's own selection, not an npm agent). */
  pm?: "npm" | "bun" | "deno" | "pnpm" | "yarn";
  /** Epoch seconds — when the stamp was written. */
  stampedAt?: number;
  /** Who wrote it (installer script name). */
  by?: string;
};

/* ── stamp read/write ─────────────────────────────────────────────────── */

export async function readChannelStamp(file: string = CHANNEL_FILE): Promise<ChannelStamp | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ChannelStamp;
    if (typeof parsed?.channel === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeChannelStamp(
  stamp: ChannelStamp,
  file: string = CHANNEL_FILE,
): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch {
    // Best-effort: the heuristics in detectChannel() still resolve the
    // channel without a stamp.
  }
}

/** Map an npm_config_user_agent string to the package manager it names. */
export function parseUserAgent(ua: string | undefined): "npm" | "bun" | "pnpm" | "yarn" {
  if (!ua) return "npm";
  const head = ua.split(" ")[0]?.toLowerCase() ?? "";
  if (head.startsWith("bun/")) return "bun";
  if (head.startsWith("pnpm/")) return "pnpm";
  if (head.startsWith("yarn/")) return "yarn";
  return "npm";
}

/* ── channel detection ────────────────────────────────────────────────── */

/**
 * Everything detectChannel needs, injectable for tests. Defaults read the
 * real process state.
 */
export type ChannelContext = {
  stamp: ChannelStamp | null;
  execPath: string;
  isCompiled: boolean;
  /** Directory of this module — reveals npm/bun global installs. */
  moduleDir: string;
  platform: NodeJS.Platform;
  /** The runtime ACTUALLY executing pboss ("node" | "bun" | "deno") —
   *  the live signal a deno install is told by (deno's npm-cache paths
   *  match no filesystem rule and deno never runs npm's postinstall, so
   *  no stamp exists to read). Optional so injected test contexts keep
   *  their shape. */
  runtime?: "node" | "bun" | "deno";
  /** True when the directory ABOVE this module is a git repo (a checkout
   *  cloned under ANY name — `git clone … pboss my-fork` — is still a
   *  source run; the path heuristic alone would miss it). Optional so
   *  injected test contexts keep their old shape. */
  parentHasGit?: boolean;
};

/**
 * This module's directory — portable across Bun, Node and Deno.
 * `import.meta.dir` is a BUN-ONLY extension (undefined elsewhere → the
 * upgrade channel probe crashed on Node and Deno with "The 'path'
 * argument must be of type string"); `import.meta.url` is standard. In
 * the bundled dist this resolves to the dist directory; in a source
 * checkout it resolves to src/ — both shapes the channel rules expect.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export async function currentChannelContext(): Promise<ChannelContext> {
  return {
    stamp: await readChannelStamp(),
    execPath: process.execPath,
    isCompiled:
      (typeof Bun !== "undefined" &&
        typeof Bun.main === "string" &&
        Bun.main.includes("$bunfs")) ||
      false,
    moduleDir: MODULE_DIR,
    platform: process.platform,
    parentHasGit: await isGitRoot(join(MODULE_DIR, "..")),
    runtime: R.name,
  };
}

/** `.git` next door — the marker of a working checkout (npm tarballs ship
 *  none, so the node_modules rule below always wins for real installs). */
async function isGitRoot(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve how this pboss was installed. The stamp wins (it was written by
 * the installer itself); without one we infer from the executable path.
 */
export function detectChannel(ctx: ChannelContext): InstallChannel {
  const exec = normalizePath(ctx.execPath);
  const moduleDir = normalizePath(ctx.moduleDir);

  // 0. The runtime ACTUALLY executing pboss — the one signal that cannot be
  //    stale (the live half of spec §14). npm links its bins to Node and
  //    Bun's to Bun, so a pboss executing under Deno is a deno install:
  //    `deno install -g npm:pboss/deno-entry` dispatches straight to the
  //    entry, its npm-cache path matches no filesystem rule below, and
  //    npm's postinstall never runs under deno — every OTHER artifact on
  //    such a machine (an npm-era stamp from an install that was replaced,
  //    the wrapper-only ~/.pboss/.runtime file deno's shim never consults)
  //    can only describe what was there BEFORE. Three things keep their
  //    authority over it:
  //      - a deliberate `--channel` repair (the user pinned it by hand),
  //      - channels that own their own upgrade path (universal / brew /
  //        snap — the universal installer stamps itself even on its deno
  //        path, and re-runs that path when it upgrades the machine),
  //      - a source checkout (running a repo's dist under deno by hand is
  //        a source run, not a deno install).
  if (ctx.runtime === "deno") {
    const deliberate = ctx.stamp?.by === "pboss upgrade --channel";
    const ownsUpgrade =
      ctx.stamp?.channel === "universal" ||
      ctx.stamp?.channel === "brew" ||
      ctx.stamp?.channel === "snap";
    const sourceShape = moduleDir.endsWith("/pboss/src") || ctx.parentHasGit === true;
    if (!deliberate && !ownsUpgrade && !sourceShape) return "deno";
  }

  // 1. The installer's own record is authoritative.
  if (ctx.stamp?.channel) {
    const ch = ctx.stamp.channel;
    if (ch === "npm" && ctx.stamp.pm === "bun") return "bun";
    return ch;
  }

  // 2. Snap classic confinement — the binary lives under /snap/pboss.
  if (exec.startsWith("/snap/") || exec.startsWith("c:/programdata/snap")) {
    return "snap";
  }

  // 4. Homebrew — /opt/homebrew/Cellar/pboss/… (arm), /usr/local/Cellar
  //    (intel) and the linuxbrew layout (…/.linuxbrew/Cellar/…).
  if (
    /\/\.?(homebrew|linuxbrew)\/cellar\/pboss\//.test(exec) ||
    /\/usr\/local\/cellar\/pboss\//.test(exec)
  ) {
    return "brew";
  }

  // 5. Compiled binary in the canonical system locations → universal
  //    installer (it also owns %ProgramFiles%\pboss on Windows).
  if (ctx.isCompiled) {
    if (ctx.platform === "win32") {
      if (/program files\/pboss/i.test(exec)) return "universal";
    } else if (
      exec === "/usr/local/bin/pboss" ||
      exec === "/usr/bin/pboss" ||
      exec === "/opt/pboss/pboss" ||
      // The universal installer's per-user fallback (no-sudo machines) —
      // home-agnostic: any */.local/bin/pboss compiled binary is ours.
      exec.endsWith("/.local/bin/pboss")
    ) {
      return "universal";
    }
    // A compiled binary somewhere we don't recognize (manual copy).
    return "unknown";
  }

  // 6. Package-manager globals — a repo checkout and an npm global BOTH end
  //    in …/pboss/src, so the node_modules placement wins.
  if (moduleDir.includes("/.bun/install/global/node_modules/pboss/")) return "bun";
  if (moduleDir.includes("/node_modules/pboss/")) {
    return "npm";
  }

  // 7. Running from source (bun run src/index.ts inside a checkout) — by
  //    path shape (the classic clone) OR by the git marker (a checkout
  //    cloned under any name; rule 6 already claimed node_modules).
  if (moduleDir.endsWith("/pboss/src") || ctx.parentHasGit === true) {
    return "source";
  }

  return "unknown";
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/* ── upgrade planning ─────────────────────────────────────────────────── */

export type UpgradePlan = {
  channel: InstallChannel;
  /** Human name of the channel for display. */
  label: string;
  /** The command argv that performs the upgrade. */
  command: string[];
  /** True when the plan cannot be executed automatically. */
  manual: boolean;
  /** Extra honest note printed after the upgrade command runs. */
  note?: string;
};

/**
 * The runtime the universal installer must be told to use — the answer it
 * would otherwise prompt for (owner report, 2026-10-06). Whitelist-checked
 * before it is ever interpolated into a shell command (the same discipline
 * as isSafeVersion): anything but node/bun/deno is dropped, not passed.
 */
export type UniversalRuntimeHint = "node" | "bun" | "deno";

/**
 * The channel-fidelity table: each channel upgrades THROUGH ITSELF. Pure —
 * safe to unit test without touching the machine.
 *
 * `targetVersion` (the registry's latest, known by the time a plan is built)
 * is honored by the universal channel only: the installer command pins
 * PBOSS_VERSION so `curl | bash` compiles EXACTLY the release the upgrade
 * announced (npm-registry tarball) instead of whatever git main happens to
 * carry — the two can drift, and an unpinned upgrade that recompiles an
 * older-looking main is how "upgraded but `pboss -v` still shows the old
 * version" happens. npm/bun channels pin `pboss@latest` inherently;
 * brew/snap defer to their package manager; Windows keeps the unpinned
 * installer (install.ps1 has no tarball path yet).
 *
 * `runtimeHint` (universal channel only) rides along as an explicit
 * --runtime / -Runtime flag so the re-run installer never prompts: the
 * upgrade derives it from the persistent selection (spec §14) or the
 * runtime executing this very pboss. Absent → the installer's own
 * sources decide (its --runtime flag, then ~/.pboss/.runtime, then the
 * prompt — the same order the wrapper uses).
 */
export function buildUpgradePlan(
  channel: InstallChannel,
  platform: NodeJS.Platform = process.platform,
  targetVersion?: string,
  denoPin?: DenoPin | null,
  runtimeHint?: UniversalRuntimeHint | null,
): UpgradePlan {
  switch (channel) {
    case "npm":
      return {
        channel,
        label: "npm (global)",
        command: ["npm", "install", "-g", "pboss@latest"],
        manual: false,
        note: "The npm postinstall re-checks boot persistence automatically" +
          (platform === "win32" ? "; the native pboss.cmd / pboss.ps1 shims are re-healed" : ""),
      };
    case "bun":
      return {
        channel,
        label: "bun (global)",
        command: ["bun", "add", "-g", "pboss@latest"],
        manual: false,
        note: "The postinstall hook re-checks boot persistence automatically" +
          (platform === "win32" ? "; the native pboss.cmd / pboss.ps1 shims are re-healed" : ""),
      };
    case "deno": {
      // The canonical install command (README / install.sh / install.ps1):
      // --force replaces the existing global install (deno refuses
      // otherwise), --reload re-resolves against the live registry (a
      // stale cached packument keeps serving the previous resolution even
      // past the hold — the "upgraded but `pboss -v` still shows the old
      // version" failure), --name pins the command, and /deno-entry is the
      // published subpath (deno executes package bins as modules, so the
      // .sh wrapper cannot serve it — see src/runtime-config.ts).
      // Version choice (owner spec, 2026-10-06 — the upgrade command IS
      // the install command plus --reload --force):
      //
      //   bypass  → the UNPINNED spec `npm:pboss/deno-entry`: the local
      //             deno knows --min-dep-age, so the flag alone disables
      //             the 24-hour supply-chain hold and the unpinned spec
      //             resolves the registry's TRUE latest (README parity —
      //             no version pin, and no eligibility fetch either).
      //   pin     → the newest version Deno can resolve without the flag
      //             (deno-eligibility.ts) — older denos only.
      if (denoPin === null) {
        return {
          channel,
          label: "deno (global)",
          command: [],
          manual: true,
          note:
            "Deno's 24-hour supply-chain protection is holding back every pboss " +
            "version that supports Deno (published less than a day ago). " +
            "Re-run `pboss upgrade` after that window passes.",
        };
      }
      const spec = denoPin?.version
        ? `npm:pboss@${denoPin.version}/deno-entry`
        : "npm:pboss/deno-entry";
      const command = ["deno", "install", "-g", "-A"];
      if (denoPin?.bypass) command.push(DENO_MIN_DEP_AGE_FLAG);
      command.push("--name", "pboss", "--reload", "--force", spec);
      return {
        channel,
        label: "deno (global)",
        command,
        manual: false,
        note:
          denoPin?.note ??
          (denoPin?.bypass
            ? "Deno re-links the global command in place (the supply-chain age " +
              "hold is bypassed for this explicitly chosen package)."
            : "Deno re-links the global command to the new release in place."),
      };
    }
    case "brew":
      return {
        channel,
        label: "Homebrew",
        command: ["brew", "upgrade", "pboss"],
        manual: false,
        note: "Brew rebuilds the standalone binary from source itself.",
      };
    case "snap":
      return {
        channel,
        label: "snap",
        // sudo here is inherent to snapd (system snaps refresh as root),
        // not a pboss requirement — every pboss-managed channel is
        // root-free.
        command: ["sudo", "snap", "refresh", "pboss"],
        manual: false,
        note: "The snap refreshes in place — no second CLI appears.",
      };
    case "universal": {
      // The flag is whitelist-checked — NEVER interpolate an unvalidated
      // value into a shell command (same rule as PBOSS_VERSION above).
      const rt =
        runtimeHint === "node" || runtimeHint === "bun" || runtimeHint === "deno"
          ? runtimeHint
          : null;
      if (platform === "win32") {
        return {
          channel,
          label: "universal installer (Windows)",
          command: [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            // With a runtime to pass, -Runtime must BIND to the irm'd
            // scriptblock (the form install.ps1's own header documents);
            // a plain `irm | iex` cannot carry parameters.
            rt
              ? `iex '& { $(irm https://procboss.com/install.ps1) } -Runtime ${rt}'`
              : "irm https://procboss.com/install.ps1 | iex",
          ],
          manual: false,
          note:
            "No Administrator needed — it installs per-user by default." +
            (rt ? ` The runtime rides along (-Runtime ${rt} is passed explicitly, so the installer never re-asks).` : ""),
        };
      }
      const pin = isSafeVersion(targetVersion) ? `PBOSS_VERSION=${targetVersion} ` : "";
      // `bash -s --` forwards the flag through the pipe to the script —
      // a bare `bash` after the pipe receives no arguments at all.
      const tail = rt ? `bash -s -- --runtime=${rt}` : "bash";
      return {
        channel,
        label: "universal installer",
        command: [
          "bash",
          "-c",
          `curl -fsSL https://procboss.com/install.sh | ${pin}${tail}`,
        ],
        manual: false,
        note:
          "No root required — the installer is idempotent and refreshes in place." +
            (pin ? " It downloads the exact version shown above from the npm registry." : "") +
            (rt ? ` The runtime rides along (--runtime=${rt} is passed explicitly, so the installer never re-asks).` : ""),
      };
    }
    case "source":
      return {
        channel,
        label: "source checkout",
        command: ["git", "-C", "<repo>", "pull"],
        manual: true,
        note: "You are running pboss straight from a git checkout: cd into the repo, `git pull`, and re-run. Pin a real channel (universal/npm/brew/snap) to self-upgrade.",
      };
    default:
      return {
        channel: "unknown",
        label: "unrecognized install",
        command: [],
        manual: true,
        note: "pboss could not tell how it was installed, so it refuses to guess: re-install through one channel (curl | bash, npm i -g, brew, snap) and `pboss upgrade` will track it from then on.",
      };
  }
}

/* ── runtime-driven channel resolution (spec §14: .runtime is the truth) ── */

/** The channel a configured runtime upgrades through. */
export function channelForRuntime(runtime: "node" | "bun" | "deno"): InstallChannel {
  return runtime === "node" ? "npm" : runtime;
}

/**
 * The inverse of channelForRuntime — the runtime a package-ecosystem
 * channel rides on. Feeds the universal installer's --runtime flag: the
 * upgrade already knows the answer (the persisted selection, or the
 * runtime executing this very pboss), and the installer must never re-ask
 * a question the machine has already answered (owner report, 2026-10-06:
 * `pboss upgrade` through the universal channel prompted mid-upgrade).
 * Channels that own their own upgrade path (universal/brew/snap/…)
 * have no runtime to name — null.
 */
export function runtimeForChannel(channel: InstallChannel): "node" | "bun" | "deno" | null {
  switch (channel) {
    case "npm":
      return "node";
    case "bun":
      return "bun";
    case "deno":
      return "deno";
    default:
      return null;
  }
}

/**
 * The channel `pboss upgrade` actually uses: the detected channel vs the
 * persistent runtime selection (spec §14). A deno DETECTION is the
 * executing runtime speaking — deno's own shim never consults
 * ~/.pboss/.runtime (that file belongs to the npm/bun wrapper), so a
 * stale node/bun selection must not redirect a deno install's upgrade
 * into another ecosystem. For every other package-manager-shaped
 * detection, the persistent selection decides the ecosystem
 * (node → npm, bun → bun, deno → deno) — including the universal
 * installer's installs, which ride the selected runtime's package
 * ecosystem; brew/snap/source/unknown keep owning themselves.
 */
export function resolveUpgradeChannel(
  runtimeChannel: InstallChannel | null,
  detected: InstallChannel,
): InstallChannel {
  if (detected === "deno") return "deno";
  return runtimeChannel !== null &&
    (detected === "npm" || detected === "bun" || detected === "universal")
    ? runtimeChannel
    : detected;
}

/**
 * Read the persistent runtime selection as a channel hint. Invalid content
 * is NOT swallowed (spec §20) — it propagates as an error so `pboss upgrade`
 * can tell the user to fix their config instead of guessing an ecosystem.
 */
export async function configuredRuntimeChannel(): Promise<InstallChannel | null> {
  let raw: string;
  try {
    raw = await readFile(join(PBOSS_HOME, ".runtime"), "utf8");
  } catch {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "node" || value === "bun" || value === "deno") return channelForRuntime(value);
  throw new Error(
    `Invalid ProcBoss runtime configuration: ${raw.trim()}\n\n` +
      "Supported runtimes:\n  node\n  bun\n  deno"
  );
}

/* ── version checks ───────────────────────────────────────────────────── */

/** Semver-ish compare: positive when a > b, 0 when equal, negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/, "").split(".");
  const pb = String(b).replace(/^v/, "").split(".");
  for (let i = 0; i < 3; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** The canonical version source for every channel (they all build from it). */
export const PBOSOL_REGISTRY_URL = "https://registry.npmjs.org/pboss/latest";

/** npm registry tarball for an exact version (what PBOSS_VERSION installs). */
export const PBOSOL_TARBALL_URL = "https://registry.npmjs.org/pboss/-/pboss-<version>.tgz";

/**
 * The versions the universal installer is allowed to be pinned to. The pin
 * travels through a `bash -c "curl … | PBOSS_VERSION=<v> bash"` command
 * string, so anything outside plain semver MUST be rejected — never
 * interpolate an unvalidated registry value into a shell command.
 */
export function isSafeVersion(v: string | undefined | null): v is string {
  return typeof v === "string" && /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(v);
}

/**
 * The deno channel's version choice, resolved by the caller (index.ts)
 * via fetchDenoEligibility + probeDenoMinDepAge BEFORE the plan is built.
 *
 *   { version, bypass } → bypass: install the registry's TRUE latest with
 *                         --min-dep-age=0 (the hold disabled);
 *                         version may be null when the registry could not
 *                         be read — the unpinned spec + the flag still
 *                         resolves latest instead of falling back
 *   { version }          → the newest version Deno can resolve; note
 *                         explains any hold (older denos)
 *   null                → no deno-resolvable version exports ./deno-entry
 *                         yet AND no bypass — manual plan, the note says
 *                         when the window passes
 */
export interface DenoPin {
  /** The version to pin (null: the unpinned npm:pboss spec). */
  version: string | null;
  /** Local deno knows --min-dep-age: disable the age hold. */
  bypass?: boolean;
  note?: string;
}

/**
 * Whether the local deno knows the supply-chain hold's escape hatch —
 * probed from `deno install --help`, never version-parsed (an unknown
 * flag is a hard error on older denos, which have no hold to bypass).
 * Runs through the runtime adapter's ASYNC capture(): the deno adapter
 * has no synchronous spawn (spawnSync there is a hard throw), and pboss
 * itself usually runs under the very deno being probed. `spawner` is
 * injectable for tests; a missing deno is simply "no flag".
 */
export async function probeDenoMinDepAge(
  spawner: (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null }> = (cmd) =>
    R.process.capture(cmd),
  denoBin: string = "deno",
): Promise<boolean> {
  try {
    const r = await spawner([denoBin, "install", "--help"]);
    if (r.exitCode !== null && r.exitCode !== 0) return false;
    return helpTextSupportsMinDepAge(`${r.stdout}\n${r.stderr}`);
  } catch {
    return false;
  }
}

/**
 * Latest published version. `fetcher` is injectable for tests. The npm
 * registry is the source of truth for version numbers across channels.
 */
export async function fetchLatestVersion(
  fetcher: typeof fetch = fetch,
  url: string = PBOSOL_REGISTRY_URL,
): Promise<string | null> {
  try {
    const res = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/* ── execution ────────────────────────────────────────────────────────── */

/* ── Windows shim healing after package-manager upgrades ────────────────── */

/**
 * npm and Bun link pboss's bin as a shell-script wrapper — and every time
 * they (re)install or update the package, they regenerate their OWN shims:
 * a pboss.cmd that invokes `sh`, which cmd and PowerShell cannot run on a
 * plain Windows machine. The one-line installer overwrites those with a
 * pboss.cmd that runs the PowerShell twin (bin/pboss.ps1). `pboss upgrade`
 * must do the same after an npm/bun-channel update — otherwise the upgrade
 * breaks the very command that performed it. (The universal channel runs
 * install.ps1, which heals itself; deno re-links its own command.)
 *
 * Best-effort and never fatal: returns the healed bin directory, or null
 * when there was nothing to do. Everything is injectable for tests.
 */
export async function healWindowsShims(
  plan: UpgradePlan,
  opts: {
    platform?: NodeJS.Platform;
    which?: (cmd: string) => string | null;
    moduleDir?: string;
  } = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  if (plan.channel !== "npm" && plan.channel !== "bun") return null;
  const which = opts.which ?? ((cmd: string) => R.misc.which(cmd));
  const pbossBin = which("pboss");
  if (!pbossBin) return null;
  const binDir = dirname(pbossBin);
  // Where the just-updated package lives. The running module sits inside
  // it (.../pboss/src or .../pboss/dist), and npm/bun update in place —
  // same directory, new files — so the wrapper twin beside this source is
  // the NEW one. Known-layout fallbacks cover exotic resolutions.
  const moduleDir = opts.moduleDir ?? MODULE_DIR;
  const candidates = [
    join(dirname(moduleDir), "bin", "pboss.ps1"),
    join(homedir(), ".bun", "install", "global", "node_modules", "pboss", "bin", "pboss.ps1"),
    join(binDir, "node_modules", "pboss", "bin", "pboss.ps1"),
  ];
  const wrapper = candidates.find((c) => existsSync(c));
  if (!wrapper) return null;
  copyFileSync(wrapper, join(binDir, "pboss.ps1"));
  // The same two-line bootstrap the PowerShell installer writes: run the
  // wrapper twin under powershell, forward every argument verbatim.
  writeFileSync(
    join(binDir, "pboss.cmd"),
    "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0pboss.ps1\" %*\r\n",
  );
  return binDir;
}

/** Run an upgrade plan's command with stdio inherited (password prompts — snap's — work). */
export async function runUpgradePlan(
  plan: UpgradePlan,
  spawnFn: (cmd: string[]) => Promise<number> = defaultSpawn,
  healShims: (plan: UpgradePlan) => Promise<string | null> = (p) => healWindowsShims(p),
): Promise<boolean> {
  const code = await spawnFn(plan.command);
  if (code !== 0) return false;
  // Windows, npm/bun channel: the package manager just regenerated its own
  // shims for the .sh bin — re-heal them (best-effort; never fails the
  // upgrade) or the next `pboss` invocation would die.
  await healShims(plan).catch((err: unknown) => {
    ignore("heal windows shims after upgrade", err);
    return null;
  });
  return true;
}

/* ── post-upgrade verification ─────────────────────────────────────────── */

/** What `pboss --version` actually reports from PATH after an upgrade. */
export type InstalledVersion = {
  /** The resolved executable the user's shell will run. */
  path: string;
  /** The version it printed (no "v" prefix). */
  version: string;
};

/** Parse `pboss v1.2.5` style output. Tolerant: last v-prefixed token. */
export function parseVersionOutput(text: string): string | null {
  const m = text.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?)(?:\s|$)/);
  return m?.[1] ?? null;
}

/**
 * The upgrade's receipt: spawn the pboss the user's PATH resolves NOW (the
 * new binary, if the channel command did its job) and read its version.
 * This is what `pboss -v` will print in the user's next shell — checking it
 * here turns "upgrade requested" into "upgrade VERIFIED" (or an honest
 * warning about a second, older pboss earlier on PATH).
 *
 * `which`/`spawnFn` injectable for tests. Null = could not verify (binary
 * not on PATH or refused to answer), never a crash.
 */
export async function verifyInstalledVersion(
  opts: {
    which?: (cmd: string) => string | null;
    spawnFn?: (cmd: string[]) => Promise<{ code: number; stdout: string }> | { code: number; stdout: string };
  } = {},
): Promise<InstalledVersion | null> {
  const which = opts.which ?? ((cmd: string) => R.misc.which(cmd));
  const spawnFn =
    opts.spawnFn ??
    (async (cmd: string[]) => {
      const proc = R.process.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      // `pboss --version` is a pure print, but never trust a spawned CLI
      // forever: kill it and report "unverifiable" after 10s.
      const timer = setTimeout(() => proc.kill(), 10_000);
      try {
        const [code, stdout] = await Promise.all([
          proc.exited,
          new Response(proc.stdout as ReadableStream).text(),
        ]);
        return { code: code ?? -1, stdout };
      } finally {
        clearTimeout(timer);
      }
    });

  try {
    const path = which("pboss");
    if (!path) return null;
    const { code, stdout } = await spawnFn([path, "--version"]);
    if (code !== 0) return null;
    const version = parseVersionOutput(stdout);
    return version ? { path, version } : null;
  } catch {
    return null;
  }
}

async function defaultSpawn(cmd: string[]): Promise<number> {
  const proc = R.process.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) ?? -1;
}

/** One-line summary used by --check and the command output. */
export function describeChannel(channel: InstallChannel, plan: UpgradePlan): string {
  return `${plan.label} (${channel}) → ${plan.command.join(" ") || "manual"}`;
}
