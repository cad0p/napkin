/**
 * Basename ranking served from SQL postings (#109).
 *
 * Before #109 the basename ranking was a MiniSearch index (BM25, prefix,
 * fuzzy 0.2, field boost 2) held in every process's heap. MiniSearch's score
 * is a pure function of the term postings, the document's field length, the
 * document count and the mean field length, so this module reproduces it
 * from rows the store keeps instead of approximating it:
 *
 *  - tokenizing, lowercasing and the field length (unique RAW tokens, as
 *    MiniSearch counts them) match MiniSearch's defaults;
 *  - per query term: exact (weight 1), prefix (0.375 * len / (len + 0.3 *
 *    dist)) and fuzzy (0.45 * len / (len + dist), Levenshtein <= min(6,
 *    round(0.2 * len)), prefix terms excluded) matches, BM25 k=1.2 b=0.7
 *    d=0.5, field boost 2, OR-combined across terms.
 *
 * Nothing here is retained: a query reads the postings it needs and drops
 * them.
 */

const SPACE_OR_PUNCTUATION = /[\n\r\p{Z}\p{P}]+/u;

export const NAME_BOOST = 2;
const PREFIX_WEIGHT = 0.375;
const FUZZY_WEIGHT = 0.45;
const FUZZY_RATIO = 0.2;
const MAX_FUZZY = 6;
const BM25_K = 1.2;
const BM25_B = 0.7;
const BM25_D = 0.5;

/** What the store indexes for one basename. */
export interface NameAnalysis {
  /** lowercase term → occurrences. */
  terms: Map<string, number>;
  /** MiniSearch field length: unique raw tokens. */
  length: number;
}

export function analyzeName(basename: string): NameAnalysis {
  const tokens = basename.split(SPACE_OR_PUNCTUATION);
  const terms = new Map<string, number>();
  for (const token of tokens) {
    const term = token.toLowerCase();
    if (!term) continue;
    terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return { terms, length: new Set(tokens).size };
}

/** Query terms the way MiniSearch derives them from a query string. */
export function queryTerms(query: string): string[] {
  return query
    .split(SPACE_OR_PUNCTUATION)
    .map((t) => t.toLowerCase())
    .filter((t) => !!t);
}

export interface NamePosting {
  term: string;
  fileId: number;
  tf: number;
  nameLen: number;
  path: string;
}

/** What the ranking needs from the store. */
export interface NameSource {
  nameStats(): { docs: number; lenSum: number };
  /** Postings of every term starting with `prefix` (inclusive), by term, file id. */
  postingsWithPrefix(prefix: string): NamePosting[];
  /** Postings of exactly these terms, by term, file id. */
  postingsForTerms(terms: string[]): NamePosting[];
  /** Vocabulary terms whose character length is within [min, max]. */
  vocabBetween(min: number, max: number): string[];
}

function levenshteinWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function bm25(
  tf: number,
  df: number,
  total: number,
  fieldLength: number,
  avg: number,
): number {
  const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
  return (
    idf *
    (BM25_D +
      (tf * (BM25_K + 1)) /
        (tf + BM25_K * (1 - BM25_B + (BM25_B * fieldLength) / avg)))
  );
}

interface Hit {
  path: string;
  score: number;
}

/**
 * Rank basenames for `query`: path → score, best first. Scores are the
 * boosted BM25 sums MiniSearch's `search()` returned (unrounded).
 */
export function searchNames(
  src: NameSource,
  query: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const terms = queryTerms(query);
  if (terms.length === 0) return out;
  const { docs, lenSum } = src.nameStats();
  if (docs === 0) return out;
  const avg = lenSum / docs;

  const combined = new Map<number, Hit>();
  for (const term of terms) {
    const perTerm = new Map<number, Hit>();
    const addGroup = (group: NamePosting[], weight: number): void => {
      const df = group.length;
      for (const p of group) {
        const score =
          weight * NAME_BOOST * bm25(p.tf, df, docs, p.nameLen, avg);
        const hit = perTerm.get(p.fileId);
        if (hit) hit.score += score;
        else perTerm.set(p.fileId, { path: p.path, score });
      }
    };
    const groupByTerm = (postings: NamePosting[]): NamePosting[][] => {
      const groups: NamePosting[][] = [];
      let last: string | null = null;
      for (const p of postings) {
        if (p.term !== last) {
          groups.push([]);
          last = p.term;
        }
        groups[groups.length - 1].push(p);
      }
      return groups;
    };

    const prefixTerms = new Set<string>();
    for (const group of groupByTerm(src.postingsWithPrefix(term))) {
      const t = group[0].term;
      if (!t.startsWith(term)) continue;
      if (t === term) {
        addGroup(group, 1);
      } else {
        prefixTerms.add(t);
        const dist = t.length - term.length;
        addGroup(group, (PREFIX_WEIGHT * t.length) / (t.length + 0.3 * dist));
      }
    }

    const maxDistance = Math.min(
      MAX_FUZZY,
      Math.round(term.length * FUZZY_RATIO),
    );
    if (maxDistance > 0) {
      // SQL length() counts code points, JS length counts UTF-16 units: a
      // JS length L is at least L/2 code points, so the lower bound is loose.
      const lo = Math.max(1, Math.ceil((term.length - maxDistance) / 2));
      const hi = term.length + maxDistance;
      const fuzzy: { term: string; distance: number }[] = [];
      for (const cand of src.vocabBetween(lo, hi)) {
        if (cand === term || prefixTerms.has(cand)) continue;
        const distance = levenshteinWithin(term, cand, maxDistance);
        if (distance > 0 && distance <= maxDistance) {
          fuzzy.push({ term: cand, distance });
        }
      }
      if (fuzzy.length > 0) {
        fuzzy.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
        const dist = new Map(fuzzy.map((f) => [f.term, f.distance]));
        for (const group of groupByTerm(
          src.postingsForTerms(fuzzy.map((f) => f.term)),
        )) {
          const t = group[0].term;
          const d = dist.get(t);
          if (d === undefined) continue;
          addGroup(group, (FUZZY_WEIGHT * t.length) / (t.length + d));
        }
      }
    }

    for (const [fileId, hit] of perTerm) {
      const existing = combined.get(fileId);
      if (existing) existing.score += hit.score;
      else combined.set(fileId, hit);
    }
  }

  const ranked = [...combined.values()].sort((a, b) => b.score - a.score);
  for (const hit of ranked) out.set(hit.path, hit.score);
  return out;
}
