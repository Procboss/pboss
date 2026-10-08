/**
 * Deno permissions — the first RUNTIME-UNIQUE feature (owner request,
 * 2026-10-06): `--permissions "allow-read,…"` / `permissions: [...]`,
 * translated to real deno flags at the command-build choke point and
 * IGNORED under bun/node ("support individual runtime unique features,
 * ignored if the other runtimes don't support it").
 *
 * Three layers, each pinned here:
 *
 *   1. PURE LOGIC (src/deno-permissions.ts) — normalization + the merge
 *      against what the user already stated. The rules encode VERIFIED
 *      deno 2.9.7 behavior:
 *        - `-A` + any `--allow-*` is a hard deno ERROR ("--allow-all
 *          conflicts with --allow-write") in BOTH orders — the merge must
 *          never produce that combination in either direction.
 *        - `-A --deny-write` is VALID (deny takes precedence over allow).
 *        - Two same-stem flags are NOT a union (a repeat replaces) — so
 *          duplicates are never emitted and a user's scoping never
 *          overridden: "check if permissions are also provided in
 *          interpreter-args and not duplicate it".
 *
 *   2. COMMAND ASSEMBLY (ClusterManager.buildWorkerCommand) — explicit
 *      interpreter cases are deterministic on every host; the resolved-route
 *      `-A` strip is covered by the pure merge tests.
 *
 *   3. E2E — the REAL CLI on a hermetic PBOSS_HOME with the REAL deno on
 *      PATH (skips visibly on deno-less machines — the false-green lesson
 *      from the 1.6.0 wrapper-farm incident): a permission list actually
 *      GRANTS what it says, a missing grant actually DENIES, a deny entry
 *      layered on a user-stated `-A` actually blocks, and `describe`
 *      reports the list.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  normalizeDenoPermissions,
  mergeDenoPermissions,
  DENO_PERMISSION_CATEGORIES,
} from "../src/deno-permissions";
import { ClusterManager } from "../src/cluster-manager";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "src", "index.ts");

// The default user install (~/.deno/bin) is not always on the test
// process's PATH — resolve it the way pboss's own finder would.
const denoBin =
  Bun.which("deno") ??
  (existsSync(join(process.env.HOME || "", ".deno", "bin", "deno"))
    ? join(process.env.HOME || "", ".deno", "bin", "deno")
    : null);
const canDeno = !!denoBin;

// ---------------------------------------------------------------------------
// 1. Pure logic — normalizeDenoPermissions
// ---------------------------------------------------------------------------

describe("deno permissions — normalizeDenoPermissions", () => {
  test("plain allow/deny entries become flags", () => {
    expect(normalizeDenoPermissions(["allow-read"])).toEqual(["--allow-read"]);
    expect(normalizeDenoPermissions(["deny-write"])).toEqual(["--deny-write"]);
  });

  test("entries keep their value verbatim, category matches case-insensitively", () => {
    expect(normalizeDenoPermissions(["allow-net=api.example.com:443"])).toEqual([
      "--allow-net=api.example.com:443",
    ]);
    expect(normalizeDenoPermissions(["ALLOW-READ"])).toEqual(["--allow-read"]);
    expect(normalizeDenoPermissions(["--allow-env=FOO,bar"])).toEqual(["--allow-env=FOO,bar"]);
  });

  test('"all" spellings normalize to deno\'s short -A', () => {
    expect(normalizeDenoPermissions(["all"])).toEqual(["-A"]);
    expect(normalizeDenoPermissions(["-A"])).toEqual(["-A"]);
    expect(normalizeDenoPermissions(["A"])).toEqual(["-A"]);
    expect(normalizeDenoPermissions(["--allow-all"])).toEqual(["-A"]);
  });

  test('"all" subsumes allow-* (they would conflict in deno) but keeps deny-*', () => {
    expect(normalizeDenoPermissions(["allow-read", "all", "deny-write"])).toEqual([
      "--deny-write",
      "-A",
    ]);
  });

  test('"none" dominates the whole list — the zero-permission escape hatch', () => {
    expect(normalizeDenoPermissions(["allow-read", "none"])).toEqual([]);
    expect(normalizeDenoPermissions(["none", "deny-write"])).toEqual([]);
  });

  test("same stem twice: the LAST occurrence replaces (never unions)", () => {
    expect(normalizeDenoPermissions(["allow-read=/a", "allow-read=/b"])).toEqual([
      "--allow-read=/b",
    ]);
  });

  test("exact duplicates and empty entries are dropped", () => {
    expect(normalizeDenoPermissions(["allow-read", "allow-read", "", "  "])).toEqual([
      "--allow-read",
    ]);
  });

  test("garbage entries throw with the categories listed", () => {
    expect(() => normalizeDenoPermissions(["foo"])).toThrow(/Invalid deno permission "foo"/);
    expect(() => normalizeDenoPermissions(["allow-writ"])).toThrow(/unknown category "writ"/);
    expect(() => normalizeDenoPermissions(["allow-writ"])).toThrow(
      new RegExp(DENO_PERMISSION_CATEGORIES.join(", "))
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Pure logic — mergeDenoPermissions
// ---------------------------------------------------------------------------

describe("deno permissions — mergeDenoPermissions", () => {
  test("RUNTIME-UNIQUE: non-deno prefixes come back unchanged (ignored, not an error)", () => {
    const nodePrefix = ["node", "--max-old-space-size=4096"];
    expect(mergeDenoPermissions(nodePrefix, ["allow-read"], { defaultAllEnd: 0 })).toEqual(
      nodePrefix
    );
    const bunPrefix = ["/usr/local/bin/bun", "run"];
    expect(mergeDenoPermissions(bunPrefix, ["allow-read"], { defaultAllEnd: 0 })).toEqual(
      bunPrefix
    );
    const nonePrefix: string[] = []; // interpreter "none" — no runtime at all
    expect(mergeDenoPermissions(nonePrefix, ["allow-read"], { defaultAllEnd: 0 })).toEqual([]);
  });

  test("empty permission list leaves the prefix alone (feature off)", () => {
    const prefix = ["deno", "run", "-A"];
    expect(mergeDenoPermissions(prefix, [], { defaultAllEnd: 3 })).toEqual(prefix);
  });

  test("explicit deno interpreter: the list appends after the interpreter's own flags", () => {
    expect(
      mergeDenoPermissions(["deno", "--allow-read"], ["allow-write"], { defaultAllEnd: 0 })
    ).toEqual(["deno", "--allow-read", "--allow-write"]);
  });

  test("NOT DUPLICATED: a stem the user already stated (any scoping) is skipped", () => {
    // bare flag already present
    expect(
      mergeDenoPermissions(["deno", "--allow-read"], ["allow-read"], { defaultAllEnd: 0 })
    ).toEqual(["deno", "--allow-read"]);
    // the user's SCOPED grant wins over a broader request — never overridden
    expect(
      mergeDenoPermissions(["deno", "--allow-read=/tmp"], ["allow-read"], { defaultAllEnd: 0 })
    ).toEqual(["deno", "--allow-read=/tmp"]);
    // node-args region counts as stated too (it sits before the script)
    expect(
      mergeDenoPermissions(["deno", "run", "--allow-env=FOO"], ["allow-env=BAR"], {
        defaultAllEnd: 0,
      })
    ).toEqual(["deno", "run", "--allow-env=FOO"]);
  });

  test("user-stated -A: allow entries are suppressed (they hard-conflict in deno), deny entries layer on top", () => {
    // Verified on deno 2.9.7: `deno -A --allow-write` errors out in BOTH
    // orders; `deno -A --deny-write` is valid and deny wins.
    expect(
      mergeDenoPermissions(["deno", "-A"], ["allow-read", "deny-write"], { defaultAllEnd: 0 })
    ).toEqual(["deno", "-A", "--deny-write"]);
  });

  test('"all" entry is suppressed when the user already stated ANY allow-* scoping', () => {
    expect(
      mergeDenoPermissions(["deno", "--allow-write=/tmp"], ["all"], { defaultAllEnd: 0 })
    ).toEqual(["deno", "--allow-write=/tmp"]);
  });

  test("pboss's own default -A (resolved route region) is REPLACED by the specific list", () => {
    expect(
      mergeDenoPermissions(["deno", "run", "-A"], ["allow-read"], { defaultAllEnd: 3 })
    ).toEqual(["deno", "run", "--allow-read"]);
  });

  test("a user-stated -A is NEVER stripped — only deduplicated against (defaultAllEnd 0)", () => {
    expect(
      mergeDenoPermissions(["deno", "run", "-A"], ["allow-read"], { defaultAllEnd: 0 })
    ).toEqual(["deno", "run", "-A"]);
  });

  test("the strip respects the region boundary: node-args keep their -A, the route's goes", () => {
    // Route = [deno, run, -A] (ours), node-args = [--allow-env=FOO] (user's).
    // -A is stripped from the ROUTE region only; --allow-env=FOO stays and
    // suppresses a redundant allow-env.
    expect(
      mergeDenoPermissions(["deno", "run", "-A", "--allow-env=FOO"], ["allow-env"], {
        defaultAllEnd: 3,
      })
    ).toEqual(["deno", "run", "--allow-env=FOO"]);
  });

  test('["none"] on the resolved route yields a zero-permission deno app', () => {
    expect(
      mergeDenoPermissions(["deno", "run", "-A"], ["none"], { defaultAllEnd: 3 })
    ).toEqual(["deno", "run"]);
  });

  test("the input prefix is never mutated (pure function)", () => {
    const prefix = ["deno", "run", "-A"];
    mergeDenoPermissions(prefix, ["allow-read"], { defaultAllEnd: 3 });
    expect(prefix).toEqual(["deno", "run", "-A"]);
  });

  test("invalid entries throw at merge time (config-file apps get the same error)", () => {
    expect(() =>
      mergeDenoPermissions(["deno"], ["writ"], { defaultAllEnd: 0 })
    ).toThrow(/Invalid deno permission/);
  });
});

// ---------------------------------------------------------------------------
// 3. Command assembly — ClusterManager.buildWorkerCommand (explicit
//    interpreters only: deterministic on every host; the resolved-route
//    translation is pinned by the merge tests above)
// ---------------------------------------------------------------------------

describe("deno permissions — buildWorkerCommand", () => {
  const cm = new ClusterManager();
  const base = {
    id: 1,
    name: "app",
    script: "/srv/app/server.mjs",
    args: [],
    cwd: "/srv/app",
    env: {},
    instances: 1,
    execMode: "fork" as const,
    autorestart: true,
    maxRestarts: 16,
    minUptime: 1000,
    watch: false,
    mergeLogs: false,
    raw: false,
    killTimeout: 5000,
    restartDelay: 0,
  };

  test("explicit deno + permissions: flags land between interpreter and script", async () => {
    const cmd = await cm.buildWorkerCommand({
      ...base,
      interpreter: "deno",
      permissions: ["allow-write", "allow-net=api.example.com"],
    });
    expect(cmd).toEqual([
      "deno",
      "--allow-write",
      "--allow-net=api.example.com",
      "/srv/app/server.mjs",
    ]);
  });

  test("interpreter-args duplicates are not re-added", async () => {
    const cmd = await cm.buildWorkerCommand({
      ...base,
      interpreter: "deno",
      interpreterArgs: ["--allow-read=/tmp"],
      permissions: ["allow-read", "deny-write"],
    });
    expect(cmd).toEqual(["deno", "--allow-read=/tmp", "--deny-write", "/srv/app/server.mjs"]);
  });

  test("RUNTIME-UNIQUE: a node interpreter ignores permissions entirely", async () => {
    const cmd = await cm.buildWorkerCommand({
      ...base,
      interpreter: "node",
      nodeArgs: ["--max-old-space-size=4096"],
      permissions: ["allow-read"],
    });
    expect(cmd).toEqual(["node", "--max-old-space-size=4096", "/srv/app/server.mjs"]);
  });

  test('interpreter "none" (direct binary) ignores permissions', async () => {
    const cmd = await cm.buildWorkerCommand({
      ...base,
      interpreter: "none",
      permissions: ["allow-read"],
    });
    expect(cmd).toEqual(["/srv/app/server.mjs"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Static pins — the parser, the scanner set, the help, the docs
// ---------------------------------------------------------------------------

describe("deno permissions — static pins", () => {
  const src = readFileSync(join(REPO, "src", "index.ts"), "utf8");

  test("parseStartFlags takes --permissions and --perms as VALUE flags", () => {
    expect(src).toMatch(/case "--permissions":/);
    expect(src).toMatch(/case "--perms":/);
    expect(src).toContain('"--permissions", "--perms"'); // START_VALUE_FLAGS member
    expect(src).not.toContain('"--permissions", "-P"'); // the letter form is GONE
  });

  test("the = spellings are handled (--permissions=list, --perms=list)", () => {
    expect(src).toContain('arg.startsWith("--permissions=")');
    expect(src).toContain('arg.startsWith("--perms=")');
  });

  test("the help advertises the flag and says why there is no letter form", () => {
    expect(src).toMatch(/--permissions, --perms <list>/);
    expect(src).toMatch(/-p is --port/);
  });

  test("-P is refused loudly before the target scan, never silently ignored", () => {
    // The guard sits in cmdStart ahead of findStartTarget — without it,
    // `-P allow-read` would donate its VALUE to the script-target slot.
    expect(src).toMatch(/args\.includes\("-P"\)/);
    expect(src).toMatch(/-P is not a flag/);
    expect(src).not.toMatch(/case "-P":/); // and it is not a parse case either
  });

  test("README documents the flag, the config array, and the dedup rule", () => {
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    expect(readme).toContain("--permissions");
    expect(readme).toMatch(/permissions:\s*\["allow-net", "allow-read", "deny-write"\]/);
    expect(readme).toContain("runtime-unique");
  });

  test("DOCS.md carries the flag row and the config-field documentation", () => {
    const docs = readFileSync(join(REPO, "DOCS.md"), "utf8");
    expect(docs).toContain("--permissions");
    expect(docs).toMatch(/permissions.*runtime-unique|runtime-unique.*permissions/i);
  });
});

// ---------------------------------------------------------------------------
// 5. E2E — the real CLI, a hermetic PBOSS_HOME, the real deno
// ---------------------------------------------------------------------------

/** Hermetic home; each e2e case gets its own daemon + dump. */
async function freshHome(prefix: string): Promise<string> {
  return mkdtempSync(join(tmpdir(), `pboss-perms-${prefix}-`));
}

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    // ~/.deno/bin must reach the daemon (it spawns the deno app), so PATH is
    // inherited with the deno dir prepended.
    env: {
      ...process.env,
      PBOSS_HOME: home,
      PATH: `${dirname(denoBin!)}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: home,
  });
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { out, err, code: code ?? 0 };
}

async function cleanup(home: string) {
  try {
    await runCli(["kill"], home);
  } catch {
    /* daemon never started */
  }
  try {
    const sweep = Bun.spawn(["pkill", "-f", home], { stdout: "ignore", stderr: "ignore" });
    await sweep.exited;
  } catch {
    /* pkill unavailable — best effort */
  }
  rmSync(home, { recursive: true, force: true });
}

/**
 * A deno app that (a) stays alive and (b) leaves proof of its permission
 * state: it READS <name>.input and WRITES <name>.ran. What it can do is
 * exactly what pboss granted.
 */
function writeDenoApp(home: string, name = "deno-app.mjs") {
  const script = join(home, name);
  const stem = name.replace(/\.\w+$/, "");
  writeFileSync(
    script,
    [
      `import { readFileSync, writeFileSync } from "node:fs";`,
      `import { join, dirname } from "node:path";`,
      `import { fileURLToPath } from "node:url";`,
      `const here = dirname(fileURLToPath(import.meta.url));`,
      `// read a sibling input file — needs allow-read`,
      `const input = readFileSync(join(here, ${JSON.stringify(`${stem}.input`)}), "utf8");`,
      `// write the sentinel — needs allow-write`,
      `writeFileSync(join(here, ${JSON.stringify(`${stem}.ran`)}), input.trim());`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join("\n")
  );
  writeFileSync(join(home, `${stem}.input`), "granted\n");
  return script;
}

