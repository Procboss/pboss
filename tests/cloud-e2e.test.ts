/**
 * Cloud e2e — the whole stack against the mini-cloud contract double:
 * real CLI subprocesses, a real daemon subprocess (auto-started by the CLI
 * exactly as in production), and a real bidirectional agent link (the
 * /ws/agent WebSocket: state reports up, commands + log.watch down) over
 * 127.0.0.1.
 *
 * The human-in-the-loop is simulated the only way it can be in a test:
 * the CLI's stdout is STREAMED (not buffered), the printed code is read
 * the moment it appears, and the approval is POSTed as the browser would.
 * Everything else — polling, claim, credential handover to the daemon,
 * outbound connection, command dispatch — is the production path.
 *
 * Each test gets its own PBOSS_HOME (own socket, own daemon); daemons and
 * workers are killed in the test's finally block.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, existsSync } from "node:fs";
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

function spawnCli(args: string[], home: string, env: Record<string, string> = {}) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home, PBOSS_NO_BROWSER: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: ROOT,
  });
}

async function runCli(args: string[], home: string, env: Record<string, string> = {}) {
  const proc = spawnCli(args, home, env);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  const code = await proc.exited;
  return { out, err, code };
}

/**
 * Run a device-flow CLI command and play the approving human: stream
 * stdout, regex the code out of the "Code:  XXXX-XXXX" line (ANSI-tolerant
 * — colorize may wrap the value in bold escapes), approve it immediately.
 */
async function runDeviceFlowCli(args: string[], home: string, env: Record<string, string> = {}) {
  const proc = spawnCli(args, home, env);
  const chunks: string[] = [];
  let approved = false;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
      if (!approved) {
        const m = chunks.join("").match(/Code:\s*(?:\x1b\[[0-9;]*m)*([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/);
        if (m) {
          approved = true;
          void mini.approve(m[1]!);
        }
      }
    }
  })();
  const errTask = new Response(proc.stderr).text().catch(() => "");
  await readLoop;
  const err = await errTask;
  const code = await proc.exited;
  return { out: chunks.join(""), err, code };
}

function freshHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `pboss-cloude2e-${prefix}-`));
  mkdirSync(join(home, "logs"), { recursive: true });
  return home;
}

function stayAlive(home: string, name = "web.ts"): string {
  const p = join(home, name);
  writeFileSync(p, "setInterval(() => {}, 1000);\n");
  return p;
}

async function killDaemon(home: string) {
  await runCli(["kill"], home).catch(() => undefined);
}

/** Read cloud.json (the machine credential the daemon wrote). */
function readCloudJson(home: string) {
  return JSON.parse(readFileSync(join(home, "cloud.json"), "utf-8")) as {
    cloudUrl: string;
    serverId: string;
    serverSecret: string;
    serverName?: string;
  };
}

