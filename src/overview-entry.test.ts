import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildVaultOverview } from "./overview-entry.js";
import { Napkin } from "./sdk.js";
import {
  createTempVault,
  dropOverviewStoreFiles,
  resetOverviewIndexForTests,
} from "./utils/test-helpers.js";

/**
 * The slim `@cad0p/napkin/overview` entry (#123): a forked process that
 * only builds the vault overview must not load the search, bases, canvas,
 * tasks, templates, or links modules — nor gray-matter or minisearch
 * statically. The scan mirrors package-exports.test.ts (#121): walk the
 * static (and dynamic) import graph of src/overview-entry.ts and assert on
 * the reachable set.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/**
 * Relative and package imports of a TS source file (static and dynamic).
 * `import type`/`export type` statements are erased at compile time and
 * count as nothing; so are `import("…")` types inside type positions
 * (matched heuristically: preceded by `typeof`, `=`, `:`, or `<`).
 */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const specs = new Set<string>();
  const stmtRe =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(stmtRe)) {
    if (m[1] === undefined) specs.add(m[2] as string);
  }
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(dynRe)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
    if (/typeof\s*$|=\s*$|:\s*$|<\s*$/.test(before)) continue;
    specs.add(m[1] as string);
  }
  return [...specs];
}

/**
 * Every module reachable from `entry`: node builtins, bare package
 * specifiers, and src-relative paths.
 */
function graph(entry: string): {
  builtins: string[];
  packages: string[];
  files: string[];
} {
  const builtins = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith("node:")) {
        builtins.add(spec);
      } else if (spec.startsWith(".")) {
        todo.push(
          path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")),
        );
      } else {
        packages.add(spec);
      }
    }
  }
  return {
    builtins: [...builtins].sort(),
    packages: [...packages].sort(),
    files: [...seen].map((f) => path.relative(SRC, f)).sort(),
  };
}

const ENTRY = path.join(SRC, "overview-entry.ts");

/**
 * Modules the overview never uses and the slim entry must not reach.
 * Prefixes: every match is a relative src path (or src dir) start.
 */
const FORBIDDEN = [
  "core/search",
  "core/bases",
  "core/canvas",
  "core/tasks",
  "core/templates",
  "core/links",
  "templates/",
  "utils/sqlite-store",
  "utils/json-store",
  "utils/name-search",
  "utils/search-cache",
];

describe("@cad0p/napkin/overview entry (#123)", () => {
  test("import graph reaches no search/tasks/bases/canvas/links/store module", () => {
    const g = graph(ENTRY);
    const hits = g.files.filter((f) =>
      FORBIDDEN.some((p) => f === p || f.startsWith(p)),
    );
    expect(hits).toEqual([]);
    for (const b of g.builtins) expect(b).toMatch(/^node:/);
  });

  test("import graph has no static gray-matter or minisearch import", () => {
    const g = graph(ENTRY);
    expect(g.packages).not.toContain("gray-matter");
    expect(g.packages).not.toContain("minisearch");
  });

  test("buildVaultOverview equals Napkin#overview on miss and hit paths", () => {
    const vault = createTempVault({
      "Architecture.md":
        "---\ntitle: Architecture\ntags: [design, infra]\n---\n" +
        "# Architecture\n\nThe search index stores terms per folder.\n",
      "Inbox/Note.md":
        "---\nstatus: draft\n---\n# Note\n\nA body with a [[Architecture|link]].\n",
      "Inbox/Daily/2026-01-01.md": "# 2026-01-01\n\n- [ ] review\n",
      "plain.md": "# Plain\n\nNo frontmatter here.\n",
    });
    try {
      const cwd = vault.path;

      // Miss path: a fresh vault computes through the entry…
      const entryMiss = buildVaultOverview(cwd);
      // …and the hit path answers from the result cache.
      const entryHit = buildVaultOverview(cwd);
      expect(entryHit).toEqual(entryMiss);

      // The SDK computes the same result on a cold run (caches dropped, so
      // nothing is served from what the entry wrote).
      dropOverviewStoreFiles(vault.vaultPath);
      resetOverviewIndexForTests();
      const sdkMiss = new Napkin(cwd).overview();
      expect(sdkMiss).toEqual(entryMiss);
      const sdkHit = new Napkin(cwd).overview();
      expect(sdkHit).toEqual(entryMiss);
    } finally {
      vault.cleanup();
    }
  });

  test("package.json maps ./overview to the shipped entry module", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.exports["./overview"]).toEqual({
      types: "./dist/overview-entry.d.ts",
      import: "./dist/overview-entry.js",
      default: "./dist/overview-entry.js",
    });
  });
});
