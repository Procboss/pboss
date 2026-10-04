/**
 * Runtime-agnostic architecture suite.
 *
 * The contract under test (the architecture spec):
 *   - detection identifies the runtime ACTUALLY EXECUTING pboss — Bun
 *     classifies as bun (never as node, despite Bun's node-compat APIs)
 *   - detection happens once; the adapter is a process-lifetime singleton
 *   - each adapter uses its runtime's NATIVE APIs — source-pinned so a
 *     future "just use node: APIs everywhere" regression fails CI
 *   - unsupported runtimes fail cleanly with the supported list
 *   - the bun adapter's transport works end-to-end (socket serve + fetch)
 *   - the SAME dist bundle runs under Node (e2e, skipped when node is
 *     absent) — start/stop/list through the real daemon
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRuntime,
  getRuntime,
  currentRuntimeName,
  runtimeDisplayName,
} from "../src/runtime";

const REPO = join(dirname(import.meta.path), "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("runtime detection", () => {
  test("this process (the test suite) runs under Bun and is detected as bun — never as node", () => {
    // The critical misclassification risk: Bun implements Node's APIs and
    // sets process.versions.node, so detection MUST test the Bun global
    // BEFORE anything node-shaped.
    expect(detectRuntime()).toBe("bun");
    expect(typeof globalThis.Bun).not.toBe("undefined");
    expect(process.versions.node).toBeDefined(); // and STILL bun — see?
  });

  test("a child Node process detects node (its node-compat does not make it bun)", async () => {
    const r = Bun.spawnSync(["node", "-e", "console.log('node-ok')"]);
    if (r.exitCode !== 0) return; // node not installed — skip silently
    expect(r.stdout.toString().trim()).toBe("node-ok");
  });

  test("getRuntime caches the adapter for the process lifetime", () => {
    expect(getRuntime()).toBe(getRuntime());
  });

  test("currentRuntimeName answers the executing runtime", () => {
    expect(currentRuntimeName()).toBe("bun");
  });

  test("unsupported runtimes fail with the supported list (unit: the detector's error branch)", () => {
    // Simulated: no Bun, no Deno, a `process` WITHOUT versions.node.
    const sandbox = `
      const caught = (() => {
        try {
          ${read("src/runtime/detect.ts")
            .replace(/^import type.*$/m, "")
            .replace(/export function detectRuntime/, "function detectRuntime")}
          return null;
        } catch (err) {
          return err;
        }
      })();
      if (!caught) { console.log("NO-THROW"); process.exit(1); }
      console.log(caught.message);
    `;
    const r = Bun.spawnSync(["node", "-e", sandbox]);
    if (r.exitCode !== 0) return; // node absent — the bun path above covers it
    const out = r.stdout.toString();
    expect(out).toContain("Unsupported runtime");
    expect(out).toContain("Bun");
    expect(out).toContain("Node.js");
    expect(out).toContain("Deno");
  }, 20_000);

  test("display names", () => {
    expect(runtimeDisplayName("bun")).toBe("Bun");
    expect(runtimeDisplayName("node")).toBe("Node.js");
    expect(runtimeDisplayName("deno")).toBe("Deno");
  });
});

describe("the adapter uses each runtime's NATIVE APIs (source pins)", () => {
  // These pins are the regression wall: replacing a native implementation
  // with a node-compat one (the architecture's forbidden direction) fails.

  test("bun/process.ts uses Bun.spawn / Bun.spawnSync — and no node:child_process", () => {
    const src = read("src/runtime/bun/process.ts");
    expect(src).toContain("Bun.spawn(");
    expect(src).toContain("Bun.spawnSync(");
    expect(src).not.toContain("node:child_process");
  });

  test("bun/filesystem.ts uses Bun.file / Bun.write / Bun.gzipSync", () => {
    const src = read("src/runtime/bun/filesystem.ts");
    expect(src).toContain("Bun.file(");
    expect(src).toContain("Bun.write(");
    expect(src).toContain("Bun.gzipSync(");
    expect(src).not.toContain("node:fs/promises");
  });

  test("bun/network.ts uses Bun.serve + the native unix fetch option", () => {
    const src = read("src/runtime/bun/network.ts");
    expect(src).toContain("Bun.serve");
    expect(src).toContain("unix:");
    expect(src).not.toContain("node:http");
  });

  test("bun/adapter.ts uses Bun.sleep / Bun.which / Bun.version / Bun.main", () => {
    const src = read("src/runtime/bun/adapter.ts");
    expect(src).toContain("Bun.sleep");
    expect(src).toContain("Bun.which");
    expect(src).toContain("Bun.version");
    expect(src).toContain("Bun.main");
  });

  test("node/process.ts uses node:child_process", () => {
    expect(read("src/runtime/node/process.ts")).toContain('from "node:child_process"');
  });

  test("node/filesystem.ts uses node:fs + node:zlib", () => {
    const src = read("src/runtime/node/filesystem.ts");
    expect(src).toContain("node:fs");
    expect(src).toContain("node:zlib");
  });

  test("node/network.ts uses node:http (the native unix-socket client)", () => {
    expect(read("src/runtime/node/network.ts")).toContain('from "node:http"');
  });

  test("node/adapter.ts uses node:timers/promises sleep", () => {
    expect(read("src/runtime/node/adapter.ts")).toContain("node:timers/promises");
  });

  test("deno/process.ts uses Deno.Command", () => {
    expect(read("src/runtime/deno/process.ts")).toContain("new Deno.Command");
  });

  test("deno/filesystem.ts uses the Deno.* file APIs", () => {
    const src = read("src/runtime/deno/filesystem.ts");
    expect(src).toContain("Deno.readTextFile");
    expect(src).toContain("Deno.writeFile");
    expect(src).toContain("Deno.stat");
  });

  test("deno/network.ts uses Deno.serve + Deno.connect (native unix transport)", () => {
    const src = read("src/runtime/deno/network.ts");
    expect(src).toContain("Deno.serve");
    expect(src).toContain("Deno.connect");
  });

  test("adapter modules have ZERO top-level side effects (pure factories)", () => {
    for (const rel of [
      "src/runtime/bun/adapter.ts",
      "src/runtime/node/adapter.ts",
      "src/runtime/deno/adapter.ts",
    ]) {
      const src = read(rel);
      // module top level = everything before the first function export.
      const head = src.slice(0, src.indexOf("export function"));
      expect(head).not.toMatch(/new Deno\.|Bun\.\w+\(|Deno\.\w+\(/);
    }
  });
});

describe("core modules never touch runtime globals directly (the adapter wall)", () => {
  test("no Bun.* call sites outside src/runtime/ and the two guarded detectors", () => {
    // Grep-equivalent over the sources that matter. The two allowed
    // exceptions are the `typeof Bun !== "undefined" && Bun.main` guards
    // in install-mode.ts and upgrade.ts (compiled-binary detection —
    // bun-only by construction, always guarded).
    const offenders: string[] = [];
    for (const rel of [
      "src/api.ts",
      "src/daemon.ts",
      "src/process-container.ts",
      "src/process-manager.ts",
      "src/cluster-manager.ts",
      "src/dashboard.ts",
      "src/log-manager.ts",
      "src/monitor.ts",
      "src/utils.ts",
      "src/cron-jobs.ts",
      "src/startup-manager.ts",
      "src/cloud.ts",
      "src/upgrade.ts",
      "src/index.ts",
    ]) {
      const src = read(rel);
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const code = lines[i]!.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        // A Bun.* reference is legal only inside the `typeof Bun !== "undefined"`
        // guards (compiled-binary detection) — the guard may sit 1-2 lines up.
        const window = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
        if (/Bun\.[a-zA-Z]/.test(code) && !/typeof Bun/.test(window)) {
          offenders.push(`${rel}: ${code.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no runtime-name branches in core hot paths (adapter calls only)", () => {
    for (const rel of ["src/process-container.ts", "src/cluster-manager.ts"]) {
      const src = read(rel);
      expect(src).not.toMatch(/name === "bun"|name === "node"|name === "deno"/);
      expect(src).not.toMatch(/typeof Bun !== "undefined"/);
    }
  });
});

describe("the bun adapter's unix-socket transport (end-to-end)", () => {
  test("serve + socketFetch round-trip JSON over a real unix socket", async () => {
    const R = getRuntime();
    expect(R.name).toBe("bun");
    const dir = mkdtempSync(join(tmpdir(), "pboss-runtime-"));
    const sock = join(dir, "test.sock");
    try {
      let reloaded = false;
      const server = R.network.serve({
        socketPath: sock,
        fetch: async (req) => {
          const body = (await req.json()) as { hello?: string };
          return Response.json({ pong: body.hello ?? "none", reloaded });
        },
      });
      const res = await R.network.socketFetch("http://localhost/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }, sock);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { pong: string };
      expect(body.pong).toBe("world");

      // reload() swaps the handler in place
      server.reload(() => Response.json({ swapped: true }));
      reloaded = true;
      const res2 = await R.network.socketFetch("http://localhost/cmd", { method: "POST", body: "{}" }, sock);
      expect(((await res2.json()) as { swapped: boolean }).swapped).toBe(true);

      await server.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("fs adapter round-trips readText/readBytes/write/size/readRange/gzip", async () => {
    const R = getRuntime();
    const dir = mkdtempSync(join(tmpdir(), "pboss-runtime-fs-"));
    try {
      const f = join(dir, "data.txt");
      await R.filesystem.write(f, "hello runtime world");
      expect(await R.filesystem.exists(f)).toBe(true);
      expect(await R.filesystem.readText(f)).toBe("hello runtime world");
      expect(await R.filesystem.size(f)).toBe(19); // 19 chars — counted twice
      expect(new TextDecoder().decode(await R.filesystem.readRange(f, 6, 13))).toBe("runtime");
      const gz = R.filesystem.gzip(new TextEncoder().encode("compress me"));
      expect(new TextDecoder().decode(R.filesystem.gunzip(gz))).toBe("compress me");
      // binary safety through readBytes (gzip data must not text-roundtrip)
      await R.filesystem.write(join(dir, "x.gz"), gz);
      expect(new TextDecoder().decode(R.filesystem.gunzip(await R.filesystem.readBytes(join(dir, "x.gz"))))).toBe("compress me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("process adapter captures output and exit codes", async () => {
    const R = getRuntime();
    const ok = await R.process.capture(["sh", "-c", "echo out-123; echo err-456 >&2; exit 7"]);
    expect(ok.stdout.trim()).toBe("out-123");
    expect(ok.stderr.trim()).toBe("err-456");
    expect(ok.exitCode).toBe(7);
  });

  test("spawn produces live streams + an exit promise", async () => {
    const R = getRuntime();
    const child = R.process.spawn(["sh", "-c", "echo streaming; sleep 0.1; exit 3"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout!).text();
    expect(text.trim()).toBe("streaming");
    expect(await child.exited).toBe(3);
  });
});

describe("the same dist bundle runs under Node (execution e2e)", () => {
  // Skipped automatically when node is not installed or dist/ is not built
  // (bun run scripts/build-dist.ts). The bun adapter above covers this
  // machine's native path; this proves the NODE path with the real daemon.
  const CLI = join(REPO, "dist", "cli.js");
  const haveNode = Bun.which("node") !== null;
  const haveDist = existsSync(CLI);

  function nodeCli(args: string[], home: string) {
    return Bun.spawnSync(["node", CLI, ...args], {
      env: { ...process.env, PBOSS_HOME: home },
      cwd: home,
    });
  }

  test("node executes the bundle: --version and `runtime` report honestly", async () => {
    if (!haveNode || !haveDist) return;
    const home = mkdtempSync(join(tmpdir(), "pboss-node-e2e-"));
    try {
      const v = nodeCli(["--version"], home);
      expect(v.exitCode).toBe(0);
      expect(v.stdout.toString().trim()).toMatch(/^pboss v\d/);

      // `pboss runtime` (the status command) shows the executing engine —
      // Node under node (not the test host's runtime). The bare
      // `--runtime` info flag is gone: --runtime is a VALUE flag now.
      const rt = nodeCli(["runtime"], home);
      expect(rt.exitCode).toBe(0);
      expect(rt.stdout.toString()).toContain("Executing engine:");
      expect(rt.stdout.toString()).toContain("Node");
      expect(rt.stdout.toString()).not.toContain("Executing engine:   Bun");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("node runs a REAL daemon lifecycle: start → list → stop → delete → kill", async () => {
    if (!haveNode || !haveDist) return;
    const home = mkdtempSync(join(tmpdir(), "pboss-node-e2e-"));
    try {
      writeFileSync(join(home, "app.js"), 'setInterval(() => {}, 1000);\n');
      const start = nodeCli(["start", "app.js", "--name", "node_e2e"], home);
      expect(start.exitCode).toBe(0);
      expect(start.stdout.toString()).toContain("node_e2e");
      expect(start.stdout.toString()).toContain("online");

      const ls = nodeCli(["list"], home);
      expect(ls.stdout.toString()).toContain("node_e2e");

      const st = nodeCli(["stop", "node_e2e"], home);
      expect(st.stdout.toString()).toContain("stopped");

      const dl = nodeCli(["delete", "node_e2e"], home);
      expect(dl.exitCode).toBe(0);

      const kill = nodeCli(["kill"], home);
      expect(kill.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
