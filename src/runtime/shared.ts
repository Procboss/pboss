/**
 * ProcBoss (pboss) — runtime-shared helpers.
 *
 * Cross-runtime utilities used by MORE THAN ONE adapter (the Node and Deno
 * adapters share the PATH scan; the Bun adapter uses Bun.which first and
 * only falls back to it). Shared here because it is genuinely
 * runtime-independent — per the architecture rule "shared where sharing is
 * better".
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Resolve `cmd` to an absolute executable path by scanning PATH.
 *
 * Node and Deno have no `which()` builtin; scanning PATH (with stat + mode
 * check) is the native approach for both. Bun ships Bun.which, so the Bun
 * adapter uses that first — this scan is its fallback for the well-known
 * install locations daemons miss (minimal-PATH systemd units).
 *
 * Optional extra directories are appended AFTER the PATH entries (used by
 * callers that know runtime-specific install roots like ~/.bun/bin).
 */
export function scanPathFor(
  cmd: string,
  opts: { platform?: NodeJS.Platform; pathEnv?: string; extraDirs?: string[] } = {}
): string | null {
  const platform = opts.platform ?? process.platform;
  const isWin = platform === "win32";
  const name = isWin && !/\.(exe|cmd|bat)$/i.test(cmd) ? `${cmd}.exe` : cmd;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const dirs = [
    ...pathEnv.split(isWin ? ";" : ":").filter((d) => d.length > 0),
    ...(opts.extraDirs ?? []),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      if (!isWin && (st.mode & 0o111) === 0) continue; // needs an execute bit on POSIX
      return candidate;
    } catch {
      // missing candidate — keep scanning
    }
  }
  return null;
}

/** Full PATH split into directories (handy for search-descriptions). */
export function pathDirectories(opts: { platform?: NodeJS.Platform; pathEnv?: string } = {}): string[] {
  const isWin = (opts.platform ?? process.platform) === "win32";
  return (opts.pathEnv ?? process.env.PATH ?? "")
    .split(isWin ? ";" : ":")
    .filter((d) => d.length > 0);
}

/** PATH separator for the current/queried platform. */
export const pathDelimiter = delimiter;
