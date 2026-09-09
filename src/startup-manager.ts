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

import { join, dirname } from "path";
import { readFileSync, rmSync, existsSync } from "fs";
import { mkdir } from "fs/promises";
import { $ } from "bun";
import { ignore } from "./error-handling";
import { colorize } from "./utils";
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
 * Boot persistence is PER-USER: the Linux systemd unit is a user unit
 * (~/.config/systemd/user) and macOS uses a per-user LaunchAgent, so the
 * service always targets the INVOKING user's ~/.pboss. SUDO_USER is still
 * resolved for legacy `sudo pboss startup install` runs so paths stay sane,
 * but install() actively tells sudo users to re-run as themselves (root has
 * no user systemd session, and a root daemon would split into /root/.pboss).
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

/** The re-run command printed when boot persistence is missing. No sudo —
 *  the service is per-user, so the user's own shell is always enough. */
function startupInstallHint(): string {
  return "pboss startup install";
}

/**
 * Directory holding the per-user systemd unit: ~/.config/systemd/user.
 * User units need no root: `systemctl --user` talks to the user's own
 * manager, and `WantedBy=default.target` enables it for their sessions.
 */
function userUnitDir(home: string): string {
  return join(home, ".config", "systemd", "user");
}

/**
 * Guard against the LEGACY habit this change exists to kill: running
 * `sudo pboss startup install`. Under sudo, `systemctl --user` reaches
 * root's session (or none at all) — never the invoking user's — so the
 * install would land in the wrong home or fail opaquely. pboss now needs
 * no root anywhere on this path; say so, clearly.
 */
function assertNotUnderSudo(): void {
  if (isRoot() && process.env.SUDO_USER && process.env.SUDO_USER !== "root") {
    throw new Error(
      `pboss startup no longer needs sudo — the boot service is per-user.\n` +
        `Re-run as yourself:  ${startupInstallHint()}`
    );
  }
}

/** True when the current process has root privileges on Linux/macOS. */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Best-effort `loginctl enable-linger <user>`: with linger, the user's
 * systemd instance (and the pboss daemon) starts at BOOT, before any
 * login; without it, at the user's first login. Self-linger is polkit
 * allowed for active local users on modern systemd; on hosts where it is
 * not, the caller prints the one-line hint and moves on — never an error.
 */
async function enableLinger(user: string): Promise<boolean> {
  try {
    // env: process.env (the LIVE object) — Bun resolves the executable
    // through the PATH of the env passed at spawn time (same as
    // runSystemctl), so tests can substitute a loginctl shim by
    // mutating PATH in-process.
    const proc = Bun.spawn(["loginctl", "enable-linger", user], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: process.env,
    });
    return (await proc.exited) === 0;
  } catch (err) {
    ignore(`loginctl enable-linger ${user}`, err);
    return false;
  }
}

/**
 * Read-only linger probe for `pboss startup status`: true/false, or null
 * when loginctl is unavailable. `loginctl show-user --property=Linger`
 * works for the invoking user without privileges.
 */
async function lingerEnabled(user: string): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(
      ["loginctl", "show-user", user, "--property=Linger", "--value"],
      // env: process.env (the LIVE object) — see enableLinger.
      { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: process.env }
    );
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0) return null;
    return out === "yes" || out === "true" || out === "1";
  } catch (err) {
    ignore(`loginctl show-user ${user} (status)`, err);
    return null;
  }
}

/**
 * Reboot-survival self-heal, called when the daemon process comes up
 * OUTSIDE systemd (the CLI's on-demand daemonizer): without linger the
 * user unit only starts at the user's first login, so a headless reboot
 * leaves the machine dark — no daemon, no cloud link — until someone
 * logs in. If the unit is installed but linger is off, flip it on
 * (best-effort, no root). Called from the __daemon entry so the cloud
 * connection survives the NEXT reboot even when nobody logs in.
 */
