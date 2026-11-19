import * as fs from "node:fs";
import * as path from "node:path";
import { loadSqlite } from "./sqlite-store.js";

/**
 * The SQLite per-note overview store (#118).
 *
 * `.napkin/cache/overview-v2.db` — a separate, versioned file name next to
 * the search store's `index-v2.db` (deliberately NOT tables in that
 * database: the two stores have different lifecycles, and a schema bump here
 * must not force a search-index rebuild). It replaces
 * `overview-folders-cache.json` as the per-folder data store — the JSON
 * file stays only as the fallback for environments where SQLite cannot be
 * used, the same rule the search store follows.
 *
 * The #86 folder cache re-tokenized every note of a folder when one note
 * changed: a miss touching a 2,000-note folder re-read and re-tokenized all
 * of them. This store keeps ONE ROW PER NOTE with the note's term data as a
 * blob, so a changed folder re-aggregates from its notes' blobs in sorted
 * path order — which reproduces buildFolderData's term order exactly (the
 * file list is sorted path order; the folder Map's insertion order is
 * (note rank, first-seen position within the note)) — and re-tokenizes only
 * the notes whose (mtime, size) actually changed.
 *
 * Schema (v1, `PRAGMA user_version = 1`):
 *
 *   meta(k, v)                              'format' (OVERVIEW_CACHE_VERSION),
 *                                           'ignore_fp', 'templates_folder',
 *                                           'flags' (Uint8 blob, below)
 *   terms(id, term UNIQUE)                  the term dictionary (bigrams
 *                                           included); ids carry no meaning
 *                                           beyond identity within this DB
 *   notes(path, folder, mtime, size,        one row per note; (mtime, size)
 *         skip, tags, heads, data)          is the freshness key (the same
 *                                           pair the JSON folder sig uses).
 *                                           skip=1 marks a malformed-
 *                                           frontmatter note; tags is JSON,
 *                                           heads is JSON
 *                                           [[headingText, [termId,…]],…]
 *                                           per unique heading text in
 *                                           first-seen order, data is an
 *                                           Int32Array blob:
 *                                           [nNh, (id,count)×nNh, nBody,
 *                                           (id,count)×nBody] — non-heading
 *                                           weighted terms, then body terms,
 *                                           each in first-seen order
 *   folders(path, notes, tags, warn,        one row per folder — the
 *           tfids, cand, full)              aggregate its notes' blobs
 *                                           produce: tfids is an Int32Array
 *                                           of tf term ids in tf order (the
 *                                           df input), cand an Int32Array of
 *                                           (id, tf) keyword-candidate pairs
 *                                           in tf order (every
 *                                           isCandidateKeyword input is
 *                                           folder-local, so the filter runs
 *                                           at aggregation time), full is an
 *                                           optional Int32Array holding the
 *                                           folder's complete term data
 *                                           ([nTf,(id,tf)×, nBody,(id,tf)×,
 *                                           nHead,(id,n)×, nHeadOnly,ids×,
 *                                           nTop,(id,tf)×]) — populated only
 *                                           for folders a sibling collapse
 *                                           could touch (full bodyTF is
 *                                           needed to merge exactly)
 *
 * The 'flags' meta blob is a dense Uint8Array indexed by term id:
 * bit 0 = term contains a space (bigram), bit 1 = self-pair ("x x"). It
 * replaces per-row term-text reads at aggregation and scoring time.
 *
 * There is intentionally no secondary index on term ids and no SQL-side df:
 * document frequency is exact by construction when recomputed on each miss
 * from the folders' tfids blobs (~25 ms on a 29k-note vault), and writes are
 * a handful of per-note upserts plus one folder row each.
 *
 * The DB is disposable: open failure, corruption, or a schema-version
 * mismatch renames the file aside and recreates it; a second failure makes
 * `open()` return null so `createOverviewStore` falls back to the JSON
 * folder cache.
 */

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

const CACHE_DIR = "cache";
const DB_FILE = "overview-v2.db";
const SCHEMA_VERSION = 1;

