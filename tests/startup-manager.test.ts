import { describe, test, expect, afterEach } from "bun:test";
import { StartupManager, dumpBootSummary, bootServiceInstalled } from "../src/startup-manager";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox note: these tests run WITHOUT root privileges, which is exactly
// the point — the boot service is per-user, so a normal user account is
// all install()/uninstall() ever need. systemctl is PATH-shimmed so no
// real systemd is touched.

const SAVED_ENV: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    SAVED_ENV[k] ??= process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete SAVED_ENV[k];
  }
});

describe("StartupManager — the per-user privilege model (Linux)", () => {
  test.skipIf(process.platform !== "linux")(
    "install() needs NO root: writes the user unit and drives systemctl --user",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-user-install-"));
      const { dir, log } = installSystemctlShim();
      setEnv({
        HOME: home,
        SUDO_USER: undefined,
        PBOSS_HOME: undefined,
        PATH: `${dir}:${process.env.PATH}`,
      });
      try {
        const startup = new StartupManager();
        // Non-root used to throw "Root is required ... sudo env PATH=...".
        // The new contract: no privilege error anywhere — install()
        // completes for a normal user and only ever touches their own home.
        const msg = await startup.install({
          verifyTimeoutMs: 1_500,
          cliSocket: join(dir, "no-cli-daemon.sock"),
        });
        expect(msg).not.toContain("Root is required");

        // The unit landed under the invoking user's ~/.config/systemd/user.
        const unitPath = join(home, ".config", "systemd", "user", "pboss.service");
        expect(existsSync(unitPath)).toBe(true);
        const unit = readFileSync(unitPath, "utf-8");
        expect(unit).toContain("WantedBy=default.target");
        expect(unit).not.toMatch(/^User=/m); // user unit: runs as its owner

        // Every systemctl invocation addressed the USER manager.
        const calls = readFileSync(log, "utf-8")
          .split("\n")
          .filter((l) => l.trim() !== "");
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => c.startsWith("--user"))).toBe(true);

        // The manual fallback (shimmed daemon-reload failure, like a host
        // without a user systemd session) is sudo-free.
        expect(msg).toContain("systemctl --user daemon-reload");
        expect(msg).not.toContain("sudo");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform !== "linux")(
    "uninstall() needs NO root: removes the user unit via systemctl --user",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-user-uninstall-"));
      const { dir, log } = installSystemctlShim();
      const unitDir = join(home, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, "pboss.service"), "[Unit]\n");
      setEnv({
        HOME: home,
        SUDO_USER: undefined,
        PBOSS_HOME: undefined,
        PATH: `${dir}:${process.env.PATH}`,
      });
      try {
        const startup = new StartupManager();
        const msg = await startup.uninstall();
        expect(msg).toContain("PBOSS service removed");
        expect(existsSync(join(unitDir, "pboss.service"))).toBe(false);

        const calls = readFileSync(log, "utf-8")
          .split("\n")
          .filter((l) => l.trim() !== "");
        expect(calls).toContain("--user --no-block stop pboss");
        expect(calls).toContain("--user disable pboss");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

/**
 * A systemctl shim directory for the manager-level tests: every invocation
 * is logged; daemon-reload fails (a host without a user systemd session →
 * the deterministic manual-fallback path, no daemon ever started); the rest
 * succeed, with is-active reporting "inactive" so polling loops exit at
 * once. A leading `--user` is stripped so the case patterns match both
 * system and user invocations (only user ones are ever logged with it).
 */
function installSystemctlShim(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "pboss-mgr-shim-"));
  const log = join(dir, "systemctl.log");
  const systemctl = [
    "#!/bin/sh",
    `echo "$@" >> "${log}"`,
    'case "$1" in --user) shift ;; esac',
    'case "$*" in',
    '  "daemon-reload") exit 1 ;;',
    '  "is-active pboss") echo inactive; exit 3 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join("\n");
  writeFileSync(join(dir, "systemctl"), systemctl);
  chmodSync(join(dir, "systemctl"), 0o755);
  return { dir, log };
}

describe("StartupManager — SUDO_USER-aware generation", () => {
  test.skipIf(process.platform === "win32")(
    "linux unit targets the invoking user's home (SUDO_USER resolved from /etc/passwd)",
    async () => {
      setEnv({ SUDO_USER: process.env.USER! });
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      // A USER unit: no User= directive (it runs as its owner), enabled
      // via default.target, saved under the user's ~/.config/systemd/user.
      expect(out).not.toMatch(/^User=/m);
      expect(out).toContain(`Runs as user: ${process.env.USER}`);
      expect(out).toMatch(/Environment=PBOSS_HOME=\S+\/\.pboss/);
      expect(out).toMatch(/# Save to: \S+\/\.config\/systemd\/user\/pboss\.service/);
      expect(out).toContain("WantedBy=default.target");
      expect(out).toContain("systemctl --user daemon-reload");
      // The exact re-run hint is embedded in the header comment — sudo-free.
      expect(out).toContain("pboss startup install");
      expect(out).not.toContain("sudo");
    }
  );

  test.skipIf(process.platform === "win32")(
    "unknown SUDO_USER falls back to the current environment",
    async () => {
      setEnv({ SUDO_USER: "no-such-user-xyz" });
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      // Unresolvable sudo user → do not guess: use the invoking context.
      expect(out).not.toMatch(/^User=/m);
      expect(out).toContain(`Environment=PBOSS_HOME=${process.env.HOME}/.pboss`);
    }
  );

  test.skipIf(process.platform === "win32")(
    "SUDO_USER=root behaves like a real root shell (no special casing)",
    async () => {
      setEnv({ SUDO_USER: "root", USER: "root", HOME: "/root" });
      const startup = new StartupManager();
      const out = await startup.generate("linux");
      expect(out).not.toMatch(/^User=/m);
      expect(out).toContain("PBOSS_HOME=/root/.pboss");
    }
  );

  test.skipIf(process.platform !== "linux")(
    "macOS plist targets the SUDO_USER's LaunchAgents, not root's",
    async () => {
      const realHome = process.env.HOME!; // captured before HOME is overridden
      setEnv({ SUDO_USER: process.env.USER!, HOME: "/root" });
      const startup = new StartupManager();
      const out = await startup.generate("darwin");

      expect(out).toContain(`${realHome}/Library/LaunchAgents/com.pboss.daemon.plist`);
      expect(out).toContain(`${realHome}/.pboss/logs/daemon-out.log`);
      expect(out).not.toContain("/root/Library/LaunchAgents");
    }
  );
});

describe("StartupManager — generated unit shape", () => {
  test.skipIf(process.platform === "win32")("linux unit has absolute Exec commands", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("linux");

    expect(out).toContain("[Unit]");
    expect(out).toMatch(/ExecStart=\S/); // absolute path, not a bare command
    expect(out).toContain("ExecStartPost=");
    expect(out).toContain("ExecReload=");
    expect(out).toContain("ExecStop=");
    expect(out).toContain("Restart=on-failure");
  });

  test.skipIf(process.platform === "win32")(
    "linux unit waits for the ExecStart daemon and never restart-loops on conflict",
    async () => {
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      // ExecStartPost must WAIT for the unit's own daemon instead of
      // auto-spawning a competing one (the socket race that ended in
      // "Start request repeated too quickly").
      expect(out).toContain("resurrect --wait 10");
      // Exit 81 = another daemon owns the socket — restarting cannot fix
      // that; without this directive systemd restart-loops.
      expect(out).toContain("RestartPreventExitStatus=81");
    }
  );

  test.skipIf(process.platform === "win32")(
    "linux unit terminates instead of restart-looping forever",
    async () => {
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      // One FAILED start cycle takes >=10s (ExecStartPost polls for the
      // daemon), so systemd's DEFAULT rate-limit window (5 starts / 10s)
      // never fills — the unit would restart-loop forever and keep the
      // start job (and `systemctl start`, and `pboss startup install`)
      // hanging. The explicit window below always trips.
      expect(out).toContain("StartLimitIntervalSec=120");
      expect(out).toContain("StartLimitBurst=5");
      // A hung start (including ExecStartPost) must become a failure
      // systemd can act on, not a forever-activating unit.
      expect(out).toContain("TimeoutStartSec=20");
    }
  );

  test.skipIf(process.platform === "win32")(
    "linux unit marks ExecStartPost and ExecStop best-effort with the '-' prefix",
    async () => {
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      // systemd contract: a FAILED ExecStartPost aborts the unit's whole
      // start transaction — systemd kills the healthy ExecStart daemon and
      // restart-loops it. The '-' modifier makes systemd ignore the exit
      // status, so resurrect problems can never fail the unit start. Same
      // for ExecStop: a failing stop must not block systemd's
      // SIGTERM/SIGKILL fallback.
      expect(out).toMatch(/ExecStartPost=-\S/);
      expect(out).toMatch(/ExecStop=-\S/);
      // ExecStart itself stays honest — it IS the unit's health.
      expect(out).toMatch(/ExecStart=\S/);
      expect(out).not.toMatch(/ExecStart=-/);
    }
  );

  test("win32 config mentions the simple install command", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("win32");
    expect(out).toContain("PBOSS Windows Startup Configuration");
    expect(out).toContain("# pboss startup install");
    expect(out).toContain("schtasks /create");
    // The onlogon trigger must be restricted to THIS user's logon — the
    // daemon's state is per-user (%USERPROFILE%\.pboss).
    expect(out).toContain('/sc onlogon /ru "%USERNAME%"');
    // The documented PowerShell path must match what install() actually runs.
    expect(out).toContain("New-ScheduledTaskTrigger -AtLogOn -User");
    expect(out).toContain("Register-ScheduledTask");
  });
});

