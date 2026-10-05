/**
 * The Deno runtime's REAL adapter behavior — the layer the wrapper-farm and
 * entry tests never touched before 1.6.1, where three bugs sat:
 *
 *   BUG 1 (serve):  Deno.serve({ unix: path }) is not Deno's API — the
 *                  option is `path`. The bogus `unix` key was ignored and
 *                  Deno bound its TCP DEFAULT (0.0.0.0:8000): the daemon
 *                  looked alive but nothing listened on the socket.
 *   BUG 2 (client): socketFetch's buildResponse DROPPED the body bytes
 *                  that arrived with the response head (bodyFirst) in the
 *                  non-chunked path — the daemon's small JSON replies
 *                  arrive entirely in the first read, so res.json() saw an
 *                  empty body and every probe reported "stopped".
 *   BUG 3 (spawn): file-sink stdio was piped+pumped by the PARENT — a
 *                  detached child (the daemon) lost its stdout the moment
 *                  the CLI exited (SIGPIPE) and died silently. Real fds
 *                  (node:fs openSync) redirect at the kernel level now.
 *
 * These tests run the REAL source adapters under the REAL deno on PATH —
 * they skip visibly on deno-less machines (the false-green lesson from
 * the 1.6.0 wrapper-farm incident; see tests/wrapper.test.ts).
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER_URL = pathToFileURL(join(REPO, "src/runtime/deno/network.ts")).href;
const PROCESS_URL = pathToFileURL(join(REPO, "src/runtime/deno/process.ts")).href;
const DIST_ENTRY = join(REPO, "dist", "cli.deno.js");
const DIST_BUILT = existsSync(DIST_ENTRY);

const denoBin = Bun.which("deno");
const canDeno = !!denoBin;

/** Run a deno script file; capture stdout+exit. */
function denoRun(
  script: string,
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "pboss-deno-rt-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, script);
  try {
    // --sloppy-imports: the source tree's TypeScript-style extension-less
    // imports resolve under deno (deno's own suggestion for TS sources).
    const proc = Bun.spawnSync([denoBin!, "run", "-A", "--sloppy-imports", file], {
      env: { ...process.env, ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: opts.timeoutMs ?? 60_000,
    });
    return {
      code: proc.exitCode ?? -1,
      out: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deno runtime adapter — real deno", () => {
  test.skipIf(!canDeno)("serve({path}) binds the unix socket AND socketFetch parses the reply (bugs 1+2)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-deno-serve-"));
    const sock = join(home, "probe.sock");
    try {
      const script = `
import { createDenoNetwork } from ${JSON.stringify(ADAPTER_URL)};
const R = createDenoNetwork();
const sock = ${JSON.stringify(sock)};
const handle = R.serve({
  socketPath: sock,
  fetch: () => new Response(JSON.stringify({ pong: true, pid: 4242 }), {
    headers: { "content-type": "application/json" },
  }),
});
await new Promise((r) => setTimeout(r, 300));
const res = await R.socketFetch(
  "http://localhost/",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "ping" }) },
  sock,
);
const body = await res.json(); // BUG 2: empty body pre-fix → parse throws
console.log("STATUS=" + res.status);
console.log("BODY=" + JSON.stringify(body));
await handle.stop();
`;
      const r = denoRun(script);
      expect(r.code).toBe(0);
      expect(r.out).toContain("STATUS=200");
      // Pre-fix 1: the socket never existed (TCP 8000 got bound instead) —
      // socketFetch died on connect ENOENT. Pre-fix 2: the status line
      // parsed but res.json() threw on the empty stream.
      expect(r.out).toContain('BODY={"pong":true');
      expect(existsSync(sock) || r.out.includes("BODY=")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test.skipIf(!canDeno)("a chunked/streaming body still streams through socketFetch", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-deno-chunk-"));
    const sock = join(home, "probe.sock");
    try {
      const script = `
import { createDenoNetwork } from ${JSON.stringify(ADAPTER_URL)};
const R = createDenoNetwork();
const sock = ${JSON.stringify(sock)};
const handle = R.serve({
  socketPath: sock,
  fetch: () => new Response(
    new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("part-one,")); c.enqueue(new TextEncoder().encode("part-two")); c.close(); },
    }),
    { headers: { "content-type": "text/plain" } },
  ),
});
await new Promise((r) => setTimeout(r, 300));
const res = await R.socketFetch("http://localhost/", { method: "GET" }, sock);
const text = await res.text();
console.log("BODY=" + text);
await handle.stop();
`;
      const r = denoRun(script);
      expect(r.code).toBe(0);
      expect(r.out).toContain("BODY=part-one,part-two");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test.skipIf(!canDeno)("detached spawn with file sinks: the child outlives the parent (bug 3)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pboss-deno-spawn-"));
    const sink = join(home, "child.log");
    try {
      // The parent spawns a detached deno child whose stdout/stderr are
      // file sinks, then exits immediately. The child writes AFTER the
      // parent is gone — with the old piped+pump stdio that write hit a
      // broken pipe and the child died silently; with real fds it lands.
      const script = `
import { createDenoProcess } from ${JSON.stringify(PROCESS_URL)};
import { createDenoFilesystem } from ${JSON.stringify(pathToFileURL(join(REPO, "src/runtime/deno/filesystem.ts")).href)};
const P = createDenoProcess();
const F = createDenoFilesystem();
const child = P.spawn([Deno.execPath(), "run", "-A", "--sloppy-imports", ${JSON.stringify(join(home, "child.ts"))}], {
  stdout: F.sink(${JSON.stringify(sink)}),
  stderr: F.sink(${JSON.stringify(sink)}),
  stdin: "ignore",
  detached: true,
});
child.unref();
Deno.exit(0);
`;
      writeFileSync(
        join(home, "child.ts"),
        `
await new Promise((r) => setTimeout(r, 1500)); // let the parent die first
console.log("child-wrote-after-parent-exit");
`,
      );
      const r = denoRun(script, { timeoutMs: 20_000 });
      expect(r.code).toBe(0);
      // Wait for the child's post-parent write.
      await new Promise((r2) => setTimeout(r2, 2500));
      const logged = existsSync(sink) ? readFileSync(sink, "utf8") : "";
      expect(logged).toContain("child-wrote-after-parent-exit");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!canDeno || !DIST_BUILT)(
    "THE DAEMON E2E under deno: starts, answers, SURVIVES the CLI, and stops (all three bugs at once — the owner's scenario)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-deno-daemon-"));
      mkdirSync(join(home, ".pboss"), { recursive: true });
      try {
        const run = (args: string[], timeoutMs = 60_000) =>
          Bun.spawnSync([denoBin!, "run", "-A", DIST_ENTRY, ...args], {
            env: { ...process.env, HOME: home, PBOSS_HOME: join(home, ".pboss") },
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
            timeout: timeoutMs,
          });

        const start = run(["daemon", "start"]);
        const startOut = new TextDecoder().decode(start.stdout) + new TextDecoder().decode(start.stderr);
        expect(start.exitCode).toBe(0);
        expect(startOut).not.toContain("Timed out waiting for pboss daemon");

        // The daemon must still be answering after the CLI process exited
        // (bug 3) — give it a beat, then probe.
        await new Promise((r) => setTimeout(r, 1500));
        const status = run(["daemon", "status"]);
        const statusOut = new TextDecoder().decode(status.stdout) + new TextDecoder().decode(status.stderr);
        expect(statusOut).toContain("running");

        // The launch log must carry the daemon's own stdout line (the fd
        // sinks — pre-fix the log files stayed empty).
        const daemonLog = readFileSync(join(home, ".pboss", "daemon.out.log"), "utf8");
        expect(daemonLog).toContain("Daemon listening on");

        const stop = run(["daemon", "stop"]);
        expect(stop.exitCode === 0 || stop.exitCode === null).toBe(true);
      } finally {
        // Belt on top: never leak a daemon from a failed assertion.
        Bun.spawnSync([denoBin!, "run", "-A", DIST_ENTRY, "daemon", "stop"], {
          env: { ...process.env, HOME: home, PBOSS_HOME: join(home, ".pboss") },
          stdout: "ignore", stderr: "ignore", stdin: "ignore",
        });
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test.skipIf(!canDeno || !DIST_BUILT)(
    "`pboss upgrade --check` completes under deno (the import.meta.dir crash — bug 5)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "pboss-deno-upg-"));
      mkdirSync(join(home, ".pboss"), { recursive: true });
      writeFileSync(join(home, ".pboss", ".runtime"), "deno\n");
      try {
        const proc = Bun.spawnSync([denoBin!, "run", "-A", DIST_ENTRY, "upgrade", "--check"], {
          env: { ...process.env, HOME: home, PBOSS_HOME: join(home, ".pboss"), TERM: "dumb" },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          timeout: 60_000,
        });
        const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
        // Bug 5: currentChannelContext used `import.meta.dir` — a BUN-ONLY
        // extension, undefined under Deno/Node → the channel probe crashed
        // with "The 'path' argument must be of type string. Received
        // undefined" before any upgrade logic ran.
        expect(out).not.toContain("must be of type string");
        expect(out).not.toContain("parentHasGit");
        // It got far enough to print the upgrade header (registry answers
        // or the hold note — either is a completed channel resolution).
        expect(out).toContain("pboss upgrade");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
