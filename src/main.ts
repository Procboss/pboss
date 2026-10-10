/**
 * ProcBoss (pboss) — dist build entry.
 *
 * The compiled bundle's entry (dist/cli.js) and, transitively, every
 * per-runtime entrypoint (dist/cli.node.js / cli.bun.js / cli.deno.js —
 * they dynamically import this file after the wrapper dispatched them).
 * index.ts's import.meta.main guard covers `bun run src/index.ts` dev use;
 * under the bundled file (Node/Deno execute it without import.meta.main),
 * this explicit entry is what actually boots the CLI.
 *
 * `--runtime=<x>` never reaches this file: it is a LAUNCHER flag
 * (owner spec, 2026-10-07) — bin/pboss.sh / bin/pboss.ps1 consume it,
 * strip it, persist the selection when none exists, and dispatch to the
 * runtime entry (src/runtime-config.ts owns the file contract).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { PBossCLI } from "./index.ts";
import { ensureDirs } from "./utils.ts";
import { getRuntime } from "./runtime/index.ts";
import { stampRuntimeSelectionOnFirstRun } from "./runtime-config.ts";

await ensureDirs();

// Deno installs have no wrapper to persist the first-run selection
// (owner report, 2026-10-07: a deno global install left .runtime empty
// forever, so a leftover Node daemon's runtime silently became the
// unstated-app default). Stamp deno when nothing is selected — BEFORE
// cli.run so every command, including `pboss runtime` itself, sees it.
// Bun/Node package installs reach this file only through the wrapper,
// which has already persisted by dispatch time; a compiled binary cannot
// change runtime — deno is the only wrapper-less flavor that can drift.
if (getRuntime().name === "deno") {
  await stampRuntimeSelectionOnFirstRun("deno");
}

const cli = new PBossCLI();
await cli.run(process.argv.slice(2));

// Deno pins its event loop on every spawned child — there is no unref
// (owner report 2026-10-07: `pboss upgrade` completed, then hung forever on
// the daemon its post-upgrade check had spawned; the finished CLI never
// returned to the shell). The command's work is done here, so exit
// explicitly. Bun/Node release their unref'd/detached children and drain
// naturally — exit ONLY where the runtime cannot.
if (getRuntime().name === "deno") process.exit(0);
