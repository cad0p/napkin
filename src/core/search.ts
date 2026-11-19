import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";
import { loadConfig } from "../utils/config.js";
import { listFiles, SKIP_DIRS } from "../utils/files.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import {
  createIndexStore,
  type IndexDiffDoc,
  type IndexSnapshot,
  type IndexStore,
  isQueryableIndexStore,
  type QueryableIndexStore,
  reportIndexStoreFailure,
  resetIndexStoresForTests,
} from "../utils/index-store.js";
import { JsonStore } from "../utils/json-store.js";
import { extractLinks } from "../utils/markdown.js";
import { searchNames } from "../utils/name-search.js";
import {
  diffFileMtimes,
  type FileDiff,
  type FileMtimeEntry,
  type FileStatSig,
  type LinkTarget,
  linkTarget,
  statAllFiles,
} from "../utils/search-cache.js";
import {
  isFreshnessWindowOpen,
  markSearchWalkStale,
  recordSearchWalk,
  resetSearchFreshnessForTests,
  takeSearchFreshness,
} from "../utils/search-freshness.js";

/**
 * Maximum snippet lines returned per file. Prevents broad queries from
 * producing unbounded output when many matches exist in a single file.
 * Matches beyond this limit are still findable via `napkin read`.
 */
const MAX_SNIPPET_LINES_PER_FILE = 25;

/**
 * Weight for content term frequency in the composite score.
 * Calibrated so that a file with 10 content matches ≈ a basename BM25 hit.
 * Basename BM25 scores typically range 1-15; content TF × 0.05 keeps content
 * from drowning out title relevance while still surfacing content matches.
 */
const CONTENT_TF_WEIGHT = 0.05;
const BASENAME_BOOST = 2;
const BACKLINK_WEIGHT = 0.5;
const RECENCY_WEIGHT = 1.0;

/**
 * Minimum interval between two disk-cache writes for the same cache key.
 *
 * A long-lived process (the pi extension) re-searches while notes churn: an
 * incremental diff on every query would rewrite a multi-MB cache far more
 * often than needed. The first write after the window is immediate (leading
 * edge — that is what makes a one-shot CLI search persist at all); anything
 * inside the window coalesces into a single trailing write.
 */
const CACHE_WRITE_INTERVAL_MS = 30_000;

export interface SearchResult {
  file: string;
  score: number;
  links: number;
  modified: string;
  snippets: { line: number; text: string }[];
}

export interface SearchOptions {
  path?: string;
  limit?: number;
  contextLines?: number;
  snippets?: boolean;
  page?: number;
  /**
   * Freshness window for the vault stat walk, in milliseconds (#93).
   *
   * Inside the window a search reuses the index this process already built
   * instead of listing and statting every note, so a query costs a basename
   * BM25 lookup plus the content scan. Writes made through napkin in this
   * process are still picked up (their paths are re-stat'd); writes made by
   * OTHER processes become visible after at most this window.
   *
   * `0` (the default, and the CLI behaviour) validates against disk on every
   * search. Overrides `search.freshnessMs` from the vault config.
   */
  freshnessMs?: number;
}

export interface PaginatedSearchResults {
  results: SearchResult[];
  totalPages: number;
  currentPage: number;
  totalResults: number;
}

interface DocRecord {
  /** Vault-relative file path (used as id). */
  file: string;
  basename: string;
  mtime: number;
  size: number;
  /** Outgoing wikilink targets (for backlink recompute on incremental). */
  outgoingLinks: string[];
}

/**
 * Link tallies that let the incremental diff update backlink counts by delta
 * (#92) instead of re-resolving every link in the vault.
 *
 * `backlinkCounts` is the resolved per-file result; these two maps hold the
 * same links grouped by target key instead of by resolution, so a change to
 * one basename's path set can be re-resolved without walking every doc:
 *  - bare-name link `[[note]]` → key "note"
 *  - path link `[[folder/note]]` → key "note", ref "folder/note.md"
 * Occurrences are counted (duplicates count twice, as before). Keys and refs
 * come from the owned targets in DocRecord, so no note text is retained.
 * Memory-only: derived from `docs` when a cache is loaded, never persisted.
 */
interface LinkCounterState {
  /** bare-name target key → link occurrences across all docs. */
  bareLinkCounts: Map<string, number>;
  /** path target key → (ref as written → link occurrences). */
  pathLinkCounts: Map<string, Map<string, number>>;
}

const BASENAME_INDEX_OPTIONS = {
  fields: ["basename"],
  storeFields: ["file"],
  idField: "file",
  searchOptions: {
    boost: { basename: BASENAME_BOOST },
    fuzzy: 0.2,
    prefix: true,
  },
};

// ── In-memory index cache (module scope) ─────────────────────────
// Adapts Omnisearch's plugin-scope model to napkin's process scope.
// A long-lived process (e.g. the pi extension) benefits when the same vault
// is searched repeatedly; a short-lived `napkin` CLI invocation sees no
// benefit (and no harm) since the cache dies with the process.
//
// The hybrid architecture: MiniSearch indexes ONLY `basename` (fast ~84ms
// build for 2700 files), while content matching is a substring scan that
// streams each note from disk at query time. This avoids the ~8s cost of
// indexing full content into MiniSearch's inverted index and — since #85 —
// keeps note text out of this cache entirely: one process on a large vault
// would otherwise retain hundreds of MB of UTF-16 note text for its life.
interface CachedVaultIndex extends LinkCounterState {
  basenameIndex: MiniSearch;
  docs: Map<string, DocRecord>;
  backlinkCounts: Map<string, number>;
  fileMtimes: Map<string, FileStatSig>;
  /**
   * basename (lowercase) → vault-relative paths, shallowest first. Kept in
   * memory so a diff only touches the groups it changed (#92); derived from
   * `docs` on load, never persisted.
   */
  basenameMap: Map<string, string[]>;
}

const memoryCache = new Map<string, CachedVaultIndex>();

function memoryCacheKey(contentPath: string, ignoreFp: string): string {
  return `${contentPath}\0${ignoreFp}`;
}

/** Per cache key: when this process last wrote the disk cache. */
const lastCacheWriteAt = new Map<string, number>();

/**
 * Per cache key: the pending trailing write scheduled by the throttle.
 * At most one timer per key — a second dirty diff inside the window only
 * refreshes the state the timer will serialize.
 */
interface PendingCacheWrite {
  timer: NodeJS.Timeout;
  store: IndexStore;
  state: CachedVaultIndex;
  ignoreFp: string;
}
const pendingCacheWrites = new Map<string, PendingCacheWrite>();

/** Drop a scheduled trailing write, if any. */
function cancelPendingWrite(cacheKey: string): void {
  const pending = pendingCacheWrites.get(cacheKey);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCacheWrites.delete(cacheKey);
}

/**
 * Test-only hook: simulate a fresh process by dropping the in-memory cache
 * AND the throttle bookkeeping (a stale write timestamp or pending trailing
 * write would otherwise leak into the next test in the same file).
 */
export function resetSearchIndexForTests(): void {
  for (const cacheKey of [...pendingCacheWrites.keys()]) {
    cancelPendingWrite(cacheKey);
  }
  lastCacheWriteAt.clear();
  memoryCache.clear();
  resetSearchFreshnessForTests();
  resetIndexStoresForTests();
}

/**
 * Test-only hook: the live in-memory record for a cached file, so tests can
 * assert what the cache retains (no note text — #85). Not exported by the SDK.
 */
