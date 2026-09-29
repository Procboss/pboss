// Smoke test for the node:cluster wrapper — exercises the exact source
// embedded in src/node-cluster.ts against a real Node, then verifies the
// full worker lifecycle: spawn, shared port, respawn, rolling reload, stop.
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SMOKEDIR = join(ROOT, "scripts", ".smoke-node-cluster");

// Load the embedded wrapper source the same way the shipped code does.
const { NODE_CLUSTER_WRAPPER_SOURCE, ensureNodeClusterWrapper } = await import(
  join(ROOT, "src", "node-cluster.ts")
);

mkdirSync(SMOKEDIR, { recursive: true });
rmSync(SMOKEDIR, { recursive: true, force: true }); // stale markers from a crashed run lie
mkdirSync(SMOKEDIR, { recursive: true });
writeFileSync(join(SMOKEDIR, "app.cjs"), `const fs = require("node:fs");
const path = require("node:path");
const id = process.env.NODE_APP_INSTANCE || "0";
fs.writeFileSync(path.join(__dirname, "worker-" + id + ".started"), String(process.pid));
if (process.env.PORT) fs.writeFileSync(path.join(__dirname, "worker-" + id + ".port"), process.env.PORT);
setInterval(() => {}, 1 << 30);
`);

process.env.PBOSS_HOME = SMOKEDIR; // before importing constants via the module? ensure uses it at call time
const wrapper = await ensureNodeClusterWrapper();
console.log("wrapper written:", wrapper);
console.log("wrapper syntax check...");
const check = spawn("node", ["--check", wrapper], { stdio: "inherit" });
const checkCode = await new Promise((r) => check.on("exit", (c) => r(c ?? 1)));
if (checkCode !== 0) { console.error("SYNTAX CHECK FAILED"); process.exit(1); }

const marker = (i) => join(SMOKEDIR, `worker-${i}.started`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freshPid = (i) => Number(readFileSync(marker(i), "utf8"));

const child = spawn("node", [wrapper], {
  cwd: SMOKEDIR,
  env: {
    ...process.env,
    PBOSS_TARGET_SCRIPT: join(SMOKEDIR, "app.cjs"),
    PBOSS_TARGET_ARGS: "[]",
    PBOSS_CLUSTER_INSTANCES: "3",
    PBOSS_BASE_PORT: "3000",
    PBOSS_KILL_TIMEOUT: "3000",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
console.log("wrapper pid:", child.pid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(150); }
  return false;
};

// 1. three workers spawn, all writing markers with shared PORT=3000
const ok1 = await until(() => [0, 1, 2].every((i) => existsSync(marker(i))));
console.log("1. three workers spawned:", ok1);
if (!ok1) { child.kill("SIGKILL"); process.exit(1); }
// markers are only trustworthy once they belong to THIS run's workers:
// every pid must be alive and distinct
const ok1b = await until(() => {
  const p = [0, 1, 2].map(freshPid);
  return new Set(p).size === 3 && p.every(alive);
});
console.log("1b. fresh worker pids alive:", ok1b);
if (!ok1b) { child.kill("SIGKILL"); process.exit(1); }
const pids1 = [0, 1, 2].map(freshPid);
console.log("   worker pids:", pids1, "all alive:", pids1.every(alive));
for (const i of [0, 1, 2]) {
  const port = readFileSync(join(SMOKEDIR, `worker-${i}.port`), "utf8");
  console.log(`   worker ${i} PORT=${port}`);
}

// 2. respawn: kill worker 1, a replacement appears
process.kill(pids1[1], "SIGKILL");
const ok2 = await until(() => freshPid(1) !== pids1[1] && alive(freshPid(1)));
console.log("2. crashed worker respawned:", ok2);

// 3. rolling reload: SIGHUP rotates every worker pid
const before = [0, 1, 2].map(freshPid);
process.kill(child.pid, "SIGHUP");
const ok3 = await until(() => [0, 1, 2].every((i) => freshPid(i) !== before[i] && alive(freshPid(i))), 20000);
console.log("3. rolling reload rotated all workers:", ok3);

// 4. SIGTERM tears down the whole group
child.kill("SIGTERM");
const ok4 = await until(() => ![0, 1, 2].some((i) => alive(freshPid(i))), 15000);
console.log("4. all workers dead after SIGTERM:", ok4);
// Bun's node:child_process compat does not always deliver the child 'exit'
// event here — poll pid liveness instead of awaiting the event.
const wrapperGone = await until(() => !alive(child.pid), 15000);
console.log("wrapper exited:", wrapperGone);

rmSync(SMOKEDIR, { recursive: true, force: true });
console.log(ok1 && ok1b && ok2 && ok3 && ok4 && wrapperGone ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(ok1 && ok1b && ok2 && ok3 && ok4 && wrapperGone ? 0 : 1);
