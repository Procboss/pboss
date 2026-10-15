#!/usr/bin/env node
/**
 * ProcBoss (pboss) — the Node.js CLI entry.
 *
 * The Node.js source entry — `node src/cli-node.ts` from a git checkout
 * (JSR no longer exports it, owner trim 2026-10-15; npm users get the
 * compiled dist/cli.node.js instead). It keeps the per-runtime parity:
 * every runtime's entry opens with a shebang naming IT exactly (`.` on
 * JSR is the deno entry, src/index.ts carries the bun shebang) — and all
 * three boot the SAME CLI in src/index.ts.
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
