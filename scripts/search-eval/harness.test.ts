import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetSearchIndexForTests } from "../../src/core/search.js";
import { Napkin } from "../../src/index.js";
import {
  compareIdentity,
  compareRanking,
  dropSearchCache,
  readQueries,
  recordRun,
  sampleQueries,
  summariseRanking,
  vaultFingerprint,
  worstQueries,
} from "./harness.js";

// The committed fixture vault (scripts/fixtures/search-eval) is synthetic: a
// handful of notes with overlapping vocabulary plus a query set that yields
// multi-hit, single-hit and empty result lists. Tests copy it to a temp dir so
// a run's caches never touch the checkout.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDir = path.join(repoRoot, "scripts/fixtures/search-eval");
const fixtureVault = path.join(fixtureDir, "vault");
const fixtureQueries = path.join(fixtureDir, "queries.txt");

let dir: string;
let vault: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-search-eval-"));
  vault = path.join(dir, "vault");
  fs.cpSync(fixtureVault, vault, { recursive: true });
  resetSearchIndexForTests();
});

afterEach(() => {
  resetSearchIndexForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A search function through the public SDK, like the harness CLI uses. */
function sdkSearch(limit = 10) {
  const napkin = new Napkin(vault);
  return (query: string) =>
    napkin
      .search(query, { limit, snippets: false })
      .map((hit) => ({ file: hit.file, score: hit.score }));
}

describe("record / identity on the fixture vault", () => {
  test("cold and warm runs produce the same ranked lists", () => {
    const queries = readQueries(fixtureQueries);
    expect(queries.length).toBeGreaterThan(5);

    // Cold: nothing cached, in-memory index dropped between runs so this
    // mirrors two separate processes.
    const cold = recordRun(sdkSearch(), queries);
    resetSearchIndexForTests();
    dropSearchCache(new Napkin(vault));
    const colder = recordRun(sdkSearch(), queries);
    expect(compareIdentity(cold.queries, colder.queries, 1e-9)).toEqual([]);

    // Warm: second run loads the on-disk cache written by the first.
    resetSearchIndexForTests();
    const warm = recordRun(sdkSearch(), queries);
    expect(compareIdentity(cold.queries, warm.queries, 1e-9)).toEqual([]);

    // The fixture is worth comparing: multi-hit and empty result lists.
    expect(cold.queries.some((q) => q.results.length > 1)).toBe(true);
    expect(cold.queries.some((q) => q.results.length === 0)).toBe(true);
    expect(cold.latency.p50Ms).toBeGreaterThanOrEqual(0);
  });

  test("a changed vault changes the fingerprint", () => {
    const before = vaultFingerprint(new Napkin(vault));
    fs.appendFileSync(path.join(vault, "notes/gamma.md"), "\nnew line\n");
    const after = vaultFingerprint(new Napkin(vault));
    expect(after.fileCount).toBe(before.fileCount);
    expect(after.digest).not.toBe(before.digest);
  });
});

describe("perturbed results are reported", () => {
  function baseline() {
    const queries = readQueries(fixtureQueries);
    const run = recordRun(sdkSearch(), queries);
    const index = run.queries.findIndex((q) => q.results.length >= 2);
    expect(index).toBeGreaterThanOrEqual(0);
    return { run, target: run.queries[index] };
  }

  test("identity mode flags a reordered list", () => {
    const { run, target } = baseline();
    const perturbed = run.queries.map((q) =>
      q.query === target.query
        ? { ...q, results: [...q.results].reverse() }
        : q,
    );
    const diffs = compareIdentity(run.queries, perturbed, 1e-9);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].query).toBe(target.query);
    expect(diffs[0].diffs[0].kind).toBe("file");
  });

  test("identity mode flags a changed score", () => {
    const { run, target } = baseline();
    const perturbed = run.queries.map((q) =>
      q.query === target.query
        ? {
            ...q,
            results: q.results.map((hit, i) =>
              i === 0 ? { ...hit, score: hit.score + 0.1 } : hit,
            ),
          }
        : q,
    );
    const diffs = compareIdentity(run.queries, perturbed, 1e-9);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].diffs[0].kind).toBe("score");
  });

  test("ranking mode reports lost recall and lower RBO", () => {
    const { run, target } = baseline();

    // Reordering keeps every file: recall stays 1, rank quality drops.
    const reordered = run.queries.map((q) =>
      q.query === target.query
        ? { ...q, results: [...q.results].reverse() }
        : q,
    );
    const reorderedMetrics = compareRanking(run.queries, reordered);
    const reorderedTarget = reorderedMetrics.find(
      (q) => q.query === target.query,
    );
    expect(reorderedTarget?.recall).toBe(1);
    expect(reorderedTarget?.recallAt10).toBe(1);
    expect(reorderedTarget?.rbo).toBeLessThan(1);
    expect(reorderedTarget?.jaccardAt10).toBe(1);
    expect(reorderedTarget?.kendallTau).toBeLessThan(0);

    // Dropping the top hit loses recall@10 and lands in the worst list.
    const droppedFile = target.results[0].file;
    const dropped = run.queries.map((q) =>
      q.query === target.query ? { ...q, results: q.results.slice(1) } : q,
    );
    const droppedMetrics = compareRanking(run.queries, dropped);
    const droppedTarget = droppedMetrics.find((q) => q.query === target.query);
    expect(droppedTarget?.recall).toBeLessThan(1);
    expect(droppedTarget?.recallAt10).toBeLessThan(1);
    expect(droppedTarget?.missingAt10).toContain(droppedFile);
    expect(worstQueries(droppedMetrics, 1)[0].query).toBe(target.query);

    const summary = summariseRanking(droppedMetrics);
    expect(summary.recallAt10.mean).toBeLessThan(1);
    expect(summary.recall.mean).toBeLessThan(1);
  });
});