export function getCachedDocForTests(
  contentPath: string,
  file: string,
): DocRecord | undefined {
  for (const [cacheKey, cache] of memoryCache) {
    if (cacheKey.startsWith(`${contentPath}\0`)) {
      return cache.docs.get(file);
    }
  }
  // SQLite-backed (#109): nothing is cached in memory, the signature lives
  // in the store. Test vaults use the content path as their config dir.
  const store = createIndexStore(contentPath);
  if (isQueryableIndexStore(store) && "fileForTests" in store) {
    const row = (store as unknown as SqliteStoreTestView).fileForTests(file);
    store.release();
    if (row) {
      return {
        ...row,
        basename: path.basename(file, ".md"),
        outgoingLinks: [],
      };
    }
  }
  return undefined;
}

interface SqliteStoreTestView {
  phantomRefCountsForTests?(): Map<string, number>;
  fileForTests(
    file: string,
  ): { file: string; mtime: number; size: number } | undefined;
}

/** Test-only: whether the in-memory cache holds an index for the vault. */
export function hasMemoryIndexForTests(contentPath: string): boolean {
  for (const cacheKey of memoryCache.keys()) {
    if (cacheKey.startsWith(`${contentPath}\0`)) return true;
  }
  return false;
}

/**
 * Test-only hook: raw basename BM25 scores for a query, resolved exactly the
 * way `searchVault` resolves the index (so an incremental diff is applied
 * first). `searchVault` rounds the composite score to one decimal, which
 * hides sub-0.05 drift between an incrementally updated index and a cold
 * build; a test that pins that parity needs the unrounded BM25 scores (#100).
 * Not exported by the SDK.
 */
export function getBasenameScoresForTests(
  contentPath: string,
  configPath: string,
  query: string,
): Map<string, number> {
  const config = loadConfig(configPath);
  const { ignorer, fingerprint } = loadIgnorer(contentPath, configPath);
  const freshnessMs = resolveFreshnessMs(config.search.freshnessMs, undefined);
  const store = createIndexStore(configPath);
  if (isQueryableIndexStore(store)) {
    try {
      refreshStore(store, contentPath, ignorer, fingerprint, freshnessMs);
      return searchNames(store, query);
    } finally {
      store.release();
    }
  }
  const { basenameIndex } = resolveVaultIndex(
    contentPath,
    configPath,
    ignorer,
    fingerprint,
    freshnessMs,
  );
  const scores = new Map<string, number>();
  for (const result of basenameIndex.search(query)) {
    scores.set(result.id as string, result.score);
  }
  return scores;
}

/**
 * Test-only hook: a copy of the live backlink counts, so a test can compare
 * the incremental delta against a full recompute. Not exported by the SDK.
 */
export function getCachedBacklinkCountsForTests(
  contentPath: string,
): Map<string, number> | undefined {
  for (const [cacheKey, cache] of memoryCache) {
    if (cacheKey.startsWith(`${contentPath}\0`)) {
      return new Map(cache.backlinkCounts);
    }
  }
  // SQLite-backed (#109): resolve every file's count from link_counts.
  const store = createIndexStore(contentPath);
  if (!isQueryableIndexStore(store)) return undefined;
  try {
    const files = [...store.scanPaths(null)];
    const counts = new Map<string, number>();
    for (const [file, info] of store.hitInfo(files)) {
      if (info.links !== 0) counts.set(file, info.links);
    }
    const phantoms = (store as unknown as SqliteStoreTestView)
      .phantomRefCountsForTests;
    if (phantoms) {
      for (const [ref, n] of phantoms.call(store)) counts.set(ref, n);
    }
    return counts;
  } finally {
    store.release();
  }
}

// ── Index building (cold path) ────────────────────────────────────

interface BuildResult extends LinkCounterState {
  docs: Map<string, DocRecord>;
  backlinkCounts: Map<string, number>;
  fileMtimes: Map<string, FileStatSig>;
  basenameMap: Map<string, string[]>;
  basenameIndex: MiniSearch;
}

/**
 * Copy a string into a flat, self-owned V8 string.
 *
 * Wikilink targets are regex captures + trimmed slices: V8 keeps them as
 * sliced/thin strings that retain their parent — the whole note text. Those
 * targets live in the index for the process lifetime, so a single link per
 * note would keep every note's content alive and defeat #85 (measured: 510 MB
 * retained on a 28.7k-note vault even after DocRecord.content was removed).
 * Re-encoding through a Buffer yields a fresh sequential string that owns its
 * bytes. Link targets are tiny, so the copy is cheap.
 */
function ownString(value: string): string {
  return Buffer.from(value, "utf-8").toString("utf-8");
}

/**
 * Read one note's metadata for the index.
 *
 * The file is read once to extract outgoing wikilinks, then the text is
 * dropped: the memory cache and the disk cache hold metadata only (#85).
 * Content is read again, per query, by `contentScan` and snippet extraction.
 */
function readDoc(vaultPath: string, file: string): DocRecord {
  const fullPath = path.join(vaultPath, file);
  const content = fs.readFileSync(fullPath, "utf-8");
  const stat = fs.statSync(fullPath);
  const basename = path.basename(file, ".md");
  const { wikilinks } = extractLinks(content);
  return {
    file,
    basename,
    mtime: stat.mtimeMs,
    size: stat.size,
    // Own the targets: see ownString — sliced strings would retain content.
    outgoingLinks: wikilinks.map(ownString),
  };
}

/**
 * Read a note's text for the content scan or snippet extraction.
 * Returns null when the file vanished or became unreadable after the index
 * walk — the caller treats it as a non-match / empty snippet rather than
 * failing the whole search.
 */
