/**
 * Live crash-report e2e (Task 131) — the AGENT side.
 *
 * Runs the owner's exact crash repro (the setInterval that throws at
 * c == 5) under a REAL ProcessManager and a REAL CloudAgent linked to
 * the cloud given on argv — the full daemon path minus the RPC shell.
 * Exits 0 once the demo left the running set AND one report cycle has
 * passed (the crash event flew), 1 on timeout (no crash observed), 2 on
 * bad usage.
 *
 * Usage:
 *   bun scripts/e2e-crash-live.ts <PBOSS_HOME> <cloudUrl> <serverId> \
 *        <serverSecret> <serverName> <demoScriptPath>
 */
const [, , home, cloudUrl, serverId, serverSecret, serverName, demoScript] = process.argv;
if (!home || !cloudUrl || !serverId || !serverSecret || !serverName || !demoScript) {
  console.error(
    "usage: bun scripts/e2e-crash-live.ts <PBOSS_HOME> <cloudUrl> <serverId> <serverSecret> <serverName> <demoScript>",
  );
  process.exit(2);
}
// PBOSS_HOME must be pinned BEFORE importing cloud.ts (module-load read)
process.env.PBOSS_HOME = home;
delete process.env.PBOSS_CLOUD_REPORT_MS;

const { CloudAgent } = await import("../src/cloud");
const { ProcessManager } = await import("../src/process-manager");

const pm = new ProcessManager();
// 5s reports (pinned locally) — the crash event rides the next one
const agent = new CloudAgent(pm, { reportIntervalMs: 5_000 });
agent.start({ cloudUrl, serverId, serverSecret, serverName });

// the owner's repro: no autorestart — it crashes and STOPS
await pm.start({
  name: "demo",
  script: demoScript,
  interpreter: "bun",
  autorestart: false,
});
console.log("[e2e-agent] demo started — 10s ticks, throws at the 6th (~60s)");

async function shutdown(code: number): Promise<never> {
  await agent.stop({ revoke: false, quiet: true }).catch(() => undefined);
  await pm.stopAll({ persist: false }).catch(() => undefined);
  process.exit(code);
}

const t0 = Date.now();
const timer = setInterval(() => {
  const demo = pm.list().find((p) => p.name === "demo");
  const gone =
    demo != null &&
    demo.status !== "online" &&
    demo.status !== "launching" &&
    demo.status !== "waiting-restart";
  if (gone) {
    console.log(`[e2e-agent] demo left the running set (${demo!.status}) — one report cycle to fly`);
    clearInterval(timer);
    // the outbox needs one report cycle to deliver + the ack to land
    setTimeout(() => void shutdown(0), 6_000);
    return;
  }
  if (Date.now() - t0 > 150_000) {
    console.error("[e2e-agent] timed out — the demo never crashed");
    clearInterval(timer);
    void shutdown(1);
  }
}, 1_000);
