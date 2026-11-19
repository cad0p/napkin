import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_FILE = "overview-cache.json";
const FOLDERS_CACHE_FILE = "overview-folders-cache.json";

/**
 * Cache format version, stored in BOTH cache files. Bump when the persisted
 * shape or the computation behind it changes: an unknown version is a miss,
 * never an error. One constant for both files on purpose — the folder data
 * feeds the result, so a tokenizer/FolderData change invalidates both.
 *
 * v3 (#117): the vault walk is bounded to the configured overview depth, so
 * fingerprints cover only the files the overview can use — a v2 fingerprint
 * (whole vault) must never be compared against a v3 one (bounded).
 */
export const OVERVIEW_CACHE_VERSION = 3;

// ─── Whole-result cache ─────────────────────────────────────────────

export interface OverviewCacheKey {
  /** Whole-vault fingerprint (paths + mtimes), see vaultFingerprint. */
  fingerprint: string;
  /** Resolved options the result was computed with (depth, keywords, ...). */
  optionsKey: string;
  /** Ignore-relevant state (config flags + ignore file signatures). */
  ignoreFingerprint: string;
}

export interface OverviewCacheData<T> extends OverviewCacheKey {
  version: number;
  result: T;
}

/**
 * Load the cached overview result if the vault fingerprint, the resolved
 * options, and the ignore state all match. Returns null on miss, mismatch,
 * or corruption.
 *
 * Single-entry cache, same trade-off as the search cache: the stored result
 * is a few KB, and the dominant call pattern (agents re-running `napkin
 * overview` with default options between reads) hits one variant. This is
 * the only check on the warm/no-change path — the (much larger) per-folder
 * data file is not even opened.
 */