function readNoteContent(vaultPath: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(vaultPath, file), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read all docs, build a basename-only MiniSearch index, and compute backlink
 * counts in-memory from already-read content.
 *
 * The basename map (basename → [paths]) lets us resolve wikilinks via O(1)
 * Map lookup instead of the old O(n²) `resolveFileLoose` → `findMatches` →
 * `listFiles` walk. Shallowest-path-first tie-break matches the old semantics.
 *
 * Content is NOT indexed into MiniSearch — that takes ~8s for 26MB. Instead,
 * content matching is done at query time by reading each note from disk and
 * scanning it, then dropping the text. This trades ~8s cold index build for
 * a per-query disk scan (the OS page cache keeps the bytes shared and
 * reclaimable across processes), and retains no note text in memory.
 */
function buildDocsAndBacklinks(
  vaultPath: string,
  ignore?: Ignorer,
): BuildResult {
  const files = listFiles(vaultPath, { ext: "md", ignore });

  const docsArr: DocRecord[] = [];
  const fileMtimes = new Map<string, FileStatSig>();

  for (const file of files) {
    const doc = readDoc(vaultPath, file);
    docsArr.push(doc);
    fileMtimes.set(doc.file, { mtime: doc.mtime, size: doc.size });
  }

  const basenameMap = buildBasenameMap(docsArr);
  const links = recomputeAllLinks(docsArr, basenameMap);

  // Build basename-only MiniSearch index (fast: ~84ms for 2700 files).
  const basenameIndex = rebuildBasenameIndex(docsArr);

  return {
    docs: new Map(docsArr.map((d) => [d.file, d])),
    ...links,
    fileMtimes,
    basenameMap,
    basenameIndex,
  };
}

/**
 * Order basename paths shallowest-first for the wikilink resolve tie-break.
 * Depth is the documented rule; equal depths fall back to lexical order —
 * the order `listFiles` produces — so an incrementally maintained map stays
 * identical to a cold build (a stable sort on insertion order would drift
 * after deletes and re-adds).
 */
function sortByDepth(paths: string[]): void {
  paths.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) return depth;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** basename (lowercase) → vault-relative paths, shallowest first. */
function buildBasenameMap(docs: Iterable<DocRecord>): Map<string, string[]> {
  const basenameMap = new Map<string, string[]>();
  for (const doc of docs) {
    const key = doc.basename.toLowerCase();
    const existing = basenameMap.get(key);
    if (existing) existing.push(doc.file);
    else basenameMap.set(key, [doc.file]);
  }
  for (const paths of basenameMap.values()) {
    if (paths.length > 1) sortByDepth(paths);
  }
  return basenameMap;
}

/**
 * Resolve a classified target against the basename map.
 * Mirrors `findMatches` + `resolveFileLoose` semantics:
 *  - "path/with/slash" or "*.md" → the ref itself, when any file with that
 *    basename exists
 *  - bare name → basename match, shallowest path wins on ambiguity
 */
function resolveLink(
  basenameMap: Map<string, string[]>,
  link: LinkTarget,
): string | null {
  if (link.ref !== null) return basenameMap.has(link.key) ? link.ref : null;
  return basenameMap.get(link.key)?.[0] ?? null;
}

/** Add one link occurrence to the per-target-key tallies. */
function addLinkCounter(
  bareLinkCounts: Map<string, number>,
  pathLinkCounts: Map<string, Map<string, number>>,
  link: LinkTarget,
): void {
  if (link.ref === null) {
    bareLinkCounts.set(link.key, (bareLinkCounts.get(link.key) ?? 0) + 1);
    return;
  }
  let refs = pathLinkCounts.get(link.key);
  if (!refs) {
    refs = new Map();
    pathLinkCounts.set(link.key, refs);
  }
  refs.set(link.ref, (refs.get(link.ref) ?? 0) + 1);
}

/** Remove one link occurrence, dropping empty counters. */
function removeLinkCounter(
  bareLinkCounts: Map<string, number>,
  pathLinkCounts: Map<string, Map<string, number>>,
  link: LinkTarget,
): void {
  if (link.ref === null) {
    const next = (bareLinkCounts.get(link.key) ?? 0) - 1;
    if (next > 0) bareLinkCounts.set(link.key, next);
    else bareLinkCounts.delete(link.key);
    return;
  }
  const refs = pathLinkCounts.get(link.key);
  if (!refs) return;
  const next = (refs.get(link.ref) ?? 0) - 1;
  if (next > 0) {
    refs.set(link.ref, next);
    return;
  }
  refs.delete(link.ref);
  if (refs.size === 0) pathLinkCounts.delete(link.key);
}

/** Apply a signed change to a resolved per-file count, keeping no zeros. */
function bumpCount(
  counts: Map<string, number>,
  file: string,
  delta: number,
): void {
  const next = (counts.get(file) ?? 0) + delta;
  if (next === 0) counts.delete(file);
  else counts.set(file, next);
}

/** Resolved backlink counts plus the tallies that produced them. */
interface LinkCounts extends LinkCounterState {
  backlinkCounts: Map<string, number>;
}

/**
 * Resolve the per-target-key tallies into per-file counts. O(distinct target
 * keys + path refs) instead of O(link occurrences), and the same answer:
 * every bare link to a key lands on its shallowest path, and every path ref
 * lands on its own spelling while its basename exists.
 */
function resolveAllCounts(
  basenameMap: Map<string, string[]>,
  tallies: LinkCounterState,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, occurrences] of tallies.bareLinkCounts) {
    const first = basenameMap.get(key)?.[0];
    if (first !== undefined) {
      counts.set(first, (counts.get(first) ?? 0) + occurrences);
    }
  }
  for (const [key, refs] of tallies.pathLinkCounts) {
    if (!basenameMap.has(key)) continue;
    for (const [ref, occurrences] of refs) {
      counts.set(ref, (counts.get(ref) ?? 0) + occurrences);
    }
  }
  return counts;
}

/** Full pass over every doc's links — the cold path and the delta fallback. */
function recomputeAllLinks(
  docs: Iterable<DocRecord>,
  basenameMap: Map<string, string[]>,
): LinkCounts {
  const bareLinkCounts = new Map<string, number>();
  const pathLinkCounts = new Map<string, Map<string, number>>();
  for (const doc of docs) {
    for (const target of doc.outgoingLinks) {
      addLinkCounter(bareLinkCounts, pathLinkCounts, linkTarget(target));
    }
  }
  const tallies = { bareLinkCounts, pathLinkCounts };
  return {
    ...tallies,
    backlinkCounts: resolveAllCounts(basenameMap, tallies),
  };
}

// ── Snippet extraction ───────────────────────────────────────────

function extractSnippets(
  content: string,
  query: string,
  contextLines: number,
  maxSnippetLines?: number,
): { line: number; text: string }[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const lines = content.split("\n");
  const matchedLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      matchedLines.add(i);
    }
  }

  const ranges: [number, number][] = [];
  for (const lineIdx of [...matchedLines].sort((a, b) => a - b)) {
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(lines.length - 1, lineIdx + contextLines);
    if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = Math.max(
        ranges[ranges.length - 1][1],
        end,
      );
    } else {
      ranges.push([start, end]);
    }
  }

  const matchedLineCount = matchedLines.size;
  const snippets: { line: number; text: string }[] = [];
  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      snippets.push({ line: i + 1, text: line });
      if (maxSnippetLines && snippets.length >= maxSnippetLines) {
        const shownMatches = new Set<number>();
        for (const s of snippets) {
          if (matchedLines.has(s.line - 1)) shownMatches.add(s.line - 1);
        }
        const remaining = matchedLineCount - shownMatches.size;
        if (remaining > 0) {
          snippets.push({
            line: 0,
            text: `... ${remaining} more match${remaining === 1 ? "" : "es"} in this file`,
          });
        }
        return snippets;
      }
    }
  }

  return snippets;
}

