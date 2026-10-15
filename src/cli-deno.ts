#!/usr/bin/env -S deno run -A
/**
 * ProcBoss (pboss) — the Deno CLI entry.
 *
 * This is the JSR package's ROOT export (`.`): JSR is Deno's home
 * registry, so the package is CLI-first — `deno run jsr:@procboss/pboss`
 * and `deno install -g jsr:@procboss/pboss` (no subpath) boot the
 * deno-flavored CLI, and its shebang names deno, exactly. The sibling
 * entries carry their own runtimes' shebangs: `./cli/bun` is src/index.ts
 * (`#!/usr/bin/env bun`) and `./cli/node` is src/cli-node.ts
 * (`#!/usr/bin/env node`); all three boot the SAME CLI in src/index.ts.
 *
 * The shebang carries the permission grant a process manager needs —
 * `env -S` splits it into `deno run -A` (GNU coreutils >= 8.30, macOS >=
 * Catalina, FreeBSD, busybox >= 1.30). The sanctioned install paths embed
 * the flags themselves (`deno install -g -A ... jsr:@procboss/pboss`
 * writes a shim that runs `deno run -A` on the cached entry), so the
 * shebang is the direct-execution path — and the honest declaration of
 * which runtime this file belongs to.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { main } from "./index.ts";

await main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
