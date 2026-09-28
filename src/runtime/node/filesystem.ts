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

import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import type { PBFileSink, PBFilesystemRuntime } from "../core/types";

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

    gzip(data: Uint8Array): Uint8Array {
      return gzipSync(data);
    },

    gunzip(data: Uint8Array): Uint8Array {
      return gunzipSync(data);
    },

    sink(path: string): PBFileSink {
      // node:child_process takes streams as stdio targets natively; appended
      // so daemon launch logs survive restarts.
      const stream = createWriteStream(path, { flags: "a" });
      return Object.assign(stream, { __pbFileSink: path }) as unknown as PBFileSink;
    },
  };
}
