import { describe, test, expect, afterEach } from "bun:test";
import { CloudAgent, type CloudConfig } from "../src/cloud";
import type { ProcessManager } from "../src/process-manager";

/**
 * Link confirmation — the "proxy mirage" fix. Some reverse proxies
 * (space-z.ai preview tunnels were the field report) answer the
 * WebSocket upgrade THEMSELVES within milliseconds, then dial the origin
 * without forwarding the Authorization header: the origin 401s every
 * upstream, and the client sits on an open socket that leads nowhere.
 *
 * An agent that trusted the open event alone:
 *   - reported "connected — command channel live" (a lie),
 *   - updated "Report: 0s ago" (frames buffered into the void),
 *   - reset the backoff on every fake open → a ~3s reconnect loop,
 *     "139 retries" within minutes, a wall of 401s on the cloud.
 *
 * The contract under test, against real local WebSocket servers:
 *   1. The dial carries the credential on BOTH transports: Authorization
 *      header AND the `?agent=` query param (the only one that survives
 *      header-stripping proxies).
 *   2. An open socket with no hello is NEVER "connected"; the hello
 *      deadline closes it and the agent redials.
 *   3. No frames are sent while unconfirmed (sendFrame gate), and no
 *      report timestamp is recorded (the status must not lie).
 *   4. A confirmed link that dies says WHY (close code/reason —
 *      "replaced" gets its own diagnosis); the generic
 *      "websocket not open" report-skip never masks the real error.
 *   5. A stable link's death resets the retry counter; an unstable
 *      link's death does not.
 *   6. The hello frame flips the agent to connected and reports flow.
 */

const stubPm = {
  list: () => [],
  getLogs: async () => [],
  watchProcessLogs: () => undefined,
} as unknown as ProcessManager;

const cfg = (url: string): CloudConfig => ({
  cloudUrl: url,
  serverId: "srv_linkconf",
  serverSecret: "pbs_test",
  serverName: "linkconf-test",
});

/**
 * A scriptable fake cloud. Each connection (by index) follows a script:
 * whether hello is sent, when/why the socket closes. Nothing else is
 * ever sent — an unscripted connection is a silent mirage.
 */
function startScriptedCloud(
  scripts: Array<{
    hello?: boolean;
    closeAfterMs?: number;
    closeCode?: number;
    closeReason?: string;
  }>,
) {
  const upgradeUrls: string[] = [];
  const authHeaders: string[] = [];
  const frames: string[] = [];
  let connections = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      if (new URL(req.url).pathname === "/ws/agent") {
        upgradeUrls.push(req.url);
        authHeaders.push(req.headers.get("authorization") ?? "");
        if (bunServer.upgrade(req)) return;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const script = scripts[connections] ?? {};
        connections++;
        if (script.hello !== false) {
          ws.send(JSON.stringify({ type: "hello", serverId: "srv_linkconf", now: Date.now() }));
        }
        if (script.closeAfterMs != null) {
          timers.push(
            setTimeout(
              () => ws.close(script.closeCode ?? 1000, script.closeReason ?? ""),
              script.closeAfterMs,
            ),
          );
        }
      },
      message(_ws, raw) {
        frames.push(String(raw));
      },
      close() {},
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get connections() {
      return connections;
    },
    get upgradeUrls() {
      return upgradeUrls;
    },
    get authHeaders() {
      return authHeaders;
    },
    get frames() {
      return frames;
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      server.stop(true);
    },
  };
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(40);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const agents: CloudAgent[] = [];
const servers: Array<ReturnType<typeof startScriptedCloud>> = [];

afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop({ revoke: false, quiet: true });
  for (const s of servers.splice(0)) s.stop();
});

