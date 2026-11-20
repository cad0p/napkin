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
 * `.napkin/cache/overview-v3.db` — a separate, versioned file name next to
 * the search store's `index-v2.db` (deliberately NOT tables in that
 * database: the two stores have different lifecycles, and a schema bump here
 * must not force a search-index rebuild). The file name changes with every
 * on-disk schema, so napkin versions on different schemas (pi's pinned copy
 * and the CLI, say) each keep their own file instead of parking and
 * rebuilding each other's: schema v1 (#118) lives in `overview-v2.db`,
 * schema v2 (#125) in `overview-v3.db`. It replaces
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
 * When `overview-v3.db` does not exist yet and a schema-v1 `overview-v2.db`
 * with a current meta.format does, the v1 file is migrated WITHOUT being
 * modified: a read-only connection copies it with VACUUM INTO, the copy is
 * migrated (one transaction streams each note's stored blob into ft,
 * refcounts heading texts into headrc/lc, builds cand with the SQL filter
 * and dft with one GROUP BY), and the result is linked into place. A stale
 * format or a failed migration leaves the v1 file alone and the cold path
 * builds `overview-v3.db`; the v1 file stays for older napkin versions.
 *
 * The DB is disposable: open failure, corruption, or a schema-version
 * mismatch renames the file aside and recreates it; a second failure makes
 * `open()` return null so `createOverviewStore` falls back to the JSON
 * folder cache. A BUSY/locked database is never parked — another process
 * holds it and it is healthy — `open()` returns null for this run instead.
 */

type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

const CACHE_DIR = "cache";
const DB_FILE = "overview-v3.db";
/** The schema-v1 store (#118) — the read-only migration source. */
const LEGACY_V1_DB_FILE = "overview-v2.db";
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
// Parameters are plain positional `?` in left-to-right order: Node 22.13's
// node:sqlite cannot bind numbered `?NNN` parameters positionally
// ("column index out of range"), and 22.13 is the engines floor.
const SQL_FT_NH =
  "INSERT INTO ft(fid, tid, w, lc, nord, npos) " +
  "SELECT ?, e.value ->> 0, e.value ->> 1, 0, ?, e.key FROM json_each(?) e " +
  "WHERE true ON CONFLICT(fid, tid) DO UPDATE SET w = w + excluded.w, " +
  "nord = coalesce(nord, excluded.nord), " +
  "npos = CASE WHEN nord IS NULL THEN excluded.npos ELSE npos END";
const SQL_FT_H =
  "INSERT INTO ft(fid, tid, w, lc, hord, hpos) " +
  "SELECT ?, e.value, 0, 0, ?, e.key FROM json_each(?) e " +
  "WHERE true ON CONFLICT(fid, tid) DO UPDATE SET " +
  "hord = coalesce(hord, excluded.hord), " +
  "hpos = CASE WHEN hord IS NULL THEN excluded.hpos ELSE hpos END";
const SQL_HEADRC =
  "INSERT INTO headrc(fid, text, n) VALUES(?, ?, 1) " +
  "ON CONFLICT(fid, text) DO UPDATE SET n = n + 1 RETURNING n";
const SQL_LC =
  "UPDATE ft SET lc = lc + 1 WHERE fid = ? " +
  "AND tid IN (SELECT value FROM json_each(?))";

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
  "WHERE f.fid = ? AND NOT (f.w = 0 AND f.lc < 2) " +
  "AND CASE WHEN instr(t.term, ' ') > 0 " +
  "THEN f.w + (f.lc > 0) * 3 >= 2 AND " +
  "substr(t.term, 1, instr(t.term, ' ') - 1) <> substr(t.term, instr(t.term, ' ') + 1) " +
  "ELSE t.id NOT IN (SELECT value FROM json_each(?)) END";

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
  dftOfIds: StatementSync;
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
  termInsertBulk: StatementSync;
  termIdsAt: StatementSync;
  headrcBulk: StatementSync;
}

