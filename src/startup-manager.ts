/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Startup script generation (systemd / launchd / Windows Task Scheduler).
 *
 * The generated service definitions must survive without a login shell, so
 * they reference absolute executables resolved at generation time. What they
 * reference depends on how pboss was installed:
 *
 *  - Compiled standalone binary (one-line installer, `build:bin`): the daemon
 *    is started by re-executing the binary itself
 *    (`ExecStart=<pboss> __daemon`). Bun is embedded in the binary and is NOT
 *    required on the system.
 *
 *  - Script install (npm / `bun add -g pboss`, git checkout): the daemon runs
 *    on the system Bun runtime (`ExecStart=<bun> run <daemon.ts>`), which is
 *    therefore required.
 *
 * Detection lives in `src/install-mode.ts` and is shared with the daemon
 * launcher in `src/api.ts` so both stay consistent.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { join } from "path";
import { readFileSync } from "fs";
import { $ } from "bun";
import { ignore } from "./error-handling";
import { waitForDaemon, stopDaemonIfRunning } from "./api";
import {
  IS_COMPILED,
  findBun,
  daemonSpawnCommand,
  cliSpawnCommand,
  installModeDescription,
} from "./install-mode";

/**
 * The user the generated service should run as.
 *
 * `pboss startup` needs root on Linux (to write /etc/systemd/system), so it is
 * typically invoked with sudo — but the daemon itself should keep running as
 * the *invoking* human, not as root: their daemon data lives in their own
 * ~/.pboss, and a root daemon would silently split off into /root/.pboss.
 * When SUDO_USER is present we resolve that user's home and use it for the
 * service's User= and PBOSS_HOME.
 */
function targetUserContext(): { user: string; home: string } {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== "root") {
    const home = homeForUser(sudoUser);
    if (home) return { user: sudoUser, home };
  }
  return {
    user: process.env.USER || "root",
    home: process.env.HOME || "/root",
  };
}

/** Resolve a user's home directory: /etc/passwd → dscl (macOS) → getent (NSS). */
function homeForUser(user: string): string | null {
  try {
    const passwd = readFileSync("/etc/passwd", "utf-8");
    const line = passwd.split("\n").find((l) => l.startsWith(`${user}:`));
    const home = line?.split(":")[5];
    if (home) return home;
  } catch (err) {
    ignore(`resolve home for ${user} via /etc/passwd`, err);
  }
  try {
    const r = Bun.spawnSync(["dscl", ".", "-read", `/Users/${user}`, "NFSHomeDirectory"]);
    const out = new TextDecoder().decode(r.stdout ?? new Uint8Array()).trim();
    const m = out.match(/NFSHomeDirectory:\s*(.+)/);
    if (m?.[1]) return m[1].trim();
  } catch (err) {
    ignore(`resolve home for ${user} via dscl`, err);
  }
  try {
    const r = Bun.spawnSync(["getent", "passwd", user]);
    const out = new TextDecoder().decode(r.stdout ?? new Uint8Array()).trim();
    const home = out.split(":")[5];
    if (home) return home;
  } catch (err) {
    ignore(`resolve home for ${user} via getent`, err);
  }
  return null;
}

/**
 * The re-run command printed when privileges are missing. Preserving the
 * invoking user's PATH is the trick: `sudo` alone uses a minimal secure PATH
 * that does not include per-user bin dirs like ~/.bun/bin — which is exactly
 * why `sudo pboss` reports "command not found" on Bun-global installs.
 */
function sudoRetryHint(): string {
  return 'sudo env PATH="$PATH" pboss startup';
}

