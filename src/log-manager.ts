/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { join, dirname, basename } from "path";
import { appendFile, rename, unlink, readdir } from "fs/promises";
import { LOG_DIR } from "./constants";
import { ignore, warn } from "./error-handling";
import type {  LogEntry, LogRotateOptions } from "./types";
import { EOL } from 'node:os';

const isoRegex: RegExp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

// [__br__] = linebreak
const nl = "[__br__]"

export class LogManager {
  
  private writeBuffers: Map<string, string[]> = new Map();
  private flushTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  getLogPaths(name: string, id: number, customOut?: string, customErr?: string) {
    return {
      outFile: customOut || join(LOG_DIR, `${name}-${id}-out.log`),
      errFile: customErr || join(LOG_DIR, `${name}-${id}-error.log`),
    };
  }
  
  
  async appendLog(filePath: string, data: string | Uint8Array) {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);

    // Buffer writes for performance
    if (!this.writeBuffers.has(filePath)) {
      this.writeBuffers.set(filePath, []);
    }
    this.writeBuffers.get(filePath)!.push(text);

    // Debounced flush
    if (!this.flushTimers.has(filePath)) {
      this.flushTimers.set(filePath, setTimeout(() => {
        this.flushBuffer(filePath);
      }, 100));
    }
  }
  
  async appendJSONLog(filePath: string, msg: string) {
    
     msg = msg.trim().replace(/[\r\n]+/g, nl);
    
    const log: LogEntry = {
      ts: new Date().toISOString(),
      msg
    };
  
    const line = JSON.stringify(log) + "\n";
  
    // reuse your buffer system 
    if (!this.writeBuffers.has(filePath)) {
      this.writeBuffers.set(filePath, []);
    }
  
    this.writeBuffers.get(filePath)!.push(line);
  
    if (!this.flushTimers.has(filePath)) {
      this.flushTimers.set(
        filePath,
        setTimeout(() => this.flushBuffer(filePath), 100)
      );
    }
  }

  private async flushBuffer(filePath: string) {
    const buffer = this.writeBuffers.get(filePath);
    if (!buffer || buffer.length === 0) return;

    const content = buffer.join("");
    this.writeBuffers.set(filePath, []);
    this.flushTimers.delete(filePath);

    try {
      // Use appendFile (O_APPEND) instead of read-entire-file-then-rewrite.
      // The old Bun.write approach pulled the whole log into a JS string on
      // every flush — O(file size) memory per flush, quadratic overall.
      // appendFile seeks to EOF at the kernel level and writes only new bytes.
      await appendFile(filePath, content, { encoding: "utf8" });
    } catch (err) {
      console.error(`[pboss] Failed to write log: ${filePath}`, err);
    }
  }

  async forceFlush() {
    for (const [filePath] of this.writeBuffers) {
      await this.flushBuffer(filePath);
    }
  }
  
  private parseLine(line: string, level?: "err" | "out"): LogEntry {
    
    let newLine: LogEntry;
    
    try {
      
      newLine = JSON.parse(line) as LogEntry;
      
    } catch {
      // fallback to old format
      const ts = this.extractLogTs(line);
      const msg = line.replace(`[${ts}]`, "").trim();
      newLine = { ts, msg };
    }
    
    newLine.msg = newLine.msg.replaceAll(nl, EOL)
    newLine.level = level;
    
    return newLine;
  }
  
  private extractLogTs(line: string) {
    const match = line.match(isoRegex);
    return match?.[0] ?? ""
  }

  async readLogs(
    name: string,
    id: number,
    lines: number = 20,
    customOut?: string,
    customErr?: string
  ): Promise<LogEntry[]> {

    const paths = this.getLogPaths(name, id, customOut, customErr);
    
    const logs = (await Promise.all(Object.values(paths).map(async (fp) => {         
      
      const f = Bun.file(fp);
      if (!(await f.exists())) return [];

      const level = (fp == paths.errFile) ? "err" : "out";
      
      const rawLog = await f.text();
 
       return rawLog
         .split(/\r?\n/)
         .filter(Boolean)
         .slice(-lines)
         .map(l => this.parseLine(l, level));
      
    }))).flat();
        
    // lets sort the logs here 
    let sortedLogs = logs
      .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))
    
    if (sortedLogs.length > lines) {
      sortedLogs = sortedLogs.slice(-lines)
    }
      
    return sortedLogs
  }

  async tailLog(
    name: string,
    id: number,
    streamController: ReadableStreamDefaultController,
    signal: AbortSignal
  ) {
    const paths = this.getLogPaths(name, id);

    const state = {
      out: Bun.file(paths.outFile).size,
      err: Bun.file(paths.errFile).size,
    };

    const poll = setInterval(async () => {
      for (const [type, fp] of [["out", paths.outFile],["err", paths.errFile],] as const) {

        const f = Bun.file(fp);

        if (!(await f.exists())) continue;

        let lastSize = state[type];

        const size = f.size;

        if (size < lastSize) {
          state[type] = 0; // rotated file
          lastSize = 0;
        }

        if (size === lastSize) continue;

        const chunk = await f.slice(lastSize, size).text();
        state[type] = size;

        for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
          try {
            const log = { name, id, ...this.parseLine(line, type) };
            streamController.enqueue(`data: ${JSON.stringify(log)}\n\n`);
          } catch {
            clearInterval(poll);
            return;
          }
        }
      }
    }, 500);

    signal.addEventListener("abort", () => {
      clearInterval(poll);
    });
  }

  /**
   * Callback-based incremental tail (used by the cloud agent's log.watch).
   * Polls both log files every `intervalMs`, parses new lines, and emits
   * them as {t, level, msg} batches. Returns the stop function.
   * Idempotent per (name, id) — starting a second watch on the same files
   * stops the first.
   */
  watchLogs(
    name: string,
    id: number,
    onLines: (lines: { t: number; level: string; msg: string }[]) => void,
    customOut?: string,
    customErr?: string,
    intervalMs = 500
  ): () => void {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    const key = `${name}-${id}`;

    // one tail per target — a second watcher replaces the first
    this.lineWatchers.get(key)?.();

    const state = { out: -1, err: -1 };

    const readSide = async (
      type: "out" | "err",
      fp: string
    ): Promise<{ t: number; level: string; msg: string }[]> => {
      const f = Bun.file(fp);
      if (!(await f.exists())) return [];
      if (state[type] === -1) {
        // first poll: start from EOF, only NEW lines are "live"
        state[type] = f.size;
        return [];
      }
      let lastSize = state[type];
      const size = f.size;
      if (size < lastSize) {
        state[type] = 0; // rotated file
        lastSize = 0;
      }
      if (size === lastSize) return [];
      const chunk = await f.slice(lastSize, size).text();
      state[type] = size;
      const lines: { t: number; level: string; msg: string }[] = [];
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        const parsed = this.parseLine(line, type);
        lines.push({
          t: Date.now(),
          level: type === "err" ? "err" : "info",
          msg: parsed.msg,
        });
      }
      return lines;
    };

    const poll = setInterval(async () => {
      try {
        const out = await readSide("out", paths.outFile);
        const err = await readSide("err", paths.errFile);
        const batch = [...out, ...err];
        if (batch.length > 0) onLines(batch);
      } catch (err) {
        // unreadable mid-poll (rotation race) — next tick retries
        ignore(`watch logs ${name}-${id}`, err);
      }
    }, intervalMs);

    const stop = () => {
      clearInterval(poll);
      if (this.lineWatchers.get(key) === stop) this.lineWatchers.delete(key);
    };
    this.lineWatchers.set(key, stop);
    return stop;
  }

  private lineWatchers = new Map<string, () => void>();

  async rotate(filePath: string, options: LogRotateOptions): Promise<void> {
    
    const file = Bun.file(filePath);
    
    if (!(await file.exists()) || file.size < options.maxSize) return;
  
    const bgTasks: Promise<any>[] = [];
  
    for (let i = options.retain - 1; i >= 1; i--) {
      
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
  
      if (await Bun.file(src).exists()) {
        
        await rename(src, dst);
        if (options.compress) {
          bgTasks.push((async () => {
            try {
              const srcFile = Bun.file(dst);
              if (await srcFile.exists()) {
                const data = await srcFile.arrayBuffer();
                const compressed = Bun.gzipSync(new Uint8Array(data));
                await Bun.write(`${dst}.gz`, compressed);
                await unlink(dst);
              }
            } catch (err) {
              // Lost compression leaves the rotated file on disk (not lost,
              // just uncompressed) — visible, not silent.
              warn(`compress rotated log ${dst}`, err);
            }
          })());
        }
      }
    }
  
    await Bun.write(filePath, ""); // Instantly truncate and reclaim space
  
    const dir = dirname(filePath);
    const baseName = basename(filePath);
  
    // Background cleanup
    bgTasks.push(
      readdir(dir).then(files =>
        Promise.all(
          files.filter(f => f.startsWith(`${baseName}.`)).sort().reverse()
            .slice(options.retain).map(f =>
              unlink(join(dir, f)).catch(err => ignore(`delete old rotated log ${f}`, err))
            )
        )
      ).catch(err => ignore(`readdir ${dir} during rotation cleanup`, err))
    );
  
    // Let Bun handle the heavy lifting in the background!
    Promise.all(bgTasks).catch(err => ignore("log rotation background tasks", err)); 
  }

  async flush(name: string, id: number, customOut?: string, customErr?: string) {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    try { await Bun.write(paths.outFile, ""); } catch (err) { warn(`truncate ${paths.outFile}`, err); }
    try { await Bun.write(paths.errFile, ""); } catch (err) { warn(`truncate ${paths.errFile}`, err); }
  }

  async checkRotation(
    name: string,
    id: number,
    options: LogRotateOptions,
    customOut?: string,
    customErr?: string
  ) {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    await this.rotate(paths.outFile, options);
    await this.rotate(paths.errFile, options);
  }
}

