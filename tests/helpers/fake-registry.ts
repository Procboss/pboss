/**
 * A hermetic npm-registry stand-in, run as its OWN PROCESS (owner report,
 * 2026-10-12: the suite must not depend on the machine's reach of
 * registry.npmjs.org — an unreachable network took the two deno upgrade
 * tests down while the rest of the suite was green).
 *
 * Why a process and not an in-test Bun.serve: the deno tests drive the CLI
 * with Bun.spawnSync, which BLOCKS the whole test runtime — an in-process
 * server would freeze mid-request and the CLI's version check would hang
 * until its 10 s timeout. A separate process keeps answering while the
 * test process is blocked.
 *
 * Serves the two documents pboss's version checks read:
 *   GET /pboss/latest  → { name, version: <latest> }
 *   GET /pboss         → the packument (dist-tags + a time map with the
 *                        latest published 48 h ago — OUTSIDE Deno's 24 h
 *                        supply-chain window, so it resolves for old and
 *                        new denos alike; 1.6.0 is the deno-entry floor)
 *
 * Usage: bun run tests/helpers/fake-registry.ts <latest>
 * Announces itself on stdout's FIRST line:
 *   FAKE_REGISTRY_READY http://127.0.0.1:<port>
 * …then serves until killed.
 */
import { serve } from "bun";

const latest = process.argv[2] ?? "9.9.9";
const published = new Date(Date.now() - 48 * 3_600_000).toISOString();

const server = serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/pboss/latest") {
      return Response.json({ name: "pboss", version: latest });
    }
    if (path === "/pboss") {
      return Response.json({
        "dist-tags": { latest },
        time: {
          created: published,
          modified: published,
          "1.6.0": published, // DENO_ENTRY_MIN_VERSION — the floor
          [latest]: published,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`FAKE_REGISTRY_READY http://127.0.0.1:${server.port}`);
// Keep the process alive: the server must outlive the test that started it.
setInterval(() => {}, 60_000);
