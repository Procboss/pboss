/**
 * ProcBoss (pboss) — Cloud Deploy Job
 *
 * The agent-side half of ProcBoss Cloud Deployments (the target/batch
 * redesign): executes ONE (batch × target) run and streams
 * deploy.progress frames back to the cloud on the existing agent
 * WebSocket. Two strategies (spec §4):
 *
 *   release (created processes) — per-target layout under
 *   ~/.pboss/deploys/<slug>/:
 *
 *     <slug>/source/                    the git clone (full history — any
 *                                        SHA that ever deployed stays
 *                                        checkoutable)
 *     <slug>/releases/<sha8>-<ts>/      one built release per deployment
 *     <slug>/current -> releases/…      the ATOMIC swap point (symlink)
 *
 *   inplace (adopted processes) — the process's OWN working directory is
 *   the deploy target: backup → fetch → checkout -f <sha> → build →
 *   restart with the process's own definition (nothing is re-homed; no
 *   config file is read on this path, §4A).
 *
 * Backups (spec §7) live under ~/.pboss/backups/<targetId>/v<N>_<commit>/
 * for BOTH strategies — taken before anything touches the live code, so
 * "Revert to this" and the cloud's auto-rollback both restore a real
 * folder. Retention prunes oldest-first but NEVER the last-known-good.
 *
 * Safety contract with the cloud engine (mirrored on both sides):
 *   • the running version is never touched before the new code is fully
 *     built (build failure = no-op for production)
 *   • a failure AFTER the swap restores the previous state and restarts
 *     the process on it before reporting the error
 *   • restore (deploy.restore) is its own job: flip/copy the backup back,
 *     restart, report — the SAME mechanics a manual revert and the
 *     auto-rollback ride
 *
 * Auth: the tokenized clone URL arrives in the payload and is used ONLY
 * as a per-fetch http.extraheader — the remote in .git/config stays the
 * clean credential-free URL.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, existsSync, readlinkSync, symlinkSync, renameSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { PBOSS_HOME } from "./constants";
import { ignore } from "./error-handling";
import type { ProcessManager } from "./process-manager";
import type { CloudAgentFrame } from "./cloud";
import type { DeployRunPayload, DeployRestorePayload, DeployPurgePayload } from "./cloud";

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

/* ── roots ────────────────────────────────────────────────────────────── */

const RELEASES_KEPT = 10;

/**
 * Roots resolve PER JOB, not at import time. PBOSS_HOME is an environment
 * contract, but bun's test runner (and any embedder) can import this
 * module long before the env is pinned — an import-time root then aimed
 * test deploys at the REAL ~/.pboss: wrong root, failing assertions, and
 * home-dir pollution. Resolving at job start honors the env whenever it
 * was set, and falls back to the import-time PBOSS_HOME (same homedir
 * default) when it never was.
 */
function deploysRoot(): string {
  return join(process.env.PBOSS_HOME || PBOSS_HOME, "deploys");
}

function backupsRoot(): string {
  return join(process.env.PBOSS_HOME || PBOSS_HOME, "backups");
}

type JobCtx = {
  sendFrame: (frame: CloudAgentFrame) => boolean;
  pm: ProcessManager;
};

/* ── backups (§7) ──────────────────────────────────────────────────────── */

/**
 * Snapshot a live directory to ~/.pboss/backups/<targetId>/v<N>_<commit>/.
 * Prunes oldest-first beyond `retention` but NEVER the backup holding the
 * `keepCommit` (the last-known-good — the actual safety net). Returns the
 * new backup path + the pruned ones (the cloud maintains its registry).
 */
