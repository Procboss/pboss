import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readChannelStamp,
  writeChannelStamp,
  parseUserAgent,
  detectChannel,
  buildUpgradePlan,
  compareVersions,
  fetchLatestVersion,
  runUpgradePlan,
  type ChannelContext,
} from "../src/upgrade";

/**
 * `pboss upgrade` exists to keep ONE pboss per machine: the channel that
 * installed the CLI must also upgrade it. The contract under test:
 *   1. A channel stamp (written by install.sh / install.ps1 / postinstall /
 *      brew) is authoritative.
 *   2. Without a stamp, the executable's own location tells the truth.
 *   3. Every channel upgrades THROUGH ITSELF (npm→npm, universal→curl|bash,
 *      brew→brew, snap→snap refresh) — no cross-channel jumps.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pboss-upgrade-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function ctx(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    stamp: null,
    execPath: "/usr/local/bin/bun",
    isCompiled: false,
    moduleDir: "/home/alice/dev/pboss/src",
    platform: "linux",
    ...overrides,
  };
}

describe("channel stamp persistence", () => {
  test("round-trips through ~/.pboss/channel.json", () => {
    const file = join(home, "channel.json");
    writeChannelStamp({ channel: "universal", by: "install.sh" }, file);
    const stamp = readChannelStamp(file);
    expect(stamp?.channel).toBe("universal");
    expect(stamp?.by).toBe("install.sh");
  });

  test("missing or corrupt stamp reads as null, never throws", () => {
    expect(readChannelStamp(join(home, "nope.json"))).toBeNull();
    const file = join(home, "channel.json");
    writeFileSync(file, "{not json");
    expect(readChannelStamp(file)).toBeNull();
    writeFileSync(file, '{"nope": 1}');
    expect(readChannelStamp(file)).toBeNull();
  });

  test("writeChannelStamp creates the .pboss directory on demand", () => {
    const file = join(home, "nested", ".pboss", "channel.json");
    writeChannelStamp({ channel: "npm", pm: "bun" }, file);
    expect(readChannelStamp(file)?.channel).toBe("npm");
  });
});

describe("parseUserAgent: which package manager owns the install", () => {
  test("npm / bun / pnpm / yarn heads map to their PM", () => {
    expect(parseUserAgent("npm/10.8.2 node/v20.5.1 linux x64")).toBe("npm");
    expect(parseUserAgent("bun/1.1.30 linux x64")).toBe("bun");
    expect(parseUserAgent("pnpm/9.1.0 npm/? node/v20")).toBe("pnpm");
    expect(parseUserAgent("yarn/4.2.0 npm/? node/v20")).toBe("yarn");
  });
  test("missing user agent defaults to npm", () => {
    expect(parseUserAgent(undefined)).toBe("npm");
    expect(parseUserAgent("")).toBe("npm");
  });
});

describe("detectChannel: the stamp wins", () => {
  test("each installer's stamp is authoritative", () => {
    expect(detectChannel(ctx({ stamp: { channel: "universal" } }))).toBe("universal");
    expect(detectChannel(ctx({ stamp: { channel: "npm" } }))).toBe("npm");
    expect(detectChannel(ctx({ stamp: { channel: "brew" } }))).toBe("brew");
    expect(detectChannel(ctx({ stamp: { channel: "snap" } }))).toBe("snap");
  });

  test("npm stamp with pm bun resolves to the bun channel", () => {
    expect(detectChannel(ctx({ stamp: { channel: "npm", pm: "bun" } }))).toBe("bun");
    expect(detectChannel(ctx({ stamp: { channel: "npm", pm: "npm" } }))).toBe("npm");
  });
});

describe("detectChannel: runtime heuristics (stamp-less machines)", () => {
  test("compiled binary at /usr/local/bin/pboss → universal", () => {
    expect(
      detectChannel(
        ctx({ execPath: "/usr/local/bin/pboss", isCompiled: true, moduleDir: "/usr/local/bin" })
      )
    ).toBe("universal");
  });

  test("compiled exe under Program Files → universal (windows)", () => {
    expect(
      detectChannel(
        ctx({
          execPath: "C:\\Program Files\\pboss\\pboss.exe",
          isCompiled: true,
          moduleDir: "C:\\Program Files\\pboss",
          platform: "win32",
        })
      )
    ).toBe("universal");
  });

  test("snap location → snap (classic confinement path)", () => {
    expect(
      detectChannel(
        ctx({ execPath: "/snap/pboss/x1/pboss", isCompiled: true, moduleDir: "/snap/pboss/x1" })
      )
    ).toBe("snap");
  });

  test("homebrew Cellar path → brew (arm + intel + linuxbrew layouts)", () => {
    for (const exec of [
      "/opt/homebrew/Cellar/pboss/1.2.0/bin/pboss",
      "/usr/local/Cellar/pboss/1.2.0/bin/pboss",
      "/home/linuxbrew/.linuxbrew/Cellar/pboss/1.2.0/bin/pboss",
    ]) {
      expect(detectChannel(ctx({ execPath: exec, isCompiled: true, moduleDir: exec }))).toBe("brew");
    }
  });

  test("bun global node_modules → bun channel", () => {
    expect(
      detectChannel(
        ctx({
          execPath: "/home/alice/.bun/bin/bun",
          moduleDir: "/home/alice/.bun/install/global/node_modules/pboss/src",
        })
      )
    ).toBe("bun");
  });

  test("npm global node_modules → npm channel", () => {
    expect(
      detectChannel(
        ctx({
          execPath: "/usr/bin/node",
          moduleDir: "/usr/lib/node_modules/pboss/src",
        })
      )
    ).toBe("npm");
  });

  test("repo checkout run through bun → source", () => {
    expect(
      detectChannel(ctx({ execPath: "/home/alice/.bun/bin/bun", moduleDir: "/home/alice/dev/pboss/src" }))
    ).toBe("source");
  });

  test("a compiled binary in a weird place is honestly 'unknown'", () => {
    expect(
      detectChannel(ctx({ execPath: "/opt/mystery/pboss", isCompiled: true, moduleDir: "/opt/mystery" }))
    ).toBe("unknown");
  });
});

describe("buildUpgradePlan: each channel upgrades through itself", () => {
  test("npm → npm install -g pboss@latest (no curl, no brew)", () => {
    const plan = buildUpgradePlan("npm");
    expect(plan.command).toEqual(["npm", "install", "-g", "pboss@latest"]);
    expect(plan.manual).toBe(false);
  });

  test("bun → bun add -g pboss@latest", () => {
    const plan = buildUpgradePlan("bun");
    expect(plan.command).toEqual(["bun", "add", "-g", "pboss@latest"]);
  });

  test("brew → brew upgrade pboss", () => {
    const plan = buildUpgradePlan("brew");
    expect(plan.command).toEqual(["brew", "upgrade", "pboss"]);
  });

  test("snap → sudo snap refresh pboss", () => {
    const plan = buildUpgradePlan("snap");
    expect(plan.command).toEqual(["sudo", "snap", "refresh", "pboss"]);
  });

  test("universal on linux/macOS → the curl|sudo bash installer", () => {
    const plan = buildUpgradePlan("universal", "linux");
    expect(plan.command[0]).toBe("bash");
    expect(plan.command[2]).toContain("https://procboss.com/install.sh");
    expect(plan.command[2]).toContain("sudo bash");
    // The plan must NOT install through a package manager.
    expect(plan.command.join(" ")).not.toContain("npm");
  });

  test("universal on windows → the elevated powershell installer", () => {
    const plan = buildUpgradePlan("universal", "win32");
    expect(plan.command[0]).toBe("powershell");
    expect(plan.command.at(-1)).toContain("https://procboss.com/install.ps1");
  });

  test("source and unknown are honest manual plans", () => {
    expect(buildUpgradePlan("source").manual).toBe(true);
    expect(buildUpgradePlan("source").note).toContain("git");
    const unknown = buildUpgradePlan("unknown");
    expect(unknown.manual).toBe(true);
    expect(unknown.command).toEqual([]);
    expect(unknown.note).toContain("refuses to guess");
  });
});

describe("compareVersions", () => {
  test("orders semver correctly, tolerant of the v prefix", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("v1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0); // numeric, not lexicographic
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0); // missing parts are 0
  });
});

describe("fetchLatestVersion (injectable fetcher)", () => {
  test("reads the version field from the registry payload", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ version: "1.4.0" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion(fake, "https://example.test/latest")).toBe("1.4.0");
  });

  test("non-200 or network failure resolves null (never throws)", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion(failing, "https://example.test/latest")).toBeNull();
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion(throwing, "https://example.test/latest")).toBeNull();
  });
});

describe("runUpgradePlan (injectable spawner)", () => {
  test("success only when the channel command exits 0", async () => {
    const ran: string[][] = [];
    const ok = await runUpgradePlan(buildUpgradePlan("npm"), async (cmd) => {
      ran.push(cmd);
      return 0;
    });
    expect(ok).toBe(true);
    expect(ran[0]).toEqual(["npm", "install", "-g", "pboss@latest"]);
    const bad = await runUpgradePlan(buildUpgradePlan("npm"), async () => 1);
    expect(bad).toBe(false);
  });
});

describe("CLI surface", () => {
  test("`pboss --help` advertises the upgrade command and its channel rule", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("upgrade");
    expect(out).toContain("--check");
    expect(out).toContain("never spawns a second CLI");
  });

  test("`pboss upgrade --check` reports the channel and exits without upgrading", async () => {
    // The dev checkout is a "source" install — --check must say so, print
    // the plan, and exit 0 without running git.
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "upgrade", "--check"],
      {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PBOSS_HOME: join(home, ".pboss") },
      }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("pboss upgrade");
    expect(out).toContain("source");
    // Latest version comes from the real npm registry; both up-to-date and
    // behind are acceptable --check outcomes, but a channel line must exist.
    expect(out).toMatch(/Installed via:\s+source checkout/);
  });

  test("`pboss upgrade --channel bogus` rejects unknown channels with exit 1", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "upgrade", "--channel", "bogus"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PBOSS_HOME: join(home, ".pboss") },
    });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(1);
    expect(err).toContain('Unknown channel "bogus"');
  });
});
