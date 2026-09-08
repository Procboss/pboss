/**
 * Cloud device-flow client tests — the headless login handshake
 * (`pboss cloud connect` / `pboss login`), against the mini-cloud
 * contract double (tests/helpers/mini-cloud.ts).
 *
 * Covers: requestDeviceCode → poll (pending / slow_down / approve / deny /
 * expiry / single claim), the user credential store (0600, round-trip,
 * corrupt file), browserPlausible (the "intelligent" browser decision),
 * and the user-token endpoints the CLI uses directly (me / revoke).
 *
 * PBOSS_HOME binding: constants bind once per bun test process — file
 * assertions use the BOUND constants' path, and only OUR file
 * (cloud-user.json) is removed, never the whole bound home.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = mkdtempSync(join(tmpdir(), `pboss-clouddev-${process.pid}-`));
process.env.PBOSS_HOME = TEST_HOME;
process.env.PBOSS_NO_BROWSER = "1"; // never touch a real browser from tests

// BOUND constants (may be another file's home under the shared registry)
const { CLOUD_USER_FILE } = await import("../src/constants");
const auth = await import("../src/cloud-auth");
type CloudUserCredential = import("../src/cloud-auth").CloudUserCredential;
const { startMiniCloud } = await import("./helpers/mini-cloud");
type MiniCloud = import("./helpers/mini-cloud").MiniCloud;

let mini: MiniCloud;

beforeAll(async () => {
  mini = await startMiniCloud();
});

afterAll(async () => {
  await mini.stop();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

afterEach(() => {
  try {
    rmSync(CLOUD_USER_FILE, { force: true });
  } catch {
    /* not ours to clean */
  }
});

