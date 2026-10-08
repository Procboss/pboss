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

import { openSync, readdirSync, statSync, watch as fsWatch } from "node:fs";
import { join, relative } from "node:path";
import type { PBFileSink, PBFilesystemRuntime, PBWatcher } from "../core/types";

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

    watch(dir: string, onChange: (filename: string) => void): PBWatcher {
      // Bun implements node:fs.watch natively — but its `recursive` flag is
      // a SILENT no-op on Linux before bun 1.3.10: only top-level events
      // fire, so a `--watch` app never restarts on changes inside its
      // subdirectories (CI on the pinned bun 1.3.9 caught exactly that;
      // macOS always worked). A silent capability gap cannot be probed
      // synchronously (events are async), so the adapter OWNS its
      // recursion: one non-recursive watch per directory of the tree,
      // added as directories appear, dropped as they go — the same shape
      // node:fs itself uses for recursive watching on Linux. Event paths
      // stay root-relative ("src/deep.js"), the spelling the native
      // recursive watcher reports and the ignore-list matcher expects.
      const watchers = new Map<string, ReturnType<typeof fsWatch>>();
      let closed = false;

      const drop = (d: string): void => {
        const w = watchers.get(d);
        if (!w) return;
        watchers.delete(d);
        try { w.close(); } catch { /* already closed */ }
      };

      const addTree = (d: string): void => {
        if (closed || watchers.has(d)) return;
        let w: ReturnType<typeof fsWatch>;
        try {
          w = fsWatch(d, (_event, filename) => {
            if (closed) return;
            const f = filename?.toString();
            if (!f) return; // no entry name — nothing to report or manage
            onChange(join(relative(dir, d), f));
            // The entry may be a directory the tree does not watch yet —
            // `mkdir -p` creates whole chains silently, so addTree
            // descends into whatever appeared.
            const full = join(d, f);
            try {
              if (statSync(full).isDirectory()) addTree(full);
            } catch {
              // Vanished between event and stat: its watcher (if any) is
              // dead weight — drop it so the map tracks the living tree.
              drop(full);
            }
          });
        } catch {
          // Unreadable or already-vanished — nothing to watch here.
          return;
        }
        watchers.set(d, w);
        // Existing subdirectories need watches too: the caller asked for
        // the TREE, not just the root. Symlinked directories are NOT
        // followed — a symlink can point back at the tree's own ancestor
        // and watching through it would cycle.
        try {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) addTree(join(d, e.name));
          }
        } catch { /* unreadable tree — the parent stays watched */ }
      };

      addTree(dir);

      return {
        close: () => {
          closed = true;
          for (const w of watchers.values()) {
            try { w.close(); } catch { /* already closed */ }
          }
          watchers.clear();
        },
      };
    },
  };
}
