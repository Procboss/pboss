/**
 * ProcBoss (pboss) — JavaScript & TypeScript Process Manager
 * A production-grade, runtime-agnostic process manager — Bun, Node.js and Deno.
 *
 * Deno permissions — the first RUNTIME-UNIQUE feature (owner request,
 * 2026-10-06): `--permissions "allow-read,allow-net=api.example.com"` on the
 * CLI or `permissions: ["allow-read", …]` in an ecosystem file translates to
 * real deno permission flags at the command-build choke point
 * (ClusterManager.buildWorkerCommand). Under bun/node the list is IGNORED —
 * those runtimes have no permission model, and a config stays portable across
 * machines whose interpreter chains differ.
 *
 * The UNSTATED default (owner rule, 2026-10-08): no permission flags at all —
 * deno's own deny-by-default. Before that date pboss's resolved route granted
 * the kitchen-sink `-A`, which silently allowed everything the user never
 * stated (owner report: a serving app started with NO net permission).
 *
 * The rules below were verified against deno 2.9.7 (see tests for the pins):
 *   - `deno file.ts` implies `run`, so `["deno", "--allow-write", file]` is a
 *     valid spawn — flags may sit directly after the binary.
 *   - `-A` mixed with ANY `--allow-*` is a HARD deno error
 *     ("--allow-all conflicts with --allow-write") in BOTH orders — so the
 *     merge must never produce that combination, in either direction.
 *   - `-A --deny-write` IS valid (deny takes precedence over allow) — deny
 *     entries are therefore always appendable on top of an existing `-A`.
 *   - Two `--allow-write=…` flags are NOT a union — a repeated stem replaces,
 *     so duplicates are never emitted and a user's scoping is never overridden.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */
import { commandRuntime } from "./install-mode";

/**
 * The deno permission categories (deno 2.x flag surface). Anything else in a
 * permissions entry fails validation at start time with a clear message — a
 * typo like "allow-writ" must not silently under-permission an app. Exotic
 * future categories can still ride through `--interpreter-args` untouched.
 */
export const DENO_PERMISSION_CATEGORIES: readonly string[] = [
  "read",
  "write",
  "net",
  "env",
  "run",
  "sys",
  "ffi",
  "hrtime",
];

/** One normalized permission flag: `-A`, or `--allow-x` / `--deny-x` (± `=value`). */
export type DenoPermissionFlag = string;

/**
 * Parse and normalize a permissions entry list into deno flags.
 *
 * Accepted entry forms (leading `--` tolerated, category case-insensitive,
 * values preserved verbatim):
 *   "allow-read"            → "--allow-read"
 *   "allow-net=api.com:443" → "--allow-net=api.com:443"
 *   "deny-write"            → "--deny-write"
 *   "-A" | "A" | "all"      → "-A"          (deno's short --allow-all)
 *   "none"                  → the list is EMPTY (dominates everything — the
 *                             escape hatch for a zero-permission deno app)
 *
 * Within-list cleanup (mirrors the verified deno semantics above):
 *   - exact duplicates are dropped
 *   - "all" present → every allow-* entry is dropped (they conflict with -A);
 *     deny-* entries survive (they layer on top of -A)
 *   - "none" present → the whole list is empty
 *   - same stem twice → the LAST occurrence wins (a repeated stem replaces,
 *     it never unions)
 *
 * Throws a descriptive Error on anything unparseable.
 */
export function normalizeDenoPermissions(entries: string[]): DenoPermissionFlag[] {
  const raw = entries
    .map((e) => (typeof e === "string" ? e.trim() : ""))
    .filter((e) => e !== "");

  if (raw.some((e) => e.replace(/^--?/i, "").toLowerCase() === "none")) {
    return []; // "none" dominates: a zero-permission app
  }

  const flags: string[] = [];
  const stems = new Map<string, string>(); // "allow-read" → flag (last wins)
  let sawAll = false;

  for (const entry of raw) {
    const bare = entry.replace(/^--?/, "");
    const lower = bare.toLowerCase();

    if (lower === "a" || lower === "all" || lower === "allow-all") {
      sawAll = true;
      continue;
    }

    const m = bare.match(/^(allow|deny)-([A-Za-z][A-Za-z0-9]*)(?:=(.*))?$/i);
    if (!m) {
      throw new Error(
        `Invalid deno permission "${entry}". Entries are allow-<category> or deny-<category> ` +
          `(optionally =value), plus "all" (= -A) and "none". ` +
          `Categories: ${DENO_PERMISSION_CATEGORIES.join(", ")}. ` +
          `Examples: "allow-read", "allow-net=api.example.com", "deny-write", "all".`
      );
    }
    const [, polarity, category, value] = m as unknown as [
      string,
      "allow" | "deny",
      string,
      string | undefined,
    ];
    const cat = category.toLowerCase();
    if (!DENO_PERMISSION_CATEGORIES.includes(cat)) {
      throw new Error(
        `Invalid deno permission "${entry}" — unknown category "${category}". ` +
          `Categories: ${DENO_PERMISSION_CATEGORIES.join(", ")}. ` +
          `Examples: "allow-read", "allow-net=api.example.com", "deny-write".`
      );
    }
    const stem = `${polarity.toLowerCase()}-${cat}`;
    const flag = `--${polarity.toLowerCase()}-${cat}${value !== undefined ? `=${value}` : ""}`;
    // A repeated stem REPLACES (never unions — verified deno behavior).
    const prev = stems.get(stem);
    if (prev !== undefined) {
      const idx = flags.indexOf(prev);
      if (idx !== -1) flags.splice(idx, 1);
    }
    stems.set(stem, flag);
    flags.push(flag);
  }

  // "all" subsumes every allow-* (and would hard-conflict with them in deno);
  // deny-* layers on top of -A and stays.
  if (sawAll) {
    return [...flags.filter((f) => !/^--allow-/.test(f)), "-A"];
  }
  return flags;
}

