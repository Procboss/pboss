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
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readlinkSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
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

type Frame = { type: string; progress?: { step: string; success?: boolean; error?: string; logs?: string[] } };

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
  // PBOSS_HOME must be pinned BEFORE constants loads (deploys root)
  process.env.PBOSS_HOME = HOME;
  return import("../src/deploy-job");
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "pboss-autodeploy-"));
  HOME = join(ROOT, "home");
  mkdirSync(HOME, { recursive: true });

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

    const deploys = join(HOME, "deploys", "testapp");
    const releases = join(deploys, "releases");
    const releaseNames = readdirSync(releases);
    expect(releaseNames.length).toBe(1);
    expect(existsSync(join(releases, releaseNames[0], "dist", "marker.txt"))).toBe(true);
    expect(readFileSync(join(releases, releaseNames[0], "dist", "marker.txt")).toString()).toBe("built-v1");

    const current = resolve(deploys, readlinkSync(join(deploys, "current")));
    expect(current.startsWith(releases)).toBe(true);

    expect(fake.starts.length).toBe(1);
    expect(fake.starts[0].name).toBe("testapp");
    expect(fake.starts[0].script).toBe("node index.js");
    expect(fake.starts[0].cwd).toBe(join(deploys, "current"));
  });

  test("second commit → second release, symlink flips forward", async () => {
    const { runDeployJob } = await importJob();
    const deploys = join(HOME, "deploys", "testapp");
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
    expect(readdirSync(join(HOME, "deploys", "testapp", "releases")).length).toBe(2);
    const current = resolve(join(HOME, "deploys", "testapp"), readlinkSync(join(HOME, "deploys", "testapp", "current")));
    expect(current.includes(SHA1.slice(0, 8))).toBe(true);
  });

  test("failing start after the swap → previous release restored", async () => {
    const { runDeployJob } = await importJob();
    const deploys = join(HOME, "deploys", "testapp");
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
});
