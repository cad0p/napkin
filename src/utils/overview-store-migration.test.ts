import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  _aggregateFolder,
  _lastOverviewSyncStats,
  getOverview,
} from "../core/overview.js";
import {
  createOverviewStore,
  lastOverviewOpenError,
  ORD_GAP,
  resetOverviewStoresForTests,
  SqliteOverviewStore,
  setOverviewBusyTimeoutForTests,
} from "./overview-store.js";
import { loadSqlite } from "./sqlite-loader.js";
import {
  createTempVault,
  dropOverviewStoreFiles,
  resetOverviewIndexForTests,
} from "./test-helpers.js";

/**
 * Schema v2 (#125): the in-place v1→v2 migration, and the invariant that
 * every folder's ordered cand rows equal the reference aggregation's
 * candidate list while dft equals a fresh recount — after a cold build,
 * after each kind of miss, and after the depth bound changes.
 *
 * The v1 fixture DB in ./fixtures/overview-v1/ was produced by the pre-#125
 * (schema v1) code on the vault the manifest describes; the manifest also
 * records the overview the v1 pipeline emitted, so a migrated store must
 * reproduce it byte-for-byte.
 */

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "overview-v1",
);
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf-8"),
) as {
  config: Record<string, unknown>;
  files: { path: string; content: string; mtime: number }[];
  expected: unknown;
};

type TempVault = { path: string; vaultPath: string; cleanup: () => void };
const vaults: TempVault[] = [];

