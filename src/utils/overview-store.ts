import * as fs from "node:fs";
import * as path from "node:path";
import { loadSqlite } from "./sqlite-store.js";

/**
 * The SQLite per-folder overview store (#112).
 *
 * `.napkin/cache/overview-v1.db` — a separate, versioned file name next to
 * the search store's `index-v2.db`. It is deliberately NOT another set of
 * tables in the index database: the two stores have different lifecycles
 * (the search store can pin/fallback independently), and a schema bump here
 * must not force a search-index rebuild. The store holds what
 * `overview-folders-cache.json` held — per-folder term data — but queryable
 * per folder instead of parsed whole: an overview miss streams what it needs
 * instead of materialising a 70 MB JSON document and a 1.4M-term dictionary.
 *
 * Schema (v1, `PRAGMA user_version = 1`):
 *
 *   meta(k, v)                              'format' (OVERVIEW_CACHE_VERSION),
 *                                           'ignore_fp', 'templates_folder'
 *   folders(id, path, depth, sig,
 *           notes, tags, warn)              one row per folder; sig is the
 *                                           direct-files fingerprint; tags and
 *                                           warn are JSON arrays; notes is the
 *                                           note count buildFolderData computed
 *   terms(id, term, df)                     the term dictionary (bigrams
 *                                           included); df = number of STORED
 *                                           folders whose folder_tf contains
 *                                           the term, maintained by the write
 *                                           paths — the run-time document
 *                                           frequency adds a small correction
 *   folder_tf(folder_id, pos,
 *             term_id, tf)                  weighted term counts per folder;
 *                                           pos is the pair's index in
 *                                           first-occurrence order — insertion
 *                                           order is behavior (keyword ties
 *                                           break on it)
 *   folder_body(folder_id, pos,
 *               term_id, tf)                unweighted body counts, for the
 *                                           sibling-collapse cosine
 *   folder_bodytop(folder_id, rank,
 *                  term_id, tf)             the folder's top-60 body terms —
 *                                           the only thing tfCosine reads;
 *                                           recomputed on each folder write so
 *                                           a collapse check loads ~60 rows per
 *                                           child instead of the whole body map
 *   folder_head(folder_id, pos,
 *               term_id, n, only)           heading line counts; only=1 marks
 *                                           the headingOnly terms (a strict
 *                                           subset of the head keys, since
 *                                           every heading term is also in tf)
 *   folder_cand(folder_id, pos,
 *               term_id, tf, bigram)        the folder's keyword CANDIDATES —
 *                                           every isCandidateKeyword input is
 *                                           folder-local (bigram counts, the
 *                                           folder's own tokens, heading
 *                                           corroboration), so the filter runs
 *                                           at write time; scoring then only
 *                                           needs (id, tf, df, is-bigram) —
 *                                           term text is resolved for the ~8
 *                                           selected keywords, not the rows
 *
 * Everything is keyed by integer term id — there is no in-memory whole-vault
 * dictionary or term→index map: building a folder interns each of its terms
 * with one indexed SELECT (one INSERT for a genuinely new term), and the
 * read side resolves term text through a JOIN in the row stream.
 *
 * The DB is disposable: open failure, corruption, or a schema-version
 * mismatch renames the file aside and recreates it; a second failure makes
 * `open()` return null so `createOverviewStore` falls back to the JSON
 * folder cache (the pre-#112 persistence, kept verbatim for that case).
 */

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

const CACHE_DIR = "cache";
const DB_FILE = "overview-v1.db";
const SCHEMA_VERSION = 1;

let busyTimeoutMs = 5000;
/** Test seam: SQLite busy timeout in ms (default 5000). */
export function setOverviewBusyTimeoutForTests(ms: number): void {
  busyTimeoutMs = ms;
}

