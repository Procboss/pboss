import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { builtinModules } from "module";

/**
 * JSR publishability contract (Task 242, 2026-10-10).
 *
 * pboss publishes to jsr.io as @procboss/pboss — the source tree is the
 * package. These pins keep the tree publishable so `bun run
 * publish:jsr:dry` (or the CI dry-run job) can never be broken silently:
 *
 * - jsr.json identity + version stay in lockstep with package.json
 * - every export target exists and mirrors package.json's bun conditions
 * - every relative import in src/ carries an explicit .ts/.js/.json
 *   extension (JSR's resolver does no Node-style extension hunting)
 * - every bare import is a node builtin or an entry of jsr.json's import
 *   map — an unmapped npm dependency is an instant publish failure
 * - the import map's npm: ranges mirror package.json's dependencies
 * - constants.ts keeps the modern `with { type: "json" }` attribute —
 *   the legacy `assert` form parses under Bun but throws under Deno,
 *   the runtime a JSR source install actually runs on
 */

const REPO = join(dirname(import.meta.path), "..");
const jsr = JSON.parse(readFileSync(join(REPO, "jsr.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  publish: { include: string[]; exclude?: string[] };
  imports: Record<string, string>;
};
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};

const SRC = join(REPO, "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

interface SpecHit {
  file: string;
  line: number;
  spec: string;
}

const isCommentLine = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

function collectSpecifiers(): SpecHit[] {
  const hits: SpecHit[] = [];
  for (const file of walkTs(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i]!)) continue;
      for (const re of [
        /\bfrom\s*(["'])([^"'\n]+)\1/g, // import/export … from "spec"
        /\bimport\s+(["'])([^"'\n]+)\1/g, // side-effect import "spec"
        /\bimport\(\s*(["'])([^"'\n]+)\1\s*\)/g, // dynamic import("spec")
        /\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g, // require("spec")
      ]) {
        for (const m of lines[i]!.matchAll(re)) {
          hits.push({ file, line: i + 1, spec: m[2]! });
        }
      }
    }
  }
  return hits;
}

const KNOWN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|node|css|txt|wasm|svg)$/i;

describe("jsr.json: package identity and version lockstep", () => {
  test("the package is @procboss/pboss (owner spec: scope @procboss, name pboss)", () => {
    expect(jsr.name).toBe("@procboss/pboss");
  });

  test("version stays in sync with package.json — one logical version everywhere", () => {
    expect(jsr.version).toBe(pkg.version);
    expect(jsr.version).toMatch(/^\d+\.\d+\.\d+/); // semver, no leading v
  });

  test("publish scripts exist (bun run publish:jsr / publish:jsr:dry)", () => {
    expect(pkg.scripts["publish:jsr"]).toContain("jsr publish");
    expect(pkg.scripts["publish:jsr:dry"]).toContain("--dry-run");
  });
});

describe("jsr.json: exports mirror package.json and exist on disk", () => {
  test("the trio — api / cli / types — same targets as npm's bun conditions", () => {
    const npmDot = pkg.exports["."] as { bun: string };
    const npmCli = pkg.exports["./cli"] as { bun: string };
    expect(jsr.exports["."]).toBe(npmDot.bun);
    expect(jsr.exports["./cli"]).toBe(npmCli.bun);
    expect(jsr.exports["./types"]).toBe(pkg.exports["./types"] as string);
  });

  test("every export target resolves to a real file", () => {
    for (const target of Object.values(jsr.exports)) {
      expect(existsSync(join(REPO, target))).toBe(true);
    }
  });
});

describe("jsr.json: the publish set is complete", () => {
  test("src/**, package.json (the VERSION import), README and LICENSE are included", () => {
    // constants.ts imports ../package.json — excluding it is the classic
    // "excluded-module" publish failure (the graph reaches outside the set).
    for (const required of ["src/**", "package.json", "README.md", "LICENSE"]) {
      expect(jsr.publish.include).toContain(required);
    }
  });

  test("constants.ts pins the modern JSON import attribute (assert throws under Deno)", () => {
    const constants = readFileSync(join(SRC, "constants.ts"), "utf8");
    expect(constants).toContain('from "../package.json" with { type: "json" }');
    expect(constants).not.toContain("assert { type:");
  });
});

describe("src/: import hygiene for the JSR graph", () => {
  const hits = collectSpecifiers();

  test("every relative specifier carries an explicit file extension", () => {
    const bad = hits.filter(
      (h) => h.spec.startsWith(".") && !KNOWN_EXT.test(h.spec.split("?")[0]!.split("#")[0]!),
    );
    expect(
      bad.map((h) => `${h.file.replace(REPO + "/", "")}:${h.line} "${h.spec}"`),
    ).toEqual([]);
  });

  test("every bare specifier is a node builtin or a jsr.json import-map entry", () => {
    const bad = hits.filter((h) => {
      if (h.spec.startsWith(".") || h.spec.startsWith("node:")) return false;
      if (builtinModules.includes(h.spec)) return false;
      return !(h.spec in jsr.imports);
    });
    expect(
      bad.map((h) => `${h.file.replace(REPO + "/", "")}:${h.line} "${h.spec}"`),
    ).toEqual([]);
  });
});

describe("jsr.json: the import map mirrors package.json dependencies", () => {
  test("every npm: mapping names a real dependency with the exact same range", () => {
    for (const [alias, target] of Object.entries(jsr.imports)) {
      const m = /^npm:(.+?)@(.+)$/.exec(target);
      if (!m) throw new Error(`${alias}: not an npm: specifier (${target})`);
      const depName = m[1]!;
      const range = m[2]!;
      expect(pkg.dependencies[depName], `${alias}: ${depName} is not a package.json dependency`).toBeDefined();
      expect(pkg.dependencies[depName], `${alias}: range drift vs package.json`).toBe(range);
      expect(alias).toBe(depName); // the alias IS the bare specifier src/ imports
    }
  });
});
