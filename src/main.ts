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

import { PBossCLI } from "./index";
import { ensureDirs } from "./utils";

await ensureDirs();
const cli = new PBossCLI();
await cli.run(process.argv.slice(2));