function relativeTime(mtimeMs: number): string {
  const diff = Date.now() - mtimeMs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ── Content scan (hybrid search) ──────────────────────────────────

/**
 * Scan note text for query terms, returning term frequency per file.
 *
 * Each candidate note is read from disk, lowercased, counted, and dropped —
 * one file at a time, nothing retained (#85). The OS page cache holds the
 * raw bytes once for every process, instead of each process holding a
 * separate UTF-16 copy. Still far cheaper than building a MiniSearch content
 * index (~8s) on every cold build.
 *
 * Uses case-insensitive substring matching (matches napkin's prior
 * `extractSnippets` behavior and MiniSearch's `prefix: true` recall). A
 * file deleted or made unreadable between the index walk and this scan is
 * skipped silently.
 */
function contentScan(
  contentPath: string,
  files: Iterable<string>,
  terms: string[],
): Map<string, number> {
  const tf = new Map<string, number>();
  if (terms.length === 0) return tf;
  const lowerTerms = terms.map((t) => t.toLowerCase());
  for (const file of files) {
    const content = readNoteContent(contentPath, file);
    if (content === null) continue;
    const lo = content.toLowerCase();
    let total = 0;
    for (const term of lowerTerms) {
      const i = 0;
      let count = 0;
      const len = term.length;
      // Fast path: single-char terms use split (faster than indexOf loop)
      if (len <= 1) {
        count = lo.split(term).length - 1;
      } else {
        let idx = i;
        for (;;) {
          idx = lo.indexOf(term, idx);
          if (idx === -1) break;
          count++;
          idx += len;
        }
      }
      total += count;
    }
    if (total > 0) tf.set(file, total);
  }
  return tf;
}

// ── Vault index resolution (cold / warm / incremental) ───────────

interface ResolvedIndex {
  basenameIndex: MiniSearch;
  docs: Map<string, DocRecord>;
  backlinkCounts: Map<string, number>;
}

/**
 * Resolve the vault index:
 *   1. Check the in-memory cache (long-lived process fast path).
 *   2. Otherwise ask the index store: if it holds a snapshot, load the
 *      basename index + metadata, and apply an incremental diff (discard
 *      removed, add/replace changed).
 *   3. Otherwise (cold) build from scratch.
 *
 * In all cases the result is kept in the in-memory cache for reuse, and a
 * non-empty incremental diff is persisted (throttled) so the next process
 * does not have to re-read the changed notes.
 */
function resolveVaultIndex(
  contentPath: string,
  configPath: string,
  ignorer: Ignorer,
  ignoreFp: string,
  freshnessMs: number,
  storeOverride?: IndexStore,
): ResolvedIndex {
  // One index per vault (#87): folder scoping is a query-time filter in
  // searchVault, so the memory key and the store never depend on a folder.
  const memKey = memoryCacheKey(contentPath, ignoreFp);
  // The store choice lives behind this call (#94): search.ts never learns
  // whether the snapshot comes from a JSON file or a SQLite database.
  const store = storeOverride ?? createIndexStore(configPath);

  const cached = memoryCache.get(memKey);
  if (cached) {
    return applyIncrementalOrCached(
      contentPath,
      store,
      memKey,
      cached,
      ignoreFp,
      ignorer,
      freshnessMs,
    );
  }

  const diskCache = store.load();
  // A stored snapshot is only valid when it holds a whole-vault view
  // (folder === null; older per-folder caches are treated as a miss and
  // replaced) AND the ignore state matches the current fingerprint — an
  // ignore change can hide/unhide files that incremental diffing against
  // fileMtimes would miss.
  if (
    diskCache &&
    diskCache.folder === null &&
    diskCache.ignoreFingerprint === ignoreFp
  ) {
    const loaded = loadFromDiskCache(diskCache);
    if (loaded) {
      memoryCache.set(memKey, loaded);
      return applyIncrementalOrCached(
        contentPath,
        store,
        memKey,
        loaded,
        ignoreFp,
        ignorer,
        freshnessMs,
      );
    }
  }

  // Cold path — build the whole-vault index from scratch and persist.
  const built = buildDocsAndBacklinks(contentPath, ignorer);
  const fresh: CachedVaultIndex = {
    basenameIndex: built.basenameIndex,
    docs: built.docs,
    backlinkCounts: built.backlinkCounts,
    fileMtimes: built.fileMtimes,
    basenameMap: built.basenameMap,
    bareLinkCounts: built.bareLinkCounts,
    pathLinkCounts: built.pathLinkCounts,
  };
  memoryCache.set(memKey, fresh);
  // A cold build reads every note, so it is a walk: record it for the
  // freshness window (#93).
  recordSearchWalk(contentPath, memKey);
  // A JSON store writes through the throttle (the leading edge fires
  // immediately anyway, and a follow-up diff coalesces); an incremental
  // store takes the bulk snapshot directly — a diff write never needs the
  // throttle (#106).
  persistBuiltIndex(store, memKey, fresh, ignoreFp);
  return {
    basenameIndex: fresh.basenameIndex,
    docs: fresh.docs,
    backlinkCounts: fresh.backlinkCounts,
  };
}

/** The cached view of a vault, when the diff found nothing to change. */
function cachedView(cache: CachedVaultIndex): ResolvedIndex {
  return {
    basenameIndex: cache.basenameIndex,
    docs: cache.docs,
    backlinkCounts: cache.backlinkCounts,
  };
}

/**
 * Bring the cached index up to date with the disk and persist it when anything
 * changed. Three ways through (#93):
 *
 *  - nothing pending and the last walk is inside the freshness window: return
 *    the cache as-is, with no I/O at all. This is the fast path a long-lived
 *    consumer hits on most queries.
 *  - paths this process wrote since the last search: re-stat just those and
 *    apply them through the incremental diff (read-your-writes inside the
 *    window), without a full walk.
 *  - otherwise: walk the vault and diff — the pre-#93 behaviour, and what a
 *    freshness window of 0 always does.
 */
function applyIncrementalOrCached(
  contentPath: string,
  store: IndexStore,
  memKey: string,
  cache: CachedVaultIndex,
  ignoreFp: string,
  ignorer: Ignorer,
  freshnessMs: number,
): ResolvedIndex {
  const pending = takeSearchFreshness(contentPath);

  if (
    !pending.forceWalk &&
    isFreshnessWindowOpen(contentPath, memKey, freshnessMs)
  ) {
    if (pending.dirty.length === 0) return cachedView(cache);
    const updated = applyDiffAndPersist(
      contentPath,
      store,
      memKey,
      cache,
      ignoreFp,
      diffFromDirtyPaths(
        contentPath,
        (file) => cache.fileMtimes.has(file),
        pending.dirty,
        ignorer,
      ),
    );
    return updated ?? cachedView(cache);
  }

  const updated = applyDiffAndPersist(
    contentPath,
    store,
    memKey,
    cache,
    ignoreFp,
    vaultDiff(contentPath, cache, ignorer),
  );
  // Recorded after the walk, so the window opens on a completed walk and
  // never hides a half-applied diff from the next search.
  recordSearchWalk(contentPath, memKey);
  // Without this the store only ever holds the cold snapshot, so every new
  // process re-reads everything added or edited since (#84).
  return updated ?? cachedView(cache);
}

/**
 * Apply one diff to the in-memory index and persist it to the store.
 * Returns null when the diff is empty.
 */
function applyDiffAndPersist(
  contentPath: string,
  store: IndexStore,
  memKey: string,
  cache: CachedVaultIndex,
  ignoreFp: string,
  diff: FileDiff,
): ResolvedIndex | null {
  const updated = applyDiff(contentPath, cache, diff);
  if (!updated) return null;
  persistAppliedDiff(store, memKey, cache, ignoreFp);
  return updated;
}

/**
 * Build a diff from the vault-relative paths this process wrote (#93).
 *
 * A dirty path is re-stat'd — and re-read — unconditionally: signature
 * equality is not a reason to trust the index for a file the process itself
 * just wrote, and a same-length edit in the same filesystem tick reports an
 * unchanged mtime+size (see statAllFiles). Paths the vault walk could not
 * enumerate are dropped: indexing a note that a cold build would exclude
 * would make the incremental result diverge from a fresh one.
 */
function diffFromDirtyPaths(
  contentPath: string,
  isIndexed: (file: string) => boolean,
  dirty: string[],
  ignore?: Ignorer,
): FileDiff {
  const toAdd: FileMtimeEntry[] = [];
  const toRemove: string[] = [];
  for (const file of dirty) {
    if (!isEnumeratedPath(file, ignore)) continue;
    const sig = statFile(contentPath, file);
    if (sig === null) {
      if (isIndexed(file)) toRemove.push(file);
    } else {
      toAdd.push({ file, ...sig });
    }
  }
  return {
    toAdd,
    toRemove,
    unchanged: toAdd.length === 0 && toRemove.length === 0,
  };
}

/** Stat one vault-relative note; null when it is not a readable file. */
function statFile(contentPath: string, file: string): FileStatSig | null {
  try {
    const stat = fs.statSync(path.join(contentPath, file));
    if (!stat.isFile()) return null;
    return { mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * True when the vault walk would list this path — the filter a dirty path
 * must pass before it may enter the index.
 *
 * Mirrors listFiles: only `.md` files are indexed, no path segment may be a
 * SKIP_DIRS entry (pruned unconditionally at descent), and the ignore
 * predicate must pass for the file AND for every ancestor directory, because
 * a dir-only pattern (`build/`) prunes a subtree without matching the files
 * inside it.
 */
function isEnumeratedPath(file: string, ignore?: Ignorer): boolean {
  if (!file.endsWith(".md")) return false;
  const segments = file.split("/");
  const name = segments[segments.length - 1];
  if (SKIP_DIRS.has(name)) return false;
  let dir = "";
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (SKIP_DIRS.has(segment)) return false;
    dir = dir === "" ? segment : `${dir}/${segment}`;
    if (ignore?.ignores(`${dir}/`)) return false;
  }
  return !ignore?.ignores(file);
}

function loadFromDiskCache(cache: IndexSnapshot): CachedVaultIndex | null {
  try {
    const loaded = MiniSearch.loadJSON(cache.index, {
      fields: ["basename"],
      storeFields: ["file"],
      idField: "file",
      searchOptions: {
        boost: { basename: BASENAME_BOOST },
        fuzzy: 0.2,
        prefix: true,
      },
    });
    const docs = new Map<string, DocRecord>();
    for (const d of cache.docs) {
      docs.set(d.file, {
        file: d.file,
        basename: d.basename,
        mtime: d.mtime,
        size: d.size,
        outgoingLinks: cache.outgoingLinks[d.file] ?? [],
      });
    }
    const fileMtimes = new Map(Object.entries(cache.fileMtimes));
    const basenameMap = buildBasenameMap(docs.values());
    // A snapshot written by a version that discarded docs carries their stale
    // posting entries ("dirt"), and those inflate the BM25 document frequency
    // of the live docs they precede until a vacuum — the drift #100 fixes on
    // the incremental path. Rebuilding the basename-only index from the docs
    // just loaded is cheap (~0.4s per 28.7k notes) and only happens once: the
    // next diff persists a clean snapshot. loadJSON cannot be repaired in
    // place, since vacuum() is async and this path is synchronous.
    const basenameIndex =
      loaded.dirtCount === 0 ? loaded : rebuildBasenameIndex(docs.values());
    // Derive the per-target tallies from the cached doc metadata and resolve
    // the counts from them (#92). The tallies are memory-only, so the cache
    // format is unchanged; deriving (instead of trusting the persisted
    // counts) also means a snapshot written before this change — with a
    // different ambiguity tie-break after churn — cannot seed a delta with
    // counts that disagree with the docs.
    const resolved = recomputeAllLinks(docs.values(), basenameMap);
    return {
      basenameIndex,
      docs,
      backlinkCounts: resolved.backlinkCounts,
      fileMtimes,
      basenameMap,
      bareLinkCounts: resolved.bareLinkCounts,
      pathLinkCounts: resolved.pathLinkCounts,
    };
  } catch {
    return null;
  }
}

/**
 * Stat current files and diff against the cached mtime map — the walk half
 * of the incremental update (the apply half is `applyDiff`).
 */
function vaultDiff(
  vaultPath: string,
  cache: CachedVaultIndex,
  ignore?: Ignorer,
): FileDiff {
  const current = statAllFiles(vaultPath, undefined, ignore);
  return diffFileMtimes(Object.fromEntries(cache.fileMtimes), current);
}

/**
 * Apply one diff (a full walk's, or the dirty paths' — #93) to the cached
 * index. Returns null when the diff is empty.
 */
function applyDiff(
  vaultPath: string,
  cache: CachedVaultIndex,
  diff: FileDiff,
): ResolvedIndex | null {
  if (diff.unchanged) {
    return null;
  }

  const changed = diff.toAdd.length + diff.toRemove.length;
  // A bulk diff (checkout, import, folder rename) is cheaper to recompute in
  // one pass than to maintain link by link. The delta costs O(links in the
  // changed docs + links to the affected basenames); a full pass is O(all
  // links) once, so an eighth of the vault is comfortably past the crossover.
  const fullRebuild = changed > cache.docs.size / 8;
  const affected = fullRebuild ? null : snapshotAffectedKeys(cache, diff);

  if (!fullRebuild) {
    // Undo the changed docs' old contributions against the OLD basename map.
    // Subtracting with the new map would decrement the wrong file when an
    // add/remove re-pointed a target.
    for (const file of diff.toRemove) {
      const doc = cache.docs.get(file);
      if (doc) removeDocLinks(cache, doc, affected);
    }
    for (const entry of diff.toAdd) {
      const doc = cache.docs.get(entry.file);
      if (doc) removeDocLinks(cache, doc, affected);
    }
  }

  removeFromIndex(cache, diff.toRemove);
  addToIndex(vaultPath, cache, diff.toAdd);

  if (fullRebuild) {
    const counted = recomputeAllLinks(cache.docs.values(), cache.basenameMap);
    cache.backlinkCounts = counted.backlinkCounts;
    cache.bareLinkCounts = counted.bareLinkCounts;
    cache.pathLinkCounts = counted.pathLinkCounts;
  } else {
    // Add the changed docs' new contributions against the NEW map.
    for (const entry of diff.toAdd) {
      const doc = cache.docs.get(entry.file);
      if (!doc) continue;
      for (const target of doc.outgoingLinks) {
        const link = linkTarget(target);
        addLinkCounter(cache.bareLinkCounts, cache.pathLinkCounts, link);
        const resolved = resolveLink(cache.basenameMap, link);
        if (resolved !== null) bumpCount(cache.backlinkCounts, resolved, 1);
      }
    }

    // Move the unchanged docs' contributions for keys whose path set changed.
    // The changed docs' own links were moved above, so their old occurrences
    // are excluded from the snapshot tallies.
    if (affected) {
      for (const key of affected.values()) {
        const paths = cache.basenameMap.get(key.key);
        const newFirst = paths?.[0] ?? null;
        const present = paths !== undefined;
        const bare = key.bare - key.changedBare;
        if (bare !== 0 && key.oldFirst !== newFirst) {
          if (key.oldFirst !== null) {
            bumpCount(cache.backlinkCounts, key.oldFirst, -bare);
          }
          if (newFirst !== null) {
            bumpCount(cache.backlinkCounts, newFirst, bare);
          }
        }
        if (key.wasPresent !== present) {
          // Path refs resolve to their own spelling whenever the basename
          // exists, so only an existence flip moves them.
          for (const [ref, count] of key.refs) {
            const moved = count - (key.changedRefs.get(ref) ?? 0);
            if (moved === 0) continue;
            if (key.wasPresent) bumpCount(cache.backlinkCounts, ref, -moved);
            if (present) bumpCount(cache.backlinkCounts, ref, moved);
          }
        }
      }
    }
  }

  // Persistence is the caller's job (applyIncrementalOrCached) — it owns the
  // config path, the ignore fingerprint, and the write throttle.
  return {
    basenameIndex: cache.basenameIndex,
    docs: cache.docs,
    backlinkCounts: cache.backlinkCounts,
  };
}

/** A basename group whose path set changes in this diff (#92). */
interface AffectedKey {
  key: string;
  /** Shallowest path before the diff; null when the key was absent. */
  oldFirst: string | null;
  wasPresent: boolean;
  /** Link tallies before the diff. */
  bare: number;
  refs: Map<string, number>;
  /** Occurrences among the changed docs' OLD links, excluded when moving. */
  changedBare: number;
  changedRefs: Map<string, number>;
}

/**
 * Snapshot the basename groups an add/remove/rename can redirect: their old
 * shallowest path and their link tallies. Pure edits change no path set, so
 * they need no snapshot at all.
 */
function snapshotAffectedKeys(
  cache: CachedVaultIndex,
  diff: FileDiff,
): Map<string, AffectedKey> | null {
  const keys = new Set<string>();
  for (const file of diff.toRemove) {
    keys.add(path.basename(file, ".md").toLowerCase());
  }
  for (const entry of diff.toAdd) {
    // A modified doc keeps its path, so only genuinely new paths change a
    // basename's path set (a rename arrives as a remove plus an add).
    if (!cache.docs.has(entry.file)) {
      keys.add(path.basename(entry.file, ".md").toLowerCase());
    }
  }
  if (keys.size === 0) return null;

  const affected = new Map<string, AffectedKey>();
  for (const key of keys) {
    const paths = cache.basenameMap.get(key);
    const refs = cache.pathLinkCounts.get(key);
    affected.set(key, {
      key,
      oldFirst: paths?.[0] ?? null,
      wasPresent: paths !== undefined,
      bare: cache.bareLinkCounts.get(key) ?? 0,
      refs: refs ? new Map(refs) : new Map(),
      changedBare: 0,
      changedRefs: new Map(),
    });
  }
  return affected;
}

/** Subtract one doc's old link contributions (against the current map). */
function removeDocLinks(
  cache: CachedVaultIndex,
  doc: DocRecord,
  affected: Map<string, AffectedKey> | null,
): void {
  for (const target of doc.outgoingLinks) {
    const link = linkTarget(target);
    removeLinkCounter(cache.bareLinkCounts, cache.pathLinkCounts, link);
    const resolved = resolveLink(cache.basenameMap, link);
    if (resolved !== null) bumpCount(cache.backlinkCounts, resolved, -1);
    if (!affected) continue;
    const entry = affected.get(link.key);
    if (!entry) continue;
    if (link.ref === null) {
      entry.changedBare++;
    } else {
      entry.changedRefs.set(
        link.ref,
        (entry.changedRefs.get(link.ref) ?? 0) + 1,
      );
    }
  }
}

/** Build a basename-only index from doc metadata (cold build, dirt repair). */
function rebuildBasenameIndex(docs: Iterable<DocRecord>): MiniSearch {
  const index = new MiniSearch({ ...BASENAME_INDEX_OPTIONS });
  index.addAll([...docs]);
  return index;
}

/**
 * Drop one doc from the basename index, using the fields it was indexed with.
 *
 * `discard(id)` is the cheaper call, but it only marks the doc's posting
 * entries as obsolete: they stay in the inverted index until a vacuum, and
 * `termResults` derives BM25 document frequency from the posting-list size,
 * decrementing it for a stale entry only when it reaches that entry. Live docs
 * visited before it therefore score against a document frequency that still
 * counts documents the index no longer has (#100) — an incrementally updated
 * index ranked differently from a cold build of the same vault. `remove`
 * takes the stored fields (we keep file and basename) and deletes the postings
 * immediately, leaving the statistics exactly those of the live documents.
 */
function removeFromBasenameIndex(
  cache: CachedVaultIndex,
  doc: DocRecord,
): void {
  if (!cache.basenameIndex.has(doc.file)) return;
  cache.basenameIndex.remove({ file: doc.file, basename: doc.basename });
}

/** Remove deleted docs from the MiniSearch index, docs map and basename map. */
function removeFromIndex(cache: CachedVaultIndex, files: string[]): void {
  for (const file of files) {
    const doc = cache.docs.get(file);
    if (doc) removeFromBasenameIndex(cache, doc);
    cache.docs.delete(file);
    cache.fileMtimes.delete(file);
    const key = path.basename(file, ".md").toLowerCase();
    const paths = cache.basenameMap.get(key);
    if (!paths) continue;
    const idx = paths.indexOf(file);
    if (idx !== -1) paths.splice(idx, 1);
    if (paths.length === 0) cache.basenameMap.delete(key);
  }
}

/** Read and index added/modified docs, appending new paths to their group. */
function addToIndex(
  vaultPath: string,
  cache: CachedVaultIndex,
  entries: FileMtimeEntry[],
): void {
  for (const entry of entries) {
    const doc = readDoc(vaultPath, entry.file);
    const previous = cache.docs.get(doc.file);
    const key = doc.basename.toLowerCase();
    if (!cache.docs.has(doc.file)) {
      const paths = cache.basenameMap.get(key);
      if (paths) {
        paths.push(doc.file);
        // Keep the group ordered for the resolve tie-break. Sorting here
        // covers both the delta and the full-rebuild branch.
        sortByDepth(paths);
      } else {
        cache.basenameMap.set(key, [doc.file]);
      }
    }
    // A modified doc keeps its id but may have a new basename, so the old
    // version must be removed with the fields it was indexed with (#100).
    if (previous) removeFromBasenameIndex(cache, previous);
    cache.basenameIndex.add(doc);
    cache.docs.set(doc.file, doc);
    cache.fileMtimes.set(doc.file, { mtime: doc.mtime, size: doc.size });
  }
}

/**
 * Convert the in-memory index to an `IndexSnapshot` and hand it to the store.
 *
 * Cold and incremental paths both call this with the same in-memory shape, so
 * what is stored is a single full snapshot either way — a snapshot written
 * incrementally loads exactly like one built cold. Note text is never
 * written: docs carry metadata only (#85), so the snapshot stays small and a
 * process that loads it retains no content.
 *
 * Best-effort: search works without a store, so failures are swallowed.
 */
function buildSnapshot(
  state: CachedVaultIndex,
  ignoreFp: string,
): IndexSnapshot {
  const docsArr = [...state.docs.values()];
  const outgoingLinks: Record<string, string[]> = {};
  for (const d of docsArr) outgoingLinks[d.file] = d.outgoingLinks;
  return {
    // Kept for format compatibility (#87): the snapshot always holds the
    // whole vault now, so this is always null. A stored snapshot with a
    // non-null folder is an old per-folder one and is treated as a miss.
    folder: null,
    fileMtimes: Object.fromEntries(state.fileMtimes),
    index: JSON.stringify(state.basenameIndex),
    docs: docsArr.map((d) => ({
      file: d.file,
      basename: d.basename,
      mtime: d.mtime,
      size: d.size,
    })),
    backlinkCounts: Object.fromEntries(state.backlinkCounts),
    outgoingLinks,
    ignoreFingerprint: ignoreFp,
  };
}

function persistCache(
  store: IndexStore,
  state: CachedVaultIndex,
  ignoreFp: string,
): void {
  try {
    store.save(buildSnapshot(state, ignoreFp));
  } catch {
    // Best-effort persistence — search still works without it.
  }
}

/**
 * Persist a cold-built index through the throttle — the leading edge still
 * fires immediately. (The in-memory path only runs with `JsonStore`; a
 * SQLite store is queried in place, see `searchViaStore`.)
 */
function persistBuiltIndex(
  store: IndexStore,
  cacheKey: string,
  state: CachedVaultIndex,
  ignoreFp: string,
): void {
  persistCacheThrottled(store, cacheKey, state, ignoreFp);
}

/** Persist an applied diff: a snapshot-only store rewrites through the throttle. */
function persistAppliedDiff(
  store: IndexStore,
  cacheKey: string,
  state: CachedVaultIndex,
  ignoreFp: string,
): void {
  persistCacheThrottled(store, cacheKey, state, ignoreFp);
}

/**
 * Persist the snapshot for `cacheKey`, at most once per CACHE_WRITE_INTERVAL_MS.
 *
 * Leading edge: the first write after the window happens right away, which is
 * what makes a one-shot CLI process persist at all. Writes inside the window
 * are coalesced into a single trailing write of the latest state, on an
 * `unref()`'d timer so a pending flush never keeps a CLI process alive (a
 * long-lived extension process flushes normally).
 *
 * The throttle belongs to the caller, not to the store: it exists because a
 * `save()` rewrites the whole snapshot (O(vault) bytes), which is what
 * `JsonStore` costs. `SqliteStore`'s per-file deltas make it unnecessary and
 * retire it (#94).
 */
function persistCacheThrottled(
  store: IndexStore,
  cacheKey: string,
  state: CachedVaultIndex,
  ignoreFp: string,
): void {
  const now = Date.now();
  const elapsed = now - (lastCacheWriteAt.get(cacheKey) ?? 0);

  if (elapsed >= CACHE_WRITE_INTERVAL_MS) {
    // A blocking call can push us past the deadline before the trailing timer
    // ran; drop it rather than write the same snapshot twice.
    cancelPendingWrite(cacheKey);
    lastCacheWriteAt.set(cacheKey, now);
    persistCache(store, state, ignoreFp);
    return;
  }

  const pending = pendingCacheWrites.get(cacheKey);
  if (pending) {
    // Inside the window with a flush already scheduled: only refresh what the
    // trailing write will serialize (the state object is mutated in place, so
    // in practice this is the same reference).
    pending.store = store;
    pending.state = state;
    pending.ignoreFp = ignoreFp;
    return;
  }

  const timer = setTimeout(() => {
    const entry = pendingCacheWrites.get(cacheKey);
    pendingCacheWrites.delete(cacheKey);
    if (!entry) return;
    lastCacheWriteAt.set(cacheKey, Date.now());
    persistCache(entry.store, entry.state, entry.ignoreFp);
  }, CACHE_WRITE_INTERVAL_MS - elapsed);
  // Never keep the process alive just to flush a cache.
  timer.unref();
  pendingCacheWrites.set(cacheKey, { timer, store, state, ignoreFp });
}

// ── Folder scoping (query-time filter) ──────────────────────────

/**
 * Normalise a user-supplied folder scope the way listFiles resolves it:
 * joined under the vault root (path.join collapses leading/trailing
 * slashes, "./" segments, and OS separators), then re-relativised to the
 * vault root. Returns null when there is no effective scope (no path, or
 * the path resolves to the vault root itself, e.g. ".").
 *
 * A scope that escapes the vault ("../x") yields a prefix no
 * vault-relative file can match, so it returns no results — the
 * whole-vault index cannot serve external directories the way the old
 * folder-scoped walk could.
 */
function normalizeFolderScope(
  contentPath: string,
  folder: string | undefined,
): string | null {
  if (!folder) return null;
  const rel = path
    .relative(contentPath, path.join(contentPath, folder))
    .split(path.sep)
    .join("/");
  return rel === "" ? null : rel;
}

// ── Public search API ─────────────────────────────────────────────

/**
 * Resolve the freshness window (#93): per-call option > vault config > `0`.
 *
 * A window of 0 means "validate against disk on every search", which is what
 * the CLI and a default SDK instance do — behaviour is unchanged unless a
 * long-lived consumer asks for a window. Negative or non-finite values fall
 * back to 0: never skipping the walk is the safe reading of a bad number.
 */
function resolveFreshnessMs(
  configValue: number | undefined,
  optionValue: number | undefined,
): number {
  const raw = optionValue ?? configValue ?? 0;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function searchVault(
  contentPath: string,
  configPath: string,
  query: string,
  opts?: SearchOptions,
): SearchResult[] {
  const config = loadConfig(configPath);
  // Single fingerprint computation: loadIgnorer computes it for its memo key
  // and returns it, so the disk-cache validity check, memoryCacheKey, and
  // persist all reuse the same value instead of re-hashing ignore files.
  const { ignorer, fingerprint: ignoreFp } = loadIgnorer(
    contentPath,
    configPath,
  );
  const freshnessMs = resolveFreshnessMs(
    config.search.freshnessMs,
    opts?.freshnessMs,
  );

  // Folder scope is a query-time filter over the whole-vault index (#87):
  // a path-segment prefix match so "foo" matches "foo/x.md" and
  // "foo/bar/y.md" but NOT "foobar/x.md". A folder that does not exist
  // yields no in-scope files — same empty result listFiles produced.
  const folderScope = normalizeFolderScope(contentPath, opts?.path);

  const store = createIndexStore(configPath);
  let fallback: IndexStore | undefined;
  if (isQueryableIndexStore(store)) {
    // #109: the SQLite store is queried per search; nothing of the index is
    // held in this process afterwards. Any failure (locked, corrupt, I/O)
    // answers THIS search from the in-memory path below — never a crash.
    try {
      return searchViaStore(
        store,
        contentPath,
        config,
        ignorer,
        ignoreFp,
        freshnessMs,
        folderScope,
        query,
        opts,
      );
    } catch (error) {
      reportIndexStoreFailure(configPath, store, error);
      fallback = new JsonStore(configPath);
      // The freshness window was opened by a walk of the SQLite store, and
      // the failed refresh may already have taken this process's dirty
      // paths. Neither describes the JSON snapshot the fallback loads (it
      // can be arbitrarily old), so the fallback walks the vault.
      markSearchWalkStale(contentPath);
    } finally {
      store.release();
    }
  }

  const { basenameIndex, docs, backlinkCounts } = resolveVaultIndex(
    contentPath,
    configPath,
    ignorer,
    ignoreFp,
    freshnessMs,
    fallback,
  );

  // Basename BM25 search (fast), restricted to in-scope files.
  const inScope =
    folderScope === null
      ? null
      : (file: string) => file.startsWith(`${folderScope}/`);
  const basenameScores = new Map<string, number>();
  for (const r of basenameIndex.search(query)) {
    const id = r.id as string;
    if (inScope && !inScope(id)) continue;
    basenameScores.set(id, r.score);
  }

  // Content substring scan (one note at a time, read from disk), restricted
  // to in-scope docs — out-of-folder docs are never candidates.
  const scanFiles: string[] = [];
  for (const file of docs.keys()) {
    if (!inScope || inScope(file)) scanFiles.push(file);
  }
  const contentTf = contentScan(contentPath, scanFiles, queryTerms(query));

  const results = rankAndRender(
    contentPath,
    config,
    query,
    opts,
    basenameScores,
    contentTf,
    (files) => {
      const info = new Map<string, HitInfo>();
      for (const file of files) {
        const doc = docs.get(file);
        if (!doc) continue;
        // Backlink counts are whole-vault by design (#87): links from outside
        // a folder scope still count — they reflect a note's real importance.
        info.set(file, {
          mtime: doc.mtime,
          links: backlinkCounts.get(file) || 0,
        });
      }
      return info;
    },
  );
  // A one-off fallback must not leave a whole-vault index in the heap.
  if (fallback) memoryCache.delete(memoryCacheKey(contentPath, ignoreFp));
  return results;
}

/** Whitespace-split, lowercased content-scan terms. */
function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

interface HitInfo {
  mtime: number;
  /** Resolved inbound link count. */
  links: number;
}

/**
 * Merge basename + content hits, score, rank and render the top results.
 *
 * Shared by the in-memory path and the store path: both hand over the same
 * two score maps and a lookup for the per-hit facts (recency, backlinks).
 */
function rankAndRender(
  contentPath: string,
  config: ReturnType<typeof loadConfig>,
  query: string,
  opts: SearchOptions | undefined,
  basenameScores: Map<string, number>,
  contentTf: Map<string, number>,
  infoOf: (files: string[]) => Map<string, HitInfo>,
): SearchResult[] {
  // Merge basename + content hits.
  const allHits = new Set([...basenameScores.keys(), ...contentTf.keys()]);
  if (allHits.size === 0) return [];
  const info = infoOf([...allHits]);

  const scored: Array<{
    file: string;
    composite: number;
    links: number;
    _mtime: number;
  }> = [];
  for (const file of allHits) {
    const hit = info.get(file);
    if (!hit) continue;
    const bm25 = basenameScores.get(file) || 0;
    const tf = contentTf.get(file) || 0;
    scored.push({
      file,
      composite:
        bm25 * BASENAME_BOOST +
        tf * CONTENT_TF_WEIGHT +
        hit.links * BACKLINK_WEIGHT,
      links: hit.links,
      _mtime: hit.mtime,
    });
  }

  // Normalise recency across the result set.
  let maxMtime = -Infinity;
  let minMtime = Infinity;
  for (const r of scored) {
    if (r._mtime > maxMtime) maxMtime = r._mtime;
    if (r._mtime < minMtime) minMtime = r._mtime;
  }
  const mtimeRange = maxMtime - minMtime || 1;
  for (const s of scored) {
    s.composite += ((s._mtime - minMtime) / mtimeRange) * RECENCY_WEIGHT;
  }

  scored.sort((a, b) => b.composite - a.composite);
  const limit = opts?.limit ?? config.search.limit;
  const topN = scored.slice(0, Math.min(limit, scored.length));

  const contextLines = opts?.contextLines ?? config.search.contextLines;

  // Read content + extract snippets ONLY for the top-N results. Note text is
  // never cached, so this is always a disk read (top-N files, not the vault).
  return topN.map((s) => {
    const content = readNoteContent(contentPath, s.file) ?? "";
    return {
      file: s.file,
      score: Math.round(s.composite * 10) / 10,
      links: s.links,
      modified: relativeTime(s._mtime),
      snippets:
        opts?.snippets === false
          ? []
          : extractSnippets(
              content,
              query,
              contextLines,
              MAX_SNIPPET_LINES_PER_FILE,
            ),
    };
  });
}

// ── Store-backed search (#109) ───────────────────────────────────

/**
 * One search against a queryable store: bring the store up to date (cold
 * build, stat-walk diff, or dirty paths inside the freshness window), then
 * answer the query with SQL reads. No whole-vault structure outlives the
 * call.
 */
function searchViaStore(
  store: QueryableIndexStore,
  contentPath: string,
  config: ReturnType<typeof loadConfig>,
  ignorer: Ignorer,
  ignoreFp: string,
  freshnessMs: number,
  folderScope: string | null,
  query: string,
  opts: SearchOptions | undefined,
): SearchResult[] {
  refreshStore(store, contentPath, ignorer, ignoreFp, freshnessMs);

  return store.readSnapshot(() => {
    // Basename BM25 over the SQL postings. Statistics (document count, mean
    // field length, document frequency) stay whole-vault; only the hits are
    // restricted to the folder scope, exactly like the in-memory path.
    const basenameScores = new Map<string, number>();
    for (const [file, score] of searchNames(store, query)) {
      if (folderScope !== null && !file.startsWith(`${folderScope}/`)) {
        continue;
      }
      basenameScores.set(file, score);
    }

    const contentTf = contentScan(
      contentPath,
      store.scanPaths(folderScope),
      queryTerms(query),
    );

    return rankAndRender(
      contentPath,
      config,
      query,
      opts,
      basenameScores,
      contentTf,
      (files) => store.hitInfo(files),
    );
  });
}

/** Read one note's index record; null when it vanished or is unreadable. */
function tryReadDoc(vaultPath: string, file: string): IndexDiffDoc | null {
  try {
    return readDoc(vaultPath, file);
  } catch {
    return null;
  }
}

/**
 * Make the store reflect the vault (#93 semantics, store-resident state):
 *
 *  - not built under this ignore state: cold build (read every note once,
 *    one transaction);
 *  - inside the freshness window: only the paths this process wrote are
 *    re-stat'd and applied;
 *  - otherwise: stat walk, streamed comparison against the stored
 *    signatures, apply the diff.
 */
function refreshStore(
  store: QueryableIndexStore,
  contentPath: string,
  ignorer: Ignorer,
  ignoreFp: string,
  freshnessMs: number,
): void {
  const memKey = memoryCacheKey(contentPath, ignoreFp);
  const pending = takeSearchFreshness(contentPath);

  if (!store.isReady(ignoreFp)) {
    const docs: IndexDiffDoc[] = [];
    for (const file of listFiles(contentPath, { ext: "md", ignore: ignorer })) {
      const doc = tryReadDoc(contentPath, file);
      if (doc) docs.push(doc);
    }
    store.replaceAll(docs, ignoreFp);
    recordSearchWalk(contentPath, memKey);
    return;
  }

  if (
    !pending.forceWalk &&
    isFreshnessWindowOpen(contentPath, memKey, freshnessMs)
  ) {
    if (pending.dirty.length === 0) return;
    applyStoreDiff(
      store,
      contentPath,
      ignoreFp,
      diffFromDirtyPaths(
        contentPath,
        (file) => store.hasFile(file),
        pending.dirty,
        ignorer,
      ),
    );
    return;
  }

  const current = statAllFiles(contentPath, undefined, ignorer);
  applyStoreDiff(store, contentPath, ignoreFp, store.diffAgainst(current));
  // Recorded after the apply, so the window opens on a completed walk.
  recordSearchWalk(contentPath, memKey);
}

function applyStoreDiff(
  store: QueryableIndexStore,
  contentPath: string,
  ignoreFp: string,
  diff: FileDiff,
): void {
  if (diff.unchanged) return;
  const upsert: IndexDiffDoc[] = [];
  const vanished: string[] = [];
  for (const entry of diff.toAdd) {
    const doc = tryReadDoc(contentPath, entry.file);
    if (doc) upsert.push(doc);
    else if (store.hasFile(entry.file)) vanished.push(entry.file);
  }
  store.saveDiff({
    upsert,
    remove: [...diff.toRemove, ...vanished].map((file) => ({
      file,
      basename: path.basename(file, ".md"),
    })),
    ignoreFingerprint: ignoreFp,
  });
}

export function searchVaultPaginated(
  contentPath: string,
  configPath: string,
  query: string,
  opts?: SearchOptions,
): PaginatedSearchResults {
  const config = loadConfig(configPath);
  const resultsPerPage = config.search.resultsPerPage;
  const totalResults = searchVault(contentPath, configPath, query, opts);
  const pageSize = resultsPerPage;
  const totalPages = Math.max(1, Math.ceil(totalResults.length / pageSize));
  const page = opts?.page ?? 1;

  if (page < 1) {
    throw new Error("Page must be >= 1");
  }
  if (page > totalPages) {
    throw new Error(`Page ${page} exceeds total pages (${totalPages})`);
  }

  return {
    results: totalResults.slice((page - 1) * pageSize, page * pageSize),
    totalPages,
    currentPage: page,
    totalResults: totalResults.length,
  };
}