function backupDir(
  opts: {
    targetId: string;
    fromDir: string;
    commit: string;
    retention: number;
    keepCommit: string | null;
  },
): { backupPath: string; prunedPaths: string[] } {
  const safeTarget = opts.targetId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = join(backupsRoot(), safeTarget);
  mkdirSync(root, { recursive: true });

  // next version ordinal = max existing + 1
  let maxN = 0;
  const existing: Array<{ n: number; name: string }> = [];
  for (const entry of readdirSync(root)) {
    const m = /^v(\d+)_/.exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    maxN = Math.max(maxN, n);
    existing.push({ n, name: entry });
  }
  const commitPart = /^[0-9a-f]{7,40}$/.test(opts.commit) ? opts.commit : "live";
  const name = `v${maxN + 1}_${commitPart}`;
  const backupPath = join(root, name);

  cpSync(opts.fromDir, backupPath, { recursive: true });

  // prune oldest beyond retention — never the keepCommit's folder
  const pruned: string[] = [];
  const sorted = existing.sort((a, b) => a.n - b.n); // oldest first
  let over = sorted.length + 1 - opts.retention; // folders over budget
  for (const e of sorted) {
    if (over <= 0) break;
    if (opts.keepCommit && e.name.endsWith(`_${opts.keepCommit}`)) continue; // last-known-good stays even over budget
    try {
      rmSync(join(root, e.name), { recursive: true, force: true });
      pruned.push(join(root, e.name));
      over--;
    } catch {
      /* prune is best-effort */
    }
  }
  return { backupPath, prunedPaths: pruned };
}

/* ── the deploy job (both strategies) ─────────────────────────────────── */

