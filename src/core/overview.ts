import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../utils/config.js";
import { listFiles } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import { extractHeadings, extractTags } from "../utils/markdown.js";
import {
  type CachedFolderData,
  compactOverviewFoldersCache,
  loadOverviewCache,
  loadOverviewFoldersCache,
  OVERVIEW_CACHE_VERSION,
  type OverviewCacheData,
  type OverviewFoldersCacheData,
  saveOverviewCache,
  saveOverviewFoldersCache,
} from "../utils/overview-cache.js";

export interface OverviewFolder {
  path: string;
  notes: number;
  keywords: string[];
  tags: string[];
  /** Number of subfolders rolled up into this row (homogeneous-sibling collapse). */
  collapsedFolders?: number;
}

export interface VaultOverview {
  context?: string;
  overview: OverviewFolder[];
  /** Present only when maxRows capped the listing; rows/notes of dropped entries. */
  truncated?: { rows: number; notes: number };
  warnings?: string[];
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HEX_HASH_RE = /\b[a-f0-9]{8,}\b/g;
// Structured noise from imported/converted documents (OCR'd PDFs, DocuSign
// exports, HTML conversions). Stripped before tokenization so ID shrapnel
// ("DAB4-BCF3-..." → "dab", "bcf") never reaches keyword scoring.
const DASHED_HEX_RE = /\b[0-9a-f]{2,}(?:-[0-9a-f]{2,})+\b/gi;
const DIGIT_BLOB_RE = /\b(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{6,}\b/gi;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const HTML_ENTITY_RE = /&[a-z]+;|&#\d+;/gi;
const HEXLETTER_RUN_RE = /\b[a-f]{7,}\b/gi;

// Homogeneous-sibling collapse: parents with at least this many children
// whose term distributions are at least this similar (mean pairwise cosine
// over top terms) are rendered as a single aggregate row. Tuned against a
// corpus of real-world agent vaults — imported document dumps sit at ~0.15–0.25
// similarity, curated folder structures below ~0.05.
const COLLAPSE_MIN_CHILDREN = 5;
const COLLAPSE_SIMILARITY = 0.15;
const COLLAPSE_COSINE_TOP_TERMS = 60;
const COLLAPSE_PAIRWISE_CAP = 20;
const TOKEN_RE = /[a-z]{3,}/g;
const FRONTMATTER_RE = /^---[\s\S]*?---\n?/;
const ATX_HEADING_LINE_RE = /^#{1,6}\s+.+$/gm;
const WIKILINK_ONLY_RE = /^\[\[[^\]]+(?:\|[^\]]+)?\]\]$/;
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "as",
  "be",
  "was",
  "are",
  "this",
  "that",
  "not",
  "has",
  "have",
  "had",
  "will",
  "can",
  "may",
  "do",
  "does",
  "did",
  "been",
  "being",
  "would",
  "could",
  "should",
  "its",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "we",
  "they",
  "you",
  "he",
  "she",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "about",
  "above",
  "after",
  "again",
  "also",
  "any",
  "because",
  "before",
  "between",
  "down",
  "during",
  "even",
  "first",
  "get",
  "how",
  "if",
  "into",
  "like",
  "made",
  "make",
  "many",
  "much",
  "new",
  "no",
  "now",
  "off",
  "old",
  "only",
  "one",
  "out",
  "over",
  "own",
  "same",
  "so",
  "still",
  "then",
  "there",
  "these",
  "those",
  "through",
  "under",
  "up",
  "use",
  "used",
  "using",
  "want",
  "way",
  "well",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "work",
  "see",
  "here",
  "need",
  "etc",
  "two",
  "next",
  "per",
  "via",
  "vs",
  "yet",
  "ago",
  "due",
  "tbd",
]); // prettier-ignore

interface WeightedTerms {
  /** Term → occurrence count for one source text. */
  counts: Map<string, number>;
  weight: number;
}

interface HeadingSignals {
  lineCount: Map<string, number>;
  weightedTerms: Map<string, number>;
}

/**
 * Term counts shared by every folder in one overview run: one global string
 * dictionary plus flat `[termIndex, count]` pairs per folder, in
 * first-occurrence order.
 *
 * Sharing a dictionary is what makes the per-folder cache cheap to load — a
 * cached folder's pairs are used as-is instead of being converted into a Map
 * of millions of entries — and it keeps vocabulary that repeats across
 * thousands of folders on disk only once. Equal terms always have equal
 * indices, so everything the pipeline does with terms (document frequency,
 * cosine similarity) works on indices.
 */
interface TermDictionary {
  terms: string[];
  /** term → index; built on first intern (a pure cache-hit run never needs it). */
  index?: Map<string, number>;
}

