import * as fs from "node:fs";
import * as path from "node:path";
import { OVERVIEW_CACHE_VERSION } from "./overview-cache.js";
import {
  folderDepth,
  folderKeywordTokens,
  termFlags,
} from "./overview-terms.js";
import { loadSqlite, type SqliteModule } from "./sqlite-loader.js";

/**
 * The SQLite per-note overview store (#118, schema v2 #125).
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
 * Schema (v2, `PRAGMA user_version = 2`, #125): per-folder term data lives
 * as SQL ROWS instead of per-folder blobs, so a miss updates rows instead of
 * re-materializing dense per-folder arrays in JS.
 *
 *   meta(k, v)                              'format' (OVERVIEW_CACHE_VERSION),
 *                                           'ignore_fp', 'templates_folder',
 *                                           'df_depth' (depth bound dft was
 *                                           built under)
 *   terms(id, term UNIQUE)                  the term dictionary (bigrams
 *                                           included); ids carry no meaning
 *                                           beyond identity within this DB
 *   notes(path, folder, mtime, size,        one row per note; (mtime, size)
 *         skip, tags, heads, data, ord)     is the freshness key (the same
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
 *                                           each in first-seen order.
 *                                           ord is the note's order key,
 *                                           spaced 2^20 apart in JS
 *                                           path-sort order.
 *   folders(path, notes, tags, warn)        one row per folder — the
 *                                           aggregate its notes' blobs
 *                                           produce. notes/tags/warn stay
 *                                           per-folder scalars; the term
 *                                           data moved into rows.
 *   fdir(fid, path UNIQUE)                  folder ids for the row tables
 *   ft(fid, tid, w, lc,                     one row per folder term:
 *      nord, npos, hord, hpos)              w = non-heading weighted count,
 *      PK(fid, tid) WITHOUT ROWID           lc = number of distinct heading
 *                                           texts containing the term,
 *                                           (nord,npos)/(hord,hpos) = first
 *                                           note (by ord) and position
 *                                           outside/inside headings
 *   cand(fid, tid, tf, sec,                 keyword candidates in tf order:
 *        o1, o2) PK(fid, tid)               tf = w + 3·[lc>0]; (sec,o1,o2) =
 *        WITHOUT ROWID                      (0,nord,npos) when w>0 else
 *                                           (1,hord,hpos). The candidate
 *                                           filter (bigram tf≥2, not a
 *                                           self-pair, not a folder token,
 *                                           heading-only needs lc≥2) runs
 *                                           in SQL from the term text.
 *   dft(tid, n)                             document frequency over stored
 *                                           folders at depth ≤ meta.df_depth
 *   headrc(fid, text, n)                    refcount of distinct heading
 *      PK(fid, text) WITHOUT ROWID          texts per folder — drives lc
 *
 * Collapse merge data (#112 r3 step 4 keeps the full-equivalent derivation):
 * the v1 `full` blob is gone; the collapse path derives a folder's
 * tf/body/heading maps from ft rows plus the body section of its ordered
 * note blobs — computed lazily only for collapse-candidate folders.
 *
 * A v1 file (per-folder tfids/cand/full blobs + meta flags) is migrated in
 * place on open — one transaction streams each note's stored blob into ft,
 * refcounts heading texts into headrc/lc, builds cand with the SQL filter
 * and dft with one GROUP BY — when its meta.format is current. A stale
 * format or any migration failure parks the file aside and the cold path
 * rebuilds it.
 *
 * The DB is disposable: open failure, corruption, or a schema-version
 * mismatch renames the file aside and recreates it; a second failure makes
 * `open()` return null so `createOverviewStore` falls back to the JSON
 * folder cache.
 */

type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

const CACHE_DIR = "cache";
const DB_FILE = "overview-v2.db";
const SCHEMA_VERSION = 2;
/**
 * notes.ord spacing: notes get (i+1)·2^20 in JS path-sort order, so a later
 * per-note insert lands midway between neighbours before a folder has to be
 * renumbered (the 2^20 gap allows twenty halvings).
 */
export const ORD_GAP = 1 << 20;

let busyTimeoutMs = 5000;
/** Test seam: SQLite busy timeout in ms (default 5000). */
export function setOverviewBusyTimeoutForTests(ms: number): void {
  busyTimeoutMs = ms;
}

