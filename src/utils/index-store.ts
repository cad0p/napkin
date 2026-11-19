import { JsonStore } from "./json-store.js";
import type { NameSource } from "./name-search.js";
import type { FileDiff, FileMtimeEntry, FileStatSig } from "./search-cache.js";
import { SqliteStore } from "./sqlite-store.js";

/**
 * Persistence seam for the vault search index (#94).
 *
 * `searchVault` keeps a whole-vault index in process memory and persists it so
 * the next process starts warm instead of walking the vault and reading every
 * note. Two implementations sit behind this interface: `JsonStore` (one
 * whole-snapshot file, the #84 cache) and `SqliteStore` (a SQLite database
 * under `.napkin/cache/`, updated by per-file delta). This interface is the
 * boundary they swap at, so `search.ts` never learns which one it has.
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
 *  - `saveDiff()` (see `IncrementalIndexStore`) persists one applied diff —
 *    per-file upserts and deletes in a single transaction — instead of the
 *    whole snapshot. A store that has it makes the caller-side write throttle
 *    unnecessary, because an incremental persist costs O(changed), not
 *    O(vault).
 *
 * Scope of this PR (#106): a single process. The schema already carries what
 * the cross-process follow-up needs — `files.gen`/`tombstones.gen` (a delta
 * feed: `WHERE gen > :seen`), `meta` keys reserved for a scan lease, and
 * `link_counts` keyed per link target — so it lands without a migration.
 * What a later issue adds on top:
 *
 *  - `acquireScanLease(owner, ttlMs)` / `renewScanLease` /
 *    `releaseScanLease`: one scanner at a time across processes; the others
 *    answer from committed state, at most one scan old (`meta.scan_lease`).
 *  - `readDeltas(sinceGen)` / `currentGeneration()`: files changed or
 *    tombstoned since a generation, so another process patches its in-memory
 *    index instead of walking the vault.
 *  - `markDirty(path)` plus a shared `last_scan_at`: the freshness state
 *    `search-freshness.ts` keeps in process memory today.
 *
 * `JsonStore` stays as the automatic fallback: an older Node without
 * `node:sqlite`, a vault on a network filesystem, a read-only cache dir.
 * There is no user-facing choice — SQLite is THE store and the fallback
 * engages only when the database genuinely cannot be used.
 */

export interface IndexStore {
  /** The stored whole-vault snapshot, or null when there is none to use. */
  load(): IndexSnapshot | null;

  /** Persist a whole-vault snapshot, replacing whatever was stored. */
  save(snapshot: IndexSnapshot): void;
}

/**
 * A store that can persist a per-file diff in one transaction.
 *
 * `saveDiff` is deliberately a separate, optional capability rather than a
 * required method: `JsonStore` cannot do O(changed) writes, and a caller
 * that sees this interface knows the write throttle (`persistCacheThrottled`)
 * is unnecessary — a diff write is cheap.
 */
export interface IncrementalIndexStore extends IndexStore {
  /** Persist the changes of one applied diff, atomically. */
  saveDiff(diff: IndexDiff): void;
}

export function isIncrementalIndexStore(
  store: IndexStore,
): store is IncrementalIndexStore {
  return typeof (store as IncrementalIndexStore).saveDiff === "function";
}

/**
 * A store search queries in place (#109) instead of loading a snapshot.
 *
 * Every method reads on demand and returns plain values; the store keeps
 * nothing proportional to the vault between calls. Search calls `release()`
 * when it is done, so even the connection is not held between searches.
 * `searchVault` treats any throw from these methods as "this store failed
 * for this search" and answers from the in-memory path instead.
 */
export interface QueryableIndexStore extends IncrementalIndexStore, NameSource {
  /** True when the store holds an index built under this ignore state. */
  isReady(ignoreFingerprint: string): boolean;
  /** Replace the whole index (cold build), in one transaction. */
  replaceAll(docs: IndexDiffDoc[], ignoreFingerprint: string): void;
  hasFile(file: string): boolean;
  /** Diff a stat walk against the stored signatures, streaming the rows. */
  diffAgainst(current: FileMtimeEntry[]): FileDiff;
  /** Stream indexed paths in order, optionally inside a folder scope. */
  scanPaths(folderScope: string | null): IterableIterator<string>;
  /** Recency and resolved backlink count per path. */
  hitInfo(files: string[]): Map<string, { mtime: number; links: number }>;
  /** Run one search's reads against a single committed state. */
  readSnapshot<T>(fn: () => T): T;
  /** Close the connection (reopened lazily by the next call). */
  release(): void;
  /** Park an unusable database aside so the next open rebuilds it. */
  discard(): void;
}

