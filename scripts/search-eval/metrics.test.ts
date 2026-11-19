import { describe, expect, test } from "vitest";
import {
  identityDiffs,
  jaccardAtK,
  kendallTau,
  mean,
  median,
  percentile,
  rbo,
  recall,
  recallAtK,
  round,
} from "./metrics.js";

// Hand-computed expectations only: every number below is derivable from the
// definitions in the module docstring, not from running the implementation.

describe("recall", () => {
  test("counts baseline files found anywhere in the candidate", () => {
    expect(recall(["a.md", "b.md", "c.md"], ["c.md", "x.md"])).toBeCloseTo(
      1 / 3,
      12,
    );
    expect(recall(["a.md"], ["a.md"])).toBe(1);
  });

  test("an empty baseline recalls everything; an empty candidate nothing", () => {
    expect(recall([], [])).toBe(1);
    expect(recall([], ["a.md"])).toBe(1);
    expect(recall(["a.md"], [])).toBe(0);
  });
});

describe("recallAtK", () => {
  test("restricts both lists to the first k", () => {
    // top-1 differs, the whole list is identical.
    expect(recallAtK(["a", "b"], ["b", "a"], 1)).toBe(0);
    expect(recallAtK(["a", "b"], ["b", "a"], 2)).toBe(1);
  });

  test("a baseline shorter than k uses what exists", () => {
    expect(recallAtK(["a"], ["a", "b", "c"], 10)).toBe(1);
  });
});

describe("jaccardAtK", () => {
  test("is intersection over union", () => {
    expect(jaccardAtK(["a", "b"], ["b", "c"], 10)).toBeCloseTo(1 / 3, 12);
    expect(jaccardAtK(["a", "b"], ["b", "a"], 10)).toBe(1);
    expect(jaccardAtK(["a"], ["b"], 10)).toBe(0);
  });

  test("two empty sets are identical", () => {
    expect(jaccardAtK([], [], 10)).toBe(1);
  });
});

describe("rbo", () => {
  test("identical lists are 1, disjoint lists are 0", () => {
    expect(rbo(["a", "b", "c"], ["a", "b", "c"])).toBeCloseTo(1, 12);
    expect(rbo(["a"], ["b"])).toBe(0);
    expect(rbo([], [])).toBe(1);
    expect(rbo(["a"], [])).toBe(0);
  });

  test("a top-2 swap costs less than a full reversal at p=0.9", () => {
    // A = [a,b,c], B = [b,a,c], p = 0.9:
    //   d=1 overlap 0, d=2 overlap 2, d=3 overlap 3
    //   (1-p) * (0.9*2/2 + 0.81*3/3) + 0.9^3 * 3/3 = 0.171 + 0.729 = 0.9
    expect(rbo(["a", "b", "c"], ["b", "a", "c"])).toBeCloseTo(0.9, 12);
    // Reversal B = [c,b,a]: prefix overlaps are 0 at d=1, 1/2 at d=2
    // (only b is shared) and 3/3 at d=3 ->
    //   (1-p) * (0.9 * 1/2 + 0.81 * 1) + 0.9^3 * 1 = 0.126 + 0.729 = 0.855
    const reversed = rbo(["a", "b", "c"], ["c", "b", "a"]);
    expect(reversed).toBeCloseTo(0.855, 12);
    expect(reversed).toBeLessThan(0.9);
  });
});

describe("kendallTau", () => {
  test("identical order is 1, reversed is -1", () => {
    expect(kendallTau(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(kendallTau(["a", "b", "c"], ["c", "b", "a"])).toBe(-1);
  });

  test("is computed on the intersection only", () => {
    // a-order x,y,z; b-order y,z,x -> pairs (x,y) and (x,z) discordant,
    // (y,z) concordant -> (1 - 2) / 3.
    expect(kendallTau(["x", "y", "z"], ["y", "z", "x"])).toBeCloseTo(
      -1 / 3,
      12,
    );
    // "d" only exists in one list and must not count.
    expect(kendallTau(["x", "y", "z", "d"], ["y", "z", "x"])).toBeCloseTo(
      -1 / 3,
      12,
    );
  });

  test("is null when fewer than two files are shared", () => {
    expect(kendallTau(["a"], ["a"])).toBeNull();
    expect(kendallTau(["a", "b"], ["c", "d"])).toBeNull();
  });
});

describe("identityDiffs", () => {
  const base = [
    { file: "a.md", score: 10 },
    { file: "b.md", score: 5 },
  ];

  test("identical lists have no diffs", () => {
    expect(identityDiffs(base, structuredClone(base), 1e-9)).toEqual([]);
  });

  test("score differences within epsilon are accepted", () => {
    const candidate = [
      { file: "a.md", score: 10 + 1e-12 },
      { file: "b.md", score: 5 },
    ];
    expect(identityDiffs(base, candidate, 1e-9)).toEqual([]);
    expect(identityDiffs(base, candidate, 1e-15)).toHaveLength(1);
  });

  test("a different file at the same index is reported", () => {
    const candidate = [
      { file: "b.md", score: 10 },
      { file: "a.md", score: 5 },
    ];
    const diffs = identityDiffs(base, candidate, 1e-9);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ index: 0, kind: "file" });
    expect(diffs[0].baseline).toBe("a.md (10)");
    expect(diffs[0].candidate).toBe("b.md (10)");
  });

  test("a length change is one diff at the first missing index", () => {
    const diffs = identityDiffs(base, [base[0]], 1e-9);
    expect(diffs).toEqual([
      { index: 1, kind: "length", baseline: "2", candidate: "1" },
    ]);
  });
});

describe("aggregates", () => {
  test("percentile is nearest-rank", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 95)).toBe(4);
    expect(percentile([7], 100)).toBe(7);
  });

  test("median averages the middle pair; mean is arithmetic", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });

  test("round keeps report numbers stable", () => {
    expect(round(1.23456)).toBe(1.2346);
    expect(round(1.23456, 2)).toBe(1.23);
  });
});