/** Options for mergeDenoPermissions. */
export interface DenoPermissionMergeContext {
  /**
   * Exclusive end of the prefix region that may contain pboss's OWN default
   * flags — the resolved interpreter route (`deno run --quiet`, and on older
   * pboss installs `deno run -A`), never a flag the user typed. Pass 0 when
   * every flag in the prefix is user-stated (an explicit `--interpreter`),
   * so a user's `-A` is never stripped, only deduplicated against.
   */
  defaultAllEnd: number;
}

/**
 * Merge a permissions list into a partially-built interpreter command — the
 * core of the feature. `prefix` is the command so far WITHOUT the script
 * (`["deno", "run", "-A"]`, `["deno", "--allow-read"]`,
 * `["node", "--max-old-space-size=4096"]`, …). Returns the new prefix; the
 * input array is never mutated.
 *
 * Contract:
 *
 *   1. RUNTIME-UNIQUE: a prefix whose first token is not deno comes back
 *      UNCHANGED. bun and node have no permission model — the list is
 *      ignored, never an error, so one ecosystem file drives a mixed fleet.
 *
 *   2. pboss's own default `-A` (resolved-route region only, see
 *      defaultAllEnd — present only on older pboss installs; the current
 *      resolved route is `deno run --quiet`) is STRIPPED when a permission
 *      list is present — asking for specific grants means not-all.
 *      `permissions: ["none"]` therefore yields a zero-permission deno app
 *      (identical to the unstated default, stated explicitly).
 *
 *   3. USER-STATED FLAGS ARE AUTHORITATIVE (issue: "not duplicate it"):
 *      an existing flag with the same stem (any scoping) suppresses that
 *      entry; an existing `-A`/`--allow-all` suppresses every allow-* entry
 *      (appending one is a hard deno error anyway) while deny-* entries
 *      still append (valid and meaningful on top of -A).
 *
 *   4. "all" is likewise suppressed when the user already stated ANY allow-*
 *      flag — `-A` after a scoped `--allow-write=/tmp` is the deno conflict
 *      error, and widening a user's explicit scoping is never the job of a
 *      convenience flag. Exact duplicates are never emitted.
 */
export function mergeDenoPermissions(
  prefix: string[],
  permissions: string[],
  ctx: DenoPermissionMergeContext
): string[] {
  // Rule 1 — runtime-unique: only deno translates permissions.
  if (commandRuntime(prefix) !== "deno") return prefix;
  if (!permissions || permissions.length === 0) return prefix;

  const merged = [...prefix];

  // Rule 2 — strip pboss's own default -A (the resolved route region only).
  const stripEnd = Math.max(0, Math.min(ctx.defaultAllEnd, merged.length));
  for (let i = 0; i < stripEnd; i++) {
    if (merged[i] === "-A" || merged[i] === "--allow-all") {
      merged.splice(i, 1);
      i--;
    }
  }

  // Rule 3 — survey what the user already stated (interpreter-args AND
  // node-args: every flag token before the script).
  const hasAll = merged.some((t) => t === "-A" || t === "--allow-all");
  const allowStemExists = merged.some((t) => /^--allow-[A-Za-z]/.test(t));
  const stems = new Set<string>();
  for (const token of merged) {
    // "--allow-x", "--allow-x=v", "--deny-x" — any stated scoping of the stem
    // counts; a bare non-flag token ("run") is position filler, not a grant.
    const m = token.match(/^--(allow|deny)-([A-Za-z][A-Za-z0-9]*)/);
    if (m) stems.add(`${m[1]!.toLowerCase()}-${m[2]!.toLowerCase()}`);
  }

  for (const flag of normalizeDenoPermissions(permissions)) {
    if (flag === "-A") {
      if (hasAll) continue; // already granted
      if (allowStemExists) continue; // would conflict — user's scoping wins
      merged.push(flag);
      continue;
    }
    const m = flag.match(/^--(allow|deny)-([A-Za-z][A-Za-z0-9]*)/)!;
    const stem = `${m[1]!.toLowerCase()}-${m[2]!.toLowerCase()}`;
    if (stems.has(stem)) continue; // already stated by the user — no duplicate
    if (hasAll && m[1]!.toLowerCase() === "allow") continue; // -A implies it
    merged.push(flag);
    stems.add(stem);
  }

  return merged;
}
