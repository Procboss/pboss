/**
 * The [y/N] prompt under EOF (owner report, 2026-10-06): Ctrl+D at
 * `pboss upgrade`'s confirm crashed a deno-installed pboss with
 * "Top-level await promise never resolved", aimed at the entry's
 * `await import("./cli.js")`. Root cause: readline's 'close' event fires
 * with NO answer (Ctrl+D, a closing terminal, a detached pty), the old
 * confirm() never settled its question promise, and a top-level await
 * left dangling over an emptied event loop is a hard failure on every
 * runtime we ship — deno prints that error, node/bun exit 13. The fix
 * settles with the SAFE answer ("no") and says so dimly once.
 *
 * Layers pinned here:
 *   1. STATIC — the close handler, the settle-once guard, and the
 *      caller-aware non-TTY bypass hint (upgrade says --yes/-y, delete
 *      keeps --force; the old message told upgraders about a flag their
 *      command did not have).
 *   2. E2E through a REAL pty (`script`) — the bug needs isTTY=true
 *      followed by EOT, so pipes can exercise it (they take the non-TTY
 *      refuse path instead). Linux + /usr/bin/script gated; the deno
 *      variant was live-verified on 2.9.7 (see the worklog) and needs
 *      the built dist, so it stays manual.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "src", "index.ts");
/** The pty harness: linux with util-linux's script (CI + dev boxes). */
const canPty = process.platform === "linux" && existsSync("/usr/bin/script");

/** Hermetic home; each e2e case gets its own daemon + dump. */
async function freshHome(prefix: string): Promise<string> {
  return mkdtempSync(join(tmpdir(), `pboss-confirm-${prefix}-`));
}

/** Run the real CLI with PBOSS_HOME isolated (daemon commands). */
async function runCli(args: string[], home: string) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, PBOSS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: home,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { out, err, code: code ?? 0 };
}

/**
 * Run a command under a REAL pty whose stdin immediately delivers the
 * given bytes then closes — `printf '<bytes>' | script -qec "<cmd>"`.
 * \x04 through a pty is exactly the user's Ctrl+D.
 */
async function runInPty(cmd: string, input: string, timeoutMs = 30_000) {
  return new Promise<{ out: string; code: number }>((resolve, reject) => {
    const proc = Bun.spawn(["script", "-qec", cmd, "/dev/null"], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Uint8Array([...Buffer.from(input, "binary")]),
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("pty run timed out — the prompt is hanging again"));
    }, timeoutMs);
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([out, err, code]) => {
      clearTimeout(timer);
      resolve({ out: out + err, code: code ?? 0 });
    });
  });
}

/**
 * The VISIBLE text of a pty capture — ANSI escapes (cursor moves, line
 * clears, colors) and CRs stripped. Why: the harness feeds input at spawn,
 * so the bytes can beat the CLI into raw mode and readline then REPAINTS —
 * the owner's box (2026-10-06, prepublishOnly) captured `... [y/N] \x1b[53Gn`,
 * a cursorTo(end-of-prompt) between the prompt and the echoed answer, and a
 * literal "[y/N] n" match broke on it. Assert on WHAT was said, not on how
 * the terminal repainted it (stripAnsi's pty-hardened sibling).
 */
function visible(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "") // OSC (ESC ] ... BEL/ST)
    .replace(/\x1b\[[0-9;:?<=>!]*[ -/]*[@-~]/g, "") // CSI — cursorTo/clear/color
    .replace(/\x1b./g, "") // any other ESC pair
    .replace(/\r\n?/g, "\n"); // pty CRLF → LF
}

async function cleanup(home: string) {
  try {
    await runCli(["kill"], home);
  } catch {
    /* daemon never started */
  }
  try {
    const sweep = Bun.spawn(["pkill", "-f", home], { stdout: "ignore", stderr: "ignore" });
    await sweep.exited;
  } catch {
    /* pkill unavailable — best effort */
  }
  rmSync(home, { recursive: true, force: true });
}