export async function selfHealLinger(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  // systemd started us — linger is already on (or deliberately managed).
  if (process.env.INVOCATION_ID) return false;
  const target = targetUserContext();
  const unit = join(userUnitDir(target.home), "pboss.service");
  if (!existsSync(unit)) return false; // nothing to start at boot yet
  const on = await enableLinger(target.user);
  if (on) {
    console.log(
      colorize(
        `☁  linger enabled for ${target.user} — the daemon now starts at BOOT, before any login`,
        "cyan"
      )
    );
  }
  return on;
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
   * installs do not need a Bun directory for pboss itself — but the target
   * user's ~/.bun/bin is still added when it exists, because worker
   * processes (and anything they shell out to by name) inherit the unit's
   * PATH and a `bun`-by-name lookup inside a worker must resolve.
   */
  private servicePath(targetHome?: string): string {
    const parts: string[] = [];
    if (targetHome) {
      const userBunBin = join(targetHome, ".bun", "bin");
      if (existsSync(userBunBin)) parts.push(userBunBin);
    }
    parts.push("/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin");
    if (!IS_COMPILED) {
      const bun = findBun();
      if (bun) {
        const bunDir = dirname(bun);
        if (!parts.includes(bunDir)) parts.push(bunDir);
      }
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
# run this from a regular shell:
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
    const unitPath = this.servicePath(target.home);
    const serviceDir = userUnitDir(target.home);

    // A USER unit: no User= directive (it runs as the owning user), and
    // WantedBy=default.target — the user manager has no multi-user.target.
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
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=${unitPath}
Environment=PBOSS_HOME=${join(target.home, ".pboss")}
# ALWAYS, not on-failure: the daemon must come back after ANY exit that is
# not an explicit stop — including a crash that happens to exit 0. Exit 81
# (another daemon owns the socket) stays non-restartable below.
Restart=always
RestartSec=2
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
WantedBy=default.target
`;

    const servicePath = join(serviceDir, "pboss.service");
    return `# PBOSS Systemd Service (per-user — no root required)
# Install mode: ${installModeDescription()}
# Runs as user: ${target.user} (home: ${target.home})
# Save to: ${servicePath}
# Or install it directly with:  ${startupInstallHint()}
#
# If saved manually, then run:
#   systemctl --user daemon-reload
#   systemctl --user enable pboss
#   systemctl --user start pboss
#
# Start at BOOT (before any login) instead of at first login:
#   loginctl enable-linger ${target.user}

${unit}`;
  }

  private generateLaunchd(daemonCmd: string[]): string {
    const programArgs = daemonCmd
      .map((arg) => `         <string>${escapeXml(arg)}</string>`)
      .join("\n");
    // LaunchAgents are per-user — the agent targets the invoking user's
    // home (SUDO_USER-aware only so legacy sudo runs keep sane paths).
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
        <string>${escapeXml(this.servicePath(home))}</string>
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
# Or install it directly with:  ${startupInstallHint()}
#   (LaunchAgents are per-user — no sudo needed or wanted.)
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
   * @param opts.cliSocket where to probe for (and stop) a stray CLI daemon
   *   before the unit starts. Default: the CLI's own PBOSS_HOME socket;
   *   overridable so tests can point it at a path nothing will ever answer.
   */
  async install(opts: { verifyTimeoutMs?: number; cliSocket?: string } = {}): Promise<string> {
    const os = process.platform;
    const content = await this.generate(os);

    if (os === "linux") {
      // Sudo is not just unnecessary here — it is WRONG: root has no user
      // systemd session, so `systemctl --user` could never reach the
      // invoking user's manager. Tell the legacy habit to re-run plain.
      assertNotUnderSudo();

      const target = targetUserContext();
      const servicePath = join(userUnitDir(target.home), "pboss.service");

      const unitStart = content.indexOf("[Unit]");
      const unitContent = content.substring(unitStart);

      try {
        await mkdir(userUnitDir(target.home), { recursive: true });
        await Bun.write(servicePath, unitContent);
      } catch (err) {
        throw new Error(
          `Failed to write ${servicePath} (${err instanceof Error ? err.message : String(err)}).`
        );
      }

      return bringUpSystemdUnit({
        servicePath,
        targetUser: target.user,
        targetHome: target.home,
        verifyTimeoutMs: opts.verifyTimeoutMs,
        cliSocket: opts.cliSocket,
        userMode: true,
      });
    } else if (os === "darwin") {
      // LaunchAgents are per-user and need no root.
      assertNotUnderSudo();
      const target = targetUserContext();
      const plistPath = join(target.home, "Library", "LaunchAgents", "com.pboss.daemon.plist");
      // Extract plist content
      const plistStart = content.indexOf("<?xml");
      const plistContent = content.substring(plistStart);
      await mkdir(join(target.home, "Library", "LaunchAgents"), { recursive: true });
      await Bun.write(plistPath, plistContent);

      // launchd opens StandardOut/StandardErrorPath BEFORE starting the
      // program: if the target user's ~/.pboss/logs does not exist yet, the
      // agent refuses to start with a cryptic "Path had bad permissions"
      // error — create the directory explicitly for the user the agent
      // will run as.
      await mkdir(join(target.home, ".pboss", "logs"), { recursive: true });

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
      // The task is registered for the CURRENT user (their logon, their
      // %USERPROFILE%\.pboss) — no Administrator gate upfront: per-user
      // registration is allowed unelevated. If THIS host's policy refuses
      // it, the failure path below names the elevated re-run honestly.
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
            `\nIf this host requires elevation for per-user tasks, re-run from an\nAdministrator shell:  pboss startup install`
          );
        }

        return `Windows Scheduled Task "${taskName}" installed successfully.\nRun on demand: schtasks /run /tn "${taskName}"`;
      } catch (err: any) {
        return `Failed to create scheduled task: ${err.message}. If this host requires elevation for per-user tasks, re-run from an Administrator shell.`;
      }
    }

    return "Unsupported platform for auto-install. Manual setup required.";
  }

  async uninstall(): Promise<string> {
    const os = process.platform;

    if (os === "linux") {
      // The unit is per-user — removing it is the user's own operation.
      assertNotUnderSudo();
      const target = targetUserContext();
      const servicePath = join(userUnitDir(target.home), "pboss.service");

      // Stop with --no-block + our own bounded wait: a plain `systemctl stop`
      // waits on the stop job, and a unit stuck in a restart loop (or with a
      // D-state process) can hold that job — and the whole uninstall — for
      // minutes. Also best-effort, to tolerate hosts without systemd.
      const stop = await runSystemctl(["--no-block", "stop", "pboss"], { user: true });
      if (stop.code === 0) {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const state = (await runSystemctl(["is-active", "pboss"], { user: true })).out;
          if (state === "inactive" || state === "failed" || state === "") break;
          await Bun.sleep(300);
        }
      } else {
        ignore("systemctl --user --no-block stop pboss (uninstall)", stop.err);
      }
      const disable = await runSystemctl(["disable", "pboss"], { user: true });
      if (disable.code !== 0) ignore("systemctl --user disable pboss (uninstall)", disable.err);
      try {
        rmSync(servicePath, { force: true });
      } catch (err) {
        ignore(`rm ${servicePath} (uninstall)`, err);
      }
      const reload = await runSystemctl(["daemon-reload"], { user: true });
      if (reload.code !== 0) ignore("systemctl --user daemon-reload (uninstall)", reload.err);

      return "PBOSS service removed";
    } else if (os === "darwin") {
      assertNotUnderSudo();
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

  /**
   * Read-only boot-persistence report (`pboss startup status`): is the
   * boot service installed/enabled, is the daemon up, and what exactly a
   * reboot would restore from the auto-saved dump. Never mutates anything.
   *
   * `opts.unitDir` redirects where the systemd unit is looked up
   * (default ~/.config/systemd/user) so tests can point it at a fixture
   * directory.
   */
  async status(opts: { unitDir?: string } = {}): Promise<string> {
    const os = process.platform;
    const target = targetUserContext();
    const unitDir = opts.unitDir ?? userUnitDir(target.home);
    // The pboss home the daemon actually uses: an explicit PBOSS_HOME env
    // wins (the daemon started under it honors the same pointer), else the
    // target user's ~/.pboss (same rule as the unit).
    const pbossHome = process.env.PBOSS_HOME || join(target.home, ".pboss");
    const lines: string[] = [];
    let installed = false;

    if (os === "linux") {
      const unitPath = join(unitDir, "pboss.service");
      const wantsPath = join(unitDir, "default.target.wants", "pboss.service");
      installed = existsSync(unitPath);

      lines.push("Boot startup service (systemd, per-user)");
      lines.push(`  Service:    ${unitPath}`);
      lines.push(`  Installed:  ${installed ? "yes" : "no"}`);
      if (installed) {
        lines.push(
          existsSync(wantsPath)
            ? "  Enabled:    yes — starts with your session (default.target)"
            : "  Enabled:    no — run:  systemctl --user enable pboss"
        );
        // 127 = no systemctl on this host (container): nothing to report.
        const active = await runSystemctl(["is-active", "pboss"], { user: true });
        if (active.code !== 127) {
          lines.push(`  Active:     ${active.out || "unknown"}`);
        }
        // Linger decides boot-vs-first-login: report it read-only.
        const linger = await lingerEnabled(target.user);
        lines.push(
          linger === null
            ? "  Linger:     unknown (loginctl unavailable)"
            : linger
              ? "  Linger:     on — the daemon starts at BOOT, before login"
              : "  Linger:     off — the daemon starts at first login (enable with:  loginctl enable-linger)"
        );
      } else {
        lines.push(`  → install it with:  ${startupInstallHint()}`);
      }
    } else if (os === "darwin") {
      const plistPath = join(target.home, "Library", "LaunchAgents", "com.pboss.daemon.plist");
      installed = existsSync(plistPath);
      lines.push("Boot startup service (launchd)");
      lines.push(`  Service:    ${plistPath}`);
      lines.push(`  Installed:  ${installed ? "yes" : "no"}`);
      if (!installed) {
        lines.push(`  → install it with:  ${startupInstallHint()}`);
      }
    } else if (os === "win32") {
      let installed = false;
      try {
        const proc = Bun.spawn(["schtasks", "/query", "/tn", "PBOSS_Daemon"], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        installed = (await proc.exited) === 0;
      } catch (err) {
        ignore("schtasks /query (startup status)", err);
      }
      lines.push("Boot startup service (Task Scheduler)");
      lines.push(`  Service:    PBOSS_Daemon scheduled task`);
      lines.push(`  Installed:  ${installed ? "yes" : "no"}`);
      if (!installed) {
        lines.push(`  → install it with:  ${startupInstallHint()}`);
      }
    } else {
      return `Unsupported platform for startup status: ${os}`;
    }

    // Daemon liveness on the daemon's ACTUAL home (explicit PBOSS_HOME or
    // the target user's ~/.pboss — SUDO_USER-aware, same rule as the unit).
    if (os === "linux" || os === "darwin") {
      const socket = join(pbossHome, "daemon.sock");
      const probe = await probeDaemon(socket);
      lines.push(
        probe
          ? `  Daemon:     reachable (pid ${probe.pid}) at ${socket}`
          : `  Daemon:     not answering at ${socket}`
      );
    }

    // What a reboot restores — from the auto-saved dump.
    const dumpPath = join(pbossHome, "dump.json");
    const summary = dumpBootSummary(pbossHome);
    lines.push("");
    lines.push("Reboot persistence:");
    lines.push(`  Dump:       ${dumpPath}`);
    if (!summary || summary.total === 0) {
      lines.push(
        "  On boot:    nothing to restore yet (process starts are saved automatically)"
      );
    } else if (installed) {
      const parts = [`${summary.running} process(es) come back running`];
      if (summary.stopped > 0) parts.push(`${summary.stopped} stopped`);
      lines.push(`  On boot:    ${parts.join(", ")}`);
    } else {
      lines.push(
        `  On boot:    nothing yet — ${summary.total} saved process(es) are waiting for the service above`
      );
    }

    return lines.join("\n");
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
 *
 * `opts.user` prepends `--user`, addressing the invoking user's own
 * manager — the no-root path user units live on.
 */
export async function runSystemctl(
  args: string[],
  opts: { user?: boolean } = {}
): Promise<SystemctlResult> {
  const fullArgs = [...(opts.user ? ["--user"] : []), ...args];
  try {
    // env: process.env (the LIVE object) — Bun resolves the executable
    // through the PATH of the env passed at spawn time, so tests can
    // substitute a systemctl shim by mutating PATH in-process.
    const proc = Bun.spawn(["systemctl", ...fullArgs], {
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
    ignore(`systemctl ${fullArgs.join(" ")}`, err);
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
  /** The user the unit runs as — used in messages and linger. */
  targetUser: string;
  /** Home of the unit's user — the unit's PBOSS_HOME lives under it. */
  targetHome: string;
  /** Overall deadline for the unit to become healthy. Default 30s. */
  verifyTimeoutMs?: number;
  /**
   * Socket of the INVOKING CLI's own daemon. Default: the CLI's own
   * PBOSS_HOME socket. Overridable so tests can point it at a path nothing
   * will ever answer.
   */
  cliSocket?: string;
  /**
   * User-unit mode: drive `systemctl --user` (the no-root path). The
   * manual fallback commands then lose their sudo prefix.
   */
  userMode?: boolean;
}

/**
 * Bring the freshly written unit up and VERIFY it — the half of
 * `pboss startup install` that runs after the unit file lands on disk
 * (~/.config/systemd/user/pboss.service for user units).
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
  const user = opts.userMode === true;
  const ctl = { user };

  // A detached daemon from an earlier CLI command would hold the socket
  // the unit's ExecStart needs — the loser used to exit 1 and the unit
  // restart-looped. Ask any stray to stop BEFORE starting the unit, on
  // BOTH sockets involved: the CLI's own PBOSS_HOME and the unit user's
  // home. Never spawns: it only acts when a daemon already answers.
  await stopDaemonIfRunning(15_000, opts.cliSocket ?? DAEMON_SOCKET);
  if (unitSocket !== (opts.cliSocket ?? DAEMON_SOCKET)) {
    await stopDaemonIfRunning(15_000, unitSocket);
  }

  const manual: string[] = [];
  // daemon-reload and enable submit no job — safe to wait on.
  for (const args of [["daemon-reload"], ["enable", "pboss"]] as const) {
    const r = await runSystemctl([...args], ctl);
    if (r.code !== 0) {
      ignore(`systemctl ${user ? "--user " : ""}${args.join(" ")} (bring-up)`, r.err);
      manual.push(`systemctl ${user ? "--user " : ""}${args.join(" ")}`);
    }
  }
  // The (re)start job is the only hangable one — submit it, never await it.
  // RESTART, not start: re-running `pboss startup install` (e.g. after
  // `pboss upgrade` replaced the binary) must actually (re)start the unit
  // — a bare `start` on an already-active unit is a NO-OP and would leave
  // the OLD binary running until the next reboot. On an inactive unit,
  // restart behaves exactly like start.
  const start = await runSystemctl(["--no-block", "restart", "pboss"], ctl);
  if (start.code !== 0) {
    ignore(`systemctl ${user ? "--user " : ""}--no-block restart pboss (bring-up)`, start.err);
    manual.push(`systemctl ${user ? "--user " : ""}restart pboss`);
  }

  if (manual.length > 0) {
    return (
      `Service file installed at ${opts.servicePath}, but systemd could not be\n` +
      `controlled from here. Finish enabling it with:\n  ` +
      manual.join("\n  ")
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
    state = (await runSystemctl(["is-active", "pboss"], ctl)).out;
    responsive = (await probeDaemon(unitSocket)) !== null;
    if (state === "active" && responsive) break;
    // The unit gave up (start-rate limited / permanent failure) — polling
    // longer cannot change the verdict.
    if (state === "failed") break;
    await Bun.sleep(500);
  }

  // Linger (user units): with it the daemon runs from BOOT; without, from
  // the user's first login. Best-effort — the install itself already
  // succeeded at this point, so a refused linger is a NOTE, never a fail.
  let lingerNote = "";
  if (user) {
    const lingerOn = await enableLinger(opts.targetUser);
    lingerNote = lingerOn
      ? "\nLinger: on — the daemon starts at BOOT (before any login)."
      : "\nLinger: off — the daemon starts at your FIRST LOGIN. Start it at boot with:\n  loginctl enable-linger " +
        opts.targetUser;
  }

  if (state === "active" && responsive) {
    return `Service installed and started: ${opts.servicePath}${lingerNote}`;
  }

  const journal = await journalctlText(
    user ? ["--user", "-u", "pboss", "-n", "25", "--no-pager"] : ["-u", "pboss", "-n", "25", "--no-pager"]
  );
  return (
    `Service installed but is not healthy (unit state: ${state || "unknown"},\n` +
    `daemon at ${unitSocket} ${responsive ? "is" : "is not"} answering).\n` +
    `Recent unit output:\n${journal || "  (journalctl unavailable)"}\n` +
    `Inspect with:  systemctl ${user ? "--user " : ""}status pboss  ·  journalctl ${user ? "--user " : ""}-u pboss -n 50 --no-pager`
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

// ---------------------------------------------------------------------------
// Boot-persistence introspection — shared by `pboss startup status` and the
// first-start onboarding hint in the CLI. All read-only.
// ---------------------------------------------------------------------------

/** What the auto-saved dump would restore at boot. */
export interface DumpBootSummary {
  total: number;
  running: number;
  stopped: number;
}

/**
 * Count what a reboot restores from a pboss home's dump.json (the
 * directory that CONTAINS dump.json — i.e. ~/.pboss or $PBOSS_HOME):
 * entries with stopped === true come back stopped, everything else comes
 * back running. Returns null when there is no dump (nothing started yet).
 */
export function dumpBootSummary(pbossHome: string): DumpBootSummary | null {
  try {
    const dumpPath = join(pbossHome, "dump.json");
    if (!existsSync(dumpPath)) return null;
    const parsed = JSON.parse(readFileSync(dumpPath, "utf-8"));
    if (!Array.isArray(parsed)) return null;
    let running = 0;
    let stopped = 0;
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && (entry as any).stopped === true) {
        stopped++;
      } else {
        running++;
      }
    }
    return { total: parsed.length, running, stopped };
  } catch (err) {
    ignore(`read dump summary for ${pbossHome}`, err);
    return null;
  }
}

/** Presence + install command for the boot service on this platform. */
export interface BootServicePresence {
  installed: boolean;
  /** The exact command that installs the boot service here. */
  howToInstall: string;
}

/**
 * Cheap read-only check for the boot service: file existence on
 * Linux/macOS, a bounded schtasks query on Windows. Safe to call from
 * anywhere — the first-start persistence hint runs this after `pboss start`.
 *
 * `opts.unitDir` redirects where the systemd unit is looked up
 * (default ~/.config/systemd/user) so tests can point it at a fixture
 * directory. The real path stays the default for production callers, but
 * tests must never let the developer's own machine decide the outcome: a
 * host that followed the install docs genuinely has the unit.
 */
export async function bootServiceInstalled(
  opts: { unitDir?: string } = {}
): Promise<BootServicePresence> {
  const os = process.platform;
  if (os === "linux") {
    const unitDir = opts.unitDir ?? userUnitDir(targetUserContext().home);
    return {
      installed: existsSync(join(unitDir, "pboss.service")),
      howToInstall: startupInstallHint(),
    };
  }
  if (os === "darwin") {
    const home = targetUserContext().home;
    return {
      installed: existsSync(join(home, "Library", "LaunchAgents", "com.pboss.daemon.plist")),
      howToInstall: startupInstallHint(),
    };
  }
  if (os === "win32") {
    try {
      const proc = Bun.spawn(["schtasks", "/query", "/tn", "PBOSS_Daemon"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      const installed = (await proc.exited) === 0;
      return {
        installed,
        howToInstall: startupInstallHint(),
      };
    } catch (err) {
      ignore("schtasks /query (boot presence check)", err);
      return { installed: false, howToInstall: startupInstallHint() };
    }
  }
  return { installed: false, howToInstall: startupInstallHint() };
}

/**
 * The one hint printed after the first process start, telling the user
 * where reboot persistence stands. PM2 makes users discover
 * `pm2 startup && pm2 save` the hard way; pboss states its default out
 * loud, once, at the moment it becomes relevant.
 */
export function persistenceHintLine(presence: BootServicePresence): string {
  return presence.installed
    ? "✓ Persistence on: this process is saved and will come back after reboot  (pboss startup status)"
    : "Reboot persistence is off — run:\n" +
        `    ${presence.howToInstall}\n` +
        "  to bring your processes back after a reboot  (pboss startup status)";
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
