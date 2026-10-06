/**
 * Deno's npm supply-chain window — the eligibility resolver every deno
 * install/upgrade surface goes through (deno-eligibility.ts).
 *
 * Empirically established against Deno 2.9.7 (the bisect that found it):
 *   - versions published < 24 h ago are NOT resolvable — `*` falls back to
 *     the previous version silently, exact pins error with "Could not find"
 *   - the rule is measured from the packument's `time` map against the
 *     machine's clock
 * The resolver adds a 1 h skew buffer (25 h total) and requires ≥ 1.6.0
 * (the first version exporting ./deno-entry).
 */

import { describe, test, expect } from "bun:test";
import {
  parseDenoEligibility,
  fetchDenoEligibility,
  denoEntrySpec,
  helpTextSupportsMinDepAge,
  DENO_ENTRY_MIN_VERSION,
  DENO_MIN_DEP_AGE_FLAG,
  DENO_SUPPLY_CHAIN_WINDOW_HOURS,
  DENO_WINDOW_BUFFER_HOURS,
  comparePlainVersions,
  type PackumentLike,
} from "../src/deno-eligibility";

/** h hours ago, as a packument timestamp. */
function ago(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

/** A packument with the given version→age map and dist-tags.latest. */
function doc(ages: Record<string, number>, latest?: string): PackumentLike {
  const time: Record<string, string> = {
    created: ago(10000),
    modified: ago(1),
  };
  for (const [v, h] of Object.entries(ages)) time[v] = ago(h);
  return {
    versions: Object.fromEntries(Object.keys(ages).map((v) => [v, {}])),
    time,
    "dist-tags": { latest: latest ?? Object.keys(ages).at(-1) ?? "1.0.0" },
  };
}

describe("deno-eligibility: parseDenoEligibility (pure)", () => {
  test("the constants pin the empirically verified window", () => {
    expect(DENO_SUPPLY_CHAIN_WINDOW_HOURS).toBe(24);
    expect(DENO_WINDOW_BUFFER_HOURS).toBe(1);
    expect(DENO_ENTRY_MIN_VERSION).toBe("1.6.0");
  });

  test("the owner's exact scenario: 1.6.0 published 16 h ago, 1.5.3 old", () => {
    const e = parseDenoEligibility(
      doc({ "1.5.3": 24 * 7, "1.6.0": 16 }, "1.6.0"),
    );
    // 1.6.0 is inside the (buffered) window and 1.5.3 predates deno-entry:
    // nothing is installable — the transition state.
    expect(e.best).toBeNull();
    expect(e.latest).toBe("1.6.0");
    expect(e.holdUntil).not.toBeNull();
  });

  test("1.6.0 aged past the window becomes best", () => {
    const e = parseDenoEligibility(
      doc({ "1.5.3": 24 * 7, "1.6.0": 26 }, "1.6.0"),
    );
    expect(e.best).toBe("1.6.0");
    expect(e.holdUntil).toBeNull();
  });

  test("25 h is the exact eligibility edge (24 h window + 1 h buffer)", () => {
    expect(parseDenoEligibility(doc({ "1.6.0": 24.9 })).best).toBeNull();
    expect(parseDenoEligibility(doc({ "1.6.0": 25.1 })).best).toBe("1.6.0");
  });

  test("max semver wins, not publish order (hotfix published before its base)", () => {
    const e = parseDenoEligibility(
      doc({ "1.6.0": 24 * 9, "1.6.1": 24 * 5, "1.6.2": 24 * 3 }, "1.6.2"),
    );
    expect(e.best).toBe("1.6.2");
  });

  test("a fresh release holds back to the previous version", () => {
    const e = parseDenoEligibility(
      doc({ "1.6.0": 24 * 9, "1.6.1": 2 }, "1.6.1"),
    );
    expect(e.best).toBe("1.6.0");
    expect(e.latest).toBe("1.6.1");
    expect(e.holdUntil).not.toBeNull();
  });

  test("versions before 1.6.0 never become best (no ./deno-entry export)", () => {
    const e = parseDenoEligibility(doc({ "1.5.9": 24 * 400, "1.5.3": 24 * 7 }));
    expect(e.best).toBeNull();
  });

  test("prereleases and non-version time keys are ignored", () => {
    const e = parseDenoEligibility({
      versions: { "1.6.0": {}, "1.7.0-beta.1": {} },
      time: {
        created: ago(400 * 24),
        modified: ago(1),
        "1.6.0": ago(24 * 30),
        "1.7.0-beta.1": ago(24 * 30), // old enough, but a prerelease
      },
      "dist-tags": { latest: "1.7.0-beta.1" },
    });
    expect(e.best).toBe("1.6.0");
    // latest is the prerelease tag — holdUntil is computed from its time,
    // which is long past → no hold.
    expect(e.holdUntil).toBeNull();
  });

  test("holdUntil is latest's publish + 25 h, ISO formatted", () => {
    const now = Date.now();
    const e = parseDenoEligibility(
      { versions: {}, time: { "1.6.0": new Date(now - 2 * 3_600_000).toISOString() }, "dist-tags": { latest: "1.6.0" } },
      now,
    );
    expect(e.holdUntil).toBe(
      new Date(now - 2 * 3_600_000 + 25 * 3_600_000).toISOString(),
    );
  });

  test("an empty/missing time map yields nothing installable", () => {
    expect(parseDenoEligibility({ versions: {} }).best).toBeNull();
    expect(parseDenoEligibility({}).best).toBeNull();
    expect(parseDenoEligibility({}).latest).toBeNull();
  });
});

describe("deno-eligibility: fetchDenoEligibility (injected fetcher)", () => {
  test("parses a served packument", async () => {
    const fetcher = (() =>
      Promise.resolve(
        new Response(JSON.stringify(doc({ "1.6.0": 24 * 9 }, "1.6.0")), {
          status: 200,
        }),
      )) as unknown as typeof fetch;
    const e = await fetchDenoEligibility(fetcher, "http://x/pboss");
    expect(e?.best).toBe("1.6.0");
  });

  test("non-OK and network failures return null (never throw)", async () => {
    const failing = (() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch;
    expect(await fetchDenoEligibility(failing, "http://x")).toBeNull();
    const throwing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchDenoEligibility(throwing, "http://x")).toBeNull();
  });
});

describe("deno-eligibility: helpers", () => {
  test("denoEntrySpec builds the pinned subpath form", () => {
    expect(denoEntrySpec("1.6.0")).toBe("npm:pboss@1.6.0/deno-entry");
  });

  test("comparePlainVersions: triple-digit semantics", () => {
    expect(comparePlainVersions("1.6.0", "1.6.0")).toBe(0);
    expect(comparePlainVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(comparePlainVersions("1.6.0", "1.5.99")).toBeGreaterThan(0);
    expect(comparePlainVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  test("DENO_MIN_DEP_AGE_FLAG: Deno's own escape hatch, value 0 (disables)", () => {
    // The SHORT spelling — what `deno install --help` itself prints (the
    // long form --minimum-dependency-age is equivalent); verified against
    // 2.9.7: `deno install -g -A --min-dep-age=0 --name pboss
    //  npm:pboss@1.6.1/deno-entry` installs a 6-minute-old release.
    expect(DENO_MIN_DEP_AGE_FLAG).toBe("--min-dep-age=0");
  });

  test("helpTextSupportsMinDepAge: either spelling, never a false positive", () => {
    // Real `deno install --help` (2.9.7) prints the SHORT alias:
    // "  --min-dep-age <VALUE>  (Unstable) The age in minutes …"
    expect(helpTextSupportsMinDepAge("  --min-dep-age <VALUE>  (Unstable) The age in minutes")).toBe(true);
    // Long spelling, if help ever switches to it.
    expect(helpTextSupportsMinDepAge("  --minimum-dependency-age <VALUE>  The age")).toBe(true);
    // Old deno (pre-2.9): neither spelling, no hold, no flag.
    expect(helpTextSupportsMinDepAge("Install a package or script globally\n  -A, --allow-all")).toBe(false);
    expect(helpTextSupportsMinDepAge("")).toBe(false);
  });
});