export function isQueryableIndexStore(
  store: IndexStore,
): store is QueryableIndexStore {
  return typeof (store as QueryableIndexStore).hitInfo === "function";
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

/** One upserted doc in a diff — the IndexedDoc plus its outgoing links. */
export interface IndexDiffDoc extends IndexedDoc {
  /** Raw wikilink targets, for the links/link_counts tables. */
  outgoingLinks: string[];
}

/**
 * The changes of one applied diff, for `IncrementalIndexStore.saveDiff`.
 *
 * Everything is post-apply state: `upsert` docs carry the NEW signature and
 * link set, and `remove` carries enough (path + basename) to write a
 * tombstone and repair a loaded basename index without the deleted doc.
 */
export interface IndexDiff {
  /** Added or modified docs, post-change. */
  upsert: IndexDiffDoc[];
  /** Removed files (path + basename, for tombstones and index repair). */
  remove: { file: string; basename: string }[];
  /** Ignore fingerprint the diff was applied under. */
  ignoreFingerprint: string;
}

/**
 * A whole-vault index snapshot: everything a fresh process needs to serve
 * searches without walking the vault or reading a note.
 *
 * The field names are the JSON file's, because that is the only format written
 * today and `JsonStore` owns that encoding. `SqliteStore` serves the same
 * shape from its tables, so `search.ts` does not change: `fileMtimes` from
 * `files(mtime,size)`, `docs` and `outgoingLinks` from `files` and
 * `links`, `index` from the basename blob, and `folder` /
 * `ignoreFingerprint` from `meta`.
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
  /**
   * file → inbound backlink count. Advisory: the load path re-derives
   * resolved counts from `docs`/`outgoingLinks` anyway (#92), so a store
   * that keeps per-target tallies (`SqliteStore`) does not persist this
   * field and returns an empty map.
   */
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
 * The one place an implementation is chosen — automatically. `SqliteStore`
 * is the store; `JsonStore` engages only when the database cannot be
 * opened (`node:sqlite` missing, a read-only or network filesystem, an
 * unrecoverable file), so a vault on an exotic setup keeps working.
 *
 * Stores are cached per configPath: a long-lived consumer constructs a
 * `Napkin` per call, and reopening the database (plus its prepared
 * statements) on every search would cost a few ms each time.
 */
export function createIndexStore(configPath: string): IndexStore {
  const kind =
    forcedJsonConfigs.has(configPath) || failures.get(configPath) === PIN_AFTER
      ? "json"
      : "sqlite";
  const key = `${configPath}${kind}`;
  const cached = stores.get(key);
  if (cached) return cached;
  const store =
    kind === "sqlite"
      ? (SqliteStore.open(configPath) ?? new JsonStore(configPath))
      : new JsonStore(configPath);
  stores.set(key, store);
  return store;
}

const stores = new Map<string, IndexStore>();

/** Query-path failures per config dir; at PIN_AFTER the process stops trying SQLite. */
const failures = new Map<string, number>();
const PIN_AFTER = 3;

/** Messages that mean the database FILE is unusable, not just busy. */
const CORRUPTION =
  /malformed|not a database|corrupt|disk image|file is encrypted/i;

/**
 * A query against the store threw (locked, corrupt, I/O). The caller answers
 * that search from the in-memory path; here the store is cleaned up for the
 * next one: a corrupt file is parked aside and the cached handle dropped, so
 * the next open rebuilds. After `PIN_AFTER` failures this process pins
 * `JsonStore` for the vault.
 */
export function reportIndexStoreFailure(
  configPath: string,
  store: IndexStore,
  error: unknown,
): void {
  failures.set(configPath, (failures.get(configPath) ?? 0) + 1);
  const message = error instanceof Error ? error.message : String(error);
  try {
    if (isQueryableIndexStore(store)) {
      if (CORRUPTION.test(message)) {
        store.discard();
        stores.delete(`${configPath}sqlite`);
      } else {
        store.release();
      }
    }
  } catch {
    // Cleanup is best-effort; the search already has its answer.
  }
}

/**
 * Test-only seam: config dirs pinned to `JsonStore` (see
 * `useJsonIndexStore` in test-helpers). Keyed per configPath — every
 * `createTempVault` gets a unique path, so pins never leak between tests,
 * and `resetIndexStoresForTests` deliberately leaves them in place: a test
 * that pins JSON and then resets mid-test (a simulated fresh process)
 * must still observe the pinned store.
 */
const forcedJsonConfigs = new Set<string>();

/** Test-only: pin one vault's config dir to `JsonStore`. */
export function forceJsonIndexStoreForTests(configPath: string): void {
  forcedJsonConfigs.add(configPath);
}

/**
 * Test-only hook: drop the cached store objects, so a test observes a fresh
 * selection (and a fresh SQLite connection) the way a new process would.
 * Called from `resetSearchIndexForTests`.
 */
export function resetIndexStoresForTests(): void {
  stores.clear();
  failures.clear();
}
