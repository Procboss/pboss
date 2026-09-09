#!/usr/bin/env bun
/**
 * ProcBoss (pboss) — Bun Process Manager
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 *
 * npm/bun package `postinstall` lifecycle hook.
 *
 * Goal: boot persistence BY DEFAULT. A GLOBAL install of pboss should end
 * with the boot service (per-user systemd unit / launchd agent / Windows
 * scheduled task) installed, so the daemon starts at boot and resurrects
 * the saved process list. This hook attempts that automatically — WITHOUT
 * root: the service is per-user, so `npm i -g pboss` from a normal user
 * account is enough.
 *
 * Hard rules — the hook must NEVER break a package install:
 *   1. Only GLOBAL installs act. Local/dev installs (the repo itself, CI
 *      checkout, `npm i pboss` inside an app) stay completely silent —
 *      nobody wants a systemd unit from a dev dependency.
 *   2. Best-effort only. Hosts without a user systemd session (containers,
 *      minimal VMs) print ONE hint line with the exact command to run and
 *      exit 0. The user installed a CLI, not a nag screen.
 *   3. Always exits 0. Any failure is reported as a hint, never as an npm
 *      error.
 *
 * It intentionally does NOT spawn the daemon by itself: the install path
 * (`pboss startup install`) starts the service, which owns the daemon.
 */

import { StartupManager } from "./startup-manager";
import { writeChannelStamp, parseUserAgent } from "./upgrade";
import { loadCloudConfig } from "./cloud";

/**
 * True when the package manager is performing a GLOBAL install (npm sets
 * `npm_config_global=true` for `npm i -g`). Local installs must stay silent.
 * Exported for tests.
 */
export function isGlobalInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_config_global === "true" || env.npm_config_global === "1";
}

/**
 * The reinstall contract, made visible at install time: the machine
 * credential in ~/.pboss/cloud.json is the PERMANENT cache — it outlives
 * the package directory across deletes, reinstalls and upgrades. When a
 * fresh install finds one, say so: nobody should re-link a machine that
 * is already linked. Read-only, never throws; null = nothing to report.
 * Exported for tests.
 */
export function existingCloudLinkNote(): string | null {
  const cfg = loadCloudConfig();
  if (!cfg) return null;
  const name = cfg.serverName ?? cfg.serverId;
  return `Existing cloud link found (${name}) — the daemon will resume it automatically. State: pboss cloud status`;
}

/**
 * The one-line manual command to print when auto-install was not possible.
 * No sudo anywhere: the boot service is per-user (user systemd unit /
 * LaunchAgent / per-user scheduled task), so the user's own shell is
 * always enough.
 */
export function manualInstallHint(): string {
  switch (process.platform) {
    case "linux":
    case "darwin":
      return "Boot persistence is not set up. To enable it:  pboss startup install";
    case "win32":
      return "Boot persistence is not set up. To enable it:  pboss startup install";
    default:
      return "Boot persistence is not available on this platform.";
  }
}

async function main(): Promise<void> {
  if (!isGlobalInstall()) return; // local/dev install — silent by rule 1

  // Record WHO installed us so `pboss upgrade` upgrades through the same
  // package manager (npm/bun/pnpm/yarn) instead of spawning a second copy.
  const pm = parseUserAgent(process.env.npm_config_user_agent);
  writeChannelStamp({
    channel: "npm",
    pm,
    by: "postinstall",
    stampedAt: Math.floor(Date.now() / 1000),
  });

  try {
    // Shorter verify deadline than the CLI default: a failing unit must not
    // stretch `npm i -g pboss` by half a minute. The CLI command keeps the
    // full 30s diagnosis window.
    const message = await new StartupManager().install({ verifyTimeoutMs: 15_000 });
    console.log(message);
  } catch (err) {
    // Expected on user-level installs without privileges — one hint, exit 0.
    console.log(
      `pboss installed, but the boot service could not be set up automatically ` +
        `(${err instanceof Error ? err.message.split("\n")[0] : String(err)}).`
    );
    console.log(manualInstallHint());
  }

  // Reinstall/upgrade contract: if this machine was already linked, the
  // credential survived the package swap — the daemon (re)started by the
  // step above resumes it. Say so instead of leaving the user to discover
  // the link state by asking for status.
  const linkNote = existingCloudLinkNote();
  if (linkNote) console.log(linkNote);
}

// Only act when run as the package postinstall (module is the entry), not
// when imported by tests.
if (import.meta.main) {
  main().catch(() => {
    // Rule 3: never fail the install — the hint path above already covered
    // the actionable cases.
  });
}