/** Two forever-apps in the "eos" namespace — the delete-confirm setup. */
function writeNamespaceFleet(home: string) {
  const script = "setInterval(() => {}, 1000);";
  writeFileSync(join(home, "a.mjs"), script);
  writeFileSync(join(home, "b.mjs"), script);
}

// ---------------------------------------------------------------------------
// 1. Static pins — the settle contract in src/index.ts
// ---------------------------------------------------------------------------

describe("confirm() EOF — static pins", () => {
  const src = readFileSync(CLI, "utf8");

  test("the readline close event settles the prompt — no dangling promise", () => {
    expect(src).toMatch(/rl\.on\("close"/);
    expect(src).toContain("(input closed — treating as no)");
  });

  test("settle-once guard: a real answer followed by rl.close() is not EOF", () => {
    // rl.close() inside settle() re-fires 'close' AFTER an answer — without
    // the guard the dim note prints after every real answer too.
    expect(src).toMatch(/let settled = false/);
    expect(src).toMatch(/if \(settled\) return/);
  });

  test("the non-TTY refuse hint is the caller's own bypass flag", () => {
    // Old message hardcoded --force — true for delete, a LIE for upgrade.
    expect(src).toMatch(/bypass = "--force"/);
    expect(src).toContain('"--yes (-y)"'); // what cmdUpgrade passes
    expect(src).toContain("${bypass}"); // the message is parameterized
  });
});

// ---------------------------------------------------------------------------
// 2. E2E — the real CLI under a real pty
// ---------------------------------------------------------------------------

describe("confirm() EOF — e2e (real CLI, real pty)", () => {
  test.skipIf(!canPty)(
    "Ctrl+D at a namespace-delete prompt aborts cleanly — no hang, no crash",
    async () => {
      const home = await freshHome("eof");
      writeNamespaceFleet(home);
      try {
        const s1 = await runCli(
          ["start", join(home, "a.mjs"), "--name", "a", "--namespace", "eos"],
          home
        );
        const s2 = await runCli(
          ["start", join(home, "b.mjs"), "--name", "b", "--namespace", "eos"],
          home
        );
        expect(s1.out).toContain("online");
        expect(s2.out).toContain("online");

        // The user's exact gesture: Ctrl+D (\x04 through a pty) at [y/N].
        const res = await runInPty(
          `env PBOSS_HOME=${home} bun run ${CLI} delete eos`,
          "\x04"
        );
        expect(res.code).toBe(1); // aborted, not crashed (13) nor hung
        const out = visible(res.out);
        expect(out).toContain("Delete 2 processes");
        expect(out).toContain("(input closed — treating as no)");
        expect(out).toContain("Aborted — nothing was deleted");
        expect(out).not.toContain("never resolved"); // the deno TLA error

        // The fleet survives — nothing was deleted.
        const list = await runCli(["list"], home);
        expect(list.out).toContain("a");
        expect(list.out).toContain("b");
      } finally {
        await cleanup(home);
      }
    },
    120000
  );

  test.skipIf(!canPty)(
    "a real answer prints NO eof note — the close event after rl.close() stays silent",
    async () => {
      const home = await freshHome("answer");
      writeNamespaceFleet(home);
      try {
        await runCli(
          ["start", join(home, "a.mjs"), "--name", "a", "--namespace", "eos"],
          home
        );
        await runCli(
          ["start", join(home, "b.mjs"), "--name", "b", "--namespace", "eos"],
          home
        );

        const res = await runInPty(
          `env PBOSS_HOME=${home} bun run ${CLI} delete eos`,
          "n\n"
        );
        expect(res.code).toBe(1);
        // The echoed answer may be separated from the prompt by a repaint
        // escape — match the visible text (owner's box, 2026-10-06).
        const out = visible(res.out);
        expect(out).toContain("[y/N] n");
        expect(out).toContain("Aborted — nothing was deleted");
        expect(out).not.toContain("(input closed"); // the noise the guard kills
      } finally {
        await cleanup(home);
      }
    },
    120000
  );
});
