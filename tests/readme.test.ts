import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const REPO = join(dirname(import.meta.path), "..");
const readme = readFileSync(join(REPO, "README.md"), "utf8");

// 2026-09-29: HTML comments are not documentation — copy preserved for a
// later re-add (the universal installer, multi-language support) must not
// count as present. "Removed" checks run on the comment-stripped text.
const visible = readme.replace(/<!--[\s\S]*?-->/g, "");

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
    expect(visible).not.toContain("Remote deployment");
    expect(visible).not.toContain("SSH deploys with release directories");
    expect(visible).not.toContain("symlink rotation");
  });

  test("no \"ProcBoss Cloud (optional)\" Highlights bullet", () => {
    expect(visible).not.toContain("**ProcBoss Cloud (optional)**");
    expect(visible).not.toContain("Outbound-only connection");
    expect(visible).not.toContain("Everything local works without it");
  });

  test("the cloud-connect demo block (removed earlier the same way) stays gone", () => {
    expect(visible).not.toContain("Waiting for authorization");
    expect(visible).not.toContain("Server authorized and connected");
    expect(visible).not.toContain("Open the URL anywhere");
  });

  test("no One-Line Universal Install (removed 2026-09-29 — package managers only for now)", () => {
    expect(visible).not.toContain("One-Line Universal Install");
    expect(visible).not.toContain("curl -fsSL https://procboss.com/install.sh | bash");
    expect(visible).not.toContain("install.ps1");
    expect(visible).not.toContain("install.cmd");
  });

  test("no Runtime-Agnostic Architecture section (moved to the main docs, 2026-09-29)", () => {
    expect(visible).not.toContain("## Runtime-Agnostic Architecture");
    expect(visible).not.toContain("Runtime Adapter"); // the ASCII diagram's node
    expect(visible).not.toContain("### Which runtime is executing pboss?");
  });

  test("no multi-language marketing (removed 2026-09-29 — JS/TS backend focus)", () => {
    // The tagline and the first Highlights bullet sold "everything else on the
    // machine: Go, Python, Rust, Ruby, PHP, Java...". Hidden for the JS/TS
    // focus; re-add with multi-language support when it returns.
    expect(visible).not.toContain("Go, Python, Rust, Ruby, PHP");
    expect(visible).not.toContain("Everything else is managed too");
    expect(visible).not.toContain("universal production process manager");
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
