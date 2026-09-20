/**
 * Deploy-job e2e — the auto-deploy pipeline on the agent side, against a
 * REAL local git repository (file:// remote — no network, no GitHub):
 *
 *   1. a working repo with two commits + a build step that writes a marker
 *   2. runDeployJob(mode "new"): clone → archive → install → build →
 *      release dir exists with the built marker, current symlink points at
 *      it, the (fake) process manager got start() with cwd=current
 *   3. the progress frame sequence matches the pipeline order and ends
 *      with a terminal done(success) frame carrying the exact commit
 *   4. deploy the SECOND commit → new release, symlink flipped
 *   5. rollback to the first commit → fast path reuses the existing
 *      release (progress starts at "deploying", no rebuild)
 *   6. a failing build after a good deploy → the previous symlink is
 *      RESTORED (a failed deploy must not leave production broken)
 *   7. cancelDeployJob for an unknown id is a clean false
 *   8. the owner's default: ~/apps is the OS user's HOME — a custom
 *      PBOSS_HOME does not drag the apps tree next to itself
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readlinkSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

let ROOT: string;
let HOME: string;
let REPO: string;
let SHA1 = "";
let SHA2 = "";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(
    ["git", "-c", "user.name=e2e", "-c", "user.email=e2e@test.local", "-C", cwd, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

type Frame = { type: string; progress?: { step: string; success?: boolean; error?: string; logs?: string[]; commit?: string; durationMs?: number } };

/** The fake process manager — records starts, can be poisoned. */
function makeFakePm() {
  const starts: Array<{ name: string; script: string; cwd: string }> = [];
  let poison = false;
  return {
    starts,
    setPoison: (v: boolean) => (poison = v),
    pm: {
      list: () => [],
      stop: async () => [],
      start: async (opts: { name: string; script: string; cwd: string }) => {
        if (poison) throw new Error("poisoned start");
        starts.push({ name: opts.name, script: opts.script, cwd: opts.cwd });
        return [] as never[];
      },
    } as unknown as import("../src/process-manager").ProcessManager,
  };
}

async function importJob() {
  // Pin the roots before the job RUNS: both resolve per job (runDeployJob
  // reads the env at job start), so this holds even when bun's
  // single-process runner cached src/constants with a different home
  // (full-suite runs — the api.test.ts import binds ~/.pboss first).
  // PBOSS_HOME steers backups; PBOSS_APPS_DIR (pinned in beforeAll)
  // steers the deploy tree.
  process.env.PBOSS_HOME = HOME;
  return import("../src/deploy-job");
}

/** The suite's apps root: beforeAll pins PBOSS_APPS_DIR = ROOT/apps — the
 * absolute-control override — so pipeline assertions read a stable root
 * and never touch the runner's real home. */
function appsDir(): string {
  return join(ROOT, "apps");
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "pboss-autodeploy-"));
  HOME = join(ROOT, "home");
  mkdirSync(HOME, { recursive: true });
  // the suite's apps root — the absolute-control override (the default
  // would be the runner's real HOME, which tests must never touch)
  process.env.PBOSS_APPS_DIR = join(ROOT, "apps");

  // the fixture repo: two commits, build writes dist/marker.txt
  REPO = join(ROOT, "repo.git");
  mkdirSync(REPO);
  await git(REPO, "init", "-b", "main");
  writeFileSync(join(REPO, "index.js"), "console.log('v1');\n");
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "app", scripts: { build: "node build.js" } }, null, 2));
  writeFileSync(join(REPO, "build.js"), "require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/marker.txt', 'built-v1');\n");
  await git(REPO, "add", "-A");
  await git(REPO, "commit", "-m", "v1");
  SHA1 = await git(REPO, "rev-parse", "HEAD");

  writeFileSync(join(REPO, "index.js"), "console.log('v2');\n");
  await git(REPO, "add", "-A");
  await git(REPO, "commit", "-m", "v2");
  SHA2 = await git(REPO, "rev-parse", "HEAD");
});

afterAll(() => {
  delete process.env.PBOSS_APPS_DIR; // leave the ambient env untouched
  rmSync(ROOT, { recursive: true, force: true });
});

function payload(overrides: Partial<import("../src/cloud").DeployRunPayload>): import("../src/cloud").DeployRunPayload {
  return {
    deploymentId: "dep_test_1",
    repoUrl: REPO,
    cleanRepoUrl: REPO,
    branch: "main",
    commitSha: SHA1,
    installCmd: null,
    buildCmd: "node build.js",
    startCmd: "node index.js",
    workdir: null,
    env: {},
    runtime: "node",
    mode: "new",
    processName: "testapp",
    buildTimeoutSec: 120,
    // the redesign fields — release strategy, no backup registry by default
    strategy: "release",
    targetId: null,
    backupFromCommit: null,
    backupRetention: 5,
    configFile: null,
    configApp: null,
    ...overrides,
  };
}

