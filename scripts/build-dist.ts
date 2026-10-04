/**
 * ProcBoss (pboss) — build the runtime-agnostic dist bundle.
 *
 * Produces the files the PUBLISHED package ships so the same CLI runs under
 * Bun, Node and Deno:
 *
 *   dist/cli.js          — the CLI entry (node shebang; ESM). Any runtime
 *                          executes it; the runtime adapter layer picks the
 *                          native APIs of whichever runtime is running it.
 *   dist/api.mjs         — the library entry (import { PBoss } from "pboss").
 *   dist/postinstall.js  — the npm postinstall hook (plain JS; runs under
 *                          whichever package manager executes it).
 *
 * The bundle contains all three adapters; each adapter module has zero
 * top-level side effects, so loading the file never touches another
 * runtime's globals — only the executing runtime's implementation runs.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

mkdirSync(join(ROOT, "dist"), { recursive: true });

const NODE_SHEBANG = "#!/usr/bin/env node\n";

/*
 * One bundle, three runtimes — and Deno is strict about builtins.
 *
 * Node and Bun accept BOTH `from "events"` and `from "node:events"` in ESM;
 * Deno accepts ONLY the prefixed form (bare specifiers are "not a
 * dependency" — a hard error). Our sources and the bundled CJS deps
 * (through __require) both end up with bare forms, so every emitted bundle
 * is rewritten to the always-valid `node:` form before it ships. This is
 * what makes dist/cli.js run under bun, node AND `deno run -A` unchanged.
 */
const NODE_BUILTINS = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
  "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "path/posix",
  "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline",
  "readline/promises", "repl", "stream", "stream/consumers", "stream/promises",
  "stream/web", "string_decoder", "sys", "timers", "timers/promises", "tls",
  "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

/** Rewrite bare builtin specifiers in static import/export statements to
 *  `node:`-prefixed. Bun's bundler emits single-line import statements, so a
 *  line-anchored scan is exact — and idempotent (already-prefixed specifiers
 *  like `node:module` contain a colon and cannot match a bare name). */
