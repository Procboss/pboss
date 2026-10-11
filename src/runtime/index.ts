/**
 * ProcBoss (pboss) — the runtime adapter entry.
 *
 *     ProcBoss is runtime-agnostic, not runtime-generic.
 *
 * Core process-manager logic lives in PBoss Core and speaks ONLY the
 * adapter interfaces; the adapter selected here forwards to the executing
 * runtime's NATIVE APIs (Bun.spawn / node:child_process / Deno.Command,
 * Bun.serve / node:http / Deno.serve, …).
 *
 * Detection happens ONCE, at first use; the adapter is cached for the
 * process lifetime and hot paths resolve directly to the native
 * implementations (no per-call detection, no dynamic imports, no Promise
 * wrapping in the hot path).
 *
 * Adapter modules are pure function bags with zero top-level side effects:
 * loading all three costs nothing and cannot crash an unsupported runtime
 * (the source-pinning tests in tests/runtime-adapter.test.ts keep each
 * implementation native — a Bun→node-compat regression fails CI).
 *
 * Adding a runtime = new src/runtime/<name>/ directory + one line in the
 * factory below; PBoss Core never changes.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import { detectRuntime, runtimeDisplayName } from "./detect.ts";
import type { RuntimeAdapter, RuntimeName } from "./core/types.ts";

export type { RuntimeName } from "./core/types.ts";
export type {
  RuntimeAdapter,
  PBChild,
  PBSpawnOptions,
  PBFileSink,
  PBWatcher,
  PBServerHandle,
  PBWsSocket,
} from "./core/types.ts";
export { detectRuntime, runtimeDisplayName } from "./detect.ts";

// Perf (2026-10-11, the deno pass): the three adapters used to load
// EAGERLY — "loading all three costs nothing" was true under bun and node,
// but under deno every module of the graph bills real milliseconds, and the
// two adapters for runtimes that are not executing cost ~30ms of EVERY CLI
// invocation and daemon boot. The adapter for the EXECUTING runtime is now
// the only one instantiated, through top-level await (supported by every
// runtime pboss ships under — bun, node and deno all evaluate a module's
// TLA before any importer's body runs, so getRuntime stays synchronous for
// every caller). Literal dynamic-import specifiers keep the dist bundler
// tracing the modules.
const detected = detectRuntime();
const cached: RuntimeAdapter =
  detected === "bun"
    ? (await import("./bun/adapter.ts")).createBunAdapter()
    : detected === "node"
      ? (await import("./node/adapter.ts")).createNodeAdapter()
      : (await import("./deno/adapter.ts")).createDenoAdapter();

/**
 * The process-lifetime runtime adapter. Detected at module load (see the
 * perf note above); the same instance is returned forever after.
 */
export function getRuntime(): RuntimeAdapter {
  return cached;
}

/** The executing runtime's name (detects once, then cached). */
export function currentRuntimeName(): RuntimeName {
  return getRuntime().name;
}

/** "<Display> <version>" for `pboss --runtime` / cloud reports. */
export function runtimeDescription(): string {
  const rt = getRuntime();
  return `${runtimeDisplayName(rt.name)} ${rt.misc.runtimeVersion()}`;
}