const SCHEMA_DDL = `${[
  "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v)",
  // No UNIQUE constraint: the cold dictionary flush inserts in id order
  // (append-only on the rowid) and builds terms_term afterwards — a live
  // UNIQUE index would take 1.4M random inserts either way (~7 s vs ~2 s).
  "CREATE TABLE IF NOT EXISTS terms(id INTEGER PRIMARY KEY, term TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, folder TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, skip INTEGER NOT NULL, tags TEXT NOT NULL, heads TEXT NOT NULL, data BLOB, ord INTEGER)",
  "CREATE TABLE IF NOT EXISTS folders(path TEXT PRIMARY KEY, notes INTEGER NOT NULL, tags TEXT NOT NULL, warn TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS fdir(fid INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ft(fid INTEGER NOT NULL, tid INTEGER NOT NULL, w INTEGER NOT NULL, lc INTEGER NOT NULL, nord INTEGER, npos INTEGER, hord INTEGER, hpos INTEGER, PRIMARY KEY(fid, tid)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS cand(fid INTEGER NOT NULL, tid INTEGER NOT NULL, tf INTEGER NOT NULL, sec INTEGER NOT NULL, o1 INTEGER NOT NULL, o2 INTEGER NOT NULL, PRIMARY KEY(fid, tid)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS dft(tid INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS headrc(fid INTEGER NOT NULL, text TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(fid, text)) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS notes_fo ON notes(folder, ord)",
].join(";\n")}`;

/**
 * Folder term upserts — shared by the v1→v2 migration and the whole-folder
 * re-aggregation a miss performs. json_each carries the note's term lists
 * across the JS↔SQLite boundary once per note instead of once per term.
 *
 * First-seen keys: coalesce keeps the earliest note's ord; when the key was
 * NULL (the row exists only because the OTHER section created it), the CASE
 * installs this section's position. Column references in DO UPDATE SET read
 * the pre-update row, so the two expressions test the same condition.
 */
const SQL_FT_NH =
  "INSERT INTO ft(fid, tid, w, lc, nord, npos) " +
  "SELECT ?1, e.value ->> 0, e.value ->> 1, 0, ?2, e.key FROM json_each(?3) e " +
  "WHERE true ON CONFLICT(fid, tid) DO UPDATE SET w = w + excluded.w, " +
  "nord = coalesce(nord, excluded.nord), " +
  "npos = CASE WHEN nord IS NULL THEN excluded.npos ELSE npos END";
const SQL_FT_H =
  "INSERT INTO ft(fid, tid, w, lc, hord, hpos) " +
  "SELECT ?1, e.value, 0, 0, ?2, e.key FROM json_each(?3) e " +
  "WHERE true ON CONFLICT(fid, tid) DO UPDATE SET " +
  "hord = coalesce(hord, excluded.hord), " +
  "hpos = CASE WHEN hord IS NULL THEN excluded.hpos ELSE hpos END";
const SQL_HEADRC =
  "INSERT INTO headrc(fid, text, n) VALUES(?1, ?2, 1) " +
  "ON CONFLICT(fid, text) DO UPDATE SET n = n + 1 RETURNING n";
const SQL_LC =
  "UPDATE ft SET lc = lc + 1 WHERE fid = ?1 " +
  "AND tid IN (SELECT value FROM json_each(?2))";

/**
 * The candidate filter as SQL — aggregateFolder's isCandidateKeyword over
 * the term text: a bigram (term contains a space) needs tf ≥ 2 and must not
 * be an "x x" self-pair; any other term must not be a folder token; a
 * heading-only term (w = 0) needs lc ≥ 2.
 */
const SQL_CAND =
  "INSERT INTO cand(fid, tid, tf, sec, o1, o2) " +
  "SELECT f.fid, f.tid, f.w + (f.lc > 0) * 3, f.w = 0, " +
  "CASE WHEN f.w > 0 THEN f.nord ELSE f.hord END, " +
  "CASE WHEN f.w > 0 THEN f.npos ELSE f.hpos END " +
  "FROM ft f JOIN terms t ON t.id = f.tid " +
  "WHERE f.fid = ?1 AND NOT (f.w = 0 AND f.lc < 2) " +
  "AND CASE WHEN instr(t.term, ' ') > 0 " +
  "THEN f.w + (f.lc > 0) * 3 >= 2 AND " +
  "substr(t.term, 1, instr(t.term, ' ') - 1) <> substr(t.term, instr(t.term, ' ') + 1) " +
  "ELSE t.id NOT IN (SELECT value FROM json_each(?2)) END";

/** tf order for a folder's ft rows: non-heading terms by (nord,npos), then
 *  heading-only terms by (hord,hpos) — ORDER BY key shared by the collapse
 *  derivation and (via cand.sec/o1/o2) the stored candidate order. */
const SQL_TF_ORDER =
  "(w = 0), CASE WHEN w > 0 THEN nord ELSE hord END, " +
  "CASE WHEN w > 0 THEN npos ELSE hpos END";

/** Folder depth as SQL — folderDepth's exact rule ('/' → 0, else slash
 *  count + 1), used by the dft rebuild's depth bound. */
const SQL_FOLDER_DEPTH =
  "CASE WHEN d.path = '/' THEN 0 " +
  "ELSE length(d.path) - length(replace(d.path, '/', '')) + 1 END";