export async function runDeployJob(
  ctx: JobCtx,
  payload: DeployRunPayload,
): Promise<void> {
  const t0 = Date.now();
  const job: RunningJob = { cancelled: false, children: new Set() };
  running.set(payload.deploymentId, job);

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
  const finish = (ok: boolean, error?: string, lines?: string[], extra?: Partial<DeployProgressFrame>) => {
    progress("done", lines, {
      success: ok,
      error,
      commit: payload.commitSha,
      durationMs: Date.now() - t0,
      ...extra,
    });
  };

  try {
    if (payload.strategy === "inplace") {
      await runInplaceDeploy(ctx, job, payload, { log, progress, finish });
    } else {
      await runReleaseDeploy(ctx, job, payload, { log, progress, finish });
    }
  } catch (err) {
    // a swap-time restore already ran where one was possible — build
    // failures happen BEFORE any swap and never touched production
    finish(false, err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(payload.deploymentId);
  }
}

type Prog = {
  log: (line: string) => string;
  progress: (step: DeployProgressFrame["step"], lines?: string[], extra?: Partial<DeployProgressFrame>) => void;
  finish: (ok: boolean, error?: string, lines?: string[], extra?: Partial<DeployProgressFrame>) => void;
};

/* ── strategy A: in-place (adopted processes, §4A) ───────────────────── */

/** The adopted process's own definition — its stable identity (§10). */
function findProcessDefinition(pm: ProcessManager, processName: string) {
  const proc = pm.list().find((p) => p.name === processName);
  if (!proc) return null;
  const env = proc.pboss_env ?? proc.bm2_env;
  if (!env?.cwd || !env?.script) return null;
  return { cwd: env.cwd, script: env.script, state: proc };
}

async function runInplaceDeploy(
  ctx: JobCtx,
  job: RunningJob,
  payload: DeployRunPayload,
  prog: Prog,
): Promise<void> {
  const { log, progress, finish } = prog;

  // the process must exist and carry a readable definition (§10: name =
  // stable identity; a restarted process never loses it)
  const def = findProcessDefinition(ctx.pm, payload.processName);
  if (!def) {
    throw new Error(
      `process "${payload.processName}" not found on this server — an adopted target needs the process to stay registered`,
    );
  }
  if (!existsSync(join(def.cwd, ".git"))) {
    throw new Error(`"${def.cwd}" (the working directory of ${payload.processName}) is not a git checkout`);
  }

  /* 1 — back the live directory up (§7): the real sha names the folder
   * (the cloud's `backupFromCommit` may be null on a first adopt — the
   * truth is what the checkout says). */
  progress("backing_up", [log(`backing up ${def.cwd}`)]);
  let liveSha = payload.backupFromCommit;
  if (!liveSha) {
    liveSha = await gitIn(def.cwd, "rev-parse", "HEAD").catch((err: unknown) => {
      ignore(`read live HEAD of ${def.cwd} (inplace backup naming)`, err);
      return null;
    });
  }
  let backupFacts: { backupPath: string; prunedPaths: string[] } | null = null;
  if (payload.targetId) {
    backupFacts = backupDir({
      targetId: payload.targetId,
      fromDir: def.cwd,
      commit: liveSha ?? "live",
      retention: payload.backupRetention,
      keepCommit: liveSha,
    });
    progress("backing_up", [log(`backup at ${backupFacts.backupPath}`)], {
      backupPath: backupFacts.backupPath,
      backupCommit: liveSha ?? undefined,
      prunedPaths: backupFacts.prunedPaths.length ? backupFacts.prunedPaths : undefined,
    });
  }

  /* 2 — fetch + verify the exact SHA in the process's own checkout */
  progress("cloning", [log(`fetching ${payload.commitSha.slice(0, 7)}`)]);
  await exec(job, payload, { cwd: def.cwd }, ["git", "remote", "set-url", "origin", payload.cleanRepoUrl]);
  await exec(job, payload, { cwd: def.cwd }, ["git", "fetch", "origin", "--force", "--prune", "+refs/heads/*:refs/remotes/origin/*"], (lines) => progress("cloning", lines));
  await exec(job, payload, { cwd: def.cwd }, ["git", "cat-file", "-e", `${payload.commitSha}^{commit}`]);

  /* 3 — the hard checkout: tracked files land exactly at the SHA. A
   * checkout failure leaves the tree untouched (git checks out to a temp
   * index first for -f with clean requirements). */
  progress("cloning", [log(`checking out ${payload.commitSha.slice(0, 7)}`)]);
  await exec(job, payload, { cwd: def.cwd }, ["git", "checkout", "-f", payload.commitSha]);

  /* 4 — install + build (the shared build command, §3) */
  const runDir = payload.workdir ? join(def.cwd, payload.workdir) : def.cwd;
  if (payload.buildCmd) {
    progress("installing", [log(payload.buildCmd)]);
    await exec(job, payload, { cwd: runDir, env: payload.env }, ["sh", "-c", payload.buildCmd], (lines) => progress("building", lines));
  }

  /* 5 — restart with the process's OWN definition (never a config file) */
  await restartAdopted(ctx, job, payload, def, prog);

  finish(true, undefined, [log(`live at ${def.cwd} @ ${payload.commitSha.slice(0, 7)}`)]);
}

/** Stop + start an adopted process on its own definition. */
async function restartAdopted(
  ctx: JobCtx,
  job: RunningJob,
  payload: DeployRunPayload,
  def: { cwd: string; script: string; state: NonNullable<ReturnType<typeof findProcessDefinition>>["state"] },
  prog: Prog,
): Promise<void> {
  const env = def.state.pboss_env ?? def.state.bm2_env!;
  prog.progress("deploying", [prog.log("restarting in place")]);
  try {
    await ctx.pm.stop(payload.processName);
  } catch {
    /* not running — fine */
  }
  prog.progress("starting", [prog.log(`starting ${payload.processName} on its own definition`)]);
  await ctx.pm.start({
    name: payload.processName,
    script: env.script,
    args: env.args,
    cwd: env.cwd,
    env: { ...(env.env ?? {}), ...payload.env, PBOSS_DEPLOY_COMMIT: payload.commitSha },
    instances: env.instances,
    execMode: env.execMode,
    autorestart: env.autorestart !== false,
  });
  void job;
}

/* ── strategy B: release (created processes, §4B) ─────────────────────── */

async function runReleaseDeploy(
  ctx: JobCtx,
  job: RunningJob,
  payload: DeployRunPayload,
  prog: Prog,
): Promise<void> {
  const { log, progress, finish } = prog;

  const DEPLOYS_ROOT = deploysRoot();
  const slug = payload.processName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = join(DEPLOYS_ROOT, slug);
  const sourceDir = join(root, "source");
  const releasesDir = join(root, "releases");
  const currentLink = join(root, "current");
  const workdir = payload.workdir ? payload.workdir.replace(/^\/+|\/+$/g, "") : "";

  mkdirSync(releasesDir, { recursive: true });

  const priorCurrent = existsSync(currentLink)
    ? resolve(dirname(currentLink), readlinkSync(currentLink))
    : null;

  /* 0a — legacy rollback fast path: the release for this SHA may already
   * exist (restoring a previous deployment reuses its built release when
   * it's still on disk: seconds, not a full rebuild). The cloud's new
   * restore command (deploy.restore) carries its own version of this. */
  if (payload.mode === "rollback") {
    const existing = findReleaseForSha(releasesDir, payload.commitSha);
    if (existing) {
      progress("deploying", [log(`reusing existing release ${dirname(existing)}`)]);
      let startCmd = payload.startCmd;
      let startCwd: string | null = null;
      let startEnv: Record<string, string> = {};
      if (!startCmd && payload.configFile && payload.configApp) {
        const app = await evalConfigApp(existing, payload.configFile, payload.configApp);
        startCmd = app.script;
        startCwd = app.cwd;
        startEnv = app.env;
      }
      if (!startCmd) throw new Error("no start command available for the rollback");
      await flipAndStart(ctx, job, payload, currentLink, existing, workdir, progress, startCmd, startCwd, startEnv);
      finish(true, undefined, [log("restored from the existing release")]);
      return;
    }
  }

  /* 0 — back the current release up BEFORE anything touches it (§7) */
  if (priorCurrent && payload.targetId) {
    progress("backing_up", [log(`backing up ${priorCurrent}`)]);
    let liveSha = payload.backupFromCommit;
    if (!liveSha) {
      // the release folder name leads with sha8 — widen from the source
      liveSha = await gitIn(sourceDir, "rev-parse", "HEAD").catch((err: unknown) => {
        ignore(`read live HEAD of ${sourceDir} (release backup naming)`, err);
        return null;
      });
    }
    const backupFacts = backupDir({
      targetId: payload.targetId,
      fromDir: priorCurrent,
      commit: liveSha ?? "live",
      retention: payload.backupRetention,
      keepCommit: liveSha,
    });
    progress("backing_up", [log(`backup at ${backupFacts.backupPath}`)], {
      backupPath: backupFacts.backupPath,
      backupCommit: liveSha ?? undefined,
      prunedPaths: backupFacts.prunedPaths.length ? backupFacts.prunedPaths : undefined,
    });
  }

  /* 1 — clone / fetch the exact SHA */
  progress("cloning", [log(`fetching ${payload.commitSha.slice(0, 7)} from ${payload.cleanRepoUrl}`)]);
  const releaseName = `${payload.commitSha.slice(0, 8)}-${Date.now()}`;
  const releaseDir = join(releasesDir, releaseName);

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
  // never .git/config. Fetches into refs/remotes/* (remote-tracking).
  await exec(job, payload, { cwd: sourceDir }, ["git", "fetch", "origin", "--force", "--prune", "+refs/heads/*:refs/remotes/origin/*"], (lines) => progress("cloning", lines));
  // the SHA must EXIST locally — never deploy an ambiguous branch state
  await exec(job, payload, { cwd: sourceDir }, ["git", "cat-file", "-e", `${payload.commitSha}^{commit}`]);

  /* 2 — release dir from the exact commit */
  progress("cloning", [log(`creating release ${releaseName} (git archive)`)]);
  mkdirSync(releaseDir, { recursive: true });
  await exec(job, payload, { cwd: sourceDir }, [
    "sh",
    "-c",
    `git archive ${payload.commitSha} | tar -x -C ${shellQuote(releaseDir)}`,
  ]);

  /* 3 — resolve the start command (§4B): the config file's app entry is
   * the authority — never hand-typed. Legacy payloads may carry startCmd. */
  let startCmd = payload.startCmd;
  let startCwd: string | null = null;
  let startEnv: Record<string, string> = {};
  if (!startCmd && payload.configFile && payload.configApp) {
    const app = await evalConfigApp(releaseDir, payload.configFile, payload.configApp);
    startCmd = app.script;
    startCwd = app.cwd;
    startEnv = app.env;
    progress("cloning", [log(`start command from ${payload.configFile} [${payload.configApp}]: ${startCmd}`)]);
  }
  if (!startCmd) {
    throw new Error("no start command: created processes need a config file app entry");
  }

  /* 4 — install + build */
  const runDir = workdir ? join(releaseDir, workdir) : releaseDir;
  if (!existsSync(runDir)) {
    throw new Error(`working directory "${payload.workdir}" does not exist in the repository`);
  }
  if (payload.installCmd) {
    progress("installing", [log(payload.installCmd)]);
    await exec(job, payload, { cwd: runDir, env: payload.env }, ["sh", "-c", payload.installCmd], (lines) => progress("installing", lines));
  }
  if (payload.buildCmd) {
    progress("building", [log(payload.buildCmd)]);
    await exec(job, payload, { cwd: runDir, env: payload.env }, ["sh", "-c", payload.buildCmd], (lines) => progress("building", lines));
  }

  /* 5 — the swap + (re)start (restore the prior symlink on failure) */
  try {
    await flipAndStart(ctx, job, payload, currentLink, releaseDir, workdir, progress, startCmd, startCwd, startEnv);
  } catch (err) {
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
          script: startCmd,
          cwd: workdir ? join(currentLink, workdir) : currentLink,
          env: { ...startEnv, ...payload.env },
          autorestart: true,
        });
      } catch (rollbackErr) {
        const rb = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`${err instanceof Error ? err.message : String(err)}; rollback failed: ${rb}`);
      }
    }
    throw err;
  }

  /* 6 — GC old releases (keep the newest N — restore range) */
  try {
    const { execFile } = await import("node:child_process");
    execFile("sh", ["-c", `ls -dt ${shellQuote(releasesDir)}/*/ | tail -n +${RELEASES_KEPT + 1} | xargs -r rm -rf`]);
  } catch {
    /* GC is best-effort */
  }

  finish(true, undefined, [log(`live at ${releaseDir}`)]);
}

