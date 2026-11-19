import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
  IndexDiff,
  IndexDiffDoc,
  IndexedDoc,
  IndexSnapshot,
  QueryableIndexStore,
} from "./index-store.js";
import { JsonStore } from "./json-store.js";
import {
  analyzeName,
  type NamePosting,
  type NameSource,
} from "./name-search.js";
import {
  type FileDiff,
  type FileMtimeEntry,
  linkCountKey,
  linkTarget,
} from "./search-cache.js";

/**
 * The SQLite search-index store (#106, part of #94).
 *
 * `.napkin/cache/index-v2.db` — a versioned file name so napkin versions that
 * change the schema never fight over one database. WAL mode, per-file
 * upserts/deletes inside one transaction per diff.
 *
 * Since #109 the store is QUERIED, not loaded: `searchVault` reads what a
 * query needs (candidate paths, mtimes, backlink tallies, basename postings)
 * and keeps nothing resident. The basename MiniSearch blob of v1 is replaced
 * by SQL postings (`name_terms`, `name_vocab`, `files.name_len`) that
 * `name-search.ts` ranks with MiniSearch's exact BM25/prefix/fuzzy formulas.
 *
 * Schema (v2, `PRAGMA user_version = 2`):
 *
 *   meta(k, v)                       'gen', 'ignore_fp'; reserved: 'scan_lease',
 *                                    'last_scan_at', 'body_state' (later issues)
 *   folders(id, path, depth, gen)    folder row per dirname; gen bumps when a
 *                                    direct file is added/changed/removed
 *                                    (reserved for the overview store, #94 s4)
 *   files(id, path, folder_id, basename, basename_lc, depth,
 *         mtime, size, ino, gen,
 *         name_len)                  one row per note; gen = the generation the
 *                                    row was last written; name_len = MiniSearch
 *                                    field length of the basename
 *   name_terms(term, file_id, tf)    basename postings; name_vocab(term) the
 *                                    distinct terms (fuzzy expansion)
 *   links(src, target)               raw outgoing wikilink targets per file id
 *   link_counts(key, n)              classified target key → occurrences;
 *                                    key = lc basename (bare) or 'p:'+ref —
 *                                    the future cross-process delta feed
 *   tombstones(path, basename, gen)  deletions; a later issue prunes by age
 *
 * Generations (`meta.gen`) increase once per write transaction. A file's row
 * commits in the same transaction as everything derived from it, so a crash
 * can never leave a signature that claims data which is missing — the next
 * scan sees the old signature and redoes the work. A file's basename postings
 * commit in the same transaction as its row; edits never touch them (a
 * basename cannot change without a new path).
 *
 * The DB is disposable: open failure, `SQLITE_NOTADB`/corruption, or a
 * schema-version mismatch renames the file aside and recreates it; a second
 * failure makes `open()` return null so `createIndexStore` falls back to
 * `JsonStore`.
 */

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

const CACHE_DIR = "cache";
const DB_FILE = "index-v2.db";
const SCHEMA_VERSION = 2;

/** Test seam: SQLite busy timeout in ms (default 5000). */
let busyTimeoutMs = 5000;
export function setBusyTimeoutForTests(ms: number): void {
  busyTimeoutMs = ms;
}

let sqliteModule: SqliteModule | null | undefined;

/**
 * Import `node:sqlite`, suppressing only its ExperimentalWarning (Node 22
 * prints it on first load; 24+ print nothing). The warning is filtered for
 * the synchronous duration of the `require` only, so every other warning —
 * experimental or not — still reaches stderr.
 *
 * The module is loaded through `createRequire` because a static `import`
 * would run before this code has a chance to install the filter.
 */
export function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (
    this: typeof process,
    warning: unknown,
    ...rest: unknown[]
  ) {
    const message =
      typeof warning === "string"
        ? warning
        : (warning as { message?: string } | undefined)?.message;
    const opt = rest[0];
    const type =
      typeof opt === "string"
        ? opt
        : (opt as { type?: string } | undefined)?.type;
    if (
      typeof message === "string" &&
      message.includes("SQLite") &&
      typeof type === "string" &&
      type.includes("Experimental")
    ) {
      return undefined as never;
    }
    return emitWarning.apply(process, [warning, ...rest] as never);
  } as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)("node:sqlite");
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqliteModule ?? null;
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta(
  k TEXT PRIMARY KEY,
  v
);
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  depth INTEGER NOT NULL,
  gen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  folder_id INTEGER NOT NULL,
  basename TEXT NOT NULL,
  basename_lc TEXT NOT NULL,
  depth INTEGER NOT NULL,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  ino INTEGER,
  gen INTEGER NOT NULL,
  name_len INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS files_gen ON files(gen);
