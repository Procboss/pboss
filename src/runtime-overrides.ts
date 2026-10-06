/**
 * ProcBoss (pboss) — the persistent, global runtime overrides (issue #40).
 * https://procboss.com
 * License: GPL-3.0-only
 *
 * ONE store, three readers:
 *
 *   ~/.pboss/runtime-overrides   (PBOSS_HOME overrides the directory)
 *
 * Flat, line-based, TAB-separated — deliberately NOT JSON, because the bin
 * wrappers (bin/pboss.sh, bin/pboss.ps1) must read it with the primitives
 * their own languages have (awk / Get-Content), and a shell script cannot
 * import TypeScript. One entry per line:
 *
 *   my-api\tbun
 *   /srv/app/ecosystem.config.ts\tdeno
 *
 * Keys are either a process BASE name (what `pboss start --name api` or the
 * script basename produced — cluster instances strip their -N suffix) or an
 * ABSOLUTE ecosystem config path (what loadEcosystemConfig resolved).
 * Values are one of node | bun | deno.
 *
 * What it means (the issue-#40 contract):
 *
 *   `pboss start --runtime=bun ./script.ts` pins that PROCESS to bun;
 *   `pboss start --runtime=deno ecosystem.config.ts` pins the WHOLE
 *   ecosystem. The pin is persistent — restart, reload, a pboss reboot, a
 *   machine reboot (the dump carries the ecosystem path) all keep using
 *   it — and it NEVER touches ~/.pboss/.runtime, the machine-wide default
 *   that only `pboss runtime change` may write.
 *
 * Effective runtime for a managed process (the issue's precedence, applied
 * at every spawn — cluster-manager.buildWorkerCommand):
 *
 *   1. runtime_overrides   this store: the process's own name, its cluster
 *                          base name, then its ecosystem config path
 *   2. .runtime            the machine-wide default (leniently read: a
 *                          missing/empty file is "no default", never the
 *                          hard §20 error — that guard belongs to the
 *                          wrapper, and a bad default must not brick the
 *                          fleet's spawns)
 *   3. normal detection    inherit the main runtime / discovery chain
 *
 * The bin wrappers apply the SAME order for the runtime that executes the
 * pboss CLI itself (issue #40, "Launcher/runtime resolution"): the saved
 * override for the invocation's target wins over .runtime. The wrappers
 * never WRITE this store — only the daemon does.
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PBOSS_HOME } from "./constants";
import {
  RUNTIME_FILE,
  SUPPORTED_RUNTIMES,
  isValidRuntime,
  normalizeRuntime,
  readRuntimeFileRaw,
  type RuntimeChoice,
} from "./runtime-config";

/** The store file. PBOSS_HOME overrides ~/.pboss (tests, portability). */
export const RUNTIME_OVERRIDES_FILE = join(PBOSS_HOME, "runtime-overrides");

/**
 * The env channel from the bin wrapper to the CLI (issue #40). The wrapper
 * owns the `--runtime` flag — it strips it before the CLI runs — and hands
 * the value down ONLY through this variable, so the CLI's start paths can
 * pin the process/ecosystem being started. The JavaScript level never parses
 * the flag itself (owner spec, 2026-10-07).
 */
export const LAUNCHER_RUNTIME_ENV = "PBOSS_LAUNCHER_RUNTIME";

/* ── parsing (pure — the format is pinned by tests) ─────────────────────── */

/**
 * Parse the store's text into a map. Corrupt lines (no TAB, an empty key,
 * a value outside the canonical runtime list) are skipped SILENTLY — the
 * same leniency the wrappers apply with awk — so one bad hand-edited line
 * can never brick the CLI: every other entry keeps working.
 */
export function parseRuntimeOverrides(text: string): Map<string, RuntimeChoice> {
  const out = new Map<string, RuntimeChoice>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue; // no TAB or an empty key
    const key = line.slice(0, tab).trim();
    const value = normalizeRuntime(line.slice(tab + 1));
    if (key === "" || !isValidRuntime(value)) continue;
    out.set(key, value);
  }
  return out;
}

/** Serialize a map back to the canonical text (sorted keys — stable diffs). */
export function formatRuntimeOverrides(store: Map<string, RuntimeChoice>): string {
  const lines = [
    "# pboss runtime overrides (issue #40) — key<TAB>runtime.",
    "# Keys: process base names, or absolute ecosystem config paths.",
    `# Managed by pboss; the value survives restarts, reboots and upgrades.`,
  ];
  for (const key of [...store.keys()].sort()) {
    lines.push(`${key}\t${store.get(key)}`);
  }
  return lines.join("\n") + "\n";
}

/** Read the store. Absent → an empty map (nothing pinned on this machine). */
export async function readRuntimeOverrides(
  file: string = RUNTIME_OVERRIDES_FILE,
): Promise<Map<string, RuntimeChoice>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return new Map();
  }
  return parseRuntimeOverrides(text);
}

/**
 * Persist the store atomically (tmp + rename — the same discipline as
 * writeRuntimeSelection): a torn write must never leave the machine with a
 * half-updated override table mid-restart.
 */
