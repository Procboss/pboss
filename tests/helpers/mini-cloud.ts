/**
 * Mini-cloud — a contract-faithful test double of the ProcBoss Cloud API
 * (procboss.com's /api/device/* + /api/agent/* + /api/me), used by the
 * pboss test suite to exercise the device-code login and the bidirectional
 * agent link WITHOUT the real Next.js app + Postgres.
 *
 * It implements the SAME wire contract (shapes, error codes, single-claim
 * semantics, Bearer auth, the /ws/agent WebSocket, 409-before-socket), so the
 * client + agent code under test is the real production code. Differences
 * from the real cloud are deliberate and limited to: in-memory state,
 * secrets kept raw in memory (so agent auth can be checked), approval is
 * an HTTP call instead of a logged-in browser page, and TTLs can be
 * shrunk per-test.
 */

import { randomBytes } from "node:crypto";

export interface MiniServerRow {
  id: string;
  name: string;
  host: string;
  status: string;
  os: string;
  agentVersion: string;
  cpu: number;
  memUsed: number;
  memTotal: number;
  lastSeen: number;
  secret: string | null; // raw, in-memory only (the real cloud stores sha256)
  processes: Array<Record<string, unknown>>;
}

interface MiniDevice {
  deviceCode: string;
  userCode: string;
  scope: "machine" | "user";
  status: "pending" | "approved" | "claimed" | "denied";
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  client: string | null;
  serverId?: string;
  expiresAt: number;
}

interface MiniUserToken {
  token: string;
  revoked: boolean;
}

