/**
 * ProcBoss (pboss) — Node filesystem adapter.
 *
 * Node-native file APIs: node:fs/promises (readFile/writeFile/stat) and
 * node:zlib for compression. The sink is a node WriteStream — node's
 * child_process accepts streams as stdio targets natively.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { createWriteStream, watch as fsWatch } from "node:fs";
import fsp from "node:fs/promises";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip) as (data: Uint8Array) => Promise<Buffer>;
const gunzipAsync = promisify(gunzip) as (data: Uint8Array) => Promise<Buffer>;
import type { PBFileSink, PBFilesystemRuntime, PBWatcher } from "../core/types.ts";

export function createNodeFilesystem(): PBFilesystemRuntime {
  return {
    async readText(path: string): Promise<string> {
      return fsp.readFile(path, "utf8");
    },

    async readBytes(path: string): Promise<Uint8Array> {
      return new Uint8Array(await fsp.readFile(path));
    },

    async readJSON(path: string): Promise<unknown> {
      return JSON.parse(await fsp.readFile(path, "utf8"));
    },

    async exists(path: string): Promise<boolean> {
      try {
        await fsp.stat(path);
        return true;
      } catch {
        return false; // ENOENT and friends — Bun.file().exists() semantics
      }
    },

    async write(path: string, data: string | Uint8Array): Promise<void> {
      await fsp.writeFile(path, data);
    },

    async size(path: string): Promise<number> {
      return (await fsp.stat(path)).size;
    },

    async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
      const fh = await fsp.open(path, "r");
      try {
        const length = end - start;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buffer, 0, length, start);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      } finally {
        await fh.close();
      }
    },

    async gzip(data: Uint8Array): Promise<Uint8Array> {
      // node:zlib's async form — the compression runs on the libuv thread
      // pool, so a big log rotation never blocks the daemon's event loop.
      return new Uint8Array(await gzipAsync(data));
    },

    async gunzip(data: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await gunzipAsync(data));
    },

    async sink(path: string): Promise<PBFileSink> {
      // node:child_process accepts a WriteStream as a stdio target and —
      // when it has an OPEN file descriptor — uses that fd directly: the
      // child dups it, the same kernel-owned redirect Bun and Deno get.
      //
      // The catch (found live, 2026-10-12): createWriteStream opens
      // LAZILY, and spawn() handed a stream whose fd is still null throws
      // ERR_INVALID_ARG_VALUE — which the daemon launch's fallback then
      // swallowed into stdio "ignore": under real node the daemon has
      // been running with NO launch logs since the async mandate. The
      // sink() therefore awaits the "open" event before returning: fd
      // pinned, spawn accepts it, the redirect is real.
      const stream = createWriteStream(path, { flags: "a" });
      // A WriteStream with no "error" listener dies loudly on the first
      // write failure (node throws unhandled 'error' events). The
      // redirect is best-effort everywhere in pboss — a full disk must
      // not take the daemon down with it.
      stream.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });
      return Object.assign(stream, {
        __pbFileSink: path,
        close: () =>
          new Promise<void>((resolve) => {
            if (stream.writableEnded) {
              resolve();
              return;
            }
            stream.end(() => resolve());
          }),
      }) as unknown as PBFileSink;
    },

    watch(dir: string, onChange: (filename: string) => void): PBWatcher {
      const w = fsWatch(dir, { recursive: true }, (_event, filename) => {
        const f = filename?.toString();
        if (f) onChange(f);
      });
      return {
        close: () => {
          try { w.close(); } catch { /* already closed */ }
        },
      };
    },
  };
}
