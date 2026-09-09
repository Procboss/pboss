/**
 * Cloud link across reinstalls & upgrades — the permanent-credential-cache
 * contract.
 *
 * Field report: "after I deleted pboss and reinstalled it, `pboss cloud
 * status` says not linked". The machine credential lives in
 * ~/.pboss/cloud.json (0600) which SURVIVES binary swaps by design — but
 * three gaps could still make a machine look unlinked (or worse):
 *
 *   1. `cloud status` trusted ONLY the daemon's in-memory agent state:
 *      a daemon that booted before the credential existed (fresh install
 *      racing a dotfiles sync / backup restore / manual migration) answered
 *      "not linked" forever while the credential sat on disk unread.
 *   2. `CloudAgent.start()` THREW on a refused transport — and the daemon
 *      calls it unguarded at boot, so one stale cloud.json URL bricked the
 *      whole daemon (processes, logs, everything).
 *   3. Nothing at the reinstall/upgrade MOMENT ever checked for or
 *      reported the surviving link.
 *
 * The contract under test:
 *   - the daemon picks the link back up the moment anyone asks (self-heal
 *     on the cloudStatus RPC), and the fleet row goes back online;
 *   - start() degrades to "configured, stopped, reason in lastError"
 *     instead of throwing, and the daemon stays alive;
 *   - postinstall names a surviving link instead of staying silent;
 *   - install.sh / install.ps1 carry the same detection block;
 *   - `pboss upgrade`'s verdict line formats every state honestly.
 *
 * File-dependent units run in subprocesses (PBOSS_HOME is resolved at
 * module import); the e2e section drives real CLI/daemon subprocesses
 * against the mini-cloud contract double.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "index.ts");

/* ── part A: the upgrade verdict line (pure, in-process) ──────────────── */

import { describeCloudLink } from "../src/cloud";
import type { CloudAgentStatus } from "../src/cloud";

function statusOf(overrides: Partial<CloudAgentStatus>): CloudAgentStatus {
  return {
    configured: true,
    cloudUrl: "https://procboss.com",
    serverId: "srv_relink",
    serverName: "prod-01",
    connected: false,
    streamState: "connected",
    reconnects: 0,
    nextRetryInMs: null,
    lastReportAt: null,
    lastReportAgeMs: null,
    processes: 0,
    pendingEvents: 0,
    lastError: null,
    ...overrides,
  };
}

describe("describeCloudLink (the post-upgrade verdict line)", () => {
  test("unconfigured names the connect command", () => {
    const line = describeCloudLink(statusOf({ configured: false, streamState: "stopped" }));
    expect(line).toContain("no cloud link");
    expect(line).toContain("pboss cloud connect");
  });

  test("connected / connecting / backoff resume verdicts name the server", () => {
    expect(describeCloudLink(statusOf({ streamState: "connected", connected: true })))
      .toContain("cloud link resumed: prod-01");
    expect(describeCloudLink(statusOf({ streamState: "connected", connected: true })))
      .toContain("connected, command channel live");
    expect(describeCloudLink(statusOf({ streamState: "connecting" }))).toContain("connecting…");
    expect(
      describeCloudLink(statusOf({ streamState: "backoff", nextRetryInMs: 7500 }))
    ).toContain("next try in ~8s");
  });

  test("stopped carries the reason instead of pretending", () => {
    const line = describeCloudLink(
      statusOf({ streamState: "stopped", lastError: "refusing plaintext transport to http://x" })
    );
    expect(line).toContain("prod-01");
    expect(line).toContain("stopped");
    expect(line).toContain("refusing plaintext transport");
  });

  test("falls back to the server id when no name was stored", () => {
    const line = describeCloudLink(
      statusOf({ streamState: "connecting", serverName: null })
    );
    expect(line).toContain("srv_relink");
  });
});

/* ── part B: agent behavior (subprocesses — hermetic PBOSS_HOME) ──────── */

/**
 * Run a snippet with PBOSS_HOME pointed at a scratch dir; returns
 * { code, out }. The snippet must print a "__JSON__<json>" marker line for
 * anything the test wants to assert on.
 */
async function runAgentSubprocess(home: string, code: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, PBOSS_HOME: home, PBOSS_CLOUD_REPORT_MS: "600000" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: ROOT,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  const code2 = await proc.exited;
  return { code: code2, out, err };
}

const PM_STUB = `{ list: () => [], getLogs: async () => [], watchProcessLogs: () => undefined }`;

/** Pull the "__JSON__{...}" marker line out of a subprocess's stdout. */
function parseMarker(out: string): Record<string, unknown> {
  const m = out.match(/__JSON__(\{.*\})/);
  if (!m) throw new Error(`no __JSON__ marker in subprocess output: ${out.slice(0, 300)}`);
  return JSON.parse(m[1] as string) as Record<string, unknown>;
}

