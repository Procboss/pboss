/**
 * ProcBoss (pboss) — dist build entry.
 *
 * The compiled bundle's entry (dist/cli.js): runs the CLI unconditionally.
 * index.ts's import.meta.main guard covers `bun run src/index.ts` dev use;
 * under the bundled file (Node/Deno execute it without import.meta.main),
 * this explicit entry is what actually boots the CLI.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { PBossCLI } from "./index";
import { ensureDirs } from "./utils";

await ensureDirs();
const cli = new PBossCLI();
await cli.run(process.argv.slice(2));
