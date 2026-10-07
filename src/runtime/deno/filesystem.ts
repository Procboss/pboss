/**
 * ProcBoss (pboss) — Deno filesystem adapter.
 *
 * Deno-native file APIs: Deno.readTextFile / Deno.stat / Deno.writeFile.
 * Sync gzip has no Deno.* equivalent — node:zlib IS Deno's supported native
 * path for synchronous compression (Deno implements node: modules natively;
 * the same rule Bun follows for the fs APIs shared code already uses).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { gzipSync, gunzipSync } from "node:zlib";
import type { PBFileSink, PBFilesystemRuntime, PBWatcher } from "../core/types";

export function createDenoFilesystem(): PBFilesystemRuntime {
  return {
    readText(path: string): Promise<string> {
      return Deno.readTextFile(path);
    },

    async readBytes(path: string): Promise<Uint8Array> {
      return await Deno.readFile(path);
    },

    async readJSON(path: string): Promise<unknown> {
      return JSON.parse(await Deno.readTextFile(path));
    },

    async exists(path: string): Promise<boolean> {
      try {
        await Deno.stat(path);
        return true;
      } catch {
        return false; // NotFound and anything else — exists() never throws
      }
    },

    async write(path: string, data: string | Uint8Array): Promise<void> {
      if (typeof data === "string") {
        await Deno.writeTextFile(path, data);
      } else {
        await Deno.writeFile(path, data);
      }
    },

    async size(path: string): Promise<number> {
      return (await Deno.stat(path)).size;
    },

    async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
      const all = await Deno.readFile(path);
      return all.slice(start, end);
    },

    gzip(data: Uint8Array): Uint8Array {
      return gzipSync(data);
    },

    gunzip(data: Uint8Array): Uint8Array {
      return gunzipSync(data);
    },

    sink(path: string): PBFileSink {
      // Deno.Command cannot take a file as stdout — deno/process.ts spawns
      // piped and pumps to the path. The sink is just the tagged path here.
      return { __pbFileSink: path };
    },

    watch(dir: string, onChange: (filename: string) => void): PBWatcher {
      // Deno's native watcher is an ASYNC ITERATOR — pump it on a detached
      // task so the adapter stays synchronous like the other runtimes.
      // (node:fs.watch would work through Deno's node-compat layer, but
      // Deno.watchFs is the native API — the repo's contract.) Events carry
      // ABSOLUTE paths; ignore-list matching is substring, so both spellings
      // behave identically.
      const watcher = Deno.watchFs(dir, { recursive: true });
      void (async () => {
        try {
          for await (const event of watcher) {
            for (const p of event.paths) onChange(p);
          }
        } catch {
          // Closed (or the watched path vanished) — the pump ends.
        }
      })();
      return {
        close: () => {
          try { watcher.close(); } catch { /* already closed */ }
        },
      };
    },
  };
}