export function loadOverviewCache<T>(
  configPath: string,
  key: OverviewCacheKey,
): T | null {
  try {
    const raw = fs.readFileSync(path.join(configPath, CACHE_FILE), "utf-8");
    const data = JSON.parse(raw) as Partial<OverviewCacheData<T>>;
    if (data.version !== OVERVIEW_CACHE_VERSION) return null;
    if (data.fingerprint !== key.fingerprint) return null;
    if (data.optionsKey !== key.optionsKey) return null;
    if (data.ignoreFingerprint !== key.ignoreFingerprint) return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

export function saveOverviewCache<T>(
  configPath: string,
  data: OverviewCacheData<T>,
): void {
  writeAtomic(path.join(configPath, CACHE_FILE), JSON.stringify(data));
}

// ─── Per-folder data cache ──────────────────────────────────────────
//
// One entry per folder, each holding that folder's FolderData (weighted term
// counts + heading signals) as produced by buildFolderData(). Term strings
// live once in a global dictionary and folder arrays reference them by index:
// the same vocabulary repeats across many folders, so inlining it per entry
// would roughly triple the file (#issue 86). Counts stay integers.

/**
 * Serialized FolderData for one folder. Term-count maps are flat
 * `[termIndex, count, ...]` arrays in Map insertion order — insertion order
 * is behavior here (keyword tie-breaking is a stable sort over it).
 */
export interface CachedFolderData {
  /** Fingerprint of this folder's DIRECT files (paths, mtimes, sizes). */
  sig: string;
  /** Note count as buildFolderData computed it (skipped notes still count). */
  n: number;
  /** Weighted term counts (FolderData.tf) → dictionary indices. */
  tf: number[];
  /** Body term counts (FolderData.bodyTF) → dictionary indices. */
  body: number[];
  /** Heading line counts (FolderData.headingLineCount) → dictionary indices. */
  head: number[];
  /**
   * Terms that come ONLY from headings (FolderData.hasNonHeading complement).
   * Stored as the complement because it is the small side: buildFolderData
   * takes hasNonHeading from the filename/title/frontmatter/body sources
   * BEFORE heading terms are folded in, so it is not derivable from `tf`.
   */
  headOnly: number[];
  tags: string[];
  /** Warnings emitted while building this folder (malformed frontmatter). */
  warn: string[];
}

export interface OverviewFoldersCacheData {
  version: number;
  /** Ignore-relevant state: an ignore change can hide/unhide whole folders. */
  ignoreFingerprint: string;
  /** Templates folder is skipped by grouping, so it shapes FolderData. */
  templatesFolder: string;
  /** Global term dictionary referenced by the folder arrays above. */
  terms: string[];
  folders: Record<string, CachedFolderData>;
}

/** Loaded form: the dictionary plus folder entries keyed by folder path. */
export interface OverviewFoldersCache {
  terms: string[];
  folders: Map<string, CachedFolderData>;
}

/**
 * Load the per-folder data cache. Returns null when the file is absent,
 * unreadable, corrupt, written by another version, or produced under a
 * different ignore/templates state — callers then rebuild from cold.
 *
 * Individual folder entries that do not validate are dropped rather than
 * failing the whole file: a dropped entry is simply rebuilt this run.
 */
export function loadOverviewFoldersCache(
  configPath: string,
  ignoreFingerprint: string,
  templatesFolder: string,
): OverviewFoldersCache | null {
  try {
    const raw = fs.readFileSync(
      path.join(configPath, FOLDERS_CACHE_FILE),
      "utf-8",
    );
    const data = JSON.parse(raw) as Partial<OverviewFoldersCacheData>;
    if (data.version !== OVERVIEW_CACHE_VERSION) return null;
    if (data.ignoreFingerprint !== ignoreFingerprint) return null;
    if (data.templatesFolder !== templatesFolder) return null;
    if (!Array.isArray(data.terms)) return null;
    for (const term of data.terms) {
      if (typeof term !== "string") return null;
    }
    if (!data.folders || typeof data.folders !== "object") return null;

    const folders = new Map<string, CachedFolderData>();
    for (const [folder, entry] of Object.entries(data.folders)) {
      if (!isCachedFolderData(entry)) continue;
      folders.set(folder, entry);
    }
    return { terms: data.terms, folders };
  } catch {
    return null;
  }
}

/**
 * Persist the per-folder data cache.
 *
 * Atomic, like the search cache: written to a temp file in the same
 * directory and renamed over the target, so a reader never observes a
 * half-written cache and a crash mid-write leaves the previous snapshot
 * intact. Callers treat persistence as best-effort (overview works without
 * a cache) and swallow I/O errors.
 */
export function saveOverviewFoldersCache(
  configPath: string,
  data: OverviewFoldersCacheData,
): void {
  writeAtomic(path.join(configPath, FOLDERS_CACHE_FILE), JSON.stringify(data));
}

/**
 * Drop dictionary terms no folder references any more — a deleted or
 * rewritten folder leaves its vocabulary behind, and without compaction the
 * file would grow monotonically. Returns the input object unchanged (same
 * reference, no copy) when every term is still referenced.
 *
 * Cost is one pass over the folder arrays (no JSON, no string work unless
 * something is orphaned), and only runs when the cache is being rewritten.
 */
export function compactOverviewFoldersCache(
  data: OverviewFoldersCacheData,
): OverviewFoldersCacheData {
  const { terms } = data;
  if (terms.length === 0) return data;

  const referenced = new Uint8Array(terms.length);
  let referencedCount = 0;
  const mark = (index: number) => {
    if (index >= 0 && index < referenced.length && !referenced[index]) {
      referenced[index] = 1;
      referencedCount++;
    }
  };
  const markPairs = (pairs: number[]) => {
    for (let i = 0; i < pairs.length; i += 2) mark(pairs[i]);
  };
  for (const entry of Object.values(data.folders)) {
    markPairs(entry.tf);
    markPairs(entry.body);
    markPairs(entry.head);
    for (const index of entry.headOnly) mark(index);
  }
  if (referencedCount === terms.length) return data;

  // Old index → new index (-1 for orphans).
  const remap = new Int32Array(terms.length).fill(-1);
  const compacted: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    if (!referenced[i]) continue;
    remap[i] = compacted.length;
    compacted.push(terms[i]);
  }
  const rewritePairs = (pairs: number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      out.push(remap[pairs[i]], pairs[i + 1]);
    }
    return out;
  };
  const folders: Record<string, CachedFolderData> = Object.create(null);
  for (const [folder, entry] of Object.entries(data.folders)) {
    folders[folder] = {
      ...entry,
      tf: rewritePairs(entry.tf),
      body: rewritePairs(entry.body),
      head: rewritePairs(entry.head),
      headOnly: entry.headOnly.map((index) => remap[index]),
    };
  }
  return { ...data, terms: compacted, folders };
}

// ─── Shared helpers ─────────────────────────────────────────────────

function isCachedFolderData(value: unknown): value is CachedFolderData {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CachedFolderData>;
  if (typeof entry.sig !== "string") return false;
  if (typeof entry.n !== "number") return false;
  for (const pairs of [entry.tf, entry.body, entry.head]) {
    // Even length = whole [index, count] pairs; element types are validated
    // during decode (which can still reject an entry).
    if (!Array.isArray(pairs) || pairs.length % 2 !== 0) return false;
  }
  for (const list of [entry.tags, entry.warn]) {
    if (!Array.isArray(list)) return false;
    for (const item of list) if (typeof item !== "string") return false;
  }
  if (!Array.isArray(entry.headOnly)) return false;
  for (const index of entry.headOnly) {
    if (typeof index !== "number") return false;
  }
  return true;
}

/** Write via a same-directory temp file + rename (never a torn cache). */
function writeAtomic(filePath: string, payload: string): void {
  // pid + random suffix: two writers (or a run that crashed mid-write) never
  // share a temp path, so one cannot clobber the other's half-written file.
  const tmpPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, payload);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; the write error below is the one that matters.
    }
    throw err;
  }
}