afterEach(() => {
  resetOverviewIndexForTests();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(files: Record<string, string>): TempVault {
  const v = createTempVault(files);
  vaults.push(v);
  return v;
}

/** Recreate the fixture vault exactly: same config, files, and mtimes. */
function fixtureVault(): TempVault {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-test-"));
  const napkinDir = path.join(tmpDir, ".napkin");
  fs.mkdirSync(napkinDir, { recursive: true });
  fs.writeFileSync(
    path.join(napkinDir, "config.json"),
    JSON.stringify(MANIFEST.config),
  );
  for (const f of MANIFEST.files) {
    const full = path.join(napkinDir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content);
    fs.utimesSync(full, new Date(f.mtime), new Date(f.mtime));
  }
  const v = {
    path: tmpDir,
    vaultPath: napkinDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
  vaults.push(v);
  return v;
}

const V1_FILE = "overview-v2.db";
const V2_FILE = "overview-v3.db";

function rawDb(vaultPath: string, file = V2_FILE) {
  const sqlite = loadSqlite();
  if (sqlite === null) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(path.join(vaultPath, "cache", file), {
    readOnly: true,
  });
}

function sha(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function userVersion(vaultPath: string, file: string): number {
  const db = rawDb(vaultPath, file);
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
  } finally {
    db.close();
  }
}

/** A fixture vault whose cache dir holds the v1 store (overview-v2.db). */
function fixtureVaultWithV1(): { v: TempVault; v1Path: string } {
  const v = fixtureVault();
  const v1Path = path.join(v.vaultPath, "cache", V1_FILE);
  fs.mkdirSync(path.dirname(v1Path), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, "overview-v2.db"), v1Path);
  return { v, v1Path };
}

function cacheFiles(vaultPath: string): string[] {
  return fs.readdirSync(path.join(vaultPath, "cache")).sort();
}

function i32(u: Uint8Array): Int32Array {
  if (u.byteOffset % 4 === 0) {
    return new Int32Array(u.buffer, u.byteOffset, u.byteLength >> 2);
  }
  const c = u.slice();
  return new Int32Array(c.buffer, 0, c.byteLength >> 2);
}

/**
 * The row-table invariant: for EVERY stored folder, ordered cand rows equal
 * _aggregateFolder's candidate list computed from the same stored records;
 * and dft equals a recount over the folders at depth ≤ meta.df_depth.
 */
function expectStoreConsistent(v: TempVault): void {
  const store = createOverviewStore(v.vaultPath) as SqliteOverviewStore;
  expect(store).not.toBeNull();
  const meta = store.metaState();
  const bound = meta.dfDepth ?? 0;
  const byFolder = new Map<string, string[]>();
  for (const m of store.noteMeta()) {
    const list = byFolder.get(m.folder) ?? [];
    list.push(m.path);
    byFolder.set(m.folder, list);
  }
  const depth = (f: string) => (f === "/" ? 0 : f.split("/").length);
  const dfExpected = new Map<number, number>();
  const rows = store.folderRows();
  const fidOf = new Map(rows.map((r) => [r.path, r.fid]));
  for (const row of rows) {
    const fid = row.fid;
    const files = (byFolder.get(row.path) ?? []).slice().sort();
    const expected = _aggregateFolder(store, row.path, files, (file) => {
      const r = store.getNote(file);
      expect(r).toBeDefined();
      return {
        skip: r?.skip === 1,
        tags: JSON.parse(r?.tags ?? "[]") as string[],
        heads: JSON.parse(r?.heads ?? "[]") as [string, number[]][],
        data: r?.data == null ? null : i32(r.data),
      };
    });
    const got = store.folderCandPairs(fid);
    expect([...got], `cand rows for ${row.path}`).toEqual([...expected.cand]);
    // df recount: this folder's term set contributes when within the bound.
    if (depth(row.path) <= bound) {
      for (const id of store.folderTfIds(fid)) {
        dfExpected.set(id, (dfExpected.get(id) ?? 0) + 1);
      }
    }
  }
  const df = new Int32Array(store.maxTermId() + 1);
  store.fillDf(df);
  const dfActual = new Map<number, number>();
  df.forEach((n, id) => {
    if (n > 0) dfActual.set(id, n);
  });
  expect(dfActual, "dft == recount").toEqual(dfExpected);
  expect(fidOf.size).toBe(byFolder.size);
}

const FIXTURE: Record<string, string> = {
  "NAPKIN.md": "# Fixture project\nContext note for the store vault.",
  "root.md": "# Root\nroot anchor zebra kumquat levain",
  "alpha/kubernetes.md":
    "# Cluster\nkubernetes ingress routing autoscaling telemetry dashboards\n## Deploy notes\nlevain hydration metrics pipeline",
  "alpha/mesh.md":
    "# Mesh\nkubernetes service mesh service mesh sidecar proxies\n## Deploy notes\nsolo uniqueheading\ndata data data",
  "beta/payroll.md":
    "# Payroll\npayroll withholding contractors ledger invoices quarterly",
  "beta/ledger.md":
    "# Ledger\ndouble entry ledger reconciliation journal corrections audit",
  "gamma/sourdough.md":
    "# Sourdough\nfermentation hydration levain schedules starter feeding",
  "deep/a/b/note.md": "# Deep\nabyssal trench bathysphere hadal pelagic",
};

describe("overview store schema v2 (#125)", () => {
  test("a v1 database migrates into overview-v3.db and is left unchanged", () => {
    const { v, v1Path } = fixtureVaultWithV1();
    expect(userVersion(v.vaultPath, V1_FILE)).toBe(1);
    const v1Hash = sha(v1Path);

    // The run misses the result cache, opens the store — migrating a copy
    // of the v1 file — and serves every folder from the migrated rows.
    const result = getOverview(v.vaultPath, v.vaultPath);
    expect(JSON.stringify(result)).toBe(JSON.stringify(MANIFEST.expected));

    // The v1 file is byte-for-byte what older napkin versions wrote: they
    // keep using it (no ping-pong of parks and rebuilds between versions).
    expect(sha(v1Path)).toBe(v1Hash);
    expect(userVersion(v.vaultPath, V1_FILE)).toBe(1);
    const files = cacheFiles(v.vaultPath);
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(false);
    expect(files.some((f) => f.includes(".migrating-"))).toBe(false);

    const after = rawDb(v.vaultPath);
    expect(
      (after.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(2);
    expect(
      (after.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
    ).toBe("wal");
    // ords assigned in JS path-sort order, spaced ORD_GAP apart.
    const ords = after
      .prepare(
        "SELECT path, ord FROM notes WHERE folder = 'alpha' ORDER BY ord",
      )
      .all() as { path: string; ord: number }[];
    expect(ords.map((r) => r.path)).toEqual(
      ["alpha/kubernetes.md", "alpha/mesh.md"].sort(),
    );
    for (const [i, r] of ords.entries()) expect(r.ord).toBe((i + 1) * ORD_GAP);
    // The v1 blobs are gone from the migrated copy.
    const cols = after
      .prepare("SELECT name FROM pragma_table_info('folders')")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name).sort()).toEqual([
      "notes",
      "path",
      "tags",
      "warn",
    ]);
    expect(
      after.prepare("SELECT v FROM meta WHERE k = 'flags'").get(),
    ).toBeUndefined();
    after.close();

    // Row tables equal the reference aggregation over the stored records.
    expectStoreConsistent(v);

    // A second process finds overview-v3.db and does not migrate again.
    resetOverviewStoresForTests();
    const v2Hash = sha(path.join(v.vaultPath, "cache", V2_FILE));
    fs.rmSync(path.join(v.vaultPath, "overview-cache.json"), { force: true });
    expect(JSON.stringify(getOverview(v.vaultPath, v.vaultPath))).toBe(
      JSON.stringify(MANIFEST.expected),
    );
    expect(_lastOverviewSyncStats().whole).toEqual([]);
    expect(_lastOverviewSyncStats().delta).toEqual([]);
    expect(sha(v1Path)).toBe(v1Hash);
    resetOverviewStoresForTests();
    expect(sha(path.join(v.vaultPath, "cache", V2_FILE))).toBe(v2Hash);
  });

  test("a failed migration leaves the v1 file alone and the cold path matches", () => {
    const { v, v1Path } = fixtureVaultWithV1();
    // Corrupt one note's heads JSON: the migration's decode throws.
    const sqlite = loadSqlite();
    const db = new (
      sqlite as NonNullable<ReturnType<typeof loadSqlite>>
    ).DatabaseSync(v1Path);
    db.prepare("UPDATE notes SET heads = 'not json' WHERE path = ?").run(
      "alpha/mesh.md",
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const v1Hash = sha(v1Path);

    const result = getOverview(v.vaultPath, v.vaultPath);
    expect(JSON.stringify(result)).toBe(JSON.stringify(MANIFEST.expected));
    expect(sha(v1Path)).toBe(v1Hash);
    const files = cacheFiles(v.vaultPath);
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(false);
    expect(files.some((f) => f.includes(".migrating-"))).toBe(false);
    expect(userVersion(v.vaultPath, V2_FILE)).toBe(2);
    expect(userVersion(v.vaultPath, V1_FILE)).toBe(1);
    expectStoreConsistent(v);
  });

  test("a stale-format v1 file is not migrated and stays untouched", () => {
    const { v, v1Path } = fixtureVaultWithV1();
    const sqlite = loadSqlite();
    const db = new (
      sqlite as NonNullable<ReturnType<typeof loadSqlite>>
    ).DatabaseSync(v1Path);
    db.exec("UPDATE meta SET v = -1 WHERE k = 'format'");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const v1Hash = sha(v1Path);
    const result = getOverview(v.vaultPath, v.vaultPath);
    expect(JSON.stringify(result)).toBe(JSON.stringify(MANIFEST.expected));
    expect(sha(v1Path)).toBe(v1Hash);
    expect(_lastOverviewSyncStats().whole.length).toBeGreaterThan(0);
    expect(userVersion(v.vaultPath, V2_FILE)).toBe(2);
    expectStoreConsistent(v);
  });

  test("a locked v1 file is neither parked nor migrated: this run falls back", () => {
    const { v, v1Path } = fixtureVaultWithV1();
    const sqlite = loadSqlite() as NonNullable<ReturnType<typeof loadSqlite>>;
    // A writer mid-commit in rollback-journal mode excludes readers.
    const holder = new sqlite.DatabaseSync(v1Path);
    holder.exec("PRAGMA journal_mode = DELETE");
    holder.exec("BEGIN EXCLUSIVE");
    setOverviewBusyTimeoutForTests(50);
    try {
      expect(SqliteOverviewStore.open(v.vaultPath)).toBeNull();
      const files = cacheFiles(v.vaultPath);
      expect(files.some((f) => f.includes(".corrupt-"))).toBe(false);
      expect(files.some((f) => f.includes(".migrating-"))).toBe(false);
      expect(files).not.toContain(V2_FILE);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      setOverviewBusyTimeoutForTests(5000);
    }
    // Lock released: the next run migrates.
    const s = SqliteOverviewStore.open(v.vaultPath);
    expect(s).not.toBeNull();
    s?.close();
    expect(userVersion(v.vaultPath, V2_FILE)).toBe(2);
  });

  test("a locked store file is never parked (busy open returns null)", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    resetOverviewStoresForTests();
    const dbPath = path.join(v.vaultPath, "cache", V2_FILE);
    const sqlite = loadSqlite() as NonNullable<ReturnType<typeof loadSqlite>>;
    // Rollback-journal mode + an exclusive writer: opening in WAL needs the
    // lock, so the open sees SQLITE_BUSY.
    const holder = new sqlite.DatabaseSync(dbPath);
    holder.exec("PRAGMA journal_mode = DELETE");
    holder.exec("BEGIN EXCLUSIVE");
    holder.exec("CREATE TABLE IF NOT EXISTS held(x)");
    setOverviewBusyTimeoutForTests(50);
    try {
      expect(SqliteOverviewStore.open(v.vaultPath)).toBeNull();
      expect(lastOverviewOpenError()).toMatch(/locked|busy/i);
      expect(cacheFiles(v.vaultPath).some((f) => f.includes(".corrupt-"))).toBe(
        false,
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      setOverviewBusyTimeoutForTests(5000);
    }
    expectStoreConsistent(v);
  });

  test("a write-locked WAL store opens without parking; the write falls back", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    resetOverviewStoresForTests();
    const dbPath = path.join(v.vaultPath, "cache", V2_FILE);
    const sqlite = loadSqlite() as NonNullable<ReturnType<typeof loadSqlite>>;
    const holder = new sqlite.DatabaseSync(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("CREATE TABLE IF NOT EXISTS held(x)");
    setOverviewBusyTimeoutForTests(50);
    try {
      const s = SqliteOverviewStore.open(v.vaultPath);
      expect(s).not.toBeNull();
      s?.close();
      // A miss needs the write lock: this run falls back to the JSON path,
      // with the same output, and nothing is parked.
      fs.writeFileSync(
        path.join(v.vaultPath, "beta/extra.md"),
        "# Extra\nledger addendum",
      );
      const out = getOverview(v.vaultPath, v.vaultPath);
      expect(out.overview.length).toBe(first.overview.length);
      expect(cacheFiles(v.vaultPath).some((f) => f.includes(".corrupt-"))).toBe(
        false,
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      setOverviewBusyTimeoutForTests(5000);
    }
    resetOverviewStoresForTests();
    fs.rmSync(path.join(v.vaultPath, "overview-cache.json"), { force: true });
    getOverview(v.vaultPath, v.vaultPath);
    expect(_lastOverviewSyncStats().delta).toContain("beta");
    expectStoreConsistent(v);
  });

  test("a fresh process's first miss interns after the stored max id and commits", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    const before = rawDb(v.vaultPath);
    const maxBefore = (
      before.prepare("SELECT MAX(id) AS m FROM terms").get() as { m: number }
    ).m;
    before.close();
    // New process: no warm store object, no cached high-water mark.
    resetOverviewStoresForTests();
    fs.writeFileSync(
      path.join(v.vaultPath, "alpha/novel.md"),
      "# Gamma\nunprecedented zymurgic quixotism",
    );
    const incremental = getOverview(v.vaultPath, v.vaultPath);
    // The delta committed through the store — no JSON fallback.
    expect(_lastOverviewSyncStats().delta).toEqual(["alpha"]);
    expect(
      fs.existsSync(path.join(v.vaultPath, "overview-folders-cache.json")),
    ).toBe(false);
    const after = rawDb(v.vaultPath);
    expect(
      after
        .prepare("SELECT path FROM notes WHERE path = 'alpha/novel.md'")
        .get(),
    ).toBeDefined();
    const ids = after
      .prepare(
        "SELECT t.id FROM terms t WHERE t.term IN ('unprecedented', 'zymurgic', 'quixotism')",
      )
      .all() as { id: number }[];
    after.close();
    expect(ids).toHaveLength(3);
    for (const { id } of ids) expect(id).toBeGreaterThan(maxBefore);
    expectStoreConsistent(v);
    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(incremental)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath)),
    );
  });

  test("cold build: every folder's cand and dft match the aggregation", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    expectStoreConsistent(v);
  });

  const MUTATIONS: {
    name: string;
    apply: (vaultPath: string) => void;
  }[] = [
    {
      name: "edit a note",
      apply: (p) =>
        fs.writeFileSync(
          path.join(p, "alpha/kubernetes.md"),
          "# Cluster\nkubernetes ingress sourdough fermentation hydration",
        ),
    },
    {
      name: "edit a heading (lc/headrc path)",
      apply: (p) =>
        fs.writeFileSync(
          path.join(p, "alpha/mesh.md"),
          "# Mesh\nkubernetes service mesh\n## Fresh heading\nsolo uniqueheading",
        ),
    },
    {
      name: "add a note",
      apply: (p) =>
        fs.writeFileSync(
          path.join(p, "beta/invoices.md"),
          "# Invoices\ninvoice numbering dunning reminders reconciliation",
        ),
    },
    {
      name: "add a mid-position note",
      apply: (p) =>
        fs.writeFileSync(
          path.join(p, "alpha/aaa-first.md"),
          "# First\nalpha ingress routing collimator optics",
        ),
    },
    {
      name: "delete a note",
      apply: (p) => fs.rmSync(path.join(p, "beta/payroll.md")),
    },
    {
      name: "delete a whole folder",
      apply: (p) =>
        fs.rmSync(path.join(p, "gamma"), { recursive: true, force: true }),
    },
    {
      name: "add a new folder",
      apply: (p) => {
        fs.mkdirSync(path.join(p, "delta"), { recursive: true });
        fs.writeFileSync(
          path.join(p, "delta/telescope.md"),
          "# Optics\ntelescope collimation reflector focal ratio",
        );
      },
    },
    {
      name: "add a skip-flagged note",
      apply: (p) => {
        fs.writeFileSync(
          path.join(p, "beta/broken.md"),
          "---\n  bad: [unclosed\n---\nmalformed frontmatter body",
        );
      },
    },
  ];

  test.each(MUTATIONS)(
    "miss ($name): every folder's cand and dft match, output identical",
    ({ apply }) => {
      const v = vault(FIXTURE);
      getOverview(v.vaultPath, v.vaultPath);
      apply(v.vaultPath);
      const incremental = getOverview(v.vaultPath, v.vaultPath);
      expectStoreConsistent(v);
      // Byte-identity vs a full cold rebuild of the mutated vault.
      dropOverviewStoreFiles(v.vaultPath);
      const cold = getOverview(v.vaultPath, v.vaultPath);
      expect(JSON.stringify(incremental)).toBe(JSON.stringify(cold));
      expectStoreConsistent(v);
    },
  );

  test("a depth change rebuilds dft under the new bound", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    // Shallow run: deep carried folders leave the df count.
    const shallow = getOverview(v.vaultPath, v.vaultPath, { depth: 1 });
    expectStoreConsistent(v);
    expect(shallow.overview.some((f) => f.path === "deep/a/b")).toBe(false);
    // Back to full depth: the carried folders return, df covers them.
    const deep = getOverview(v.vaultPath, v.vaultPath);
    expectStoreConsistent(v);
    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(deep)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath)),
    );
  });
});
