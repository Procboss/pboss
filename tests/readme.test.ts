import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const REPO = join(dirname(import.meta.path), "..");
const readme = readFileSync(join(REPO, "README.md"), "utf8");

/**
 * README content contract (owner request, 2026-09-10): two Highlights
 * bullets were removed on the owner's exact instruction —
 *   "Remote deployment — SSH deploys with release directories, symlink
 *    rotation, pre/post hooks."
 *   "ProcBoss Cloud (optional) — pboss cloud connect prints a code, …"
 * Earlier (same day) the "Link the machine to ProcBoss Cloud" demo block
 * (device code + "Waiting for authorization…" + approval paragraph) was
 * removed the same way. These pins keep them out — marketing copy the
 * owner asks to disappear must STAY gone across future edits.
 */

describe("README.md: removed-at-the-owner's-request sections stay removed", () => {
  test("no \"Remote deployment\" Highlights bullet", () => {
    expect(readme).not.toContain("Remote deployment");
    expect(readme).not.toContain("SSH deploys with release directories");
    expect(readme).not.toContain("symlink rotation");
  });

  test("no \"ProcBoss Cloud (optional)\" Highlights bullet", () => {
    expect(readme).not.toContain("**ProcBoss Cloud (optional)**");
    expect(readme).not.toContain("Outbound-only connection");
    expect(readme).not.toContain("Everything local works without it");
  });

  test("the cloud-connect demo block (removed earlier the same way) stays gone", () => {
    expect(readme).not.toContain("Waiting for authorization");
    expect(readme).not.toContain("Server authorized and connected");
    expect(readme).not.toContain("Open the URL anywhere");
  });

  test("no One-Line Universal Install (removed 2026-09-29 — package managers only for now)", () => {
    expect(readme).not.toContain("One-Line Universal Install");
    expect(readme).not.toContain("curl -fsSL https://procboss.com/install.sh | bash");
    expect(readme).not.toContain("install.ps1");
    expect(readme).not.toContain("install.cmd");
  });

  test("no Runtime-Agnostic Architecture section (moved to the main docs, 2026-09-29)", () => {
    expect(readme).not.toContain("## Runtime-Agnostic Architecture");
    expect(readme).not.toContain("Runtime Adapter"); // the ASCII diagram's node
    expect(readme).not.toContain("### Which runtime is executing pboss?");
  });
});

describe("README.md: the untouched core contract survives removals", () => {
  test("Highlights keeps its head and tail — the removal was surgical", () => {
    expect(readme).toContain("## Highlights");
    expect(readme).toContain("**First-class Bun, Node.js, and Deno**");
    expect(readme).toContain("**Persistence (default on)**");
    expect(readme).toContain("**Tiny footprint**");
    // Highlights is a contiguous list: no orphaned blank line left behind
    // between Persistence and Tiny footprint by the deletion.
    const highlights = readme.split("## Highlights")[1]!.split("---")[0]!;
    expect(highlights).toContain(
      "apps survive restarts and reboots.\n- **Tiny footprint**",
    );
  });

  test("install / quick-start / updating sections intact", () => {
    // 2026-09-29: the universal installer one-liner was replaced by the
    // package-manager block (bun / npm / deno) at the owner's request.
    expect(readme).toContain("### Package-Manager Installs");
    expect(readme).toContain("bun install -g pboss");
    expect(readme).toContain("npm install -g pboss");
    // 2026-09-29: -A added at the owner's request — Deno is deny-by-default
    // and a process manager needs the full grant set.
    expect(readme).toContain("deno install -g -A npm:pboss");
    expect(readme).toContain("## Quick Start");
    expect(readme).toContain("pboss start"); // the issue-#29 auto-detection story
    expect(readme).toContain("pboss upgrade --check");
    expect(readme).toContain("## Documentation");
    expect(readme).toContain("## License");
  });
});