/* ── the config-file evaluation (§4B — the file is the authority) ─────── */

type ConfigAppEntry = { script: string; cwd: string | null; env: Record<string, string> };

/**
 * Read one app entry out of a repo config file (pboss/ecosystem/pm2 or a
 * user-designated one). .json parses exactly; .js/.ts load as a module
 * (the authoritative read — the wizard's GitHub-side parse is a preview).
 * The entry must carry the picked app's name — never silently the first.
 */
export async function evalConfigApp(
  baseDir: string,
  configFile: string,
  configApp: string,
): Promise<ConfigAppEntry> {
  const path = resolve(baseDir, configFile);
  if (!path.startsWith(resolve(baseDir) + "/")) {
    throw new Error(`config file "${configFile}" escapes the repository`);
  }
  if (!existsSync(path)) {
    throw new Error(`config file "${configFile}" not found in the repository`);
  }

  let apps: Array<Record<string, unknown>> = [];
  if (path.endsWith(".json")) {
    const { readFileSync } = await import("node:fs");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    apps = normalizeConfigApps(parsed);
  } else {
    // module load — the file's own semantics win
    const mod = (await import(`file://${path}`)) as unknown as {
      default?: unknown;
      apps?: unknown;
    };
    const exported: unknown = mod.default ?? mod.apps ?? mod;
    apps = normalizeConfigApps(exported);
  }

  const entry = apps.find((a) => typeof a.name === "string" && a.name === configApp);
  if (!entry) {
    throw new Error(`app "${configApp}" no longer exists in ${configFile} — re-run the wizard for this target`);
  }
  if (typeof entry.script !== "string" || !entry.script.trim()) {
    throw new Error(`app "${configApp}" in ${configFile} has no script`);
  }
  const env: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object") {
    for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  return {
    script: entry.script.trim(),
    cwd: typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : null,
    env,
  };
}

