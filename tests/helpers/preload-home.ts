/**
 * Suite-wide PBOSS_HOME isolation — the preload every `bun test` runs
 * BEFORE any test file loads (bunfig.toml [test] preload).
 *
 * The incident this closes (owner report, 2026-10-15): `bun test` runs
 * every test file in ONE process, and src/constants.ts resolves
 * PBOSS_HOME at IMPORT time. Whichever file imports constants first
 * locks the home for the whole suite — alphabetically that is
 * tests/api.test.ts, which sets nothing, so the suite ran against the
 * DEVELOPER'S REAL ~/.pboss. The 20-odd test files that set
 * process.env.PBOSS_HOME at module top were silent no-ops on full-suite
 * runs (their isolation only ever worked when a file ran alone).
 *
 * On CI this was invisible — a fresh runner has an empty ~/.pboss. On a
 * development machine that USES pboss it is not: the owner's ~/.pboss
 * carried a .runtime stamped to deno (running the JSR entry under deno
 * stamps the selection), so every test that spawned a .ts probe
 * resolved its interpreter to `deno run` — the probes crashed on the
 * Bun global inside 100ms, and the env-reread suite burned its whole
 * 8s waitProbe budget waiting for a file the child never wrote. The
 * ClusterManager unit failed the same way: cmd[0] was the deno binary,
 * not the bun path the test pinned.
 *
 * The fix is suite-wide because the leak is suite-wide: this preload
 * locks a fresh, empty, per-run temp home before any src module loads —
 * no .runtime, no runtime-overrides, no daemon socket of a live
 * manager — on every machine, forever. Per-test hermetic homes stay as
 * they are (they were already no-ops on full-suite runs; nothing
 * changes for them).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pboss-test-home-"));
process.env.PBOSS_HOME = home;

// Best-effort sweep on suite exit — a crashed run leaves the dir for the
// OS tmp cleaner, which is the same deal every hermetic test here makes.
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* a child may still hold a handle — the tmp cleaner takes it */
  }
});
