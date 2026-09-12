import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile, readdir } from "fs/promises";
// NB: no `exists` here — fs/promises.exists is a BUN-ONLY extension. When
// tsc resolves fs/promises against stock @types/node (CI's install can
// re-resolve it transitively), the import stops typechecking. existsSync
// is typed by both @types/node and bun-types and behaves identically here.
import { existsSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `pboss-test-logs-${Date.now()}`);
const LOG_DIR = join(TEST_DIR, "logs");

beforeEach(async () => {
  await mkdir(LOG_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("Log File Management", () => {
  test("should create stdout log file", async () => {
    const logFile = join(LOG_DIR, "app-out.log");
    await writeFile(logFile, "");

    const fileExists = existsSync(logFile);
    expect(fileExists).toBe(true);
  });

  test("should create stderr log file", async () => {
    const logFile = join(LOG_DIR, "app-error.log");
    await writeFile(logFile, "");

    const fileExists = existsSync(logFile);
    expect(fileExists).toBe(true);
  });

  test("should append log lines with timestamps", async () => {
    const logFile = join(LOG_DIR, "app-out.log");
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] Server started on port 3000\n`;

    await writeFile(logFile, logLine);
    const content = await readFile(logFile, "utf-8");

    expect(content).toContain("Server started on port 3000");
    expect(content).toContain("[");
    expect(content).toContain("T");
  });

  test("should handle multiple log entries", async () => {
    const logFile = join(LOG_DIR, "app-out.log");
    const lines = [
      `[${new Date().toISOString()}] Line 1\n`,
      `[${new Date().toISOString()}] Line 2\n`,
      `[${new Date().toISOString()}] Line 3\n`,
    ];

    await writeFile(logFile, lines.join(""));
    const content = await readFile(logFile, "utf-8");
    const logLines = content.trim().split("\n");

    expect(logLines).toHaveLength(3);
  });

  test("should flush (clear) logs for a process", async () => {
    const logFile = join(LOG_DIR, "app-out.log");
    await writeFile(logFile, "some old log data\nmore data\n");

    // Flush = truncate
    await writeFile(logFile, "");
    const content = await readFile(logFile, "utf-8");
    expect(content).toBe("");
  });

  test("should list all log files", async () => {
    await writeFile(join(LOG_DIR, "api-out.log"), "log");
    await writeFile(join(LOG_DIR, "api-error.log"), "err");
    await writeFile(join(LOG_DIR, "worker-out.log"), "log");

    const files = await readdir(LOG_DIR);
    const logFiles = files.filter((f) => f.endsWith(".log"));
    expect(logFiles).toHaveLength(3);
  });

  test("should get last N lines of log", async () => {
    const logFile = join(LOG_DIR, "app-out.log");
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    await writeFile(logFile, lines.join("\n") + "\n");

    const content = await readFile(logFile, "utf-8");
    const allLines = content.trim().split("\n");
    const lastN = allLines.slice(-15);

    expect(lastN).toHaveLength(15);
    expect(lastN[0]).toBe("Line 86");
    expect(lastN[14]).toBe("Line 100");
  });
});

describe("Log Rotation", () => {
  test("should detect when log file exceeds max size", async () => {
    const logFile = join(LOG_DIR, "big-app-out.log");
    const maxSize = 1024; // 1KB
    const bigContent = "x".repeat(maxSize + 100);
    await writeFile(logFile, bigContent);

    const file = Bun.file(logFile);
    expect(file.size).toBeGreaterThan(maxSize);
  });

  test("should rotate log file by renaming", async () => {
    const logFile = join(LOG_DIR, "app-out.log");
    const rotatedFile = join(LOG_DIR, "app-out.log.1");

    await writeFile(logFile, "old content");

    // Simulate rotation
    const content = await readFile(logFile, "utf-8");
    await writeFile(rotatedFile, content);
    await writeFile(logFile, "");

    const oldContent = await readFile(rotatedFile, "utf-8");
    const newContent = await readFile(logFile, "utf-8");

    expect(oldContent).toBe("old content");
    expect(newContent).toBe("");
  });

  test("should keep maximum number of rotated files", async () => {
    const maxRotations = 3;

    for (let i = 1; i <= 5; i++) {
      await writeFile(join(LOG_DIR, `app-out.log.${i}`), `rotation ${i}`);
    }

    const files = await readdir(LOG_DIR);
    const rotated = files
      .filter((f) => f.startsWith("app-out.log."))
      .sort();

    // Simulate cleanup: keep only last N
    const toDelete = rotated.slice(0, rotated.length - maxRotations);
    for (const f of toDelete) {
      await rm(join(LOG_DIR, f));
    }

    const remaining = (await readdir(LOG_DIR)).filter((f) =>
      f.startsWith("app-out.log.")
    );
    expect(remaining).toHaveLength(maxRotations);
  });
});