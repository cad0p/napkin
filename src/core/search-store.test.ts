import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadIgnorer } from "../utils/ignore.js";
import {
  createIndexStore,
  isQueryableIndexStore,
  resetIndexStoresForTests,
} from "../utils/index-store.js";
import { markSearchPathsDirty } from "../utils/search-freshness.js";
import { SqliteStore, setBusyTimeoutForTests } from "../utils/sqlite-store.js";
import {
  createTempVault,
  dropSearchStoreFiles,
  useJsonIndexStore,
} from "../utils/test-helpers.js";
import {
  hasMemoryIndexForTests,
  resetSearchIndexForTests,
  searchVault,
} from "./search.js";

/**
 * Search served from the SQLite store per query (#109): the store is queried
 * in place, nothing of the index stays in the process, and results match both
 * a cold build and the in-memory JsonStore path.
 */

type TempVault = { path: string; vaultPath: string; cleanup: () => void };
const vaults: TempVault[] = [];

afterEach(() => {
  resetSearchIndexForTests();
  setBusyTimeoutForTests(5000);
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(files: Record<string, string>): TempVault {
  const v = createTempVault(files);
  vaults.push(v);
  // One fixed whole-second mtime for every note. The recency term is
  // normalised across the result set and scores are rounded, so notes
  // written a millisecond apart (or a copy that loses sub-millisecond
  // precision) would flip scores at a rounding edge. Tests that need
  // distinct times set them explicitly.
  const fixed = new Date(2025, 0, 2);
  for (const entry of fs.readdirSync(v.vaultPath, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      fs.utimesSync(path.join(entry.parentPath, entry.name), fixed, fixed);
    }
  }
  return v;
}

/** A mid-sized vault: duplicate basenames, links, hyphens, folders. */
function corpus(): Record<string, string> {
  const files: Record<string, string> = {
    "Projects/alpha-roadmap.md":
      "# Alpha roadmap\nquarterly planning [[beta-notes]]\n",
    "Projects/beta-notes.md":
      "# Beta\nmeeting notes quarterly [[alpha-roadmap]] [[index]]\n",
    "Projects/deep/index.md":
      "# Deep index\nzzmarker [[Projects/alpha-roadmap]]\n",
    "index.md": "# Index\n[[alpha-roadmap]] [[beta-notes]] [[beta-notes]]\n",
    "foo/inside.md": "# inside\nscoped zzmarker\n",
    "foo/bar/nested-note.md": "# nested\nscoped zzmarker nested\n",
    "foobar/outside.md": "# outside\nscoped zzmarker\n",
    "Journal/2026-01-02 daily.md": "# daily\nproject planning\n",
    "Journal/2026-01-03 daily.md": "# daily\nproject review [[index]]\n",
    "Reference/passkey-webauthn-guide.md": "# Passkeys\nwebauthn enroll\n",
  };
  for (let i = 0; i < 25; i++) {
    files[`Misc/note-${i} project-${i % 5}.md`] =
      `# note ${i}\nproject filler quarterly ${i % 3 === 0 ? "[[index]]" : ""}\n`;
  }
  return files;
}

const QUERIES = [
  "alpha",
  "alpha roadmap",
  "roadmp", // fuzzy
  "quart", // prefix
  "quarterly planning",
  "project",
  "daily",
  "index",
  "webauthn passkey",
  "zzmarker",
  "nonexistentterm",
  "note-3 project",
];

function run(v: TempVault, query: string, opts?: { path?: string }) {
  return searchVault(v.vaultPath, v.vaultPath, query, {
    limit: 100,
    snippets: false,
    ...opts,
  }).map((r) => ({ file: r.file, score: r.score, links: r.links }));
}

/** Same hits and scores; order among exact ties is not part of the contract. */
function canonical(rows: ReturnType<typeof run>) {
  return [...rows].sort(
    (a, b) =>
      b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
}

describe("SQLite search path (#109)", () => {
  test("the default store is queryable and search leaves nothing in memory", () => {
    const v = vault(corpus());
    expect(isQueryableIndexStore(createIndexStore(v.vaultPath))).toBe(true);
    expect(run(v, "alpha").length).toBeGreaterThan(0);
    expect(hasMemoryIndexForTests(v.vaultPath)).toBe(false);
  });

  test("DB and JsonStore agree on hits, scores and backlinks", () => {
    const sqlite = vault(corpus());
    const json = vault(corpus());
    useJsonIndexStore(json.vaultPath);
    // Same mtimes in both vaults so recency normalises identically.
    for (const rel of Object.keys(corpus())) {
      const t = new Date(2024, 0, 1 + (rel.length % 17));
      fs.utimesSync(path.join(sqlite.vaultPath, rel), t, t);
      fs.utimesSync(path.join(json.vaultPath, rel), t, t);
    }
    for (const q of QUERIES) {
      expect(canonical(run(sqlite, q)), q).toEqual(canonical(run(json, q)));
    }
  });

  test("incremental updates match a cold build of the final state", () => {
    const inc = vault(corpus());
    for (const q of QUERIES) run(inc, q); // build + warm

    const write = (rel: string, body: string, tick: number) => {
      const full = path.join(inc.vaultPath, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
      const t = new Date(2025, 0, 1, 0, 0, tick);
      fs.utimesSync(full, t, t);
    };
    // edit, add, delete, rename (+ a brand-new shallow duplicate basename)
    write(
      "Projects/alpha-roadmap.md",
      "# Alpha\nrewritten quarterly [[index]]\n",
      1,
    );
    write(
      "Projects/gamma-plan.md",
      "# Gamma\nquarterly [[alpha-roadmap]]\n",
      2,
    );
    fs.rmSync(path.join(inc.vaultPath, "Misc/note-4 project-4.md"));
    fs.renameSync(
      path.join(inc.vaultPath, "Reference/passkey-webauthn-guide.md"),
      path.join(inc.vaultPath, "Reference/passkey-enroll-handbook.md"),
    );
    write("index.md", "# Index\n[[gamma-plan]] [[alpha-roadmap]]\n", 3);
    write("alpha-roadmap.md", "# shallow dup\n[[beta-notes]]\n", 4);

    const cold = vault({});
    fs.rmSync(cold.vaultPath, { recursive: true, force: true });
    fs.cpSync(inc.vaultPath, cold.vaultPath, {
      recursive: true,
      preserveTimestamps: true,
    });
    dropSearchStoreFiles(cold.vaultPath);
    resetIndexStoresForTests();

    for (const q of [...QUERIES, "gamma", "handbook", "passkey enroll"]) {
      expect(canonical(run(inc, q)), q).toEqual(canonical(run(cold, q)));
    }
    // Deleted and renamed-away files are gone; the new names are findable.
    expect(run(inc, "note-4").map((r) => r.file)).not.toContain(
      "Misc/note-4 project-4.md",
    );
    expect(run(inc, "webauthn").map((r) => r.file)).not.toContain(
      "Reference/passkey-webauthn-guide.md",
    );
    expect(run(inc, "handbook").map((r) => r.file)).toContain(
      "Reference/passkey-enroll-handbook.md",
    );
  });

  test("name postings stay exact across delete/rename (no stale terms)", () => {
    const v = vault(corpus());
    run(v, "alpha");
    fs.renameSync(
      path.join(v.vaultPath, "Projects/alpha-roadmap.md"),
      path.join(v.vaultPath, "Projects/omega-plan.md"),
    );
    expect(run(v, "alpha-roadmap").map((r) => r.file)).not.toContain(
      "Projects/alpha-roadmap.md",
    );
    expect(run(v, "omega").map((r) => r.file)).toContain(
      "Projects/omega-plan.md",
    );

    const store = createIndexStore(v.vaultPath);
    if (!(store instanceof SqliteStore))
      throw new Error("expected SqliteStore");
    const before = store.inspectForTests();
    store.release();
    // A cold rebuild yields the same posting/vocabulary counts.
    dropSearchStoreFiles(v.vaultPath);
    resetIndexStoresForTests();
    run(v, "alpha");
    const fresh = createIndexStore(v.vaultPath);
    if (!(fresh instanceof SqliteStore))
      throw new Error("expected SqliteStore");
    const after = fresh.inspectForTests();
    fresh.release();
    expect(before.nameTerms).toBe(after.nameTerms);
    expect(before.nameVocab).toBe(after.nameVocab);
    expect(before.linkCount).toBe(after.linkCount);
  });

  test("folder scope filters hits but keeps whole-vault statistics", () => {
    const v = vault(corpus());
    const whole = run(v, "zzmarker");
    const scoped = run(v, "zzmarker", { path: "foo" });
    expect(scoped.map((r) => r.file).sort()).toEqual([
      "foo/bar/nested-note.md",
      "foo/inside.md",
    ]);
    expect(whole.map((r) => r.file)).toContain("foobar/outside.md");
    // Basename scores are whole-vault: scoping can only drop rows.
    const nameScoped = run(v, "nested-note", { path: "foo" });
    const nameWhole = run(v, "nested-note");
    const whole0 = nameWhole.find((r) => r.file === "foo/bar/nested-note.md");
    const scoped0 = nameScoped.find((r) => r.file === "foo/bar/nested-note.md");
    expect(scoped0?.score).toBe(whole0?.score);
    expect(run(v, "zzmarker", { path: "nonexistent" })).toEqual([]);
    // Same answer as the in-memory path.
    const json = vault(corpus());
    useJsonIndexStore(json.vaultPath);
    expect(
      canonical(run(json, "zzmarker", { path: "foo" })).map((r) => r.file),
    ).toEqual(canonical(scoped).map((r) => r.file));
  });

  test("a note deleted between the walk and the scan does not break the search", () => {
    const v = vault(corpus());
    run(v, "alpha");
    fs.rmSync(path.join(v.vaultPath, "Projects/beta-notes.md"));
    const files = run(v, "beta").map((r) => r.file);
    expect(files).not.toContain("Projects/beta-notes.md");
  });
});

test("a basename containing U+10FFFF matches the in-memory path", () => {
  const v = vault({
    "Misc/note\u{10FFFF}x.md": "# odd\nbody\n",
    "Misc/other.md": "# o\n",
  });
  const sqlite = run(v, "note").map((r) => r.file);
  const json = vault({
    "Misc/note\u{10FFFF}x.md": "# odd\nbody\n",
    "Misc/other.md": "# o\n",
  });
  useJsonIndexStore(json.vaultPath);
  expect(sqlite).toEqual(run(json, "note").map((r) => r.file));
  expect(sqlite).toContain("Misc/note\u{10FFFF}x.md");
});

describe("SQLite search path failure modes (#109)", () => {
  test("a database corrupted after open falls back, then recovers", () => {
    const v = vault(corpus());
    const expected = canonical(run(v, "alpha roadmap"));
    // Corrupt the file under the live (closed-between-searches) store.
    const db = path.join(v.vaultPath, "cache", "index-v2.db");
    for (const suffix of ["-wal", "-shm"])
      fs.rmSync(`${db}${suffix}`, { force: true });
    fs.writeFileSync(db, "this is not a sqlite database at all");

    let got: ReturnType<typeof run> = [];
    expect(() => {
      got = run(v, "alpha roadmap");
    }).not.toThrow();
    expect(canonical(got).map((r) => r.file)).toEqual(
      expected.map((r) => r.file),
    );
    // The bad file was parked; the next search rebuilds a clean database.
    expect(
      fs
        .readdirSync(path.join(v.vaultPath, "cache"))
        .some((f) => f.includes(".corrupt-")),
    ).toBe(true);
    expect(canonical(run(v, "alpha roadmap"))).toEqual(expected);
  });

  test("a locked database falls back for that search, never a crash", () => {
    const v = vault(corpus());
    run(v, "alpha");
    setBusyTimeoutForTests(100);
    resetIndexStoresForTests();
    run(v, "alpha"); // reopen under the short timeout

    // Another connection holds the write lock while a note changes.
    const raw = new (require("node:sqlite").DatabaseSync)(
      path.join(v.vaultPath, "cache", "index-v2.db"),
    );
    raw.exec("BEGIN IMMEDIATE");
    try {
      const full = path.join(v.vaultPath, "Projects/alpha-roadmap.md");
      fs.writeFileSync(full, "# Alpha\nlockedmarker\n");
      let got: ReturnType<typeof run> = [];
      expect(() => {
        got = run(v, "lockedmarker");
      }).not.toThrow();
      expect(got.map((r) => r.file)).toContain("Projects/alpha-roadmap.md");
    } finally {
      raw.exec("ROLLBACK");
      raw.close();
    }
    // Lock released: the next search applies the change through SQLite.
    expect(run(v, "lockedmarker").map((r) => r.file)).toContain(
      "Projects/alpha-roadmap.md",
    );
  });

  test("a fallback inside the freshness window walks instead of trusting an old JSON snapshot", () => {
    // An old search-cache.json for the same notes (an earlier napkin wrote it).
    const old = vault(corpus());
    useJsonIndexStore(old.vaultPath);
    run(old, "alpha");
    const v = vault(corpus());
    const windowed = (query: string) =>
      searchVault(v.vaultPath, v.vaultPath, query, {
        limit: 100,
        snippets: false,
        freshnessMs: 60_000,
      }).map((r) => r.file);
    windowed("alpha"); // the SQLite walk opens the window
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(old.vaultPath, "search-cache.json"), "utf8"),
    );
    // Same notes, same ignore state: only the fingerprint's vault path differs.
    snapshot.ignoreFingerprint = loadIgnorer(
      v.vaultPath,
      v.vaultPath,
    ).fingerprint;
    fs.writeFileSync(
      path.join(v.vaultPath, "search-cache.json"),
      JSON.stringify(snapshot),
    );

    // This process writes a note (napkin marks it dirty), then the store
    // fails after the refresh took the dirty paths.
    fs.writeFileSync(
      path.join(v.vaultPath, "Projects/fresh-note.md"),
      "# Fresh\nwindowmarker\n",
    );
    markSearchPathsDirty(v.vaultPath, "Projects/fresh-note.md");
    const db = path.join(v.vaultPath, "cache", "index-v2.db");
    for (const suffix of ["-wal", "-shm"])
      fs.rmSync(`${db}${suffix}`, { force: true });
    fs.writeFileSync(db, "this is not a sqlite database at all");

    expect(windowed("windowmarker")).toContain("Projects/fresh-note.md");
  });
});
