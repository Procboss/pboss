import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const REPO = join(dirname(import.meta.path), "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

/**
 * The package manifest is install surface: the wrapper, the installers, and
 * every package manager consume it verbatim. These pins keep it a shape the
 * machinery can rely on.
 *
 * The self-dependency guard is not cosmetic: a package that depends on its
 * own name forces every resolver to dedupe a self-cycle — npm tolerates it,
 * but a future Bun (or any stricter resolver) may refuse, and the failure
 * lands on users at install time, far from the manifest that caused it.
 * (1.5.3 and 1.6.0 shipped with `"pboss": "^1.5.2"` in dependencies — this
 * test makes sure that never happens again.)
 */
describe("package manifest: the shape the installers rely on", () => {
  test("no self-dependency — a package must never depend on itself", () => {
    expect(pkg.dependencies?.pboss).toBeUndefined();
    expect(pkg.devDependencies?.pboss).toBeUndefined();
    expect(pkg.optionalDependencies?.pboss).toBeUndefined();
    expect(pkg.peerDependencies?.pboss).toBeUndefined();
  });

  test("every declared bin target actually exists in the repo", () => {
    const bins = (pkg.bin ?? {}) as Record<string, string>;
    expect(Object.keys(bins).length).toBeGreaterThan(0);
    for (const target of Object.values(bins)) {
      expect(existsSync(join(REPO, target))).toBe(true);
    }
  });

  test("the bin directory ships in the published files", () => {
    expect((pkg.files as string[] | undefined)?.some((f) => f === "bin/" || f === "bin")).toBe(true);
  });
});
