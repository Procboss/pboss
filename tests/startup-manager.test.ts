import { describe, test, expect, afterEach } from "bun:test";
import { StartupManager } from "../src/startup-manager";

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
      expect(startup.install()).rejects.toThrow(/sudo env PATH="\$PATH" pboss startup/);
    }
  );

  test.skipIf(process.platform !== "linux" || typeof process.getuid === "function" && process.getuid() === 0)(
    "uninstall() as non-root throws with the sudo hint",
    async () => {
      const startup = new StartupManager();
      expect(startup.uninstall()).rejects.toThrow(/sudo env PATH="\$PATH" pboss startup remove/);
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
      expect(out).toContain('sudo env PATH="$PATH" pboss startup');
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

  test("win32 config mentions the simple install command", async () => {
    const startup = new StartupManager();
    const out = await startup.generate("win32");
    expect(out).toContain("PBOSS Windows Startup Configuration");
    expect(out).toContain("# pboss startup");
    expect(out).toContain("schtasks /create");
  });
});
