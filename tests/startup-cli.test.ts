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
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
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

/**
 * systemctl shim for CLI subprocesses: logs every invocation, daemon-reload
 * fails (exactly like a host without a user systemd session → the
 * deterministic manual-fallback path; no daemon is ever started), the rest
 * succeed with is-active "inactive". A leading `--user` is stripped before
 * matching, so both system- and user-form invocations hit the same cases
 * (the log still records the original, full argument list).
 */
function makeSystemctlShim(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "pboss-cli-shim-"));
  const log = join(dir, "systemctl.log");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> "${log}"`,
    'case "$1" in --user) shift ;; esac',
    'case "$*" in',
    '  "daemon-reload") exit 1 ;;',
    '  "is-active pboss") echo inactive; exit 3 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join("\n");
  writeFileSync(join(dir, "systemctl"), script);
  chmodSync(join(dir, "systemctl"), 0o755);
  return { dir, log };
}

/** Hermetic env for a CLI run: everything lands under a temp HOME. */
function hermeticEnv(home: string, shimDir: string): Record<string, string> {
  return {
    HOME: home,
    PBOSS_HOME: join(home, ".pboss"),
    SUDO_USER: "", // never set: the legacy sudo flow must not engage
    PATH: `${shimDir}:${process.env.PATH}`,
  };
}

describe("pboss startup — option dispatch", () => {
  test.skipIf(process.platform !== "linux")(
    "bare `pboss startup` prints the options and installs NOTHING",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-cli-bare-"));
      const { dir } = makeSystemctlShim();
      try {
        const { out, err, code } = await runCli(["startup"], hermeticEnv(home, dir));

        // Guidance, not action.
        expect(code).toBe(0);
        expect(out).toContain("Usage: pboss startup <install | uninstall | status>");
        expect(out).toContain("install");
        expect(out).toContain("uninstall");
        expect(out).toContain("does nothing");

        // Proof it did not fall through to install(): the user unit was
        // never written (install as a normal user now SUCCEEDS, so the
        // missing file is the real proof — the old "Root is required"
        // error no longer exists to lean on).
        expect(err).toBe("");
        expect(existsSync(join(home, ".config", "systemd", "user", "pboss.service"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform !== "linux")(
    "`pboss startup install` works as a normal user (no root, no sudo)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-cli-install-"));
      const { dir, log } = makeSystemctlShim();
      try {
        const { out, err, code } = await runCli(["startup", "install"], hermeticEnv(home, dir));

        // Completes successfully for a normal user — no privilege error.
        expect(code).toBe(0);
        expect(err).not.toContain("Root is required");
        expect(err).toBe("");

        // The per-user unit landed under the invoking user's HOME...
        const unitPath = join(home, ".config", "systemd", "user", "pboss.service");
        expect(existsSync(unitPath)).toBe(true);
        expect(readFileSync(unitPath, "utf-8")).toContain("WantedBy=default.target");

        // ...only the USER manager was addressed...
        const calls = readFileSync(log, "utf-8")
          .split("\n")
          .filter((l) => l.trim() !== "");
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => c.startsWith("--user"))).toBe(true);

        // ...and the printed instructions are sudo-free.
        expect(out).toContain("systemctl --user daemon-reload");
        expect(out).not.toContain("sudo");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  test.skipIf(process.platform !== "linux")(
    "`pboss startup uninstall` removes the per-user unit without root",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-cli-uninstall-"));
      const { dir } = makeSystemctlShim();
      const unitDir = join(home, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, "pboss.service"), "[Unit]\n");
      try {
        const { out, err, code } = await runCli(["startup", "uninstall"], hermeticEnv(home, dir));
        expect(code).toBe(0);
        expect(err).not.toContain("Root is required");
        expect(out).toContain("PBOSS service removed");
        expect(existsSync(join(unitDir, "pboss.service"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform !== "linux")(
    "`pboss startup remove` remains an alias of uninstall",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-cli-remove-"));
      const { dir } = makeSystemctlShim();
      const unitDir = join(home, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, "pboss.service"), "[Unit]\n");
      try {
        const { out, err, code } = await runCli(["startup", "remove"], hermeticEnv(home, dir));
        expect(code).toBe(0);
        expect(err).not.toContain("Root is required");
        expect(out).toContain("PBOSS service removed");
        expect(existsSync(join(unitDir, "pboss.service"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
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
