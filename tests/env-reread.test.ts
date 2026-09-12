import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

/**
 * .env re-read at (re)spawn — the "stale env snapshot" suite.
 *
 * The production incident this pins: the app's env was captured ONCE at
 * `pboss start` time (ecosystem config `import "dotenv/config"`) and frozen
 * into the container config + ~/.pboss/dump.json. Every later .env edit was
 * invisible to `pboss restart` and post-reboot `resurrect` — the ProcBoss
 * web app kept a placeholder `DATABASE_URL` (`…@HOST/DBNAME`) and 502'd
 * every request with "Can't reach database server at `HOST:5432`" while
 * the real Neon URL sat unread in .env.
 *
 * Contract under test:
 *   1. `<app cwd>/.env` is re-read at EVERY (re)spawn and its values WIN
 *      over the start-time snapshot (edit .env + pboss restart applies);
 *   2. apps WITHOUT an .env see zero change (snapshot semantics intact);
 *   3. pboss's own injected vars (PBOSS_NAME, …) cannot be hijacked via .env;
 *   4. resurrect from the dump heals the same way (reboot path);
 *   5. the parser tolerates comments/quotes/export/CRLF/malformed lines.
 *
 * PBOSS_HOME is isolated BEFORE src imports (constants.ts resolves it at
 * import time) so nothing here touches the developer's real ~/.pboss.
 */
const TEST_HOME = join(tmpdir(), `pboss-test-envreread-${process.pid}-${Date.now()}`);
process.env.PBOSS_HOME = TEST_HOME;

const ROOT = join(tmpdir(), `pboss-test-envreread-src-${process.pid}-${Date.now()}`);

beforeEach(async () => {
  await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
});

/** App that dumps the env it booted with to a file, then idles. */
const ENV_PROBE_SCRIPT = `
const out = process.env.PB_ENV_OUT!;
await Bun.write(out, JSON.stringify({
  db: process.env.PB_DB_URL ?? null,
  marker: process.env.PB_MARKER ?? null,
  pbossName: process.env.PBOSS_NAME ?? null,
  pid: process.pid,
}));
setInterval(() => {}, 1000);
`;

async function makeAppDir(name: string, envFile?: string): Promise<{ dir: string; script: string; out: string }> {
  const dir = join(ROOT, name);
  await mkdir(dir, { recursive: true });
  const script = join(dir, "probe.ts");
  const out = join(dir, "env.json");
  await writeFile(script, ENV_PROBE_SCRIPT);
  if (envFile !== undefined) await writeFile(join(dir, ".env"), envFile);
  return { dir, script, out };
}

interface ProbeSnapshot {
  db: string | null;
  marker: string | null;
  pbossName: string | null;
  pid: number;
}

async function readProbe(out: string): Promise<ProbeSnapshot> {
  return JSON.parse(await readFile(out, "utf-8"));
}

/** Poll until the probe file matches (or the child changed pid). */
async function waitProbe(
  out: string,
  pred: (s: ProbeSnapshot) => boolean,
  timeoutMs = 8000
): Promise<ProbeSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeSnapshot | null = null;
  while (Date.now() < deadline) {
    try {
      last = await readProbe(out);
      if (pred(last)) return last;
    } catch {
      /* not written yet */
    }
    await Bun.sleep(50);
  }
  throw new Error(`probe never satisfied (last: ${JSON.stringify(last)})`);
}

describe("parseEnvFile (dotenv subset)", () => {
  test("comments, blanks, export prefix, quotes, CRLF", async () => {
    const { parseEnvFile } = await import("../src/utils");
    const parsed = parseEnvFile(
      [
        "# full-line comment",
        "",
        "PLAIN=value",
        "export EXPORTED=also-fine",
        'DQUOTED="keep # this, drop quotes"',
        "SQUOTED='single'",
        "CRLF_OK=windows\r",
        "URL=\"postgresql://u:p@host/db?a=1&b=2\"",
        "  TRIMMED  =  spaced value  ",
      ].join("\n")
    );
    expect(parsed.PLAIN).toBe("value");
    expect(parsed.EXPORTED).toBe("also-fine");
    expect(parsed.DQUOTED).toBe("keep # this, drop quotes");
    expect(parsed.SQUOTED).toBe("single");
    expect(parsed.CRLF_OK).toBe("windows");
    expect(parsed.URL).toBe("postgresql://u:p@host/db?a=1&b=2");
    expect(parsed.TRIMMED).toBe("spaced value");
  });

  test("malformed lines are ignored, never fatal", async () => {
    const { parseEnvFile } = await import("../src/utils");
    const parsed = parseEnvFile("no-equals-sign\nBAD KEY=1\n1STARTS_WITH_DIGIT=2\nGOOD=3\n=a\n");
    expect(parsed.GOOD).toBe("3");
    expect(Object.keys(parsed)).toHaveLength(1);
  });
});

