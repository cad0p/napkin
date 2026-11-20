import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Package entry points (#121). `./vault` lets a consumer resolve a vault
 * without loading the SDK graph, and the `default` condition lets
 * `require()` (Node's require(esm)) resolve both entries by package name.
 * pi-napkin relies on both: pi loads extensions through jiti, so the SDK is
 * loaded on first use through createRequire instead of a static import.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** Relative and package imports of a TS source file (static and dynamic). */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const specs = new Set<string>();
  const re =
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) specs.add((m[1] ?? m[2]) as string);
  return [...specs];
}

/** Every module reachable from `entry`: node builtins and src-relative paths. */
function graph(entry: string): { builtins: string[]; files: string[] } {
  const builtins = new Set<string>();
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
        throw new Error(`${path.relative(SRC, file)} imports package ${spec}`);
      }
    }
  }
  return {
    builtins: [...builtins].sort(),
    files: [...seen].map((f) => path.relative(SRC, f)).sort(),
  };
}

describe("package exports (#121)", () => {
  test("./vault reaches only node builtins and exit-codes", () => {
    const g = graph(path.join(SRC, "utils", "vault.ts"));
    expect(g.files).toEqual(["utils/exit-codes.ts", "utils/vault.ts"]);
    for (const b of g.builtins) expect(b).toMatch(/^node:/);
  });

  test("package.json maps ./vault to the shipped vault module", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.exports["./vault"]).toEqual({
      types: "./dist/utils/vault.d.ts",
      import: "./dist/utils/vault.js",
      default: "./dist/utils/vault.js",
    });
    expect(pkg.exports["."].default).toBe(pkg.exports["."].import);
  });

  // Resolves through the package's own name (self-reference), so it runs
  // against dist/. CI builds dist in `pnpm install` (prepare).
  test.runIf(fs.existsSync(path.join(ROOT, "dist", "index.js")))(
    "require() and import() resolve both entries to the same exports",
    () => {
      const script = `
        import { createRequire } from "node:module";
        const req = createRequire(${JSON.stringify(path.join(ROOT, "package.json"))});
        const out = {};
        for (const spec of [
          "@cad0p/napkin",
          "@cad0p/napkin/vault",
          "@cad0p/napkin/overview",
        ]) {
          const viaRequire = req(spec);
          const viaImport = await import(spec);
          out[spec] = {
            keys: Object.keys(viaRequire).sort(),
            same: Object.keys(viaImport).every((k) => viaImport[k] === viaRequire[k]),
          };
        }
        process.stdout.write(JSON.stringify(out));
      `;
      const out = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: ROOT,
          encoding: "utf-8",
        }),
      );
      expect(out["@cad0p/napkin"].keys).toContain("Napkin");
      expect(out["@cad0p/napkin"].same).toBe(true);
      expect(out["@cad0p/napkin/vault"].keys).toEqual(
        expect.arrayContaining([
          "NAPKIN_MARKER",
          "VaultNotFoundError",
          "findVault",
        ]),
      );
      expect(out["@cad0p/napkin/vault"].same).toBe(true);
      expect(out["@cad0p/napkin/overview"].keys).toEqual(
        expect.arrayContaining(["buildVaultOverview"]),
      );
      expect(out["@cad0p/napkin/overview"].same).toBe(true);
    },
    20_000,
  );
});
