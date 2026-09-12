/**
 * ProcBoss (pboss) — Cloud Deploy Job
 *
 * The agent-side half of ProcBoss Auto Deploy: executes ONE deployment
 * (exact commit SHA → release → atomic symlink swap → process restart)
 * and streams deploy.progress frames back to the cloud on the existing
 * agent WebSocket.
 *
 * Layout per target (slug of the process name) under ~/.pboss/deploys/:
 *
 *   <slug>/source/                    the git clone (full history — any SHA
 *                                      that ever deployed stays checkoutable)
 *   <slug>/releases/<sha8>-<ts>/      one built release per deployment
 *   <slug>/current -> releases/…      the ATOMIC swap point (symlink flip)
 *
 * Safety contract with the cloud engine (mirrored on both sides):
 *   • the running version is never touched before the new release is
 *     fully built (build failure = no-op for production)
 *   • a failure AFTER the symlink flip restores the previous symlink and
 *     restarts the process on it before reporting the error
 *   • rollback is just a deploy whose commit SHA is an old one — if the
 *     release dir still exists it is reused (seconds, not minutes)
 *
 * Auth: the tokenized clone URL arrives in the payload and is used ONLY
 * as a per-fetch http.extraheader — the remote in .git/config stays the
 * clean credential-free URL.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readlinkSync, symlinkSync, renameSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { PBOSS_HOME } from "./constants";
import type { ProcessManager } from "./process-manager";
import type { CloudAgentFrame } from "./cloud";
import type { DeployRunPayload } from "./cloud";

/* ── wire payload (mirror of the cloud's DeployRunPayload) ───────────── */

export type DeployProgressFrame = Extract<CloudAgentFrame, { type: "deploy.progress" }>["progress"];

/* ── job registry (cancel support) ───────────────────────────────────── */

type RunningJob = {
  cancelled: boolean;
  children: Set<ReturnType<typeof spawn>>;
};

const running = new Map<string, RunningJob>();

/** Is a job for this deployment already executing? (deploy.run dedup) */
export function deployJobRunning(deploymentId: string): boolean {
  return running.has(deploymentId);
}

