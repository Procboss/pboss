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

import { detectRuntime, runtimeDisplayName } from "./detect";
import type { RuntimeAdapter, RuntimeName } from "./core/types";
import { createBunAdapter } from "./bun/adapter";
import { createNodeAdapter } from "./node/adapter";
import { createDenoAdapter } from "./deno/adapter";

export type { RuntimeName } from "./core/types";
export type {
  RuntimeAdapter,
  PBChild,
  PBSpawnOptions,
  PBFileSink,
  PBServerHandle,
  PBWsSocket,
} from "./core/types";
export { detectRuntime, runtimeDisplayName } from "./detect";

let cached: RuntimeAdapter | null = null;

/**
 * The process-lifetime runtime adapter. Detects the executing runtime on
 * the first call and returns the same instance forever after.
 */
export function getRuntime(): RuntimeAdapter {
  if (cached) return cached;
  const name = detectRuntime();
  cached =
    name === "bun" ? createBunAdapter() : name === "node" ? createNodeAdapter() : createDenoAdapter();
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