describe("CloudAgent link confirmation — the proxy-mirage fix", () => {
  test("the dial carries the credential on both transports (header + ?agent=)", async () => {
    const cloud = startScriptedCloud([{ hello: true }]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm);
    agents.push(agent);

    agent.start(cfg(cloud.url));
    await until(() => agent.status().connected, 5_000, "connect");

    expect(cloud.upgradeUrls.length).toBeGreaterThanOrEqual(1);
    const url = cloud.upgradeUrls[0]!;
    expect(url).toContain("/ws/agent?agent=");
    expect(url).toContain("srv_linkconf.pbs_test");
    expect(cloud.authHeaders[0]).toBe("Bearer srv_linkconf.pbs_test");
    expect(cloud.connections).toBe(1);
  }, 15_000);

  test("a proxy mirage (open, never hello) is never 'connected' and is redialed", async () => {
    // Script: every connection is a silent mirage — the proxy answered the
    // upgrade itself and the origin never registered us.
    const cloud = startScriptedCloud([{ hello: false }, { hello: false }, { hello: false }]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm, { helloTimeoutMs: 250, reportIntervalMs: 100 });
    agents.push(agent);

    agent.start(cfg(cloud.url));

    // Give the mirage plenty of time to fool the old logic: the socket is
    // OPEN, the report timer is firing — none of it may count.
    await Bun.sleep(450);
    const during = agent.status();
    expect(during.connected).toBe(false);
    expect(during.streamState).not.toBe("connected");
    expect(during.lastReportAt).toBeNull(); // no lying "Report: 0s ago"

    // The hello deadline must force the socket down and redial.
    await until(() => cloud.connections >= 2, 8_000, "mirage redial");
    const after = agent.status();
    expect(after.connected).toBe(false);
    expect(after.reconnects).toBeGreaterThanOrEqual(1);
  }, 20_000);

  test("no frames leave the agent while the link is unconfirmed", async () => {
    // A silent mirage with a LONG hello deadline: the report timer fires
    // several times while the socket is open-but-unconfirmed.
    const cloud = startScriptedCloud([{ hello: false }]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm, { helloTimeoutMs: 5_000, reportIntervalMs: 100 });
    agents.push(agent);

    agent.start(cfg(cloud.url));
    await Bun.sleep(600); // 6+ report cycles inside the mirage window

    expect(cloud.frames.length).toBe(0); // sendFrame gate held
  }, 10_000);

  test("the mirage diagnosis survives the report timer (no error masking)", async () => {
    const cloud = startScriptedCloud([{ hello: false }, { hello: false }]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm, { helloTimeoutMs: 200, reportIntervalMs: 80 });
    agents.push(agent);

    agent.start(cfg(cloud.url));
    // The hello deadline fires (200ms) and sets the specific error; the
    // report timer keeps firing (80ms) — it must NOT overwrite it with the
    // generic "websocket not open" skip.
    await until(
      () => (agent.status().lastError ?? "").includes("never confirmed the link"),
      5_000,
      "mirage diagnosis",
    );
    await Bun.sleep(400); // several more report cycles
    expect(agent.status().lastError).toContain("never confirmed the link");
  }, 15_000);

  test("a confirmed link that dies says why — 'replaced' gets its own diagnosis", async () => {
    const cloud = startScriptedCloud([
      { hello: true, closeAfterMs: 150, closeCode: 1000, closeReason: "replaced" },
    ]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm, { helloTimeoutMs: 2_000, reportIntervalMs: 5_000 });
    agents.push(agent);

    agent.start(cfg(cloud.url));
    await until(() => agent.status().connected, 5_000, "confirm");
    await until(() => cloud.connections === 1 && !agent.status().connected, 5_000, "replaced close");

    await until(
      () => (agent.status().lastError ?? "").includes("replaced"),
      5_000,
      "replaced diagnosis",
    );
    expect(agent.status().lastError).toContain("another daemon");
    // status also exposes the pending redial, not a bare "139 retries"
    const st = agent.status();
    expect(st.streamState).toBe("backoff");
    expect(st.nextRetryInMs).not.toBeNull();
    expect(st.nextRetryInMs!).toBeGreaterThan(0);
  }, 20_000);

  test("a stable link's death resets the retry counter; an unstable one does not", async () => {
    // conn 0: confirmed, lives 400ms (>= stableLinkMs 200) → stable → reset
    // conn 1: confirmed, lives 100ms (< stableLinkMs) → not stable → no reset
    const cloud = startScriptedCloud([
      { hello: true, closeAfterMs: 400 },
      { hello: true, closeAfterMs: 100 },
    ]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm, { helloTimeoutMs: 5_000, stableLinkMs: 200 });
    agents.push(agent);

    agent.start(cfg(cloud.url));
    await until(() => cloud.connections === 1 && agent.status().connected, 5_000, "first link");
    await until(() => cloud.connections === 2, 8_000, "redial after stable link death");
    // stable reset happened: this retry counts as 1 (not 2)
    await until(() => agent.status().reconnects === 1, 5_000, "reconnects after stable reset");
    await until(() => cloud.connections === 2 && !agent.status().connected, 5_000, "second death");
    // conn 1 was NOT stable: the counter accumulates
    await until(() => agent.status().reconnects === 2, 5_000, "reconnects accumulate when unstable");
  }, 25_000);

  test("hello flips the agent to connected and state reports flow", async () => {
    const cloud = startScriptedCloud([{ hello: true }]);
    servers.push(cloud);
    const agent = new CloudAgent(stubPm, { reportIntervalMs: 100 });
    agents.push(agent);

    agent.start(cfg(cloud.url));
    await until(() => agent.status().connected, 5_000, "confirm");
    expect(agent.status().lastError).toBeNull();

    await until(() => cloud.frames.length >= 1, 5_000, "state report after confirm");
    const first = JSON.parse(cloud.frames[0]!) as { type: string };
    expect(first.type).toBe("state");
    expect(agent.status().lastReportAt).not.toBeNull();
  }, 15_000);
});