// ---------------------------------------------------------------------------
// macOS LaunchAgent template — valid XML, PBOSS_HOME parity, escaping
// ---------------------------------------------------------------------------

/**
 * Minimal XML well-formedness checker: balanced tags, attributes quoted,
 * single root, no raw & in text, no stray text outside the root. Written
 * here because the test runtime has no XML parser — this is exactly the
 * property launchd requires of the generated plist.
 */
function assertWellFormedXml(xml: string): void {
  const body = xml
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/^<!DOCTYPE[^>]*>\s*/, "");
  const tagRe = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)(\s*\/?\s*)>/g;
  const stack: string[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body)) !== null) {
    const text = body.slice(pos, m.index);
    if (stack.length === 0 && text.trim() !== "") {
      throw new Error(`text outside the root element: ${JSON.stringify(text.slice(0, 30))}`);
    }
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(text)) {
      throw new Error(`raw '&' in text content: ${JSON.stringify(text.slice(0, 30))}`);
    }
    const full = m[0];
    const closing = m[1] ?? "";
    const name = m[2] ?? "";
    const tail = m[4] ?? "";
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(`mismatched close </${name}> — open was <${open ?? "nothing"}>`);
      }
    } else if (!tail.trim().endsWith("/")) {
      stack.push(name);
    }
    pos = m.index + full.length;
  }
  const trailing = body.slice(pos);
  if (stack.length === 0 && trailing.trim() !== "") {
    throw new Error(`text after the root element: ${JSON.stringify(trailing.slice(0, 30))}`);
  }
  if (stack.length !== 0) {
    throw new Error(`unclosed elements: ${stack.join(", ")}`);
  }
}