let busyTimeoutMs = 5000;
/** Test seam: SQLite busy timeout in ms (default 5000). */
export function setOverviewBusyTimeoutForTests(ms: number): void {
  busyTimeoutMs = ms;
}

const SCHEMA_DDL =
  [
    "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v)",
    // No UNIQUE constraint: the cold dictionary flush inserts in id order
    // (append-only on the rowid) and builds terms_term afterwards — a live
    // UNIQUE index would take 1.4M random inserts either way (~7 s vs ~2 s).
    "CREATE TABLE IF NOT EXISTS terms(id INTEGER PRIMARY KEY, term TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, folder TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, skip INTEGER NOT NULL, tags TEXT NOT NULL, heads TEXT NOT NULL, data BLOB)",
    "CREATE TABLE IF NOT EXISTS folders(path TEXT PRIMARY KEY, notes INTEGER NOT NULL, tags TEXT NOT NULL, warn TEXT NOT NULL, tfids BLOB, cand BLOB, full BLOB)",
  ].join(";\n") + ";";

interface Stmts {
  metaGet: StatementSync;
  metaSet: StatementSync;
  noteMetaAll: StatementSync;
  noteGet: StatementSync;
  noteUpsert: StatementSync;
  noteDelete: StatementSync;
  noteDeleteFolder: StatementSync;
  folderUpsert: StatementSync;
  folderDelete: StatementSync;
  folderPaths: StatementSync;
  folderInfo: StatementSync;
  folderRows: StatementSync;
  folderFull: StatementSync;
  termIdsBatch: StatementSync;
  termTextsBatch: StatementSync;
  termInsert: StatementSync;
}