describe("query sampling", () => {
  test("is seeded and order-preserving", () => {
    const queries = ["a", "b", "c", "d", "e", "f"];
    const first = sampleQueries(queries, 3, 90);
    expect(first).toEqual(sampleQueries(queries, 3, 90));
    expect(first).toHaveLength(3);
    expect(first).toEqual([...first].sort());
    expect(new Set(first).size).toBe(3);
    // n >= length returns the whole set, unchanged.
    expect(sampleQueries(queries, 6, 90)).toEqual(queries);
    expect(sampleQueries(queries, 99, 90)).toEqual(queries);
  });
});

describe("CLI", () => {
  const cli = path.join(repoRoot, "scripts/search-eval/cli.ts");

  function run(args: string[]): { status: number; output: string } {
    try {
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", cli, ...args],
        { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" },
      );
      return { status: 0, output };
    } catch (error) {
      const failure = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        status: failure.status ?? -1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  test(
    "record → identity compare passes, a perturbed baseline exits 1",
    () => {
      const baselinePath = path.join(dir, "baseline.json");

      const record = run([
        "--vault",
        vault,
        "--queries",
        fixtureQueries,
        "--record",
        baselinePath,
      ]);
      expect(record.status).toBe(0);
      expect(record.output).toContain("recorded");
      expect(fs.existsSync(baselinePath)).toBe(true);

      const identical = run(["--vault", vault, "--compare", baselinePath]);
      expect(identical.status).toBe(0);
      expect(identical.output).toContain("identical");

      // Perturb the recorded baseline, then re-run the gate.
      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as {
        queries: Array<{ results: Array<{ file: string; score: number }> }>;
      };
      const target = baseline.queries.find((q) => q.results.length >= 2);
      expect(target).toBeDefined();
      if (!target) return;
      [target.results[0], target.results[1]] = [
        target.results[1],
        target.results[0],
      ];
      fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

      const changed = run(["--vault", vault, "--compare", baselinePath]);
      expect(changed.status).toBe(1);
      expect(changed.output).toContain("differing queries");
    },
    { timeout: 60_000 },
  );
});
