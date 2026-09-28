/**
 * ProcBoss (pboss) — Bun filesystem adapter.
 *
 * Bun-native file APIs: Bun.file / Bun.write / Bun.gzipSync. The sink is a
 * BunFile — Bun.spawn accepts it directly as a stdio target, which is how
 * the daemon's launch logs are redirected today.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { openSync } from "node:fs";
import type { PBFileSink, PBFilesystemRuntime } from "../core/types";

export function createBunFilesystem(): PBFilesystemRuntime {
  return {
    readText(path: string): Promise<string> {
      return Bun.file(path).text();
    },

    async readBytes(path: string): Promise<Uint8Array> {
      return new Uint8Array(await Bun.file(path).arrayBuffer());
    },

    readJSON(path: string): Promise<unknown> {
      return Bun.file(path).json();
    },

    async exists(path: string): Promise<boolean> {
      return Bun.file(path).exists();
    },

    async write(path: string, data: string | Uint8Array): Promise<void> {
      await Bun.write(path, data as unknown as string);
    },

    async size(path: string): Promise<number> {
      return Bun.file(path).size;
    },

    async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
      return new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer());
    },

    gzip(data: Uint8Array): Uint8Array {
      return Bun.gzipSync(new Uint8Array(data));
    },

    gunzip(data: Uint8Array): Uint8Array {
      return Bun.gunzipSync(new Uint8Array(data));
    },

    sink(path: string): PBFileSink {
      // Bun.spawn natively accepts raw file descriptors as stdio targets
      // (the cron runner has relied on it since day one) — an append-mode
      // fd IS the native append sink.
      const fd = openSync(path, "a");
      return { __pbFileSink: path, fd };
    },
  };
}