function prepareAll(db: DatabaseSync): Stmts {
  return {
    metaGet: db.prepare("SELECT v FROM meta WHERE k = ?"),
    metaSet: db.prepare(
      "INSERT INTO meta(k, v) VALUES(?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ),
    noteMetaAll: db.prepare("SELECT path, folder, mtime, size FROM notes"),
    noteGet: db.prepare(
      "SELECT skip, tags, heads, data FROM notes WHERE path = ?",
    ),
    noteUpsert: db.prepare(
      "INSERT INTO notes(path, folder, mtime, size, skip, tags, heads, data) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET folder = excluded.folder, " +
        "mtime = excluded.mtime, size = excluded.size, " +
        "skip = excluded.skip, tags = excluded.tags, " +
        "heads = excluded.heads, data = excluded.data",
    ),
    // Folder-guarded: a row re-attributed to another folder by this run's
    // upserts is immune to the stale-note cleanup of its previous folder.
    noteDelete: db.prepare("DELETE FROM notes WHERE path = ? AND folder = ?"),
    noteDeleteFolder: db.prepare("DELETE FROM notes WHERE folder = ?"),
    folderUpsert: db.prepare(
      "INSERT INTO folders(path, notes, tags, warn, tfids, cand, full) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET notes = excluded.notes, " +
        "tags = excluded.tags, warn = excluded.warn, " +
        "tfids = excluded.tfids, cand = excluded.cand, " +
        "full = excluded.full",
    ),
    folderDelete: db.prepare("DELETE FROM folders WHERE path = ?"),
    folderPaths: db.prepare("SELECT path FROM folders"),
    folderInfo: db.prepare(
      "SELECT path, full IS NOT NULL AS hasFull FROM folders",
    ),
    folderRows: db.prepare(
      "SELECT path, notes, tags, warn, tfids, cand FROM folders",
    ),
    folderFull: db.prepare("SELECT full FROM folders WHERE path = ?"),
    // Bulk dictionary lookups: a JSON array of terms/ids crosses the
    // JS↔SQLite boundary once per ~5000 entries instead of once per term.
    termIdsBatch: db.prepare(
      "SELECT id, term FROM terms " +
        "WHERE term IN (SELECT value FROM json_each(?))",
    ),
    termTextsBatch: db.prepare(
      "SELECT id, term FROM terms " +
        "WHERE id IN (SELECT value FROM json_each(?))",
    ),
    termInsert: db.prepare("INSERT INTO terms(id, term) VALUES(?, ?)"),
  };
}

/** Rows/terms per json_each bulk call. */
const CHUNK = 5000;

/** Freshness metadata of one stored note (no term data). */
export interface StoredNoteMeta {
  path: string;
  folder: string;
  mtime: number;
  size: number;
}

/** One stored note's full record, as aggregateFolder consumes it. */
export interface StoredNoteRecord {
  skip: number;
  /** JSON string[]: the note's tags. */
  tags: string;
  /** JSON [[headingText, termId[]], …] per unique heading text. */
  heads: string;
  /** Int32 blob [nNh,(id,count)×, nBody,(id,count)×] or null when skipped. */
  data: Uint8Array | null;
}

/** One stored folder row (term data as blobs). */
export interface StoredFolderRow {
  path: string;
  notes: number;
  /** JSON string[]: the folder's tags, build order. */
  tags: string;
  /** JSON string[]: warnings emitted while building the folder. */
  warn: string;
  /** Int32Array blob: tf term ids in tf order. */
  tfids: Uint8Array;
  /** Int32Array blob: (term id, tf) candidate pairs in tf order. */
  cand: Uint8Array;
}

/** Why the last tryOpen failed, so a reopen failure can say corrupt vs busy. */
let lastOpenError = "";

/** Test/diagnostic seam: the error string of the most recent failed open. */
export function lastOverviewOpenError(): string {
  return lastOpenError;
}

/** Write .napkin/cache/.gitignore once so the DB is never committed. */
function writeCacheGitignore(dir: string): void {
  const gitignore = path.join(dir, ".gitignore");
  try {
    if (fs.readFileSync(gitignore, "utf-8") === "*\n") return;
  } catch {
    // Missing or unreadable — (re)write below.
  }
  fs.writeFileSync(gitignore, "*\n");
}

function tryOpen(
  sqlite: SqliteModule,
  dbPath: string,
  journalMode: "WAL" | "DELETE",
): DatabaseSync | null {
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { timeout: busyTimeoutMs });
    db.exec("PRAGMA journal_mode = " + journalMode);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = " + busyTimeoutMs);
    // Small page cache: the connection is closed when the overview finishes,
    // so nothing stays resident between calls.
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
        "overview schema version " + version + ", expected " + SCHEMA_VERSION,
      );
    }
    db.exec(SCHEMA_DDL);
    db.exec("PRAGMA user_version = " + SCHEMA_VERSION);
    // Probe the tables a schema-skewed file might be missing columns on.
    db.prepare("SELECT id, term FROM terms LIMIT 0").get();
    db.prepare(
      "SELECT path, folder, mtime, size, skip, tags, heads, data FROM notes LIMIT 0",
    ).get();
    db.prepare(
      "SELECT path, notes, tags, warn, tfids, cand, full FROM folders LIMIT 0",
    ).get();
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

/** term → flags byte: bit 0 = contains a space, bit 1 = "x x" self-pair. */
function termFlags(term: string): number {
  const sp = term.indexOf(" ");
  if (sp < 0) return 0;
  return term.slice(0, sp) === term.slice(sp + 1) ? 3 : 1;
}

export class SqliteOverviewStore {
  private closed = false;
  private flagsValue: Uint8Array | null = null;
  private maxId = -1;
  /** Cold-build interning: an in-memory dict while the whole vault is
   *  rewritten, so 1.4M first-seen terms skip per-term SQL probes. */
  private coldDict: Map<string, number> | null = null;
  private coldIds: Map<number, string> | null = null;
  private coldTerms: string[] = [];

  private constructor(
    private readonly dbPath: string,
    private db: DatabaseSync,
    private stmts: Stmts,
  ) {}