function prepareAll(db: DatabaseSync): Stmts {
  return {
    metaGet: db.prepare("SELECT v FROM meta WHERE k = ?"),
    metaSet: db.prepare(
      "INSERT INTO meta(k, v) VALUES(?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ),
    noteMetaAll: db.prepare("SELECT path, folder, mtime, size, ord FROM notes"),
    noteGet: db.prepare(
      "SELECT skip, tags, heads, data FROM notes WHERE path = ?",
    ),
    noteUpsert: db.prepare(
      "INSERT INTO notes(path, folder, mtime, size, skip, tags, heads, data, ord) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET folder = excluded.folder, " +
        "mtime = excluded.mtime, size = excluded.size, " +
        "skip = excluded.skip, tags = excluded.tags, " +
        "heads = excluded.heads, data = excluded.data, ord = excluded.ord",
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
    dftOfIds: db.prepare(
      "SELECT tid, n FROM dft WHERE tid IN (SELECT value FROM json_each(?))",
    ),
    dftDecFolder: db.prepare(
      "UPDATE dft SET n = n - 1 WHERE tid IN " +
        "(SELECT tid FROM ft WHERE fid = ?)",
    ),
    dftIncFolder: db.prepare(
      "INSERT INTO dft(tid, n) SELECT tid, 1 FROM ft WHERE fid = ? " +
        "ON CONFLICT(tid) DO UPDATE SET n = n + 1",
    ),
    // Targeted: only the folder's own term ids can have dropped to zero —
    // a whole-table scan would walk the dictionary-sized dft on every miss.
    dftPrune: db.prepare(
      "DELETE FROM dft WHERE n <= 0 AND tid IN " +
        "(SELECT tid FROM ft WHERE fid = ?)",
    ),
    dftAll: db.prepare("SELECT tid, n FROM dft"),
    dftClear: db.prepare("DELETE FROM dft"),
    dftRebuild: db.prepare(
      "INSERT INTO dft(tid, n) SELECT f.tid, COUNT(*) FROM ft f " +
        "JOIN fdir d ON d.fid = f.fid WHERE " +
        SQL_FOLDER_DEPTH +
        " <= ? GROUP BY f.tid",
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
    termIdsAt: db.prepare(
      "SELECT e.key AS k, t.id FROM json_each(?) e " +
        "JOIN terms t ON t.term = e.value",
    ),
    headrcBulk: db.prepare(
      "INSERT INTO headrc(fid, text, n) " +
        "SELECT ?, e.value ->> 0, e.value ->> 1 FROM json_each(?) e",
    ),
    // Consecutive ids from the bound start, in the JSON array's order.
    termInsertBulk: db.prepare(
      "INSERT INTO terms(id, term) SELECT ? + e.key, e.value FROM json_each(?) e",
    ),
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
  /** Order key within the folder (JS path-sort order); null only for a
   *  row written before its folder's aggregation assigned one. */
  ord: number | null;
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

/** Cold-build Bloom filter size: 2^24 bits (2 MB); with 4 probes about
 *  0.7% false positives at 1.45M terms, degrading gracefully beyond. */
const COLD_FILTER_BITS = 1 << 24;
let coldFilterBits = COLD_FILTER_BITS;

/** Test seam: the cold Bloom filter's size in bits (a power of two ≥ 32);
 *  no argument restores the default. */
export function setOverviewColdFilterBitsForTests(
  bits = COLD_FILTER_BITS,
): void {
  coldFilterBits = bits;
}

/** Test seam: the cold Bloom filter's primitives. */
export const coldFilterForTests = {
  create: (bits: number): Uint32Array => new Uint32Array(bits >>> 5),
  add: (f: Uint32Array, term: string): void => filterAdd(f, term),
  has: (f: Uint32Array, term: string): boolean => filterHas(f, term),
};

/** termHash's second hash (an out-parameter, so hashing allocates nothing). */
let termHash2 = 0;

/** Two 32-bit string hashes — FNV-1a (returned) and a multiplicative
 *  variant (termHash2, odd) — for double hashing. */
function termHash(term: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < term.length; i++) {
    const c = term.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  termHash2 = h2 | 1;
  return h1;
}

function filterHas(bits: Uint32Array, term: string): boolean {
  const h1 = termHash(term);
  const mask = bits.length * 32 - 1;
  for (let i = 0; i < 4; i++) {
    const b = (h1 + Math.imul(i, termHash2)) & mask;
    if ((bits[b >>> 5] & (1 << (b & 31))) === 0) return false;
  }
  return true;
}

function filterAdd(bits: Uint32Array, term: string): void {
  const h1 = termHash(term);
  const mask = bits.length * 32 - 1;
  for (let i = 0; i < 4; i++) {
    const b = (h1 + Math.imul(i, termHash2)) & mask;
    bits[b >>> 5] |= 1 << (b & 31);
  }
}

/** ft rows per multi-row INSERT of a whole-folder write (8 params each). */
const FT_BULK_ROWS = 256;

/**
 * One whole folder's ft/headrc rows aggregated in JS (#131) — the same rows
 * streamNoteIntoFt's per-note upserts produce, without a SQL round trip per
 * note. Notes are added in folder path order (note index i ↔ ord
 * (i + 1)·ORD_GAP), so "first seen" is simply the first add:
 *
 *   w          sum of the non-heading weighted counts
 *   nord/npos  first note and position (index in its non-heading list)
 *   hord/hpos  first note and position (index in its distinct heading ids)
 *   lc         distinct heading texts containing the term (a text counts
 *              for its ids on its first occurrence in the folder)
 *   headrc     heading text → number of notes carrying it
 *
 * Memory is per folder: parallel typed columns sized by the folder's
 * distinct terms (grown by doubling), plus one tid → slot index sized by
 * the dictionary's max id. The index is shared across folders and cleared
 * entry by entry on drain, so a cold build never holds more than one
 * folder's rows in JS.
 */
export class FolderRowsBuilder {
  private slot = new Int32Array(0);
  private n = 0;
  private tid = new Int32Array(1024);
  private w = new Int32Array(1024);
  private lc = new Int32Array(1024);
  private nNote = new Int32Array(1024);
  private nPos = new Int32Array(1024);
  private hNote = new Int32Array(1024);
  private hPos = new Int32Array(1024);
  private heads = new Map<string, number>();

  /** Slot of a term id in the folder's columns, created on first sight. */
  private at(id: number): number {
    if (id >= this.slot.length) {
      const grown = new Int32Array(
        Math.max(id + 1, Math.ceil(this.slot.length * 1.5)),
      );
      grown.set(this.slot);
      this.slot = grown;
    }
    const s = this.slot[id];
    if (s !== 0) return s - 1;
    if (this.n === this.tid.length) this.grow();
    const i = this.n++;
    this.slot[id] = i + 1;
    this.tid[i] = id;
    this.w[i] = 0;
    this.lc[i] = 0;
    this.nNote[i] = -1;
    this.nPos[i] = 0;
    this.hNote[i] = -1;
    this.hPos[i] = 0;
    return i;
  }

  private grow(): void {
    const cap = this.tid.length * 2;
    const more = (a: Int32Array): Int32Array<ArrayBuffer> => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.tid = more(this.tid);
    this.w = more(this.w);
    this.lc = more(this.lc);
    this.nNote = more(this.nNote);
    this.nPos = more(this.nPos);
    this.hNote = more(this.hNote);
    this.hPos = more(this.hPos);
  }

  /** Add the folder's note at index noteIndex (path order). */
  add(noteIndex: number, rec: StreamedNote): void {
    if (rec.skip || rec.data === null) return;
    const a = rec.data;
    const nn = a[0];
    for (let k = 0, p = 1; k < nn; k++, p += 2) {
      const i = this.at(a[p]);
      this.w[i] += a[p + 1];
      if (this.nNote[i] < 0) {
        this.nNote[i] = noteIndex;
        this.nPos[i] = k;
      }
    }
    // Distinct heading-seen ids in first-seen order: position = rank among
    // them (streamNoteIntoFt's hIds index).
    let pos = 0;
    const seen = new Set<number>();
    for (const [, ids] of rec.heads) {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const i = this.at(id);
        if (this.hNote[i] < 0) {
          this.hNote[i] = noteIndex;
          this.hPos[i] = pos;
        }
        pos++;
      }
    }
    for (const [text, ids] of rec.heads) {
      const n = (this.heads.get(text) ?? 0) + 1;
      this.heads.set(text, n);
      if (n === 1) {
        for (const id of ids) this.lc[this.at(id)]++;
      }
    }
  }

  /**
   * Emit every row as [fid, tid, w, lc, nord, npos, hord, hpos] in tid
   * order, then reset the folder state (the slot index is cleared entry by
   * entry; the columns drop back to their initial size).
   */
  drain(fid: number, emit: (row: (number | null)[]) => void): void {
    const order = this.tid.slice(0, this.n).sort();
    const row: (number | null)[] = [fid, 0, 0, 0, null, null, null, null];
    for (let k = 0; k < order.length; k++) {
      const id = order[k];
      const i = this.slot[id] - 1;
      this.slot[id] = 0;
      row[1] = id;
      row[2] = this.w[i];
      row[3] = this.lc[i];
      const nn = this.nNote[i];
      row[4] = nn < 0 ? null : (nn + 1) * ORD_GAP;
      row[5] = nn < 0 ? null : this.nPos[i];
      const hn = this.hNote[i];
      row[6] = hn < 0 ? null : (hn + 1) * ORD_GAP;
      row[7] = hn < 0 ? null : this.hPos[i];
      emit(row);
    }
    this.n = 0;
    if (this.tid.length > 1024) {
      this.tid = new Int32Array(1024);
      this.w = new Int32Array(1024);
      this.lc = new Int32Array(1024);
      this.nNote = new Int32Array(1024);
      this.nPos = new Int32Array(1024);
      this.hNote = new Int32Array(1024);
      this.hPos = new Int32Array(1024);
    }
  }

  /** The folder's [heading text, note count] pairs; clears them. */
  takeHeadings(): [string, number][] {
    const out = [...this.heads];
    this.heads = new Map();
    return out;
  }
}

/**
 * One note's term lists in the shape the per-note delta consumes (#126):
 * non-heading ids with their weighted counts (position = index), the
 * distinct heading-seen ids in first-seen order (position = index) — the
 * exact positions streamNoteIntoFt stores as npos/hpos — and the
 * per-unique-heading-text term lists that drive headrc.
 */
interface NoteLists {
  nh: number[];
  nhc: number[];
  h: number[];
  texts: [string, number[]][];
}

const EMPTY_LISTS: NoteLists = { nh: [], nhc: [], h: [], texts: [] };

function noteLists(rec: StreamedNote | null): NoteLists {
  if (rec === null || rec.skip || rec.data === null) return EMPTY_LISTS;
  const a = rec.data;
  const nn = a[0];
  const nh: number[] = [];
  const nhc: number[] = [];
  for (let k = 0, p = 1; k < nn; k++, p += 2) {
    nh.push(a[p]);
    nhc.push(a[p + 1]);
  }
  const seen = new Set<number>();
  const h: number[] = [];
  for (const [, ids] of rec.heads) {
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        h.push(id);
      }
    }
  }
  return { nh, nhc, h, texts: rec.heads };
}

/** One ft row as the delta reads and rewrites it. */
interface FtRow {
  w: number;
  lc: number;
  nord: number | null;
  npos: number | null;
  hord: number | null;
  hpos: number | null;
}

const EMPTY_ROW: FtRow = {
  w: 0,
  lc: 0,
  nord: null,
  npos: null,
  hord: null,
  hpos: null,
};

/** Statements only a per-note delta needs — prepared on first use so the
 *  open (and the hit path) pays nothing for them. */
interface DeltaStmts {
  ftGet: StatementSync;
  ftPut: StatementSync;
  ftDel: StatementSync;
  candDel: StatementSync;
  candFill: StatementSync;
  dftInc: StatementSync;
  dftDec: StatementSync;
  dftZero: StatementSync;
  headrcInc: StatementSync;
  headrcDec: StatementSync;
  headrcDel: StatementSync;
  later: StatementSync;
  summaries: StatementSync;
  ords: StatementSync;
}

function prepareDelta(db: DatabaseSync): DeltaStmts {
  return {
    ftGet: db.prepare(
      "SELECT tid, w, lc, nord, npos, hord, hpos FROM ft " +
        "WHERE fid = ? AND tid IN (SELECT value FROM json_each(?))",
    ),
    ftPut: db.prepare(
      "INSERT INTO ft(fid, tid, w, lc, nord, npos, hord, hpos) " +
        "SELECT ?, e.value ->> 0, e.value ->> 1, e.value ->> 2, " +
        "e.value ->> 3, e.value ->> 4, e.value ->> 5, e.value ->> 6 " +
        "FROM json_each(?) e WHERE true ON CONFLICT(fid, tid) DO UPDATE " +
        "SET w = excluded.w, lc = excluded.lc, nord = excluded.nord, " +
        "npos = excluded.npos, hord = excluded.hord, hpos = excluded.hpos",
    ),
    ftDel: db.prepare(
      "DELETE FROM ft WHERE fid = ? " +
        "AND tid IN (SELECT value FROM json_each(?))",
    ),
    candDel: db.prepare(
      "DELETE FROM cand WHERE fid = ? " +
        "AND tid IN (SELECT value FROM json_each(?))",
    ),
    candFill: db.prepare(
      `${SQL_CAND} AND f.tid IN (SELECT value FROM json_each(?))`,
    ),
    dftInc: db.prepare(
      "INSERT INTO dft(tid, n) SELECT value, 1 FROM json_each(?) WHERE true " +
        "ON CONFLICT(tid) DO UPDATE SET n = n + 1",
    ),
    dftDec: db.prepare(
      "UPDATE dft SET n = n - 1 WHERE tid IN (SELECT value FROM json_each(?))",
    ),
    dftZero: db.prepare(
      "DELETE FROM dft WHERE n <= 0 " +
        "AND tid IN (SELECT value FROM json_each(?))",
    ),
    headrcInc: db.prepare(SQL_HEADRC),
    headrcDec: db.prepare(
      "UPDATE headrc SET n = n - 1 WHERE fid = ? AND text = ? RETURNING n",
    ),
    headrcDel: db.prepare(
      "DELETE FROM headrc WHERE fid = ? AND text = ? AND n <= 0",
    ),
    later: db.prepare(
      "SELECT ord, skip, heads, data FROM notes " +
        "WHERE folder = ? AND ord > ? ORDER BY ord",
    ),
    summaries: db.prepare(
      "SELECT path, skip, tags FROM notes WHERE folder = ?",
    ),
    ords: db.prepare("SELECT path, ord FROM notes WHERE folder = ?"),
  };
}

/** Run fn over arr in size-element JSON batches (json_each bulk calls). */
function inChunks<T>(arr: T[], size: number, fn: (json: string) => void): void {
  for (let i = 0; i < arr.length; i += size) {
    fn(JSON.stringify(arr.slice(i, i + size)));
  }
}

/** Why the last tryOpen failed, so a reopen failure can say corrupt vs busy. */
let lastOpenError = "";
/** Set when the last tryOpen failed because another connection holds the
 *  database (BUSY/LOCKED): the file is healthy, so it must not be parked. */
let openBusy = false;

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), including extended codes. */
function isBusyError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number") {
    const primary = code & 0xff;
    if (primary === 5 || primary === 6) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(
    message,
  );
}

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
 * Runs on a private copy of the v1 file (see migrateLegacyStore); any
 * failure discards the copy and the caller takes the cold path.
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
    // the migration loudly so the copy is discarded, not half-dropped.
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
      // Rollback best-effort: the copy is discarded either way.
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
    if (version !== 0 && version !== SCHEMA_VERSION) {
      // A versioned file name covers cross-version skew; a nonzero, different
      // user_version means a same-name schema we cannot read — rebuild.
      throw new Error(
        `overview schema version ${version}, expected ${SCHEMA_VERSION}`,
      );
    }
    db.exec(SCHEMA_DDL);
    // Only a fresh file needs the version written: the pragma takes the
    // write lock, and a live writer elsewhere must not make a healthy,
    // current file look unusable.
    if (version === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
    openBusy = isBusyError(error);
    try {
      db?.close();
    } catch {
      // Nothing to close cleanly.
    }
    return null;
  }
}

