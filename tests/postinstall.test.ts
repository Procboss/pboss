import { describe, test, expect } from "bun:test";

/**
 * The npm `postinstall` hook (src/postinstall.ts) — boot persistence by
 * default for GLOBAL installs only.
 *
 * These tests cover the decision logic only (never the side effects —
 * actually installing a systemd unit from CI would be wrong on every level):
 *   - global installs (npm i -g) act;
 *   - local/dev installs stay completely silent;
 *   - the manual hint names the right command per platform.
 */
import { isGlobalInstall, manualInstallHint } from "../src/postinstall";

describe("postinstall: isGlobalInstall gate", () => {
  test("true for npm_config_global=true (npm i -g)", () => {
    expect(isGlobalInstall({ npm_config_global: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  test("true for npm_config_global=1", () => {
    expect(isGlobalInstall({ npm_config_global: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  test("false for local installs (env var absent)", () => {
    expect(isGlobalInstall({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("false for explicit non-global values", () => {
    expect(isGlobalInstall({ npm_config_global: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isGlobalInstall({ npm_config_global: "" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("postinstall never acts during local dev installs of the repo", () => {
    // `bun install` / `npm install` in the pboss repo itself: no global flag.
    // This is exactly the environment these very tests run in.
    expect(isGlobalInstall()).toBe(
      process.env.npm_config_global === "true" || process.env.npm_config_global === "1"
    );
  });
});

describe("postinstall: manualInstallHint", () => {
  test("names the startup install command for this platform", () => {
    const hint = manualInstallHint();
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("pboss startup install");

    // The service is per-user on every platform: the hint is sudo-free
    // everywhere (no "sudo", no "Administrator", no elevated shell).
    expect(hint).not.toContain("sudo");
    expect(hint).not.toContain("Administrator");
  });
});