interface Stmts {
  metaGet: StatementSync;
  metaSet: StatementSync;
  noteMetaAll: StatementSync;
  noteGet: StatementSync;
  noteUpsert: StatementSync;
  noteDelete: StatementSync;
  noteDeleteFolder: StatementSync;
  noteSetOrd: StatementSync;
  noteBodiesFolder: StatementSync;
  folderUpsert: StatementSync;
  folderDelete: StatementSync;
  folderPaths: StatementSync;
  folderRows: StatementSync;
  fdirEnsure: StatementSync;
  fdirGet: StatementSync;
  fdirDelete: StatementSync;
  ftDeleteFolder: StatementSync;
  candDeleteFolder: StatementSync;
  headrcDeleteFolder: StatementSync;
  ftAddNh: StatementSync;
  ftAddH: StatementSync;
  headrcBump: StatementSync;
  lcBump: StatementSync;
  candFill: StatementSync;
  candFolder: StatementSync;
  dftDecFolder: StatementSync;
  dftIncFolder: StatementSync;
  dftPrune: StatementSync;
  dftAll: StatementSync;
  dftClear: StatementSync;
  dftRebuild: StatementSync;
  ftFolderTids: StatementSync;
  ftFolderTfPairs: StatementSync;
  ftFolderHead: StatementSync;
  ftFolderHeadOnly: StatementSync;
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
    noteSetOrd: db.prepare("UPDATE notes SET ord = ? WHERE path = ?"),
    noteBodiesFolder: db.prepare(
      "SELECT data FROM notes WHERE folder = ? ORDER BY ord",
    ),
    folderUpsert: db.prepare(
      "INSERT INTO folders(path, notes, tags, warn) VALUES(?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET notes = excluded.notes, " +
        "tags = excluded.tags, warn = excluded.warn",
    ),
    folderDelete: db.prepare("DELETE FROM folders WHERE path = ?"),
    folderPaths: db.prepare("SELECT path FROM folders"),
    folderRows: db.prepare(
      "SELECT f.path, f.notes, f.tags, f.warn, d.fid FROM folders f " +
        "JOIN fdir d ON d.path = f.path",
    ),
    fdirEnsure: db.prepare(
      "INSERT INTO fdir(path) VALUES(?) ON CONFLICT(path) " +
        "DO UPDATE SET path = excluded.path RETURNING fid",
    ),
    fdirGet: db.prepare("SELECT fid FROM fdir WHERE path = ?"),
    fdirDelete: db.prepare("DELETE FROM fdir WHERE fid = ?"),
    ftDeleteFolder: db.prepare("DELETE FROM ft WHERE fid = ?"),
    candDeleteFolder: db.prepare("DELETE FROM cand WHERE fid = ?"),
    headrcDeleteFolder: db.prepare("DELETE FROM headrc WHERE fid = ?"),
    ftAddNh: db.prepare(SQL_FT_NH),
    ftAddH: db.prepare(SQL_FT_H),
    headrcBump: db.prepare(SQL_HEADRC),
    lcBump: db.prepare(SQL_LC),
    candFill: db.prepare(SQL_CAND),
    candFolder: db.prepare(
      "SELECT tid, tf FROM cand WHERE fid = ? ORDER BY sec, o1, o2",
    ),
    dftDecFolder: db.prepare(
      "UPDATE dft SET n = n - 1 WHERE tid IN " +
        "(SELECT tid FROM ft WHERE fid = ?)",
    ),
    dftIncFolder: db.prepare(
      "INSERT INTO dft(tid, n) SELECT tid, 1 FROM ft WHERE fid = ? " +
        "ON CONFLICT(tid) DO UPDATE SET n = n + 1",
    ),
    dftPrune: db.prepare("DELETE FROM dft WHERE n <= 0"),
    dftAll: db.prepare("SELECT tid, n FROM dft"),
    dftClear: db.prepare("DELETE FROM dft"),
    dftRebuild: db.prepare(
      "INSERT INTO dft(tid, n) SELECT f.tid, COUNT(*) FROM ft f " +
        "JOIN fdir d ON d.fid = f.fid WHERE " +
        SQL_FOLDER_DEPTH +
        " <= ?1 GROUP BY f.tid",
    ),
    ftFolderTids: db.prepare("SELECT tid FROM ft WHERE fid = ?"),
    ftFolderTfPairs: db.prepare(
      "SELECT tid, w + (lc > 0) * 3 AS tf FROM ft WHERE fid = ? " +
        "ORDER BY " +
        SQL_TF_ORDER,
    ),
    ftFolderHead: db.prepare(
      "SELECT tid, lc FROM ft WHERE fid = ? AND lc > 0 ORDER BY hord, hpos",
    ),
    ftFolderHeadOnly: db.prepare(
      "SELECT tid FROM ft WHERE fid = ? AND w = 0 AND lc > 0",
    ),
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

/** One stored note's full record, as the folder streaming consumes it. */
export interface StoredNoteRecord {
  skip: number;
  /** JSON string[]: the note's tags. */
  tags: string;
  /** JSON [[headingText, termId[]], …] per unique heading text. */
  heads: string;
  /** Int32 blob [nNh,(id,count)×, nBody,(id,count)×] or null when skipped. */
  data: Uint8Array | null;
}

/** One stored folder row plus its fdir id (term data lives in the row tables). */
export interface StoredFolderRow {
  path: string;
  notes: number;
  /** JSON string[]: the folder's tags, build order. */
  tags: string;
  /** JSON string[]: warnings emitted while building the folder. */
  warn: string;
  fid: number;
}

/**
 * The pieces of one note's record the ft/headrc streaming consumes — the
 * same slices aggregateFolder accumulated: non-heading (id,count) pairs in
 * first-seen order, the distinct heading-seen ids in first-seen order, and
 * the per-unique-heading-text term lists.
 */
export interface StreamedNote {
  skip: boolean;
  heads: [string, number[]][];
  data: Int32Array | null;
}

/** Decode a stored note row into the streamed form. */
function decodeStoredNote(row: StoredNoteRecord): StreamedNote {
  return {
    skip: row.skip === 1,
    heads: JSON.parse(row.heads) as [string, number[]][],
    data:
      row.data === null
        ? null
        : row.data.byteOffset % 4 === 0
          ? new Int32Array(
              row.data.buffer,
              row.data.byteOffset,
              row.data.byteLength >> 2,
            )
          : new Int32Array(row.data.slice().buffer),
  };
}

/** Stream one note's record into ft/headrc — migrate2's exact upserts. */
function streamNoteIntoFt(
  stmts: Pick<Stmts, "ftAddNh" | "ftAddH" | "headrcBump" | "lcBump">,
  fid: number,
  ord: number,
  rec: StreamedNote,
): void {
  if (rec.skip || rec.data === null) return;
  const a = rec.data;
  const nn = a[0];
  const nhPairs: [number, number][] = [];
  for (let k = 0, p = 1; k < nn; k++, p += 2) {
    nhPairs.push([a[p], a[p + 1]]);
  }
  const seen = new Set<number>();
  const hIds: number[] = [];
  for (const [, ids] of rec.heads) {
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        hIds.push(id);
      }
    }
  }
  if (nhPairs.length > 0) {
    stmts.ftAddNh.run(fid, ord, JSON.stringify(nhPairs));
  }
  if (hIds.length > 0) {
    stmts.ftAddH.run(fid, ord, JSON.stringify(hIds));
  }
  for (const [text, ids] of rec.heads) {
    const row = stmts.headrcBump.get(fid, text) as { n: number };
    // First occurrence of this heading text in the folder: its terms gain
    // one distinct-heading-text count.
    if (row.n === 1) stmts.lcBump.run(fid, JSON.stringify(ids));
  }
}