/** Flattened `[termIndex, count, ...]` pairs, first-occurrence order. */
type TermPairs = number[];

interface FolderData {
  /** Weighted term counts, flattened into dictionary indices. */
  tf: TermPairs;
  /**
   * Term frequencies from note content (bodies and heading lines, unweighted;
   * no filename or title terms). Used for sibling-collapse similarity so
   * shared naming conventions cannot fake content homogeneity.
   */
  bodyTF: TermPairs;
  headingLineCount: Map<string, number>;
  /**
   * Terms whose only occurrences are headings. Stored as the complement of
   * "has a non-heading occurrence" because it is the small side: a note's
   * body vocabulary is orders of magnitude larger than its heading
   * vocabulary, and only membership is ever queried.
   */
  headingOnly: Set<string>;
  tags: Set<string>;
  noteCount: number;
}

const DIGIT_RE = /\d/;

/**
 * Each replace is guarded by a necessary condition of its pattern (an email
 * must contain "@", a URL "http", ...) so clean prose skips the expensive
 * regex scans entirely. Guards never change the result: when the guard is
 * false the pattern cannot match. HEX_HASH_RE can skip when no digit remains
 * because HEXLETTER_RUN_RE has already removed pure-letter hex runs ≥7.
 */
function stripNoise(text: string): string {
  let out = text;
  if (out.includes("```")) out = out.replace(CODE_BLOCK_RE, "");
  if (out.includes("`")) out = out.replace(INLINE_CODE_RE, "");
  if (out.includes("http")) out = out.replace(URL_RE, "");
  if (out.includes("@")) out = out.replace(EMAIL_RE, "");
  if (out.includes("<")) out = out.replace(HTML_TAG_RE, " ");
  if (out.includes("&")) out = out.replace(HTML_ENTITY_RE, " ");
  const hasDigit = DIGIT_RE.test(out);
  if (out.includes("-")) out = out.replace(DASHED_HEX_RE, " ");
  if (hasDigit) out = out.replace(DIGIT_BLOB_RE, " ");
  out = out.replace(HEXLETTER_RUN_RE, " ");
  if (hasDigit) out = out.replace(HEX_HASH_RE, "");
  return out;
}

function tokenize(text: string): string[] {
  const cleaned = stripNoise(text);
  return (cleaned.toLowerCase().match(TOKEN_RE) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
}

/**
 * Term → occurrence count for one text, from a single tokenize() pass.
 * Unigrams are inserted before bigrams, each in first-occurrence order —
 * the same insertion order occurrence-wise accumulation produced, so
 * downstream keyword tie-breaking (stable sort over Map order) is unchanged.
 */
function termCounts(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }
  return counts;
}

/** Merge per-text counts into an accumulator, scaled by an integer weight. */
function mergeCounts(
  target: Map<string, number>,
  counts: Map<string, number>,
  weight: number,
): void {
  for (const [term, count] of counts) {
    target.set(term, (target.get(term) || 0) + count * weight);
  }
}

function addWeightedTerms(
  target: Map<string, number>,
  sourceTerms: Iterable<string>,
  weight: number,
): void {
  for (const term of sourceTerms) {
    target.set(term, (target.get(term) || 0) + weight);
  }
}

function buildTF(sources: WeightedTerms[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const source of sources) {
    mergeCounts(freq, source.counts, source.weight);
  }
  return freq;
}

/** Depth of a folder path: root `/` is 0, `amazon` is 1, `amazon/features` is 2. */
function folderDepth(folder: string): number {
  return folder === "/" ? 0 : folder.split("/").length;
}

function folderKeywordTokens(folderPath: string): Set<string> {
  const tokens = new Set<string>();
  for (const segment of folderPath.split("/")) {
    for (const token of tokenize(segment)) {
      tokens.add(token);
      tokens.add(token.endsWith("s") ? token.slice(0, -1) : `${token}s`);
    }
  }
  return tokens;
}

function shouldSkipOverviewFile(
  file: string,
  folder: string,
  templatesFolder: string,
): boolean {
  const basename = path.basename(file);
  const topLevelFolder = folder === "/" ? "" : folder.split("/")[0];

  return (
    topLevelFolder === templatesFolder ||
    (folder === "/" && basename === "NAPKIN.md") ||
    basename === "_about.md"
  );
}

function frontmatterText(properties: Record<string, unknown>): string[] {
  const values: string[] = [];

  const visit = (value: unknown) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };

  for (const [key, value] of Object.entries(properties)) {
    if (key === "title" || key === "tags") continue;
    visit(value);
  }

  return values.filter((value) => {
    const trimmed = value.trim();
    return (
      trimmed.length > 0 &&
      !WIKILINK_ONLY_RE.test(trimmed) &&
      !ISO_DATE_PREFIX_RE.test(trimmed)
    );
  });
}

