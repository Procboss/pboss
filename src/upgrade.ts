/**
 * ProcBoss (pboss) — Bun Process Manager
 * https://procboss.com
 * License: GPL-3.0-only
 *
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
 *      node_modules path is a package-manager install.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { VERSION, PBOSS_HOME } from "./constants";
import { colorize } from "./utils";

/** Where the install channel is recorded (written by installers). */
export const CHANNEL_FILE = join(PBOSS_HOME, "channel.json");

export type InstallChannel =
  | "universal" // curl | bash (linux/macOS) or install.ps1 (windows)
  | "npm" // npm install -g pboss
  | "bun" // bun add -g pboss
  | "brew" // brew install pboss
  | "snap" // snap install pboss
  | "source" // git checkout run through bun directly
  | "unknown";

/** Marker payload the installers write. */
export type ChannelStamp = {
  channel: InstallChannel;
  /** For package-manager stamps: which package manager owns the install. */
  pm?: "npm" | "bun" | "pnpm" | "yarn";
  /** Epoch seconds — when the stamp was written. */
  stampedAt?: number;
  /** Who wrote it (installer script name). */
  by?: string;
};

/* ── stamp read/write ─────────────────────────────────────────────────── */

export function readChannelStamp(file: string = CHANNEL_FILE): ChannelStamp | null {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ChannelStamp;
    if (typeof parsed?.channel === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeChannelStamp(
  stamp: ChannelStamp,
  file: string = CHANNEL_FILE,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
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
};

export function currentChannelContext(): ChannelContext {
  return {
    stamp: readChannelStamp(),
    execPath: process.execPath,
    isCompiled:
      (typeof Bun !== "undefined" &&
        typeof Bun.main === "string" &&
        Bun.main.includes("$bunfs")) ||
      false,
    moduleDir: import.meta.dir,
    platform: process.platform,
  };
}

/**
 * Resolve how this pboss was installed. The stamp wins (it was written by
 * the installer itself); without one we infer from the executable path.
 */
export function detectChannel(ctx: ChannelContext): InstallChannel {
  // 1. The installer's own record is authoritative.
  if (ctx.stamp?.channel) {
    const ch = ctx.stamp.channel;
    if (ch === "npm" && ctx.stamp.pm === "bun") return "bun";
    return ch;
  }

  const exec = normalizePath(ctx.execPath);
  const moduleDir = normalizePath(ctx.moduleDir);

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

  // 7. Running from source (bun run src/index.ts inside a checkout).
  if (moduleDir.endsWith("/pboss/src")) {
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

const UNIVERSAL_URLS = {
  linux: "https://procboss.com/install.sh",
  darwin: "https://procboss.com/install.sh",
  win32: "https://procboss.com/install.ps1",
} as const;

/**
 * The channel-fidelity table: each channel upgrades THROUGH ITSELF. Pure —
 * safe to unit test without touching the machine.
 */
export function buildUpgradePlan(
  channel: InstallChannel,
  platform: NodeJS.Platform = process.platform,
): UpgradePlan {
  switch (channel) {
    case "npm":
      return {
        channel,
        label: "npm (global)",
        command: ["npm", "install", "-g", "pboss@latest"],
        manual: false,
        note: "The npm postinstall re-checks boot persistence automatically.",
      };
    case "bun":
      return {
        channel,
        label: "bun (global)",
        command: ["bun", "add", "-g", "pboss@latest"],
        manual: false,
        note: "The postinstall hook re-checks boot persistence automatically.",
      };
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
            "irm https://procboss.com/install.ps1 | iex",
          ],
          manual: false,
          note: "No Administrator needed — it installs per-user by default.",
        };
      }
      return {
        channel,
        label: "universal installer",
        command: [
          "bash",
          "-c",
          "curl -fsSL https://procboss.com/install.sh | bash",
        ],
        manual: false,
        note: "No root required — it refreshes the same install directory in place (sudo may prompt once if pboss lives in /usr/local/bin).",
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

/** Run an upgrade plan's command with stdio inherited (password prompts — snap's — work). */
export async function runUpgradePlan(
  plan: UpgradePlan,
  spawnFn: (cmd: string[]) => Promise<number> = defaultSpawn,
): Promise<boolean> {
  const code = await spawnFn(plan.command);
  return code === 0;
}

async function defaultSpawn(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** One-line summary used by --check and the command output. */
export function describeChannel(channel: InstallChannel, plan: UpgradePlan): string {
  return `${plan.label} (${channel}) → ${plan.command.join(" ") || "manual"}`;
}
