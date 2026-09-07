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
import { readFileSync, rmSync } from "fs";
import { mkdir } from "fs/promises";
import { $ } from "bun";
import { ignore } from "./error-handling";
import { stopDaemonIfRunning } from "./api";
import { probeDaemon } from "./daemon-probe";
import { DAEMON_SOCKET } from "./constants";
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
 * `pboss startup install` needs root on Linux (to write /etc/systemd/system),
 * so it is typically invoked with sudo — but the daemon itself should keep
 * running as the *invoking* human, not as root: their daemon data lives in
 * their own ~/.pboss, and a root daemon would silently split off into
 * /root/.pboss. When SUDO_USER is present we resolve that user's home and
 * use it for the service's User= and PBOSS_HOME.
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
  return 'sudo env PATH="$PATH" pboss startup install';
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
    // "C:\Program Files\..."). `/ru` restricts the onlogon trigger to THIS
    // user's logon — without it the task fires at anyone's logon while
    // running as the creating account, which is wrong for a per-user daemon
    // (its state lives in the creating user's %USERPROFILE%\.pboss).
    const trValue = daemonCmd.map(quoteWindowsToken).join(" ");
    const resurrectCmd = cliSpawnCommand("resurrect").join(" ");
    return `# PBOSS Windows Startup Configuration
# Install mode: ${installModeDescription()}
#
# To install as a Scheduled Task that starts automatically on user logon,
# simply run this from an elevated shell (Run as Administrator):
#
# pboss startup install
#
# Equivalent manual commands:
# schtasks /create /tn "${taskName}" /tr "${trValue}" /sc onlogon /ru "%USERNAME%" /f /rl highest
#
# Or run with PowerShell (what \`pboss startup install\` itself uses — no
# nested /tr quoting to get wrong):
# $Action = New-ScheduledTaskAction -Execute "${daemonCmd[0]}" -Argument "${daemonCmd.slice(1).join(" ")}"
# $Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
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
    // quickly"). 10s is generous for a compiled binary to bind its socket;
    // it also keeps each FAILED start cycle short, which matters for the
    // start-rate limiter below.
    const execStartPost = cliSpawnCommand("resurrect", "--wait", "10").join(" ");
    const execReload = cliSpawnCommand("reload", "all").join(" ");
    const execStop = cliSpawnCommand("kill").join(" ");
    const target = targetUserContext();

    const unit = `[Unit]
Description=ProcBoss Process Manager
Documentation=https://procboss.com
After=network.target
# Explicit start-rate limiting. The systemd default is 5 starts / 10s —
# but one failed cycle here takes >=10s (ExecStartPost polls for the
# daemon), so the default window NEVER fills: a failing daemon
# restart-loops forever, which also leaves the queued start job pending
# forever and hangs systemctl start (and therefore
# "pboss startup install"). 5 starts / 120s always terminates.
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=${target.user}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=${this.servicePath()}
Environment=PBOSS_HOME=${join(target.home, ".pboss")}
Restart=on-failure
# Bound the whole start (including ExecStartPost) so a hung start is a
# failure systemd can act on, not a forever-activating unit.
TimeoutStartSec=20
# Exit 81 = another daemon already owns the socket (leftover detached
# daemon). Retrying cannot fix that — without this, systemd restart-loops
# into "Start request repeated too quickly".
RestartPreventExitStatus=81