function markdownBodyText(content: string): string {
  return content.replace(FRONTMATTER_RE, "").replace(ATX_HEADING_LINE_RE, "");
}

function buildHeadingSignals(
  headingCounts: Iterable<Map<string, number>>,
): HeadingSignals {
  const lineCount = new Map<string, number>();
  const weightedTerms = new Map<string, number>();
  const uniqueTerms = new Set<string>();

  for (const counts of headingCounts) {
    for (const term of counts.keys()) {
      uniqueTerms.add(term);
      lineCount.set(term, (lineCount.get(term) || 0) + 1);
    }
  }

  addWeightedTerms(weightedTerms, uniqueTerms, 3);
  return { lineCount, weightedTerms };
}

function isCandidateKeyword(
  term: string,
  tf: number,
  folderTokens: Set<string>,
  headingLineCount: Map<string, number>,
  headingOnly: Set<string>,
): boolean {
  if (term.includes(" ")) {
    const [a, b] = term.split(" ");
    if (tf < 2 || a === b) return false;
  } else if (folderTokens.has(term)) {
    return false;
  }

  // Require corroboration: real keywords either appear outside headings or in
  // multiple heading lines. Single heading-only terms are usually section labels.
  // Every candidate term comes from `tf`, and `headingOnly` is exactly the
  // subset of `tf` with no non-heading occurrence, so this is the same test
  // the old full key-set membership was — without materializing that set
  // (2.7M entries on a real vault) per folder.
  return !headingOnly.has(term) || (headingLineCount.get(term) || 0) >= 2;
}

function extractKeywordsTFIDF(
  folderTF: TermPairs,
  terms: string[],
  documentFrequency: Map<number, number>,
  totalFolders: number,
  maxKeywords: number,
  folderPath: string,
  headingLineCount: Map<string, number>,
  headingOnly: Set<string>,
): string[] {
  const folderTokens = folderKeywordTokens(folderPath);
  const scored: [string, number][] = [];

  for (let i = 0; i < folderTF.length; i += 2) {
    const term = terms[folderTF[i]];
    const tf = folderTF[i + 1];
    if (
      !isCandidateKeyword(term, tf, folderTokens, headingLineCount, headingOnly)
    ) {
      continue;
    }

    const df = documentFrequency.get(folderTF[i]) || 1;
    const idf = Math.log(1 + totalFolders / df);
    scored.push([term, tf * idf]);
  }

  const sorted = scored.sort((a, b) => b[1] - a[1]);
  const selected: string[] = [];
  const suppressed = new Set<string>();

  for (const [term] of sorted) {
    if (selected.length >= maxKeywords) break;
    if (suppressed.has(term)) continue;

    selected.push(term);
    if (term.includes(" ")) {
      for (const part of term.split(" ")) {
        suppressed.add(part);
      }
    }
  }

  return selected;
}

/**
 * Top-N (term index, count) entries of one flattened term map. The sort is
 * stable, so terms with equal counts keep first-occurrence order — the same
 * tie-break the Map iteration this replaced provided.
 */
function topTermPairs(pairs: TermPairs): [number, number][] {
  const entries: [number, number][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    entries.push([pairs[i], pairs[i + 1]]);
  }
  return entries
    .sort((x, y) => y[1] - x[1])
    .slice(0, COLLAPSE_COSINE_TOP_TERMS);
}

