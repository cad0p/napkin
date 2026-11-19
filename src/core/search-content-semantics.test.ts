import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import {
  resetSearchIndexForTests,
  type SearchResult,
  searchVault,
} from "./search.js";

// Pins the content-scan semantics across #85 (note text read from disk per
// query instead of cached in memory/on disk).
//
// Every fixture note has the same mtime and no backlinks, and no query term
// appears in a basename, so the composite score reduces to exactly
// `contentOccurrences * CONTENT_TF_WEIGHT` (0.05), rounded to one decimal.
// The expected counts below were taken from the pre-#85 in-memory scan:
//   - multi-term: occurrences are summed over every term
//   - single char: split(term).length - 1 (non-overlapping, same as indexOf loop)
//   - case-mixed and Unicode: both sides go through JS toLowerCase, and the
//     em-dash/accents compare as whole characters, not folded bytes
const FIXTURE: Record<string, string> = {
  "n1.md": "alpha beta alpha beta beta", // 2 + 3 = 5
  "n2.md": "ALPHA beta", // 1 + 1 = 2
  "n3.md": "xxy x", // 3
  "n4.md": "xylophone", // 1
  "n5.md": "café CAFÉ café", // 3
  "n6.md": "Café", // 1
  "n7.md": "été Été", // 2
  "n8.md": "ÉTÉ été été", // 3
  "n9.md": "A—B a—b", // 2
  "n10.md": "a—b a—b a—b", // 3
};

const FIXED_MTIME = new Date("2024-01-01T00:00:00Z");

type PinnedResult = Pick<SearchResult, "file" | "score" | "links" | "snippets">;

function match(file: string, score: number, text: string): PinnedResult {
  return { file, score, links: 0, snippets: [{ line: 1, text }] };
}

let v: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  v = createTempVault(FIXTURE);
  // Identical mtimes zero out the recency term, leaving content TF alone.
  for (const file of Object.keys(FIXTURE)) {
    fs.utimesSync(path.join(v.vaultPath, file), FIXED_MTIME, FIXED_MTIME);
  }
});

afterEach(() => {
  v.cleanup();
  resetSearchIndexForTests();
});

/** Result fields that must be identical to the pre-#85 semantics. */
function pinned(query: string): PinnedResult[] {
  return searchVault(v.vaultPath, v.vaultPath, query).map((r) => ({
    file: r.file,
    score: r.score,
    links: r.links,
    snippets: r.snippets,
  }));
}

describe("content scan semantics", () => {
  test("multi-term counts sum every term occurrence", () => {
    expect(pinned("alpha beta")).toEqual([
      match("n1.md", 0.3, FIXTURE["n1.md"]),
      match("n2.md", 0.1, FIXTURE["n2.md"]),
    ]);
  });

  test("single-char terms use the same non-overlapping split count", () => {
    expect(pinned("x")).toEqual([
      match("n3.md", 0.2, FIXTURE["n3.md"]),
      match("n4.md", 0.1, FIXTURE["n4.md"]),
    ]);
  });

  test("case-mixed accented terms match case-insensitively", () => {
    expect(pinned("café")).toEqual([
      match("n5.md", 0.2, FIXTURE["n5.md"]),
      match("n6.md", 0.1, FIXTURE["n6.md"]),
    ]);
    expect(pinned("ÉTÉ")).toEqual([
      match("n8.md", 0.2, FIXTURE["n8.md"]),
      match("n7.md", 0.1, FIXTURE["n7.md"]),
    ]);
  });

  test("an em-dash is matched literally, not split or folded", () => {
    expect(pinned("a—b")).toEqual([
      match("n10.md", 0.2, FIXTURE["n10.md"]),
      match("n9.md", 0.1, FIXTURE["n9.md"]),
    ]);
  });

  test("a fresh process (disk cache hit) ranks the same as the warm scan", () => {
    const warm = pinned("alpha beta");
    expect(warm).toEqual([
      match("n1.md", 0.3, FIXTURE["n1.md"]),
      match("n2.md", 0.1, FIXTURE["n2.md"]),
    ]);

    // Only the disk cache survives; note text must be re-read from disk
    // without changing the result set, order, scores, or snippets.
    resetSearchIndexForTests();
    expect(pinned("alpha beta")).toEqual(warm);
  });
});
