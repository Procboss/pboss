/**
 * ProcBoss (pboss) — Deno's npm supply-chain window, made explicit.
 *
 * Deno REFUSES to resolve npm package versions published within the last
 * 24 hours. Not just for ranges (`npm:pboss` silently resolves to the
 * PREVIOUS version) but even for exact pins — `deno install -g
 * npm:pboss@1.6.0/deno-entry` answers "Could not find npm package 'pboss'
 * matching '1.6.0'" while 1.6.0 sits on the registry as `latest`. The rule
 * is measured from the packument's `time` map against the machine's clock
 * (verified empirically against Deno 2.9.7: age 20 h → excluded, age 24 h →
 * resolvable).
 *
 * Consequence for pboss: right after we publish, every unpinned deno
 * install lands on YESTERDAY's version — and before 1.6.0 that meant a
 * broken shim (`./deno-entry` did not exist), the owner's exact
 * "Failed resolving binary export" report. Every deno install/upgrade
 * surface therefore resolves the NEWEST version Deno will actually accept
 * and PINS the spec to it, instead of guessing:
 *
 *   best = max semver of { v : time[v] is ≥ 25 h old  AND  v ≥ 1.6.0 }
 *
 *   25 h = Deno's 24 h window + a 1 h clock-skew buffer (the comparison
 *   runs on the user's machine; a slow clock must not make the pin
 *   unresolvable again).
 *   1.6.0 = the first version whose exports map defines ./deno-entry.
 *
 * When best is null — only possible during the one-time transition where
 * the previous deno-resolvable version predates deno support — installers
 * fall back to npm as the DELIVERY vehicle (the bin wrapper dispatches to
 * deno at run time; the runtime selection stays deno) and say exactly
 * that. `pboss upgrade` instead reports the hold and the time the newest
 * release becomes resolvable.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

/** Deno's supply-chain protection window (hours), measured from publish. */
export const DENO_SUPPLY_CHAIN_WINDOW_HOURS = 24;

/** Buffer on top of the window (hours) absorbing user-clock skew. */
export const DENO_WINDOW_BUFFER_HOURS = 1;

/** The first pboss version whose exports map defines ./deno-entry. */
export const DENO_ENTRY_MIN_VERSION = "1.6.0";

/** The full packument is required — the `time` map is not in /latest. */
export const PBOSS_PACKUMENT_URL = "https://registry.npmjs.org/pboss";

/** What every deno install/upgrade surface needs to know about the window. */
export interface DenoEligibility {
  /** Newest version Deno can resolve that exports ./deno-entry (null: none). */
  best: string | null;
  /** The registry's dist-tags.latest (may sit inside the window). */
  latest: string | null;
  /**
   * ISO instant when `latest` becomes Deno-resolvable including the buffer
   * (null: latest is already resolvable, or is unknown).
   */
  holdUntil: string | null;
}

/** The packument subset parseDenoEligibility reads (the real shape). */
export interface PackumentLike {
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
  "dist-tags"?: Record<string, string>;
}

/** Semver-ish compare: positive when a > b, 0 when equal, negative when a < b. */
export function comparePlainVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/, "").split(".");
  const pb = String(b).replace(/^v/, "").split(".");
  for (let i = 0; i < 3; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Pure decision half: the newest deno-resolvable, deno-entry-capable
 * version of a packument, plus the hold status of dist-tags.latest.
 * `now` is injectable so the window math is unit-testable.
 */
export function parseDenoEligibility(doc: PackumentLike, now: number = Date.now()): DenoEligibility {
  const times = doc.time ?? {};
  // 25 h in ms — the window plus the skew buffer.
  const cutoff = now - (DENO_SUPPLY_CHAIN_WINDOW_HOURS + DENO_WINDOW_BUFFER_HOURS) * 3_600_000;

  let best: string | null = null;
  for (const [version, stamp] of Object.entries(times)) {
    // Skip the packument's non-version keys ("created", "modified", tags)
    // and any prerelease — plain x.y.z only, matching what Deno resolves
    // for a bare specifier.
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const published = Date.parse(stamp);
    if (Number.isNaN(published)) continue;
    if (published > cutoff) continue; // inside the (buffered) window
    if (comparePlainVersions(version, DENO_ENTRY_MIN_VERSION) < 0) continue; // no ./deno-entry
    if (best === null || comparePlainVersions(version, best) > 0) best = version;
  }

  const latest = doc["dist-tags"]?.latest ?? null;
  let holdUntil: string | null = null;
  if (latest && times[latest]) {
    const published = Date.parse(times[latest]!);
    if (!Number.isNaN(published)) {
      const until = published + (DENO_SUPPLY_CHAIN_WINDOW_HOURS + DENO_WINDOW_BUFFER_HOURS) * 3_600_000;
      if (until > now) holdUntil = new Date(until).toISOString();
    }
  }

  return { best, latest, holdUntil };
}

/**
 * Live half: read the pboss packument and parse it. Returns null when the
 * registry cannot be reached in time — callers degrade to the unpinned
 * spec and let Deno's own resolution decide (the pre-1.6.0 breakage is
 * impossible once 1.6.0 is outside the window, so the fallback is safe).
 * `fetcher` is injectable for tests.
 */
export async function fetchDenoEligibility(
  fetcher: typeof fetch = fetch,
  url: string = PBOSS_PACKUMENT_URL,
): Promise<DenoEligibility | null> {
  try {
    const res = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as PackumentLike;
    return parseDenoEligibility(doc);
  } catch {
    return null;
  }
}

/** The pinned deno spec installers and upgrades use for a version. */
export function denoEntrySpec(version: string): string {
  return `npm:pboss@${version}/deno-entry`;
}
