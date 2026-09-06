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
import { $ } from "bun";
import {
  IS_COMPILED,
  findBun,
  daemonSpawnCommand,
  cliSpawnCommand,
  installModeDescription,
} from "./install-mode";

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
# To install as a Scheduled Task that starts automatically on user logon:
#
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
    const execStartPost = cliSpawnCommand("resurrect").join(" ");
    const execReload = cliSpawnCommand("reload", "all").join(" ");
    const execStop = cliSpawnCommand("kill").join(" ");

    const unit = `[Unit]
Description=ProcBoss Process Manager
Documentation=https://procboss.com
After=network.target

[Service]
Type=simple
User=${process.env.USER || "root"}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=${this.servicePath()}
Environment=PBOSS_HOME=${join(process.env.HOME || "/root", ".pboss")}
Restart=on-failure

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
# Save to: ${servicePath}
# Then run:
#   sudo systemctl daemon-reload
#   sudo systemctl enable pboss
#   sudo systemctl start pboss

${unit}`;
  }

  private generateLaunchd(daemonCmd: string[]): string {
    const programArgs = daemonCmd
      .map((arg) => `         <string>${escapeXml(arg)}</string>`)
      .join("\n");

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
    <string>${join(process.env.HOME || "/Users/user", ".pboss", "logs", "daemon-out.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(process.env.HOME || "/Users/user", ".pboss", "logs", "daemon-error.log")}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${this.servicePath()}</string>
        <key>HOME</key>
        <string>${process.env.HOME}</string>
    </dict>
</dict>
</plist>`;

    const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.pboss.daemon.plist`;

    return `# PBOSS LaunchAgent (macOS)
# Install mode: ${installModeDescription()}
# Save to: ${plistPath}
# Then run:
# launchctl load ${plistPath}

${plist}`;
  }

  async install(): Promise<string> {
    const os = process.platform;
    const content = await this.generate(os);

    if (os === "linux") {
      const servicePath = "/etc/systemd/system/pboss.service";

      const unitStart = content.indexOf("[Unit]");
      const unitContent = content.substring(unitStart);

      try {
        await Bun.write(servicePath, unitContent);
      } catch {
        return "Failed to create the service file. Please ensure you have sufficient permissions (try running with sudo).";
      }

      await $`systemctl daemon-reload`;
      await $`systemctl enable pboss`;
      await $`systemctl start pboss`;

      return `Service installed at ${servicePath}`;
    } else if (os === "darwin") {
      const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.pboss.daemon.plist`;
      // Extract plist content
      const plistStart = content.indexOf("<?xml");
      const plistContent = content.substring(plistStart);
      await Bun.write(plistPath, plistContent);

      return `Plist installed at ${plistPath}\nRun: launchctl load ${plistPath}`;
    } else if (os === "win32") {
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
        await proc.exited;

        return `Windows Scheduled Task "${taskName}" installed successfully.\nRun on demand: schtasks /run /tn "${taskName}"`;
      } catch (err: any) {
        return `Failed to create scheduled task: ${err.message}. Try running as Administrator.`;
      }
    }

    return "Unsupported platform for auto-install. Manual setup required.";
  }

  async uninstall(): Promise<string> {
    const os = process.platform;

    if (os === "linux") {
      await $`systemctl stop pboss`;
      await $`systemctl disable pboss`;

      await $`rm -f /etc/systemd/system/pboss.service`;
      await $`systemctl daemon-reload`;

      return "PBOSS service removed";
    } else if (os === "darwin") {
      const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.pboss.daemon.plist`;

      await $`launchctl unload ${plistPath}`;
      await $`rm -f ${plistPath}`;
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