describe("readEnvFileOverrides", () => {
  test("missing dir / missing file contributes nothing", async () => {
    const { readEnvFileOverrides } = await import("../src/utils");
    expect(readEnvFileOverrides(join(ROOT, "nope"))).toEqual({});
  });

  test("reads the app dir's .env", async () => {
    const { readEnvFileOverrides } = await import("../src/utils");
    const { dir } = await makeAppDir("unit", "DATABASE_URL=postgres://real/db\n");
    expect(readEnvFileOverrides(dir)).toEqual({ DATABASE_URL: "postgres://real/db" });
  });
});

describe(".env re-read at (re)spawn — the stale-snapshot incident", () => {
  test("pboss restart applies a .env edit (old code kept the stale value)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    // The incident shape: the START-TIME snapshot carries the placeholder
    // DATABASE_URL (captured from the .env of the first boot)…
    const app = await makeAppDir("restart-app", "PB_DB_URL=postgres://placeholder@HOST/DBNAME\n");

    await pm.start({
      name: "env-restart-app",
      script: app.script,
      cwd: app.dir,
      env: { PB_ENV_OUT: app.out, PB_DB_URL: "postgres://placeholder@HOST/DBNAME" },
    });

    // …but the first boot already prefers the .env file over the snapshot.
    const first = await waitProbe(app.out, (s) => s.db !== null);
    expect(first.db).toBe("postgres://placeholder@HOST/DBNAME");
    expect(first.pbossName).toBe("env-restart-app"); // injected, not from .env

    // THE FIX: edit .env, restart — the new value must reach the child.
    await writeFile(join(app.dir, ".env"), "PB_DB_URL=postgresql://real@neon.tech/db?pgbouncer=true\n");
    await pm.restart("env-restart-app");
    const second = await waitProbe(app.out, (s) => s.db?.includes("neon.tech") === true);
    expect(second.db).toBe("postgresql://real@neon.tech/db?pgbouncer=true");
    expect(second.pbossName).toBe("env-restart-app");

    await pm.deleteAll();
  });

  test("apps without an .env keep pure snapshot semantics (zero change)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const app = await makeAppDir("no-env-app"); // no .env in cwd

    await pm.start({
      name: "env-plain-app",
      script: app.script,
      cwd: app.dir,
      env: { PB_ENV_OUT: app.out, PB_MARKER: "from-snapshot" },
    });

    const snap = await waitProbe(app.out, (s) => s.marker !== null);
    expect(snap.marker).toBe("from-snapshot");

    await pm.deleteAll();
  });

  test(".env cannot hijack pboss's own injected vars", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const app = await makeAppDir("hijack-app", "PBOSS_NAME=evil\nPBOSS_ID=999\n");

    await pm.start({
      name: "env-hijack-app",
      script: app.script,
      cwd: app.dir,
      env: { PB_ENV_OUT: app.out },
    });

    const snap = await waitProbe(app.out, (s) => s.db === null && s.pbossName !== null);
    expect(snap.pbossName).toBe("env-hijack-app"); // .env's "evil" must NOT win

    await pm.deleteAll();
  });

  test("resurrect from the dump heals the same way (reboot path)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const app = await makeAppDir("resurrect-app", "PB_DB_URL=postgres://before@HOST/db\n");

    await pm.start({
      name: "env-resurrect-app",
      script: app.script,
      cwd: app.dir,
      env: { PB_ENV_OUT: app.out },
    });
    await waitProbe(app.out, (s) => s.db === "postgres://before@HOST/db");
    await pm.stopAll({ persist: false }); // daemon-shutdown style: dump keeps describing what should run

    // While "down" (reboot), the operator fixes .env…
    await writeFile(join(app.dir, ".env"), "PB_DB_URL=postgresql://fixed@neon.tech/db\n");

    // …the next daemon boots and resurrects from the dump — the child must
    // boot with the FIXED value even though the dump's env snapshot is stale.
    const pm2 = new ProcessManager();
    await pm2.resurrect();
    const snap = await waitProbe(app.out, (s) => s.db?.includes("fixed@neon") === true);
    expect(snap.db).toBe("postgresql://fixed@neon.tech/db");

    await pm2.deleteAll();
  });
});
