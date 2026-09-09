import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, statSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * ~/.pboss permission contract — the pm2 /tmp/.pm2 lesson, applied: the
 * directory that holds the daemon's Unix socket (and cloud.json, the
 * machine credential) must be owner-only. Any local user who can REACH
 * the socket can command the daemon.
 *
 * Both paths are covered:
 *   - fresh install: ensureDirs creates ~/.pboss 0700 from the start
 *   - pre-0700-rule install: tightenPbossHomeMode self-heals an existing
 *     permissive directory at daemon boot
 *
 * Runs in a subprocess because PBOSS_HOME is resolved at module import.
 */

const ROOT = "/home/z/my-project/pboss";

function runInSubprocess(home: string, code: string): Promise<number> {
  const proc = Bun.spawn(["bun", "-e", code], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  return proc.exited;
}

describe("~/.pboss is owner-only (0700) — daemon socket + credential dir", () => {
  test("fresh install: ensureDirs creates the home tree 0700", async () => {
    const home = join(tmpdir(), `pboss-fresh-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const code = await runInSubprocess(
      home,
      `import { ensureDirs } from "${ROOT}/src/utils"; await ensureDirs();`
    );
    expect(code).toBe(0);
    if (process.platform !== "win32") {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      // subdirs inherit the owner-only posture
      expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
    }
    rmSync(home, { recursive: true, force: true });
  }, 20_000);

  test("pre-rule install: tightenPbossHomeMode heals an existing 0755 home", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-loose-home-"));
    if (process.platform === "win32") {
      rmSync(home, { recursive: true, force: true });
      return; // POSIX mode semantics — nothing to assert on Windows
    }
    // simulate an ~/.pboss created before the 0700 rule (mkdir default 0755)
    chmodSync(home, 0o755);
    const code = await runInSubprocess(
      home,
      `import { ensureDirs, tightenPbossHomeMode } from "${ROOT}/src/utils"; await ensureDirs(); tightenPbossHomeMode();`
    );
    expect(code).toBe(0);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    rmSync(home, { recursive: true, force: true });
  }, 20_000);

  test("the cloud credential is written 0600 inside the 0700 home", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-credmode-"));
    if (process.platform === "win32") {
      rmSync(home, { recursive: true, force: true });
      return;
    }
    chmodSync(home, 0o755); // even a loose pre-existing home
    const code = await runInSubprocess(
      home,
      `import { saveCloudConfig } from "${ROOT}/src/cloud"; saveCloudConfig({ cloudUrl: "https://procboss.com", serverId: "srv_x", serverSecret: "pbs_y" });`
    );
    expect(code).toBe(0);
    expect(statSync(join(home, "cloud.json")).mode & 0o777).toBe(0o600);
    rmSync(home, { recursive: true, force: true });
  }, 20_000);
});

// keep mkdirSync referenced for future dir-setup needs without tripping lint
void mkdirSync;