/** Cosine similarity over the top-N terms of two TF maps. */
function tfCosine(a: TermPairs, b: TermPairs): number {
  const ta = topTermPairs(a);
  const tb = topTermPairs(b);
  const tbByTerm = new Map(tb);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of ta) na += v * v;
  for (const [, v] of tb) nb += v * v;
  for (const [k, v] of ta) {
    const w = tbByTerm.get(k);
    if (w) dot += v * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Sum several flattened term maps into one. Insertion order is behavior
 * (keyword selection breaks ties on it), so the accumulator keeps the
 * first-occurrence order of the inputs.
 */
function mergeTermPairs(parts: TermPairs[]): TermPairs {
  const totals = new Map<number, number>();
  for (const pairs of parts) {
    for (let i = 0; i < pairs.length; i += 2) {
      totals.set(pairs[i], (totals.get(pairs[i]) || 0) + pairs[i + 1]);
    }
  }
  const merged: TermPairs = [];
  for (const [index, count] of totals) merged.push(index, count);
  return merged;
}

function mergeFolderData(items: FolderData[]): FolderData {
  const headingLineCount = new Map<string, number>();
  const headingOnly = new Set<string>();
  const tags = new Set<string>();
  let noteCount = 0;
  for (const d of items) {
    for (const [k, v] of d.headingLineCount) {
      headingLineCount.set(k, (headingLineCount.get(k) || 0) + v);
    }
    for (const k of d.headingOnly) headingOnly.add(k);
    for (const t of d.tags) tags.add(t);
    noteCount += d.noteCount;
  }
  return {
    tf: mergeTermPairs(items.map((d) => d.tf)),
    bodyTF: mergeTermPairs(items.map((d) => d.bodyTF)),
    headingLineCount,
    headingOnly,
    tags,
    noteCount,
  };
}

/**
 * Collapse numerous, lexically homogeneous sibling folders into their parent
 * so repetitive subtrees (imported document dumps, per-entity folder fans)
 * render as one aggregate row instead of dominating the overview. The vault
 * root is never a collapse target: top-level folders are the taxonomy.
 * Parents shallower than `collapseDepth` are also skipped, so curated
 * top-level namespaces cannot be absorbed by a similarity artifact.
 */
function collapseHomogeneousSiblings(
  folderData: Map<string, FolderData>,
  collapseDepth: number,
): {
  data: Map<string, FolderData>;
  collapsed: Map<string, number>;
} {
  const byParent = new Map<string, string[]>();
  for (const folder of folderData.keys()) {
    if (folder === "/") continue;
    const idx = folder.lastIndexOf("/");
    const parent = idx === -1 ? "/" : folder.slice(0, idx);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)?.push(folder);
  }

  // Deepest parents first so collapses can cascade upward.
  const parents = [...byParent.keys()].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );

  const data = new Map(folderData);
  const collapsed = new Map<string, number>();

  for (const parent of parents) {
    // Root is depth 0 and always skipped; parents shallower than
    // collapseDepth can never be collapse targets.
    if (parent === "/" || folderDepth(parent) < collapseDepth) continue;
    const children = (byParent.get(parent) || []).filter((c) => data.has(c));
    if (children.length < COLLAPSE_MIN_CHILDREN) continue;

    const cap = Math.min(children.length, COLLAPSE_PAIRWISE_CAP);
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < cap; i++) {
      for (let j = i + 1; j < cap; j++) {
        const a = data.get(children[i]);
        const b = data.get(children[j]);
        if (!a || !b) continue;
        sum += tfCosine(a.bodyTF, b.bodyTF);
        pairs++;
      }
    }
    if (pairs === 0 || sum / pairs < COLLAPSE_SIMILARITY) continue;

    const toMerge: FolderData[] = [];
    let mergedFolderCount = 0;
    for (const child of children) {
      const d = data.get(child);
      if (!d) continue;
      toMerge.push(d);
      mergedFolderCount += 1 + (collapsed.get(child) || 0);
      data.delete(child);
      collapsed.delete(child);
    }
    const existing = data.get(parent);
    const merged = existing
      ? mergeFolderData([existing, ...toMerge])
      : mergeFolderData(toMerge);
    data.set(parent, merged);
    collapsed.set(parent, (collapsed.get(parent) || 0) + mergedFolderCount);
  }

  return { data, collapsed };
}

function groupFilesByFolder(
  files: string[],
  templatesFolder: string,
): Map<string, string[]> {
  const folderFiles = new Map<string, string[]>();

  for (const file of files) {
    const dir = path.dirname(file);
    const folder = dir === "." ? "/" : dir;
    if (shouldSkipOverviewFile(file, folder, templatesFolder)) continue;

    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder)?.push(file);
  }

  return folderFiles;
}