/* ── log search (log.search cloud command + CLI) ─────────────────────── */

/** One matching line found by searchLogFiles. */
export interface LogSearchMatch {
  /** The file it came from (basename — rotations included). */
  file: string;
  /** Parsed epoch-ms timestamp (null when the line carries none). */
  ts: number | null;
  /** The message text (the searchable part, not the raw JSON envelope). */
  line: string;
  level?: "err" | "out";
}

export interface LogSearchResult {
  matches: LogSearchMatch[];
  /** Basenames actually scanned (missing files are skipped silently). */
  scannedFiles: string[];
  /** True when the result hit maxResults before exhausting the files. */
  truncated: boolean;
}

/** Lines examined per file — bounds the worst case (a 10MB log is ~100k
 *  lines; anything past this is pathological and still bounded work). */
const SEARCH_LINE_CAP = 200_000;

/**
 * Time-ranged regex search across a process's logs — the LIVE files plus
 * every rotation on disk (`.N` and `.N.gz`, in rotation order: newest
 * first). `from`/`to` are epoch ms; lines without a parseable timestamp
 * are kept only when no range was given. An invalid regex degrades to a
 * case-insensitive literal match instead of throwing.
 */
export async function searchLogFiles(
  files: Array<string | undefined>,
  query: string,
  opts: { from?: number; to?: number; maxResults?: number } = {}
): Promise<LogSearchResult> {
  const maxResults = Math.max(1, Math.min(1000, opts.maxResults ?? 200));
  let re: RegExp;
  try {
    re = new RegExp(query, "i");
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  // Expand each base file with its rotations: file, file.1.gz, file.1,
  // file.2.gz, file.2… — higher N is OLDER; within one N, .gz vs plain is
  // the same content at different compression stages, so prefer .gz.
  const expanded: Array<{ path: string; level: "err" | "out" }> = [];
  const dirEntries = new Map<string, Set<string>>();
  for (const f of files) {
    if (!f) continue;
    const dir = dirname(f);
    const base = basename(f);
    if (!dirEntries.has(dir)) {
      try {
        dirEntries.set(dir, new Set(await readdir(dir)));
      } catch (err) {
        ignore(`readdir ${dir} for log search`, err);
        dirEntries.set(dir, new Set());
      }
    }
    const names = dirEntries.get(dir)!;
    const level: "err" | "out" = base.includes("error") ? "err" : "out";
    expanded.push({ path: f, level });
    // rotations, oldest last but scanned newest-first below
    const rotations: Array<{ n: number; gz: boolean }> = [];
    for (const name of names) {
      const m = new RegExp(`^${escapeRe(base)}\\.(\\d+)(\\.gz)?$`).exec(name);
      if (m) rotations.push({ n: Number(m[1]), gz: Boolean(m[2]) });
    }
    rotations.sort((a, b) => a.n - b.n);
    const seen = new Set<number>();
    for (const r of rotations) {
      if (seen.has(r.n)) continue; // .gz won the race above (sorted same N)
      seen.add(r.n);
      expanded.push({
        path: join(dir, `${base}.${r.n}${r.gz ? ".gz" : ""}`),
        level,
      });
    }
  }

  // Scan NEWEST first: live file, then .1, .2 …
  const matches: LogSearchMatch[] = [];
  const scannedFiles: string[] = [];
  let truncated = false;

  for (let i = 0; i < expanded.length && matches.length < maxResults; i++) {
    const { path, level } = expanded[i]!;
    let text: string;
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) continue;
      const buf = await f.arrayBuffer();
      text = path.endsWith(".gz")
        ? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(buf)))
        : new TextDecoder().decode(buf);
    } catch (err) {
      ignore(`read log file ${path} for search`, err);
      continue;
    }
    scannedFiles.push(basename(path));

    const lines = text.split(/\r?\n/);
    const start = Math.max(0, lines.length - SEARCH_LINE_CAP);
    for (let li = start; li < lines.length; li++) {
      const raw = lines[li]!;
      if (!raw) continue;
      const parsed = parseLineForSearch(raw);
      if (opts.from !== undefined || opts.to !== undefined) {
        if (parsed.ts === null) continue; // untimestamped + a range = skip
        if (opts.from !== undefined && parsed.ts < opts.from) continue;
        if (opts.to !== undefined && parsed.ts > opts.to) continue;
      }
      if (re.test(parsed.msg)) {
        matches.push({ file: basename(path), ts: parsed.ts, line: parsed.msg, level });
        if (matches.length >= maxResults) {
          truncated = i < expanded.length - 1 || li < lines.length - 1;
          break;
        }
      }
    }
  }

  return { matches, scannedFiles, truncated };
}

function parseLineForSearch(
  raw: string
): { ts: number | null; msg: string } {
  try {
    const entry = JSON.parse(raw) as LogEntry;
    if (entry && typeof entry.ts === "string" && typeof entry.msg === "string") {
      const t = Date.parse(entry.ts);
      return {
        ts: Number.isFinite(t) ? t : null,
        msg: entry.msg,
      };
    }
  } catch {
    // pre-JSON format: [ISO] message
  }
  const m = raw.match(isoRegex);
  const ts = m ? Date.parse(m[0]) : NaN;
  return {
    ts: Number.isFinite(ts) ? ts : null,
    msg: (m ? raw.replace(`[${m[0]}]`, "") : raw).trim(),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
