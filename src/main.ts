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
 * `--runtime=<x>` is handled BEFORE the CLI runs: it initializes the
 * persistent selection (~/.pboss/.runtime) when none exists, prints the
 * one-invocation override notice otherwise, and re-execs the matching
 * runtime entry when the current engine differs (src/runtime-config.ts).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { PBossCLI } from "./index";
import { ensureDirs } from "./utils";
import { handleRuntimeFlag } from "./runtime-config";

await ensureDirs();
const argv = await handleRuntimeFlag(process.argv.slice(2));
const cli = new PBossCLI();
await cli.run(argv);