const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function mintUserCode(): string {
  let raw = "";
  for (let i = 0; i < 12; i++) {
    raw += USER_CODE_ALPHABET[randomBytes(1)[0]! % USER_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export interface MiniCloudOptions {
  /** Auto-approve machine/user codes after this delay (stands in for the human). */
  autoApproveMs?: number;
  /** Device-code TTL (default 10 min; shrink for expiry tests). */
  ttlMs?: number;
}

export interface MiniCloud {
  url: string;
  port: number;
  stop(): Promise<void>;
  state: {
    servers: MiniServerRow[];
    devices: MiniDevice[];
    userTokens: MiniUserToken[];
    enrollmentTokens: string[];
    lastStateReport: Record<string, unknown> | null;
    commandResults: Array<{ commandId: string; success: boolean; data?: unknown; error?: string }>;
    logFrames: Array<{ process: string; lines: unknown[] }>;
  };
  /** Approve/deny a code the way the browser page would. */
  approve(userCode: string, action?: "approve" | "deny"): Promise<Response>;
  /** Dispatch a command at a connected agent; resolves with its result POST. */
  dispatchCommand(
    serverId: string,
    type: string,
    payload?: Record<string, unknown>
  ): Promise<{ commandId: string; success: boolean; data?: unknown; error?: string }>;
  /** Mint a legacy enrollment token for `pboss cloud connect <token>`. */
  mintEnrollmentToken(): string;
  /** Send a fire-and-forget control frame (log.watch / log.unwatch). */
  sendControl(serverId: string, frame: Record<string, unknown>): boolean;
  /** Answer slow_down exactly once on the next poll (client-backoff test). */
  slowDownOnce(): void;
}

export async function startMiniCloud(opts: MiniCloudOptions = {}): Promise<MiniCloud> {
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;

  const state: MiniCloud["state"] = {
    servers: [],
    devices: [],
    userTokens: [],
    enrollmentTokens: [],
    lastStateReport: null,
    commandResults: [],
    logFrames: [],
  };

  // Live agent WebSockets + pending commands (the "gateway")
  type MiniWs = { serverId: string; send: (s: string) => void; close: (code: number, reason?: string) => void; ping: () => void };
  const sockets = new Map<string, MiniWs>();
  const pending = new Map<string, { resolve: (r: any) => void; timer: ReturnType<typeof setTimeout> }>();
  const pings = new Map<string, ReturnType<typeof setInterval>>();
  let slowDownPending = false;

  function wsSend(serverId: string, text: string): boolean {
    const ws = sockets.get(serverId);
    if (!ws) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false; // closed — the agent will reconnect
    }
  }

  /** Apply a state report the way the real cloud's ingest would. */
  function applyStateReport(server: MiniServerRow, report: any): void {
    server.status = report.status === "offline" ? "offline" : report.status ?? "online";
    server.cpu = report.cpu ?? 0;
    server.memUsed = report.memUsed ?? 0;
    server.memTotal = report.memTotal ?? 0;
    server.lastSeen = Date.now();
    server.processes = report.processes ?? [];
    state.lastStateReport = report;
  }

  function agentAuth(header: string | null): MiniServerRow | null {
    if (!header?.startsWith("Bearer ")) return null;
    const raw = header.slice("Bearer ".length).trim();
    const dot = raw.indexOf(".");
    if (dot <= 0) return null;
    const server = state.servers.find((s) => s.id === raw.slice(0, dot));
    if (!server?.secret || server.secret !== raw.slice(dot + 1)) return null;
    return server;
  }

  function userTokenAuth(header: string | null): MiniUserToken | null {
    if (!header?.startsWith("Bearer pbu_")) return null;
    const token = header.slice("Bearer ".length).trim();
    const row = state.userTokens.find((t) => t.token === token);
    return row && !row.revoked ? row : null;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function claim(device: MiniDevice): Record<string, unknown> {
    device.status = "claimed";
    if (device.scope === "machine") {
      const secret = "pbs_" + randomBytes(18).toString("base64url");
      const server = state.servers.find((s) => s.id === device.serverId);
      if (server) server.secret = secret; // the real cloud stores sha256
      return {
        scope: "machine",
        serverId: device.serverId,
        serverSecret: secret,
        serverName: server?.name ?? "?",
      };
    }
    const token = "pbu_" + randomBytes(18).toString("base64url");
    state.userTokens.push({ token, revoked: false });
    return {
      scope: "user",
      token,
      tokenName: `cli@${device.hostname?.split(".")[0]?.slice(0, 20) || "unknown"}`,
      user: { email: "dev@procboss.test", name: "Dev Tester", handle: "devtester", provider: "github" },
    };
  }

  function approveInternal(device: MiniDevice, action: "approve" | "deny"): void {
    if (action === "deny") {
      device.status = "denied";
      return;
    }
    device.status = "approved";
    if (device.scope === "machine" && !device.serverId) {
      const name = `srv-${(device.hostname ?? "unknown").split(".")[0]!.slice(0, 12)}`;
      let server = state.servers.find((s) => s.host === device.hostname && !s.secret);
      if (!server) {
        server = {
          id: "srv_" + randomBytes(8).toString("hex"),
          name,
          host: device.hostname ?? "unknown",
          status: "offline",
          os: device.os ?? "unknown",
          agentVersion: device.agentVersion ?? "pboss/unknown",
          cpu: 0,
          memUsed: 0,
          memTotal: 0,
          lastSeen: Date.now(),
          secret: null,
          processes: [],
        };
        state.servers.push(server);
      }
      device.serverId = server.id;
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    /* ── device flow ─────────────────────────────────────────────────── */

    if (req.method === "POST" && path === "/api/device/code") {
      const body = (await req.json().catch(() => ({}))) as any;
      if (body.scope !== "machine" && body.scope !== "user") {
        return json({ error: "bad_request" }, 400);
      }
      const device: MiniDevice = {
        deviceCode: "pbd_" + randomBytes(18).toString("base64url"),
        userCode: mintUserCode(),
        scope: body.scope,
        status: "pending",
        hostname: typeof body.hostname === "string" ? body.hostname : null,
        os: typeof body.os === "string" ? body.os : null,
        arch: typeof body.arch === "string" ? body.arch : null,
        agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : null,
        client: typeof body.client === "string" ? body.client : null,
        expiresAt: Date.now() + ttlMs,
      };
      state.devices.push(device);
      if (opts.autoApproveMs != null) {
        setTimeout(() => {
          if (device.status === "pending") approveInternal(device, "approve");
        }, opts.autoApproveMs);
      }
      return json({
        deviceCode: device.deviceCode,
        userCode: device.userCode,
        verificationUrl: `${url.origin}/connect`,
        expiresInMs: ttlMs,
        intervalMs: 250, // fast for tests; the client honors the server's value
      });
    }

    if (req.method === "POST" && path === "/api/device/token") {
      const body = (await req.json().catch(() => ({}))) as any;
      const device = state.devices.find((d) => d.deviceCode === body.deviceCode);
      if (!device) return json({ error: "expired_token" }, 410);
      if (slowDownPending) {
        slowDownPending = false;
        return json({ error: "slow_down" }, 428);
      }
      if (device.status === "pending") {
        if (Date.now() > device.expiresAt) {
          device.status = "denied";
          return json({ error: "expired_token" }, 410);
        }
        return json({ error: "authorization_pending" }, 400);
      }
      if (device.status === "denied") return json({ error: "access_denied" }, 403);
      if (device.status === "claimed") return json({ error: "expired_token" }, 410);
      return json(claim(device));
    }

    if (req.method === "GET" && path.startsWith("/api/device/pending/")) {
      const code = decodeURIComponent(path.split("/").pop() ?? "");
      const device = state.devices.find((d) => d.userCode === code);
      if (!device) return json({ error: "unknown_code" }, 404);
      return json({
        scope: device.scope,
        status: device.status,
        hostname: device.hostname,
        os: device.os,
        arch: device.arch,
        agentVersion: device.agentVersion,
        client: device.client,
        expiresInMs: Math.max(0, device.expiresAt - Date.now()),
      });
    }

    if (req.method === "POST" && /^\/api\/device\/[^/]+\/approve$/.test(path)) {
      const code = decodeURIComponent(path.split("/")[3] ?? "");
      const body = (await req.json().catch(() => ({}))) as any;
      const action = body.action === "deny" ? "deny" : "approve";
      const device = state.devices.find((d) => d.userCode === code);
      if (!device) return json({ error: "unknown_code" }, 404);
      if (device.status !== "pending") return json({ error: "already_handled" }, 409);
      if (Date.now() > device.expiresAt) return json({ error: "expired_token" }, 410);
      approveInternal(device, action);
      return json({
        ok: true,
        action,
        scope: device.scope,
        serverName: state.servers.find((s) => s.id === device.serverId)?.name ?? null,
      });
    }

    /* ── user tokens (`pboss login` / whoami / logout) ───────────────── */

    if (req.method === "GET" && path === "/api/me") {
      const token = userTokenAuth(req.headers.get("authorization"));
      if (!token) return json({ error: "unauthorized" }, 401);
      return json({
        email: "dev@procboss.test",
        name: "Dev Tester",
        handle: "devtester",
        provider: "github",
        tokenName: "cli@test",
        tokenLastUsedAt: null,
      });
    }

    if (req.method === "POST" && path === "/api/me/revoke") {
      const token = userTokenAuth(req.headers.get("authorization"));
      if (token) token.revoked = true;
      return json({ ok: true, revoked: Boolean(token) });
    }

    /* ── agent endpoints (the machine credential) ────────────────────── */

    if (req.method === "POST" && path === "/api/agent/enroll") {
      const body = (await req.json().catch(() => ({}))) as any;
      if (!state.enrollmentTokens.includes(body.token)) {
        return json({ error: "token invalid, expired or already used" }, 403);
      }
      state.enrollmentTokens.splice(state.enrollmentTokens.indexOf(body.token), 1);
      const secret = "pbs_" + randomBytes(18).toString("base64url");
      const name = `srv-${(body.hostname ?? "unknown").split(".")[0]?.slice(0, 12) ?? "unknown"}`;
      const row: MiniServerRow = {
        id: "srv_" + randomBytes(8).toString("hex"),
        name,
        host: body.hostname ?? "unknown",
        status: "offline",
        os: body.platform ?? "unknown",
        agentVersion: `pboss/${body.pbossVersion ?? "?"}`,
        cpu: 0,
        memUsed: 0,
        memTotal: 0,
        lastSeen: Date.now(),
        secret,
        processes: [],
      };
      state.servers.push(row);
      return json({ serverId: row.id, serverSecret: secret, serverName: row.name });
    }

    if (req.method === "POST" && path === "/api/agent/state") {
      const server = agentAuth(req.headers.get("authorization"));
      if (!server) return json({ error: "unauthorized" }, 401);
      // the real cloud answers 409 until the agent WebSocket is registered
      if (!sockets.has(server.id)) return json({ error: "stream_not_registered" }, 409);
      const report = (await req.json().catch(() => ({}))) as any;
      applyStateReport(server, report);
      return json({ ok: true });
    }

    if (req.method === "GET" && path === "/api/agent/servers") {
      const server = agentAuth(req.headers.get("authorization"));
      if (!server) return json({ error: "unauthorized" }, 401);
      return json({
        servers: state.servers.map((s) => ({
          id: s.id,
          name: s.name,
          host: s.host,
          status: sockets.has(s.id) ? "online" : s.status,
          os: s.os,
          agentVersion: s.agentVersion,
          cpu: s.status === "offline" && !sockets.has(s.id) ? 0 : s.cpu,
          memUsed: s.memUsed,
          memTotal: s.memTotal,
          lastSeen: new Date(s.lastSeen).toISOString(),
          enrolled: s.secret != null,
        })),
      });
    }

    if (req.method === "POST" && path === "/api/agent/disconnect") {
      const server = agentAuth(req.headers.get("authorization"));
      if (server) server.secret = null; // revoked
      return json({ ok: true });
    }



    if (req.method === "POST" && path === "/api/agent/command-result") {
      const server = agentAuth(req.headers.get("authorization"));
      if (!server) return json({ error: "unauthorized" }, 401);
      const result = (await req.json().catch(() => ({}))) as any;
      state.commandResults.push(result);
      const waiter = pending.get(result.commandId);
      if (waiter) {
        pending.delete(result.commandId);
        clearTimeout(waiter.timer);
        waiter.resolve(result);
      }
      return json({ ok: true });
    }

    return json({ error: "not_found", path }, 404);
  }

  const server = Bun.serve<{ authorization?: string }>({
    port: 0,
    fetch(req, bunServer) {
      if (new URL(req.url).pathname === "/ws/agent") {
        const ok = bunServer.upgrade(req, {
          data: { authorization: req.headers.get("authorization") ?? "" },
        });
        if (ok) return; // upgraded — websocket handlers take over
        return json({ error: "upgrade_failed" }, 500);
      }
      return handle(req);
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        const server = agentAuth(data.authorization ?? null);
        if (!server) {
          // invalid/revoked credential — same close code the real cloud uses
          ws.close(4001, "revoked");
          return;
        }
        const entry: MiniWs = {
          serverId: server.id,
          send: (s) => ws.send(s),
          close: (code, reason) => ws.close(code, reason),
          ping: () => ws.ping(),
        };
        const prev = sockets.get(server.id);
        if (prev) prev.close(1000, "replaced");
        sockets.set(server.id, entry);
        ws.send(JSON.stringify({ type: "hello", serverId: server.id, now: Date.now() }));
        pings.set(server.id, setInterval(() => entry.ping(), 2000));
      },
      message(ws, raw) {
        const data = ws.data as { authorization?: string };
        const server = agentAuth(data.authorization ?? null);
        if (!server) return;
        let frame: any;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        switch (frame?.type) {
          case "state":
            applyStateReport(server, frame.report ?? {});
            break;
          case "command-result": {
            const result = frame.result ?? {};
            state.commandResults.push(result);
            const waiter = pending.get(result.commandId);
            if (waiter) {
              pending.delete(result.commandId);
              clearTimeout(waiter.timer);
              waiter.resolve(result);
            }
            break;
          }
          case "log":
            state.logFrames.push({ process: frame.process, lines: frame.lines ?? [] });
            break;
          default:
            break; // pong etc.
        }
      },
      close(ws) {
        const data = ws.data as { authorization?: string };
        const server = agentAuth(data.authorization ?? null);
        if (!server) return;
        const entry = sockets.get(server.id);
        if (entry && entry.serverId === server.id) {
          sockets.delete(server.id);
          const iv = pings.get(server.id);
          if (iv) clearInterval(iv);
          pings.delete(server.id);
        }
      },
    },
  });

  const mini: MiniCloud = {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    state,
    stop: async () => {
      for (const iv of pings.values()) clearInterval(iv);
      pings.clear();
      for (const ws of sockets.values()) ws.close(1001, "server stopping");
      sockets.clear();
      server.stop(true);
    },
    approve: (userCode, action = "approve") =>
      fetch(`${mini.url}/api/device/${encodeURIComponent(userCode)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    dispatchCommand: (serverId, type, payload = {}) =>
      new Promise((resolve) => {
        const commandId = "cmd_" + randomBytes(6).toString("hex");
        const timer = setTimeout(() => {
          pending.delete(commandId);
          resolve({ commandId, success: false, error: "agent timeout" });
        }, 10_000);
        pending.set(commandId, { resolve, timer });
        const sent = wsSend(
          serverId,
          JSON.stringify({ type: "command", command: { id: commandId, type, payload } })
        );
        if (!sent) {
          pending.delete(commandId);
          clearTimeout(timer);
          resolve({ commandId, success: false, error: "agent offline" });
        }
      }),
    sendControl: (serverId, frame) => wsSend(serverId, JSON.stringify(frame)),
    mintEnrollmentToken: () => {
      const token = "pbc_" + randomBytes(12).toString("base64url");
      state.enrollmentTokens.push(token);
      return token;
    },
    slowDownOnce: () => {
      slowDownPending = true;
    },
  };

  return mini;
}