describe("device flow — machine scope (pboss cloud connect)", () => {
  test("requestDeviceCode sends machine facts and returns a grant", async () => {
    const grant = await auth.requestDeviceCode(mini.url, "machine");
    expect(grant.deviceCode.startsWith("pbd_")).toBe(true);
    expect(grant.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(grant.verificationUrl).toBe(`${mini.url}/connect`);
    expect(grant.intervalMs).toBeGreaterThan(0);
    const device = mini.state.devices.find((d) => d.deviceCode === grant.deviceCode);
    expect(device?.hostname).toBeTruthy(); // the approval card shows it
    expect(device?.agentVersion?.startsWith("pboss/")).toBe(true);
  });

  test("pending → approve → claim returns the machine credential once", async () => {
    const grant = await auth.requestDeviceCode(mini.url, "machine");
    await expect(auth.pollDeviceToken(mini.url, grant, { timeoutMs: 1000 })).rejects.toThrow(
      /timed out waiting for authorization/
    );
    const res = await mini.approve(grant.userCode);
    expect(res.ok).toBe(true);
    const claim = await auth.pollDeviceToken(mini.url, grant);
    if (claim.scope !== "machine") throw new Error("expected machine claim");
    expect(claim.serverId.startsWith("srv_")).toBe(true);
    expect(claim.serverSecret.startsWith("pbs_")).toBe(true);
    expect(claim.serverName.startsWith("srv-")).toBe(true);
    // single claim — a second poller gets expired_token
    await expect(auth.pollDeviceToken(mini.url, grant, { timeoutMs: 500 })).rejects.toThrow(
      /code expired/
    );
  });

  test("slow_down backs the client off and the claim still succeeds", async () => {
    const grant = await auth.requestDeviceCode(mini.url, "machine");
    await mini.approve(grant.userCode);
    mini.slowDownOnce();
    const claim = await auth.pollDeviceToken(mini.url, grant);
    expect(claim.scope).toBe("machine");
  });

  test("denial in the browser is a clear error at the terminal", async () => {
    const grant = await auth.requestDeviceCode(mini.url, "machine");
    await mini.approve(grant.userCode, "deny");
    await expect(auth.pollDeviceToken(mini.url, grant, { timeoutMs: 2000 })).rejects.toThrow(
      /denied in the browser/
    );
  });

  test("expired codes refuse approval and expire the poll", async () => {
    const short = await startMiniCloud({ ttlMs: 300 });
    try {
      const grant = await auth.requestDeviceCode(short.url, "machine");
      await new Promise((r) => setTimeout(r, 400));
      const res = await short.approve(grant.userCode);
      expect(res.status).toBe(410); // expired_token — the gate refuses late approvals
      await expect(
        auth.pollDeviceToken(short.url, grant, { timeoutMs: 1500 })
      ).rejects.toThrow(/code expired/);
    } finally {
      await short.stop();
    }
  });
});

describe("device flow — user scope (pboss login)", () => {
  test("claim returns a pbu_ token + identity; me/revoke work with it", async () => {
    const grant = await auth.requestDeviceCode(mini.url, "user");
    expect(mini.state.devices.find((d) => d.deviceCode === grant.deviceCode)?.client).toBe("pboss-cli");
    await mini.approve(grant.userCode);
    const claim = await auth.pollDeviceToken(mini.url, grant);
    if (claim.scope !== "user") throw new Error("expected user claim");
    expect(claim.token.startsWith("pbu_")).toBe(true);
    expect(claim.user.email).toBe("dev@procboss.test");

    const cred: CloudUserCredential = {
      cloudUrl: mini.url,
      token: claim.token,
      tokenName: claim.tokenName,
      user: claim.user,
    };
    const me = await auth.cloudUserMe(cred);
    expect(me?.email).toBe("dev@procboss.test");
    expect(await auth.cloudUserRevoke(cred)).toBe(true);
    expect(await auth.cloudUserMe(cred)).toBeNull(); // revoked
  });
});

describe("user credential file (cloud-user.json)", () => {
  test("round-trips and is written 0600", () => {
    auth.saveCloudUser({
      cloudUrl: "http://example.test",
      token: "pbu_xyz",
      tokenName: "cli@test",
      user: { email: "a@b.c", name: "A", handle: null, provider: "github" },
    });
    const loaded = auth.loadCloudUser();
    expect(loaded?.token).toBe("pbu_xyz");
    expect(loaded?.user.email).toBe("a@b.c");
    const mode = statSync(CLOUD_USER_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("corrupt or partial files read as logged-out, never throw", () => {
    writeFileSync(CLOUD_USER_FILE, "{broken json");
    expect(auth.loadCloudUser()).toBeNull();
    writeFileSync(CLOUD_USER_FILE, JSON.stringify({ cloudUrl: "x" }));
    expect(auth.loadCloudUser()).toBeNull();
  });

  test("clearCloudUser removes the file", () => {
    auth.saveCloudUser({
      cloudUrl: "http://x",
      token: "pbu_t",
      tokenName: "cli",
      user: { email: "e@x", name: "E", handle: null, provider: "github" },
    });
    auth.clearCloudUser();
    expect(auth.loadCloudUser()).toBeNull();
  });
});

describe("browserPlausible — the headless intelligence", () => {
  const SAVED: Record<string, string | undefined> = {};
  function setEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      SAVED[k] ??= process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete SAVED[k];
    }
  });

  test("PBOSS_NO_BROWSER=1 always wins — servers stay print-only", () => {
    setEnv({ PBOSS_NO_BROWSER: "1", BROWSER: "firefox", DISPLAY: ":0" });
    expect(auth.browserPlausible()).toBe(false);
  });

  test("an explicit BROWSER means try it, even without DISPLAY", () => {
    setEnv({ PBOSS_NO_BROWSER: undefined, BROWSER: "firefox", DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
    expect(auth.browserPlausible()).toBe(true);
  });

  test("linux without a desktop session is print-only (the SSH case)", () => {
    setEnv({ PBOSS_NO_BROWSER: undefined, BROWSER: undefined, DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
    if (process.platform === "linux") expect(auth.browserPlausible()).toBe(false);
  });

  test("DISPLAY (or WAYLAND_DISPLAY) means a desktop is present", () => {
    setEnv({ PBOSS_NO_BROWSER: undefined, BROWSER: undefined, DISPLAY: ":0" });
    expect(auth.browserPlausible()).toBe(true);
    setEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-0" });
    expect(auth.browserPlausible()).toBe(true);
  });
});