/** Poll until the file exists (bounded). */
async function waitFor(file: string, ms = 25_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await Bun.sleep(50);
  }
  return existsSync(file);
}

/** Poll until the condition holds (bounded). */
async function pollFor(cond: () => boolean, ms = 25_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(stepMs);
  }
  return cond();
}

/** The saved dump entries (config per process). */
function dumpConfigs(home: string): any[] {
  const dump = join(home, "dump.json");
  if (!existsSync(dump)) return [];
  try {
    return JSON.parse(readFileSync(dump, "utf8")) as any[];
  } catch {
    return []; // mid-write
  }
}

describe("deno permissions — e2e (real CLI + real deno)", () => {
    test.skipIf(!canDeno)(
      "a stated permission list GRANTS what it says (read + write sentinels land)",
      async () => {
        const home = await freshHome("grant");
        writeDenoApp(home);
        try {
          const res = await runCli(
            ["start", "./deno-app.mjs", "--interpreter", "deno", "--permissions", "allow-read,allow-write"],
            home
          );
          expect(res.code).toBe(0);
          expect(await waitFor(join(home, "deno-app.ran"))).toBe(true);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "a MISSING grant actually denies — no -A leaks through (the pre-feature default)",
      async () => {
        const home = await freshHome("deny");
        writeDenoApp(home);
        try {
          const res = await runCli(
            ["start", "./deno-app.mjs", "--interpreter", "deno", "--permissions", "allow-read"],
            home
          );
          // The app boots (read works) but the write is denied by deno
          // itself — the sentinel never lands and the app keeps crashing.
          await Bun.sleep(4000);
          expect(existsSync(join(home, "deno-app.ran"))).toBe(false);
          // It registered (a real deno process, really permission-gated).
          expect(dumpConfigs(home).length).toBeGreaterThan(0);
          expect(res.code).toBe(0);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "THE OWNER'S REPORT (2026-10-08): an UNSTATED route grants NOTHING — a serving app fails with the pointed --allow-net hint",
      async () => {
        // The owner's machine shape: a deno install stamped .runtime=deno, so
        // `pboss start ./server.ts` (unstated interpreter, unstated
        // permissions) resolves the deno route. Pre-fix that route carried
        // the kitchen-sink `-A` — the app STARTED and SERVED without any
        // stated net permission ("I didnt set net permission which must
        // fail but it started").
        const home = await freshHome("unstated");
        writeFileSync(join(home, ".runtime"), "deno\n");
        const PORT = 18401;
        writeFileSync(
          join(home, "server.ts"),
          [
            `console.log("SERVE-BOOTED");`,
            `Deno.serve({ port: ${PORT} }, () => new Response("serving"));`,
            ``,
          ].join("\n")
        );
        try {
          const res = await runCli(["start", "./server.ts"], home);
          expect(res.code).toBe(0); // the start command itself is fine
          expect(dumpConfigs(home).length).toBeGreaterThan(0); // it registered

          // The pointed denial lands in the app's error log — deno's own
          // message, never a silent success.
          const errLog = join(home, "logs", "server-0-error.log");
          const denied = await pollFor(
            () => existsSync(errLog) && readFileSync(errLog, "utf8").includes("Requires net access"),
            20_000,
          );
          expect(denied).toBe(true);
          const logged = readFileSync(errLog, "utf8");
          expect(logged).toContain("--allow-net"); // the hint is pointed

          // And it never serves: the whole point of the owner's report.
          const probe = Bun.spawnSync(
            ["curl", "-s", "--max-time", "2", `http://localhost:${PORT}/`],
            { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
          );
          expect(probe.exitCode).not.toBe(0);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "the --quiet route: a healthy serving app's logs carry NO [ERROR] listening banner",
      async () => {
        // Deno prints "Listening on http://…" to STDERR — every process
        // manager labels that [ERROR], so a successful start painted the
        // owner's logs red. The resolved route now runs --quiet: the banner
        // is gone, real output stays, real errors still print.
        const home = await freshHome("quiet");
        writeFileSync(join(home, ".runtime"), "deno\n");
        const PORT = 18402;
        writeFileSync(
          join(home, "server.ts"),
          [
            `console.log("QUIET-BOOTED");`,
            `Deno.serve({ port: ${PORT} }, () => new Response("ok"));`,
            ``,
          ].join("\n")
        );
        try {
          const res = await runCli(
            ["start", "./server.ts", "--permissions", "allow-net"],
            home,
          );
          expect(res.code).toBe(0);

          // THIS app booted (its own log line — not any stray listener on
          // the port), and it serves (granted exactly what was stated).
          const outLog = join(home, "logs", "server-0-out.log");
          const booted = await pollFor(
            () => existsSync(outLog) && readFileSync(outLog, "utf8").includes("QUIET-BOOTED"),
            20_000,
          );
          expect(booted).toBe(true);
          const up = await pollFor(() => {
            const probe = Bun.spawnSync(
              ["curl", "-s", "--max-time", "2", `http://localhost:${PORT}/`],
              { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
            );
            return probe.exitCode === 0;
          }, 20_000);
          expect(up).toBe(true);

          // The logs show the app's own output — and NOT the runtime's
          // STDERR banner, which pboss would faithfully label [ERROR].
          const logs = await runCli(["logs", "server", "--lines", "50"], home);
          expect(logs.out).toContain("QUIET-BOOTED");
          expect(logs.out).not.toContain("Listening on");
          expect(logs.out).not.toContain("[ERROR]");
          const errLog = join(home, "logs", "server-0-error.log");
          if (existsSync(errLog)) {
            expect(readFileSync(errLog, "utf8")).not.toContain("Listening on");
          }
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "deny layers on top of a user-stated -A: -A --deny-write blocks the write",
      async () => {
        const home = await freshHome("deny-on-A");
        writeDenoApp(home);
        try {
          const res = await runCli(
            [
              "start", "./deno-app.mjs",
              "--interpreter", "deno",
              "--interpreter-args", "-A",
              "--permissions", "deny-write",
            ],
            home
          );
          await Bun.sleep(4000);
          expect(existsSync(join(home, "deno-app.ran"))).toBe(false);
          expect(dumpConfigs(home).length).toBeGreaterThan(0);
          expect(res.code).toBe(0);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "the = spellings and the --perms short form both work; describe reports the list",
      async () => {
        const home = await freshHome("spellings");
        writeDenoApp(home, "alt.mjs");
        try {
          const res = await runCli(
            ["start", "--permissions=allow-read,allow-write", "--interpreter", "deno", "./alt.mjs"],
            home
          );
          expect(res.code).toBe(0);
          expect(await waitFor(join(home, "alt.ran"))).toBe(true);

          const desc = await runCli(["describe", "alt"], home);
          expect(desc.out).toMatch(/Permissions\s+: allow-read, allow-write \(deno\)/);

          // --perms short form on a fresh app, plus its own = spelling —
          // neither can collide with -p (--port), which is the point.
          writeDenoApp(home, "alt2.mjs");
          const res2 = await runCli(
            ["start", "./alt2.mjs", "--interpreter", "deno", "--perms", "allow-read,allow-write"],
            home
          );
          expect(res2.code).toBe(0);
          expect(await waitFor(join(home, "alt2.ran"))).toBe(true);

          writeDenoApp(home, "alt3.mjs");
          const res3 = await runCli(
            ["start", "./alt3.mjs", "--interpreter", "deno", "--perms=allow-read,allow-write"],
            home
          );
          expect(res3.code).toBe(0);
          expect(await waitFor(join(home, "alt3.ran"))).toBe(true);
        } finally {
          await cleanup(home);
        }
      },
      180000
    );

    test.skipIf(!canDeno)(
      "-P is refused with a pointed error — never treated as the port, never silent",
      async () => {
        const home = await freshHome("removed-p");
        try {
          // With a script present: the guard fires before anything spawns.
          const res = await runCli(
            ["start", "./x.mjs", "--interpreter", "deno", "-P", "allow-read"],
            home
          );
          expect(res.code).toBe(1);
          expect(res.err).toMatch(/-P is not a flag/);
          expect(res.err).toMatch(/--perms/);

          // Without a script: the old failure mode was the permission list
          // being eaten as the TARGET — the guard must beat that too.
          const res2 = await runCli(
            ["start", "-P", "allow-read,allow-write"],
            home
          );
          expect(res2.code).toBe(1);
          expect(res2.err).toMatch(/-P is not a flag/);
          expect(res2.err).not.toMatch(/no script at/); // the target-scan error, not this
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "an ecosystem config file drives the same translation (permissions array)",
      async () => {
        const home = await freshHome("config");
        writeDenoApp(home, "cfg.mjs");
        writeFileSync(
          join(home, "ecosystem.config.js"),
          [
            `module.exports = {`,
            `  apps: [{`,
            `    name: "cfg",`,
            `    script: "./cfg.mjs",`,
            `    interpreter: "deno",`,
            `    permissions: ["allow-read", "allow-write"],`,
            `  }],`,
            `};`,
            ``,
          ].join("\n")
        );
        try {
          const res = await runCli(["start", "ecosystem.config.js"], home);
          expect(res.code).toBe(0);
          expect(await waitFor(join(home, "cfg.ran"))).toBe(true);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "invalid entries fail fast at the terminal with the category list",
      async () => {
        const home = await freshHome("invalid");
        writeDenoApp(home);
        try {
          const res = await runCli(
            ["start", "./deno-app.mjs", "--interpreter", "deno", "--permissions", "allow-writ,allow-read"],
            home
          );
          expect(res.code).toBe(1);
          expect(res.err).toMatch(/Invalid deno permission "allow-writ"/);
          expect(res.err).toMatch(/unknown category "writ"/);
          // Nothing registered — the error fired before any spawn.
          expect(dumpConfigs(home).length).toBe(0);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );

    test.skipIf(!canDeno)(
      "RUNTIME-UNIQUE e2e: permissions under an explicit bun interpreter are ignored, with the dim notice",
      async () => {
        const home = await freshHome("ignored");
        writeDenoApp(home, "bun-app.mjs");
        try {
          const res = await runCli(
            ["start", "./bun-app.mjs", "--interpreter", "bun", "--permissions", "allow-write"],
            home
          );
          // bun ignores the list — the app runs anyway (bun grants by default).
          expect(res.code).toBe(0);
          expect(await waitFor(join(home, "bun-app.ran"))).toBe(true);
          // The dim honesty line named the runtime.
          expect(res.err).toMatch(/permissions are a Deno feature — ignored for bun/);
        } finally {
          await cleanup(home);
        }
      },
      120000
    );
  }
);
