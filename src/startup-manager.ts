/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */
 
 import { join } from "path";
 import { $ } from "bun";

export class StartupManager {
  async generate(platform?: string): Promise<string> {
    const os = platform || process.platform;
    const bunPath = Bun.which("bun") || (os === "win32" ? "bun.exe" : "/usr/local/bin/bun");
    const pbossPath = join(import.meta.dir, "index.ts");
    const daemonPath = join(import.meta.dir, "daemon.ts");

    switch (os) {
      case "linux":
        return this.generateSystemd(bunPath, pbossPath, daemonPath);
      case "darwin":
        return this.generateLaunchd(bunPath, pbossPath, daemonPath);
      case "win32":
        return this.generateWindows(bunPath, pbossPath, daemonPath);
      default:
        throw new Error(`Unsupported platform: ${os}`);
    }
  }

  private generateWindows(bunPath: string, pbossPath: string, daemonPath: string): string {
    const taskName = "PBOSS_Daemon";
    return `# PBOSS Windows Startup Configuration
# To install as a Scheduled Task that starts automatically on user logon:
#
# schtasks /create /tn "${taskName}" /tr "\\"${bunPath}\\" run \\"${daemonPath}\\"" /sc onlogon /f /rl highest
#
# Or run with PowerShell:
# $Action = New-ScheduledTaskAction -Execute "${bunPath}" -Argument "run \\"${daemonPath}\\""
# $Trigger = New-ScheduledTaskTrigger -AtLogOn
# $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest
# Register-ScheduledTask -TaskName "${taskName}" -Action $Action -Trigger $Trigger -Principal $Principal -Force
#
# To resurrect processes after startup:
# "${bunPath}" run "${pbossPath}" resurrect
`;
  }
 
   private generateSystemd(bunPath: string, pbossPath: string, daemonPath: string): string {
     
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
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${join(bunPath, "..")}
Environment=PBOSS_HOME=${join(process.env.HOME || "/root", ".pboss")}
Restart=on-failure

ExecStart=${bunPath} run ${daemonPath}
ExecStartPost=${bunPath} run ${pbossPath} resurrect
ExecReload=${bunPath} run ${pbossPath} reload all
ExecStop=${bunPath} run ${pbossPath} kill

[Install]
WantedBy=multi-user.target
`;
   
const servicePath = "/etc/systemd/system/pboss.service";
return `# PBOSS Systemd Service
# Save to: ${servicePath}
# Then run:
#   sudo systemctl daemon-reload
#   sudo systemctl enable pboss
#   sudo systemctl start pboss

${unit}`;
}
 
   private generateLaunchd(bunPath: string, pbossPath: string, daemonPath: string): string {
     const plist = `<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
     <key>Label</key>
     <string>com.pboss.daemon</string>
     <key>ProgramArguments</key>
     <array>
         <string>${bunPath}</string>
         <string>run</string>
         <string>${daemonPath}</string>
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
         <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
         <key>HOME</key>
         <string>${process.env.HOME}</string>
     </dict>
 </dict>
 </plist>`;
 
const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.pboss.daemon.plist`;

return `# PBOSS LaunchAgent (macOS)
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
      const bunPath = Bun.which("bun") || "bun.exe";
      const daemonPath = join(import.meta.dir, "daemon.ts");
      const taskName = "PBOSS_Daemon";

      try {
        const proc = Bun.spawn([
          "schtasks",
          "/create",
          "/tn",
          taskName,
          "/tr",
          `"${bunPath}" run "${daemonPath}"`,
          "/sc",
          "onlogon",
          "/f",
          "/rl",
          "highest",
        ], { stdout: "pipe", stderr: "pipe" });
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