CREATE INDEX IF NOT EXISTS files_base ON files(basename_lc, depth, path);
CREATE TABLE IF NOT EXISTS links(
  src INTEGER NOT NULL,
  target TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE TABLE IF NOT EXISTS link_counts(
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones(
  path TEXT PRIMARY KEY,
  basename TEXT NOT NULL,
  gen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS name_terms(
  term TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  tf INTEGER NOT NULL,
  PRIMARY KEY(term, file_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS name_vocab(
  term TEXT PRIMARY KEY
) WITHOUT ROWID;
`;

/** Statements shared by the write paths; prepared once per open store. */
interface Stmts {
  nextGen: StatementSync;
  setMeta: StatementSync;
  folderUpsert: StatementSync;
  fileUpsert: StatementSync;
  fileIdByPath: StatementSync;
  fileDelete: StatementSync;
  linksOf: StatementSync;
  linksDelete: StatementSync;
  linkInsert: StatementSync;
  countBump: StatementSync;
  countPrune: StatementSync;
  tombUpsert: StatementSync;
  tombDelete: StatementSync;
  nameInsert: StatementSync;
  nameDelete: StatementSync;
  vocabInsert: StatementSync;
  vocabPrune: StatementSync;
  fileRow: StatementSync;
  allFiles: StatementSync;
  allLinks: StatementSync;
  fileCount: StatementSync;
}

function prepareAll(db: DatabaseSync): Stmts {
  return {
    nextGen: db.prepare(
      "INSERT INTO meta(k, v) VALUES('gen', 1) " +
        "ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 " +
        "RETURNING CAST(v AS INTEGER) AS gen",
    ),
    setMeta: db.prepare(
      "INSERT INTO meta(k, v) VALUES(?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ),
    folderUpsert: db.prepare(
      "INSERT INTO folders(path, depth, gen) VALUES(?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET gen = excluded.gen " +
        "RETURNING id",
    ),
    fileUpsert: db.prepare(
      "INSERT INTO files(" +
        "path, folder_id, basename, basename_lc, depth, mtime, size, ino, gen, name_len" +
        ") VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET " +
        "folder_id = excluded.folder_id, basename = excluded.basename, " +
        "basename_lc = excluded.basename_lc, depth = excluded.depth, " +
        "mtime = excluded.mtime, size = excluded.size, gen = excluded.gen, " +
        "name_len = excluded.name_len",
    ),
    fileIdByPath: db.prepare("SELECT id FROM files WHERE path = ?"),
    fileDelete: db.prepare("DELETE FROM files WHERE path = ?"),
    linksOf: db.prepare(
      "SELECT target FROM links WHERE src = ? ORDER BY rowid",
    ),
    linksDelete: db.prepare("DELETE FROM links WHERE src = ?"),
    linkInsert: db.prepare("INSERT INTO links(src, target) VALUES(?, ?)"),
    countBump: db.prepare(
      "INSERT INTO link_counts(key, n) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET n = n + excluded.n",
    ),
    countPrune: db.prepare("DELETE FROM link_counts WHERE n <= 0"),
    tombUpsert: db.prepare(
      "INSERT INTO tombstones(path, basename, gen) VALUES(?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET basename = excluded.basename, " +
        "gen = excluded.gen",
    ),
    tombDelete: db.prepare("DELETE FROM tombstones WHERE path = ?"),
    nameInsert: db.prepare(
      "INSERT OR REPLACE INTO name_terms(term, file_id, tf) VALUES(?, ?, ?)",
    ),
    nameDelete: db.prepare(
      "DELETE FROM name_terms WHERE term = ? AND file_id = ?",
    ),
    vocabInsert: db.prepare("INSERT OR IGNORE INTO name_vocab(term) VALUES(?)"),
    vocabPrune: db.prepare(
      "DELETE FROM name_vocab WHERE term = ? AND NOT EXISTS " +
        "(SELECT 1 FROM name_terms WHERE term = ?)",
    ),
    fileRow: db.prepare("SELECT id, basename FROM files WHERE path = ?"),
    allFiles: db.prepare(
      "SELECT id, path, basename, mtime, size, gen FROM files",
    ),
    // Grouped per source file: 28k rows instead of 174k on a large vault,
    // so the load allocates ~6x fewer transient row objects (V8 keeps the
    // high-water mark as heapTotal for the process lifetime). Group order
    // follows the links_src index scan, and within a group json_group_array
    // preserves the rowid order the per-row query produced.
    allLinks: db.prepare(
      "SELECT src, json_group_array(target) AS targets FROM links GROUP BY src",
    ),
    fileCount: db.prepare("SELECT COUNT(*) AS n FROM files"),
  };
}

/** Write `.napkin/cache/.gitignore` once so the DB is never committed. */
function writeCacheGitignore(dir: string): void {
  const gitignore = path.join(dir, ".gitignore");
  try {
    if (fs.readFileSync(gitignore, "utf-8") === "*\n") return;
  } catch {
    // Missing or unreadable — (re)write below.
  }
  fs.writeFileSync(gitignore, "*\n");
}

interface FileRow {
  id: number;
  path: string;
  basename: string;
  mtime: number;
  size: number;
  gen: number;
}

/**
 * Open (or create) the database with the given journal mode and initialise
 * the schema. Returns null on any failure — the caller decides whether to
 * rename the file aside or fall back.
 */
function tryOpen(
  sqlite: SqliteModule,
  dbPath: string,
  journalMode: "WAL" | "DELETE",
): DatabaseSync | null {
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { timeout: busyTimeoutMs });
    db.exec(`PRAGMA journal_mode = ${journalMode}`);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // 2 MB page cache: the connection is closed after every search (#109),
    // so nothing stays resident between queries.
    db.exec("PRAGMA cache_size = -2048");
    db.exec("PRAGMA foreign_keys = OFF");
    const row = db.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const version = row?.user_version ?? 0;
    // A versioned file name covers cross-version skew; a nonzero, different
    // user_version means a same-name schema we cannot read — rebuild.
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new Error(
        `index schema version ${version}, expected ${SCHEMA_VERSION}`,
      );
    }
    db.exec(SCHEMA_DDL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    // Probe the tables a schema-skewed file might be missing columns on.
    db.prepare(
      "SELECT id, path, folder_id, basename, basename_lc, depth, mtime, size, ino, gen, name_len FROM files LIMIT 0",
    ).get();
    db.prepare("SELECT term, file_id, tf FROM name_terms LIMIT 0").get();
    db.prepare("SELECT term FROM name_vocab LIMIT 0").get();
    db.prepare("SELECT src, target FROM links LIMIT 0").get();
    return db;
  } catch (error) {
    lastOpenError = error instanceof Error ? error.message : String(error);
    try {
      db?.close();
    } catch {
      // Nothing to close cleanly.
    }
    return null;
  }
}

/** Why the last `tryOpen` failed, so a reopen failure can say corrupt vs busy. */
let lastOpenError = "";

export class SqliteStore implements QueryableIndexStore, NameSource {
  /**
   * True while `db` is closed. The connection is closed at the end of
   * `load()` — the one bulk read — and lazily reopened by `ensureOpen()`
   * on the next write: an open connection costs ~15 MB of sqlite-side memory
   * per process (page cache, statements, wal-index), which a long-lived
   * reader process would otherwise hold forever (#106 review).
   */
  private closed = false;

  private constructor(
    private readonly configPath: string,
    private readonly dbPath: string,
    private db: DatabaseSync,
    private stmts: Stmts,
  ) {}

  /**
   * Reopen the database if it was closed after a `load()`. Reopen cost is
   * a few ms (pragmas + idempotent DDL + prepare) — only paid once per
   * operation, and diffs are rare compared to searches.
   */
  private ensureOpen(): void {
    if (!this.closed) return;
    const sqlite = loadSqlite();
    if (sqlite === null) throw new Error("node:sqlite unavailable");
    for (const mode of ["WAL", "DELETE"] as const) {
      const db = tryOpen(sqlite, this.dbPath, mode);
      if (db !== null) {
        this.db = db;
        this.stmts = prepareAll(db);
        this.closed = false;
        return;
      }
    }
    throw new Error(`cannot reopen index db ${this.dbPath}: ${lastOpenError}`);
  }

  private closeDb(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
    this.closed = true;
  }

  /**
   * Open the vault's SQLite store, creating it when missing.
   *
   * Recovery ladder: open with WAL (then DELETE journaling, for filesystems
   * where shared-memory WAL cannot mmap); on failure rename the file aside
   * and repeat; on failure again return null so the caller falls back to
   * `JsonStore`. When the new database is empty and a valid
   * `search-cache.json` exists, it is imported — the first SqliteStore run
   * costs one bulk write instead of a cold build.
   */
  static open(configPath: string): SqliteStore | null {
    const sqlite = loadSqlite();
    if (sqlite === null) return null;

    const dir = path.join(configPath, CACHE_DIR);
    const dbPath = path.join(dir, DB_FILE);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeCacheGitignore(dir);
    } catch {
      return null;
    }

    let db: DatabaseSync | null = null;
    for (const mode of ["WAL", "DELETE"] as const) {
      db = tryOpen(sqlite, dbPath, mode);
      if (db !== null) break;
    }
    if (db === null) {
      // Corrupt, not-a-database, or wrong schema — park it and recreate.
      // The -wal/-shm sidecars must move with it: an orphaned WAL replays
      // into the fresh database and resurrects the very rows we parked.
      parkAside(dbPath);
      for (const mode of ["WAL", "DELETE"] as const) {
        db = tryOpen(sqlite, dbPath, mode);
        if (db !== null) break;
      }
      if (db === null) return null;
    }

    const store = new SqliteStore(configPath, dbPath, db, prepareAll(db));
    store.migrateFromJson();
    return store;
  }

  /**
   * Import file rows and links from a valid v1 database (#106 layout), so the
   * move to v2 does not cost a cold build. The v1 file is only read and is
   * left in place: older napkin processes keep writing it until they restart.
   * Name postings are derived from the basenames by `replaceAll`.
   */
  private importV1(): boolean {
    const v1Path = path.join(path.dirname(this.dbPath), "index-v1.db");
    if (!fs.existsSync(v1Path)) return false;
    const sqlite = loadSqlite();
    if (sqlite === null) return false;
    let v1: DatabaseSync | undefined;
    try {
      v1 = new sqlite.DatabaseSync(v1Path, { readOnly: true, timeout: 2000 });
      const fp = v1.prepare("SELECT v FROM meta WHERE k = 'ignore_fp'").get() as
        | { v: unknown }
        | undefined;
      if (typeof fp?.v !== "string") return false;
      const links = new Map<number, string[]>();
      for (const row of v1
        .prepare("SELECT src, target FROM links ORDER BY rowid")
        .iterate() as Iterable<{ src: number; target: string }>) {
        const list = links.get(row.src);
        if (list) list.push(row.target);
        else links.set(row.src, [row.target]);
      }
      const docs: IndexDiffDoc[] = [];
      for (const row of v1
        .prepare(
          "SELECT id, path, basename, mtime, size FROM files ORDER BY path",
        )
        .iterate() as Iterable<{
        id: number;
        path: string;
        basename: string;
        mtime: number;
        size: number;
      }>) {
        docs.push({
          file: row.path,
          basename: row.basename,
          mtime: row.mtime,
          size: row.size,
          outgoingLinks: links.get(row.id) ?? [],
        });
      }
      if (docs.length === 0) return false;
      this.replaceAll(docs, fp.v);
      return true;
    } catch {
      return false;
    } finally {
      try {
        v1?.close();
      } catch {
        // Read-only handle; nothing to flush.
      }
    }
  }

  /**
   * One-shot migration: an empty database adopts a valid JSON snapshot
   * instead of forcing the first SqliteStore search into a cold build.
   * The JSON file is left in place — it is still the fallback store's cache,
   * and its removal is a later cleanup step (#94 step 7).
   */
  private migrateFromJson(): void {
    try {
      this.ensureOpen();
      const count = this.stmts.fileCount.get() as { n: number } | undefined;
      if ((count?.n ?? 0) > 0) return;
      if (this.readMeta().ignoreFp !== undefined) return;
      if (this.importV1()) return;
      const snapshot = new JsonStore(this.configPath).load();
      if (snapshot !== null) this.save(snapshot);
    } catch {
      // Migration is best-effort: a failed import just means a cold build.
    }
  }

  /**
   * Persist a whole snapshot in one transaction (cold build, JSON import).
   * All derived tables are rebuilt from `docs`/`outgoingLinks`, matching
   * the JSON store's replace-everything semantics.
   */
  save(snapshot: IndexSnapshot): void {
    this.replaceAll(
      snapshot.docs.map((doc) => ({
        ...doc,
        outgoingLinks: snapshot.outgoingLinks[doc.file] ?? [],
      })),
      snapshot.ignoreFingerprint,
    );
  }

  /** Replace the whole index with `docs` in one transaction (cold build). */
  replaceAll(docs: IndexDiffDoc[], ignoreFingerprint: string): void {
    this.ensureOpen();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const gen = this.bumpGen();
      db.exec("DELETE FROM links");
      db.exec("DELETE FROM files");
      db.exec("DELETE FROM folders");
      db.exec("DELETE FROM link_counts");
      db.exec("DELETE FROM tombstones");
      db.exec("DELETE FROM name_terms");
      db.exec("DELETE FROM name_vocab");
      const countDeltas = new Map<string, number>();
      for (const doc of docs) {
        this.upsertDoc(gen, doc, doc.outgoingLinks, countDeltas);
      }
      this.applyCountDeltas(countDeltas);
      this.stmts.setMeta.run("ignore_fp", ignoreFingerprint);
      db.exec("COMMIT");
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  /**
   * Persist one applied diff in a single transaction.
   *
   * Per file: replace the `files` row (id preserved via the UNIQUE path),
   * replace its `links` rows, and adjust `link_counts` by the difference
   * between the old and new link sets. Deletes write a tombstone and drop
   * the file's basename postings.
   */
  saveDiff(diff: IndexDiff): void {
    this.ensureOpen();
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const gen = this.bumpGen();
      const countDeltas = new Map<string, number>();
      for (const removed of diff.remove) {
        const row = this.stmts.fileRow.get(removed.file) as
          | { id: number; basename: string }
          | undefined;
        if (row !== undefined) {
          for (const { target } of this.linksOf(row.id)) {
            bumpDelta(countDeltas, linkCountKey(linkTarget(target)), -1);
          }
          this.stmts.linksDelete.run(row.id);
          this.dropNameTerms(row.id, row.basename);
          this.stmts.fileDelete.run(removed.file);
        }
        this.touchFolder(parentDir(removed.file), gen);
        this.stmts.tombUpsert.run(removed.file, removed.basename, gen);
      }
      for (const doc of diff.upsert) {
        this.upsertDoc(gen, doc, doc.outgoingLinks, countDeltas);
      }
      this.stmts.setMeta.run("ignore_fp", diff.ignoreFingerprint);
      this.applyCountDeltas(countDeltas);
      db.exec("COMMIT");
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  /**
   * Materialize the stored metadata as a snapshot, or null when there is
   * none usable. Search does NOT use this since #109 (it queries the store
   * per search); it remains for the JSON-compat contract, tests and
   * diagnostics. `index` is empty: the basename index is never serialized,
   * and a consumer that feeds it to MiniSearch.loadJSON simply cold-builds.
   *
   * Never throws: a database that fails mid-read is corrupt or unreadable,
   * which the caller treats exactly like a missing cache — a cold build.
   * Resolved backlink counts are not persisted (per-target tallies are, in
   * `link_counts`); `backlinkCounts` is advisory and `loadFromDiskCache`
   * re-derives it either way.
   */
  load(): IndexSnapshot | null {
    try {
      this.ensureOpen();
      const meta = this.readMeta();
      // No fingerprint means nothing was ever saved (or a failed import).
      if (meta.ignoreFp === undefined) return null;

      // Streamed, not .all(): materialising 200k row objects at once was
      // ~45 MB of transient heap that V8 then retains as arena. iterate()
      // hands each row over one at a time.
      const docs: IndexedDoc[] = [];
      const fileMtimes: IndexSnapshot["fileMtimes"] = {};
      const outgoingLinks: IndexSnapshot["outgoingLinks"] = {};
      const idToPath = new Map<number, string>();
      for (const row of this.stmts.allFiles.iterate() as Iterable<FileRow>) {
        docs.push({
          file: row.path,
          basename: row.basename,
          mtime: row.mtime,
          size: row.size,
        });
        fileMtimes[row.path] = { mtime: row.mtime, size: row.size };
        idToPath.set(row.id, row.path);
        // Every file gets an entry, even without links — the JSON snapshot
        // carries explicit empty arrays and loadFromDiskCache merges the map.
        outgoingLinks[row.path] = [];
      }
      // JS string sort (UTF-16 code units) — the same order listFiles'
      // results.sort() produces, so the doc order — and every tie-break that
      // depends on it — matches a JSON snapshot byte for byte. SQLite's
      // BINARY collation can differ on non-ASCII paths.
      docs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
      for (const row of this.stmts.allLinks.iterate() as Iterable<{
        src: number;
        targets: string;
      }>) {
        const file = idToPath.get(row.src);
        if (file !== undefined) {
          outgoingLinks[file] = JSON.parse(row.targets) as string[];
        }
      }
      // Hand the page cache and freed SQL memory back to malloc — the bulk
      // load just touched every page, and no more reads are coming.
      try {
        this.db.exec("PRAGMA shrink_memory");
      } catch {
        // Older SQLite builds may lack it; memory stays cached, still fine.
      }

      return {
        folder: null,
        fileMtimes,
        index: "",
        docs,
        backlinkCounts: {},
        outgoingLinks,
        ignoreFingerprint: meta.ignoreFp,
      };
    } catch {
      return null;
    } finally {
      // See the closed flag docs: release the connection after the bulk read.
      this.closeDb();
    }
  }

  // ── Query path (#109) ───────────────────────────────────────────
  //
  // Everything below reads on demand and returns plain values; nothing is
  // cached on the instance. `release()` closes the connection so a process
  // between searches holds no SQLite memory either.

  /** True when the store holds an index built under this ignore state. */
  isReady(ignoreFingerprint: string): boolean {
    this.ensureOpen();
    return this.readMeta().ignoreFp === ignoreFingerprint;
  }

  hasFile(file: string): boolean {
    this.ensureOpen();
    return this.stmts.fileIdByPath.get(file) !== undefined;
  }

  /**
   * Compare a fresh stat walk against the stored signatures. The stored rows
   * are streamed one at a time; the only whole-vault structure is the walk
   * result the caller already holds. A file is changed when mtime OR size
   * differs, like `diffFileMtimes`.
   */
  diffAgainst(current: FileMtimeEntry[]): FileDiff {
    this.ensureOpen();
    const byFile = new Map<string, FileMtimeEntry>();
    for (const entry of current) byFile.set(entry.file, entry);
    const unchanged = new Set<string>();
    const toRemove: string[] = [];
    const rows = this.db
      .prepare("SELECT path, mtime, size FROM files")
      .iterate() as Iterable<{ path: string; mtime: number; size: number }>;
    for (const row of rows) {
      const entry = byFile.get(row.path);
      if (entry === undefined) toRemove.push(row.path);
      else if (entry.mtime === row.mtime && entry.size === row.size) {
        unchanged.add(row.path);
      }
    }
    const toAdd = current.filter((entry) => !unchanged.has(entry.file));
    return {
      toAdd,
      toRemove,
      unchanged: toAdd.length === 0 && toRemove.length === 0,
    };
  }

  /** Stream indexed paths in order, optionally within a folder scope. */
  *scanPaths(folderScope: string | null): IterableIterator<string> {
    this.ensureOpen();
    const stmt =
      folderScope === null
        ? this.db.prepare("SELECT path FROM files ORDER BY path")
        : this.db.prepare(
            "SELECT path FROM files WHERE path >= ? AND path < ? ORDER BY path",
          );
    const rows = (
      folderScope === null
        ? stmt.iterate()
        : stmt.iterate(`${folderScope}/`, `${folderScope}0`)
    ) as Iterable<{ path: string }>;
    for (const row of rows) yield row.path;
  }

  /**
   * Recency and resolved backlink count for each path, in one query.
   * Resolution mirrors search.ts `resolveAllCounts`: a path-style link counts
   * for the file spelled exactly like its ref; a bare link counts for the
   * shallowest file of its basename (ties by path).
   */
  hitInfo(files: string[]): Map<string, { mtime: number; links: number }> {
    this.ensureOpen();
    const out = new Map<string, { mtime: number; links: number }>();
    if (files.length === 0) return out;
    const rows = this.db
      .prepare(
        "SELECT f.path AS path, f.mtime AS mtime, " +
          "COALESCE((SELECT n FROM link_counts WHERE key = 'p:' || f.path), 0) AS pn, " +
          "CASE WHEN f.path = (SELECT g.path FROM files g " +
          "WHERE g.basename_lc = f.basename_lc ORDER BY g.depth, g.path LIMIT 1) " +
          "THEN COALESCE((SELECT n FROM link_counts WHERE key = f.basename_lc), 0) " +
          "ELSE 0 END AS bn " +
          "FROM files f WHERE f.path IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(files)) as unknown as {
      path: string;
      mtime: number;
      pn: number;
      bn: number;
    }[];
    for (const row of rows) {
      out.set(row.path, { mtime: row.mtime, links: row.pn + row.bn });
    }
    return out;
  }

  nameStats(): { docs: number; lenSum: number } {
    this.ensureOpen();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS docs, COALESCE(SUM(name_len), 0) AS lenSum FROM files",
      )
      .get() as { docs: number; lenSum: number };
    return { docs: row.docs, lenSum: row.lenSum };
  }

  postingsWithPrefix(prefix: string): NamePosting[] {
    this.ensureOpen();
    return this.db
      .prepare(
        "SELECT n.term AS term, n.file_id AS fileId, n.tf AS tf, " +
          "f.name_len AS nameLen, f.path AS path " +
          "FROM name_terms n JOIN files f ON f.id = n.file_id " +
          "WHERE n.term >= ? AND n.term < ? ORDER BY n.term, n.file_id",
      )
      .all(prefix, prefixUpperBound(prefix)) as unknown as NamePosting[];
  }

  postingsForTerms(terms: string[]): NamePosting[] {
    this.ensureOpen();
    if (terms.length === 0) return [];
    return this.db
      .prepare(
        "SELECT n.term AS term, n.file_id AS fileId, n.tf AS tf, " +
          "f.name_len AS nameLen, f.path AS path " +
          "FROM name_terms n JOIN files f ON f.id = n.file_id " +
          "WHERE n.term IN (SELECT value FROM json_each(?)) " +
          "ORDER BY n.term, n.file_id",
      )
      .all(JSON.stringify(terms)) as unknown as NamePosting[];
  }

  vocabBetween(min: number, max: number): string[] {
    this.ensureOpen();
    return (
      this.db
        .prepare(
          "SELECT term FROM name_vocab WHERE length(term) BETWEEN ? AND ? ORDER BY term",
        )
        .all(min, max) as unknown as { term: string }[]
    ).map((r) => r.term);
  }

  /**
   * Run the read phase of one search inside a single read transaction, so
   * statistics, postings, the path scan and hit info all come from the same
   * committed state even when another process writes in between (WAL gives
   * each statement the newest commit otherwise). The callback must finish
   * every read it starts, including iterators, before it returns.
   */
  readSnapshot<T>(fn: () => T): T {
    this.ensureOpen();
    this.db.exec("BEGIN DEFERRED");
    try {
      return fn();
    } finally {
      // A read-only transaction: COMMIT and ROLLBACK are equivalent; the
      // connection may already be gone if the callback closed it.
      if (!this.closed && this.db.isTransaction) this.db.exec("COMMIT");
    }
  }

  /** Close the connection; the next call reopens it lazily. */
  release(): void {
    if (!this.closed) this.closeDb();
  }

  /** Park a database a query found unusable aside, so the next open rebuilds. */
  discard(): void {
    this.closeDb();
    parkAside(this.dbPath);
  }

  // ── Internals ───────────────────────────────────────────────────

  private bumpGen(): number {
    const row = this.stmts.nextGen.get() as { gen: number } | undefined;
    return row?.gen ?? 0;
  }

  private readMeta(): { ignoreFp?: string } {
    this.ensureOpen();
    const row = this.db
      .prepare("SELECT v FROM meta WHERE k = 'ignore_fp'")
      .get() as { v: unknown } | undefined;
    return { ignoreFp: typeof row?.v === "string" ? row.v : undefined };
  }

  private linksOf(src: number): { target: string }[] {
    return this.stmts.linksOf.all(src) as unknown as { target: string }[];
  }

  /** Insert/update one file row, its links, and its folder row. */
  private upsertDoc(
    gen: number,
    doc: IndexedDoc,
    targets: string[],
    countDeltas: Map<string, number>,
  ): void {
    const dir = parentDir(doc.file);
    const folderId = this.touchFolder(dir, gen);
    const existed = this.stmts.fileIdByPath.get(doc.file) !== undefined;
    const analysis = analyzeName(doc.basename);
    this.stmts.fileUpsert.run(
      doc.file,
      folderId,
      doc.basename,
      doc.basename.toLowerCase(),
      doc.file.split("/").length - 1,
      doc.mtime,
      doc.size,
      gen,
      analysis.length,
    );
    const row = this.stmts.fileIdByPath.get(doc.file) as
      | { id: number }
      | undefined;
    if (row === undefined) {
      throw new Error(`files row missing after upsert: ${doc.file}`);
    }
    // A path's basename never changes (a rename is remove + add), so only a
    // new row needs postings; an edit leaves them alone.
    if (!existed) {
      for (const [term, tf] of analysis.terms) {
        this.stmts.nameInsert.run(term, row.id, tf);
        this.stmts.vocabInsert.run(term);
      }
    }
    for (const { target } of this.linksOf(row.id)) {
      bumpDelta(countDeltas, linkCountKey(linkTarget(target)), -1);
    }
    this.stmts.linksDelete.run(row.id);
    for (const target of targets) {
      this.stmts.linkInsert.run(row.id, target);
      bumpDelta(countDeltas, linkCountKey(linkTarget(target)), 1);
    }
    this.stmts.tombDelete.run(doc.file);
  }

  /** Upsert a folder row and bump its generation; returns the folder id. */
  private touchFolder(dir: string, gen: number): number {
    const depth = dir === "" ? 0 : dir.split("/").length;
    const row = this.stmts.folderUpsert.get(dir, depth, gen) as
      | { id: number }
      | undefined;
    if (row === undefined) {
      throw new Error(`folders row missing after upsert: ${dir}`);
    }
    return row.id;
  }

  /** Remove a file's basename postings and any vocabulary term they orphan. */
  private dropNameTerms(fileId: number, basename: string): void {
    for (const term of analyzeName(basename).terms.keys()) {
      this.stmts.nameDelete.run(term, fileId);
      this.stmts.vocabPrune.run(term, term);
    }
  }

  private applyCountDeltas(deltas: Map<string, number>): void {
    for (const [key, delta] of deltas) {
      if (delta !== 0) this.stmts.countBump.run(key, delta);
    }
    this.stmts.countPrune.run();
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // Already rolled back (or never began) — the failed transaction left
      // the previous committed state intact either way.
    }
  }

  /** Close the underlying database handle (tests; stores are cached). */
  close(): void {
    this.closeDb();
  }

  /** Test-only: the persisted per-target link tallies. */
  linkCountsForTests(): Record<string, number> {
    this.ensureOpen();
    const rows = this.db
      .prepare("SELECT key, n FROM link_counts ORDER BY key")
      .all() as unknown as { key: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.n]));
  }

  /**
   * Test-only: path-style link refs that count although no file has that
   * exact path (the in-memory index keeps them too; search never shows them).
   */
  phantomRefCountsForTests(): Map<string, number> {
    this.ensureOpen();
    const rows = this.db
      .prepare(
        "SELECT substr(key, 3) AS ref, n FROM link_counts " +
          "WHERE key LIKE 'p:%' AND substr(key, 3) NOT IN (SELECT path FROM files)",
      )
      .all() as unknown as { ref: string; n: number }[];
    const hasBase = this.db.prepare(
      "SELECT 1 AS x FROM files WHERE basename_lc = ? LIMIT 1",
    );
    const out = new Map<string, number>();
    for (const { ref, n } of rows) {
      const key = path.basename(ref, ".md").toLowerCase();
      if (hasBase.get(key) !== undefined) out.set(ref, n);
    }
    return out;
  }

  /** Test-only: the stored signature of one file. */
  fileForTests(
    file: string,
  ): { file: string; mtime: number; size: number } | undefined {
    this.ensureOpen();
    const row = this.db
      .prepare("SELECT mtime, size FROM files WHERE path = ?")
      .get(file) as { mtime: number; size: number } | undefined;
    return row === undefined ? undefined : { file, ...row };
  }

  /** Test-only snapshot of the store's bookkeeping. */
  inspectForTests(): {
    gen: number;
    nameTerms: number;
    nameVocab: number;
    fileCount: number;
    linkCount: number;
    tombstones: number;
  } {
    this.ensureOpen();
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const genRow = this.db
      .prepare("SELECT CAST(v AS INTEGER) AS gen FROM meta WHERE k = 'gen'")
      .get() as { gen: number } | undefined;
    return {
      gen: genRow?.gen ?? 0,
      nameTerms: scalar("SELECT COUNT(*) AS n FROM name_terms"),
      nameVocab: scalar("SELECT COUNT(*) AS n FROM name_vocab"),
      fileCount: scalar("SELECT COUNT(*) AS n FROM files"),
      linkCount: scalar("SELECT COUNT(*) AS n FROM links"),
      tombstones: scalar("SELECT COUNT(*) AS n FROM tombstones"),
    };
  }
}

/** Rename the DB and its WAL/SHM sidecars together (see `open`). */
function parkAside(dbPath: string): void {
  const stamp = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.renameSync(
        `${dbPath}${suffix}`,
        `${dbPath}${suffix}.corrupt-${stamp}`,
      );
    } catch {
      // A missing sidecar is fine.
    }
  }
}

/** Accumulate one signed change into a per-key delta map. */
function bumpDelta(
  deltas: Map<string, number>,
  key: string,
  delta: number,
): void {
  deltas.set(key, (deltas.get(key) ?? 0) + delta);
}

/** Vault-relative parent directory of a file path ("" at the root). */
function parentDir(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "" : file.slice(0, idx);
}

/**
 * Exclusive upper bound for "every string that starts with `prefix`" under
 * SQLite's BINARY collation (UTF-8 bytes, i.e. code point order): the prefix
 * with its last code point incremented, trailing U+10FFFF dropped first. A
 * fixed `prefix + U+10FFFF` bound would miss terms whose next code point is
 * U+10FFFF itself. With no successor (empty or all U+10FFFF) every string
 * at or above the prefix qualifies, so the bound is past the largest one.
 */
export function prefixUpperBound(prefix: string): string {
  const cps = [...prefix].map((c) => c.codePointAt(0) as number);
  while (cps.length > 0 && cps[cps.length - 1] === 0x10ffff) cps.pop();
  if (cps.length === 0) return "\u{10FFFF}".repeat(prefix.length + 64);
  let next = (cps.pop() as number) + 1;
  if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
  return String.fromCodePoint(...cps, next);
}