# The leading '-' on ExecStartPost/ExecStop is the systemd "ignore exit
# status" modifier: a FAILED ExecStartPost aborts the whole start
# transaction — systemd would kill the healthy ExecStart daemon and
# restart-loop it. Resurrecting user processes is best-effort; unit health
# is ExecStart's job. Similarly, ExecStop failing must not mark the stop
# failed (systemd still falls back to SIGTERM + SIGKILL).
ExecStart=${execStart}
ExecStartPost=-${execStartPost}
ExecReload=${execReload}
ExecStop=-${execStop}

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
    <string>${escapeXml(join(home, ".pboss", "logs", "daemon-out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(home, ".pboss", "logs", "daemon-error.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(this.servicePath())}</string>
        <key>HOME</key>
        <string>${escapeXml(home)}</string>
        <key>PBOSS_HOME</key>
        <string>${escapeXml(join(home, ".pboss"))}</string>
    </dict>
</dict>
</plist>`;

    const plistPath = `${home}/Library/LaunchAgents/com.pboss.daemon.plist`;

    return `# PBOSS LaunchAgent (macOS)
# Install mode: ${installModeDescription()}
# Runs as user: ${target.user}
# Save to: ${plistPath}
# Or install it directly with:  pboss startup install   (LaunchAgents are
# per-user — no sudo needed; if you must use sudo, pboss targets the
# SUDO_USER's home and loads the agent as that user)
# Then run:
# launchctl load -w ${plistPath}

${plist}`;
  }

  /**
   * Install the boot startup service (systemd unit / launchd agent / Windows
   * scheduled task) and bring it up.
   *
   * @param opts.verifyTimeoutMs hard deadline for the post-install health
   *   verification (Linux). Default 30s; the npm postinstall hook passes a
   *   shorter one so a failing unit cannot stretch a package install.
   */
  async install(opts: { verifyTimeoutMs?: number } = {}): Promise<string> {
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

      const target = targetUserContext();
      return bringUpSystemdUnit({
        servicePath,
        targetUser: target.user,
        targetHome: target.home,
        verifyTimeoutMs: opts.verifyTimeoutMs,
      });
    } else if (os === "darwin") {
      // LaunchAgents are per-user and need no root.
      const target = targetUserContext();
      const plistPath = join(target.home, "Library", "LaunchAgents", "com.pboss.daemon.plist");
      // Extract plist content
      const plistStart = content.indexOf("<?xml");
      const plistContent = content.substring(plistStart);
      await Bun.write(plistPath, plistContent);

      // launchd opens StandardOut/StandardErrorPath BEFORE starting the
      // program: if the target user's ~/.pboss/logs does not exist yet, the
      // agent refuses to start with a cryptic "Path had bad permissions"
      // error. The CLI's own ensureDirs() ran for the INVOKING user's home —
      // under sudo that is /root/.pboss, not the target user's, so create
      // the directory explicitly for the user the agent will run as.
      await mkdir(join(target.home, ".pboss", "logs"), { recursive: true });

      // launchctl is per-user: under sudo, run it AS the SUDO_USER so the
      // agent is loaded into their session domain — root's launchctl would
      // load it into the system domain and it would never start at login.
      const asUser = this.launchctlAsUser();
      try {
        await $`${asUser} launchctl unload ${plistPath}`; // reload if it was already loaded
      } catch (err) {
        ignore(`launchctl unload ${plistPath} (first install)`, err);
      }
      try {
        await $`${asUser} launchctl load -w ${plistPath}`;
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
            ` Run as Administrator) and re-run:  pboss startup install`
        );
      }

      // Registration goes through PowerShell's Register-ScheduledTask
      // (built into Windows 8+), not `schtasks /create`: the daemon command
      // line regularly contains quoted paths ("C:\Program Files\..."), and
      // schtasks' /tr quoting rules mangle nested quotes into a broken
      // command line. PowerShell takes -Execute/-Argument as separate
      // values, so no shell layer ever re-parses them.
      const daemonCmd = daemonSpawnCommand();
      const taskName = "PBOSS_Daemon";
      const script = buildWindowsTaskRegistrationScript(daemonCmd, taskName);

      try {
        const proc = Bun.spawn(
          ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
          { stdout: "pipe", stderr: "pipe" }
        );
        const [code, errText] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text().catch((err: unknown) => {
            ignore("read powershell stderr (task registration)", err);
            return "";
          }),
        ]);
        if (code !== 0) {
          const detail = errText.trim();
          return (
            `Failed to create the scheduled task (powershell exit code ${code}).` +
            (detail ? `\n${detail}` : "") +
            `\nTry running as Administrator.`
          );
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
    } catch (err) {
      // Can't tell — let the task registration surface the real error
      // instead. Recorded so PBOSS_DEBUG=1 shows why the probe was skipped.
      ignore("net session (admin probe)", err);
      return true;
    }
  }

  /**
   * Prefix that makes launchctl act on the SUDO_USER's session domain when
   * `pboss startup install|uninstall` was run through sudo on macOS.
   * LaunchAgents are per-user, so running launchctl as root would load the
   * agent into the wrong (system) domain and it would never start at login.
   */
  private launchctlAsUser(): string[] {
    if (isRoot() && process.env.SUDO_USER && process.env.SUDO_USER !== "root") {
      return ["sudo", "-u", process.env.SUDO_USER];
    }
    return [];
  }

  async uninstall(): Promise<string> {
    const os = process.platform;

    if (os === "linux") {
      if (!isRoot()) {
        throw new Error(
          `Root is required to remove the system service.\n` +
            `Re-run:  sudo env PATH="$PATH" pboss startup uninstall`
        );
      }
      // Stop with --no-block + our own bounded wait: a plain `systemctl stop`
      // waits on the stop job, and a unit stuck in a restart loop (or with a
      // D-state process) can hold that job — and the whole uninstall — for
      // minutes. Also best-effort, to tolerate hosts without systemd.
      const stop = await runSystemctl(["--no-block", "stop", "pboss"]);
      if (stop.code === 0) {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const state = (await runSystemctl(["is-active", "pboss"])).out;
          if (state === "inactive" || state === "failed" || state === "") break;
          await Bun.sleep(300);
        }
      } else {
        ignore("systemctl --no-block stop pboss (uninstall)", stop.err);
      }
      const disable = await runSystemctl(["disable", "pboss"]);
      if (disable.code !== 0) ignore("systemctl disable pboss (uninstall)", disable.err);
      try {
        rmSync("/etc/systemd/system/pboss.service", { force: true });
      } catch (err) {
        ignore("rm service file (uninstall)", err);
      }
      const reload = await runSystemctl(["daemon-reload"]);
      if (reload.code !== 0) ignore("systemctl daemon-reload (uninstall)", reload.err);

      return "PBOSS service removed";
    } else if (os === "darwin") {
      const target = targetUserContext();
      const plistPath = join(target.home, "Library", "LaunchAgents", "com.pboss.daemon.plist");
      // Same domain rule as install(): launchctl as the SUDO_USER under sudo.
      const asUser = this.launchctlAsUser();

      try { await $`${asUser} launchctl unload ${plistPath}`; } catch (err) { ignore(`launchctl unload ${plistPath} (uninstall)`, err); }
      try { await $`rm -f ${plistPath}`; } catch (err) { ignore(`rm ${plistPath} (uninstall)`, err); }
      return "PBOSS launch agent removed";
    } else if (os === "win32") {
      const taskName = "PBOSS_Daemon";
      try {
        const proc = Bun.spawn(["schtasks", "/delete", "/tn", taskName, "/f"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, errText] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text().catch((err: unknown) => {
            ignore("read schtasks stderr (task delete)", err);
            return "";
          }),
        ]);
        if (code === 0) {
          return `Windows Scheduled Task "${taskName}" removed.`;
        }
        // "The system cannot find the file specified" = no such task —
        // report that honestly instead of fake success.
        if (/cannot find|does not exist|not exist/i.test(errText)) {
          return `No "${taskName}" scheduled task found — nothing to remove.`;
        }
        return (
          `Failed to remove scheduled task (schtasks exit code ${code}).` +
          (errText.trim() ? `\n${errText.trim()}` : "")
        );
      } catch (err: any) {
        return `Failed to remove scheduled task: ${err.message}`;
      }
    }

    return "Unsupported platform";
  }
}

// ---------------------------------------------------------------------------
// systemd bring-up — the post-install half of `pboss startup install`
// (Linux). Kept as module-level functions with systemctl resolved through
// PATH so tests can drive them with a shim and no real systemd.
// ---------------------------------------------------------------------------

/** One systemctl invocation: exit code plus trimmed stdout/stderr. */
export interface SystemctlResult {
  code: number;
  out: string;
  err: string;
}

/**
 * Run systemctl WITHOUT throwing. Ordinary systemctl states exit non-zero
 * ("is-active" exits 3 for "activating"), which is information here, not
 * failure. systemctl is resolved through PATH; a missing binary comes back
 * as code 127 so callers can fall back to manual instructions.
 */
export async function runSystemctl(args: string[]): Promise<SystemctlResult> {
  try {
    // env: process.env (the LIVE object) — Bun resolves the executable
    // through the PATH of the env passed at spawn time, so tests can
    // substitute a systemctl shim by mutating PATH in-process.
    const proc = Bun.spawn(["systemctl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: code ?? 127, out: out.trim(), err: err.trim() };
  } catch (err) {
    ignore(`systemctl ${args.join(" ")}`, err);
    return { code: 127, out: "", err: err instanceof Error ? err.message : String(err) };
  }
}

/** journalctl text (best-effort): trimmed output, "" when unavailable. */
export async function journalctlText(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["journalctl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch (err) {
    ignore(`journalctl ${args.join(" ")}`, err);
    return "";
  }
}

export interface BringUpOptions {
  /** Where the unit file was written (used in the result messages). */
  servicePath: string;
  /** The user the unit runs as (User=) — used in messages. */
  targetUser: string;
  /** Home of User= — the unit's PBOSS_HOME lives under it. */
  targetHome: string;
  /** Overall deadline for the unit to become healthy. Default 30s. */
  verifyTimeoutMs?: number;
  /**
   * Socket of the INVOKING CLI's own daemon (root's /root/.pboss under
   * sudo). Default: the CLI's own PBOSS_HOME socket. Overridable so
   * tests can point it at a path nothing will ever answer.
   */
  cliSocket?: string;
}

/**
 * Bring the freshly written unit up and VERIFY it — the half of
 * `pboss startup install` that runs after the unit file lands in
 * /etc/systemd/system.
 *
 * THE HANG THIS CODE EXISTS TO PREVENT: `systemctl start pboss` BLOCKS
 * until the start job completes, and this unit can keep the job pending
 * FOREVER. Every failed start cycle includes ExecStartPost polling for
 * the daemon (>=10s), so each cycle outlives systemd's default
 * start-rate-limit window (5 starts / 10s) — "Start request repeated too
 * quickly" never fires, Restart=on-failure loops forever, and the queued
 * start job (plus the CLI that awaited it) hangs indefinitely. That is
 * the "install hangs although the unit file exists" bug.
 *
 * Defense, in layers:
 *   1. start is submitted with --no-block (job in, no waiting);
 *   2. health is polled HERE with a hard deadline — is-active state plus
 *      a ping on the socket the unit's daemon actually binds;
 *   3. the unit itself rate-limits (StartLimitIntervalSec/Burst) and
 *      bounds its start (TimeoutStartSec) so systemd gives up on its own.
 */
export async function bringUpSystemdUnit(opts: BringUpOptions): Promise<string> {
  const unitSocket = join(opts.targetHome, ".pboss", "daemon.sock");

  // A detached daemon from an earlier CLI command would hold the socket
  // the unit's ExecStart needs — the loser used to exit 1 and the unit
  // restart-looped. Ask any stray to stop BEFORE starting the unit, on
  // BOTH sockets involved: the CLI's own PBOSS_HOME (root's /root/.pboss
  // under sudo) and the target user's home (the unit runs as them). Never
  // spawns: it only acts when a daemon already answers.
  await stopDaemonIfRunning(15_000, opts.cliSocket ?? DAEMON_SOCKET);
  if (unitSocket !== (opts.cliSocket ?? DAEMON_SOCKET)) {
    await stopDaemonIfRunning(15_000, unitSocket);
  }

  const manual: string[] = [];
  // daemon-reload and enable submit no job — safe to wait on.
  for (const args of [["daemon-reload"], ["enable", "pboss"]] as const) {
    const r = await runSystemctl([...args]);
    if (r.code !== 0) {
      ignore(`systemctl ${args.join(" ")} (bring-up)`, r.err);
      manual.push(`systemctl ${args.join(" ")}`);
    }
  }
  // The start job is the only hangable one — submit it, never await it.
  const start = await runSystemctl(["--no-block", "start", "pboss"]);
  if (start.code !== 0) {
    ignore("systemctl --no-block start pboss (bring-up)", start.err);
    manual.push("systemctl start pboss");
  }

  if (manual.length > 0) {
    return (
      `Service file installed at ${opts.servicePath}, but systemd could not be\n` +
      `controlled from here. Finish enabling it with:\n  ` +
      manual.map((c) => `sudo ${c}`).join("\n  ")
    );
  }

  // Verify: poll the unit state and the daemon socket until healthy,
  // permanently failed, or out of time. Two signals, both needed —
  // Type=simple reports "active" the moment ExecStart is forked (before
  // the socket exists), and a leftover daemon can answer the socket while
  // the unit itself is "failed".
  const deadline = Date.now() + (opts.verifyTimeoutMs ?? 30_000);
  let state = "";
  let responsive = false;
  while (Date.now() < deadline) {
    state = (await runSystemctl(["is-active", "pboss"])).out;
    responsive = (await probeDaemon(unitSocket)) !== null;
    if (state === "active" && responsive) break;
    // The unit gave up (start-rate limited / permanent failure) — polling
    // longer cannot change the verdict.
    if (state === "failed") break;
    await Bun.sleep(500);
  }

  if (state === "active" && responsive) {
    return `Service installed and started: ${opts.servicePath}`;
  }

  const journal = await journalctlText(["-u", "pboss", "-n", "25", "--no-pager"]);
  return (
    `Service installed but is not healthy (unit state: ${state || "unknown"},\n` +
    `daemon at ${unitSocket} ${responsive ? "is" : "is not"} answering).\n` +
    `Recent unit output:\n${journal || "  (journalctl unavailable)"}\n` +
    `Inspect with:  systemctl status pboss  ·  journalctl -u pboss -n 50 --no-pager`
  );
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

/** Quote a value for a PowerShell single-quoted string ('' escapes '). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell script that registers the pboss daemon as a per-user Scheduled
 * Task firing at the current user's logon. Kept as a pure function so it can
 * be unit-tested off-Windows.
 *
 * Why Register-ScheduledTask instead of `schtasks /create`: the daemon
 * command line often contains quoted paths ("C:\Program Files\..."), and
 * schtasks' /tr quoting rules mangle nested quotes into a broken command
 * line. PowerShell receives -Execute / -Argument as separate values, so no
 * shell layer ever re-parses them.
 *
 * The trigger is restricted to the current user's logon (`-User`) — the
 * daemon's state is per-user (~/.pboss), so it must not start for other
 * accounts. `-RunLevel Highest` mirrors the admin shell that registers it.
 */
export function buildWindowsTaskRegistrationScript(
  daemonCmd: string[],
  taskName = "PBOSS_Daemon"
): string {
  const exeToken = daemonCmd[0];
  if (!exeToken) throw new Error("daemon command must start with an executable path");
  const exe = psQuote(exeToken);
  // Tokens with spaces (script-install paths) are double-quoted inside the
  // single-quoted -Argument value; PowerShell passes them through verbatim.
  const argument = psQuote(daemonCmd.slice(1).map(quoteWindowsToken).join(" "));
  const user = process.env.USERNAME; // set by Windows for interactive sessions
  const trigger = user
    ? `New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(user)}`
    : "New-ScheduledTaskTrigger -AtLogOn";
  const principal = user
    ? `New-ScheduledTaskPrincipal -UserId ${psQuote(user)} -LogonType Interactive -RunLevel Highest`
    : "New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Highest";
  return [
    // Without this, cmdlet failures are non-terminating and the exit code
    // stays 0 — the CLI would report success for a failed registration.
    "$ErrorActionPreference = 'Stop'",
    `$Action = New-ScheduledTaskAction -Execute ${exe} -Argument ${argument}`,
    `$Trigger = ${trigger}`,
    `$Principal = ${principal}`,
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $Action -Trigger $Trigger -Principal $Principal -Force | Out-Null`,
  ].join("\n");
}
