/**
 * Pure metric functions for the search eval harness (#90).
 *
 * Every function here takes ranked file lists (best first) and returns a
 * number, so the harness's comparisons are testable without a vault. The
 * definitions deliberately mirror the idioms used in IR tooling:
 *
 *  - recall: fraction of the baseline result set still present in the
 *    candidate result set (any rank). An empty baseline is 1 by definition —
 *    "all of nothing was recalled" — so queries with no hits do not dilute
 *    an aggregate.
 *  - recall@k: the same, restricted to both lists' first k entries.
 *  - jaccard@k: |A∩B| / |A∪B| over the first k of each list.
 *  - rbo: rank-biased overlap (Webber, Moffat & Zobel 2010) with
 *    persistence p; top ranks dominate. Uses the extrapolated form for
 *    length-limited lists, evaluated at depth k = min(|A|, |B|):
 *      (1-p) * Σ_{d=1..k} p^(d-1) * |A_1:d ∩ B_1:d| / d  +  p^k * A_k
 *  - kendallTau: tau-a on the intersection, using positions in the two
 *    lists (no score ties — position is the rank). null when fewer than two
 *    files are shared.
 *
 * Scores are compared with an epsilon because callers compare rounded
 * numbers; identity also requires the same file at the same index.
 */

export interface RankedResult {
  /** Vault-relative path. */
  file: string;
  score: number;
}

/** Fraction of `baseline` found anywhere in `candidate`. Empty baseline = 1. */
export function recall(baseline: string[], candidate: string[]): number {
  if (baseline.length === 0) return 1;
  const found = new Set(candidate);
  let hits = 0;
  for (const file of baseline) {
    if (found.has(file)) hits++;
  }
  return hits / baseline.length;
}

/** Fraction of the baseline top-k found in the candidate top-k. */
export function recallAtK(
  baseline: string[],
  candidate: string[],
  k = 10,
): number {
  return recall(baseline.slice(0, k), candidate.slice(0, k));
}

/** Jaccard similarity of the two top-k sets. Two empty sets are identical. */
export function jaccardAtK(
  baseline: string[],
  candidate: string[],
  k = 10,
): number {
  const a = new Set(baseline.slice(0, k));
  const b = new Set(candidate.slice(0, k));
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const file of a) {
    if (b.has(file)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Rank-biased overlap at persistence `p` (0.9 = top ranks dominate). */
export function rbo(baseline: string[], candidate: string[], p = 0.9): number {
  if (baseline.length === 0 && candidate.length === 0) return 1;
  if (baseline.length === 0 || candidate.length === 0) return 0;

  const depth = Math.min(baseline.length, candidate.length);
  const seenBaseline = new Set<string>();
  const seenCandidate = new Set<string>();
  let overlap = 0;
  let sum = 0;
  for (let d = 1; d <= depth; d++) {
    if (!seenBaseline.has(baseline[d - 1])) {
      seenBaseline.add(baseline[d - 1]);
      if (seenCandidate.has(baseline[d - 1])) overlap++;
    }
    if (!seenCandidate.has(candidate[d - 1])) {
      seenCandidate.add(candidate[d - 1]);
      if (seenBaseline.has(candidate[d - 1])) overlap++;
    }
    sum += p ** (d - 1) * (overlap / d);
  }
  // Extrapolated residual: what the depth-limited prefix still implies about
  // the unseen tail of the shorter list.
  const residual = p ** depth * (overlap / depth);
  return (1 - p) * sum + residual;
}

/**
 * Kendall tau-a on the shared files, ordered by their position in
 * `baseline`. null when the lists share fewer than two files.
 */
export function kendallTau(
  baseline: string[],
  candidate: string[],
): number | null {
  const candidateRank = new Map<string, number>();
  for (let i = 0; i < candidate.length; i++) {
    if (!candidateRank.has(candidate[i])) candidateRank.set(candidate[i], i);
  }
  const shared: Array<{ baseline: number; candidate: number }> = [];
  for (let i = 0; i < baseline.length; i++) {
    const rank = candidateRank.get(baseline[i]);
    if (rank !== undefined) shared.push({ baseline: i, candidate: rank });
  }
  const n = shared.length;
  if (n < 2) return null;

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = shared[j].candidate - shared[i].candidate;
      if (delta > 0) concordant++;
      else if (delta < 0) discordant++;
    }
  }
  return (concordant - discordant) / ((n * (n - 1)) / 2);
}

export type IdentityDiffKind = "length" | "file" | "score";

/** One way the candidate result list differs from the baseline at an index. */
export interface IdentityDiff {
  index: number;
  kind: IdentityDiffKind;
  baseline: string | null;
  candidate: string | null;
}

/**
 * Structural equality of two ranked lists: same files, same order, scores
 * within `epsilon`. Length differences collapse into a single diff at the
 * first missing index (the caller already knows both lengths).
 */
export function identityDiffs(
  baseline: RankedResult[],
  candidate: RankedResult[],
  epsilon: number,
): IdentityDiff[] {
  const diffs: IdentityDiff[] = [];
  const shared = Math.min(baseline.length, candidate.length);
  for (let i = 0; i < shared; i++) {
    const b = baseline[i];
    const c = candidate[i];
    if (b.file !== c.file) {
      diffs.push({
        index: i,
        kind: "file",
        baseline: `${b.file} (${b.score})`,
        candidate: `${c.file} (${c.score})`,
      });
      continue;
    }
    if (Math.abs(b.score - c.score) > epsilon) {
      diffs.push({
        index: i,
        kind: "score",
        baseline: `${b.file} (${b.score})`,
        candidate: `${c.file} (${c.score})`,
      });
    }
  }
  if (baseline.length !== candidate.length) {
    diffs.push({
      index: shared,
      kind: "length",
      baseline: String(baseline.length),
      candidate: String(candidate.length),
    });
  }
  return diffs;
}

/** Nearest-rank percentile of `values` (0-100). Empty input returns 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/** Arithmetic mean. Empty input returns 0. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Median, averaging the two middle values for even counts. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Round for stable report output (keeps JSON/table diffs readable). */
export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