/** Extract the raw plist XML (without the leading comment block). */
function extractPlist(generated: string): string {
  return generated.slice(generated.indexOf("<?xml"));
}

describe("StartupManager — macOS LaunchAgent template", () => {
  test("the plist is well-formed XML (validator self-check included)", () => {
    // The checker itself must catch broken XML, or the test below proves
    // nothing: unbalanced, raw & and stray text must all be rejected.
    expect(() => assertWellFormedXml("<a><b></a>")).toThrow(/mismatched|unclosed/);
    expect(() => assertWellFormedXml("<a>raw & ampersand</a>")).toThrow(/raw/);
    expect(() => assertWellFormedXml("junk<a></a>")).toThrow(/outside/);

    const startup = new StartupManager();
    return startup.generate("darwin").then((out) => {
      expect(() => assertWellFormedXml(extractPlist(out))).not.toThrow();
    });
  });

  test("plist stays well-formed when HOME contains XML-special characters", async () => {
    // Paths with & < > " ' are legal on POSIX and would corrupt an
    // unescaped plist — escapeXml must neutralize every one of them.
    const home = `${tmpdir()}/pb<weird&"home'`;
    setEnv({ HOME: home, SUDO_USER: undefined });
    const startup = new StartupManager();
    const out = await startup.generate("darwin");
    const plist = extractPlist(out);

    expect(() => assertWellFormedXml(plist)).not.toThrow();
    expect(plist).toContain("&lt;");
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&quot;");
    expect(plist).toContain("&apos;");
  });

  test("plist pins PATH, HOME and PBOSS_HOME (parity with the systemd unit)", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("darwin");
    const plist = extractPlist(out);

    expect(plist).toContain("<key>PBOSS_HOME</key>");
    expect(plist).toContain(`<string>${join(process.env.HOME ?? "/root", ".pboss")}</string>`);
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  test("ProgramArguments are absolute and the Label matches the file name", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("darwin");
    const plist = extractPlist(out);

    expect(plist).toContain("<string>com.pboss.daemon</string>");
    expect(out).toContain("com.pboss.daemon.plist");
    // First ProgramArguments entry is the executable — absolute or a
    // $bunfs path; never a bare command name.
    const args = plist.match(/<string>([^<]*)<\/string>/g) ?? [];
    const exec = args[1]?.replace(/<\/?string>/g, "") ?? "";
    expect(exec.startsWith("/") || exec.includes(":\\") || exec.includes("$bunfs")).toBe(true);
  });
});