  /**
   * Reopen the database if it was closed after release(). Reopen cost is a
   * few ms (pragmas + idempotent DDL + prepare), paid once per operation.
   */
  private ensureOpen(): void {
    if (!this.closed) return;
    const sqlite = loadSqlite();
    if (sqlite === null) throw new Error("node:sqlite unavailable");
    const db = openDb(sqlite, this.dbPath);
    if (db !== null) {
      this.db = db;
      this.stmts = prepareAll(db);
      this.closed = false;
      return;
    }
    throw new Error(
      "cannot reopen overview db " + this.dbPath + ": " + lastOpenError,
    );
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
   * Open the vault's SQLite overview store, creating it when missing.
   *
   * Recovery ladder mirrors SqliteStore: open with WAL (then DELETE
   * journaling); on failure rename the file aside and repeat; on failure
   * again return null so the caller falls back to the JSON folder cache.
   * An existing overview-folders-cache.json is NOT imported — a cold build
   * is one pass over the vault, well inside the miss budget, and importing
   * would materialise exactly the in-memory structures this store exists to
   * avoid. The JSON file is left in place for the fallback path.
   */
  static open(configPath: string): SqliteOverviewStore | null {
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

    const db = openDb(sqlite, dbPath);
    if (db === null) return null;
    return new SqliteOverviewStore(dbPath, db, prepareAll(db));
  }

  // ── Metadata ──────────────────────────────────────────────────────

  /**
   * The validation keys the stored data was built under: the folder-data
   * format version, the ignore fingerprint, and the templates folder. A
   * mismatch means the whole store is a miss — like the JSON cache, it is
   * discarded wholesale rather than partially trusted.
   */
  metaState(): {
    format?: number;
    ignoreFp?: string;
    templatesFolder?: string;
  } {
    this.ensureOpen();
    const read = (k: string): unknown =>
      (this.stmts.metaGet.get(k) as { v: unknown } | undefined)?.v;
    const format = read("format");
    const ignoreFp = read("ignore_fp");
    const templatesFolder = read("templates_folder");
    return {
      format: typeof format === "number" ? format : undefined,
      ignoreFp: typeof ignoreFp === "string" ? ignoreFp : undefined,
      templatesFolder:
        typeof templatesFolder === "string" ? templatesFolder : undefined,
    };
  }

  // ── Term dictionary ───────────────────────────────────────────────
  //
  // ids are stable within this DB only. flags[] is a dense per-id byte array
  // persisted in meta ('flags') and rebuilt on open; maxTermId is the SQL
  // MAX(id), so sparse deletes never matter.

  /** Largest term id in use (0 when the dictionary is empty). */
  maxTermId(): number {
    this.ensureOpen();
    if (this.maxId < 0) {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM terms")
        .get() as { m: number };
      this.maxId = row.m;
    }
    return this.maxId;
  }

  /** The dense per-id flag array (bit 0 = bigram, bit 1 = self-pair). */
  flags(): Uint8Array {
    this.ensureOpen();
    if (this.flagsValue === null) {
      const row = this.stmts.metaGet.get("flags") as { v: unknown } | undefined;
      this.flagsValue =
        row?.v instanceof Uint8Array
          ? new Uint8Array(row.v)
          : new Uint8Array(Math.max(1 << 16, this.maxTermId() + 1));
    }
    return this.flagsValue;
  }

  private setFlag(id: number, flag: number): void {
    let flags = this.flags();
    if (id >= flags.length) {
      const next = new Uint8Array(Math.max(id + 1, flags.length * 2));
      next.set(flags);
      this.flagsValue = next;
      flags = next;
    }
    flags[id] = flag;
  }

  /**
   * Cold-build interning mode: the caller enables it when the whole store is
   * being rewritten, so interning uses an in-memory dict and terms are
   * flushed in one sorted batch (sorted inserts keep the UNIQUE index
   * append-only — ~4× faster than first-seen-order inserts).
   */
  setColdInterning(on: boolean): void {
    this.coldDict = on ? new Map() : null;
    this.coldIds = on ? new Map() : null;
    this.coldTerms = [];
  }

  /**
   * Intern every term in the iterable, returning term → id. New terms are
   * sorted before inserting (the UNIQUE index is append-friendly that way);
   * in cold mode they only collect in memory until flushColdTerms().
   */
  intern(terms: Iterable<string>): Map<string, number> {
    this.ensureOpen();
    const ids = new Map<string, number>();
    if (this.coldDict !== null) {
      for (const term of terms) {
        let id = this.coldDict.get(term);
        if (id === undefined) {
          id = ++this.maxId;
          this.coldDict.set(term, id);
          this.coldIds?.set(id, term);
          this.coldTerms.push(term);
          this.setFlag(id, termFlags(term));
        }
        ids.set(term, id);
      }
      return ids;
    }
    const list = [...terms];
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = this.stmts.termIdsBatch.all(
        JSON.stringify(list.slice(i, i + CHUNK)),
      ) as unknown as { id: number; term: string }[];
      for (const row of rows) ids.set(row.term, row.id);
    }
    const missing = list.filter((t) => !ids.has(t)).sort();
    for (const term of missing) {
      const id = ++this.maxId;
      this.stmts.termInsert.run(id, term);
      ids.set(term, id);
      this.setFlag(id, termFlags(term));
    }
    return ids;
  }

