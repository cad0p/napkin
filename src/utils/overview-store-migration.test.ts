import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { _aggregateFolder, getOverview } from "../core/overview.js";
import {
  createOverviewStore,
  ORD_GAP,
  type SqliteOverviewStore,
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

function rawDb(vaultPath: string) {
  const sqlite = loadSqlite();
  if (sqlite === null) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(
    path.join(vaultPath, "cache", "overview-v2.db"),
    { readOnly: true },
  );
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
  test("a v1 database migrates in place and serves the identical overview", () => {
    const v = fixtureVault();
    const dbPath = path.join(v.vaultPath, "cache", "overview-v2.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_DIR, "overview-v2.db"), dbPath);

    const before = rawDb(v.vaultPath);
    expect(
      (before.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(1);
    before.close();

    // The run misses the result cache, opens the store — migrating it — and
    // serves every folder from the migrated rows.
    const result = getOverview(v.vaultPath, v.vaultPath);
    expect(JSON.stringify(result)).toBe(JSON.stringify(MANIFEST.expected));

    const after = rawDb(v.vaultPath);
    expect(
      (after.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(2);
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
    // The v1 blobs are gone.
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
    expect(
      fs
        .readdirSync(path.dirname(dbPath))
        .some((f) => f.startsWith("overview-v2.db.corrupt-")),
    ).toBe(false);
    after.close();

    // Row tables equal the reference aggregation over the stored records.
    expectStoreConsistent(v);
  });

  test("a failed migration parks the file and the cold path matches", () => {
    const v = fixtureVault();
    const dbPath = path.join(v.vaultPath, "cache", "overview-v2.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_DIR, "overview-v2.db"), dbPath);
    // Corrupt one note's heads JSON: the migration's decode throws.
    const sqlite = loadSqlite();
    const db = new (
      sqlite as NonNullable<ReturnType<typeof loadSqlite>>
    ).DatabaseSync(dbPath);
    db.prepare("UPDATE notes SET heads = 'not json' WHERE path = ?").run(
      "alpha/mesh.md",
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    const result = getOverview(v.vaultPath, v.vaultPath);
    expect(JSON.stringify(result)).toBe(JSON.stringify(MANIFEST.expected));
    expect(
      fs
        .readdirSync(path.dirname(dbPath))
        .some((f) => f.startsWith("overview-v2.db.corrupt-")),
    ).toBe(true);
    const after = rawDb(v.vaultPath);
    expect(
      (after.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(2);
    after.close();
    expectStoreConsistent(v);
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