function buildFolderData(
  vaultPath: string,
  folderFileList: string[],
  warnings: string[],
  dict: TermDictionary,
): FolderData {
  const allTags = new Set<string>();
  // Term counts per unique heading text (first-seen order), computed once and
  // reused for both bodyTF (per occurrence) and heading signals (per unique).
  const headingCountCache = new Map<string, Map<string, number>>();
  const weightedSources: WeightedTerms[] = [];
  const bodyTF = new Map<string, number>();

  for (const file of folderFileList) {
    const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
    let properties: Record<string, unknown> = {};

    try {
      ({ properties } = parseFrontmatter(content));
    } catch {
      warnings.push(`Skipping ${file} (malformed YAML frontmatter)`);
      continue;
    }

    for (const tag of extractTags(content)) allTags.add(tag);
    if (Array.isArray(properties.tags)) {
      for (const tag of properties.tags) allTags.add(String(tag));
    }

    const fileHeadings = extractHeadings(content);
    for (const heading of fileHeadings) {
      const key = heading.text.trim();
      let headingCounts = headingCountCache.get(key);
      if (!headingCounts) {
        headingCounts = termCounts(heading.text);
        headingCountCache.set(key, headingCounts);
      }
      mergeCounts(bodyTF, headingCounts, 1);
    }

    weightedSources.push({
      counts: termCounts(path.basename(file, ".md")),
      weight: 2,
    });
    if (properties.title) {
      weightedSources.push({
        counts: termCounts(String(properties.title)),
        weight: 2,
      });
    }
    for (const value of frontmatterText(properties)) {
      weightedSources.push({ counts: termCounts(value), weight: 2 });
    }
    const bodyCounts = termCounts(markdownBodyText(content));
    weightedSources.push({ counts: bodyCounts, weight: 1 });
    mergeCounts(bodyTF, bodyCounts, 1);
  }

  const tf = buildTF(weightedSources);
  // Snapshot before heading terms are folded in: whatever heading terms are
  // missing from it occur in headings only (the transient snapshot is cheaper
  // than keeping "every tf term" alive for the whole pipeline).
  const nonHeadingTerms = new Set(tf.keys());
  const headingSignals = buildHeadingSignals(headingCountCache.values());

  for (const [term, weight] of headingSignals.weightedTerms) {
    tf.set(term, (tf.get(term) || 0) + weight);
  }
  const headingOnly = new Set<string>();
  for (const term of headingSignals.weightedTerms.keys()) {
    if (!nonHeadingTerms.has(term)) headingOnly.add(term);
  }

  return {
    // Cold-built folders land in the same packed form as cached ones, so the
    // pipeline (and the cache writer) has exactly one representation to handle.
    tf: encodeTermCounts(tf, dict),
    bodyTF: encodeTermCounts(bodyTF, dict),
    headingLineCount: headingSignals.lineCount,
    headingOnly,
    tags: allTags,
    noteCount: folderFileList.length,
  };
}

/** term → index map for a dictionary, built on first intern. */
function termIndex(dict: TermDictionary): Map<string, number> {
  let index = dict.index;
  if (!index) {
    index = new Map<string, number>();
    for (let i = 0; i < dict.terms.length; i++) index.set(dict.terms[i], i);
    dict.index = index;
  }
  return index;
}

/**
 * Fingerprint of one folder's DIRECT files: path + mtime + size, in build
 * order. Size is included because a same-tick edit can report an unchanged
 * mtime (the search cache made the same call); the result-level whole-vault
 * fingerprint stays path + mtime so its pinned semantics do not change.
 */
function folderFingerprint(
  files: string[],
  sigs: Map<string, OverviewFileSig>,
): string {
  const hash = crypto.createHash("md5");
  for (const file of files) {
    const sig = sigs.get(file);
    hash.update(`${file}:${sig?.mtime}:${sig?.size}\n`);
  }
  return hash.digest("hex");
}

/**
 * Flatten a term → count map into dictionary indices, interning terms the
 * dictionary has not seen yet. Map insertion order is preserved because it is
 * behavior: keyword selection ties break on it.
 */
function encodeTermCounts(
  counts: Map<string, number>,
  dict: TermDictionary,
): TermPairs {
  const index = termIndex(dict);
  const pairs: TermPairs = [];
  for (const [term, count] of counts) {
    let id = index.get(term);
    if (id === undefined) {
      id = dict.terms.length;
      dict.terms.push(term);
      index.set(term, id);
    }
    pairs.push(id, count);
  }
  return pairs;
}

/** Append index-only dictionary references, interning unseen terms. */
function encodeTermIndices(
  values: Iterable<string>,
  dict: TermDictionary,
): number[] {
  const index = termIndex(dict);
  const indices: number[] = [];
  for (const term of values) {
    let id = index.get(term);
    if (id === undefined) {
      id = dict.terms.length;
      dict.terms.push(term);
      index.set(term, id);
    }
    indices.push(id);
  }
  return indices;
}

/** True when every pair resolves to a dictionary term and a numeric count. */
function isUsableTermPairs(pairs: number[], terms: string[]): boolean {
  for (let i = 0; i < pairs.length; i += 2) {
    if (typeof pairs[i + 1] !== "number") return false;
    if (terms[pairs[i]] === undefined) return false;
  }
  return true;
}

/** Resolve index-only dictionary references, or null when one is invalid. */
function decodeTermIndices(
  indices: number[],
  terms: string[],
): Set<string> | null {
  const values = new Set<string>();
  for (const index of indices) {
    const term = terms[index];
    if (term === undefined) return null;
    values.add(term);
  }
  return values;
}

/**
 * Rebuild a term-count map from dictionary indices. Returns null when the
 * entry is unusable (out-of-range index, non-numeric count) so the caller
 * rebuilds that folder cold instead of inventing terms.
 */
function decodeTermCounts(
  pairs: number[],
  terms: string[],
): Map<string, number> | null {
  const counts = new Map<string, number>();
  for (let i = 0; i < pairs.length; i += 2) {
    const index = pairs[i];
    const count = pairs[i + 1];
    if (typeof index !== "number" || typeof count !== "number") return null;
    const term = terms[index];
    if (term === undefined) return null;
    counts.set(term, count);
  }
  return counts;
}

