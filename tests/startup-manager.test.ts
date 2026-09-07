import { describe, test, expect, afterEach } from "bun:test";
import { StartupManager } from "../src/startup-manager";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox note: these tests run as a NON-root user on Linux, which is exactly
// the privilege context that must produce the helpful sudo retry hint.

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

describe("StartupManager — privilege checks (Linux)", () => {
  test.skipIf(process.platform !== "linux" || typeof process.getuid === "function" && process.getuid() === 0)(
    "install() as non-root throws with the PATH-preserving sudo hint",
    async () => {
      const startup = new StartupManager();
      expect(startup.install()).rejects.toThrow(/sudo env PATH="\$PATH" pboss startup install/);
    }
  );

  test.skipIf(process.platform !== "linux" || typeof process.getuid === "function" && process.getuid() === 0)(
    "uninstall() as non-root throws with the sudo hint",
    async () => {
      const startup = new StartupManager();
      expect(startup.uninstall()).rejects.toThrow(/sudo env PATH="\$PATH" pboss startup uninstall/);
    }
  );
});

describe("StartupManager — SUDO_USER-aware generation", () => {
  test.skipIf(process.platform === "win32")(
    "linux unit runs as the invoking user (SUDO_USER resolved from /etc/passwd)",
    async () => {
      setEnv({ SUDO_USER: process.env.USER! });
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      expect(out).toContain(`User=${process.env.USER}`);
      expect(out).toContain(`PBOSS_HOME=${process.env.HOME}/.pboss`);
      expect(out).toContain(`Runs as user: ${process.env.USER}`);
      // The exact re-run hint is embedded in the header comment.
      expect(out).toContain('sudo env PATH="$PATH" pboss startup install');
    }
  );

  test.skipIf(process.platform === "win32")(
    "unknown SUDO_USER falls back to the current environment",
    async () => {
      setEnv({ SUDO_USER: "no-such-user-xyz" });
      const startup = new StartupManager();
      const out = await startup.generate("linux");

      // Unresolvable sudo user → do not guess: use the invoking context.
      expect(out).toContain(`User=${process.env.USER || "root"}`);
      expect(out).toContain("PBOSS_HOME=");
    }
  );

  test.skipIf(process.platform === "win32")(
    "SUDO_USER=root behaves like a real root shell (no special casing)",
    async () => {
      setEnv({ SUDO_USER: "root", USER: "root", HOME: "/root" });
      const startup = new StartupManager();
      const out = await startup.generate("linux");
      expect(out).toContain("User=root");
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
      expect(out).toContain("resurrect --wait 30");
      // Exit 81 = another daemon owns the socket — restarting cannot fix
      // that; without this directive systemd restart-loops.
      expect(out).toContain("RestartPreventExitStatus=81");
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
