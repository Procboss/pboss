/**
 * `pboss startup` option dispatch — integration tests (real CLI subprocess).
 *
 * The owner's contract:
 *   - `pboss startup install`   installs the boot service
 *   - `pboss startup uninstall` removes it (`remove` stays an alias)
 *   - bare `pboss startup`      does NOTHING except tell the user to pick
 *                               install or uninstall
 *   - anything else             "Unknown startup option" + the same guidance
 *
 * Each case spawns the actual CLI (`bun run src/index.ts …`) exactly like
 * daemon-startup.test.ts, so the parsing, the help text and the exit codes
 * are all exercised end-to-end.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function spawnCli(args: string[], envOverrides: Record<string, string> = {}) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, ...envOverrides },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
}

async function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const proc = spawnCli(args, envOverrides);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  const code = await proc.exited;
  return { out, err, code };
}

/** Read all of a pipe without blocking the test on a dead process. */
async function drain(p: {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}) {
  const [out, err] = await Promise.all([
    new Response(p.stdout).text().catch(() => ""),
    new Response(p.stderr).text().catch(() => ""),
  ]);
  const code = await p.exited;
  return { out, err, code };
}

const NON_ROOT =
  typeof process.getuid === "function" && process.getuid() !== 0 && process.platform === "linux";

describe("pboss startup — option dispatch", () => {
  test.skipIf(!NON_ROOT)(
    "bare `pboss startup` prints the options and installs NOTHING",
    async () => {
      const { out, err, code } = await runCli(["startup"]);

      // Guidance, not action.
      expect(code).toBe(0);
      expect(out).toContain("Usage: pboss startup <install | uninstall | status>");
      expect(out).toContain("install");
      expect(out).toContain("uninstall");
      expect(out).toContain("does nothing");

      // Proof it did not fall through to install(): non-root Linux would
      // print the sudo error and exit 1.
      expect(err).toBe("");
      expect(out).not.toContain("Root is required");
    }
  );

  test.skipIf(!NON_ROOT)(
    "`pboss startup install` reaches the installer (non-root → exact sudo re-run hint)",
    async () => {
      const { err, code } = await runCli(["startup", "install"]);
      expect(code).toBe(1);
      expect(err).toContain("Root is required");
      expect(err).toContain('sudo env PATH="$PATH" pboss startup install');
    }
  );

  test.skipIf(!NON_ROOT)(
    "`pboss startup uninstall` reaches the uninstaller with its own hint",
    async () => {
      const { err, code } = await runCli(["startup", "uninstall"]);
      expect(code).toBe(1);
      expect(err).toContain("Root is required to remove the system service");
      expect(err).toContain('sudo env PATH="$PATH" pboss startup uninstall');
    }
  );

  test.skipIf(!NON_ROOT)(
    "`pboss startup remove` remains an alias of uninstall",
    async () => {
      const { err, code } = await runCli(["startup", "remove"]);
      expect(code).toBe(1);
      expect(err).toContain("Root is required to remove the system service");
    }
  );

  test("unknown option: says so, shows the guidance, exits 1", async () => {
    const { out, err, code } = await runCli(["startup", "definitely-not-a-thing"]);
    expect(code).toBe(1);
    expect(err).toContain('Unknown startup option: "definitely-not-a-thing"');
    expect(out).toContain("Usage: pboss startup <install | uninstall | status>");
    expect(out).toContain("uninstall");
  });

  test.skipIf(process.platform !== "linux")(
    "`pboss startup generate` still prints the config without installing",
    async () => {
      const { out, code } = await runCli(["startup", "generate"]);
      expect(code).toBe(0);
      expect(out).toContain("[Unit]");
      expect(out).toContain("ExecStart=");
    }
  );

  test("`pboss startup generate win32` cross-generates", async () => {
    const { out, code } = await runCli(["startup", "generate", "win32"]);
    expect(code).toBe(0);
    expect(out).toContain("PBOSS Windows Startup Configuration");
    expect(out).toContain("pboss startup install");
  });

  test("`pboss startup macos` legacy platform form still generates", async () => {
    const { out, code } = await runCli(["startup", "macos"]);
    expect(code).toBe(0);
    expect(out).toContain("PBOSS LaunchAgent (macOS)");
    expect(out).toContain("<plist version=\"1.0\">");
  });

  test("`pboss --help` documents the new subcommands", async () => {
    const { out, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("startup install");
    expect(out).toContain("startup uninstall");
    expect(out).toContain("startup status");
    expect(out).toContain("startup generate [os]");
  });

  test("`pboss startup status` reports boot-persistence state read-only", async () => {
    // Hermetic HOME so the dump path and daemon socket are the test's, not
    // the developer's real ~/.pboss. No daemon is started: status must be
    // read-only and report "not answering" honestly.
    const home = mkdtempSync(join(tmpdir(), "pboss-status-"));
    try {
      const proc = spawnCli(["startup", "status"], {
        HOME: home,
        PBOSS_HOME: join(home, ".pboss"),
      });
      const { out, err, code } = await drain(proc);
      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain("Boot startup service");
      expect(out).toContain("Installed:");
      expect(out).toContain("Reboot persistence:");
      expect(out).toContain("nothing to restore yet");
      // Read-only proof: no daemon socket was created by merely asking.
      expect(existsSync(join(home, ".pboss", "daemon.sock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