/** Serialize one folder's FolderData for the cache (shares its pair arrays). */
function cacheEntry(
  data: FolderData,
  sig: string,
  warnings: string[],
  dict: TermDictionary,
): CachedFolderData {
  return {
    sig,
    n: data.noteCount,
    // Already dictionary indices: no re-encoding pass over 5M entries.
    tf: data.tf,
    body: data.bodyTF,
    head: encodeTermCounts(data.headingLineCount, dict),
    headOnly: encodeTermIndices(data.headingOnly, dict),
    tags: [...data.tags],
    warn: warnings,
  };
}

/**
 * Rebuild a folder's FolderData from its cache entry. The weighted body term
 * maps are adopted as-is (they are already dictionary indices) — loading the
 * cache costs one parse, not a Map per term. Returns null when the entry is
 * unusable, so the caller rebuilds that folder cold instead of throwing.
 */
function decodeFolderData(
  entry: CachedFolderData,
  terms: string[],
): FolderData | null {
  const headingLineCount = decodeTermCounts(entry.head, terms);
  const headingOnly = decodeTermIndices(entry.headOnly, terms);
  if (!headingLineCount || !headingOnly) return null;
  if (!Number.isInteger(entry.n) || entry.n < 0) return null;
  if (
    !isUsableTermPairs(entry.tf, terms) ||
    !isUsableTermPairs(entry.body, terms)
  ) {
    return null;
  }
  return {
    tf: entry.tf,
    bodyTF: entry.body,
    headingLineCount,
    // buildFolderData's own semantics: the tf terms that occur in headings
    // only. Small by construction, so it is stored directly.
    headingOnly,
    tags: new Set(entry.tags),
    noteCount: entry.n,
  };
}

interface FolderDataCollection {
  folderData: Map<string, FolderData>;
  /** The dictionary every folder's term indices refer to. */
  terms: string[];
  /** Warnings in cold-computation order: folder listing order, then file order. */
  warnings: string[];
  /** Cache to persist, or null when nothing changed (skip a multi-MB write). */
  cache: OverviewFoldersCacheData | null;
}

/**
 * Build or reuse the FolderData of every folder in the listing.
 *
 * The cache is per folder, keyed by a fingerprint of that folder's DIRECT
 * files: one note written in one folder rebuilds exactly that folder and
 * reuses every other entry, so a vault that changes every few minutes pays
 * for what changed instead of for a full tokenization pass.
 *
 * Entries for folders that disappeared are dropped. Entries for folders
 * beyond maxDepth are carried over untouched — the bounded walk (#117)
 * cannot re-verify their files on a shallow run, and a deeper run re-checks
 * their sig before reusing them — but never built: a shallow run must not
 * cost as much as a deep one.
 *
 * Everything that shapes FolderData besides the files themselves (ignore
 * state, templates folder, cache version) is validated when the file is
 * loaded; any mismatch discards the whole cache.
 */
function collectFolderData(
  vaultPath: string,
  configPath: string,
  ignoreFingerprint: string,
  templatesFolder: string,
  maxDepth: number,
  folderFiles: Map<string, string[]>,
  sigs: Map<string, OverviewFileSig>,
): FolderDataCollection {
  const loaded = loadOverviewFoldersCache(
    configPath,
    ignoreFingerprint,
    templatesFolder,
  );
  // The dictionary is shared by every folder in the run; its lookup index is
  // built lazily, so a run that rebuilds nothing never pays for it.
  const dict: TermDictionary = { terms: loaded ? loaded.terms : [] };

  const folders: Record<string, CachedFolderData> = Object.create(null);
  const folderData = new Map<string, FolderData>();
  const warnings: string[] = [];
  // A missing cache, a dropped entry, or a rebuilt folder all mean the file
  // on disk no longer describes this listing.
  let dirty = loaded === null;

  // The walk is bounded to maxDepth (#117), so folderFiles holds only
  // folders this run can use — the folderDepth > maxDepth guard the
  // unbounded walk needed is gone.
  for (const [folder, folderFileList] of folderFiles) {
    const sig = folderFingerprint(folderFileList, sigs);
    const previous = loaded?.folders.get(folder);
    const cached = previous?.sig === sig ? previous : undefined;

    const reused = cached ? decodeFolderData(cached, dict.terms) : null;
    if (cached && reused) {
      folders[folder] = cached;
      folderData.set(folder, reused);
      for (const warning of cached.warn) warnings.push(warning);
      continue;
    }

    dirty = true;
    const folderWarnings: string[] = [];
    const data = buildFolderData(
      vaultPath,
      folderFileList,
      folderWarnings,
      dict,
    );
    folderData.set(folder, data);
    for (const warning of folderWarnings) warnings.push(warning);
    folders[folder] = cacheEntry(data, sig, folderWarnings, dict);
  }

  // Folders that no longer hold any visible .md file never reach the loop
  // above, so their entries would otherwise live on forever. Entries deeper
  // than maxDepth are a different case: the bounded walk cannot see whether
  // they disappeared, so they are carried over (their sig is re-verified on
  // the next run deep enough to reach them).
  if (loaded) {
    for (const [folder, entry] of loaded.folders) {
      if (folderFiles.has(folder)) continue;
      if (folderDepth(folder) > maxDepth) {
        folders[folder] = entry;
      } else {
        dirty = true;
      }
    }
  }

  if (!dirty) {
    return { folderData, terms: dict.terms, warnings, cache: null };
  }

  return {
    folderData,
    terms: dict.terms,
    warnings,
    cache: compactOverviewFoldersCache({
      version: OVERVIEW_CACHE_VERSION,
      ignoreFingerprint,
      templatesFolder,
      terms: dict.terms,
      folders,
    }),
  };
}

