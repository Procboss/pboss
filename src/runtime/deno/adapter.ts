/**
 * ProcBoss (pboss) — Deno runtime adapter.
 *
 * Assembles the Deno-native implementations. Pure factory: no top-level
 * side effects; every Deno.* call lives inside a function, so merely
 * loading this module under Bun or Node never touches the Deno global.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type { RuntimeAdapter } from "../core/types";
import { createDenoProcess } from "./process";
import { createDenoFilesystem } from "./filesystem";
import { createDenoNetwork } from "./network";
import { scanPathFor } from "../shared";

/** file:// URL → absolute path, without node:url's fromFileUrl (its types
 * vary across runtimes — the conversion is two predictable slices). */
function fileUrlToPath(url: string): string {
  let p = url.replace(/^file:\/\//, "");
  // Windows file URLs carry an extra leading slash: file:///C:/...
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return decodeURIComponent(p);
}

export function createDenoAdapter(): RuntimeAdapter {
  return {
    name: "deno",
    capabilities: { nativeWebSocket: true },
    process: createDenoProcess(),
    filesystem: createDenoFilesystem(),
    network: createDenoNetwork(),
    misc: {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      which: (cmd: string) => scanPathFor(cmd),
      runtimeVersion: () => Deno.version.deno,
      mainPath(): string | null {
        try {
          return fileUrlToPath(Deno.mainModule);
        } catch {
          return null;
        }
      },
    },
  };
}