export function cancelDeployJob(deploymentId: string): boolean {
  const job = running.get(deploymentId);
  if (!job) return false;
  job.cancelled = true;
  for (const child of job.children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  return true;
}

/* ── the job ─────────────────────────────────────────────────────────── */

const DEPLOYS_ROOT = join(PBOSS_HOME, "deploys");
const RELEASES_KEPT = 10;

type JobCtx = {
  sendFrame: (frame: CloudAgentFrame) => boolean;
  pm: ProcessManager;
};

export async function runDeployJob(
  ctx: JobCtx,
  payload: DeployRunPayload,
): Promise<void> {
  const t0 = Date.now();
  const job: RunningJob = { cancelled: false, children: new Set() };
  running.set(payload.deploymentId, job);

  const slug = payload.processName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = join(DEPLOYS_ROOT, slug);
  const sourceDir = join(root, "source");
  const releasesDir = join(root, "releases");
  const currentLink = join(root, "current");
  const workdir = payload.workdir ? payload.workdir.replace(/^\/+|\/+$/g, "") : "";

  const log = (line: string) => `[deploy ${payload.processName}] ${line}`;
  const progress = (step: DeployProgressFrame["step"], lines?: string[], extra?: Partial<DeployProgressFrame>) => {
    ctx.sendFrame({
      type: "deploy.progress",
      progress: {
        deploymentId: payload.deploymentId,
        step,
        logs: lines?.filter((l) => l.trim()).slice(-40),
        ...extra,
      } as DeployProgressFrame,
    });
  };
  const finish = (ok: boolean, error?: string, lines?: string[]) => {
    progress("done", lines, {
      success: ok,
      error,
      commit: payload.commitSha,
      durationMs: Date.now() - t0,
    });
  };

  try {
    mkdirSync(releasesDir, { recursive: true });

    /* ── 0. rollback fast path: the release for this SHA may already exist ──
     * (spec §11 — restoring a previous deployment reuses its built
     * release when it's still on disk: seconds, not a full rebuild) */
    if (payload.mode === "rollback") {
      const existing = findReleaseForSha(releasesDir, payload.commitSha);
      if (existing) {
        progress("deploying", [log(`reusing existing release ${dirname(existing)}`)]);
        await flipAndStart(ctx, job, payload, currentLink, existing, workdir);
        finish(true, undefined, [log("restored from the existing release")]);
        return;
      }
    }

    /* ── 1. clone / fetch the exact SHA ── */
    progress("cloning", [log(`fetching ${payload.commitSha.slice(0, 7)} from ${payload.cleanRepoUrl}`)]);
    const releaseName = `${payload.commitSha.slice(0, 8)}-${Date.now()}`;
    const releaseDir = join(releasesDir, releaseName);

    const priorCurrent = existsSync(currentLink)
      ? resolve(dirname(currentLink), readlinkSync(currentLink))
      : null;

    if (!existsSync(join(sourceDir, ".git"))) {
      await exec(job, payload, { cwd: DEPLOYS_ROOT }, [
        "git",
        "clone",
        "--no-checkout",
        payload.cleanRepoUrl,
        sourceDir,
      ]);
    } else {
      // keep the remote honest (re-pointing after a provider-side change)
      await exec(job, payload, { cwd: sourceDir }, ["git", "remote", "set-url", "origin", payload.cleanRepoUrl]);
    }
    // authenticated fetch: token rides a per-invocation http.extraheader,
    // never .git/config. Fetches into refs/remotes/* (remote-tracking) —
    // never refs/heads/* (a checked-out HEAD makes git refuse the force
    // update, and touching local branches invites corruption).
    await exec(job, payload, { cwd: sourceDir }, ["git", "fetch", "origin", "--force", "--prune", "+refs/heads/*:refs/remotes/origin/*"], (lines) => progress("cloning", lines));
    // the SHA must EXIST locally — never deploy an ambiguous branch state
    await exec(job, payload, { cwd: sourceDir }, ["git", "cat-file", "-e", `${payload.commitSha}^{commit}`]);

    /* ── 2. release dir from the exact commit ── */
    progress("cloning", [log(`creating release ${releaseName} (git archive)`)]);
    mkdirSync(releaseDir, { recursive: true });
    await exec(job, payload, { cwd: sourceDir }, [
      "sh",
      "-c",
      `git archive ${payload.commitSha} | tar -x -C ${shellQuote(releaseDir)}`,
    ]);

    /* ── 3. install ── */
    const runDir = workdir ? join(releaseDir, workdir) : releaseDir;
    if (!existsSync(runDir)) {
      throw new Error(`working directory "${payload.workdir}" does not exist in the repository`);
    }
    if (payload.installCmd) {
      progress("installing", [log(payload.installCmd)]);
      await exec(job, payload, { cwd: runDir, env: payload.env }, ["sh", "-c", payload.installCmd], (lines) => progress("installing", lines));
    }

    /* ── 4. build ── */
    if (payload.buildCmd) {
      progress("building", [log(payload.buildCmd)]);
      await exec(job, payload, { cwd: runDir, env: payload.env }, ["sh", "-c", payload.buildCmd], (lines) => progress("building", lines));
    }

    /* ── 5-6. the swap + (re)start ── */
    let swapped = false;
    try {
      await flipAndStart(ctx, job, payload, currentLink, releaseDir, workdir, progress);
      swapped = true;
    } catch (err) {
      // a failure mid-swap/mid-start with a prior release on disk → restore
      if (priorCurrent && existsSync(priorCurrent)) {
        try {
          await exec(job, payload, { cwd: DEPLOYS_ROOT }, [
            "sh", "-c", `ln -sfn ${shellQuote(priorCurrent)} ${shellQuote(currentLink)}`,
          ]);
          progress("deploying", [log(`restored previous release ${priorCurrent}`)]);
          try {
            await ctx.pm.stop(payload.processName);
          } catch { /* not running */ }
          await ctx.pm.start({
            name: payload.processName,
            script: payload.startCmd,
            cwd: workdir ? join(currentLink, workdir) : currentLink,
            env: { ...payload.env },
            autorestart: true,
          });
        } catch (rollbackErr) {
          const rb = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          throw new Error(`${err instanceof Error ? err.message : String(err)}; rollback failed: ${rb}`);
        }
      }
      throw err;
    }
    void swapped;

    /* ── 7. GC old releases (keep the newest N — rollback range) ── */
    try {
      const { execFile } = await import("node:child_process");
      execFile("sh", ["-c", `ls -dt ${shellQuote(releasesDir)}/*/ | tail -n +${RELEASES_KEPT + 1} | xargs -r rm -rf`]);
    } catch {
      /* GC is best-effort */
    }

    finish(true, undefined, [log(`live at ${releaseDir}`)]);
  } catch (err) {
    // the swap-time restore already ran (or there was nothing to restore —
    // build failures happen BEFORE the swap and never touched production)
    finish(false, err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(payload.deploymentId);
  }
}

/* ── exec helper: streams output tail lines as progress logs ─────────── */

function exec(
  job: RunningJob,
  payload: DeployRunPayload,
  opts: { cwd: string; env?: Record<string, string> },
  command: string[],
  onLines?: (lines: string[]) => void,
): Promise<{ code: number; output: string[] }> {
  return new Promise((resolveExec, rejectExec) => {
    // authenticated git via the tokenized URL — the header rides git's
    // env-config (GIT_CONFIG_*), never .git/config, never argv
    const gitAuth: Record<string, string> = {};
    const token = extractToken(payload.repoUrl);
    if (command[0] === "git" && token && command[1] !== "remote" && command[1] !== "cat-file") {
      gitAuth.GIT_CONFIG_COUNT = "1";
      gitAuth.GIT_CONFIG_KEY_0 = `http.${payload.cleanRepoUrl}.extraheader`;
      gitAuth.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
        `x-access-token:${token}`,
      ).toString("base64")}`;
    }

    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        GIT_TERMINAL_PROMPT: "0", // never hang asking for credentials
        ...gitAuth,
      },
    });
    job.children.add(child);

    const output: string[] = [];
    const tail = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split("\n")) {
        const t = line.trim();
        if (t) output.push(t.slice(0, 500));
      }
      onLines?.(output.slice(-4)); // live tail (bounded per frame)
    };

    child.stdout?.on("data", tail);
    child.stderr?.on("data", tail);
    child.on("error", (err) => {
      job.children.delete(child);
      rejectExec(new Error(`${command[0]} failed to spawn: ${err.message}`));
    });
    child.on("close", (code) => {
      job.children.delete(child);
      if (job.cancelled) {
        rejectExec(new Error("cancelled"));
        return;
      }
      if (code === 0) resolveExec({ code, output });
      else
        rejectExec(
          new Error(
            `${command.slice(0, 3).join(" ")} exited ${code}: ${output.slice(-3).join(" / ").slice(0, 500)}`,
          ),
        );
    });
  });
}

function extractToken(repoUrl: string): string {
  const m = /^https:\/\/x-access-token:([^@]+)@/.exec(repoUrl);
  return m ? m[1] : "";
}

/** The atomic swap + process (re)start — shared by deploy and the
 * rollback fast path. */
async function flipAndStart(
  ctx: JobCtx,
  job: RunningJob,
  payload: DeployRunPayload,
  currentLink: string,
  releaseDir: string,
  workdir: string,
  progress?: (step: DeployProgressFrame["step"], lines?: string[]) => void,
): Promise<void> {
  progress?.("deploying", [`[deploy ${payload.processName}] flipping the current symlink`]);
  const tmpLink = `${currentLink}.tmp-${Date.now()}`;
  symlinkSync(releaseDir, tmpLink);
  try {
    renameSync(tmpLink, currentLink); // atomic replace (rename over a symlink)
  } catch {
    rmSync(tmpLink, { force: true });
    throw new Error("symlink flip failed");
  }

  progress?.("starting", [`[deploy ${payload.processName}] ${payload.mode === "new" ? "starting" : "restarting"} ${payload.processName}`]);
  try {
    await ctx.pm.stop(payload.processName);
  } catch {
    /* not running (or never existed) — fine */
  }
  await ctx.pm.start({
    name: payload.processName,
    script: payload.startCmd,
    cwd: workdir ? join(currentLink, workdir) : currentLink,
    env: { ...payload.env, PBOSS_DEPLOY_COMMIT: payload.commitSha },
    autorestart: true,
  });
}

/** Find an existing built release for a commit SHA (rollback fast path). */
function findReleaseForSha(releasesDir: string, commitSha: string): string | null {
  const prefix = commitSha.slice(0, 8);
  try {
    const entries = readdirSync(releasesDir);
    const hit = entries.filter((e) => e.startsWith(`${prefix}-`)).sort().pop();
    return hit ? join(releasesDir, hit) : null;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/* ── process.gitinfo — the §3 verification primitive ─────────────────── */

export async function gitInfoForProcess(
  pm: ProcessManager,
  target: string,
): Promise<{ remote: string | null; branch: string | null; commit: string | null; exists: boolean }> {
  const list = pm.list();
  const proc = list.find((p) => p.name === target || String(p.pm_id) === target || String(p.id) === target);
  if (!proc) throw new Error(`no process named "${target}"`);
  const env = proc.pboss_env ?? proc.bm2_env;
  const cwd = env?.cwd || (env?.script ? dirname(env.script) : "");
  if (!cwd) return { remote: null, branch: null, commit: null, exists: false };
  const git = async (...args: string[]) =>
    new Promise<string>((res, rej) => {
      const c = spawn("git", args, { cwd });
      let out = "";
      c.stdout?.on("data", (b) => (out += b.toString()));
      c.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error(`git ${args.join(" ")} exited ${code}`))));
      c.on("error", rej);
    });
  if (!existsSync(join(cwd, ".git"))) {
    return { remote: null, branch: null, commit: null, exists: false };
  }
  try {
    const remote = await git("remote", "get-url", "origin");
    let branch: string | null = null;
    let commit: string | null = null;
    try {
      branch = await git("rev-parse", "--abbrev-ref", "HEAD");
      commit = await git("rev-parse", "HEAD");
    } catch {
      /* fresh clone states */
    }
    return { remote: remote || null, branch, commit, exists: true };
  } catch {
    return { remote: null, branch: null, commit: null, exists: false };
  }
}