/**
 * Assemble the overview rows from per-folder data: homogeneous-sibling
 * collapse, then TF-IDF keyword selection over the resulting folders. A pure
 * function of FolderData — whether the data was just built or came from the
 * per-folder cache cannot affect the result.
 */
function buildOverviewRows(
  initialFolderData: Map<string, FolderData>,
  terms: string[],
  maxKeywords: number,
  collapse: boolean,
  collapseDepth: number,
  maxRows: number,
): OverviewFolder[] {
  let folderData = initialFolderData;
  let collapsedCounts = new Map<string, number>();
  if (collapse) {
    const result = collapseHomogeneousSiblings(folderData, collapseDepth);
    folderData = result.data;
    collapsedCounts = result.collapsed;
  }

  // Document frequency by term INDEX: the dictionary guarantees equal terms
  // share an index, so this needs no string hashing over millions of terms.
  const documentFrequency = new Map<number, number>();
  for (const { tf } of folderData.values()) {
    for (let i = 0; i < tf.length; i += 2) {
      const index = tf[i];
      documentFrequency.set(index, (documentFrequency.get(index) || 0) + 1);
    }
  }

  const totalFolders = folderData.size;
  const folders: OverviewFolder[] = [];

  // Upstream default: purely lexical order. Only when a row cap is active
  // (maxRows > 0) does the fork's priority order apply — shallow first, then
  // note count descending, then lexical — so the most informative rows
  // survive the cut. Unset/0 keeps output byte-identical to upstream.
  const entries = [...folderData.entries()].sort((a, b) => {
    if (maxRows > 0) {
      const depthDiff = folderDepth(a[0]) - folderDepth(b[0]);
      if (depthDiff !== 0) return depthDiff;
      if (a[1].noteCount !== b[1].noteCount) {
        return b[1].noteCount - a[1].noteCount;
      }
    }
    return a[0].localeCompare(b[0]);
  });

  for (const [folder, data] of entries) {
    folders.push({
      path: folder,
      notes: data.noteCount,
      keywords: extractKeywordsTFIDF(
        data.tf,
        terms,
        documentFrequency,
        totalFolders,
        maxKeywords,
        folder,
        data.headingLineCount,
        data.headingOnly,
      ),
      tags: [...data.tags].sort(),
      ...(collapsedCounts.has(folder)
        ? { collapsedFolders: collapsedCounts.get(folder) }
        : {}),
    });
  }

  return folders;
}

interface OverviewFileSig {
  file: string;
  mtime: number;
  size: number;
}

/**
 * Single directory walk + one stat per note — the unavoidable per-call floor,
 * shared by both fingerprints below. Paths + mtimes only: the shared
 * search-cache helper hashes size too (its own tradeoff); the overview cache
 * must treat a frozen-mtime content rewrite as invisible, so it
 * fingerprints independently.
 *
 * The walk is bounded to maxDepth: notes in folders deeper than the
 * configured overview depth can never reach the output (collectFolderData
 * only builds folders up to maxDepth, and the collapse only sees that set),
 * so they are not walked, not statted, and do not feed either fingerprint —
 * a deep write no longer invalidates a shallow result (#117). The bound uses
 * walkDir's shouldEnter, so symlink and ignore semantics are unchanged.
 */
function statOverviewFiles(
  contentPath: string,
  ignore: Ignorer | undefined,
  maxDepth: number,
): OverviewFileSig[] {
  const entries: OverviewFileSig[] = [];
  for (const file of listFiles(contentPath, { ext: "md", ignore, maxDepth })) {
    const stat = fs.statSync(path.join(contentPath, file));
    entries.push({ file, mtime: stat.mtimeMs, size: stat.size });
  }
  return entries;
}