/** Why the last tryOpen failed, so a reopen failure can say corrupt vs busy. */
let lastOpenError = "";
/** Set when a failed open was a failed v1→v2 migration (park immediately —
 *  retrying the same data in the other journal mode cannot help). */
let migrationFailed = false;

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

/**
 * In-place v1 → v2 migration, inside one transaction (#125). Streams each
 * note's stored blob into ft in JS path-sort order (ord spaced 2^20),
 * refcounts heading texts into headrc/lc, builds cand per folder with the
 * SQL filter, and dft with one GROUP BY over every stored folder (df_depth
 * is set to the deepest stored folder, making the unfiltered count exact);
 * a later run at a different depth rebuilds dft under its own bound.
 * Any failure rolls back and the caller parks the file for a cold rebuild.
 */
function migrateV1ToV2(db: DatabaseSync): void {
  const format = (
    db.prepare("SELECT v FROM meta WHERE k = 'format'").get() as
      | { v: unknown }
      | undefined
  )?.v;
  if (format !== OVERVIEW_CACHE_VERSION) {
    throw new Error(
      "overview v1 store has stale format " +
        String(format) +
        ", expected " +
        OVERVIEW_CACHE_VERSION,
    );
  }
  // 16 MB page cache for the migration transaction (measured optimum on the
  // 29.5k-note vault: 11 s, ~106 MB peak).
  db.exec("PRAGMA cache_size = -16384");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      [
        "CREATE TABLE fdir(fid INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL)",
        "CREATE TABLE ft(fid INTEGER NOT NULL, tid INTEGER NOT NULL, w INTEGER NOT NULL, lc INTEGER NOT NULL, nord INTEGER, npos INTEGER, hord INTEGER, hpos INTEGER, PRIMARY KEY(fid, tid)) WITHOUT ROWID",
        "CREATE TABLE cand(fid INTEGER NOT NULL, tid INTEGER NOT NULL, tf INTEGER NOT NULL, sec INTEGER NOT NULL, o1 INTEGER NOT NULL, o2 INTEGER NOT NULL, PRIMARY KEY(fid, tid)) WITHOUT ROWID",
        "CREATE TABLE dft(tid INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
        "CREATE TABLE headrc(fid INTEGER NOT NULL, text TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(fid, text)) WITHOUT ROWID",
        "ALTER TABLE notes ADD COLUMN ord INTEGER",
        "CREATE INDEX notes_fo ON notes(folder, ord)",
      ].join(";\n"),
    );
    const q = {
      paths: db.prepare("SELECT path FROM notes WHERE folder = ?"),
      note: db.prepare(
        "SELECT skip, tags, heads, data FROM notes WHERE path = ?",
      ),
      setOrd: db.prepare("UPDATE notes SET ord = ? WHERE path = ?"),
      fdirIns: db.prepare("INSERT INTO fdir(fid, path) VALUES(?, ?)"),
      ftAddNh: db.prepare(SQL_FT_NH),
      ftAddH: db.prepare(SQL_FT_H),
      headrcBump: db.prepare(SQL_HEADRC),
      lcBump: db.prepare(SQL_LC),
      cand: db.prepare(SQL_CAND),
      tokIds: db.prepare(
        "SELECT id FROM terms WHERE term IN (SELECT value FROM json_each(?))",
      ),
    };
    const folders = (
      db.prepare("SELECT path FROM folders").all() as unknown as {
        path: string;
      }[]
    )
      .map((r) => r.path)
      .sort();
    let fid = 0;
    let maxStoredDepth = 0;
    for (const folder of folders) {
      fid++;
      q.fdirIns.run(fid, folder);
      const depth = folderDepth(folder);
      if (depth > maxStoredDepth) maxStoredDepth = depth;
      const paths = (q.paths.all(folder) as unknown as { path: string }[])
        .map((r) => r.path)
        .sort();
      paths.forEach((p, i) => {
        const ord = (i + 1) * ORD_GAP;
        q.setOrd.run(ord, p);
        const row = q.note.get(p) as unknown as StoredNoteRecord;
        streamNoteIntoFt(q, fid, ord, decodeStoredNote(row));
      });
      const tokIds = (
        q.tokIds.all(
          JSON.stringify([...folderKeywordTokens(folder)]),
        ) as unknown as { id: number }[]
      ).map((r) => r.id);
      q.cand.run(fid, JSON.stringify(tokIds));
    }
    db.exec(
      "INSERT INTO dft(tid, n) SELECT tid, count(*) FROM ft GROUP BY tid",
    );
    db.prepare(
      "INSERT INTO meta(k, v) VALUES('df_depth', ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ).run(maxStoredDepth);
    // The v1 derived blobs and the meta flag array are superseded by the
    // row tables; a missing column (a partially-migrated v1 file) must fail
    // the migration loudly so the file is parked, not half-dropped.
    db.exec("ALTER TABLE folders DROP COLUMN tfids");
    db.exec("ALTER TABLE folders DROP COLUMN cand");
    db.exec("ALTER TABLE folders DROP COLUMN full");
    db.exec("DELETE FROM meta WHERE k IN ('flags', 'df')");
    db.exec("COMMIT");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Rollback best-effort: the file gets parked either way.
    }
    throw error;
  } finally {
    db.exec("PRAGMA cache_size = -2048");
  }
}

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
    // Small page cache: the connection is closed when the overview finishes,
    // so nothing stays resident between calls.
    db.exec("PRAGMA cache_size = -2048");
    db.exec("PRAGMA foreign_keys = OFF");
    const row = db.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const version = row?.user_version ?? 0;
    if (version === 1) {
      try {
        migrateV1ToV2(db);
      } catch (error) {
        migrationFailed = true;
        throw error;
      }
    } else if (version !== 0 && version !== SCHEMA_VERSION) {
      // A versioned file name covers cross-version skew; a nonzero, different
      // user_version means a same-name schema we cannot read — rebuild.
      throw new Error(
        `overview schema version ${version}, expected ${SCHEMA_VERSION}`,
      );
    }
    db.exec(SCHEMA_DDL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    // Probe the tables a schema-skewed file might be missing columns on.
    db.prepare("SELECT id, term FROM terms LIMIT 0").get();
    db.prepare(
      "SELECT path, folder, mtime, size, skip, tags, heads, data, ord FROM notes LIMIT 0",
    ).get();
    db.prepare("SELECT path, notes, tags, warn FROM folders LIMIT 0").get();
    db.prepare("SELECT fid, path FROM fdir LIMIT 0").get();
    db.prepare(
      "SELECT fid, tid, w, lc, nord, npos, hord, hpos FROM ft LIMIT 0",
    ).get();
    db.prepare("SELECT fid, tid, tf, sec, o1, o2 FROM cand LIMIT 0").get();
    db.prepare("SELECT tid, n FROM dft LIMIT 0").get();
    db.prepare("SELECT fid, text, n FROM headrc LIMIT 0").get();
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
  /**
   * Whether this store opened a transaction that is still open. Tracked by
   * hand because DatabaseSync#isTransaction is missing on the Node 22.13
   * engines floor (later 22.x and 24.x have it): there it is undefined, so a check on it never
   * committed and the next BEGIN failed ("cannot start a transaction within
   * a transaction"), silently pinning the overview to the JSON fallback.
   */
  private txOpen = false;
  private maxId = -1;
  /** Cold-build interning: an in-memory dict while the whole vault is
   *  rewritten, so 1.4M first-seen terms skip per-term SQL probes. */
  private coldDict: Map<string, number> | null = null;
  private coldIds: Map<number, string> | null = null;
  private coldTerms: string[] = [];
  private coldFlushed = 0;

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
    throw new Error(`cannot reopen overview store: ${lastOpenError}`);
  }

  private closeDb(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Closing a broken database is best-effort.
    }
  }

  /**
   * Open (or create) the vault's overview store; null when the file cannot
   * be used at all (the caller falls back to the JSON folder cache).
   *
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
   * discarded wholesale rather than partially trusted. df_depth is the
   * depth bound dft currently counts folders under.
   */
  metaState(): {
    format?: number;
    ignoreFp?: string;
    templatesFolder?: string;
    dfDepth?: number;
  } {
    this.ensureOpen();
    const read = (k: string): unknown =>
      (this.stmts.metaGet.get(k) as { v: unknown } | undefined)?.v;
    const format = read("format");
    const ignoreFp = read("ignore_fp");
    const templatesFolder = read("templates_folder");
    const dfDepth = read("df_depth");
    return {
      format: typeof format === "number" ? format : undefined,
      ignoreFp: typeof ignoreFp === "string" ? ignoreFp : undefined,
      templatesFolder:
        typeof templatesFolder === "string" ? templatesFolder : undefined,
      dfDepth: typeof dfDepth === "number" ? dfDepth : undefined,
    };
  }

  // ── Term dictionary ───────────────────────────────────────────────
  //
  // ids are stable within this DB only; maxTermId is the SQL MAX(id), so
  // sparse deletes never matter. There is no flags blob in v2: the cand
  // filter derives bigram/self-pair from the term text in SQL, and the JS
  // side resolves a term's text when it needs it.

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
    this.coldFlushed = 0;
  }

  /**
   * Intern every term in the iterable, returning term → id. New terms are
   * sorted before inserting (the UNIQUE index is append-friendly that way);
   * in cold mode they only collect in memory until the next flush.
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
    }
    return ids;
  }

  /**
   * Insert the cold-mode terms not yet flushed — in id order, which is
   * append-only on the rowid b-tree. Called per folder before its cand
   * INSERT so the SQL candidate filter's terms JOIN sees the folder's
   * terms; the UNIQUE term index is only built by the final flush.
   */
  private flushColdDelta(): void {
    if (this.coldDict === null) return;
    const coldDict = this.coldDict;
    const ins = this.db.prepare(
      "INSERT INTO terms(id, term) " +
        "SELECT e.value ->> 0, e.value ->> 1 FROM json_each(?) e",
    );
    const rows: (number | string)[][] = [];
    for (let i = this.coldFlushed; i < this.coldTerms.length; i++) {
      const term = this.coldTerms[i];
      rows.push([coldDict.get(term) as number, term]);
      if (rows.length >= CHUNK) {
        ins.run(JSON.stringify(rows));
        rows.length = 0;
      }
    }
    if (rows.length > 0) ins.run(JSON.stringify(rows));
    this.coldFlushed = this.coldTerms.length;
  }

  /**
   * Persist the cold-mode dictionary (call inside the write transaction):
   * flushes the pending terms, then builds the UNIQUE term index once — a
   * live index during the bulk load would take 1.4M random-order inserts.
   */
  flushColdTerms(): void {
    if (this.coldDict === null) return;
    this.flushColdDelta();
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS terms_term ON terms(term)");
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
  // note/folder deletions, folder row rewrites, ft/cand/headrc rows, the
  // dft adjustments, and the meta update. Every folder's rows commit
  // atomically — a crash can never leave a folder row that claims data
  // which is missing.

  beginWrite(): void {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE");
    this.txOpen = true;
  }

  endWrite(commit: boolean): void {
    if (this.closed || !this.txOpen) return;
    this.txOpen = false;
    this.db.exec(commit ? "COMMIT" : "ROLLBACK");
  }

  /** Drop every row and record the validation keys (whole-store miss). */
  resetData(format: number, ignoreFp: string, templatesFolder: string): void {
    for (const table of [
      "folders",
      "notes",
      "terms",
      "fdir",
      "ft",
      "cand",
      "dft",
      "headrc",
    ]) {
      this.db.exec(`DELETE FROM ${table}`);
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

  /** Record the depth bound dft counts folders under (write txn open). */
  setDfDepth(maxDepth: number): void {
    this.stmts.metaSet.run("df_depth", maxDepth);
  }

  /**
   * Rebuild dft over the stored folders at depth ≤ maxDepth (write txn
   * open) — the run's folder set changed bound. Incremental dft
   * adjustments during this transaction then keep it exact.
   */
  rebuildDft(maxDepth: number): void {
    this.stmts.dftClear.run();
    this.stmts.dftRebuild.run(maxDepth);
    this.setDfDepth(maxDepth);
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

  /** Assign a note's order key (write txn open). */
  noteSetOrd(path: string, ord: number): void {
    this.stmts.noteSetOrd.run(ord, path);
  }

  /** The folder's fdir id, creating the row when missing (write txn open). */
  folderFid(path: string): number {
    const row = this.stmts.fdirEnsure.get(path) as { fid: number };
    return row.fid;
  }

  /**
   * Drop the folder's term rows before a re-aggregation (write txn open):
   * its old term set leaves dft first, then ft/cand/headrc go.
   */
  clearFolderAggregation(fid: number): void {
    this.stmts.dftDecFolder.run(fid);
    this.stmts.dftPrune.run();
    this.stmts.ftDeleteFolder.run(fid);
    this.stmts.candDeleteFolder.run(fid);
    this.stmts.headrcDeleteFolder.run(fid);
  }

  /** Stream one note's record into the folder's ft/headrc rows. */
  streamFolderNote(fid: number, ord: number, rec: StreamedNote): void {
    streamNoteIntoFt(this.stmts, fid, ord, rec);
  }

  /**
   * Fill the folder's cand rows with the SQL candidate filter (write txn
   * open, after every note streamed). Flushes pending cold-interned terms
   * first so the filter's terms JOIN sees them.
   */
  fillFolderCand(fid: number, tokens: Iterable<string>): void {
    this.flushColdDelta();
    const ids = [...this.idsForTerms([...tokens]).values()];
    this.stmts.candFill.run(fid, JSON.stringify(ids));
  }

  /** Add the folder's term set to dft (write txn open, after streaming). */
  bumpFolderDft(fid: number): void {
    this.stmts.dftIncFolder.run(fid);
  }

  /** Insert or replace one folder's aggregate row (write txn open). */
  upsertFolder(
    path: string,
    notes: number,
    tagsJson: string,
    warnJson: string,
  ): void {
    this.stmts.folderUpsert.run(path, notes, tagsJson, warnJson);
  }

  /** Delete one folder and every row attributed to it (write txn open). */
  deleteFolder(folder: string): void {
    const row = this.stmts.fdirGet.get(folder) as { fid: number } | undefined;
    if (row !== undefined) {
      this.clearFolderAggregation(row.fid);
      this.stmts.fdirDelete.run(row.fid);
    }
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

  // ── Read path ─────────────────────────────────────────────────────
  //
  // folderRows lists the folder scalars once; candidates and the collapse
  // term data are read per folder from the row tables — df comes from dft,
  // never from a per-folder scan.

  /** Run the read phase inside one read transaction (consistent snapshot). */
  readSnapshot<T>(fn: () => T): T {
    this.ensureOpen();
    this.db.exec("BEGIN DEFERRED");
    this.txOpen = true;
    try {
      return fn();
    } finally {
      if (!this.closed && this.txOpen) {
        this.txOpen = false;
        this.db.exec("COMMIT");
      }
    }
  }

  /** Every stored folder's row (scalars + fdir id). */
  folderRows(): StoredFolderRow[] {
    this.ensureOpen();
    return this.stmts.folderRows.all() as unknown as StoredFolderRow[];
  }

  /** One folder's (term id, tf) candidate pairs in tf order. */
  folderCandPairs(fid: number): Int32Array {
    this.ensureOpen();
    const rows = this.stmts.candFolder.all(fid) as unknown as {
      tid: number;
      tf: number;
    }[];
    const out = new Int32Array(rows.length * 2);
    for (let i = 0; i < rows.length; i++) {
      out[2 * i] = rows[i].tid;
      out[2 * i + 1] = rows[i].tf;
    }
    return out;
  }

  /** Fill target[tid] = df for every dft row (streaming — the table is
   *  dictionary-sized, so it is never materialised as objects). */
  fillDf(target: Int32Array): void {
    this.ensureOpen();
    for (const row of this.stmts.dftAll.iterate() as Iterable<{
      tid: number;
      n: number;
    }>) {
      target[row.tid] = row.n;
    }
  }

  /** A folder's term ids (its df contribution — the collapse correction). */
  folderTfIds(fid: number): Int32Array {
    const rows = this.stmts.ftFolderTids.all(fid) as unknown as {
      tid: number;
    }[];
    return Int32Array.from(rows, (r) => r.tid);
  }

  /** A folder's (term id, tf) pairs in tf order (collapse merge input). */
  folderTfPairs(fid: number): Int32Array {
    const rows = this.stmts.ftFolderTfPairs.all(fid) as unknown as {
      tid: number;
      tf: number;
    }[];
    const out = new Int32Array(rows.length * 2);
    for (let i = 0; i < rows.length; i++) {
      out[2 * i] = rows[i].tid;
      out[2 * i + 1] = rows[i].tf;
    }
    return out;
  }

  /** A folder's heading-line counts: term id → distinct heading texts. */
  folderHeadCounts(fid: number): Map<number, number> {
    const rows = this.stmts.ftFolderHead.all(fid) as unknown as {
      tid: number;
      lc: number;
    }[];
    return new Map(rows.map((r) => [r.tid, r.lc]));
  }

  /** A folder's heading-only term ids (collapse merge input). */
  folderHeadOnlyIds(fid: number): Set<number> {
    const rows = this.stmts.ftFolderHeadOnly.all(fid) as unknown as {
      tid: number;
    }[];
    return new Set(rows.map((r) => r.tid));
  }

  /**
   * A folder's ordered note data blobs — the lazy source of its bodyTF
   * pairs for the collapse merge (the v1 `full` blob's body section).
   * ord was assigned in JS path-sort order at aggregation time, so the
   * blobs arrive in exactly the order the folder was aggregated.
   */
  folderNoteBodies(path: string): (Uint8Array | null)[] {
    this.ensureOpen();
    const rows = this.stmts.noteBodiesFolder.all(path) as unknown as {
      data: Uint8Array | null;
    }[];
    return rows.map((r) => r.data);
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
    ft: number;
    cand: number;
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
      ft: scalar("SELECT COUNT(*) AS n FROM ft"),
      cand: scalar("SELECT COUNT(*) AS n FROM cand"),
    };
  }

  /** Test-only: the stored metadata of one folder. */
  folderForTests(folder: string):
    | {
        notes: number;
        tags: string[];
        warn: string[];
      }
    | undefined {
    this.ensureOpen();
    const row = this.db
      .prepare("SELECT notes, tags, warn FROM folders WHERE path = ?")
      .get(folder) as { notes: number; tags: string; warn: string } | undefined;
    if (row === undefined) return undefined;
    return {
      notes: row.notes,
      tags: JSON.parse(row.tags) as string[],
      warn: JSON.parse(row.warn) as string[],
    };
  }

  /** Test-only: one note's stored record, or undefined. */
  noteForTests(path: string): StoredNoteRecord | undefined {
    return this.getNote(path);
  }

  /** Test-only: one folder's candidate pairs resolved to term text. */
  folderCandForTests(folder: string): [string, number][] {
    this.ensureOpen();
    const fid = (this.stmts.fdirGet.get(folder) as { fid: number } | undefined)
      ?.fid;
    if (fid === undefined) return [];
    const a = this.folderCandPairs(fid);
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

  /** Test-only: a stored term's flag byte (bit 0 = bigram, bit 1 = self-pair). */
  flagForTests(term: string): number | undefined {
    if (this.termIdForTests(term) === undefined) return undefined;
    return termFlags(term);
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
 * shared-memory WAL cannot mmap); a failed v1→v2 migration skips the second
 * mode (the same data fails identically) and parks the file; on open
 * failure park the file aside (with its -wal/-shm sidecars — an orphaned
 * WAL replays into the fresh database and resurrects the very rows we
 * parked) and repeat once. Returns null when a freshly created database
 * still cannot be opened.
 */
function openDb(sqlite: SqliteModule, dbPath: string): DatabaseSync | null {
  migrationFailed = false;
  for (const mode of ["WAL", "DELETE"] as const) {
    if (migrationFailed) break;
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
      fs.renameSync(
        `${dbPath}${suffix}`,
        `${dbPath}${suffix}.corrupt-${stamp}`,
      );
    } catch {
      // A missing sidecar is fine.
    }
  }
}

/** The store file tests drop to force a cold build. */
export function overviewStoreDbFileForTests(): string {
  return DB_FILE;
}
