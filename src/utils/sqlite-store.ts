import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
  IncrementalIndexStore,
  IndexDiff,
  IndexedDoc,
  IndexSnapshot,
} from "./index-store.js";
import { JsonStore } from "./json-store.js";
import { linkCountKey, linkTarget } from "./search-cache.js";

/**
 * The SQLite search-index store (#106, part of #94).
 *
 * `.napkin/cache/index-v1.db` — a versioned file name so napkin versions that
 * change the schema never fight over one database. WAL mode, per-file
 * upserts/deletes inside one transaction per diff, and the basename
 * MiniSearch index as a blob rewritten only when the basename set changes.
 *
 * Schema (v1, `PRAGMA user_version = 1`):
 *
 *   meta(k, v)                       'gen', 'ignore_fp'; reserved: 'scan_lease',
 *                                    'last_scan_at', 'body_state' (later issues)
 *   folders(id, path, depth, gen)    folder row per dirname; gen bumps when a
 *                                    direct file is added/changed/removed
 *                                    (reserved for the overview store, #94 s4)
 *   files(id, path, folder_id, basename, basename_lc, depth,
 *         mtime, size, ino, gen)     one row per note; gen = the generation the
 *                                    row was last written
 *   links(src, target)               raw outgoing wikilink targets per file id
 *   link_counts(key, n)              classified target key → occurrences;
 *                                    key = lc basename (bare) or 'p:'+ref —
 *                                    the future cross-process delta feed
 *   tombstones(path, basename, gen)  deletions since the last blob write;
 *                                    a later issue prunes them by age
 *   blobs(k, gen, v)                 'minisearch-basename' → serialized index
 *
 * Generations (`meta.gen`) increase once per write transaction. A file's row
 * commits in the same transaction as everything derived from it, so a crash
 * can never leave a signature that claims data which is missing — the next
 * scan sees the old signature and redoes the work. The basename blob carries
 * the generation it was written at; `load()` reports the files/tombstones
 * newer than it as `IndexSnapshot.indexDelta`, so a loading process repairs
 * the stale blob in memory instead of paying an O(vault) blob rewrite on
 * every edit.
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
const DB_FILE = "index-v1.db";
const SCHEMA_VERSION = 1;
const BASENAME_BLOB_KEY = "minisearch-basename";

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
  gen INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS blobs(
  k TEXT PRIMARY KEY,
  gen INTEGER NOT NULL,
  v BLOB
);
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
  blobUpsert: StatementSync;
  blobGet: StatementSync;
  allFiles: StatementSync;
  allLinks: StatementSync;
  tombsSince: StatementSync;
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
        "path, folder_id, basename, basename_lc, depth, mtime, size, ino, gen" +
        ") VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?) " +
        "ON CONFLICT(path) DO UPDATE SET " +
        "folder_id = excluded.folder_id, basename = excluded.basename, " +
        "basename_lc = excluded.basename_lc, depth = excluded.depth, " +
        "mtime = excluded.mtime, size = excluded.size, gen = excluded.gen",
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
    blobUpsert: db.prepare(
      "INSERT INTO blobs(k, gen, v) VALUES(?, ?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET gen = excluded.gen, v = excluded.v",
    ),
    blobGet: db.prepare("SELECT gen, v FROM blobs WHERE k = ?"),
    allFiles: db.prepare(
      "SELECT id, path, basename, mtime, size, gen FROM files ORDER BY path",
    ),
    allLinks: db.prepare(
      "SELECT f.path AS path, l.target AS target " +
        "FROM links l JOIN files f ON f.id = l.src " +
        "ORDER BY f.path, l.rowid",
    ),
    tombsSince: db.prepare(
      "SELECT path, basename FROM tombstones WHERE gen > ? ORDER BY path",
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
    db = new sqlite.DatabaseSync(dbPath, { timeout: 5000 });
    db.exec(`PRAGMA journal_mode = ${journalMode}`);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA cache_size = -16000");
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
      "SELECT id, path, folder_id, basename, basename_lc, depth, mtime, size, ino, gen FROM files LIMIT 0",
    ).get();
    db.prepare("SELECT src, target FROM links LIMIT 0").get();
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      // Nothing to close cleanly.
    }
    return null;
  }
}

export class SqliteStore implements IncrementalIndexStore {
  private constructor(
    private readonly configPath: string,
    private readonly db: DatabaseSync,
    private readonly stmts: Stmts,
  ) {}

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
      const stamp = Date.now();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.renameSync(
            `${dbPath}${suffix}`,
            `${dbPath}${suffix}.corrupt-${stamp}`,
          );
        } catch {
          // A missing sidecar is fine; anything else still gets one more try.
        }
      }
      for (const mode of ["WAL", "DELETE"] as const) {
        db = tryOpen(sqlite, dbPath, mode);
        if (db !== null) break;
      }
      if (db === null) return null;
    }

    const store = new SqliteStore(configPath, db, prepareAll(db));
    store.migrateFromJson();
    return store;
  }

  /**
   * One-shot migration: an empty database adopts a valid JSON snapshot
   * instead of forcing the first SqliteStore search into a cold build.
   * The JSON file is left in place — it is still the fallback store's cache,
   * and its removal is a later cleanup step (#94 step 7).
   */
  private migrateFromJson(): void {
    try {
      const count = this.stmts.fileCount.get() as { n: number } | undefined;
      if ((count?.n ?? 0) > 0) return;
      if (this.stmts.blobGet.get(BASENAME_BLOB_KEY) !== undefined) return;
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
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const gen = this.bumpGen();
      db.exec("DELETE FROM links");
      db.exec("DELETE FROM files");
      db.exec("DELETE FROM folders");
      db.exec("DELETE FROM link_counts");
      db.exec("DELETE FROM tombstones");
      db.exec("DELETE FROM blobs");
      const countDeltas = new Map<string, number>();
      for (const doc of snapshot.docs) {
        this.upsertDoc(
          gen,
          doc,
          snapshot.outgoingLinks[doc.file] ?? [],
          countDeltas,
        );
      }
      this.applyCountDeltas(countDeltas);
      this.putBlob(gen, snapshot.index);
      this.stmts.setMeta.run("ignore_fp", snapshot.ignoreFingerprint);
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
   * between the old and new link sets. Deletes write a tombstone. The
   * basename blob is rewritten only when `diff.indexBlob` is present — the
   * caller sets it iff the basename set changed.
   */
  saveDiff(diff: IndexDiff): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const gen = this.bumpGen();
      const countDeltas = new Map<string, number>();
      for (const removed of diff.remove) {
        const row = this.stmts.fileIdByPath.get(removed.file) as
          | { id: number }
          | undefined;
        if (row !== undefined) {
          for (const { target } of this.linksOf(row.id)) {
            bumpDelta(countDeltas, linkCountKey(linkTarget(target)), -1);
          }
          this.stmts.linksDelete.run(row.id);
          this.stmts.fileDelete.run(removed.file);
        }
        this.touchFolder(parentDir(removed.file), gen);
        this.stmts.tombUpsert.run(removed.file, removed.basename, gen);
      }
      for (const doc of diff.upsert) {
        this.upsertDoc(gen, doc, doc.outgoingLinks, countDeltas);
      }
      if (diff.indexBlob !== undefined) {
        this.putBlob(gen, diff.indexBlob);
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
   * Load the stored snapshot, or null when there is none usable.
   *
   * Never throws: a database that fails mid-read is corrupt or unreadable,
   * which the caller treats exactly like a missing cache — a cold build.
   * Resolved backlink counts are not persisted (per-target tallies are, in
   * `link_counts`); `backlinkCounts` is advisory and `loadFromDiskCache`
   * re-derives it either way.
   */
  load(): IndexSnapshot | null {
    try {
      const meta = this.readMeta();
      const blob = this.stmts.blobGet.get(BASENAME_BLOB_KEY) as
        | { gen: number; v: unknown }
        | undefined;
      // No blob means nothing was ever saved (or only a failed import).
      if (blob === undefined || meta.ignoreFp === undefined) return null;
      const index = typeof blob.v === "string" ? blob.v : String(blob.v);

      const files = this.stmts.allFiles.all() as unknown as FileRow[];
      const docs: IndexedDoc[] = [];
      const fileMtimes: IndexSnapshot["fileMtimes"] = {};
      for (const row of files) {
        docs.push({
          file: row.path,
          basename: row.basename,
          mtime: row.mtime,
          size: row.size,
        });
        fileMtimes[row.path] = { mtime: row.mtime, size: row.size };
      }
      // Every file gets an entry, even without links — the JSON snapshot
      // carries explicit empty arrays and loadFromDiskCache merges the map.
      const outgoingLinks: IndexSnapshot["outgoingLinks"] = {};
      for (const row of files) outgoingLinks[row.path] = [];
      for (const row of this.stmts.allLinks.all() as unknown as {
        path: string;
        target: string;
      }[]) {
        const list = outgoingLinks[row.path] ?? [];
        list.push(row.target);
        outgoingLinks[row.path] = list;
      }

      const add: string[] = [];
      for (const row of files) {
        if (row.gen > blob.gen) add.push(row.path);
      }
      const remove = (
        this.stmts.tombsSince.all(blob.gen) as unknown as {
          path: string;
          basename: string;
        }[]
      ).map((t) => ({ file: t.path, basename: t.basename }));

      return {
        folder: null,
        fileMtimes,
        index,
        docs,
        backlinkCounts: {},
        outgoingLinks,
        ignoreFingerprint: meta.ignoreFp,
        indexDelta:
          add.length > 0 || remove.length > 0 ? { add, remove } : undefined,
      };
    } catch {
      return null;
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private bumpGen(): number {
    const row = this.stmts.nextGen.get() as { gen: number } | undefined;
    return row?.gen ?? 0;
  }

  private readMeta(): { ignoreFp?: string } {
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
    this.stmts.fileUpsert.run(
      doc.file,
      folderId,
      doc.basename,
      doc.basename.toLowerCase(),
      doc.file.split("/").length - 1,
      doc.mtime,
      doc.size,
      gen,
    );
    const row = this.stmts.fileIdByPath.get(doc.file) as
      | { id: number }
      | undefined;
    if (row === undefined) {
      throw new Error(`files row missing after upsert: ${doc.file}`);
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

  private putBlob(gen: number, index: string): void {
    this.stmts.blobUpsert.run(BASENAME_BLOB_KEY, gen, index);
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
    this.db.close();
  }

  /** Test-only: the persisted per-target link tallies. */
  linkCountsForTests(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT key, n FROM link_counts ORDER BY key")
      .all() as unknown as { key: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.n]));
  }

  /** Test-only snapshot of the bookkeeping that drives `indexDelta`. */
  inspectForTests(): {
    gen: number;
    blobGen: number | null;
    fileCount: number;
    linkCount: number;
    tombstones: number;
  } {
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const genRow = this.db
      .prepare("SELECT CAST(v AS INTEGER) AS gen FROM meta WHERE k = 'gen'")
      .get() as { gen: number } | undefined;
    const blob = this.stmts.blobGet.get(BASENAME_BLOB_KEY) as
      | { gen: number }
      | undefined;
    return {
      gen: genRow?.gen ?? 0,
      blobGen: blob?.gen ?? null,
      fileCount: scalar("SELECT COUNT(*) AS n FROM files"),
      linkCount: scalar("SELECT COUNT(*) AS n FROM links"),
      tombstones: scalar("SELECT COUNT(*) AS n FROM tombstones"),
    };
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
