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
});

describe("README.md: the untouched core contract survives removals", () => {
  test("Highlights keeps its head and tail — the removal was surgical", () => {
    expect(readme).toContain("## Highlights");
    expect(readme).toContain("**Universal runtimes**");
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
    expect(readme).toContain("curl -fsSL https://procboss.com/install.sh | bash");
    expect(readme).toContain("## Quick Start");
    expect(readme).toContain("pboss start"); // the issue-#29 auto-detection story
    expect(readme).toContain("pboss upgrade --check");
    expect(readme).toContain("## Documentation");
    expect(readme).toContain("## License");
  });
});