function prefixNodeBuiltins(body: string): string {
  return body.replace(
    /^(\s*(?:import|export)\b[^;\n]*?\bfrom\s*|\s*import\s+)(["'])([^"'\s;]+)\2/gm,
    (match, prefix: string, quote: string, spec: string) =>
      NODE_BUILTINS.has(spec) ? `${prefix}${quote}node:${spec}${quote}` : match,
  );
}

/** The guard: after the rewrite, no static import may name a bare builtin —
 *  a miss here means the emitter's shape changed and the rewrite above (or
 *  the regex) must be updated, never shipped broken for Deno. */
function assertNoBareBuiltins(rel: string, body: string) {
  const offenders = body.match(
    /^(\s*(?:import|export)\b[^;\n]*?\bfrom\s*|\s*import\s+)(["'])(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(\2)/gm,
  );
  if (offenders) {
    console.error(`✗ ${rel}: bare Node builtin imports remain after the rewrite:`);
    for (const line of offenders.slice(0, 5)) console.error(`    ${line.trim()}`);
    process.exit(1);
  }
}

/** Run a command at the repo root, inheriting stdio. */
function run(cmd: string[]) {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✗ build step failed: ${cmd.join(" ")}`);
    process.exit(1);
  }
}

/** Prepend a shebang to an output file and mark it executable. */
function addShebang(rel: string) {
  const abs = join(ROOT, rel);
  const body = readFileSync(abs, "utf8");
  if (!body.startsWith("#!")) {
    writeFileSync(abs, NODE_SHEBANG + body);
  }
  chmodSync(abs, 0o755);
}

/** Apply the bare-builtin rewrite to a built file, then prove it took. */
function rewrite(rel: string) {
  const abs = join(ROOT, rel);
  const body = readFileSync(abs, "utf8");
  writeFileSync(abs, prefixNodeBuiltins(body));
  assertNoBareBuiltins(rel, readFileSync(abs, "utf8"));
}

// 1. The CLI — target node so node: builtins resolve; Bun.* / Deno.* stay
//    as globals the adapter branches reach only under their own runtime.
//    The bare-builtin rewrite below is what lets the SAME file run under
//    `deno run -A` (Deno refuses `from "events"` — node: only).
console.log("Building dist/cli.js …");
run(["bun", "build", "--target=node", "--format=esm", `--outfile=${join(ROOT, "dist/cli.js")}`, "./src/main.ts"]);
rewrite("dist/cli.js");
addShebang("dist/cli.js");

// 2. The library entry — same treatment, .mjs for unambiguous ESM.
console.log("Building dist/api.mjs …");
run(["bun", "build", "--target=node", "--format=esm", `--outfile=${join(ROOT, "dist/api.mjs")}`, "./src/api.ts"]);
rewrite("dist/api.mjs");

// 3. The postinstall hook — built from the source that guards on
//    import.meta.main; the built file IS the entry, so run it unconditionally
//    via a tiny wrapper.
console.log("Building dist/postinstall.js …");
const wrapper = join(ROOT, "scripts", ".postinstall-entry.ts");
writeFileSync(
  wrapper,
  [
    '// generated by build-dist.ts — the postinstall bundle is an entry,',
    '// so it runs unconditionally (the source file keeps its dev-mode guard).',
    'import { runPostinstall } from "../src/postinstall";',
    'await runPostinstall();',
    "",
  ].join("\n")
);
try {
  run(["bun", "build", "--target=node", "--format=esm", wrapper, `--outfile=${join(ROOT, "dist/postinstall.js")}`]);
} finally {
  rmSync(wrapper, { force: true });
}
rewrite("dist/postinstall.js");
addShebang("dist/postinstall.js");

// Sanity: the outputs exist and are non-empty, the per-runtime entries
// dispatch to the shared core, and the bin wrappers are executable with
// the right shebangs (the wrapper architecture's contract).
for (const f of ["dist/cli.js", "dist/api.mjs", "dist/postinstall.js"]) {
  const abs = join(ROOT, f);
  if (!existsSync(abs) || readFileSync(abs, "utf8").length < 1000) {
    console.error(`✗ ${f} missing or suspiciously small`);
    process.exit(1);
  }
  console.log(`✓ ${f}`);
}

// 4. The per-runtime entrypoints (the wrapper architecture, spec §9):
//    bin/pboss.sh dispatches node→cli.node.js, bun→cli.bun.js,
//    deno→cli.deno.js after reading ~/.pboss/.runtime. Each entry is a
//    thin bootstrap that runs the SAME shared core (dist/cli.js) — the
//    runtime-specific lives in the entry file, the CLI never duplicates.
//    (Deno's own installs reach cli.deno.js through the published
//    `npm:pboss/deno-entry` export — see package.json.)
const RUNTIME_ENTRIES: [file: string, runtime: string, shebang: string | null][] = [
  ["dist/cli.node.js", "node", "#!/usr/bin/env node"],
  ["dist/cli.bun.js", "bun", "#!/usr/bin/env bun"],
  // deno needs its permission flags — no shebang can carry them; the file
  // is always launched via `deno run -A` (wrapper) or npm:pboss/deno-entry.
  ["dist/cli.deno.js", "deno", null],
];
for (const [file, runtime, shebang] of RUNTIME_ENTRIES) {
  const abs = join(ROOT, file);
  const body = [
    ...(shebang ? [shebang] : []),
    `// ProcBoss (pboss) — the ${runtime} entrypoint (generated by build-dist.ts).`,
    `// bin/pboss.sh dispatches here after resolving ~/.pboss/.runtime.`,
    `// Shared core: ./cli.js (runtime adapters pick the native APIs).`,
    `await import("./cli.js");`,
    "",
  ].join("\n");
  writeFileSync(abs, body, "utf8");
  chmodSync(abs, 0o755);
  console.log(`✓ ${file}`);
}

// The bin wrappers must exist, be executable, and open with their shebang.
for (const [wrapper, shebang] of [
  ["bin/pboss.sh", "#!/bin/sh"],
  ["bin/pboss.ps1", "#!/usr/bin/env pwsh"],
] as const) {
  const abs = join(ROOT, wrapper);
  if (!existsSync(abs) || !readFileSync(abs, "utf8").startsWith(shebang)) {
    console.error(`✗ ${wrapper} missing or missing its shebang (${shebang})`);
    process.exit(1);
  }
  chmodSync(abs, 0o755);
  console.log(`✓ ${wrapper}`);
}
console.log("dist build complete — runs under Bun, Node and Deno.");
