import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createIndexStore } from "./index-store.js";
import { JsonStore } from "./json-store.js";
import { loadSqlite, SqliteStore } from "./sqlite-store.js";
import { createTempVault } from "./test-helpers.js";

/**
 * SqliteStore (#106): per-file diff persistence, migration, and the failure
 * modes the issue pins — kill -9 mid-transaction, a corrupt file, a
 * schema-version skew, and a mid-diff write failure.
 */

const DB_REL = path.join("cache", "index-v1.db");

const vaults: { cleanup: () => void }[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // Already closed.
    }
  }
  for (const v of vaults.splice(0)) v.cleanup();
});

function makeVault(files: Record<string, string> = {}): {
  path: string;
  vaultPath: string;
} {
  const v = createTempVault(files);
  vaults.push(v);
  return v;
}

function openStore(vaultPath: string): SqliteStore {
  const store = SqliteStore.open(vaultPath);
  if (store === null) throw new Error("SqliteStore.open returned null");
  stores.push(store);
  return store;
}

function doc(
  file: string,
  links: string[] = [],
  mtime = 1000,
): {
  file: string;
  basename: string;
  mtime: number;
  size: number;
  outgoingLinks: string[];
} {
  return {
    file,
    basename: path.basename(file, ".md"),
    mtime,
    size: 10,
    outgoingLinks: links,
  };
}

function snapshot(ignoreFingerprint = "fp") {
  return {
    folder: null,
    fileMtimes: {
      "a/one.md": { mtime: 1000, size: 10 },
      "b/two.md": { mtime: 2000, size: 20 },
    },
    index: '{"serialized":"index"}',
    docs: [
      { file: "a/one.md", basename: "one", mtime: 1000, size: 10 },
      { file: "b/two.md", basename: "two", mtime: 2000, size: 20 },
    ],
    backlinkCounts: { "a/one.md": 1 },
    outgoingLinks: { "a/one.md": [], "b/two.md": ["one"] },
    ignoreFingerprint,
  };
}