function normalizeConfigApps(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.apps)) {
      return obj.apps.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
    }
    return [obj];
  }
  return [];
}

/* ── the restore job (deploy.restore — reverts + auto-rollback, §7) ───── */

export async function runRestoreJob(
  ctx: JobCtx,
  payload: DeployRestorePayload,
): Promise<void> {
  const t0 = Date.now();
  const job: RunningJob = { cancelled: false, children: new Set() };
  running.set(payload.deploymentId, job);

  const log = (line: string) => `[restore ${payload.processName}] ${line}`;
  const progress = (step: DeployProgressFrame["step"], lines?: string[]) => {
    ctx.sendFrame({
      type: "deploy.progress",
      progress: {
        deploymentId: payload.deploymentId,
        step,
        logs: lines?.filter((l) => l.trim()).slice(-40),
      } as DeployProgressFrame,
    });
  };
  const finish = (ok: boolean, error?: string, lines?: string[]) => {
    ctx.sendFrame({
      type: "deploy.progress",
      progress: {
        deploymentId: payload.deploymentId,
        step: "done",
        success: ok,
        error,
        logs: lines?.filter((l) => l.trim()).slice(-40),
        commit: payload.commitSha,
        durationMs: Date.now() - t0,
      } as DeployProgressFrame,
    });
  };

  try {
    progress("restoring", [log(`restoring ${payload.backupPath}`)]);
    if (!existsSync(payload.backupPath)) {
      throw new Error(`backup ${payload.backupPath} no longer exists on this server`);
    }

    if (payload.strategy === "release") {
      /* release: flip current to the backup (reusing a built release for
       * the same commit when one survives — seconds, not a copy) */
      const DEPLOYS_ROOT = deploysRoot();
      const slug = payload.processName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const root = join(DEPLOYS_ROOT, slug);
      const releasesDir = join(root, "releases");
      const currentLink = join(root, "current");
      mkdirSync(releasesDir, { recursive: true });

      let target = findReleaseForSha(releasesDir, payload.commitSha);
      if (!target) {
        const releaseDir = join(releasesDir, `${payload.commitSha.slice(0, 8)}-${Date.now()}`);
        cpSync(payload.backupPath, releaseDir, { recursive: true });
        target = releaseDir;
        progress("restoring", [log(`copied the backup into ${releaseDir}`)]);
      } else {
        progress("restoring", [log(`reusing release ${dirname(target)}`)]);
      }

      // the start command comes from the RESTORED code's own config file
      let startCmd = payload.startCmd;
      let startCwd: string | null = null;
      let startEnv: Record<string, string> = {};
      if (!startCmd && payload.configFile && payload.configApp) {
        const app = await evalConfigApp(target, payload.configFile, payload.configApp);
        startCmd = app.script;
        startCwd = app.cwd;
        startEnv = app.env;
      }
      if (!startCmd) {
        throw new Error("no start command: created processes need a config file app entry");
      }

      const tmpLink = `${currentLink}.tmp-${Date.now()}`;
      symlinkSync(target, tmpLink);
      try {
        renameSync(tmpLink, currentLink);
      } catch {
        rmSync(tmpLink, { force: true });
        throw new Error("symlink flip failed");
      }
      progress("starting", [log(`restarting ${payload.processName}`)]);
      try {
        await ctx.pm.stop(payload.processName);
      } catch { /* not running */ }
      await ctx.pm.start({
        name: payload.processName,
        script: startCmd,
        cwd: startCwd ? join(currentLink, startCwd) : currentLink,
        env: { ...startEnv, ...payload.env, PBOSS_DEPLOY_COMMIT: payload.commitSha },
        autorestart: true,
      });
    } else {
      /* in-place: swap the process's own directory for the backup */
      const def = findProcessDefinition(ctx.pm, payload.processName);
      if (!def) {
        throw new Error(`process "${payload.processName}" not found on this server`);
      }
      const displaced = `${def.cwd}.pboss-restore-${Date.now()}`;
      renameSync(def.cwd, displaced);
      try {
        cpSync(payload.backupPath, def.cwd, { recursive: true });
      } catch (err) {
        // put the live dir back before failing — never leave a hole
        renameSync(displaced, def.cwd);
        throw err;
      }
      progress("starting", [log(`restarting ${payload.processName} on the restored directory`)]);
      try {
        await ctx.pm.stop(payload.processName);
      } catch { /* not running */ }
      const env = def.state.pboss_env ?? def.state.bm2_env!;
      await ctx.pm.start({
        name: payload.processName,
        script: env.script,
        args: env.args,
        cwd: env.cwd,
        env: { ...(env.env ?? {}), ...payload.env, PBOSS_DEPLOY_COMMIT: payload.commitSha },
        instances: env.instances,
        execMode: env.execMode,
        autorestart: env.autorestart !== false,
      });
      rmSync(displaced, { recursive: true, force: true });
    }

    finish(true, undefined, [log(`restored ${payload.commitSha.slice(0, 7)}`)]);
  } catch (err) {
    finish(false, err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(payload.deploymentId);
  }
}

/* ── the purge job (deploy.purge — Remove + delete files, §5) ──────────── */

export async function runPurgeJob(
  ctx: JobCtx,
  payload: DeployPurgePayload,
): Promise<{ purged: true }> {
  const log = (line: string) => `[purge ${payload.processName}] ${line}`;

  // backups always go
  const safeTarget = payload.targetId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const backupPath = join(backupsRoot(), safeTarget);
  if (existsSync(backupPath)) {
    rmSync(backupPath, { recursive: true, force: true });
  }

  if (payload.strategy === "release") {
    // the created process's whole deploy tree + the process itself
    const slug = payload.processName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const root = join(deploysRoot(), slug);
    try {
      await ctx.pm.stop(payload.processName);
    } catch { /* not running */ }
    try {
      await ctx.pm.del(payload.processName);
    } catch { /* not registered */ }
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // adopted processes keep their own directory — only the backups were ours

  return { purged: true };
}

/* ── exec helper: streams output tail lines as progress logs ─────────── */

function exec(
  job: RunningJob,
  payload: DeployRunPayload,
  opts: { cwd: string; env?: Record<string, string> },
  command: [string, ...string[]],
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
      // windowsHide (issue #36 follow-up): deploy jobs run inside the
      // console-less daemon — build/git commands would pop VISIBLE consoles.
      windowsHide: true,
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
  return m?.[1] ?? "";
}

/** One git command in a directory — plain output, no job machinery. */
function gitIn(cwd: string, ...args: string[]): Promise<string> {
  return new Promise<string>((res, rej) => {
    const c = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    c.stdout?.on("data", (b) => (out += b.toString()));
    c.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error(`git ${args.join(" ")} exited ${code}`))));
    c.on("error", rej);
  });
}

/** The atomic swap + process (re)start — shared by deploy and restore. */
async function flipAndStart(
  ctx: JobCtx,
  job: RunningJob,
  payload: DeployRunPayload,
  currentLink: string,
  releaseDir: string,
  workdir: string,
  progress?: (step: DeployProgressFrame["step"], lines?: string[]) => void,
  startCmd?: string | null,
  startCwd?: string | null,
  startEnv?: Record<string, string>,
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
    script: startCmd ?? payload.startCmd!,
    cwd: startCwd
      ? join(currentLink, startCwd)
      : workdir
        ? join(currentLink, workdir)
        : currentLink,
    env: { ...(startEnv ?? {}), ...payload.env, PBOSS_DEPLOY_COMMIT: payload.commitSha },
    autorestart: true,
  });
  void job;
}

/** Find an existing built release for a commit SHA (restore fast path). */
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
      const c = spawn("git", args, { cwd, windowsHide: true });
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