export async function writeRuntimeOverridesStore(
  store: Map<string, RuntimeChoice>,
  file: string = RUNTIME_OVERRIDES_FILE,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, formatRuntimeOverrides(store), "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows rename-over-existing can race an AV scan; retry once via
    // unlink+rename before giving up (mirrors writeRuntimeSelection).
    try {
      await unlink(file);
      await rename(tmp, file);
    } catch {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }
}

/** Pin one key (read-modify-write, atomic). */
export async function writeRuntimeOverride(
  key: string,
  runtime: RuntimeChoice,
  file: string = RUNTIME_OVERRIDES_FILE,
): Promise<void> {
  const store = await readRuntimeOverrides(file);
  store.set(key, runtime);
  await writeRuntimeOverridesStore(store, file);
}

/** Unpin keys (read-modify-write, atomic; missing keys are a no-op). */
export async function removeRuntimeOverrides(
  keys: string[],
  file: string = RUNTIME_OVERRIDES_FILE,
): Promise<void> {
  const store = await readRuntimeOverrides(file);
  let changed = false;
  for (const key of keys) {
    if (store.delete(key)) changed = true;
  }
  if (changed) await writeRuntimeOverridesStore(store, file);
}

/* ── lookup (the issue's precedence, step 1) ────────────────────────────── */

/**
 * Strip ONE trailing cluster-instance suffix: `api-3` → `api`. Fork-mode
 * instances are named `<base>-<index>` (process-manager startInternal);
 * scale-ups mint new indexes the original start never saw, so the lookup
 * must fall back from the instance name to the base that was pinned.
 * A missing name (defensive: hand-built configs) reads as "" — no lookup
 * can match it, but nothing crashes either.
 */
export function baseProcessName(name: string): string {
  return (name ?? "").replace(/-\d+$/, "");
}

/**
 * The override for a process, from a parsed store: the exact name, then the
 * cluster base name, then the ecosystem config path it was started from.
 * The name is the pin's own unit (issue #40: "my-api: bun"); the ecosystem
 * is the group pin every process inside it inherits. A falsy name (a
 * hand-built config) skips the name lookups — the ecosystem path, when
 * present, still applies.
 */
export function lookupRuntimeOverride(
  store: Map<string, RuntimeChoice>,
  name: string,
  ecosystemPath?: string,
): RuntimeChoice | null {
  if (name) {
    const direct = store.get(name);
    if (direct) return direct;
    const base = baseProcessName(name);
    if (base !== name) {
      const pinned = store.get(base);
      if (pinned) return pinned;
    }
  }
  if (ecosystemPath) {
    const eco = store.get(ecosystemPath);
    if (eco) return eco;
  }
  return null;
}

/** The stored override for a process, reading the store from disk. */
export async function resolveOverrideRuntime(
  name: string,
  ecosystemPath?: string,
  file: string = RUNTIME_OVERRIDES_FILE,
): Promise<RuntimeChoice | null> {
  return lookupRuntimeOverride(await readRuntimeOverrides(file), name, ecosystemPath);
}

/* ── the .runtime default, leniently (the issue's precedence, step 2) ───── */

/**
 * The machine-wide default for MANAGED PROCESSES (issue #40 step 2):
 * ~/.pboss/.runtime when it holds a valid runtime, null when absent, empty
 * or corrupt. The §20 hard error belongs to the wrapper — a broken default
 * must not take the fleet's spawns down with it.
 */
export async function lenientDefaultRuntime(
  file: string = RUNTIME_FILE,
): Promise<RuntimeChoice | null> {
  const raw = await readRuntimeFileRaw(file);
  if (raw === null) return null;
  const normalized = normalizeRuntime(raw);
  return isValidRuntime(normalized) ? normalized : null;
}

/**
 * The full effective runtime for a managed process — the issue's steps
 * 1+2 only. Null means "fall through to the normal chain" (inherit the
 * main runtime / machine-wide discovery — resolveScriptInterpreter).
 */
export async function effectiveProcessRuntime(
  name: string,
  ecosystemPath?: string,
  overridesFile: string = RUNTIME_OVERRIDES_FILE,
  runtimeFile: string = RUNTIME_FILE,
): Promise<RuntimeChoice | null> {
  const override = await resolveOverrideRuntime(name, ecosystemPath, overridesFile);
  if (override) return override;
  return lenientDefaultRuntime(runtimeFile);
}

/* ── the wrapper → CLI channel ──────────────────────────────────────────── */

/**
 * Read the launcher's runtime hand-off (issue #40). The wrapper exports
 * PBOSS_LAUNCHER_RUNTIME only when `--runtime` was explicitly supplied;
 * the CLI's start paths translate it into the wire field that pins the
 * process/ecosystem. A malformed value (only possible by setting the
 * variable by hand — the wrapper validates the flag) is ignored, dimly:
 * an internal channel must never crash a start.
 */
export function launcherRuntimeFromEnv(
  env: Record<string, string | undefined>,
): RuntimeChoice | null {
  const raw = env[LAUNCHER_RUNTIME_ENV];
  if (raw === undefined || raw === "") return null;
  const normalized = normalizeRuntime(raw);
  if ((SUPPORTED_RUNTIMES as readonly string[]).includes(normalized)) {
    return normalized as RuntimeChoice;
  }
  console.warn(`[pboss] ignoring invalid ${LAUNCHER_RUNTIME_ENV}="${raw}" (expected node, bun or deno)`);
  return null;
}
