import { JsonStore } from "./json-store.js";
import type { FileStatSig } from "./search-cache.js";

/**
 * Persistence seam for the vault search index (#94).
 *
 * `searchVault` keeps a whole-vault index in process memory and persists it so
 * the next process starts warm instead of walking the vault and reading every
 * note. Today that persistence is one JSON file (`JsonStore`); the target
 * (#94) is a SQLite store under `.napkin/cache/`, shared by every process,
 * updated by delta, with one scanner at a time. This interface is the boundary
 * the two swap at, so `search.ts` never learns which one it has.
 *
 * Both implementations are synchronous — `JsonStore` is a read plus an atomic
 * rename, and `node:sqlite` is synchronous too — so the seam stays off the
 * async path every query already takes.
 *
 * Contract:
 *
 *  - `load()` returns null whenever the store is missing, unreadable, written
 *    in an incompatible format, or about to be rebuilt. It never throws:
 *    search works without a store, so a broken one is a cold build, not a
 *    failed query.
 *  - `save()` may throw on I/O failure (full disk, read-only directory).
 *    Callers treat persistence as best-effort — the in-memory index is correct
 *    either way — and a failed write leaves the previous snapshot intact.
 *  - A snapshot is a whole-vault view (see `IndexSnapshot`), never a folder
 *    slice: folder scoping is a query-time filter (#87).
 *
 * What `SqliteStore` adds (#94, next PRs) — deliberately absent here, because
 * nothing calls them yet and a method nobody uses is a guess:
 *
 *  - `upsertFiles(entries)` / `deleteFiles(paths)`: per-file writes committed
 *    with a generation bump, so an incremental diff costs O(changed) instead
 *    of the O(vault) rewrite `save()` implies. `save()` is a JsonStore-shaped
 *    method and stops being the write path once these exist.
 *  - `readDeltas(sinceGen)` / `currentGeneration()`: files changed or
 *    tombstoned since a generation, so another process patches its in-memory
 *    index instead of walking the vault.
 *  - `acquireScanLease(owner, ttlMs)` / `renewScanLease` /
 *    `releaseScanLease`: one scanner at a time across processes; the others
 *    answer from committed state, at most one scan old.
 *  - `getBasenameBlob()` / `putBasenameBlob(blob)`: the serialized MiniSearch
 *    basename index as a blob, rewritten only when the basename set changes
 *    (add, remove, rename) — never on an edit.
 *  - `markDirty(path)` plus `lastScanAt` / freshness metadata: the freshness
 *    state `search-freshness.ts` keeps in process memory today, which a
 *    shared store has to hold for every process.
 *
 * `JsonStore` stays as the fallback after that: an older Node without
 * `node:sqlite`, a vault on a network filesystem, a read-only cache dir.
 */
export interface IndexStore {
  /** The stored whole-vault snapshot, or null when there is none to use. */
  load(): IndexSnapshot | null;

  /** Persist a whole-vault snapshot, replacing whatever was stored. */
  save(snapshot: IndexSnapshot): void;
}

/**
 * One indexed note. Metadata only — never note text (#85): the content scan
 * reads notes from disk per query, so a warm process retains none.
 */
export interface IndexedDoc {
  file: string;
  basename: string;
  mtime: number;
  size: number;
}

/**
 * A whole-vault index snapshot: everything a fresh process needs to serve
 * searches without walking the vault or reading a note.
 *
 * The field names are the JSON file's, because that is the only format written
 * today and `JsonStore` owns that encoding. `SqliteStore` will serve the same
 * shape from its tables, so `search.ts` does not change: `fileMtimes` from
 * `files(mtime,size)`, `docs` and `outgoingLinks` from `files` and `links`,
 * `backlinkCounts` from `link_counts`, `index` from the basename blob, and
 * `folder` / `ignoreFingerprint` from `meta`.
 */
export interface IndexSnapshot {
  /**
   * Scope of this snapshot — always null (whole vault). Kept for format
   * compatibility: an older per-folder cache is a miss, never a merge.
   */
  folder: string | null;
  /** file → {mtime,size} map, for incremental diffing. */
  fileMtimes: Record<string, FileStatSig>;
  /** JSON-serialized MiniSearch basename index. */
  index: string;
  /** Doc metadata only — never note text (#85). */
  docs: IndexedDoc[];
  /** file → inbound backlink count. */
  backlinkCounts: Record<string, number>;
  /** file → raw wikilink targets (for incremental backlink recompute). */
  outgoingLinks: Record<string, string[]>;
  /**
   * Fingerprint of the ignore-relevant state (config `ignore.*` + both ignore
   * files' {mtime,size}). A mismatch forces a cold rebuild — an ignore change
   * can hide/unhide files that incremental diffing would miss.
   */
  ignoreFingerprint: string;
}

/**
 * Select the store for a vault's config directory.
 *
 * The one place an implementation is chosen. `JsonStore` is the only one
 * today; when `SqliteStore` lands this is the function that picks it, and the
 * fallback cases listed above are decided here, not in `search.ts`.
 */
export function createIndexStore(configPath: string): IndexStore {
  return new JsonStore(configPath);
}