describe("CloudAgent.start never throws (daemon boot must survive a stale credential)", () => {
  test("plaintext non-loopback URL degrades to configured + stopped + reason", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-norelint-"));
    try {
      const { code, out } = await runAgentSubprocess(
        home,
        `import { CloudAgent } from "${ROOT}/src/cloud";
         const agent = new CloudAgent(${PM_STUB});
         agent.start({ cloudUrl: "http://example.invalid", serverId: "srv_bad", serverSecret: "pbs_bad" });
         console.log("__JSON__" + JSON.stringify(agent.status()));
         process.exit(0);`
      );
      expect(code).toBe(0); // THE regression: this used to throw (and brick the daemon boot)
      const st = parseMarker(out);
      expect(st.configured).toBe(true);
      expect(st.streamState).toBe("stopped");
      expect(st.lastError).toContain("refusing plaintext transport");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("CloudAgent.resumeFromDisk (the reinstall self-heal)", () => {
  test("no credential on disk → false, nothing started", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-noresume-"));
    try {
      const { code, out } = await runAgentSubprocess(
        home,
        `import { CloudAgent } from "${ROOT}/src/cloud";
         const agent = new CloudAgent(${PM_STUB});
         const resumed = agent.resumeFromDisk();
         console.log("__JSON__" + JSON.stringify({ resumed, status: agent.status() }));
         process.exit(0);`
      );
      expect(code).toBe(0);
      const st = parseMarker(out);
      expect(st.resumed).toBe(false);
      expect((st.status as any).configured).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("credential on disk → true and the link dials immediately", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-resume-"));
    try {
      writeFileSync(
        join(home, "cloud.json"),
        JSON.stringify({
          cloudUrl: "https://127.0.0.1:1", // loopback: TLS rule passes, nothing listens
          serverId: "srv_resume",
          serverSecret: "pbs_resume",
          serverName: "resume-box",
        })
      );
      const { code, out } = await runAgentSubprocess(
        home,
        `import { CloudAgent } from "${ROOT}/src/cloud";
         const agent = new CloudAgent(${PM_STUB});
         const resumed = agent.resumeFromDisk();
         console.log("__JSON__" + JSON.stringify({ resumed, status: agent.status() }));
         agent.stop({ revoke: false });
         process.exit(0);`
      );
      expect(code).toBe(0);
      const st = parseMarker(out);
      expect(st.resumed).toBe(true);
      expect((st.status as any).configured).toBe(true);
      expect(["connecting", "backoff"]).toContain((st.status as any).streamState);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("already running a link → true without restarting it (no second dial)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-resume2-"));
    try {
      writeFileSync(
        join(home, "cloud.json"),
        JSON.stringify({
          cloudUrl: "https://127.0.0.1:1",
          serverId: "srv_once",
          serverSecret: "pbs_once",
        })
      );
      const { code, out } = await runAgentSubprocess(
        home,
        `import { CloudAgent } from "${ROOT}/src/cloud";
         const agent = new CloudAgent(${PM_STUB});
         agent.resumeFromDisk();
         agent.resumeFromDisk(); // idempotent: must NOT stop/restart the loops
         console.log("__JSON__" + JSON.stringify(agent.status()));
         agent.stop({ revoke: false });
         process.exit(0);`
      );
      expect(code).toBe(0);
      // exactly ONE "connecting to" line = the second resume was a no-op
      expect(out.match(/connecting to https/g)?.length).toBe(1);
      const st = parseMarker(out);
      expect(st.configured).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("revoked credential (file cleared) → false, no zombie relink", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-revoked-"));
    try {
      writeFileSync(
        join(home, "cloud.json"),
        JSON.stringify({
          cloudUrl: "https://127.0.0.1:1",
          serverId: "srv_revoked",
          serverSecret: "pbs_revoked",
        })
      );
      const { code, out } = await runAgentSubprocess(
        home,
        `import { CloudAgent, loadCloudConfig } from "${ROOT}/src/cloud";
         const agent = new CloudAgent(${PM_STUB});
         agent.resumeFromDisk();
         await agent.stop({ revoke: true }); // clears the credential file
         const resumed = agent.resumeFromDisk();
         console.log("__JSON__" + JSON.stringify({ resumed, file: loadCloudConfig() }));
         process.exit(0);`
      );
      expect(code).toBe(0);
      const st = parseMarker(out);
      expect(st.resumed).toBe(false);
      expect(st.file).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("postinstall names a surviving cloud link", () => {
  test("existingCloudLinkNote: null without a credential, names the server with one", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-note-"));
    try {
      const { code, out } = await runAgentSubprocess(
        home,
        `import { existingCloudLinkNote } from "${ROOT}/src/postinstall";
         const empty = existingCloudLinkNote();
         const fs = await import("node:fs");
         fs.writeFileSync(process.env.PBOSS_HOME + "/cloud.json", JSON.stringify({ cloudUrl: "https://procboss.com", serverId: "srv_note", serverSecret: "pbs_note", serverName: "note-box" }));
         const found = existingCloudLinkNote();
         console.log("__JSON__" + JSON.stringify({ empty, found }));
         process.exit(0);`
      );
      expect(code).toBe(0);
      const st = parseMarker(out);
      expect(st.empty).toBeNull();
      expect(st.found).toContain("note-box");
      expect(st.found).toContain("pboss cloud status");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

/* ── part C: the reported bug, end to end (mini-cloud + real daemon) ──── */

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
  return Bun.spawn([process.execPath, "run", CLI, ...args], {
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
 * Play the approving human: stream stdout, regex the device code out of
 * the "Code:  XXXX-XXXX-XXXX" line (ANSI-tolerant), approve immediately.
 */
async function runDeviceFlowCli(args: string[], home: string) {
  const proc = spawnCli(args, home);
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
          void mini.approve(m[1]!).catch(() => undefined);
        }
      }
    }
  })();
  const [out, err, code] = await Promise.all([
    (async () => {
      await readLoop;
      return chunks.join("");
    })(),
    new Response(proc.stderr).text().catch(() => ""),
    proc.exited,
  ]);
  return { out, err, code };
}

function freshHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `pboss-relink-${prefix}-`));
  mkdirSync(join(home, "logs"), { recursive: true });
  return home;
}

async function killDaemon(home: string) {
  await runCli(["kill"], home).catch(() => undefined);
}

function readCloudJson(home: string) {
  return JSON.parse(readFileSync(join(home, "cloud.json"), "utf-8")) as {
    cloudUrl: string;
    serverId: string;
    serverSecret: string;
    serverName?: string;
  };
}

async function pollFleet(
  cred: { serverId: string; serverSecret: string },
  pred: (servers: any[]) => boolean,
  timeoutMs = 20_000
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${mini.url}/api/agent/servers`, {
      headers: { Authorization: `Bearer ${cred.serverId}.${cred.serverSecret}` },
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.ok && pred(body.servers ?? [])) return body.servers;
    if (Date.now() > deadline) throw new Error("fleet predicate never held");
    await new Promise((r) => setTimeout(r, 400));
  }
}

describe("cloud e2e — the reinstall: daemon up first, credential back second", () => {
  test(
    "cloud status self-heals a daemon that booted before cloud.json existed (the field report)",
    async () => {
      const home = freshHome("field");
      try {
        // 1. link the machine (normal device flow)
        const { code } = await runDeviceFlowCli(["cloud", "connect", "--url", mini.url], home);
        expect(code).toBe(0);
        const cred = readCloudJson(home);
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );

        // 2. THE REINSTALL: the credential leaves (deleted with the old
        //    app), the daemon restarts WITHOUT it, then the credential is
        //    restored from the permanent cache (backup/dotfiles/migration).
        const credPath = join(home, "cloud.json");
        const stash = join(home, "cloud.json.stash");
        renameSync(credPath, stash);
        await killDaemon(home);
        const ping = await runCli(["ping"], home); // daemon auto-starts, no link
        expect(ping.code).toBe(0);
        renameSync(stash, credPath); // the reinstall/restore moment

        // 3. asking for status must PICK THE LINK UP (not "not linked")
        const st = await runCli(["cloud", "status"], home);
        expect(st.code).toBe(0);
        expect(st.out).not.toContain("not linked");
        expect(st.out).toContain(cred.serverId);
        await pollFleet(cred, (list) =>
          list.some((s) => s.id === cred.serverId && s.status === "online")
        );
      } finally {
        await killDaemon(home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000
  );

  test(
    "a stale credential with a refused transport never bricks the daemon",
    async () => {
      const home = freshHome("stale");
      try {
        // a cloud.json whose transport is refused (plaintext non-loopback)
        writeFileSync(
          join(home, "cloud.json"),
          JSON.stringify({
            cloudUrl: "http://example.invalid",
            serverId: "srv_stale",
            serverSecret: "pbs_stale",
          })
        );
        const ping = await runCli(["ping"], home); // daemon boots WITH the bad file
        expect(ping.code).toBe(0);

        const st = await runCli(["cloud", "status"], home);
        expect(st.code).toBe(0);
        expect(st.out).not.toContain("not linked");
        expect(st.out).toContain("srv_stale");
        expect(st.out).toContain("Last err");
        expect(st.out).toContain("refusing plaintext transport");

        // the daemon is still fully alive
        const ping2 = await runCli(["ping"], home);
        expect(ping2.code).toBe(0);
      } finally {
        await killDaemon(home);
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000
  );
});
