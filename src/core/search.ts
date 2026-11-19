import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";
import { loadConfig } from "../utils/config.js";
import { listFiles } from "../utils/files.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import { extractLinks } from "../utils/markdown.js";
import {
  diffFileMtimes,
  type FileDiff,
  type FileMtimeEntry,
  type FileStatSig,
  loadSearchCache,
  type SearchCacheData,
  saveSearchCache,
  statAllFiles,
} from "../utils/search-cache.js";

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
  configPath: string;
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
  return undefined;
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
  return undefined;
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
  const basenameIndex = new MiniSearch({ ...BASENAME_INDEX_OPTIONS });
  basenameIndex.addAll(docsArr);

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
 * A wikilink target classified the way resolution narrows it: a target with
 * a slash or a `.md` suffix resolves as a path (keeping its own spelling);
 * anything else is a bare basename lookup.
 */
interface LinkTarget {
  key: string;
  /** Path-style ref, or null for a bare-name link. */
  ref: string | null;
}

function linkTarget(target: string): LinkTarget {
  if (target.includes("/") || target.endsWith(".md")) {
    const ref = target.endsWith(".md") ? target : `${target}.md`;
    return { key: path.basename(ref, ".md").toLowerCase(), ref };
  }
  return { key: target.toLowerCase(), ref: null };
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
  docs: Map<string, DocRecord>,
  terms: string[],
): Map<string, number> {
  const tf = new Map<string, number>();
  if (terms.length === 0) return tf;
  const lowerTerms = terms.map((t) => t.toLowerCase());
  for (const doc of docs.values()) {
    const content = readNoteContent(contentPath, doc.file);
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
    if (total > 0) tf.set(doc.file, total);
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
 *   2. Otherwise check the on-disk cache: if it exists, load the basename
 *      index + metadata, and apply an incremental diff (discard removed,
 *      add/replace changed).
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
): ResolvedIndex {
  // One index per vault (#87): folder scoping is a query-time filter in
  // searchVault, so the memory key and disk cache never depend on a folder.
  const memKey = memoryCacheKey(contentPath, ignoreFp);

  const cached = memoryCache.get(memKey);
  if (cached) {
    return applyIncrementalOrCached(
      contentPath,
      configPath,
      memKey,
      cached,
      ignoreFp,
      ignorer,
    );
  }

  const diskCache = loadSearchCache(configPath);
  // The disk cache is only valid when it holds a whole-vault snapshot
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
        configPath,
        memKey,
        loaded,
        ignoreFp,
        ignorer,
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
  // Goes through the throttle like the incremental path: it writes
  // immediately (nothing was written for this key yet) and records the write
  // time, so an immediate follow-up diff coalesces instead of rewriting.
  persistCacheThrottled(configPath, memKey, fresh, ignoreFp);
  return {
    basenameIndex: fresh.basenameIndex,
    docs: fresh.docs,
    backlinkCounts: fresh.backlinkCounts,
  };
}

/**
 * Apply the mtime+size diff to a cached index and persist the result when
 * anything changed. Returns the cached view unchanged when the cache is
 * already up-to-date (the stat walk is the only I/O in that case).
 */
function applyIncrementalOrCached(
  contentPath: string,
  configPath: string,
  memKey: string,
  cache: CachedVaultIndex,
  ignoreFp: string,
  ignorer: Ignorer,
): ResolvedIndex {
  const updated = applyIncrementalDiff(contentPath, cache, ignorer);
  if (!updated) {
    return {
      basenameIndex: cache.basenameIndex,
      docs: cache.docs,
      backlinkCounts: cache.backlinkCounts,
    };
  }
  // Without this the disk cache only ever holds the cold snapshot, so every
  // new process re-reads everything added or edited since (#84).
  persistCacheThrottled(configPath, memKey, cache, ignoreFp);
  return updated;
}

function loadFromDiskCache(cache: SearchCacheData): CachedVaultIndex | null {
  try {
    const basenameIndex = MiniSearch.loadJSON(cache.index, {
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
 * Stat current files, diff against the cached mtime map, and apply changes
 * to the in-memory index. Returns null when the cache is fully up-to-date
 * (no I/O beyond the stat walk).
 *
 * Changed docs are re-read from disk (for their outgoing links and stat
 * signature) and added/replaced in the basename MiniSearch index. Backlink
 * counts are updated by delta (#92): a changed doc's old link contributions
 * are subtracted and its new ones added, and only the basename keys whose
 * path set changed are re-resolved — for the docs that did not change.
 * Bulk churn falls back to a single full pass.
 */
function applyIncrementalDiff(
  vaultPath: string,
  cache: CachedVaultIndex,
  ignore?: Ignorer,
): ResolvedIndex | null {
  const current = statAllFiles(vaultPath, undefined, ignore);
  const diff = diffFileMtimes(Object.fromEntries(cache.fileMtimes), current);
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

/** Remove deleted docs from the MiniSearch index, docs map and basename map. */
function removeFromIndex(cache: CachedVaultIndex, files: string[]): void {
  for (const file of files) {
    if (cache.basenameIndex.has(file)) cache.basenameIndex.discard(file);
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
    if (cache.basenameIndex.has(doc.file)) {
      cache.basenameIndex.discard(doc.file);
    }
    cache.basenameIndex.add(doc);
    cache.docs.set(doc.file, doc);
    cache.fileMtimes.set(doc.file, { mtime: doc.mtime, size: doc.size });
  }
}

/**
 * Serialize a cached index to `.napkin/search-cache.json`.
 *
 * Cold and incremental paths both call this with the same in-memory shape, so
 * the on-disk format is a single full snapshot either way — a cache written
 * incrementally loads exactly like one built cold. Note text is never
 * written: docs carry metadata only (#85), so the snapshot stays small and a
 * process that loads it retains no content.
 *
 * Best-effort: search works without a cache, so failures are swallowed.
 */
function persistCache(
  configPath: string,
  state: CachedVaultIndex,
  ignoreFp: string,
): void {
  const docsArr = [...state.docs.values()];
  const outgoingLinks: Record<string, string[]> = {};
  for (const d of docsArr) outgoingLinks[d.file] = d.outgoingLinks;
  try {
    saveSearchCache(configPath, {
      // Kept for format compatibility (#87): the cache always holds a
      // whole-vault snapshot now, so this is always null. A cache file
      // with a non-null folder is an old per-folder snapshot and is
      // treated as a miss.
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
    });
  } catch {
    // Best-effort persistence — search still works without it.
  }
}

/**
 * Persist the cache for `cacheKey`, at most once per CACHE_WRITE_INTERVAL_MS.
 *
 * Leading edge: the first write after the window happens right away, which is
 * what makes a one-shot CLI process persist at all. Writes inside the window
 * are coalesced into a single trailing write of the latest state, on an
 * `unref()`'d timer so a pending flush never keeps a CLI process alive (a
 * long-lived extension process flushes normally).
 */
function persistCacheThrottled(
  configPath: string,
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
    persistCache(configPath, state, ignoreFp);
    return;
  }

  const pending = pendingCacheWrites.get(cacheKey);
  if (pending) {
    // Inside the window with a flush already scheduled: only refresh what the
    // trailing write will serialize (the state object is mutated in place, so
    // in practice this is the same reference).
    pending.configPath = configPath;
    pending.state = state;
    pending.ignoreFp = ignoreFp;
    return;
  }

  const timer = setTimeout(() => {
    const entry = pendingCacheWrites.get(cacheKey);
    pendingCacheWrites.delete(cacheKey);
    if (!entry) return;
    lastCacheWriteAt.set(cacheKey, Date.now());
    persistCache(entry.configPath, entry.state, entry.ignoreFp);
  }, CACHE_WRITE_INTERVAL_MS - elapsed);
  // Never keep the process alive just to flush a cache.
  timer.unref();
  pendingCacheWrites.set(cacheKey, { timer, configPath, state, ignoreFp });
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

  const { basenameIndex, docs, backlinkCounts } = resolveVaultIndex(
    contentPath,
    configPath,
    ignorer,
    ignoreFp,
  );

  // Folder scope is a query-time filter over the whole-vault index (#87):
  // a path-segment prefix match so "foo" matches "foo/x.md" and
  // "foo/bar/y.md" but NOT "foobar/x.md". A folder that does not exist
  // yields no in-scope files — same empty result listFiles produced.
  const folderScope = normalizeFolderScope(contentPath, opts?.path);
  const inScope =
    folderScope === null
      ? null
      : (file: string) => file.startsWith(`${folderScope}/`);

  // Basename BM25 search (fast), restricted to in-scope files.
  const basenameResults = basenameIndex.search(query);
  const basenameScores = new Map<string, number>();
  for (const r of basenameResults) {
    const id = r.id as string;
    if (inScope && !inScope(id)) continue;
    basenameScores.set(id, r.score);
  }

  // Content substring scan (one note at a time, read from disk), restricted
  // to in-scope docs — out-of-folder docs are never candidates.
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let scanDocs = docs;
  if (inScope) {
    scanDocs = new Map<string, DocRecord>();
    for (const [file, doc] of docs) {
      if (inScope(file)) scanDocs.set(file, doc);
    }
  }
  const contentTf = contentScan(contentPath, scanDocs, terms);

  // Merge basename + content hits.
  const allHits = new Set([...basenameScores.keys(), ...contentTf.keys()]);
  if (allHits.size === 0) return [];

  const scored: Array<{
    file: string;
    composite: number;
    links: number;
    _mtime: number;
  }> = [];
  for (const file of allHits) {
    const doc = docs.get(file);
    if (!doc) continue;
    const bm25 = basenameScores.get(file) || 0;
    const tf = contentTf.get(file) || 0;
    // Backlink counts are whole-vault by design (#87): links from outside
    // a folder scope still count — they reflect a note's real importance.
    const links = backlinkCounts.get(file) || 0;
    scored.push({
      file,
      composite:
        bm25 * BASENAME_BOOST +
        tf * CONTENT_TF_WEIGHT +
        links * BACKLINK_WEIGHT,
      links,
      _mtime: doc.mtime,
    });
  }

  // Normalise recency across the result set.
  const maxMtime = Math.max(...scored.map((r) => r._mtime));
  const minMtime = Math.min(...scored.map((r) => r._mtime));
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
  const withSnippets: SearchResult[] = topN.map((s) => {
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

  return withSnippets;
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
