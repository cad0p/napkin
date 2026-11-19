import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";
import { loadConfig } from "../utils/config.js";
import { listFiles } from "../utils/files.js";
import { type Ignorer, loadIgnorer } from "../utils/ignore.js";
import { extractLinks } from "../utils/markdown.js";
import {
  diffFileMtimes,
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
  content: string;
  mtime: number;
  size: number;
  /** Outgoing wikilink targets (for backlink recompute on incremental). */
  outgoingLinks: string[];
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
// build for 2700 files), while content matching is done via an in-memory
// substring scan (~130ms over 26MB). This avoids the ~8s cost of indexing
// full content into MiniSearch's inverted index. Content is kept in-memory
// for snippet extraction (already needed for the scan).
interface CachedVaultIndex {
  basenameIndex: MiniSearch;
  docs: Map<string, DocRecord>;
  backlinkCounts: Map<string, number>;
  fileMtimes: Map<string, FileStatSig>;
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

// ── Index building (cold path) ────────────────────────────────────

interface BuildResult {
  docs: Map<string, DocRecord>;
  backlinkCounts: Map<string, number>;
  fileMtimes: Map<string, FileStatSig>;
  basenameIndex: MiniSearch;
}

function readDoc(vaultPath: string, file: string): DocRecord {
  const fullPath = path.join(vaultPath, file);
  const content = fs.readFileSync(fullPath, "utf-8");
  const stat = fs.statSync(fullPath);
  const basename = path.basename(file, ".md");
  const { wikilinks } = extractLinks(content);
  return {
    file,
    basename,
    content,
    mtime: stat.mtimeMs,
    size: stat.size,
    outgoingLinks: wikilinks,
  };
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
 * content matching is done at query time via an in-memory substring scan
 * (~130ms). This trades ~8s cold index build for ~130ms per-query scan,
 * a massive win for cold path latency.
 */
function buildDocsAndBacklinks(
  vaultPath: string,
  ignore?: Ignorer,
): BuildResult {
  const files = listFiles(vaultPath, { ext: "md", ignore });

  const basenameMap = new Map<string, string[]>();
  const docsArr: DocRecord[] = [];
  const fileMtimes = new Map<string, FileStatSig>();

  for (const file of files) {
    const doc = readDoc(vaultPath, file);
    docsArr.push(doc);
    fileMtimes.set(doc.file, { mtime: doc.mtime, size: doc.size });
    const key = doc.basename.toLowerCase();
    const existing = basenameMap.get(key);
    if (existing) existing.push(doc.file);
    else basenameMap.set(key, [doc.file]);
  }
  // Sort each basename's paths by depth (shallowest first) for resolve tie-break.
  for (const paths of basenameMap.values()) {
    if (paths.length > 1) {
      paths.sort((a, b) => a.split("/").length - b.split("/").length);
    }
  }

  // Compute backlinks in-memory from outgoing links — no second disk pass.
  const backlinkCounts = new Map<string, number>();
  for (const doc of docsArr) {
    for (const target of doc.outgoingLinks) {
      const resolved = resolveBasename(basenameMap, target);
      if (resolved) {
        backlinkCounts.set(resolved, (backlinkCounts.get(resolved) || 0) + 1);
      }
    }
  }

  // Build basename-only MiniSearch index (fast: ~84ms for 2700 files).
  const basenameIndex = new MiniSearch({ ...BASENAME_INDEX_OPTIONS });
  basenameIndex.addAll(docsArr);

  return {
    docs: new Map(docsArr.map((d) => [d.file, d])),
    backlinkCounts,
    fileMtimes,
    basenameIndex,
  };
}

/**
 * Resolve a wikilink target against the basename map.
 * Mirrors `findMatches` + `resolveFileLoose` semantics:
 *  - "path/with/slash" or "*.md" → exact path match
 *  - bare name → basename match, shallowest path wins on ambiguity
 */
function resolveBasename(
  basenameMap: Map<string, string[]>,
  target: string,
): string | null {
  if (target.includes("/") || target.endsWith(".md")) {
    const ref = target.endsWith(".md") ? target : `${target}.md`;
    const key = path.basename(ref, ".md").toLowerCase();
    return basenameMap.has(key) ? ref : null;
  }
  const matches = basenameMap.get(target.toLowerCase());
  return matches && matches.length > 0 ? matches[0] : null;
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
 * Scan in-memory content for query terms, returning term frequency per file.
 * ~130ms for 26MB of content across 2700 files — far cheaper than building
 * a MiniSearch content index (~8s) on every cold build.
 *
 * Uses case-insensitive substring matching (matches napkin's prior
 * `extractSnippets` behavior and MiniSearch's `prefix: true` recall).
 */
function contentScan(
  docs: Map<string, DocRecord>,
  terms: string[],
): Map<string, number> {
  const tf = new Map<string, number>();
  if (terms.length === 0) return tf;
  const lowerTerms = terms.map((t) => t.toLowerCase());
  for (const doc of docs.values()) {
    const lo = doc.content.toLowerCase();
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
        // Content IS persisted in the disk cache (fixes #22) so the warm
        // path can run contentScan with correct recall. Old caches that
        // omit `content` are rejected by loadSearchCache and rebuilt.
        content: d.content,
        mtime: d.mtime,
        size: d.size,
        outgoingLinks: cache.outgoingLinks[d.file] ?? [],
      });
    }
    const backlinkCounts = new Map(Object.entries(cache.backlinkCounts));
    const fileMtimes = new Map(Object.entries(cache.fileMtimes));
    return {
      basenameIndex,
      docs,
      backlinkCounts,
      fileMtimes,
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
 * Changed docs are read from disk (content needed for the content scan),
 * added/removed from the basename MiniSearch index, and backlinks are
 * recomputed in-memory.
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

  // Remove deleted/modified files from the index and docs map.
  for (const file of diff.toRemove) {
    if (cache.basenameIndex.has(file)) cache.basenameIndex.discard(file);
    cache.docs.delete(file);
    cache.fileMtimes.delete(file);
  }

  // Build basename map for the remaining docs (for backlink recompute).
  const basenameMap = new Map<string, string[]>();
  for (const doc of cache.docs.values()) {
    const key = doc.basename.toLowerCase();
    const existing = basenameMap.get(key);
    if (existing) existing.push(doc.file);
    else basenameMap.set(key, [doc.file]);
  }

  // Read + index added/modified docs.
  for (const entry of diff.toAdd) {
    const doc = readDoc(vaultPath, entry.file);
    const key = doc.basename.toLowerCase();
    const existing = basenameMap.get(key);
    if (existing) {
      if (!existing.includes(doc.file)) existing.push(doc.file);
    } else {
      basenameMap.set(key, [doc.file]);
    }
    if (cache.basenameIndex.has(doc.file))
      cache.basenameIndex.discard(doc.file);
    cache.basenameIndex.add(doc);
    cache.docs.set(doc.file, doc);
    cache.fileMtimes.set(doc.file, { mtime: doc.mtime, size: doc.size });
  }

  // Re-sort basename paths (shallowest first) after all mutations.
  for (const paths of basenameMap.values()) {
    if (paths.length > 1) {
      paths.sort((a, b) => a.split("/").length - b.split("/").length);
    }
  }

  cache.backlinkCounts = recomputeBacklinks(cache.docs, basenameMap);

  // Persistence is the caller's job (applyIncrementalOrCached) — it owns the
  // config path, the ignore fingerprint, and the write throttle.
  return {
    basenameIndex: cache.basenameIndex,
    docs: cache.docs,
    backlinkCounts: cache.backlinkCounts,
  };
}

function recomputeBacklinks(
  docs: Map<string, DocRecord>,
  basenameMap: Map<string, string[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of docs.values()) {
    for (const target of doc.outgoingLinks) {
      const resolved = resolveBasename(basenameMap, target);
      if (resolved) {
        counts.set(resolved, (counts.get(resolved) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Serialize a cached index to `.napkin/search-cache.json`.
 *
 * Cold and incremental paths both call this with the same in-memory shape, so
 * the on-disk format is a single full snapshot either way — a cache written
 * incrementally loads exactly like one built cold. Keep the format unchanged
 * (docs[].content included) so caches from older versions still load.
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
        content: d.content,
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

  // Content substring scan (in-memory, ~130ms for 26MB), restricted to
  // in-scope docs — out-of-folder docs are never candidates.
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
  const contentTf = contentScan(scanDocs, terms);

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

  // Read content + extract snippets ONLY for the top-N results.
  const withSnippets: SearchResult[] = topN.map((s) => {
    const doc = docs.get(s.file);
    // Warm-path docs have empty content (deferred read). Read on demand.
    const content =
      doc?.content || fs.readFileSync(path.join(contentPath, s.file), "utf-8");
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