  /**
   * Persist the cold-mode dictionary: json_each insert-selects in id order
   * (ids were assigned in first-seen order at intern() time, so this is an
   * append-only write on the rowid b-tree), then the UNIQUE term index is
   * built once — a live index would take 1.4M random-order inserts instead.
   */
  flushColdTerms(): void {
    if (this.coldDict === null || this.coldTerms.length === 0) return;
    this.ensureOpen();
    const coldDict = this.coldDict;
    // Id-ordered insert: append-only on the rowid b-tree, ~0.5 s for 1.4M
    // rows. The UNIQUE term index is built after the bulk load — creating
    // it first would take random-order inserts and dominate the flush.
    const ins = this.db.prepare(
      "INSERT INTO terms(id, term) " +
        "SELECT e.value ->> 0, e.value ->> 1 FROM json_each(?) e",
    );
    const rows: (number | string)[][] = [];
    for (const term of this.coldTerms) {
      rows.push([coldDict.get(term) as number, term]);
      if (rows.length >= CHUNK) {
        ins.run(JSON.stringify(rows));
        rows.length = 0;
      }
    }
    if (rows.length > 0) ins.run(JSON.stringify(rows));
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS terms_term ON terms(term)");
  }

  /** Persist the flags blob (call inside the write transaction). */
  saveFlags(): void {
    if (this.flagsValue === null) return;
    this.stmts.metaSet.run(
      "flags",
      this.flagsValue.subarray(0, this.maxTermId() + 1),
    );
  }

  /**
   * Resolve term text for a set of term ids (selected keywords and bigram
   * parts — at most a handful per scored folder).
   */
  termTexts(ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    this.ensureOpen();
    const missing: number[] = [];
    for (const id of ids) {
      if (!out.has(id)) missing.push(id);
    }
    for (let i = 0; i < missing.length; i += CHUNK) {
      const rows = this.stmts.termTextsBatch.all(
        JSON.stringify(missing.slice(i, i + CHUNK)),
      ) as unknown as { id: number; term: string }[];
      for (const row of rows) out.set(row.id, row.term);
    }
    // Cold mode keeps unflushed terms in memory only.
    if (this.coldIds !== null) {
      for (const want of missing) {
        const term = this.coldIds.get(want);
        if (term !== undefined) out.set(want, term);
      }
    }
    return out;
  }

  /**
   * Resolve term ids for term text (folder-token exclusion, bigram parts —
   * a term absent from the dictionary simply maps to nothing).
   */
  idsForTerms(terms: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (terms.length === 0) return out;
    this.ensureOpen();
    if (this.coldDict !== null) {
      for (const term of terms) {
        const id = this.coldDict.get(term);
        if (id !== undefined) out.set(term, id);
      }
      return out;
    }
    for (let i = 0; i < terms.length; i += CHUNK) {
      const rows = this.stmts.termIdsBatch.all(
        JSON.stringify(terms.slice(i, i + CHUNK)),
      ) as unknown as { id: number; term: string }[];
      for (const row of rows) out.set(row.term, row.id);
    }
    return out;
  }

