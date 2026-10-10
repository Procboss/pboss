/**
 * ProcBoss (pboss) — Bun runtime adapter.
 *
 * Assembles the Bun-native implementations. Pure factory: no top-level
 * side effects, no other runtime's globals touched.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type { RuntimeAdapter } from "../core/types.ts";
import { createBunProcess } from "./process.ts";
import { createBunFilesystem } from "./filesystem.ts";
import { createBunNetwork } from "./network.ts";

export function createBunAdapter(): RuntimeAdapter {
  return {
    name: "bun",
    capabilities: { nativeWebSocket: true },
    process: createBunProcess(),
    filesystem: createBunFilesystem(),
    network: createBunNetwork(),
    misc: {
      sleep: (ms: number) => Bun.sleep(ms),
      which: (cmd: string) => Bun.which(cmd) ?? null,
      runtimeVersion: () => Bun.version,
      mainPath: () => (typeof Bun.main === "string" ? Bun.main : null),
    },
  };
}