/** Poll the fleet endpoint (as the daemon does) until the predicate holds. */
async function pollFleet(
  cred: { serverId: string; serverSecret: string },
  pred: (servers: any[]) => boolean,
  timeoutMs = 15_000
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${mini.url}/api/agent/servers`, {
      headers: { Authorization: `Bearer ${cred.serverId}.${cred.serverSecret}` },
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.ok && pred(body.servers ?? [])) return body.servers;
    if (Date.now() > deadline) throw new Error(`fleet predicate never held: ${JSON.stringify(body).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe(
  "cloud e2e — machine link, bidirectional agent, fleet view, disconnect",
  () => {
    test(
      "connect (device flow) → status → servers → remote command → disconnect",
      async () => {
        const home = freshHome("machine");
        try {
          // 1. the device flow: code printed → approved → credential claimed
          //    → daemon takes over (cloud.json + outbound connection)
          const { out, err, code } = await runDeviceFlowCli(
            ["cloud", "connect", "--url", mini.url],
            home
          );
          expect(code).toBe(0);
          expect(out).toContain("ProcBoss Cloud — connect this server");
          expect(out).toContain(mini.url);
          expect(out).toMatch(/Code:\s*(?:\x1b\[[0-9;]*m)*[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
          expect(out).toContain("No browser here — open the URL on any device");
          expect(out).toContain("✓ Server authorized and connected");
          expect(err).toBe("");

          // 2. the daemon owns the credential: 0600, serverId matches the cloud row
          const cloudJsonPath = join(home, "cloud.json");
          expect(existsSync(cloudJsonPath)).toBe(true);
          const cred = readCloudJson(home);
          expect(cred.serverSecret.startsWith("pbs_")).toBe(true);
          expect(cred.cloudUrl).toBe(mini.url);
          expect(statSync(cloudJsonPath).mode & 0o777).toBe(0o600);
          expect(cred.serverId).toBe(mini.state.servers[0]!.id);

          // 3. the agent's outbound connection is LIVE (fleet shows online)
          const servers = await pollFleet(cred, (list) =>
            list.some((s) => s.id === cred.serverId && s.status === "online")
          );
          expect(servers.some((s) => s.enrolled)).toBe(true);

          // 4. cloud status through the CLI reads the live link
          const st = await runCli(["cloud", "status"], home);
          expect(st.code).toBe(0);
          expect(st.out).toContain("connected — command channel live");

          // 5. a real process: start it, the daemon reports it upstream
          const script = stayAlive(home);
          const started = await runCli(["start", script], home);
          expect(started.code).toBe(0);
          await pollFleet(cred, (list) =>
            list.some((s) => s.id === cred.serverId && s.status === "online")
          );
          // the periodic state report carries the process list (upstream half)
          const deadline = Date.now() + 15_000;
          for (;;) {
            const report = mini.state.lastStateReport as any;
            if (report?.processes?.some((p: any) => p.name === "web")) break;
            if (Date.now() > deadline) throw new Error("process never appeared in a state report");
            await new Promise((r) => setTimeout(r, 500));
          }

          // 6. `pboss cloud servers` renders the fleet
          const fleet = await runCli(["cloud", "servers"], home);
          expect(fleet.code).toBe(0);
          expect(fleet.out).toContain("Fleet (1 server)");
          expect(fleet.out).toContain("online");
          expect(fleet.out).toContain(cred.serverName ?? "srv-");

          // 7. the cloud commands the machine (downstream half) — process.list
          const listResult = await mini.dispatchCommand(cred.serverId, "process.list");
          expect(listResult.success).toBe(true);
          expect(JSON.stringify(listResult.data)).toContain("web");

          // 8. …and actually controls it — process.stop
          const stopResult = await mini.dispatchCommand(cred.serverId, "process.stop", { target: "web" });
          expect(stopResult.success).toBe(true);
          const listed = await runCli(["list"], home);
          expect(listed.out).toMatch(/web[\s\S]*stopped/i);

          // 9. reconnect is an honest no-revocation restart
          const rec = await runCli(["cloud", "reconnect"], home);
          expect(rec.code).toBe(0);
          expect(rec.out).toContain("Reconnect triggered");
          await pollFleet(cred, (list) =>
            list.some((s) => s.id === cred.serverId && s.status === "online")
          );

          // 10. unlink: server-side revocation + local credential wipe
          const dis = await runCli(["cloud", "disconnect"], home);
          expect(dis.code).toBe(0);
          expect(dis.out).toContain("✓ Unlinked");
          expect(existsSync(cloudJsonPath)).toBe(false);
          expect(mini.state.servers[0]!.secret).toBeNull(); // revoked upstream
        } finally {
          await killDaemon(home);
          rmSync(home, { recursive: true, force: true });
        }
      },
      90_000
    );

    test(
      "log.watch / log.unwatch — the cloud drives the agent's live log tail",
      async () => {
        const home = freshHome("logwatch");
        try {
          // link first (auto-approved device flow)
          const { code } = await runDeviceFlowCli(["cloud", "connect", "--url", mini.url], home);
          expect(code).toBe(0);
          const cred = readCloudJson(home);
          await pollFleet(cred, (list) =>
            list.some((s) => s.id === cred.serverId && s.status === "online")
          );

          // a process that TALKS every 300ms
          const noisy = join(home, "noisy.ts");
          writeFileSync(noisy, "let i = 0; setInterval(() => { console.log('tick ' + (++i)); }, 300);\n");
          const started = await runCli(["start", noisy], home);
          expect(started.code).toBe(0);
          // wait for it to show up in state reports
          const deadline = Date.now() + 15_000;
          for (;;) {
            const report = mini.state.lastStateReport as any;
            if (report?.processes?.some((p: any) => p.name === "noisy")) break;
            if (Date.now() > deadline) throw new Error("noisy never appeared in a state report");
            await new Promise((r) => setTimeout(r, 400));
          }

          // no log frames before a watch
          expect(mini.state.logFrames.length).toBe(0);

          // watch → the agent tails the process and pushes frames
          expect(mini.sendControl(cred.serverId, { type: "log.watch", process: "noisy" })).toBe(true);
          const framesDeadline = Date.now() + 10_000;
          for (;;) {
            if (mini.state.logFrames.some((f) => f.lines.length > 0)) break;
            if (Date.now() > framesDeadline) throw new Error("no log frames arrived after log.watch");
            await new Promise((r) => setTimeout(r, 300));
          }
          const firstLine = (mini.state.logFrames.find((f) => f.lines.length > 0)!.lines[0] as any);
          expect(String(firstLine.msg)).toContain("tick");

          // unwatch → the tail stops: frame count freezes
          expect(mini.sendControl(cred.serverId, { type: "log.unwatch", process: "noisy" })).toBe(true);
          const countAtUnwatch = mini.state.logFrames.length;
          await new Promise((r) => setTimeout(r, 1500)); // > 3 ticks + poll interval
          expect(mini.state.logFrames.length).toBe(countAtUnwatch);
        } finally {
          await killDaemon(home);
          rmSync(home, { recursive: true, force: true });
        }
      },
      90_000
    );
  }
);

describe("cloud e2e — the link survives incidents (reboot / network blackout)", () => {
  test(
    "daemon restart (reboot sim): the link resumes from the saved credential",
    async () => {
      const home = freshHome("rebootsim");
      try {
        // link the machine
        const { code } = await runDeviceFlowCli(["cloud", "connect", "--url", mini.url], home);
        expect(code).toBe(0);
        const cred = readCloudJson(home);
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );
        const connectionsBefore = mini.state.connectionCount;

        // the "reboot": the daemon dies with the machine
        await killDaemon(home);

        // machine back up: any pboss command auto-starts the daemon, which
        // resumes the cloud link from ~/.pboss/cloud.json on its own
        const st = await runCli(["cloud", "status"], home);
        expect(st.code).toBe(0);
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );
        // a fresh connection was dialed (the old one died with the daemon)
        expect(mini.state.connectionCount).toBeGreaterThan(connectionsBefore);
        // and a FRESH state report arrived after the restart
        expect(mini.state.lastReportArrivedAt).toBeGreaterThan(0);
      } finally {
        await killDaemon(home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    90_000
  );

  test(
    "silent network blackout: the agent's watchdog forces a reconnect",
    async () => {
      const home = freshHome("blackout");
      try {
        // daemon runs with a 2s watchdog (env is inherited by the daemon)
        const { code } = await runDeviceFlowCli(
          ["cloud", "connect", "--url", mini.url],
          home,
          { PBOSS_CLOUD_WATCHDOG_MS: "2000" }
        );
        expect(code).toBe(0);
        const cred = readCloudJson(home);
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );
        // The daemon's watchdog only arms once the agent has SEEN a ping —
        // wait for two NEW pong round-trips from THIS agent before cutting
        // the link. (pongCount is cumulative across the whole suite: prior
        // tests' agents already pushed it past 2, so an absolute threshold
        // would pass instantly and silence the pings before this agent has
        // ever seen one — sawServerPing stays false and the watchdog stays
        // inert, which is a TEST bug, not an agent bug.)
        const pongsAtStart = mini.state.pongCount;
        const pingsDeadline = Date.now() + 15_000;
        while (Date.now() < pingsDeadline && mini.state.pongCount < pongsAtStart + 2) {
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(mini.state.pongCount).toBeGreaterThanOrEqual(pongsAtStart + 2);
        const connectionsBefore = mini.state.connectionCount;
        const reportBefore = mini.state.lastReportArrivedAt;

        // the blackout: the network path dies WITHOUT a close frame — pings
        // stop, the socket stays half-open. Only the agent's inbound
        // watchdog can detect this and re-dial.
        mini.silencePings(cred.serverId);

        // the watchdog fires within ~2s and a NEW connection lands
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (mini.state.connectionCount > connectionsBefore) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(mini.state.connectionCount).toBeGreaterThan(connectionsBefore);

        // the link is fully alive again: fleet online AND a fresh state
        // report arrived over the new socket
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );
        expect(mini.state.lastReportArrivedAt).toBeGreaterThanOrEqual(reportBefore);
      } finally {
        await killDaemon(home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    90_000
  );
});

describe("cloud e2e — user login (pboss login/whoami/logout)", () => {
  test(
    "login via device flow, whoami, logout revokes",
    async () => {
      const home = freshHome("user");
      try {
        const { out, code } = await runDeviceFlowCli(["login", "--url", mini.url], home);
        expect(code).toBe(0);
        expect(out).toContain("ProcBoss Cloud — user login");
        expect(out).toContain("✓ Logged in as dev@procboss.test");
        expect(out).toContain("pboss whoami");

        const userFile = join(home, "cloud-user.json");
        expect(existsSync(userFile)).toBe(true);
        expect(statSync(userFile).mode & 0o777).toBe(0o600);
        // a user login NEVER links the machine: no cloud.json, no daemon socket
        expect(existsSync(join(home, "cloud.json"))).toBe(false);
        expect(existsSync(join(home, "daemon.sock"))).toBe(false);

        const who = await runCli(["whoami"], home);
        expect(who.code).toBe(0);
        expect(who.out).toContain("dev@procboss.test");
        expect(who.out).toContain("Dev Tester");

        const out2 = await runCli(["logout"], home);
        expect(out2.code).toBe(0);
        expect(out2.out).toContain("revoked server-side");
        expect(existsSync(userFile)).toBe(false);

        const who2 = await runCli(["whoami"], home);
        expect(who2.code).toBe(1);
        expect(who2.out).toContain("Not logged in");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000
  );
});

describe("cloud e2e — legacy pasted-token path still works", () => {
  test(
    "cloud connect <token> enrolls and links",
    async () => {
      const home = freshHome("legacy");
      try {
        const token = mini.mintEnrollmentToken();
        const { out, code } = await runCli(["cloud", "connect", token, "--url", mini.url], home);
        expect(code).toBe(0);
        expect(out).toContain("✓ Server registered and connected");
        const cred = readCloudJson(home);
        expect(cred.serverSecret.startsWith("pbs_")).toBe(true);
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );
      } finally {
        await killDaemon(home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000
  );
});

describe("cloud e2e — honest errors when not linked / not logged in", () => {
  test(
    "cloud servers without a link says so (through the daemon)",
    async () => {
      const home = freshHome("unlinked");
      try {
        const { out, err, code } = await runCli(["cloud", "servers"], home);
        expect(code).toBe(1);
        expect(out + err).toContain("not linked");
        expect(out + err).toContain("pboss cloud connect");
      } finally {
        await killDaemon(home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000
  );

  test("cloud help documents the device flow", async () => {
    const home = freshHome("help");
    try {
      const { out, code } = await runCli(["cloud"], home);
      expect(code).toBe(0);
      expect(out).toContain("connect [--url <cloud>]");
      expect(out).toContain("servers");
      expect(out).toContain("reconnect");
      expect(out).toContain("approve at <cloud>/connect");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