  // ── Write path ────────────────────────────────────────────────────
  //
  // One write transaction covers everything a miss rebuilds: note upserts,
  // note/folder deletions, folder rewrites, and the meta update. Every
  // folder's row commits atomically — a crash can never leave a folder row
  // that claims data which is missing.

  beginWrite(): void {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE");
  }

  endWrite(commit: boolean): void {
    if (this.db.isTransaction) this.db.exec(commit ? "COMMIT" : "ROLLBACK");
  }

  /** Drop every row and record the validation keys (whole-store miss). */
  resetData(format: number, ignoreFp: string, templatesFolder: string): void {
    for (const table of ["folders", "notes", "terms"]) {
      this.db.exec("DELETE FROM " + table);
    }
    this.maxId = 0;
    this.stmts.metaSet.run("format", format);
    this.stmts.metaSet.run("ignore_fp", ignoreFp);
    this.stmts.metaSet.run("templates_folder", templatesFolder);
  }

  /** Record the validation keys after an incremental write. */
  setMeta(ignoreFp: string, templatesFolder: string): void {
    this.stmts.metaSet.run("ignore_fp", ignoreFp);
    this.stmts.metaSet.run("templates_folder", templatesFolder);
  }

  /** Freshness metadata of every stored note. */
  noteMeta(): StoredNoteMeta[] {
    this.ensureOpen();
    return this.stmts.noteMetaAll.all() as unknown as StoredNoteMeta[];
  }

  /** One note's stored record (undefined when absent). */
  getNote(path: string): StoredNoteRecord | undefined {
    this.ensureOpen();
    return this.stmts.noteGet.get(path) as StoredNoteRecord | undefined;
  }

  /** Insert or replace one note's record (write txn open). */
  upsertNote(
    path: string,
    folder: string,
    mtime: number,
    size: number,
    skip: number,
    tagsJson: string,
    headsJson: string,
    data: Uint8Array | null,
  ): void {
    this.stmts.noteUpsert.run(
      path,
      folder,
      mtime,
      size,
      skip,
      tagsJson,
      headsJson,
      data,
    );
  }

  /** Delete one note row attributed to a folder (write txn open). */
  deleteNote(path: string, folder: string): void {
    this.stmts.noteDelete.run(path, folder);
  }

  /** Insert or replace one folder's aggregate row (write txn open). */
  upsertFolder(
    path: string,
    notes: number,
    tagsJson: string,
    warnJson: string,
    tfids: Uint8Array,
    cand: Uint8Array,
    full: Uint8Array | null,
  ): void {
    this.stmts.folderUpsert.run(
      path,
      notes,
      tagsJson,
      warnJson,
      tfids,
      cand,
      full,
    );
  }

  /** Delete one folder and every note attributed to it (write txn open). */
  deleteFolder(folder: string): void {
    this.stmts.folderDelete.run(folder);
    this.stmts.noteDeleteFolder.run(folder);
  }

  /** Every stored folder path. */
  storedFolderPaths(): string[] {
    this.ensureOpen();
    return (this.stmts.folderPaths.all() as unknown as { path: string }[]).map(
      (r) => r.path,
    );
  }

  /** Every stored folder's path and whether it carries a full blob. */
  storedFolderInfo(): { path: string; hasFull: boolean }[] {
    this.ensureOpen();
    return (
      this.stmts.folderInfo.all() as unknown as {
        path: string;
        hasFull: number;
      }[]
    ).map((r) => ({ path: r.path, hasFull: r.hasFull === 1 }));
  }

