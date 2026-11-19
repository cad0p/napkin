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
import {
  createOverviewStore,
  reportOverviewStoreFailure,
  type SqliteOverviewStore,
  type StoredFolderRow,
} from "../utils/overview-store.js";

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

// ─── SQLite-backed pipeline (#118) ─────────────────────────────────
//
// The same collect → collapse → TF-IDF pipeline as above, but the per-folder
// data lives in .napkin/cache/overview-v2.db (SqliteOverviewStore): one row
// PER NOTE holding that note's term data as an Int32 blob, plus one derived
// row per folder. A miss re-tokenizes only notes whose (mtime, size)
// changed and re-aggregates each touched folder from its notes' blobs in
// sorted path order — which reproduces buildFolderData's term order exactly
// (the file list is sorted path order, and the folder Map's insertion order
// is (note rank, first-seen position within the note)). Document frequency
// is recomputed on every miss from the folders' tfids blobs, so it is exact
// by construction — no stored df to keep in sync.
//
// Byte-identity invariants against the in-memory path:
//  - note blob order: non-heading weighted terms then body terms, each in
//    the note's own first-seen order (filename, title, frontmatter, body;
//    then heading lines, then body).
//  - folder tf order: non-heading terms in (note rank, note position), then
//    heading-only terms in (note rank, heading-text rank, term position).
//  - candidate order: the tf order filtered by isCandidateKeyword — every
//    input is folder-local, so the filter runs at aggregation time.
//  - merge order: collapse children merge in folder-listing order, parent
//    row first, exactly like mergeFolderData.

/**
 * Reinterpret a SQLite blob as Int32 pairs. node:sqlite returns Uint8Arrays
 * whose pool offset need not be 4-aligned; copy when it is not.
 */
function i32(u: Uint8Array): Int32Array {
  if (u.byteOffset % 4 === 0) {
    return new Int32Array(u.buffer, u.byteOffset, u.byteLength >> 2);
  }
  const copy = u.slice();
  return new Int32Array(copy.buffer, 0, copy.byteLength >> 2);
}

