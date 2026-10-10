/**
 * ProcBoss (pboss) — runtime detection.
 *
 * Identifies the runtime ACTUALLY EXECUTING pboss — never what the installer
 * saw, never what compatibility APIs are reachable. Detection order matters:
 *
 *   1. Bun — the `Bun` global. Bun also exposes `process.versions.node`
 *      (full Node compatibility), so it MUST be tested before Node.
 *   2. Deno — the `Deno` global. Deno's node-compat layer also provides
 *      `process` for npm packages, so it too must precede Node.
 *   3. Node — `process.versions.node`.
 *
 * Anything else fails cleanly with the supported list. There is no silent
 * Node fallback: a compatibility API existing is NOT the same as the
 * runtime being that thing.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type { RuntimeName } from "./core/types.ts";

/**
 * Detect the executing runtime. Pure, synchronous, cheap — but still called
 * only once per process (getRuntime() caches the adapter); hot paths never
 * re-detect.
 */
export function detectRuntime(): RuntimeName {
  if (typeof globalThis.Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno"; // ambient shim types under non-Deno toolchains
  if (
    typeof globalThis.process !== "undefined" &&
    typeof (globalThis.process as { versions?: { node?: string } }).versions?.node === "string"
  ) {
    return "node";
  }

  // Nothing we support. Name the environment as best we can (Deno's
  // `process` shim and browsers' navigator differ) and fail loudly.
  const env = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "unknown";
  throw new Error(
    `Unsupported runtime: ${env}\n\n` +
      "ProcBoss currently supports:\n" +
      "- Bun    (https://bun.sh)\n" +
      "- Node.js (https://nodejs.org)\n" +
      "- Deno    (https://deno.com)\n\n" +
      "Run pboss with one of these runtimes."
  );
}

/** Human display name for a runtime ("Bun", "Node.js", "Deno"). */
export function runtimeDisplayName(name: RuntimeName): string {
  switch (name) {
    case "bun":
      return "Bun";
    case "node":
      return "Node.js";
    case "deno":
      return "Deno";
  }
}