  // ── Read path ─────────────────────────────────────────────────────
  //
  // folderRows loads every folder's tfids/cand blobs at once (a few MB on a
  // large vault — the df pass needs tfids anyway); the much rarer collapse
  // path loads one group's full blobs at a time.

  /** Run the read phase inside one read transaction (consistent snapshot). */
  readSnapshot<T>(fn: () => T): T {
    this.ensureOpen();
    this.db.exec("BEGIN DEFERRED");
    try {
      return fn();
    } finally {
      if (!this.closed && this.db.isTransaction) this.db.exec("COMMIT");
    }
  }

  /** Every stored folder's row, including the tfids/cand blobs. */
  folderRows(): StoredFolderRow[] {
    this.ensureOpen();
    return this.stmts.folderRows.all() as unknown as StoredFolderRow[];
  }

  /** One folder's full-blob (null when the folder never needed one). */
  folderFull(path: string): Uint8Array | null {
    this.ensureOpen();
    const row = this.stmts.folderFull.get(path) as
      | { full: Uint8Array | null }
      | undefined;
    return row?.full ?? null;
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

  /** Close the underlying database handle (tests; stores are cached). */
  close(): void {
    this.closeDb();
  }

  /** Test-only snapshot of the store's bookkeeping. */
  inspectForTests(): {
    folders: number;
    notes: number;
    terms: number;
  } {
    this.ensureOpen();
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      folders: scalar("SELECT COUNT(*) AS n FROM folders"),
      notes: scalar("SELECT COUNT(*) AS n FROM notes"),
      terms: scalar("SELECT COUNT(*) AS n FROM terms"),
    };
  }

  /** Test-only: the stored metadata of one folder. */
  folderForTests(folder: string):
    | {
        notes: number;
        tags: string[];
        warn: string[];
        hasFull: boolean;
        tfids: number;
        cand: number;
      }
    | undefined {
    this.ensureOpen();
    const row = this.db
      .prepare(
        "SELECT notes, tags, warn, tfids, cand, full FROM folders WHERE path = ?",
      )
      .get(folder) as
      | {
          notes: number;
          tags: string;
          warn: string;
          tfids: Uint8Array | null;
          cand: Uint8Array | null;
          full: Uint8Array | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      notes: row.notes,
      tags: JSON.parse(row.tags) as string[],
      warn: JSON.parse(row.warn) as string[],
      hasFull: row.full !== null,
      tfids: row.tfids === null ? 0 : row.tfids.byteLength >> 2,
      cand: row.cand === null ? 0 : row.cand.byteLength >> 2,
    };
  }

  /** Test-only: one note's stored record, or undefined. */
  noteForTests(path: string): StoredNoteRecord | undefined {
    return this.getNote(path);
  }

  /** Test-only: one folder's candidate pairs resolved to term text. */
  folderCandForTests(folder: string): [string, number][] {
    this.ensureOpen();
    const row = this.db
      .prepare("SELECT cand FROM folders WHERE path = ?")
      .get(folder) as { cand: Uint8Array | null } | undefined;
    if (row?.cand == null) return [];
    const a =
      row.cand.byteOffset % 4 === 0
        ? new Int32Array(
            row.cand.buffer,
            row.cand.byteOffset,
            row.cand.byteLength >> 2,
          )
        : new Int32Array(row.cand.slice().buffer);
    const ids: number[] = [];
    for (let i = 0; i < a.length; i += 2) ids.push(a[i]);
    const texts = this.termTexts(ids);
    const out: [string, number][] = [];
    for (let i = 0; i < a.length; i += 2) {
      out.push([texts.get(a[i]) ?? "?", a[i + 1]]);
    }
    return out;
  }

  /** Test-only: term text → id for a vocabulary check. */
  termIdForTests(term: string): number | undefined {
    return this.idsForTerms([term]).get(term);
  }

  /** Test-only: the id↔flag of a stored term. */
  flagForTests(term: string): number | undefined {
    const id = this.termIdForTests(term);
    if (id === undefined) return undefined;
    return this.flags()[id];
  }
}

