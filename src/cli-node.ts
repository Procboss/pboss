#!/usr/bin/env node
/**
 * ProcBoss (pboss) — the Node.js CLI entry.
 *
 * This is the JSR package's `./cli/node` export. It exists for parity with
 * the per-runtime story — every runtime gets an entry whose shebang names
 * IT exactly (`./cli` is the deno entry, `./cli/bun` is src/index.ts with
 * the bun shebang) — and all three boot the SAME CLI in src/index.ts.
 *
 * Running TypeScript sources directly needs Node's type stripping
 * (unflagged since Node 23.6; Node 22.6+ with --experimental-strip-types).
 * Older Node — and every installed package — uses the npm route instead:
 * bin/pboss.sh dispatches to dist/cli.node.js, the compiled bundle with
 * this same shebang.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { main } from "./index.ts";

await main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