/** A stale migration copy older than this belongs to a crashed process. */
const STALE_MIGRATION_MS = 60 * 60 * 1000;

/**
 * Build `dbPath` (schema v2) from the schema-v1 file at `legacyPath`
 * without modifying it (#125): a read-only connection VACUUMs it INTO a
 * private copy (committed WAL frames included), the copy is migrated with
 * no journal (a failure discards it anyway), switched to WAL, and linked
 * into place — never over an existing file, so a concurrent process that
 * won the race keeps its store.
 *
 * "busy" when the v1 file is locked (the caller falls back for this run
 * and retries next run); "none" when there is nothing to migrate or the
 * migration failed (the cold path builds dbPath; the v1 file is untouched).
 */
function migrateLegacyStore(
  sqlite: SqliteModule,
  legacyPath: string,
  dbPath: string,
): "done" | "busy" | "none" {
  if (fs.existsSync(dbPath) || !fs.existsSync(legacyPath)) return "none";
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.migrating-`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_MIGRATION_MS) {
        fs.rmSync(file, { force: true });
      }
    }
  } catch {
    // Sweeping a crashed run's leftovers is best-effort.
  }
  const tmp = `${dbPath}.migrating-${process.pid}`;
  const dropTmp = (): void => {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(`${tmp}${suffix}`, { force: true });
    }
  };
  let src: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  try {
    dropTmp();
    src = new sqlite.DatabaseSync(legacyPath, {
      readOnly: true,
      timeout: busyTimeoutMs,
    });
    const version = (
      src.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version !== 1) return "none";
    const format = (
      src.prepare("SELECT v FROM meta WHERE k = 'format'").get() as
        | { v: unknown }
        | undefined
    )?.v;
    if (format !== OVERVIEW_CACHE_VERSION) return "none";
    src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    src.close();
    src = undefined;
    db = new sqlite.DatabaseSync(tmp);
    db.exec("PRAGMA journal_mode = OFF");
    db.exec("PRAGMA synchronous = OFF");
    migrateV1ToV2(db);
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
    db = undefined;
    try {
      // link() refuses to replace an existing file: a store another
      // process created meanwhile (and may hold open) is never clobbered.
      fs.linkSync(tmp, dbPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && !fs.existsSync(dbPath)) {
        // No hard links on this filesystem: rename (still checked above).
        fs.renameSync(tmp, dbPath);
      }
    }
    return fs.existsSync(dbPath) ? "done" : "none";
  } catch (error) {
    lastOpenError = error instanceof Error ? error.message : String(error);
    return isBusyError(error) ? "busy" : "none";
  } finally {
    for (const conn of [src, db]) {
      try {
        conn?.close();
      } catch {
        // Already closed or broken: the copy is dropped below.
      }
    }
    try {
      dropTmp();
    } catch {
      // A leftover copy is swept by a later run.
    }
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
  /** Whether the cold-build pragmas are in force (see beginColdBuild). */
  private cold = false;
  /**
   * Cold build only: a Bloom filter (2 MB, no strings) over every term this
   * build interned. The dictionary started empty, so a term the filter has
   * never seen is certainly new and skips its SQL lookup — about half of a
   * cold build's lookups. A false positive only costs a lookup that misses.
   */
  private coldSeen: Uint32Array | null = null;
  /** terms(term) index known to exist on this connection (#131). */
  private termIndexReady = false;
  /** Bulk ft insert statements, prepared on first whole-folder write. */
  private ftBulk: { many: StatementSync; one: StatementSync } | null = null;
  /** Per-note delta statements, prepared on first use (see prepareDelta). */
  private deltaStmts: DeltaStmts | null = null;
  /** The SQL top-k statement over this connection's temp scoring tables. */
  private topStmt: StatementSync | null = null;

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
      this.deltaStmts = null;
      this.topStmt = null;
      this.ftBulk = null;
      this.closed = false;
      return;
    }
    throw new Error(`cannot reopen overview store: ${lastOpenError}`);
  }

  private closeDb(): void {
    if (this.closed) return;
    this.closed = true;
    this.maxId = -1;
    this.deltaStmts = null;
    this.topStmt = null;
    this.ftBulk = null;
    this.cold = false;
    this.coldSeen = null;
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

    // First run on the v2 schema: migrate from the v1 file, leaving it for
    // older napkin versions. A locked v1 file means this run falls back.
    if (
      migrateLegacyStore(sqlite, path.join(dir, LEGACY_V1_DB_FILE), dbPath) ===
      "busy"
    ) {
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
   * Cold-build mode (#131), inside the write transaction right after
   * resetData: the whole store is rebuilt folder by folder in batches, and
   * every batch interns through SQL — there is no in-memory dictionary, so
   * the UNIQUE term index must exist while the terms load (the table is
   * empty here, so creating it is free). The page cache is raised to 16 MB
   * for this transaction only: the measured optimum for bulk row loads
   * (r3 migrate2: 11 s at 16 MB vs 15 s at 2 MB, and a larger cache only
   * adds RSS). endColdBuild restores the 2 MB default.
   */
  beginColdBuild(): void {
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS terms_term ON terms(term)");
    this.db.exec("PRAGMA cache_size = -16384");
    this.cold = true;
    this.coldSeen = new Uint32Array(coldFilterBits >>> 5);
  }

  /** Leave cold-build mode (after commit or rollback). */
  endColdBuild(): void {
    this.coldSeen = null;
    if (!this.cold || this.closed) return;
    this.cold = false;
    this.db.exec("PRAGMA cache_size = -2048");
  }

  /**
   * Intern every term in the iterable, returning term → id. One json_each
   * lookup per CHUNK terms; the missing terms are inserted sorted (the
   * UNIQUE index is append-friendlier that way) with json_each bulk
   * inserts, taking consecutive ids after the high-water mark.
   */
  intern(terms: Iterable<string>): Map<string, number> {
    const list = [...new Set(terms)];
    const g = this.internList(list);
    const ids = new Map<string, number>();
    for (let k = 0; k < list.length; k++) ids.set(list[k], g[k]);
    return ids;
  }

  /**
   * Intern a list of distinct terms, returning their ids aligned with the
   * list (the batch interning of a whole-folder build, #131). Lookups
   * return (array index, id) pairs — the term text never crosses back, so
   * they allocate no strings.
   */
  internList(list: string[]): Int32Array {
    this.ensureOpen();
    // The json_each lookup joins on terms(term): without the index it is a
    // full dictionary scan per looked-up term (minutes on a 1.45M-term
    // dictionary). Every store written since #120 has it, but a file from
    // anywhere else must not silently turn each miss into that scan.
    if (!this.termIndexReady) {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS terms_term ON terms(term)",
      );
      this.termIndexReady = true;
    }
    // A store opened in this process may never have read the dictionary's
    // high-water mark (only a wipe or maxTermId() sets it): new ids must
    // continue after MAX(id), never restart at 0.
    this.maxTermId();
    const g = new Int32Array(list.length).fill(-1);
    const seen = this.coldSeen;
    // Indices of the terms that may already be interned: all of them,
    // unless the cold filter rules some out.
    let probe: number[] | null = null;
    if (seen !== null) {
      probe = [];
      for (let k = 0; k < list.length; k++) {
        if (filterHas(seen, list[k])) probe.push(k);
      }
    }
    const nProbe = probe === null ? list.length : probe.length;
    for (let i = 0; i < nProbe; i += CHUNK) {
      const end = Math.min(i + CHUNK, nProbe);
      const part: string[] = [];
      for (let j = i; j < end; j++) {
        part.push(list[probe === null ? j : probe[j]]);
      }
      const rows = this.stmts.termIdsAt.all(
        JSON.stringify(part),
      ) as unknown as { k: number; id: number }[];
      for (const row of rows) {
        const j = i + row.k;
        g[probe === null ? j : probe[j]] = row.id;
      }
    }
    const missing: number[] = [];
    for (let k = 0; k < list.length; k++) if (g[k] < 0) missing.push(k);
    if (missing.length === 0) return g;
    if (seen !== null) for (const k of missing) filterAdd(seen, list[k]);
    missing.sort((a, b) =>
      list[a] < list[b] ? -1 : list[a] > list[b] ? 1 : 0,
    );
    // The list is meant to be distinct; a repeated term must still get one
    // id, not a second insert that fails the UNIQUE index and rolls the run
    // back into the JSON fallback.
    const unique: string[] = [];
    const first = this.maxId + 1;
    for (let j = 0; j < missing.length; j++) {
      const term = list[missing[j]];
      if (unique.length === 0 || unique[unique.length - 1] !== term) {
        unique.push(term);
      }
      g[missing[j]] = first + unique.length - 1;
    }
    for (let i = 0; i < unique.length; i += CHUNK) {
      this.stmts.termInsertBulk.run(
        first + i,
        JSON.stringify(unique.slice(i, i + CHUNK)),
      );
    }
    this.maxId += unique.length;
    return g;
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
    // Another process may have interned terms since the high-water mark was
    // read: re-read it under the write lock.
    this.maxId = -1;
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
    ord: number | null = null,
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
      ord,
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
    this.stmts.dftPrune.run(fid);
    this.stmts.ftDeleteFolder.run(fid);
    this.stmts.candDeleteFolder.run(fid);
    this.stmts.headrcDeleteFolder.run(fid);
  }

  /**
   * Write one whole folder's aggregated rows (#131, write txn open, the
   * folder's previous rows cleared): ft in (fid, tid) order with multi-row
   * VALUES — appends on the WITHOUT ROWID primary key — then headrc, then
   * cand with the SQL filter. dft is the caller's: bumpFolderDft on a miss,
   * one rebuildDft at the end of a cold build. Resets the builder.
   */
  writeFolderRows(
    fid: number,
    rows: FolderRowsBuilder,
    tokens: string[],
  ): void {
    if (this.ftBulk === null) {
      const values = Array(FT_BULK_ROWS).fill("(?,?,?,?,?,?,?,?)").join(",");
      this.ftBulk = {
        many: this.db.prepare(
          `INSERT INTO ft(fid, tid, w, lc, nord, npos, hord, hpos) VALUES ${values}`,
        ),
        one: this.db.prepare(
          "INSERT INTO ft(fid, tid, w, lc, nord, npos, hord, hpos) " +
            "VALUES (?,?,?,?,?,?,?,?)",
        ),
      };
    }
    const bulk = this.ftBulk;
    const params: (number | null)[] = [];
    rows.drain(fid, (row) => {
      for (const v of row) params.push(v);
      if (params.length === FT_BULK_ROWS * 8) {
        bulk.many.run(...params);
        params.length = 0;
      }
    });
    for (let i = 0; i < params.length; i += 8) {
      bulk.one.run(...params.slice(i, i + 8));
    }
    const heads = rows.takeHeadings();
    for (let i = 0; i < heads.length; i += CHUNK) {
      this.stmts.headrcBulk.run(fid, JSON.stringify(heads.slice(i, i + CHUNK)));
    }
    this.fillFolderCand(fid, tokens);
  }

  private delta(): DeltaStmts {
    this.ensureOpen();
    if (this.deltaStmts === null) this.deltaStmts = prepareDelta(this.db);
    return this.deltaStmts;
  }

  /**
   * Apply one note's change to its folder's rows (#126, write txn open):
   * oldRec is the record the rows currently reflect (null for an added
   * note), newRec the record that replaces it (null for a deleted note).
   * The notes table must already hold the post-change state for this note
   * (row upserted or deleted) and every other note of the folder must be
   * what the rows reflect — the orphan scan reads the later notes.
   *
   * Only the touched term ids — the old record's ∪ the new record's — are
   * read and rewritten:
   *   - w moves by the count difference; lc moves through headrc: a heading
   *     text whose refcount goes 0→1 adds one to each of its ids' lc, 1→0
   *     subtracts one;
   *   - first-seen keys: a term the new record contains takes this note's
   *     (ord, pos) when its key is NULL or not earlier than ord; a term
   *     whose first occurrence WAS this note and that this note no longer
   *     contains, but the folder still does (w > 0 / lc > 0), is an orphan —
   *     the later notes are streamed in ord order until every orphan has
   *     its new first occurrence;
   *   - rows reaching w = lc = 0 are deleted, cand rows are rebuilt for the
   *     touched ids only, and dft moves ±1 for each row created or removed
   *     (when countDf: the folder is inside dft's depth bound).
   *
   * Returns the number of later notes the orphan scan read.
   */
  applyNoteDelta(
    fid: number,
    folder: string,
    ord: number,
    oldRec: StreamedNote | null,
    newRec: StreamedNote | null,
    tokenIds: number[],
    countDf: boolean,
  ): number {
    const q = this.delta();
    const O = noteLists(oldRec);
    const N = noteLists(newRec);
    interface Touch {
      dW: number;
      dLc: number;
      row: FtRow | null;
      next: FtRow;
    }
    const st = new Map<number, Touch>();
    const touch = (id: number): Touch => {
      let t = st.get(id);
      if (t === undefined) {
        t = { dW: 0, dLc: 0, row: null, next: EMPTY_ROW };
        st.set(id, t);
      }
      return t;
    };
    for (let i = 0; i < O.nh.length; i++) touch(O.nh[i]).dW -= O.nhc[i];
    for (let i = 0; i < N.nh.length; i++) touch(N.nh[i]).dW += N.nhc[i];
    for (const id of O.h) touch(id);
    for (const id of N.h) touch(id);
    // Heading refcounts: release the old texts first, then take the new —
    // a text kept by the edit goes 1→0→1 and nets to zero.
    for (const [text, ids] of O.texts) {
      const row = q.headrcDec.get(fid, text) as { n: number } | undefined;
      if (row !== undefined && row.n <= 0) {
        q.headrcDel.run(fid, text);
        for (const id of ids) touch(id).dLc--;
      }
    }
    for (const [text, ids] of N.texts) {
      const row = q.headrcInc.get(fid, text) as { n: number };
      if (row.n === 1) for (const id of ids) touch(id).dLc++;
    }
    const ids = [...st.keys()];
    inChunks(ids, CHUNK, (json) => {
      for (const r of q.ftGet.all(fid, json) as unknown as (FtRow & {
        tid: number;
      })[]) {
        (st.get(r.tid) as Touch).row = r;
      }
    });

    const nPos = new Map<number, number>();
    for (let i = 0; i < N.nh.length; i++) nPos.set(N.nh[i], i);
    const hPos = new Map<number, number>();
    for (let i = 0; i < N.h.length; i++) hPos.set(N.h[i], i);
    const nhOrphans = new Set<number>();
    const hOrphans = new Set<number>();
    for (const [id, t] of st) {
      const r = t.row ?? EMPTY_ROW;
      const w = r.w + t.dW;
      const lc = r.lc + t.dLc;
      let { nord, npos, hord, hpos } = r;
      const pn = nPos.get(id);
      if (pn !== undefined) {
        if (nord === null || nord >= ord) {
          nord = ord;
          npos = pn;
        }
      } else if (nord === ord) {
        if (w > 0) nhOrphans.add(id);
        nord = null;
        npos = null;
      }
      if (w === 0) {
        nord = null;
        npos = null;
      }
      const ph = hPos.get(id);
      if (ph !== undefined) {
        if (hord === null || hord >= ord) {
          hord = ord;
          hpos = ph;
        }
      } else if (hord === ord) {
        if (lc > 0) hOrphans.add(id);
        hord = null;
        hpos = null;
      }
      if (lc === 0) {
        hord = null;
        hpos = null;
      }
      t.next = { w, lc, nord, npos, hord, hpos };
    }

    // Orphan scan: the later notes in ord order, one blob at a time, until
    // every orphaned first occurrence is placed.
    let scanned = 0;
    if (nhOrphans.size > 0 || hOrphans.size > 0) {
      for (const row of q.later.iterate(folder, ord) as Iterable<{
        ord: number;
        skip: number;
        heads: string;
        data: Uint8Array | null;
      }>) {
        scanned++;
        const L = noteLists(
          decodeStoredNote({
            skip: row.skip,
            tags: "[]",
            heads: hOrphans.size > 0 ? row.heads : "[]",
            data: row.data,
          }),
        );
        if (nhOrphans.size > 0) {
          for (let i = 0; i < L.nh.length; i++) {
            const id = L.nh[i];
            if (nhOrphans.delete(id)) {
              const n = (st.get(id) as Touch).next;
              n.nord = row.ord;
              n.npos = i;
            }
          }
        }
        if (hOrphans.size > 0) {
          for (let i = 0; i < L.h.length; i++) {
            const id = L.h[i];
            if (hOrphans.delete(id)) {
              const n = (st.get(id) as Touch).next;
              n.hord = row.ord;
              n.hpos = i;
            }
          }
        }
        if (nhOrphans.size === 0 && hOrphans.size === 0) break;
      }
      if (nhOrphans.size > 0 || hOrphans.size > 0) {
        throw new Error(
          `overview rows inconsistent: ${nhOrphans.size + hOrphans.size} orphaned terms in ${folder} have no later occurrence`,
        );
      }
    }

    const put: (number | null)[][] = [];
    const created: number[] = [];
    const removed: number[] = [];
    for (const [id, t] of st) {
      const n = t.next;
      if (n.w === 0 && n.lc === 0) {
        if (t.row !== null) removed.push(id);
        continue;
      }
      if (t.row === null) created.push(id);
      put.push([id, n.w, n.lc, n.nord, n.npos, n.hord, n.hpos]);
    }
    inChunks(ids, CHUNK, (json) => q.candDel.run(fid, json));
    inChunks(removed, CHUNK, (json) => q.ftDel.run(fid, json));
    inChunks(put, 2000, (json) => q.ftPut.run(fid, json));
    const tok = JSON.stringify(tokenIds);
    inChunks(ids, CHUNK, (json) => q.candFill.run(fid, tok, json));
    if (countDf) {
      inChunks(created, CHUNK, (json) => q.dftInc.run(json));
      inChunks(removed, CHUNK, (json) => {
        q.dftDec.run(json);
        q.dftZero.run(json);
      });
    }
    return scanned;
  }

  /**
   * Renumber a folder's order keys to (i+1)·ORD_GAP in their current order
   * (write txn open) — the midpoint inserts ran out of gap. ord order IS the
   * JS path order, so a row_number over ord keeps the order; the first-seen
   * keys in ft (nord, hord) and cand.o1 are remapped through the same map.
   * Returns the folder's new path → ord map.
   */
  renumberFolder(fid: number, folder: string): Map<string, number> {
    const q = this.delta();
    this.db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS ordmap(o INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
    );
    this.db.exec("DELETE FROM temp.ordmap");
    this.db
      .prepare(
        "INSERT INTO temp.ordmap(o, n) SELECT ord, " +
          "row_number() OVER (ORDER BY ord) * ? FROM notes " +
          "WHERE folder = ? AND ord IS NOT NULL",
      )
      .run(ORD_GAP, folder);
    this.db
      .prepare(
        "UPDATE ft SET " +
          "nord = (SELECT n FROM temp.ordmap WHERE o = ft.nord), " +
          "hord = (SELECT n FROM temp.ordmap WHERE o = ft.hord) " +
          "WHERE fid = ?",
      )
      .run(fid);
    this.db
      .prepare(
        "UPDATE cand SET o1 = (SELECT n FROM temp.ordmap WHERE o = cand.o1) " +
          "WHERE fid = ?",
      )
      .run(fid);
    this.db
      .prepare(
        "UPDATE notes SET ord = (SELECT n FROM temp.ordmap WHERE o = notes.ord) " +
          "WHERE folder = ?",
      )
      .run(folder);
    this.db.exec("DELETE FROM temp.ordmap");
    const out = new Map<string, number>();
    for (const r of q.ords.all(folder) as unknown as {
      path: string;
      ord: number;
    }[]) {
      out.set(r.path, r.ord);
    }
    return out;
  }

  /** A folder's notes' (path, skip, tags) — the folder row's tags/warn
   *  are recomputed from these after a delta (no term data read). */
  folderNoteSummaries(
    folder: string,
  ): { path: string; skip: number; tags: string }[] {
    return this.delta().summaries.all(folder) as unknown as {
      path: string;
      skip: number;
      tags: string;
    }[];
  }

  /**
   * Fill the folder's cand rows with the SQL candidate filter (write txn
   * open, after the folder's ft rows are written).
   */
  fillFolderCand(fid: number, tokens: Iterable<string>): void {
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

  /**
   * Set up the SQL top-k scoring tables for this read phase (#126):
   * temp.idf(df → log(1 + totalFolders / df)) with the logs computed in V8
   * — SQLite's ln() may differ from V8's by an ULP, the bound double does
   * not — over every df value a candidate can have (1 … stored folder
   * count + mergedCount, the most a collapse merge can add), and
   * temp.dfadj with the collapse correction (empty when nothing collapsed).
   */
  prepareScoring(
    totalFolders: number,
    mergedCount: number,
    dfDelta: Map<number, number>,
  ): void {
    this.ensureOpen();
    this.db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS idf(df INTEGER PRIMARY KEY, v REAL NOT NULL)",
    );
    this.db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS dfadj(tid INTEGER PRIMARY KEY, d INTEGER NOT NULL)",
    );
    this.db.exec("DELETE FROM temp.idf");
    this.db.exec("DELETE FROM temp.dfadj");
    const folders = (
      this.db.prepare("SELECT count(*) AS n FROM fdir").get() as { n: number }
    ).n;
    const ins = this.db.prepare("INSERT INTO temp.idf(df, v) VALUES(?, ?)");
    for (let df = 1; df <= folders + mergedCount + 1; df++) {
      ins.run(df, Math.log(1 + totalFolders / df));
    }
    const adj: number[][] = [];
    for (const [tid, d] of dfDelta) if (d !== 0) adj.push([tid, d]);
    const insAdj = this.db.prepare(
      "INSERT INTO temp.dfadj(tid, d) " +
        "SELECT e.value ->> 0, e.value ->> 1 FROM json_each(?) e",
    );
    inChunks(adj, CHUNK, (json) => insAdj.run(json));
    this.topStmt = this.db.prepare(
      "SELECT c.tid FROM cand c LEFT JOIN dft d ON d.tid = c.tid " +
        "LEFT JOIN temp.dfadj a ON a.tid = c.tid " +
        "JOIN temp.idf i ON i.df = max(1, coalesce(d.n, 0) + coalesce(a.d, 0)) " +
        "WHERE c.fid = ? ORDER BY c.tf * i.v DESC, c.sec, c.o1, c.o2 LIMIT ?",
    );
  }

  /** A folder's best `limit` candidate ids by (tf·idf desc, tf order) —
   *  prepareScoring must have run in this read phase. */
  topCandidates(fid: number, limit: number): number[] {
    if (this.topStmt === null) throw new Error("prepareScoring not run");
    return (this.topStmt.all(fid, limit) as unknown as { tid: number }[]).map(
      (r) => r.tid,
    );
  }

  /** dft counts for a set of term ids (absent ids are left out). */
  dfOfIds(ids: number[]): Map<number, number> {
    this.ensureOpen();
    const out = new Map<number, number>();
    inChunks(ids, CHUNK, (json) => {
      for (const r of this.stmts.dftOfIds.all(json) as unknown as {
        tid: number;
        n: number;
      }[]) {
        out.set(r.tid, r.n);
      }
    });
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
 * shared-memory WAL cannot mmap); on open failure park the file aside
 * (with its -wal/-shm sidecars — an orphaned WAL replays into the fresh
 * database and resurrects the very rows we parked) and repeat once. A
 * BUSY/locked failure returns null at once: another connection holds a
 * healthy file, and parking it would rename it under a live writer (the
 * caller falls back for this run and the next run retries). Returns null
 * when a freshly created database still cannot be opened.
 */
function openDb(sqlite: SqliteModule, dbPath: string): DatabaseSync | null {
  for (const mode of ["WAL", "DELETE"] as const) {
    const db = tryOpen(sqlite, dbPath, mode);
    if (db !== null) return db;
    if (openBusy) return null;
  }
  parkAside(dbPath);
  for (const mode of ["WAL", "DELETE"] as const) {
    const db = tryOpen(sqlite, dbPath, mode);
    if (db !== null) return db;
    if (openBusy) return null;
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