// ─── Store selection ─────────────────────────────────────────────────
//
// The one place the implementation is chosen — automatically. SQLite is THE
// store; the JSON folder cache engages only when the database genuinely
// cannot be used (an older Node without node:sqlite, a read-only or network
// filesystem). Same rule as the search store — there is no user-facing
// choice.

const stores = new Map<string, SqliteOverviewStore>();
const failures = new Map<string, number>();
const PIN_AFTER = 3;

/** Messages that mean the database FILE is unusable, not just busy. */
const CORRUPTION =
  /malformed|not a database|corrupt|disk image|file is encrypted/i;

/**
 * The vault's SQLite overview store, or null when SQLite cannot be used —
 * the caller then takes the JSON folder-cache path. Stores are cached per
 * configPath (a Napkin instance is constructed per call).
 */
export function createOverviewStore(
  configPath: string,
): SqliteOverviewStore | null {
  if (
    forcedJsonConfigs.has(configPath) ||
    failures.get(configPath) === PIN_AFTER
  ) {
    return null;
  }
  const cached = stores.get(configPath);
  if (cached) return cached;
  const store = SqliteOverviewStore.open(configPath);
  if (store !== null) stores.set(configPath, store);
  return store;
}

/**
 * A call against the store threw (locked, corrupt, I/O). The caller falls
 * back to the JSON path for this run; here the store is cleaned up for the
 * next one. After PIN_AFTER failures this process stops trying SQLite.
 */
export function reportOverviewStoreFailure(
  configPath: string,
  store: SqliteOverviewStore,
  error: unknown,
): void {
  failures.set(configPath, (failures.get(configPath) ?? 0) + 1);
  const message = error instanceof Error ? error.message : String(error);
  try {
    if (CORRUPTION.test(message)) {
      store.discard();
      stores.delete(configPath);
    } else {
      store.release();
    }
  } catch {
    // Cleanup is best-effort; the run already fell back to the JSON path.
  }
}

/**
 * Test-only seam: config dirs pinned to the JSON folder cache (see
 * useJsonOverviewStore in test-helpers). Keyed per configPath — every
 * createTempVault gets a unique path, so pins never leak between tests.
 */
const forcedJsonConfigs = new Set<string>();

/** Test-only: pin one vault's config dir to the JSON folder cache. */
export function forceJsonOverviewStoreForTests(configPath: string): void {
  forcedJsonConfigs.add(configPath);
}

/**
 * Test-only hook: drop the cached store objects, so a test observes a fresh
 * selection (and a fresh SQLite connection) the way a new process would.
 */
export function resetOverviewStoresForTests(): void {
  for (const store of stores.values()) {
    try {
      store.close();
    } catch {
      // Best-effort cleanup.
    }
  }
  stores.clear();
  failures.clear();
}

/**
 * The open ladder: WAL journaling, then DELETE (for filesystems where
 * shared-memory WAL cannot mmap); on failure park the file aside (with its
 * -wal/-shm sidecars — an orphaned WAL replays into the fresh database and
 * resurrects the very rows we parked) and repeat once. Returns null when a
 * freshly created database still cannot be opened.
 */
function openDb(sqlite: SqliteModule, dbPath: string): DatabaseSync | null {
  for (const mode of ["WAL", "DELETE"] as const) {
    const db = tryOpen(sqlite, dbPath, mode);
    if (db !== null) return db;
  }
  parkAside(dbPath);
  for (const mode of ["WAL", "DELETE"] as const) {
    const db = tryOpen(sqlite, dbPath, mode);
    if (db !== null) return db;
  }
  return null;
}

/** Rename the DB and its WAL/SHM sidecars together (see openDb). */
function parkAside(dbPath: string): void {
  const stamp = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.renameSync(dbPath + suffix, dbPath + suffix + ".corrupt-" + stamp);
    } catch {
      // A missing sidecar is fine.
    }
  }
}

/** The store file tests drop to force a cold build. */
export function overviewStoreDbFileForTests(): string {
  return DB_FILE;
}