describe("SqliteStore", () => {
  test("open creates .napkin/cache/index-v1.db and a '*' .gitignore", () => {
    const v = makeVault();
    openStore(v.vaultPath);
    expect(fs.existsSync(path.join(v.vaultPath, DB_REL))).toBe(true);
    expect(
      fs.readFileSync(path.join(v.vaultPath, "cache", ".gitignore"), "utf-8"),
    ).toBe("*\n");
  });

  test("save + load round-trips the snapshot fields a search needs", () => {
    const v = makeVault();
    const store = openStore(v.vaultPath);
    store.save(snapshot());

    const loaded = openStore(v.vaultPath).load();
    expect(loaded).not.toBeNull();
    expect(loaded?.folder).toBeNull();
    expect(loaded?.index).toBe('{"serialized":"index"}');
    expect(loaded?.ignoreFingerprint).toBe("fp");
    expect(loaded?.fileMtimes).toEqual(snapshot().fileMtimes);
    expect(loaded?.docs).toEqual(snapshot().docs);
    expect(loaded?.outgoingLinks).toEqual(snapshot().outgoingLinks);
    // Just written: blob and file rows share a generation, no repair needed.
    expect(loaded?.indexDelta).toBeUndefined();
    expect(store.linkCountsForTests()).toEqual({ one: 1 });
  });

  test("saveDiff applies a pure edit without touching the basename blob", () => {
    const v = makeVault();
    const store = openStore(v.vaultPath);
    store.save(snapshot());
    const before = store.inspectForTests();

    store.saveDiff({
      upsert: [{ ...doc("a/one.md", ["two"], 3000) }],
      remove: [],
      ignoreFingerprint: "fp",
    });

    const after = store.inspectForTests();
    expect(after.gen).toBe(before.gen + 1);
    // Edit-only diff: no indexBlob, so the blob stays at its generation…
    expect(after.blobGen).toBe(before.blobGen);
    // …and load() reports the changed file as a repair delta.
    const loaded = store.load();
    expect(loaded?.indexDelta?.add).toEqual(["a/one.md"]);
    expect(loaded?.indexDelta?.remove ?? []).toEqual([]);
    expect(loaded?.fileMtimes["a/one.md"].mtime).toBe(3000);
    // The edited file's new outgoing link adjusts the tallies by delta.
    expect(store.linkCountsForTests()).toEqual({ one: 1, two: 1 });
  });

  test("saveDiff delete writes a tombstone and drops link contributions", () => {
    const v = makeVault();
    const store = openStore(v.vaultPath);
    store.save(snapshot());

    store.saveDiff({
      upsert: [],
      remove: [{ file: "b/two.md", basename: "two" }],
      indexBlob: '{"serialized":"index-v2"}',
      ignoreFingerprint: "fp",
    });

    const loaded = store.load();
    expect(loaded?.docs.map((d) => d.file)).toEqual(["a/one.md"]);
    expect(loaded?.index).toBe('{"serialized":"index-v2"}');
    // The blob moved with the tombstone's generation: nothing left to repair.
    expect(loaded?.indexDelta).toBeUndefined();
    // b/two.md's link to "one" is gone.
    expect(store.linkCountsForTests()).toEqual({});
  });

  test("a delete without a new blob surfaces as an indexDelta removal", () => {
    const v = makeVault();
    const store = openStore(v.vaultPath);
    store.save(snapshot());

    store.saveDiff({
      upsert: [],
      remove: [{ file: "b/two.md", basename: "two" }],
      ignoreFingerprint: "fp",
    });

    const loaded = store.load();
    expect(loaded?.indexDelta?.remove).toEqual([
      { file: "b/two.md", basename: "two" },
    ]);
  });

  test("first open migrates a valid search-cache.json instead of cold-building", () => {
    const v = makeVault();
    new JsonStore(v.vaultPath).save(snapshot());

    const store = openStore(v.vaultPath);
    expect(store.inspectForTests().fileCount).toBe(2);
    const loaded = store.load();
    expect(loaded?.docs).toEqual(snapshot().docs);
    expect(loaded?.index).toBe(snapshot().index);
  });

  test("a mid-diff write failure rolls the transaction back", () => {
    const v = makeVault();
    const store = openStore(v.vaultPath);
    store.save(snapshot());
    const before = store.inspectForTests();

    expect(() =>
      store.saveDiff({
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid row to trip the NOT NULL constraint
        upsert: [{ ...doc("c/bad.md"), basename: null } as any],
        remove: [{ file: "b/two.md", basename: "two" }],
        ignoreFingerprint: "fp",
      }),
    ).toThrow();

    // Rolled back: the delete part of the same transaction did not land.
    const after = store.inspectForTests();
    expect(after.gen).toBe(before.gen);
    expect(after.fileCount).toBe(2);
    expect(after.tombstones).toBe(0);
    expect(store.load()?.docs).toEqual(snapshot().docs);
  });

  test("a corrupt database file is parked and recreated, never a crash", () => {
    const v = makeVault();
    const first = openStore(v.vaultPath);
    first.save(snapshot());
    // Close first so the WAL checkpoints into the main file — while a WAL
    // exists it shadows the main file, and corrupting only the .db is not
    // corruption at all (SQLite recovers the live pages from the WAL).
    first.close();
    const dbPath = path.join(v.vaultPath, DB_REL);
    fs.writeFileSync(dbPath, "this is not a sqlite database");

    const store = openStore(v.vaultPath);
    // Recovered empty: no snapshot to load, but the store works.
    expect(store.load()).toBeNull();
    expect(
      fs
        .readdirSync(path.join(v.vaultPath, "cache"))
        .some((f) => f.startsWith("index-v1.db.corrupt-")),
    ).toBe(true);

    store.save(snapshot());
    expect(store.load()?.docs).toEqual(snapshot().docs);
  });

  test("a schema-version mismatch rebuilds instead of loading", () => {
    const v = makeVault();
    openStore(v.vaultPath).save(snapshot());
    const dbPath = path.join(v.vaultPath, DB_REL);

    const sqlite = loadSqlite();
    if (sqlite === null) throw new Error("node:sqlite unavailable in test");
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    const store = openStore(v.vaultPath);
    expect(store.load()).toBeNull();
    store.save(snapshot());
    expect(store.load()?.docs).toEqual(snapshot().docs);
  });

  test("kill -9 mid-transaction leaves the last committed state intact", () => {
    const v = makeVault();
    const store = openStore(v.vaultPath);
    store.save(snapshot());
    const dbPath = path.join(v.vaultPath, DB_REL);

    // A second process starts a transaction and dies holding it. The WAL
    // recovery on our next read rolls the partial transaction back — the
    // invariant is that a file row never commits without its links.
    const child = [
      'import { DatabaseSync } from "node:sqlite";',
      "const db = new DatabaseSync(process.argv[1], { timeout: 10000 });",
      'db.exec("BEGIN IMMEDIATE");',
      "db.prepare(\"INSERT INTO files(path, folder_id, basename, basename_lc, depth, mtime, size, ino, gen) VALUES(?,0,'ghost','ghost',0,1,1,NULL,99)\").run('z/ghost.md');",
      'process.kill(process.pid, "SIGKILL");',
    ].join("\n");
    expect(() =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", child, dbPath],
        { stdio: "ignore" },
      ),
    ).toThrow();

    // Both the live connection and a fresh one see only committed state.
    expect(store.inspectForTests().fileCount).toBe(2);
    expect(store.load()?.docs).toEqual(snapshot().docs);
    expect(openStore(v.vaultPath).load()?.docs).toEqual(snapshot().docs);
  });
});

describe("createIndexStore selection", () => {
  test("kind 'json' selects JsonStore, 'sqlite' selects SqliteStore", () => {
    const v = makeVault();
    expect(createIndexStore(v.vaultPath, "json")).toBeInstanceOf(JsonStore);
    const sqlite = createIndexStore(v.vaultPath, "sqlite");
    expect(sqlite).toBeInstanceOf(SqliteStore);
    if (sqlite instanceof SqliteStore) stores.push(sqlite);
  });

  test("'sqlite' falls back to JsonStore when the cache dir is unwritable", () => {
    const v = makeVault();
    fs.chmodSync(v.vaultPath, 0o555);
    try {
      expect(createIndexStore(v.vaultPath, "sqlite")).toBeInstanceOf(JsonStore);
    } finally {
      fs.chmodSync(v.vaultPath, 0o755);
    }
  });
});