const SCHEMA_DDL =
  [
    "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v)",
    "CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, depth INTEGER NOT NULL, sig TEXT NOT NULL, notes INTEGER NOT NULL, tags TEXT NOT NULL, warn TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS terms(id INTEGER PRIMARY KEY, term TEXT UNIQUE NOT NULL, df INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS folder_tf(folder_id INTEGER NOT NULL, pos INTEGER NOT NULL, term_id INTEGER NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(folder_id, pos)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS folder_tf_term ON folder_tf(term_id)",
    "CREATE TABLE IF NOT EXISTS folder_body(folder_id INTEGER NOT NULL, pos INTEGER NOT NULL, term_id INTEGER NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(folder_id, pos)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS folder_bodytop(folder_id INTEGER NOT NULL, rank INTEGER NOT NULL, term_id INTEGER NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(folder_id, rank)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS folder_head(folder_id INTEGER NOT NULL, pos INTEGER NOT NULL, term_id INTEGER NOT NULL, n INTEGER NOT NULL, only INTEGER NOT NULL, PRIMARY KEY(folder_id, pos)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS folder_cand(folder_id, pos, term_id, tf INTEGER NOT NULL, bigram INTEGER NOT NULL, PRIMARY KEY(folder_id, pos)) WITHOUT ROWID",
  ].join(";\n") + ";";

interface Stmts {
  metaGet: StatementSync;
  metaSet: StatementSync;
  allFolders: StatementSync;
  folderByPath: StatementSync;
  folderUpsert: StatementSync;
  folderDelete: StatementSync;
  termNewBatch: StatementSync;
  termIdsBatch: StatementSync;
  tfInsertBatch: StatementSync;
  bodyInsertBatch: StatementSync;
  bodyTopInsertBatch: StatementSync;
  headInsertBatch: StatementSync;
  candInsertBatch: StatementSync;
  dfDecrement: StatementSync;
  dfIncrement: StatementSync;
  orphanSweep: StatementSync;
  tfDelete: StatementSync;
  bodyDelete: StatementSync;
  bodyTopDelete: StatementSync;
  headDelete: StatementSync;
  candDelete: StatementSync;
}