/** Int32Array → the Uint8Array view sqlite stores as a BLOB. */
function u8(a: Int32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/** One note's extracted record: the form notes.data + heads + tags persist. */
interface NoteRecord {
  skip: boolean;
  tags: string[];
  /** [trimmed heading text, term ids] per unique heading text, in order. */
  heads: [string, number[]][];
  /** [nNh,(id,count)×nNh, nBody,(id,count)×nBody] — null when skipped. */
  data: Int32Array | null;
}

/**
 * One note's term data — exactly the slices buildFolderData computes for a
 * file: non-heading weighted counts (filename ×2, title ×2, frontmatter ×2,
 * body ×1) in first-seen order, body counts (heading lines then body text)
 * in first-seen order, the note's tags, and per-unique-heading-text term
 * lists in first-seen order.
 */
function extractNoteRecord(
  vaultPath: string,
  file: string,
  store: SqliteOverviewStore,
): NoteRecord {
  const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
  let properties: Record<string, unknown> = {};
  try {
    ({ properties } = parseFrontmatter(content));
  } catch {
    return { skip: true, tags: [], heads: [], data: null };
  }

  const tags = new Set<string>();
  for (const tag of extractTags(content)) tags.add(tag);
  if (Array.isArray(properties.tags)) {
    for (const tag of properties.tags) tags.add(String(tag));
  }

  // Per-unique-heading-text counts (per note; the folder-level dedup is a
  // set at aggregation time). Body counts fold every heading occurrence.
  const body = new Map<string, number>();
  const headingCache = new Map<string, Map<string, number>>();
  const headingOrder: string[] = [];
  for (const heading of extractHeadings(content)) {
    const key = heading.text.trim();
    let counts = headingCache.get(key);
    if (!counts) {
      counts = termCounts(heading.text);
      headingCache.set(key, counts);
      headingOrder.push(key);
    }
    mergeCounts(body, counts, 1);
  }

  const nh = new Map<string, number>();
  mergeCounts(nh, termCounts(path.basename(file, ".md")), 2);
  if (properties.title) {
    mergeCounts(nh, termCounts(String(properties.title)), 2);
  }
  for (const value of frontmatterText(properties)) {
    mergeCounts(nh, termCounts(value), 2);
  }
  const bodyCounts = termCounts(markdownBodyText(content));
  mergeCounts(nh, bodyCounts, 1);
  mergeCounts(body, bodyCounts, 1);

  const vocab = new Set<string>([...nh.keys(), ...body.keys()]);
  for (const counts of headingCache.values()) {
    for (const term of counts.keys()) vocab.add(term);
  }
  const ids = store.intern(vocab);

  const data = new Int32Array(2 + nh.size * 2 + body.size * 2);
  let p = 0;
  data[p++] = nh.size;
  for (const [term, count] of nh) {
    data[p++] = ids.get(term) as number;
    data[p++] = count;
  }
  data[p++] = body.size;
  for (const [term, count] of body) {
    data[p++] = ids.get(term) as number;
    data[p++] = count;
  }

  const heads: [string, number[]][] = headingOrder.map((key) => [
    key,
    [...(headingCache.get(key) as Map<string, number>).keys()].map(
      (term) => ids.get(term) as number,
    ),
  ]);
  return { skip: false, tags: [...tags], heads, data };
}

/** Dense accumulator arrays indexed by term id, grown as the dict grows. */
interface DenseAgg {
  /** Non-heading weighted counts. */
  w: Int32Array;
  /** Body counts (only tracked when the folder's full blob is needed). */
  b: Int32Array;
  /** Heading line counts (distinct heading texts containing the term). */
  lc: Int32Array;
  /** "Term id seen in a heading" marks. */
  seen: Uint8Array;
}

function ensureDense(d: DenseAgg, size: number): void {
  if (d.w.length >= size) return;
  const n = Math.ceil(size * 1.1);
  // Copy: counts already accumulated for this folder must survive the grow.
  const grow = (a: Int32Array): Int32Array => {
    const next = new Int32Array(n);
    next.set(a);
    return next;
  };
  const grow8 = (a: Uint8Array): Uint8Array => {
    const next = new Uint8Array(n);
    next.set(a);
    return next;
  };
  d.w = grow(d.w);
  d.b = grow(d.b);
  d.lc = grow(d.lc);
  d.seen = grow8(d.seen);
}

interface FolderAggregate {
  /** tf term ids in tf order (the df input). */
  tfids: Int32Array;
  /** (id, tf) keyword-candidate pairs in tf order. */
  cand: Int32Array;
  /** The full blob, or null when collapse cannot touch this folder. */
  full: Int32Array | null;
  tags: string[];
  warn: string[];
  notes: number;
}

/**
 * Re-aggregate one folder from its notes' records — in file order — into
 * the derived blobs the read phase consumes. This is the streaming,
 * id-space equivalent of buildFolderData + the candidate filter:
 *
 *   tf order   = non-heading terms (note rank, note position), then
 *                heading-only terms (note rank, heading rank, position)
 *   tf values  = non-heading weight + 3 when the term occurs in a heading
 *   headingOnly = heading terms absent from the non-heading counts
 *   lineCount   = distinct heading texts containing the term
 *
 * needFull additionally tracks body counts and emits the collapse blob;
 * when false the body section of each note blob is skipped entirely.
 */
function aggregateFolder(
  store: SqliteOverviewStore,
  folder: string,
  files: string[],
  records: (file: string) => NoteRecord,
  needFull: boolean,
  dense: DenseAgg,
): FolderAggregate {
  const nhOrder: number[] = [];
  const hOrder: number[] = [];
  const bodyOrder: number[] = [];
  const tags = new Set<string>();
  const texts = new Set<string>();
  const warn: string[] = [];

  for (const file of files) {
    const rec = records(file);
    // Interning inside records() can grow the dictionary — ensureDense may
    // replace the arrays, so the aliases are (re)bound per note.
    ensureDense(dense, store.maxTermId() + 1);
    const w = dense.w;
    const b = dense.b;
    const lc = dense.lc;
    const seen = dense.seen;
    if (rec.skip) {
      warn.push(`Skipping ${file} (malformed YAML frontmatter)`);
      continue;
    }
    for (const tag of rec.tags) tags.add(tag);
    const a = rec.data as Int32Array;
    let p = 0;
    const nn = a[p++];
    for (let k = 0; k < nn; k++, p += 2) {
      const id = a[p];
      if (w[id] === 0) nhOrder.push(id);
      w[id] += a[p + 1];
    }
    const nb = a[p++];
    if (needFull) {
      for (let k = 0; k < nb; k++, p += 2) {
        const id = a[p];
        if (b[id] === 0) bodyOrder.push(id);
        b[id] += a[p + 1];
      }
    }
    for (const [text, ids] of rec.heads) {
      for (const id of ids) {
        if (!seen[id]) {
          seen[id] = 1;
          hOrder.push(id);
        }
      }
      if (!texts.has(text)) {
        texts.add(text);
        for (const id of ids) lc[id]++;
      }
    }
  }
  const w = dense.w;
  const b = dense.b;
  const lc = dense.lc;
  const seen = dense.seen;

  // tf order: non-heading terms, then heading terms never seen outside
  // headings (w[id] === 0 marks those). Every id touched by w/b/lc/seen is
  // in tfOrder — body terms are a subset of nh ∪ heading terms — so the
  // reset loop over tfOrder clears every dense slot this folder used.
  const tfOrder = nhOrder.slice();
  for (const id of hOrder) if (w[id] === 0) tfOrder.push(id);

  // Resolved AFTER the record loop: cold-mode interning only populates the
  // dictionary as records are consumed, so an earlier lookup could miss.
  const folderTokenIds = new Set(
    store.idsForTerms([...folderKeywordTokens(folder)]).values(),
  );
  const cand: number[] = [];
  for (const id of tfOrder) {
    const tf = w[id] + (lc[id] > 0 ? 3 : 0);
    const flag = store.flags()[id];
    if (flag & 1) {
      if (tf < 2 || flag & 2) continue;
    } else if (folderTokenIds.has(id)) {
      continue;
    }
    // headingOnly (w === 0, in hOrder) needs corroboration: >= 2 heading
    // lines — the same isCandidateKeyword check, run at write time.
    if (w[id] === 0 && lc[id] < 2) continue;
    cand.push(id, tf);
  }

  let full: Int32Array | null = null;
  if (needFull) {
    const headPairs: number[] = [];
    const headOnly: number[] = [];
    for (const id of hOrder) {
      if (lc[id] > 0) headPairs.push(id, lc[id]);
      if (w[id] === 0) headOnly.push(id);
    }
    const tfPairs: number[] = [];
    for (const id of tfOrder) tfPairs.push(id, w[id] + (lc[id] > 0 ? 3 : 0));
    const bodyPairs: number[] = [];
    for (const id of bodyOrder) bodyPairs.push(id, b[id]);
    const top = topTermPairsArray(bodyPairs);
    full = new Int32Array(
      5 +
        tfPairs.length +
        bodyPairs.length +
        headPairs.length +
        headOnly.length +
        top.length,
    );
    let q = 0;
    const put = (pairs: number[] | Int32Array) => {
      full?.set(pairs, q);
      q += pairs.length;
    };
    full[q++] = tfPairs.length;
    put(tfPairs);
    full[q++] = bodyPairs.length;
    put(bodyPairs);
    full[q++] = headPairs.length;
    put(headPairs);
    full[q++] = headOnly.length;
    put(headOnly);
    full[q++] = top.length;
    put(top);
  }

  for (const id of tfOrder) {
    w[id] = 0;
    b[id] = 0;
    lc[id] = 0;
    seen[id] = 0;
  }

  return {
    tfids: Int32Array.from(tfOrder),
    cand: Int32Array.from(cand),
    full,
    tags: [...tags],
    warn,
    notes: files.length,
  };
}

/** Stable top-60 of a flat (id, count) pair list — topTermPairs' contract. */
function topTermPairsArray(pairs: number[] | Int32Array): Int32Array {
  const idx: number[] = [];
  for (let i = 0; i < pairs.length; i += 2) idx.push(i);
  idx.sort((x, y) => pairs[y + 1] - pairs[x + 1] || x - y);
  const out = new Int32Array(
    Math.min(COLLAPSE_COSINE_TOP_TERMS, idx.length) * 2,
  );
  for (let i = 0; i < out.length; i += 2) {
    out[i] = pairs[idx[i >> 1]];
    out[i + 1] = pairs[idx[i >> 1] + 1];
  }
  return out;
}

/** A folder's complete term data keyed by term id — the collapse form of
 *  FolderData. tf/bodyTF/top are flat (id, count) pair arrays. */
interface IdFolderData {
  tf: Int32Array;
  bodyTF: Int32Array;
  head: Map<number, number>;
  headOnly: Set<number>;
  top: Int32Array;
  tags: Set<string>;
  noteCount: number;
}

/** Decode a folder's full blob into IdFolderData (tags/notes from the row). */
function decodeFullBlob(
  blob: Uint8Array,
  tags: Set<string>,
  noteCount: number,
): IdFolderData {
  const a = i32(blob);
  let p = 0;
  const take = (n: number): Int32Array => {
    const out = a.subarray(p, p + n);
    p += n;
    return out;
  };
  const tf = take(a[p++]);
  const bodyTF = take(a[p++]);
  const headFlat = take(a[p++]);
  const head = new Map<number, number>();
  for (let i = 0; i < headFlat.length; i += 2) {
    head.set(headFlat[i], headFlat[i + 1]);
  }
  const headOnlyFlat = take(a[p++]);
  const headOnly = new Set<number>(headOnlyFlat);
  const top = take(a[p++]);
  return { tf, bodyTF, head, headOnly, top, tags, noteCount };
}

/** Merge id-space folder data — mergeFolderData's exact semantics. */
function mergeIdFolderData(items: IdFolderData[]): IdFolderData {
  const head = new Map<number, number>();
  const headOnly = new Set<number>();
  const tags = new Set<string>();
  let noteCount = 0;
  for (const d of items) {
    for (const [k, v] of d.head) head.set(k, (head.get(k) || 0) + v);
    for (const k of d.headOnly) headOnly.add(k);
    for (const t of d.tags) tags.add(t);
    noteCount += d.noteCount;
  }
  const mergePairs = (parts: Int32Array[]): Int32Array => {
    const totals = new Map<number, number>();
    for (const pairs of parts) {
      for (let i = 0; i < pairs.length; i += 2) {
        totals.set(pairs[i], (totals.get(pairs[i]) || 0) + pairs[i + 1]);
      }
    }
    const merged = new Int32Array(totals.size * 2);
    let i = 0;
    for (const [id, count] of totals) {
      merged[i++] = id;
      merged[i++] = count;
    }
    return merged;
  };
  const tf = mergePairs(items.map((d) => d.tf));
  const bodyTF = mergePairs(items.map((d) => d.bodyTF));
  return {
    tf,
    bodyTF,
    head,
    headOnly,
    top: topTermPairsArray(bodyTF),
    tags,
    noteCount,
  };
}

/** Cosine over two flat top-N (id, count) pair lists — tfCosine's math. */
function topPairsCosine(a: Int32Array, b: Int32Array): number {
  const bMap = new Map<number, number>();
  for (let i = 0; i < b.length; i += 2) bMap.set(b[i], b[i + 1]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 2) na += a[i + 1] * a[i + 1];
  for (let i = 0; i < b.length; i += 2) nb += b[i + 1] * b[i + 1];
  for (let i = 0; i < a.length; i += 2) {
    const w = bMap.get(a[i]);
    if (w) dot += a[i + 1] * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Score a folder's (id, tf) pairs and select keywords — id-space
 * extractKeywordsTFIDF. The pairs arrive in first-occurrence order, which
 * is behavior: the score sort is stable, so ties break identically to the
 * Map-order pipeline. Term text is resolved only for the ~maxKeywords
 * selected ids and the unigram parts of selected bigrams.
 *
 * filter (optional) is the id-space isCandidateKeyword: stored folders pass
 * their persisted candidate list (already filtered at aggregation time),
 * merged parents pass a filter over their merged heading signals.
 */
function selectKeywordsById(
  store: SqliteOverviewStore,
  pairs: Int32Array,
  df: Int32Array,
  totalFolders: number,
  maxKeywords: number,
  filter: ((id: number, tf: number) => boolean) | null,
): string[] {
  const flags = store.flags();
  const scored: { id: number; score: number }[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const id = pairs[i];
    const tf = pairs[i + 1];
    if (filter !== null && !filter(id, tf)) continue;
    const docFreq = Math.max(1, df[id]);
    scored.push({ id, score: tf * Math.log(1 + totalFolders / docFreq) });
  }
  scored.sort((a, b) => b.score - a.score);

  const selected: number[] = [];
  const suppressed = new Set<number>();
  for (const { id } of scored) {
    if (selected.length >= maxKeywords) break;
    if (suppressed.has(id)) continue;
    selected.push(id);
    if (flags[id] & 1) {
      // Suppress the bigram's unigram parts, by term id — the same test the
      // string-keyed path performs; a part absent from the dictionary
      // suppresses nothing.
      const term = store.termTexts([id]).get(id);
      if (term === undefined) continue;
      const partIds = store.idsForTerms(term.split(" "));
      for (const part of term.split(" ")) {
        const pid = partIds.get(part);
        if (pid !== undefined) suppressed.add(pid);
      }
    }
  }
  const texts = store.termTexts(selected);
  return selected.map((id) => texts.get(id) ?? "");
}

/** The whole-miss pipeline over the per-note SQLite store. */
function overviewFromStore(
  store: SqliteOverviewStore,
  vaultPath: string,
  ignoreFingerprint: string,
  templatesFolder: string,
  maxDepth: number,
  maxKeywords: number,
  collapse: boolean,
  collapseDepth: number,
  maxRows: number,
  folderFiles: Map<string, string[]>,
  sigs: Map<string, OverviewFileSig>,
): { folders: OverviewFolder[]; warnings: string[] } {
  const meta = store.metaState();
  // Same rule as the JSON cache: a format, ignore-state, or templates-folder
  // change discards the whole store — it shapes every stored record.
  const wipe =
    meta.format !== OVERVIEW_CACHE_VERSION ||
    meta.ignoreFp !== ignoreFingerprint ||
    meta.templatesFolder !== templatesFolder;

  const live = new Set(folderFiles.keys());
  const parentOf = (folder: string): string => {
    const idx = folder.lastIndexOf("/");
    return idx === -1 ? "/" : folder.slice(0, idx);
  };

  // Collapse relevance mirrors the merge gate below: parent != root, parent
  // depth >= collapseDepth, >= COLLAPSE_MIN_CHILDREN in-run siblings. Those
  // folders (members AND merge targets) need the full blob — merged data
  // must sum complete term maps, and children removed by a deeper merge only
  // shrink a group, so relevance computed pre-collapse never misses one.
  const relevant = new Set<string>();
  if (collapse) {
    const childCount = new Map<string, number>();
    for (const folder of live) {
      if (folder === "/") continue;
      const parent = parentOf(folder);
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
    for (const folder of live) {
      if (folder === "/") continue;
      const parent = parentOf(folder);
      if (
        parent !== "/" &&
        folderDepth(parent) >= collapseDepth &&
        (childCount.get(parent) ?? 0) >= COLLAPSE_MIN_CHILDREN
      ) {
        relevant.add(folder);
        relevant.add(parent);
      }
    }
  }

  // ── Sync phase: re-tokenize changed notes, re-aggregate touched ─────
  const storedNotes = wipe
    ? new Map<
        string,
        { path: string; folder: string; mtime: number; size: number }
      >()
    : new Map(store.noteMeta().map((m) => [m.path, m]));
  const storedByFolder = new Map<string, string[]>();
  for (const m of storedNotes.values()) {
    let list = storedByFolder.get(m.folder);
    if (!list) {
      list = [];
      storedByFolder.set(m.folder, list);
    }
    list.push(m.path);
  }
  const storedFolders = wipe
    ? new Map<string, boolean>()
    : new Map(store.storedFolderInfo().map((r) => [r.path, r.hasFull]));

  const toAggregate: string[] = [];
  for (const [folder, list] of folderFiles) {
    let dirty = storedFolders.get(folder) === undefined;
    if (!dirty) {
      for (const f of list) {
        const s = storedNotes.get(f);
        const g = sigs.get(f);
        if (!s || s.mtime !== g?.mtime || s.size !== g?.size) {
          dirty = true;
          break;
        }
      }
    }
    if (!dirty) {
      for (const p of storedByFolder.get(folder) ?? []) {
        if (!sigs.has(p)) {
          dirty = true;
          break;
        }
      }
    }
    if (
      dirty ||
      (relevant.has(folder) && storedFolders.get(folder) === false)
    ) {
      // dirty: a note was added/edited/removed — re-aggregate (re-reading
      // note blobs, re-tokenizing only what changed). Not dirty but newly
      // collapse-relevant without a full blob: re-aggregate for the blob —
      // note blobs suffice, no tokenization.
      toAggregate.push(folder);
    }
  }
  const foldersToDelete: string[] = [];
  for (const folder of storedFolders.keys()) {
    // Beyond-depth rows are carried over: the bounded walk cannot verify
    // them and a deeper run reuses them untouched.
    if (!live.has(folder) && folderDepth(folder) <= maxDepth) {
      foldersToDelete.push(folder);
    }
  }

  if (wipe || toAggregate.length > 0 || foldersToDelete.length > 0) {
    store.beginWrite();
    try {
      if (wipe) {
        store.resetData(
          OVERVIEW_CACHE_VERSION,
          ignoreFingerprint,
          templatesFolder,
        );
        store.setColdInterning(true);
      } else {
        store.setMeta(ignoreFingerprint, templatesFolder);
      }
      const dense: DenseAgg = {
        w: new Int32Array(store.maxTermId() + 16),
        b: new Int32Array(store.maxTermId() + 16),
        lc: new Int32Array(store.maxTermId() + 16),
        seen: new Uint8Array(store.maxTermId() + 16),
      };
      for (const folder of toAggregate) {
        const list = folderFiles.get(folder) ?? [];
        const listSet = new Set(list);
        // Notes attributed to this folder that no longer belong to it
        // (deleted, moved, or newly scaffold-skipped). The folder guard in
        // the DELETE makes a row re-attributed by another folder's upsert
        // this run immune.
        for (const p of storedByFolder.get(folder) ?? []) {
          if (!listSet.has(p)) store.deleteNote(p, folder);
        }
        const getRecord = (file: string): NoteRecord => {
          const s = storedNotes.get(file);
          const g = sigs.get(file) as OverviewFileSig;
          const stored = store.getNote(file);
          if (stored && s && s.mtime === g.mtime && s.size === g.size) {
            if (s.folder !== folder) {
              // Same file, different folder attribution (moved): the blob
              // is still valid — re-attribute it instead of re-tokenizing.
              store.upsertNote(
                file,
                folder,
                s.mtime,
                s.size,
                stored.skip,
                stored.tags,
                stored.heads,
                stored.data,
              );
            }
            return {
              skip: stored.skip === 1,
              tags: JSON.parse(stored.tags) as string[],
              heads: JSON.parse(stored.heads) as [string, number[]][],
              data: stored.data === null ? null : i32(stored.data),
            };
          }
          const rec = extractNoteRecord(vaultPath, file, store);
          store.upsertNote(
            file,
            folder,
            g.mtime,
            g.size,
            rec.skip ? 1 : 0,
            JSON.stringify(rec.tags),
            JSON.stringify(rec.heads),
            rec.data === null ? null : u8(rec.data),
          );
          return rec;
        };
        const agg = aggregateFolder(
          store,
          folder,
          list,
          getRecord,
          relevant.has(folder),
          dense,
        );
        store.upsertFolder(
          folder,
          agg.notes,
          JSON.stringify(agg.tags),
          JSON.stringify(agg.warn),
          u8(agg.tfids),
          u8(agg.cand),
          agg.full === null ? null : u8(agg.full),
        );
      }
      for (const folder of foldersToDelete) store.deleteFolder(folder);
      store.flushColdTerms();
      store.saveFlags();
      store.endWrite(true);
      store.setColdInterning(false);
    } catch (err) {
      store.endWrite(false);
      store.setColdInterning(false);
      throw err;
    }
  }

  // ── Read phase: df from tfids blobs, collapse, score ───────────────
  return store.readSnapshot(() => {
    const rowByPath = new Map(
      store.folderRows().map((r) => [r.path, r] as const),
    );
    const run: StoredFolderRow[] = [];
    for (const folder of live) {
      const row = rowByPath.get(folder);
      if (row === undefined) {
        throw new Error("overview store missing folder row: " + folder);
      }
      run.push(row);
    }
    const runSet = new Set(run.map((r) => r.path));

    // Document frequency over the run's folders — exact by construction.
    const df = new Int32Array(store.maxTermId() + 1);
    for (const r of run) {
      const ids = i32(r.tfids);
      for (let i = 0; i < ids.length; i++) df[ids[i]]++;
    }

    // ── Collapse decision (mirror of collapseHomogeneousSiblings) ──
    const removed = new Set<string>();
    const mergedData = new Map<string, IdFolderData>();
    const collapsedCounts = new Map<string, number>();
    // Run folders whose stored df contribution is replaced by a merged
    // row: absorbed children and merge-target parents.
    const dfAdjusted = new Set<string>();

    const dataOf = (p: string): IdFolderData | undefined => {
      const merged = mergedData.get(p);
      if (merged) return merged;
      if (removed.has(p)) return undefined;
      const row = rowByPath.get(p);
      if (!row || !runSet.has(p)) return undefined;
      const blob = store.folderFull(p);
      if (blob === null) {
        throw new Error("overview store missing full blob: " + p);
      }
      return decodeFullBlob(
        blob,
        new Set(JSON.parse(row.tags) as string[]),
        row.notes,
      );
    };

    if (collapse) {
      const byParent = new Map<string, string[]>();
      for (const r of run) {
        if (r.path === "/") continue;
        const parent = parentOf(r.path);
        let list = byParent.get(parent);
        if (!list) {
          list = [];
          byParent.set(parent, list);
        }
        list.push(r.path);
      }
      // Deepest parents first so collapses can cascade upward.
      const parents = [...byParent.keys()].sort(
        (a, b) => b.split("/").length - a.split("/").length,
      );

      for (const parent of parents) {
        if (parent === "/" || folderDepth(parent) < collapseDepth) continue;
        const children = (byParent.get(parent) || []).filter(
          (c) => runSet.has(c) && !removed.has(c),
        );
        if (children.length < COLLAPSE_MIN_CHILDREN) continue;

        const cap = Math.min(children.length, COLLAPSE_PAIRWISE_CAP);
        const tops: Int32Array[] = [];
        for (let i = 0; i < cap; i++) {
          const d = dataOf(children[i]);
          tops.push(d ? d.top : new Int32Array(0));
        }
        let sum = 0;
        let pairs = 0;
        for (let i = 0; i < cap; i++) {
          for (let j = i + 1; j < cap; j++) {
            sum += topPairsCosine(tops[i], tops[j]);
            pairs++;
          }
        }
        if (pairs === 0 || sum / pairs < COLLAPSE_SIMILARITY) continue;

        const toMerge: IdFolderData[] = [];
        let mergedFolderCount = 0;
        for (const child of children) {
          const d = dataOf(child);
          if (!d) continue;
          toMerge.push(d);
          mergedFolderCount += 1 + (collapsedCounts.get(child) || 0);
          removed.add(child);
          mergedData.delete(child);
          collapsedCounts.delete(child);
          dfAdjusted.add(child);
        }
        const existing = dataOf(parent);
        if (existing && runSet.has(parent) && !mergedData.has(parent)) {
          dfAdjusted.add(parent);
        }
        const merged = existing
          ? mergeIdFolderData([existing, ...toMerge])
          : mergeIdFolderData(toMerge);
        mergedData.set(parent, merged);
        collapsedCounts.set(
          parent,
          (collapsedCounts.get(parent) || 0) + mergedFolderCount,
        );
      }
    }

    // Apply the collapse correction to df: stored contributions of removed
    // children and replaced parents out, merged unions in.
    for (const folder of dfAdjusted) {
      const row = rowByPath.get(folder);
      if (!row) continue;
      const ids = i32(row.tfids);
      for (let i = 0; i < ids.length; i++) df[ids[i]]--;
    }
    for (const data of mergedData.values()) {
      for (let i = 0; i < data.tf.length; i += 2) df[data.tf[i]]++;
    }

    // ── Final row list (same ordering rules as buildOverviewRows) ──
    interface Entry {
      path: string;
      notes: number;
      row?: StoredFolderRow;
      data?: IdFolderData;
    }
    const entries: Entry[] = [];
    for (const r of run) {
      if (removed.has(r.path)) continue;
      const merged = mergedData.get(r.path);
      entries.push(
        merged
          ? { path: r.path, notes: merged.noteCount, data: merged }
          : { path: r.path, notes: r.notes, row: r },
      );
    }
    for (const [p, d] of mergedData) {
      if (!runSet.has(p)) {
        entries.push({ path: p, notes: d.noteCount, data: d });
      }
    }
    entries.sort((a, b) => {
      if (maxRows > 0) {
        const depthDiff = folderDepth(a.path) - folderDepth(b.path);
        if (depthDiff !== 0) return depthDiff;
        if (a.notes !== b.notes) return b.notes - a.notes;
      }
      return a.path.localeCompare(b.path);
    });
    const totalFolders = entries.length;

    // Warnings replay in cold order: folder listing order, then file order —
    // exactly what each folder stored when it was (re)aggregated.
    const warnings: string[] = [];
    for (const r of run) {
      for (const w of JSON.parse(r.warn) as string[]) warnings.push(w);
    }

    // A capped listing only needs keywords on the rows that survive the
    // cut: the sort keys (depth, notes, path) are known without scoring.
    const scored =
      maxRows > 0 ? Math.min(maxRows, entries.length) : entries.length;
    const flags = store.flags();
    const folders: OverviewFolder[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let keywords: string[] = [];
      if (i < scored) {
        if (e.data) {
          // Merged parent: candidacy is recomputed over merged heading
          // signals (folder-local checks on the merged data).
          const folderTokenIds = new Set(
            store.idsForTerms([...folderKeywordTokens(e.path)]).values(),
          );
          const head = e.data.head;
          const headOnly = e.data.headOnly;
          const filter = (id: number, tf: number): boolean => {
            const flag = flags[id];
            if (flag & 1) {
              if (tf < 2 || flag & 2) return false;
            } else if (folderTokenIds.has(id)) {
              return false;
            }
            return !headOnly.has(id) || (head.get(id) || 0) >= 2;
          };
          keywords = selectKeywordsById(
            store,
            e.data.tf,
            df,
            totalFolders,
            maxKeywords,
            filter,
          );
        } else if (e.row) {
          keywords = selectKeywordsById(
            store,
            i32(e.row.cand),
            df,
            totalFolders,
            maxKeywords,
            null,
          );
        }
      }
      const tags = e.data
        ? [...e.data.tags].sort()
        : [...(JSON.parse(e.row?.tags ?? "[]") as string[])].sort();
      folders.push({
        path: e.path,
        notes: e.notes,
        keywords,
        tags,
        ...(collapsedCounts.has(e.path)
          ? { collapsedFolders: collapsedCounts.get(e.path) }
          : {}),
      });
    }

    return { folders, warnings };
  });
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

  // The per-folder data store: SQLite (.napkin/cache/overview-v2.db, #118)
  // by default; the JSON per-folder cache is the fallback for environments
  // where SQLite cannot be used — same rule as the search store. Any store
  // error reports the failure and falls back for this run.
  let folders: OverviewFolder[] = [];
  let warnings: string[] = [];
  let foldersCache: OverviewFoldersCacheData | null = null;
  const store = createOverviewStore(configPath);
  let storeDone = false;
  if (store !== null) {
    try {
      const out = overviewFromStore(
        store,
        contentPath,
        ignoreFingerprint,
        templatesFolder,
        maxDepth,
        maxKeywords,
        collapse,
        collapseDepth,
        maxRows,
        folderFiles,
        sigs,
      );
      folders = out.folders;
      warnings = out.warnings;
      storeDone = true;
    } catch (err) {
      reportOverviewStoreFailure(configPath, store, err);
    }
  }
  if (!storeDone) {
    const collected = collectFolderData(
      contentPath,
      configPath,
      ignoreFingerprint,
      templatesFolder,
      maxDepth,
      folderFiles,
      sigs,
    );
    folders = buildOverviewRows(
      collected.folderData,
      collected.terms,
      maxKeywords,
      collapse,
      collapseDepth,
      maxRows,
    );
    warnings = collected.warnings;
    foldersCache = collected.cache;
  }

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
    foldersCache,
  );
  return result;
}

// Exported for differential testing against the pre-optimization oracle
// (src/core/__tests__/overview.equivalence.test.ts). Not public API.
export { stripNoise as _stripNoise, termCounts as _termCounts };
