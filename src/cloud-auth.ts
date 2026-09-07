/**
 * ProcBoss (pboss) — Cloud login client
 *
 * The device-code handshake (RFC 8628-style) for headless machines:
 * `pboss cloud connect` (machine scope) and `pboss login` (user scope).
 * The CLI requests a code, prints the URL + the short human code, and
 * polls; a person approves in a browser on ANY device — no browser on
 * the server, no pasted tokens, no passwords. The cloud-side counterpart
 * is procboss.com's /api/device/* (src/lib/cloud/device.ts — keep in sync).
 *
 * Architecture rule (mirrors the agent's): machine credentials belong to
 * the DAEMON (cloud.json, handed over via the `cloudLink` RPC after this
 * flow completes); user credentials belong to the CLI (cloud-user.json,
 * used directly for whoami/logout). The CLI never holds the machine
 * secret beyond the handshake itself.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { platform, arch, hostname } from "node:os";
import { CLOUD_USER_FILE, VERSION } from "./constants";
import { resolveCloudUrl } from "./cloud";
import { ignore } from "./error-handling";

/* ── wire shapes (the cloud's /api/device responses) ──────────────────── */

export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInMs: number;
  intervalMs: number;
}

export interface MachineClaim {
  scope: "machine";
  serverId: string;
  serverSecret: string;
  serverName: string;
}

export interface UserClaim {
  scope: "user";
  token: string;
  tokenName: string;
  user: { email: string; name: string; handle: string | null; provider: string };
}

export type DeviceTokenClaim = MachineClaim | UserClaim | { error: string };

/** Machine facts sent with the code request — the approval card shows them. */
export function deviceClientMeta(): {
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
} {
  return {
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    agentVersion: `pboss/${VERSION}`,
  };
}

/* ── step 1: ask the cloud for a code ─────────────────────────────────── */

export async function requestDeviceCode(
  cloudUrl: string,
  scope: "machine" | "user",
): Promise<DeviceCodeGrant> {
  const meta = deviceClientMeta();
  const res = await fetch(`${cloudUrl}/api/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope,
      hostname: meta.hostname,
      os: meta.os,
      arch: meta.arch,
      agentVersion: meta.agentVersion,
      client: scope === "user" ? "pboss-cli" : undefined,
    }),
  });
  const body = (await res.json().catch((err: unknown) => {
    ignore("parse device code response", err);
    return {};
  })) as Partial<DeviceCodeGrant> & { error?: string };
  if (!res.ok || !body.deviceCode || !body.userCode || !body.verificationUrl) {
    throw new Error(body.error ?? `device code request failed (HTTP ${res.status})`);
  }
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUrl: body.verificationUrl,
    expiresInMs: body.expiresInMs ?? 600_000,
    intervalMs: body.intervalMs ?? 2000,
  };
}

/* ── step 3: poll until the human approves ────────────────────────────── */

export interface PollOpts {
  /** Printed progress lines while waiting (TTY redraw is the caller's job). */
  onWait?: (elapsedMs: number) => void;
  /** Test hook: cap the loop early instead of the full 10 minutes. */
  timeoutMs?: number;
}

export async function pollDeviceToken(
  cloudUrl: string,
  grant: DeviceCodeGrant,
  opts: PollOpts = {},
): Promise<MachineClaim | UserClaim> {
  const deadline = Date.now() + (opts.timeoutMs ?? grant.expiresInMs + 15_000);
  let interval = grant.intervalMs;
  const started = Date.now();

  for (;;) {
    const res = await fetch(`${cloudUrl}/api/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    const body = (await res.json().catch((err: unknown) => {
      ignore("parse device token response", err);
      return {};
    })) as DeviceTokenClaim;

    if (!("error" in body) && (body.scope === "machine" || body.scope === "user")) {
      return body;
    }
    const err = "error" in body ? body.error : "bad_response";
    if (err === "expired_token") {
      throw new Error(
        "the code expired (10 minutes) — run the command again and approve promptly"
      );
    }
    if (err === "access_denied") {
      throw new Error("the request was denied in the browser");
    }
    if (err === "slow_down") {
      interval = Math.round(interval * 1.5);
      continue; // no sleep — the interval increase IS the backoff
    }
    // authorization_pending — or an unexpected error; keep trying until deadline
    if (Date.now() >= deadline) {
      throw new Error(err === "authorization_pending"
        ? "timed out waiting for authorization"
        : `device token poll failed: ${err}`);
    }
    opts.onWait?.(Date.now() - started);
    await sleep(Math.max(250, interval));
  }
}

