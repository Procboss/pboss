/**
 * Cloud deploy e2e — the REAL git-pull pipeline behind the dashboard's
 * Deploy button, against the mini-cloud double:
 *
 *   1. a bare git repo (origin) + a working clone on disk
 *   2. `pboss start` a process whose script lives inside the clone
 *   3. dispatch process.deploy → agent runs git pull --ff-only in the
 *      process's working directory → up-to-date: commit reported, no restart
 *   4. push a NEW commit to origin → dispatch again → agent pulls it,
 *      reports the new commit, and RESTARTS the process (pid changes)
 *   5. deploying a process outside a git repo fails honestly
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

const { startMiniCloud } = await import("./helpers/mini-cloud");
type MiniCloud = import("./helpers/mini-cloud").MiniCloud;

let mini: MiniCloud;

beforeAll(async () => {
  mini = await startMiniCloud();
});

afterAll(async () => {
  await mini.stop();
});

function spawnCli(args: string[], home: string) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home, PBOSS_NO_BROWSER: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: ROOT,
  });
}

async function runCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  const code = await proc.exited;
  return { out, err, code };
}

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

function freshHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `pboss-deploy-${prefix}-`));
  mkdirSync(join(home, "logs"), { recursive: true });
  return home;
}

describe("cloud deploy e2e — real git pull + restart through the agent", () => {
  test(
    "process.deploy pulls, reports the commit, and restarts on change",
    async () => {
      const home = freshHome("main");
      // the git fixture: bare origin + working clone
      const gitRoot = mkdtempSync(join(tmpdir(), "pboss-deploy-repo-"));
      const origin = join(gitRoot, "origin.git");
      const clone = join(gitRoot, "app");
      const pusher = join(gitRoot, "pusher");
      try {
        await git(gitRoot, "init", "--bare", origin);
        await git(gitRoot, "clone", origin, clone);
        // a talking process inside the repo
        const script = join(clone, "worker.ts");
        writeFileSync(
          script,
          "let i = 0; setInterval(() => { console.log('tick ' + (++i)); }, 300);\n",
        );
        await git(clone, "add", "-A");
        await git(clone, "commit", "-m", "chore: first commit");
        // push to the clone's own initial branch (empty clones pick master or
        // main depending on git's default) so the tracking ref exists
        const branch = (await git(clone, "branch", "--show-current")) || "master";
        await git(clone, "push", "origin", `HEAD:${branch}`);
        const firstCommit = await git(clone, "rev-parse", "--short", "HEAD");

        // link the machine + start the process
        const link = await runCli(["cloud", "connect", mini.mintEnrollmentToken(), "--url", mini.url], home);
        expect(link.code).toBe(0);
        const started = await runCli(["start", script, "--name", "worker"], home);
        expect(started.code).toBe(0);
        await new Promise((r) => setTimeout(r, 700));
        const pidOf = async (): Promise<string | undefined> => {
          const out = (await runCli(["describe", "worker"], home)).out;
          return out.match(/PID\s*:\s*(\d+)/i)?.[1] ?? out.match(/pid[\s:]+(\d+)/i)?.[1];
        };
        const pidBefore = await pidOf();

        // 1st deploy: up to date — commit reported, no restart
        const upToDate = await mini.dispatchCommand(
          (JSON.parse(await Bun.file(join(home, "cloud.json")).text()) as { serverId: string }).serverId,
          "process.deploy",
          { target: "worker" },
        );
        expect(upToDate.success).toBe(true);
        const first = upToDate.data as {
          commit: string; message: string; pulled: boolean; restart: boolean; remote: string | null;
        };
        expect(first.commit).toBe(firstCommit);
        expect(first.message).toContain("first commit");
        expect(first.pulled).toBe(false);
        expect(first.restart).toBe(false);
        expect(first.remote).toContain("origin"); // .git suffix normalized away

        // 2nd deploy: a new commit on origin → pulled + restarted
        await git(gitRoot, "clone", origin, pusher);
        writeFileSync(join(pusher, "worker.ts"), "console.log('v2');\nsetInterval(() => {}, 1000);\n");
        await git(pusher, "add", "-A");
        await git(pusher, "commit", "-m", "feat: ship v2");
        await git(pusher, "push", "origin", `HEAD:${branch}`);
        const secondCommit = (await git(pusher, "rev-parse", "--short", "HEAD")).trim();

        const shipped = await mini.dispatchCommand(
          (JSON.parse(await Bun.file(join(home, "cloud.json")).text()) as { serverId: string }).serverId,
          "process.deploy",
          { target: "worker" },
        );
        expect(shipped.success).toBe(true);
        const second = shipped.data as { commit: string; message: string; pulled: boolean; restart: boolean };
        expect(second.commit).toBe(secondCommit);
        expect(second.message).toContain("ship v2");
        expect(second.pulled).toBe(true);
        expect(second.restart).toBe(true);
        // the restart was REAL: the process got a new pid
        let pidAfter: string | undefined;
        for (let i = 0; i < 10 && !pidAfter; i++) {
          await new Promise((r) => setTimeout(r, 500));
          pidAfter = await pidOf();
        }
        expect(pidAfter).toBeTruthy();
        expect(pidAfter).not.toBe(pidBefore);
      } finally {
        await runCli(["kill"], home).catch(() => undefined);
        rmSync(home, { recursive: true, force: true });
        rmSync(gitRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );

  test(
    "deploying a process outside a git repo fails honestly",
    async () => {
      const home = freshHome("nogit");
      try {
        const script = join(home, "plain.ts");
        writeFileSync(script, "setInterval(() => {}, 1000);\n");
        await runCli(["cloud", "connect", mini.mintEnrollmentToken(), "--url", mini.url], home);
        await runCli(["start", script, "--name", "plain"], home);
        const serverId = (JSON.parse(await Bun.file(join(home, "cloud.json")).text()) as { serverId: string }).serverId;

        const result = await mini.dispatchCommand(serverId, "process.deploy", { target: "plain" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("is not a git repository");
      } finally {
        await runCli(["kill"], home).catch(() => undefined);
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