describe("StartupManager — macOS install() prerequisites (launchd open() fix)", () => {
  // Runs the darwin branch of install() on Linux by faking the platform —
  // the same technique windows.test.ts uses for win32. launchctl does not
  // exist here, so the load step falls back to its honest "installed at"
  // message; what MUST happen regardless of launchctl is the plist write
  // and the ~/.pboss/logs mkdir (launchd opens StandardOut/StandardError
  // BEFORE starting the program — a missing directory meant the agent
  // silently refused to start with a cryptic permissions error).
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "install() creates the target user's ~/.pboss/logs before loading",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-darwin-install-"));
      setEnv({ HOME: home, SUDO_USER: undefined });
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      try {
        const startup = new StartupManager();
        const msg = await startup.install();

        const plistPath = join(home, "Library", "LaunchAgents", "com.pboss.daemon.plist");
        expect(existsSync(plistPath)).toBe(true);
        expect(existsSync(join(home, ".pboss", "logs"))).toBe(true);
        expect(msg).toContain("Plist installed at");
        expect(msg).toContain(plistPath);

        // The written plist is exactly the generated XML and it parses.
        const written = readFileSync(plistPath, "utf-8");
        expect(written.startsWith("<?xml")).toBe(true);
        expect(() => assertWellFormedXml(written)).not.toThrow();
        expect(written).toContain("<key>PBOSS_HOME</key>");
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
});

describe("StartupManager — the unit PATH carries the target user's bun (the runtime-discovery fix)", () => {
  test.skipIf(process.platform === "win32")(
    "linux unit PATH starts with the target user's ~/.bun/bin when it exists",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-unitpath-"));
      const bunBin = join(home, ".bun", "bin");
      mkdirSync(bunBin, { recursive: true });
      setEnv({ HOME: home, SUDO_USER: undefined });
      try {
        const startup = new StartupManager();
        const out = await startup.generate("linux");
        const pathLine = out.match(/Environment=PATH=(.+)/)?.[1] ?? "";
        expect(pathLine.startsWith(`${bunBin}:`)).toBe(true);
        // And the standard system dirs are still all there.
        for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) {
          expect(pathLine).toContain(dir);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "linux unit PATH omits ~/.bun/bin when the target user has none",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-unitpath-none-"));
      setEnv({ HOME: home, SUDO_USER: undefined });
      try {
        const startup = new StartupManager();
        const out = await startup.generate("linux");
        const pathLine = out.match(/Environment=PATH=(.+)/)?.[1] ?? "";
        expect(pathLine.startsWith("/usr/local/sbin")).toBe(true);
        // The TARGET user's .bun dir must not be added — but a script-mode
        // install may legitimately append the resolved system Bun's own dir
        // (on CI that is /home/runner/.bun/bin), so scope the assertion.
        expect(pathLine).not.toContain(join(home, ".bun"));
        for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) {
          expect(pathLine).toContain(dir);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "launchd plist PATH also carries the target user's ~/.bun/bin",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-plistpath-"));
      const bunBin = join(home, ".bun", "bin");
      mkdirSync(bunBin, { recursive: true });
      setEnv({ HOME: home, SUDO_USER: undefined });
      try {
        const startup = new StartupManager();
        const out = await startup.generate("darwin");
        const pathString = out.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
        expect(pathString.startsWith(`${bunBin}:`)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
});

describe("StartupManager.status() — the read-only boot-persistence report", () => {
  test.skipIf(process.platform !== "linux")(
    "not installed: honest report + exact install command + dump summary",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-status-no-"));
      const unitDir = mkdtempSync(join(tmpdir(), "pboss-status-units-no-"));
      // PBOSS_HOME must be unset: status() prefers an explicit env override,
      // and another test file's module-top may have set it (shared process).
      setEnv({ HOME: home, SUDO_USER: undefined, PBOSS_HOME: undefined });
      try {
        // Empty unitDir fixture: "not installed" by CONSTRUCTION, never by
        // host state. The old version consulted the real /etc/systemd/system
        // and failed on any machine that had actually run
        // `pboss startup install` (the docs' own setup instruction) — green
        // in CI, red on the developer's box.
        const startup = new StartupManager();
        const report = await startup.status({ unitDir });
        expect(report).toContain("Boot startup service (systemd, per-user)");
        expect(report).toContain("Installed:  no");
        expect(report).toContain("pboss startup install");
        expect(report).not.toContain("sudo");
        expect(report).toContain("Reboot persistence:");
        expect(report).toContain("nothing to restore yet");
        // The dump path is the TARGET user's, not root's.
        expect(report).toContain(join(home, ".pboss", "dump.json"));
        expect(report).toContain("not answering");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(unitDir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform !== "linux")(
    "installed + enabled + saved dump: full report with restore counts",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-status-yes-"));
      const unitDir = mkdtempSync(join(tmpdir(), "pboss-status-units-"));
      setEnv({ HOME: home, SUDO_USER: undefined, PBOSS_HOME: undefined });
      try {
        // Unit file + enablement symlink, exactly where systemd puts them
        // for user units (default.target, not multi-user.target — the user
        // manager has no multi-user.target).
        mkdirSync(join(unitDir, "default.target.wants"), { recursive: true });
        writeFileSync(join(unitDir, "pboss.service"), "[Unit]\n");
        writeFileSync(
          join(unitDir, "default.target.wants", "pboss.service"),
          "symlink-ish\n"
        );
        // Dump: 2 running + 1 stopped.
        mkdirSync(join(home, ".pboss"), { recursive: true });
        writeFileSync(
          join(home, ".pboss", "dump.json"),
          JSON.stringify([{ stopped: false }, { stopped: false }, { stopped: true }])
        );

        const startup = new StartupManager();
        const report = await startup.status({ unitDir });
        expect(report).toContain("Installed:  yes");
        expect(report).toContain("Enabled:    yes — starts with your session (default.target)");
        expect(report).toContain("2 process(es) come back running");
        expect(report).toContain("1 stopped");
        expect(report).not.toContain("sudo");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(unitDir, { recursive: true, force: true });
      }
    }
  );

  test("dumpBootSummary counts running vs stopped and tolerates junk", () => {
    const pbossHome = mkdtempSync(join(tmpdir(), "pboss-dumpsum-"));
    try {
      // No dump → null.
      expect(dumpBootSummary(pbossHome)).toBeNull();

      // The argument is the pboss home (the dir that CONTAINS dump.json).
      writeFileSync(
        join(pbossHome, "dump.json"),
        JSON.stringify([{ stopped: true }, { stopped: false }, {}, null, "junk"])
      );
      const summary = dumpBootSummary(pbossHome)!;
      expect(summary.total).toBe(5);
      // stopped:true counts stopped; false/missing/non-objects count running.
      expect(summary.stopped).toBe(1);
      expect(summary.running).toBe(4);

      // Corrupt JSON → null, never a throw.
      writeFileSync(join(pbossHome, "dump.json"), "{broken");
      expect(dumpBootSummary(pbossHome)).toBeNull();
    } finally {
      rmSync(pbossHome, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "linux")( // hermetic: runs as any uid
    "bootServiceInstalled() without the unit: false + sudo install command",
    async () => {
      // An empty fixture unitDir STANDS IN for "a host without the unit".
      // The old version asserted the real /etc/systemd/system had no
      // pboss.service — true in CI and sandboxes, false on any machine that
      // followed the install docs, which is exactly the reported failure.
      const unitDir = mkdtempSync(join(tmpdir(), "pboss-boot-none-"));
      try {
        const presence = await bootServiceInstalled({ unitDir });
        expect(presence.installed).toBe(false);
        expect(presence.howToInstall).toContain("pboss startup install");
      } finally {
        rmSync(unitDir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform !== "linux")( // hermetic: runs as any uid
    "bootServiceInstalled() with the unit present: true",
    async () => {
      // The developer-machine state after `pboss startup install`: the unit
      // file exists, so presence flips to true (status() then reports
      // "Installed:  yes" — the other test in this block pins that branch).
      const unitDir = mkdtempSync(join(tmpdir(), "pboss-boot-yes-"));
      try {
        writeFileSync(join(unitDir, "pboss.service"), "[Unit]\n");
        const presence = await bootServiceInstalled({ unitDir });
        expect(presence.installed).toBe(true);
      } finally {
        rmSync(unitDir, { recursive: true, force: true });
      }
    }
  );
});