/* ── the "intelligent" browser bit ────────────────────────────────────── */

/**
 * Should we even TRY to open a browser here? On a real server (SSH, no
 * desktop) the answer is no — printing URL + code is the whole UX. On the
 * developer's laptop the tab just opens. PBOSS_NO_BROWSER=1 forces print.
 */
export function browserPlausible(): boolean {
  if (process.env.PBOSS_NO_BROWSER) return false;
  if (process.env.BROWSER) return true;
  if (process.platform === "darwin" || process.platform === "win32") return true;
  // linux/other: only a desktop session can serve xdg-open
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Best-effort `open`/`xdg-open`/`start`. Returns false when it can't. */
export async function openBrowser(url: string): Promise<boolean> {
  const cmds: string[][] =
    process.platform === "darwin"
      ? [["open", url]]
      : process.platform === "win32"
        ? [["cmd", "/c", "start", "", url]]
        : process.env.BROWSER
          ? [[process.env.BROWSER, url]]
          : [["xdg-open", url]];
  for (const cmd of cmds) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      // Don't block the CLI on the opener; a hung xdg-open must not hang login.
      void proc.exited.catch((err: unknown) => ignore(`browser opener ${cmd[0]}`, err));
      return true;
    } catch (err) {
      ignore(`spawn browser opener ${cmd[0]}`, err);
    }
  }
  return false;
}

/* ── user credential (CLI-owned, 0600, machine-agnostic) ──────────────── */

export interface CloudUserCredential {
  cloudUrl: string;
  token: string;
  tokenName: string;
  user: { email: string; name: string; handle: string | null; provider: string };
}

export function loadCloudUser(): CloudUserCredential | null {
  try {
    if (!existsSync(CLOUD_USER_FILE)) return null;
    const raw = JSON.parse(readFileSync(CLOUD_USER_FILE, "utf-8")) as Partial<CloudUserCredential>;
    if (!raw.cloudUrl || !raw.token || !raw.user?.email) return null;
    return {
      cloudUrl: String(raw.cloudUrl),
      token: String(raw.token),
      tokenName: raw.tokenName ? String(raw.tokenName) : "cli",
      user: {
        email: String(raw.user.email),
        name: String(raw.user.name ?? ""),
        handle: raw.user.handle ? String(raw.user.handle) : null,
        provider: String(raw.user.provider ?? ""),
      },
    };
  } catch {
    return null; // corrupt file = logged out
  }
}

export function saveCloudUser(cred: CloudUserCredential): void {
  writeFileSync(CLOUD_USER_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try {
    chmodSync(CLOUD_USER_FILE, 0o600);
  } catch (err) {
    // Best-effort — same policy as the machine credential file.
    ignore(`chmod user credential ${CLOUD_USER_FILE} 0600`, err);
  }
}

export function clearCloudUser(): void {
  try {
    if (existsSync(CLOUD_USER_FILE)) unlinkSync(CLOUD_USER_FILE);
  } catch (err) {
    ignore(`unlink user credential ${CLOUD_USER_FILE}`, err);
  }
}

/** GET /api/me with the CLI token — null when revoked/rejected. */
export async function cloudUserMe(cred: CloudUserCredential): Promise<{
  email: string;
  name: string;
  handle: string | null;
  provider: string;
  tokenName: string;
  tokenLastUsedAt: string | null;
} | null> {
  try {
    const res = await fetch(`${cred.cloudUrl}/api/me`, {
      headers: { Authorization: `Bearer ${cred.token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as any;
  } catch (err) {
    ignore("cloud /api/me", err);
    return null;
  }
}

/** POST /api/me/revoke — best-effort; local logout proceeds regardless. */
export async function cloudUserRevoke(cred: CloudUserCredential): Promise<boolean> {
  try {
    const res = await fetch(`${cred.cloudUrl}/api/me/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cred.token}` },
    });
    return res.ok;
  } catch (err) {
    ignore("cloud /api/me/revoke", err);
    return false;
  }
}

/** Shared URL resolution for the login commands. */
export { resolveCloudUrl };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
