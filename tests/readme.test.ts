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

  test("no One-Line Universal Install heading (the installer is a section now, 2026-10-04)", () => {
    expect(visible).not.toContain("One-Line Universal Install");
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

describe("package.json: the npm-facing description matches the JS/TS focus", () => {
  // 2026-09-29: the description still sold "that also runs Go, Python, Rust,
  // Ruby, PHP, Java, binaries, and shell scripts under one supervisor" after
  // the README/DOCS moved to the JS/TS backend focus — fixed before the 1.5.1
  // publish. It now mirrors the README tagline verbatim.
  const pkg = JSON.parse(
    readFileSync(join(REPO, "package.json"), "utf8"),
  ) as { description: string };

  test("description is the README tagline (JS/TS focus, no multi-language copy)", () => {
    expect(pkg.description).toBe(
      "A blazing-fast, runtime-agnostic process manager for Bun, Node.js, and Deno — native APIs per runtime, no compatibility layers — built for JavaScript and TypeScript backends.",
    );
    expect(pkg.description).not.toContain("Go, Python");
    expect(pkg.description).not.toContain("shell scripts under one supervisor");
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
    // and a process manager needs the full grant set. 2026-10-04: the runtime
    // wrapper architecture — deno installs the published ENTRY subpath
    // (--name pins the command; deno runs package bins as modules).
    // 2026-10-06: --minimum-dependency-age=0 — Deno ≥ 2.9's own escape hatch
    // for the 24-hour supply-chain hold (without it the unpinned spec
    // silently installs the PREVIOUS release — the owner's "stuck at 1.5.3"
    // report).
    expect(readme).toContain(
      "deno install -g -A --minimum-dependency-age=0 --name pboss npm:pboss/deno-entry",
    );
    // 2026-09-29: per-runtime install blocks at the owner's request — a bold
    // runtime label above its own fenced single-command block, so GitHub's
    // copy button copies exactly one install command.
    expect(readme).toContain("**Node.js**\n\n```bash\nnpm install -g pboss\n```");
    expect(readme).toContain("**Bun**\n\n```bash\nbun install -g pboss\n```");
    expect(readme).toContain(
      "**Deno**\n\n```bash\ndeno install -g -A --minimum-dependency-age=0 --name pboss npm:pboss/deno-entry\n```",
    );
    // 2026-10-04: the universal installer is BACK (runtime-aware): the
    // one-liner prompts for a runtime (Node default), --runtime=<x> pins it,
    // and the PowerShell twin serves Windows.
    expect(readme).toContain("### Universal Installer (recommended)");
    expect(readme).toContain("curl -fsSL https://procboss.com/install.sh | sh");
    expect(readme).toContain("curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=bun");
    expect(readme).toContain("powershell -c \"irm https://procboss.com/install.ps1 | iex\"");
    // The runtime-selection contract: .runtime, --runtime, pboss runtime change.
    expect(readme).toContain("### The Runtime Selection");
    expect(readme).toContain("~/.pboss/.runtime");
    expect(readme).toContain("pboss runtime change");
    expect(readme).toContain("pboss --runtime=bun");
    // 2026-09-29: the runtime-selection rule (node:cluster task) — unstated
    // runtimes inherit the MAIN runtime running pboss; Node apps cluster
    // through node:cluster with one shared port.
    expect(readme).toContain("An unstated app runtime inherits the main runtime running pboss");
    expect(readme).toContain("Node apps cluster through `node:cluster` with one shared port");
    expect(readme).toContain("## Quick Start");
    expect(readme).toContain("pboss start"); // the issue-#29 auto-detection story
    expect(readme).toContain("pboss upgrade --check");
    expect(readme).toContain("## Documentation");
    expect(readme).toContain("## License");
  });
});
