/**
 * Error-handling policy tests.
 *
 * [1] CONVENTION (the owner's explicit rule): empty `catch {}` blocks and
 *     empty `.catch(() => {})` arrows are FORBIDDEN in src/ — every
 *     suppression must go through ignore()/warn() so the failure is
 *     recorded and, when it matters, printed. This scans the source tree
 *     and fails on any regression (comment lines are excluded).
 *
 * [2] Behavior: ignore() never throws and records to the ring silently;
 *     warn() prints one stderr line and records; PBOSS_DEBUG=1 makes
 *     ignore() loud; DaemonConflictError carries the PID for the message.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ignore,
  warn,
  recentSuppressed,
  DaemonConflictError,
  EXIT_DAEMON_CONFLICT,
} from "../src/error-handling";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/** Recursively collect .ts files under src/, skipping type declarations. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Lines that are not comments/doc-comments. */
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

describe("error-handling convention (no silent suppression in src/)", () => {
  test("zero empty catch blocks across src/", () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      // error-handling.ts documents the forbidden pattern in comments —
      // codeLines() strips those; scan its actual code like any file.
      const lines = codeLines(readFileSync(file, "utf8"));
      for (const line of lines) {
        // `catch {}` / `catch (e) {}` with a whitespace-only body
        if (/catch\s*(\([^)]*\))?\s*\{\s*\}\s*;?\s*$/.test(line) ||
            /}\s*catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
          offenders.push(`${file.replace(srcDir + "/", "")}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("zero empty arrow-function catches across src/", () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      const lines = codeLines(readFileSync(file, "utf8"));
      for (const line of lines) {
        // `.catch(() => {})` / `.catch(() => undefined)` / `.catch(() => "")`
        if (/\.catch\(\s*\(\s*\)?\s*=>\s*(\{\s*\}|undefined|null|""|'')\s*\)/.test(line)) {
          offenders.push(`${file.replace(srcDir + "/", "")}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("ignore() / warn() behavior", () => {
  const realDebug = process.env.PBOSS_DEBUG;
  afterEach(() => {
    if (realDebug === undefined) delete process.env.PBOSS_DEBUG;
    else process.env.PBOSS_DEBUG = realDebug;
  });

  test("ignore() records to the ring and is silent by default", () => {
    const before = recentSuppressed().length;
    const errSpy = spyOn(console, "error").mockReturnValue(undefined as void);
    try {
      ignore("unit-test context", new Error("boom"));
      expect(recentSuppressed().length).toBe(before + 1);
      const last = recentSuppressed().at(-1)!;
      expect(last.context).toBe("unit-test context");
      expect(last.message).toBe("boom");
      expect(last.level).toBe("ignored");
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("ignore() tolerates non-Error throws and missing errors", () => {
    const before = recentSuppressed().length;
    expect(() => ignore("string throw", "just a string")).not.toThrow();
    expect(() => ignore("no error at all")).not.toThrow();
    expect(recentSuppressed().length).toBe(before + 2);
    expect(recentSuppressed().at(-1)!.message).toBe("");
    expect(recentSuppressed().at(-2)!.message).toBe("just a string");
  });

  test("ignore() prints when PBOSS_DEBUG=1", () => {
    process.env.PBOSS_DEBUG = "1";
    const errSpy = spyOn(console, "error").mockReturnValue(undefined as void);
    try {
      ignore("debug context", new Error("loud boom"));
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0])).toContain("debug context");
      expect(String(errSpy.mock.calls[0])).toContain("loud boom");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("warn() prints one stderr line and records as warned", () => {
    const errSpy = spyOn(console, "error").mockReturnValue(undefined as void);
    try {
      const before = recentSuppressed().length;
      warn("rotation context", new Error("disk full"));
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0])).toContain("[pboss]");
      expect(String(errSpy.mock.calls[0])).toContain("rotation context");
      expect(String(errSpy.mock.calls[0])).toContain("disk full");
      const last = recentSuppressed().at(-1)!;
      expect(last.level).toBe("warned");
      expect(recentSuppressed().length).toBe(before + 1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("DaemonConflictError", () => {
  test("exit code is 81 (RestartPreventExitStatus target)", () => {
    expect(EXIT_DAEMON_CONFLICT).toBe(81);
  });

  test("message names the socket and the existing pid", () => {
    const e = new DaemonConflictError("/tmp/x/daemon.sock", 4242);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("DaemonConflictError");
    expect(e.existingPid).toBe(4242);
    expect(e.message).toContain("pid 4242");
    expect(e.message).toContain("/tmp/x/daemon.sock");
  });

  test("message tolerates a missing pid", () => {
    const e = new DaemonConflictError("/tmp/x/daemon.sock", null);
    expect(e.existingPid).toBeNull();
    expect(e.message).toContain("/tmp/x/daemon.sock");
    expect(e.message).not.toContain("pid");
  });
});