function prepareAll(db: DatabaseSync): Stmts {
  return {
    metaGet: db.prepare("SELECT v FROM meta WHERE k = ?"),
    metaSet: db.prepare(
      "INSERT INTO meta(k, v) VALUES(?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ),
    allFolders: db.prepare(
      "SELECT id, path, depth, sig, notes, tags, warn FROM folders",
    ),
    folderByPath: db.prepare(
      "SELECT id, sig, notes, tags, warn FROM folders WHERE path = ?",
    ),
    folderUpsert: db.prepare(
      "INSERT INTO folders(path, depth, sig, notes, tags, warn) " +
        "VALUES(?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET depth = excluded.depth, " +
        "sig = excluded.sig, notes = excluded.notes, tags = excluded.tags, " +
        "warn = excluded.warn RETURNING id",
    ),
    folderDelete: db.prepare("DELETE FROM folders WHERE id = ?"),
    // Bulk variants: a JSON array of terms/rows crosses the JS↔SQLite
    // boundary once per ~5000 entries instead of once per entry — a 991-note
    // folder inserts ~1M rows, where per-row .run() calls were the whole
    // write cost.
    termNewBatch: db.prepare(
      "INSERT INTO terms(term, df) SELECT value, 0 FROM json_each(?) " +
        "RETURNING id, term",
    ),
    termIdsBatch: db.prepare(
      "SELECT id, term FROM terms " +
        "WHERE term IN (SELECT value FROM json_each(?))",
    ),
    tfInsertBatch: db.prepare(
      "INSERT INTO folder_tf(folder_id, pos, term_id, tf) " +
        "SELECT ?, json_extract(e.value,'$[0]'), " +
        "json_extract(e.value,'$[1]'), json_extract(e.value,'$[2]') " +
        "FROM json_each(?) e",
    ),
    bodyInsertBatch: db.prepare(
      "INSERT INTO folder_body(folder_id, pos, term_id, tf) " +
        "SELECT ?, json_extract(e.value,'$[0]'), " +
        "json_extract(e.value,'$[1]'), json_extract(e.value,'$[2]') " +
        "FROM json_each(?) e",
    ),
    bodyTopInsertBatch: db.prepare(
      "INSERT INTO folder_bodytop(folder_id, rank, term_id, tf) " +
        "SELECT ?, json_extract(e.value,'$[0]'), " +
        "json_extract(e.value,'$[1]'), json_extract(e.value,'$[2]') " +
        "FROM json_each(?) e",
    ),
    headInsertBatch: db.prepare(
      "INSERT INTO folder_head(folder_id, pos, term_id, n, only) " +
        "SELECT ?, json_extract(e.value,'$[0]'), " +
        "json_extract(e.value,'$[1]'), json_extract(e.value,'$[2]'), " +
        "json_extract(e.value,'$[3]') FROM json_each(?) e",
    ),
    candInsertBatch: db.prepare(
      "INSERT INTO folder_cand(folder_id, pos, term_id, tf, bigram) " +
        "SELECT ?, json_extract(e.value,'$[0]'), " +
        "json_extract(e.value,'$[1]'), json_extract(e.value,'$[2]'), " +
        "json_extract(e.value,'$[3]') FROM json_each(?) e",
    ),
    // df = number of stored folders containing the term. A folder
    // rewrite applies the old-vs-new id diff (EXCEPT) while the old rows
    // are still present: increment runs first so both sides see the OLD
    // row set — an EXCEPT evaluated after the insert would find the new
    // rows already there and add nothing. Params: (folder_id or json) as
    // noted per statement.
    dfDecrement: db.prepare(
      "UPDATE terms SET df = df - 1 WHERE id IN " +
        "(SELECT term_id FROM folder_tf WHERE folder_id = ? " +
        "EXCEPT SELECT value FROM json_each(?))",
    ),
    dfIncrement: db.prepare(
      "UPDATE terms SET df = df + 1 WHERE id IN " +
        "(SELECT value FROM json_each(?) " +
        "EXCEPT SELECT term_id FROM folder_tf WHERE folder_id = ?)",
    ),
    // Orphaned dictionary rows among the REMOVED ids only: df 0 means no
    // folder's tf references the term. Every head term is also a tf term
    // (heading terms are folded into tf), so tf is the only table the sweep
    // must consult.
    orphanSweep: db.prepare(
      "DELETE FROM terms WHERE df <= 0 AND id IN " +
        "(SELECT term_id FROM folder_tf WHERE folder_id = ? " +
        "EXCEPT SELECT value FROM json_each(?))",
    ),
    tfDelete: db.prepare("DELETE FROM folder_tf WHERE folder_id = ?"),
    bodyDelete: db.prepare("DELETE FROM folder_body WHERE folder_id = ?"),
    bodyTopDelete: db.prepare("DELETE FROM folder_bodytop WHERE folder_id = ?"),
    headDelete: db.prepare("DELETE FROM folder_head WHERE folder_id = ?"),
    candDelete: db.prepare("DELETE FROM folder_cand WHERE folder_id = ?"),
  };
}

/** Rows/terms per json_each bulk call. */
const CHUNK = 5000;

/** One folder's stored metadata row (no term data). */
export interface StoredFolderRow {
  id: number;
  path: string;
  depth: number;
  sig: string;
  notes: number;
  /** JSON-encoded string[]: the folder's tags, build order. */
  tags: string;
  /** JSON-encoded string[]: warnings emitted while building the folder. */
  warn: string;
}

/** Per-folder term maps as built from note text, before interning. */
export interface RawFolderTerms {
  tf: Map<string, number>;
  bodyTF: Map<string, number>;
  headingLineCount: Map<string, number>;
  headingOnly: Set<string>;
  tags: Set<string>;
  noteCount: number;
  /**
   * Top-N body terms (term, tf) — exactly the list topTermPairs produces
   * from bodyTF, precomputed at write time so sibling-collapse cosine
   * checks load ~60 rows instead of the folder's whole body map.
   */
  bodyTop: [string, number][];
  /**
   * The folder's keyword candidates — the terms that pass the folder-local
   * isCandidateKeyword checks. Membership only: the write loop stores the
   * (term id, tf) pair when the tf map visits a candidate, so first-occurrence
   * order is the tf order itself.
   */
  candidates: Set<string>;
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
    db.prepare(
      "SELECT id, path, depth, sig, notes, tags, warn FROM folders LIMIT 0",
    ).get();
    db.prepare("SELECT id, term, df FROM terms LIMIT 0").get();
    db.prepare(
      "SELECT folder_id, pos, term_id, tf FROM folder_tf LIMIT 0",
    ).get();
    db.prepare(
      "SELECT folder_id, rank, term_id, tf FROM folder_bodytop LIMIT 0",
    ).get();
    db.prepare(
      "SELECT folder_id, pos, term_id, n, only FROM folder_head LIMIT 0",
    ).get();
    db.prepare(
      "SELECT folder_id, pos, term_id, tf, bigram FROM folder_cand LIMIT 0",
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

export class SqliteOverviewStore {
  private closed = false;

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
   * would materialise exactly the in-memory dictionary this store exists to
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

  /** Every stored folder's metadata — a few hundred rows on a large vault. */
  folderMeta(): StoredFolderRow[] {
    this.ensureOpen();
    return this.stmts.allFolders.all() as unknown as StoredFolderRow[];
  }

  // ── Write path ────────────────────────────────────────────────────
  //
  // One write transaction covers everything a miss rebuilds: folder rewrites,
  // deletions, and the meta update. Every folder's rows commit atomically —
  // a crash can never leave a signature that claims data which is missing.

  beginWrite(): void {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE");
  }

  endWrite(commit: boolean): void {
    if (this.db.isTransaction) this.db.exec(commit ? "COMMIT" : "ROLLBACK");
  }

  /** Drop every row and record the validation keys (whole-store miss). */
  resetData(format: number, ignoreFp: string, templatesFolder: string): void {
    for (const table of [
      "folder_cand",
      "folder_head",
      "folder_bodytop",
      "folder_body",
      "folder_tf",
      "folders",
      "terms",
    ]) {
      this.db.exec("DELETE FROM " + table);
    }
    this.stmts.metaSet.run("format", format);
    this.stmts.metaSet.run("ignore_fp", ignoreFp);
    this.stmts.metaSet.run("templates_folder", templatesFolder);
  }

  /** Record the validation keys after an incremental write. */
  setMeta(ignoreFp: string, templatesFolder: string): void {
    this.stmts.metaSet.run("ignore_fp", ignoreFp);
    this.stmts.metaSet.run("templates_folder", templatesFolder);
  }

  /**
   * Intern a folder's whole vocabulary in ~5000-term JSON chunks — one
   * INSERT OR IGNORE + one id-resolving SELECT per chunk, no in-memory
   * whole-vault dictionary (the returned map is folder-scoped).
   */
  private internAll(terms: Set<string>): Map<string, number> {
    const list = [...terms];
    const ids = new Map<string, number>();
    const missing: string[] = [];
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = this.stmts.termIdsBatch.all(
        JSON.stringify(list.slice(i, i + CHUNK)),
      ) as unknown as { id: number; term: string }[];
      for (const r of rows) ids.set(r.term, r.id);
      for (const term of list.slice(i, i + CHUNK)) {
        if (!ids.has(term)) missing.push(term);
      }
    }
    // Only genuinely new terms insert — on an incremental miss that is a
    // handful, not the folder's whole vocabulary. RETURNING hands back the
    // fresh ids in the same statement.
    for (let i = 0; i < missing.length; i += CHUNK) {
      const rows = this.stmts.termNewBatch.all(
        JSON.stringify(missing.slice(i, i + CHUNK)),
      ) as unknown as { id: number; term: string }[];
      for (const r of rows) ids.set(r.term, r.id);
    }
    return ids;
  }

  /**
   * A chunked row sink for one bulk insert: rows accumulate up to CHUNK and
   * flush as one json_each insert-select — so a 1M-row folder never holds a
   * 1M-entry JS array, only a ~5000-row buffer.
   */
  private rowSink(
    stmt: StatementSync,
    folderId: number,
  ): { push(row: number[]): void; flush(): void } {
    let buf: number[][] = [];
    return {
      push: (row: number[]) => {
        buf.push(row);
        if (buf.length >= CHUNK) {
          stmt.run(folderId, JSON.stringify(buf));
          buf = [];
        }
      },
      flush: () => {
        if (buf.length > 0) stmt.run(folderId, JSON.stringify(buf));
      },
    };
  }

  /**
   * Replace one folder's stored data (or insert it fresh) inside the open
   * write transaction. raw is consumed and dropped — nothing per-folder
   * accumulates across the write loop.
   */
  writeFolder(
    folder: string,
    depth: number,
    sig: string,
    raw: RawFolderTerms,
    warnings: string[],
    storeBody: boolean,
  ): void {
    const folderRow = this.stmts.folderUpsert.get(
      folder,
      depth,
      sig,
      raw.noteCount,
      JSON.stringify([...raw.tags]),
      JSON.stringify(warnings),
    ) as { id: number };
    const folderId = folderRow.id;

    // Intern the folder's stored vocabulary at once: tf and head terms,
    // body only when this folder is collapse-relevant. head ⊆ tf and
    // candidates ⊆ tf by construction, so the tf map alone usually covers it.
    const vocab = new Set<string>([
      ...raw.tf.keys(),
      ...(storeBody ? raw.bodyTF.keys() : []),
      ...raw.headingLineCount.keys(),
    ]);
    const ids = this.internAll(vocab);

    // The folder's new tf term-id set — needed before the row loops for the
    // df diffs, which must see the OLD rows. An int array, not rows.
    const tfIds: number[] = [];
    for (const term of raw.tf.keys()) tfIds.push(ids.get(term) as number);

    // df moves while the OLD rows are still present: the EXCEPT diffs
    // compare new ids against them. +1 for ids only in the new set, -1 for
    // ids only in the old one, then orphaned terms are swept (df 0 means
    // nothing references them). A term re-interned later may get a fresh
    // id — ids carry no meaning beyond identity, so that is harmless.
    const newIdsJson = JSON.stringify(tfIds);
    this.stmts.dfIncrement.run(newIdsJson, folderId);
    this.stmts.dfDecrement.run(folderId, newIdsJson);
    this.stmts.orphanSweep.run(folderId, newIdsJson);
    this.stmts.candDelete.run(folderId);
    this.stmts.headDelete.run(folderId);
    this.stmts.bodyTopDelete.run(folderId);
    this.stmts.bodyDelete.run(folderId);
    this.stmts.tfDelete.run(folderId);

    // Only now may rows insert (the (folder_id, pos) keys would collide
    // with the old set). The sinks flush every CHUNK rows, so the JS side
    // never holds more than a ~5000-row buffer per table.
    const tfRows = this.rowSink(this.stmts.tfInsertBatch, folderId);
    const candRows = this.rowSink(this.stmts.candInsertBatch, folderId);
    let pos = 0;
    let candPos = 0;
    for (const [term, tf] of raw.tf) {
      const termId = ids.get(term) as number;
      tfRows.push([pos++, termId, tf]);
      // Candidates ride along on the tf pass — same pair, second table.
      if (raw.candidates.has(term)) {
        candRows.push([candPos++, termId, tf, term.includes(" ") ? 1 : 0]);
      }
    }
    const bodyRows = this.rowSink(this.stmts.bodyInsertBatch, folderId);
    if (storeBody) {
      pos = 0;
      for (const [term, tf] of raw.bodyTF) {
        bodyRows.push([pos++, ids.get(term) as number, tf]);
      }
    }
    const topRows = this.rowSink(this.stmts.bodyTopInsertBatch, folderId);
    let rank = 0;
    for (const [term, tf] of raw.bodyTop) {
      topRows.push([rank++, ids.get(term) as number, tf]);
    }
    const headRows = this.rowSink(this.stmts.headInsertBatch, folderId);
    pos = 0;
    for (const [term, n] of raw.headingLineCount) {
      headRows.push([
        pos++,
        ids.get(term) as number,
        n,
        raw.headingOnly.has(term) ? 1 : 0,
      ]);
    }
    tfRows.flush();
    candRows.flush();
    bodyRows.flush();
    topRows.flush();
    headRows.flush();
  }

  /** Delete one folder and every row derived from it (write txn open). */
  deleteFolder(folder: string): void {
    const row = this.stmts.folderByPath.get(folder) as
      | { id: number }
      | undefined;
    if (row === undefined) return;
    const folderId = row.id;
    this.stmts.dfDecrement.run(folderId, "[]");
    this.stmts.orphanSweep.run(folderId, "[]");
    this.stmts.candDelete.run(folderId);
    this.stmts.headDelete.run(folderId);
    this.stmts.bodyTopDelete.run(folderId);
    this.stmts.bodyDelete.run(folderId);
    this.stmts.tfDelete.run(folderId);
    this.stmts.folderDelete.run(folderId);
  }

  // ── Read path ─────────────────────────────────────────────────────
  //
  // Everything below streams or returns per-folder/per-term slices. Nothing
  // proportional to the whole vault lands on the V8 heap: the dictionary
  // stays in SQLite, document frequency rides along on the term join, and
  // the run-time df correction is an Int32Array sized by the dictionary.

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

  /**
   * One folder's weighted term pairs (id-keyed, first-occurrence order),
   * without term text — the form mergeFolderData consumes. Keyword scoring
   * uses streamCand (the persisted candidate subset, joined to term text
   * and the maintained df) instead.
   */
  *streamTfPairs(
    folderId: number,
  ): IterableIterator<{ id: number; tf: number }> {
    this.ensureOpen();
    const stmt = this.db.prepare(
      "SELECT term_id AS id, tf AS tf FROM folder_tf " +
        "WHERE folder_id = ? ORDER BY pos",
    );
    const rows = stmt.iterate(folderId) as IterableIterator<{
      id: number;
      tf: number;
    }>;
    for (const row of rows) yield row;
    holdUntilHere(stmt);
  }

  /** True when the folder has stored body rows (collapse-relevant). */
  hasBody(folderId: number): boolean {
    this.ensureOpen();
    return (
      this.db
        .prepare("SELECT 1 AS x FROM folder_body WHERE folder_id = ? LIMIT 1")
        .get(folderId) !== undefined
    );
  }

  /** One folder's body term pairs (id-keyed, first-occurrence order). */
  *streamBody(folderId: number): IterableIterator<{ id: number; tf: number }> {
    this.ensureOpen();
    const stmt = this.db.prepare(
      "SELECT term_id AS id, tf AS tf FROM folder_body " +
        "WHERE folder_id = ? ORDER BY pos",
    );
    const rows = stmt.iterate(folderId) as IterableIterator<{
      id: number;
      tf: number;
    }>;
    for (const row of rows) yield row;
    holdUntilHere(stmt);
  }

  /**
   * A folder's precomputed top-N body pairs (what tfCosine reads), in rank
   * order — the stable count-desc, first-occurrence tie order topTermPairs
   * produces at write time.
   */
  bodyTop(folderId: number): [number, number][] {
    this.ensureOpen();
    const rows = this.db
      .prepare(
        "SELECT term_id AS id, tf AS tf FROM folder_bodytop " +
          "WHERE folder_id = ? ORDER BY rank",
      )
      .all(folderId) as unknown as { id: number; tf: number }[];
    return rows.map((r) => [r.id, r.tf]);
  }

  /**
   * One folder's keyword candidates in stored (first-occurrence) order —
   * the persisted subset of folder_tf that survives isCandidateKeyword.
   */
  streamCand(
    folderId: number,
  ): { id: number; tf: number; df: number; bigram: number }[] {
    this.ensureOpen();
    // .all() over one folder's candidate rows: the C++ row reader is much
    // cheaper per row than a JS-side iterate() loop, and the rows are pure
    // integers — term text would cost a UTF-8 decode + string alloc per row
    // (~2.7M of them vault-wide) and is only needed for the ~8 winners.
    return this.db
      .prepare(
        "SELECT c.term_id AS id, c.tf AS tf, c.bigram AS bigram, e.df AS df " +
          "FROM folder_cand c JOIN terms e ON e.id = c.term_id " +
          "WHERE c.folder_id = ? ORDER BY c.pos",
      )
      .all(folderId) as unknown as {
      id: number;
      tf: number;
      df: number;
      bigram: number;
    }[];
  }

  /**
   * Resolve term text for a small set of term ids (selected keywords and
   * bigram parts — at most a handful per scored folder).
   */
  termTexts(ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    this.ensureOpen();
    const rows = this.db
      .prepare(
        "SELECT id, term FROM terms " +
          "WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(ids)) as unknown as { id: number; term: string }[];
    for (const row of rows) out.set(row.id, row.term);
    return out;
  }

  /**
   * Resolve term ids for term text (the unigram parts of a selected bigram,
   * for suppression — a missing part suppresses nothing).
   */
  idsForTerms(terms: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (terms.length === 0) return out;
    this.ensureOpen();
    const rows = this.stmts.termIdsBatch.all(
      JSON.stringify(terms),
    ) as unknown as { id: number; term: string }[];
    for (const row of rows) out.set(row.term, row.id);
    return out;
  }

  /**
   * A folder's heading signals, resolved to term text: line counts plus the
   * heading-only flag (both are only ever queried by membership/lookup).
   */
  headRows(folderId: number): {
    lineCount: Map<string, number>;
    headingOnly: Set<string>;
  } {
    this.ensureOpen();
    const rows = this.db
      .prepare(
        "SELECT h.n AS n, h.only AS only, e.term AS term " +
          "FROM folder_head h JOIN terms e ON e.id = h.term_id " +
          "WHERE h.folder_id = ? ORDER BY h.pos",
      )
      .all(folderId) as unknown as { n: number; only: number; term: string }[];
    const lineCount = new Map<string, number>();
    const headingOnly = new Set<string>();
    for (const row of rows) {
      lineCount.set(row.term, row.n);
      if (row.only === 1) headingOnly.add(row.term);
    }
    return { lineCount, headingOnly };
  }

  /**
   * Term ids one stored folder contributes to df — used to subtract the
   * row-sets collapse removes (absorbed children, merge-target parents).
   */
  *storedTermIds(folderId: number): IterableIterator<number> {
    this.ensureOpen();
    const stmt = this.db.prepare(
      "SELECT term_id AS id FROM folder_tf WHERE folder_id = ?",
    );
    const rows = stmt.iterate(folderId) as IterableIterator<{ id: number }>;
    for (const row of rows) yield row.id;
    holdUntilHere(stmt);
  }

  /**
   * Per-term count of stored folders DEEPER than maxDepth containing it —
   * the part of terms.df outside this run's folder set. Streams only terms
   * that occur in deep folders, so a shallow run reads nothing at all.
   */
  *deepTermCounts(
    maxDepth: number,
  ): IterableIterator<{ id: number; n: number }> {
    this.ensureOpen();
    // CROSS JOIN pins the join order: scan the (few hundred) folder rows
    // for deep ones first, then probe each deep folder's term rows — a
    // vault whose whole tree fits the depth limit pays nothing at all.
    const stmt = this.db.prepare(
      "SELECT t.term_id AS id, COUNT(*) AS n FROM folders f " +
        "CROSS JOIN folder_tf t ON t.folder_id = f.id " +
        "WHERE f.depth > ? GROUP BY t.term_id",
    );
    const rows = stmt.iterate(maxDepth) as IterableIterator<{
      id: number;
      n: number;
    }>;
    for (const row of rows) yield row;
    holdUntilHere(stmt);
  }

  /** Largest term id in use (0 when the dictionary is empty). */
  maxTermId(): number {
    this.ensureOpen();
    const row = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM terms")
      .get() as { m: number };
    return row.m;
  }

  /**
   * Resolve text and maintained df for a set of term ids (merged-collapse
   * parents are the only callers — their term ids are already in memory).
   */
  termsBatch(ids: number[]): Map<number, { term: string; df: number }> {
    this.ensureOpen();
    const out = new Map<number, { term: string; df: number }>();
    if (ids.length === 0) return out;
    const stmt = this.db.prepare(
      "SELECT id, term, df FROM terms " +
        "WHERE id IN (SELECT value FROM json_each(?))",
    );
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = stmt.all(
        JSON.stringify(ids.slice(i, i + CHUNK)),
      ) as unknown as { id: number; term: string; df: number }[];
      for (const row of rows) out.set(row.id, { term: row.term, df: row.df });
    }
    holdUntilHere(stmt);
    return out;
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
    terms: number;
    tfRows: number;
    bodyRows: number;
    headRows: number;
    orphanedTerms: number;
  } {
    this.ensureOpen();
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      folders: scalar("SELECT COUNT(*) AS n FROM folders"),
      terms: scalar("SELECT COUNT(*) AS n FROM terms"),
      tfRows: scalar("SELECT COUNT(*) AS n FROM folder_tf"),
      bodyRows: scalar("SELECT COUNT(*) AS n FROM folder_body"),
      headRows: scalar("SELECT COUNT(*) AS n FROM folder_head"),
      orphanedTerms: scalar("SELECT COUNT(*) AS n FROM terms WHERE df <= 0"),
    };
  }

  /** Test-only: one folder's stored term rows with their df, by term text. */
  folderTermsForTests(folder: string): Map<string, { tf: number; df: number }> {
    this.ensureOpen();
    const out = new Map<string, { tf: number; df: number }>();
    const row = this.stmts.folderByPath.get(folder) as
      | { id: number }
      | undefined;
    if (row === undefined) return out;
    const stmt = this.db.prepare(
      "SELECT e.term AS term, t.tf AS tf, e.df AS df " +
        "FROM folder_tf t JOIN terms e ON e.id = t.term_id " +
        "WHERE t.folder_id = ? ORDER BY t.pos",
    );
    for (const r of stmt.iterate(row.id) as IterableIterator<{
      term: string;
      tf: number;
      df: number;
    }>) {
      out.set(r.term, { tf: r.tf, df: r.df });
    }
    holdUntilHere(stmt);
    return out;
  }

  /** Test-only: the stored metadata of one folder. */
  folderForTests(
    folder: string,
  ):
    | { sig: string; notes: number; tags: string[]; warn: string[] }
    | undefined {
    this.ensureOpen();
    const row = this.stmts.folderByPath.get(folder) as
      | { sig: string; notes: number; tags: string; warn: string }
      | undefined;
    if (row === undefined) return undefined;
    return {
      sig: row.sig,
      notes: row.notes,
      tags: JSON.parse(row.tags) as string[],
      warn: JSON.parse(row.warn) as string[],
    };
  }

  /** Test-only: all stored folder paths. */
  folderPathsForTests(): string[] {
    this.ensureOpen();
    return (
      this.db
        .prepare("SELECT path FROM folders ORDER BY path")
        .all() as unknown as { path: string }[]
    ).map((r) => r.path);
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

let heldSql = "";
/**
 * A use of stmt after its iteration loop, so the statement stays reachable
 * for the whole loop. Node 22.13's StatementSync.iterate() iterator does
 * not reference its statement; a statement only reachable through the
 * iterator can be garbage-collected and finalized mid-loop ("statement has
 * been finalized", seen in the Node-floor CI job). Newer Node versions keep
 * it alive; this is harmless there.
 */
function holdUntilHere(stmt: { sourceSQL: string }): void {
  heldSql = stmt.sourceSQL;
}