/** True when the current process has root privileges on Linux/macOS. */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export class StartupManager {
  async generate(platform?: string): Promise<string> {
    const os = platform || process.platform;

    // Resolved per install mode (see install-mode.ts):
    //   compiled → [<pboss binary>, "__daemon"]   (no Bun needed)
    //   script   → [<bun>, "run", <daemon.ts>]    (Bun required)
    const daemonCmd = daemonSpawnCommand();

    switch (os) {
      case "linux":
        return this.generateSystemd(daemonCmd);
      case "darwin":
        return this.generateLaunchd(daemonCmd);
      case "win32":
        return this.generateWindows(daemonCmd);
      default:
        throw new Error(`Unsupported platform: ${os}`);
    }
  }

  /**
   * Build the PATH the service should run with. Unlike a login shell,
   * systemd/launchd start with a minimal PATH, so the directory containing
   * the executable we reference must be included explicitly. Compiled
   * installs do not need a Bun directory at all.
   */
  private servicePath(): string {
    const parts = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
    if (!IS_COMPILED) {
      const bun = findBun();
      if (bun) parts.push(join(bun, ".."));
    }
    return parts.join(":");
  }

  private generateWindows(daemonCmd: string[]): string {
    const taskName = "PBOSS_Daemon";
    // schtasks /tr takes a single command line — quote it as a whole, and
    // quote individual tokens only when they contain spaces (paths like
    // "C:\Program Files\...").
    const trValue = daemonCmd.map(quoteWindowsToken).join(" ");
    const resurrectCmd = cliSpawnCommand("resurrect").join(" ");
    return `# PBOSS Windows Startup Configuration
# Install mode: ${installModeDescription()}
#
# To install as a Scheduled Task that starts automatically on user logon,
# simply run this from an elevated shell (Run as Administrator):
#
# pboss startup
#
# Equivalent manual commands:
# schtasks /create /tn "${taskName}" /tr "${trValue}" /sc onlogon /f /rl highest
#
# Or run with PowerShell:
# $Action = New-ScheduledTaskAction -Execute "${daemonCmd[0]}" -Argument "${daemonCmd.slice(1).join(" ")}"
# $Trigger = New-ScheduledTaskTrigger -AtLogOn
# $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest
# Register-ScheduledTask -TaskName "${taskName}" -Action $Action -Trigger $Trigger -Principal $Principal -Force
#
# To resurrect processes after startup:
# ${resurrectCmd}
`;
  }

  private generateSystemd(daemonCmd: string[]): string {
    const execStart = daemonCmd.join(" ");
    // --wait: poll for the ExecStart daemon instead of spawning a competing
    // one (resurrect's auto-spawn raced ExecStart for the socket; the loser
    // exited 1 and the unit looped into "Start request repeated too
    // quickly").
    const execStartPost = cliSpawnCommand("resurrect", "--wait", "30").join(" ");
    const execReload = cliSpawnCommand("reload", "all").join(" ");
    const execStop = cliSpawnCommand("kill").join(" ");
    const target = targetUserContext();

    const unit = `[Unit]
Description=ProcBoss Process Manager
Documentation=https://procboss.com
After=network.target

[Service]
Type=simple
User=${target.user}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=${this.servicePath()}
Environment=PBOSS_HOME=${join(target.home, ".pboss")}
Restart=on-failure
# Exit 81 = another daemon already owns the socket (leftover detached
# daemon). Retrying cannot fix that — without this, systemd restart-loops
# into "Start request repeated too quickly".
RestartPreventExitStatus=81

ExecStart=${execStart}
ExecStartPost=${execStartPost}
ExecReload=${execReload}
ExecStop=${execStop}

[Install]
WantedBy=multi-user.target
`;

    const servicePath = "/etc/systemd/system/pboss.service";
    return `# PBOSS Systemd Service
# Install mode: ${installModeDescription()}
# Runs as user: ${target.user} (home: ${target.home})
# Save to: ${servicePath}
# Or install it directly with:  ${sudoRetryHint()}
#
# If saved manually, then run:
#   sudo systemctl daemon-reload
#   sudo systemctl enable pboss
#   sudo systemctl start pboss

${unit}`;
  }

  private generateLaunchd(daemonCmd: string[]): string {
    const programArgs = daemonCmd
      .map((arg) => `         <string>${escapeXml(arg)}</string>`)
      .join("\n");
    // LaunchAgents are per-user — when installed via sudo, target the
    // invoking user's home, not root's (SUDO_USER-aware).
    const target = targetUserContext();
    const home = target.home;

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pboss.daemon</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(home, ".pboss", "logs", "daemon-out.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(home, ".pboss", "logs", "daemon-error.log")}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${this.servicePath()}</string>
        <key>HOME</key>
        <string>${home}</string>
    </dict>
</dict>
</plist>`;

    const plistPath = `${home}/Library/LaunchAgents/com.pboss.daemon.plist`;

    return `# PBOSS LaunchAgent (macOS)
# Install mode: ${installModeDescription()}
# Runs as user: ${target.user}
# Save to: ${plistPath}
# Then run:
# launchctl load -w ${plistPath}

${plist}`;
  }

  async install(): Promise<string> {
    const os = process.platform;
    const content = await this.generate(os);

    if (os === "linux") {
      if (!isRoot()) {
        throw new Error(
          `Root is required to install a system-wide systemd service.\n` +
            `Re-run:  ${sudoRetryHint()}\n` +
            `(keeping your PATH lets sudo find pboss wherever it is installed —\n` +
            ` plain \`sudo pboss\` cannot see per-user dirs like ~/.bun/bin)`
        );
      }

      const servicePath = "/etc/systemd/system/pboss.service";

      const unitStart = content.indexOf("[Unit]");
      const unitContent = content.substring(unitStart);

      try {
        await Bun.write(servicePath, unitContent);
      } catch (err) {
        throw new Error(
          `Failed to write ${servicePath} (${err instanceof Error ? err.message : String(err)}). Re-run with root:  ${sudoRetryHint()}`
        );
      }

      // A detached daemon from an earlier CLI command would hold the socket
      // the unit's ExecStart needs — the loser used to exit 1 and the unit
      // restart-looped. Ask any stray to stop BEFORE enabling the unit.
      // (Never spawns: it only acts when a daemon already answers.)
      await stopDaemonIfRunning();

      // Best-effort enablement — on hosts without a running systemd (some
      // containers) these fail; the file is still installed, so tell the user
      // which commands to run instead of crashing.
      const manual: string[] = [];
      for (const args of [
        ["daemon-reload"],
        ["enable", "pboss"],
        ["start", "pboss"],
      ] as const) {
        try {
          await $`systemctl ${args}`;
        } catch (err) {
          ignore(`systemctl ${args.join(" ")}`, err);
          manual.push(`systemctl ${args.join(" ")}`);
        }
      }

      if (manual.length > 0) {
        return (
          `Service file installed at ${servicePath}, but systemd could not be\n` +
          `controlled from here. Finish enabling it with:\n  ` +
          manual.map((c) => `sudo ${c}`).join("\n  ")
        );
      }

      // Verify the unit actually came up instead of reporting blind success.
      const active =
        (await $`systemctl is-active pboss`.text().catch((err: unknown) => {
          ignore("systemctl is-active pboss (verification)", err);
          return "";
        })).trim() === "active";
      const responsive = await waitForDaemon(15_000);
      if (!active || !responsive) {
        const journal = await $`journalctl -u pboss -n 25 --no-pager`
          .text()
          .catch((err: unknown) => {
            ignore("journalctl -u pboss (verification)", err);
            return "";
          });
        return (
          `Service installed but did not become healthy (active: ${active}, daemon responsive: ${responsive}).\n` +
          `Recent unit output:\n${journal || "  (journalctl unavailable)"}\n` +
          `Inspect with:  systemctl status pboss  ·  journalctl -u pboss -n 50 --no-pager`
        );
      }
      return `Service installed and started: ${servicePath}`;
    } else if (os === "darwin") {
      // LaunchAgents are per-user and need no root.
      const target = targetUserContext();
      const plistPath = join(target.home, "Library", "LaunchAgents", "com.pboss.daemon.plist");
      // Extract plist content
      const plistStart = content.indexOf("<?xml");
      const plistContent = content.substring(plistStart);
      await Bun.write(plistPath, plistContent);

      try {
        await $`launchctl unload ${plistPath}`; // reload if it was already loaded
      } catch (err) {
        ignore(`launchctl unload ${plistPath} (first install)`, err);
      }
      try {
        await $`launchctl load -w ${plistPath}`;
        return `Plist installed and loaded: ${plistPath}`;
      } catch (err) {
        ignore(`launchctl load -w ${plistPath}`, err);
        return `Plist installed at ${plistPath}\nLoad it:  launchctl load -w ${plistPath}`;
      }
    } else if (os === "win32") {
      if (!(await this.isAdmin())) {
        throw new Error(
          `Administrator rights are required to register the startup task.\n` +
            `Open a terminal as Administrator (Windows Terminal → right-click →\n` +
            ` Run as Administrator) and re-run:  pboss startup`
        );
      }

      // Daemon command resolved from the install mode, same as generate().
      const daemonCmd = daemonSpawnCommand();
      const taskName = "PBOSS_Daemon";
      const trValue = daemonCmd.map(quoteWindowsToken).join(" ");

      try {
        const proc = Bun.spawn(
          [
            "schtasks",
            "/create",
            "/tn",
            taskName,
            "/tr",
            `"${trValue}"`,
            "/sc",
            "onlogon",
            "/f",
            "/rl",
            "highest",
          ],
          { stdout: "pipe", stderr: "pipe" }
        );
        const code = await proc.exited;
        if (code !== 0) {
          return `Failed to create the scheduled task (schtasks exit code ${code}). Try running as Administrator.`;
        }

        return `Windows Scheduled Task "${taskName}" installed successfully.\nRun on demand: schtasks /run /tn "${taskName}"`;
      } catch (err: any) {
        return `Failed to create scheduled task: ${err.message}. Try running as Administrator.`;
      }
    }

    return "Unsupported platform for auto-install. Manual setup required.";
  }

  /** Detect whether the Windows shell is elevated (`net session` needs admin). */
  private async isAdmin(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["net", "session"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      return (await proc.exited) === 0;
    } catch {
      // Can't tell — let schtasks surface the real error instead.
      return true;
    }
  }

  async uninstall(): Promise<string> {
    const os = process.platform;

    if (os === "linux") {
      if (!isRoot()) {
        throw new Error(
          `Root is required to remove the system service.\n` +
            `Re-run:  sudo env PATH="$PATH" pboss startup remove`
        );
      }
      // Best-effort — tolerate hosts where systemd is not the init.
      try { await $`systemctl stop pboss`; } catch (err) { ignore("systemctl stop pboss (uninstall)", err); }
      try { await $`systemctl disable pboss`; } catch (err) { ignore("systemctl disable pboss (uninstall)", err); }
      try { await $`rm -f /etc/systemd/system/pboss.service`; } catch (err) { ignore("rm service file (uninstall)", err); }
      try { await $`systemctl daemon-reload`; } catch (err) { ignore("systemctl daemon-reload (uninstall)", err); }

      return "PBOSS service removed";
    } else if (os === "darwin") {
      const target = targetUserContext();
      const plistPath = join(target.home, "Library", "LaunchAgents", "com.pboss.daemon.plist");

      try { await $`launchctl unload ${plistPath}`; } catch (err) { ignore(`launchctl unload ${plistPath} (uninstall)`, err); }
      try { await $`rm -f ${plistPath}`; } catch (err) { ignore(`rm ${plistPath} (uninstall)`, err); }
      return "PBOSS launch agent removed";
    } else if (os === "win32") {
      const taskName = "PBOSS_Daemon";
      try {
        const proc = Bun.spawn(["schtasks", "/delete", "/tn", taskName, "/f"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        return `Windows Scheduled Task "${taskName}" removed.`;
      } catch (err: any) {
        return `Failed to remove scheduled task: ${err.message}`;
      }
    }

    return "Unsupported platform";
  }
}

/** Escape a value for inclusion in a plist XML string element. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Quote a single command token for a Windows command line when needed. */
function quoteWindowsToken(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}