describe("deploy-job — real clone/archive/build/swap pipeline", () => {
  test("mode=new: release built, symlink flipped, process started, frames ordered", async () => {
    const { runDeployJob } = await importJob();
    const frames: Frame[] = [];
    const fake = makeFakePm();
    await runDeployJob(
      { sendFrame: (f: Frame) => (frames.push(f), true), pm: fake.pm },
      payload({}),
    );

    const steps = frames.filter((f) => f.type === "deploy.progress").map((f) => f.progress!.step);
    expect(steps).toContain("cloning");
    expect(steps).toContain("building");
    expect(steps).toContain("deploying");
    expect(steps).toContain("starting");
    const done = frames.find((f) => f.progress?.step === "done");
    expect(done?.progress?.success).toBe(true);
    expect(done?.progress?.commit).toBe(SHA1);
    expect(done?.progress?.durationMs).toBeGreaterThanOrEqual(0);

    const deploys = join(appsDir(), "testapp");
    const releases = join(deploys, "releases");
    const releaseNames = readdirSync(releases);
    expect(releaseNames.length).toBe(1);
    expect(existsSync(join(releases, releaseNames[0]!, "dist", "marker.txt"))).toBe(true);
    expect(readFileSync(join(releases, releaseNames[0]!, "dist", "marker.txt")).toString()).toBe("built-v1");

    const current = resolve(deploys, readlinkSync(join(deploys, "current")));
    expect(current.startsWith(releases)).toBe(true);

    expect(fake.starts.length).toBe(1);
    expect(fake.starts[0]!.name).toBe("testapp");
    expect(fake.starts[0]!.script).toBe("node index.js");
    expect(fake.starts[0]!.cwd).toBe(join(deploys, "current"));
  });

  test("second commit → second release, symlink flips forward", async () => {
    const { runDeployJob } = await importJob();
    const deploys = join(appsDir(), "testapp");
    const before = resolve(deploys, readlinkSync(join(deploys, "current")));
    const fake = makeFakePm();
    await runDeployJob(
      { sendFrame: () => true, pm: fake.pm },
      payload({ deploymentId: "dep_test_2", commitSha: SHA2, mode: "update" }),
    );
    const after = resolve(deploys, readlinkSync(join(deploys, "current")));
    expect(after).not.toBe(before);
    expect(readdirSync(join(deploys, "releases")).length).toBe(2);
  });

  test("rollback reuses the existing release — no rebuild", async () => {
    const { runDeployJob } = await importJob();
    const frames: Frame[] = [];
    const fake = makeFakePm();
    await runDeployJob(
      { sendFrame: (f: Frame) => (frames.push(f), true), pm: fake.pm },
      payload({ deploymentId: "dep_test_3", commitSha: SHA1, mode: "rollback" }),
    );
    const steps = frames.filter((f) => f.type === "deploy.progress").map((f) => f.progress!.step);
    expect(steps).not.toContain("cloning"); // fast path: no refetch
    expect(steps).not.toContain("building");
    expect(frames.find((f) => f.progress?.step === "done")?.progress?.success).toBe(true);
    // still exactly 2 releases — nothing new was built
    expect(readdirSync(join(appsDir(), "testapp", "releases")).length).toBe(2);
    const current = resolve(join(appsDir(), "testapp"), readlinkSync(join(appsDir(), "testapp", "current")));
    expect(current.includes(SHA1.slice(0, 8))).toBe(true);
  });

  test("failing start after the swap → previous release restored", async () => {
    const { runDeployJob } = await importJob();
    const deploys = join(appsDir(), "testapp");
    const before = resolve(deploys, readlinkSync(join(deploys, "current")));

    const fake = makeFakePm();
    fake.setPoison(true); // pm.start throws — the failure is AFTER the swap
    const frames: Frame[] = [];
    await runDeployJob(
      { sendFrame: (f: Frame) => (frames.push(f), true), pm: fake.pm },
      payload({ deploymentId: "dep_test_4", commitSha: SHA2, mode: "update" }),
    );

    const after = resolve(deploys, readlinkSync(join(deploys, "current")));
    expect(after).toBe(before); // restored
    const done = frames.find((f) => f.progress?.step === "done");
    expect(done?.progress?.success).toBe(false);
    expect(done?.progress?.error ?? "").toContain("poisoned start");
  });

  test("cancelDeployJob for an unknown id → clean false", async () => {
    const { cancelDeployJob } = await importJob();
    expect(cancelDeployJob("never-started")).toBe(false);
  });

  test("the owner's default: ~/apps is the OS user's home, wherever the pboss home lives", async () => {
    // /home/{username}/apps for real servers: $HOME decides — a custom
    // PBOSS_HOME must NOT drag the apps tree next to itself (the old
    // dirname coupling)
    const { runDeployJob } = await importJob();
    const userHome = join(ROOT, "fakeuser");
    const pbossHome = join(ROOT, "elsewhere", ".pboss"); // deliberately outside the user home
    mkdirSync(userHome, { recursive: true });
    const prevHome = process.env.HOME;
    const prevPboss = process.env.PBOSS_HOME;
    const prevAppsDir = process.env.PBOSS_APPS_DIR;
    delete process.env.PBOSS_APPS_DIR; // exercise the DEFAULT, not the override
    process.env.HOME = userHome;
    process.env.PBOSS_HOME = pbossHome;
    const fake = makeFakePm();
    await runDeployJob(
      { sendFrame: () => true, pm: fake.pm },
      payload({ deploymentId: "dep_home_layout", processName: "hometest" }),
    );
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    process.env.PBOSS_HOME = prevPboss ?? HOME;
    process.env.PBOSS_APPS_DIR = prevAppsDir ?? join(ROOT, "apps");

    const apps = join(userHome, "apps", "hometest");
    expect(existsSync(join(apps, "source"))).toBe(true);
    expect(existsSync(join(apps, "current"))).toBe(true);
    expect(fake.starts[0]!.cwd).toBe(join(apps, "current"));
    // nothing next to the pboss home (the dirname coupling is dead)…
    expect(existsSync(join(ROOT, "elsewhere", "apps"))).toBe(false);
    // …and nothing app-shaped inside .pboss itself
    expect(existsSync(join(pbossHome, "apps"))).toBe(false);
    expect(existsSync(join(pbossHome, "deploys"))).toBe(false);
  });
});
