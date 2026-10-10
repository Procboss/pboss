/**
 * ProcBoss (pboss) — Node runtime adapter.
 *
 * Assembles the Node-native implementations. Pure factory: no top-level
 * side effects; the `ws` dependency is imported lazily (only when a
 * WebSocket server is actually started).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { setTimeout as sleepMs } from "node:timers/promises";
import { isAbsolute, resolve } from "node:path";
import type { RuntimeAdapter } from "../core/types.ts";
import { createNodeProcess } from "./process.ts";
import { createNodeFilesystem } from "./filesystem.ts";
import { createNodeNetwork } from "./network.ts";
import { scanPathFor } from "../shared.ts";

export function createNodeAdapter(): RuntimeAdapter {
  return {
    name: "node",
    capabilities: { nativeWebSocket: true },
    process: createNodeProcess(),
    filesystem: createNodeFilesystem(),
    network: createNodeNetwork(),
    misc: {
      sleep: (ms: number) => sleepMs(ms),
      which: (cmd: string) => scanPathFor(cmd),
      runtimeVersion: () => process.versions.node,
      mainPath(): string | null {
        // argv[1] is the executed script — meaningful when the CLI entry is
        // the process (dist/cli.js, the bin shim). resolve() keeps relative
        // invocations absolute.
        const entry = process.argv[1];
        return entry ? (isAbsolute(entry) ? entry : resolve(entry)) : null;
      },
    },
  };
}
