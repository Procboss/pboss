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
import { LOG_DIR, DEFAULT_LOG_MAX_SIZE, DEFAULT_LOG_RETAIN } from "./constants";
import type {  LogEntry, LogRotateOptions } from "./types";
import { watch } from "fs";
import type { ReadableStreamController } from "bun";
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
            } catch {}
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
            .slice(options.retain).map(f => unlink(join(dir, f)).catch(() => {}))
        )
      ).catch(() => {})
    );
  
    // Let Bun handle the heavy lifting in the background!
    Promise.all(bgTasks).catch(() => {}); 
  }

  async flush(name: string, id: number, customOut?: string, customErr?: string) {
    const paths = this.getLogPaths(name, id, customOut, customErr);
    try { await Bun.write(paths.outFile, ""); } catch {}
    try { await Bun.write(paths.errFile, ""); } catch {}
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