/** Whole-vault fingerprint: every reachable note path + mtime. */
function vaultFingerprint(entries: OverviewFileSig[]): string {
  const hash = crypto.createHash("md5");
  for (const { file, mtime } of entries) hash.update(`${file}:${mtime}\n`);
  return hash.digest("hex");
}

/**
 * Overview works without a cache, so persistence is best-effort: a read-only
 * vault or a full disk costs the next run a recompute, not this one an error.
 */
function persistOverviewCaches(
  configPath: string,
  result: OverviewCacheData<VaultOverview>,
  folders: OverviewFoldersCacheData | null,
): void {
  try {
    saveOverviewCache(configPath, result);
  } catch {
    // Best-effort: see above.
  }
  if (!folders) return;
  try {
    saveOverviewFoldersCache(configPath, folders);
  } catch {
    // Best-effort: see above.
  }
}

export function getOverview(
  contentPath: string,
  configPath: string,
  opts?: {
    depth?: number;
    keywords?: number;
    collapse?: boolean;
    collapseDepth?: number;
    maxRows?: number;
  },
): VaultOverview {
  const config = loadConfig(configPath);
  const { ignorer, fingerprint: ignoreFingerprint } = loadIgnorer(
    contentPath,
    configPath,
  );
  const maxDepth = opts?.depth ?? config.overview.depth;
  const maxKeywords = opts?.keywords ?? config.overview.keywords;
  const collapse = opts?.collapse ?? config.overview.collapse;
  const collapseDepth = opts?.collapseDepth ?? config.overview.collapseDepth;
  const maxRows = opts?.maxRows ?? config.overview.maxRows;
  const templatesFolder = config.templates.folder;

  // One stat pass feeds both cache layers: the whole-vault fingerprint (does
  // the cached RESULT still apply?) and the per-folder fingerprints (which
  // FolderData must be rebuilt?). Any file add/remove/touch at or within
  // maxDepth changes the whole-vault fingerprint — deeper notes are outside
  // the bounded walk and invisible to the result (#117); NAPKIN.md is a
  // vault .md file at the root, so context changes invalidate too. Resolved
  // options are part of the result key because they change the output.
  const stats = statOverviewFiles(contentPath, ignorer, maxDepth);
  const fingerprint = vaultFingerprint(stats);
  const optionsKey = `${maxDepth}|${maxKeywords}|${collapse}|${collapseDepth}|${maxRows}|${templatesFolder}`;

  // Fast path: nothing changed and the options match, so the previous answer
  // is returned without opening the per-folder data file at all.
  const cachedResult = loadOverviewCache<VaultOverview>(configPath, {
    fingerprint,
    optionsKey,
    ignoreFingerprint,
  });
  if (cachedResult) return cachedResult;

  const sigs = new Map(stats.map((sig) => [sig.file, sig]));
  const folderFiles = groupFilesByFolder(
    stats.map(({ file }) => file),
    templatesFolder,
  );
  const collected = collectFolderData(
    contentPath,
    configPath,
    ignoreFingerprint,
    templatesFolder,
    maxDepth,
    folderFiles,
    sigs,
  );
  const folders = buildOverviewRows(
    collected.folderData,
    collected.terms,
    maxKeywords,
    collapse,
    collapseDepth,
    maxRows,
  );
  const warnings = collected.warnings;

  const contextPath = path.join(contentPath, "NAPKIN.md");
  const context = fs.existsSync(contextPath)
    ? fs.readFileSync(contextPath, "utf-8").trim()
    : undefined;

  // Row cap (fork extension): maxRows > 0 truncates the listing and reports
  // what was dropped; 0/unset is unlimited (upstream behavior).
  let overview = folders;
  let truncated: { rows: number; notes: number } | undefined;
  if (maxRows > 0 && folders.length > maxRows) {
    overview = folders.slice(0, maxRows);
    const dropped = folders.slice(maxRows);
    truncated = {
      rows: dropped.length,
      notes: dropped.reduce((sum, f) => sum + f.notes, 0),
    };
  }

  const result: VaultOverview = {
    ...(context ? { context } : {}),
    overview,
    ...(truncated ? { truncated } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  persistOverviewCaches(
    configPath,
    {
      version: OVERVIEW_CACHE_VERSION,
      fingerprint,
      optionsKey,
      ignoreFingerprint,
      result,
    },
    collected.cache,
  );
  return result;
}

// Exported for differential testing against the pre-optimization oracle
// (src/core/__tests__/overview.equivalence.test.ts). Not public API.
export { stripNoise as _stripNoise, termCounts as _termCounts };
