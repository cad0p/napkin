import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import {
  getBasenameScoresForTests,
  resetSearchIndexForTests,
  searchVault,
} from "./search.js";

/**
 * Basename BM25 exactness across incremental updates (#100).
 *
 * An incremental diff must leave the basename MiniSearch index in the state a
 * cold build of the same vault would produce: same documents, same BM25
 * statistics. The incremental path used to `discard` the old version of a
 * doc, which only marks the posting entries for later vacuuming — the stale
 * entries inflate the document frequency of every live doc that is visited
 * before them, so scores drifted from a cold build (measured 11 of 1,500 hits
 * on an 814-note vault, max 1.3 composite points).
 *
 * These tests compare the RAW basename BM25 scores (the composite score
 * `searchVault` returns is rounded to one decimal, which would hide drift up
 * to 0.05): see `getBasenameScoresForTests`.
 */

const EPSILON = 1e-9;

let vaults: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const v of vaults) v.cleanup();
  vaults = [];
  resetSearchIndexForTests();
  vi.useRealTimers();
});

/** A vault whose notes share basename tokens, so one query matches several. */
function makeVault(files: Record<string, string>): {
  path: string;
  vaultPath: string;
} {
  const v = createTempVault(files);
  vaults.push(v);
  return { path: v.path, vaultPath: v.vaultPath };
}

/** Raw basename BM25 scores for `query` from the live (incremental) index. */
function incrementalScores(
  vaultPath: string,
  query: string,
): Map<string, number> {
  return getBasenameScoresForTests(vaultPath, vaultPath, query);
}

/**
 * Raw basename BM25 scores for `query` from a cold build: the memory cache,
 * the disk cache and the throttle are dropped first, so the index is rebuilt
 * from the notes on disk exactly as a fresh CLI process would build it.
 */
function coldScores(vaultPath: string, query: string): Map<string, number> {
  fs.rmSync(path.join(vaultPath, "search-cache.json"), { force: true });
  resetSearchIndexForTests();
  return getBasenameScoresForTests(vaultPath, vaultPath, query);
}

/** Pin a file's mtime so a rewrite always registers as a change. */
function setMtime(file: string, offsetSeconds: number): void {
  const when = new Date(Date.UTC(2024, 0, 1, 0, 0, offsetSeconds));
  fs.utimesSync(file, when, when);
}

/** Compare two score maps exactly, with a readable failure message. */
function expectSameScores(
  actual: Map<string, number>,
  expected: Map<string, number>,
  label: string,
): void {
  expect({ label, files: [...actual.keys()].sort() }).toEqual({
    label,
    files: [...expected.keys()].sort(),
  });
  for (const [file, score] of actual) {
    const cold = expected.get(file) ?? Number.NaN;
    if (!(Math.abs(score - cold) <= EPSILON)) {
      throw new Error(
        `${label}: ${file} scores ${score} incrementally but ${cold} cold (` +
          `delta ${Math.abs(score - cold)})`,
      );
    }
  }
}

describe("incremental basename BM25 parity with a cold build", () => {
  test("editing a note does not move the other notes' scores", () => {
    // All three basenames carry the exact token "note", so one query hits a
    // posting list shared by three documents; the edited note is the one
    // indexed last, which is where `discard` leaves its stale entries.
    const v = makeVault({
      "daily note.md": "# Daily\n",
      "meeting note.md": "# Meeting\n",
      "project note.md": "# Project\n",
    });

    // Cold build, then an edit that changes the note's mtime and size.
    searchVault(v.vaultPath, v.vaultPath, "note", { snippets: false });
    const notePath = path.join(v.vaultPath, "project note.md");
    fs.writeFileSync(notePath, "# Project\nedited body text\n");
    setMtime(notePath, 1);

    const incremental = incrementalScores(v.vaultPath, "note");
    const cold = coldScores(v.vaultPath, "note");
    expect(incremental.size).toBe(3);
    expectSameScores(incremental, cold, "note");
  });

  test("a renamed note leaves the surviving notes' scores exact", () => {
    const v = makeVault({
      "daily note.md": "# Daily\n",
      "meeting note.md": "# Meeting\n",
      "project note.md": "# Project\n",
    });

    searchVault(v.vaultPath, v.vaultPath, "note", { snippets: false });

    // A rename arrives as a remove plus an add, and the new basename still
    // shares the "note" token with the notes that stayed.
    fs.rmSync(path.join(v.vaultPath, "project note.md"));
    const renamed = path.join(v.vaultPath, "project clipboard.md");
    fs.writeFileSync(renamed, "# Project\n");
    setMtime(renamed, 1);

    expectSameScores(
      incrementalScores(v.vaultPath, "note"),
      coldScores(v.vaultPath, "note"),
      "note after rename",
    );
  });

  test("deleting a note leaves the surviving notes' scores exact", () => {
    const v = makeVault({
      "daily note.md": "# Daily\n",
      "meeting note.md": "# Meeting\n",
      "project note.md": "# Project\n",
    });

    searchVault(v.vaultPath, v.vaultPath, "note", { snippets: false });
    fs.rmSync(path.join(v.vaultPath, "project note.md"));

    expectSameScores(
      incrementalScores(v.vaultPath, "note"),
      coldScores(v.vaultPath, "note"),
      "note after delete",
    );
  });
});

// ── Random-mutation property test (#100) ────────────────────────
// The minimal cases above pin the mechanism; this one is the property: for
// any sequence of edits, renames, deletes and adds, the scores an incrementally
// updated index reports are the scores a cold build of the same vault reports.

/** Deterministic PRNG (mulberry32) so a failing seed reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Basenames are drawn from overlapping tokens so every query hits a crowd. */
const ADJECTIVES = ["daily", "meeting", "project", "archived", "personal"];
const NOUNS = ["note", "notes", "log", "cache"];
const QUERIES = [
  "note",
  "notes",
  "note cache",
  "log",
  "meeting note",
  "personal",
  "archived notes",
  "nothingmatchesthis",
];

/** The vault as data, so a cold build can be materialised elsewhere. */
type VaultState = Map<string, string>;

function initialState(seed: number): VaultState {
  const state: VaultState = new Map();
  const r = rng(seed);
  for (let i = 0; i < 24; i++) {
    const name = `${ADJECTIVES[Math.floor(r() * ADJECTIVES.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]} ${i}`;
    const file = `${i % 3 === 0 ? "Projects" : "Notes"}/${name}.md`;
    state.set(file, `# ${name}\n`);
  }
  return state;
}

/** Write a state into a temp vault, with distinct mtimes per note. */
function materialize(state: VaultState): string {
  const files: Record<string, string> = {};
  for (const [file, content] of state) files[file] = content;
  const v = createTempVault(files);
  vaults.push(v);
  let tick = 0;
  for (const file of state.keys()) {
    setMtime(path.join(v.vaultPath, file), tick++);
  }
  return v.vaultPath;
}

/** Apply one random mutation to the state and to the live vault. */
function mutate(
  state: VaultState,
  vaultPath: string,
  r: () => number,
  tick: number,
): void {
  const paths = [...state.keys()];
  const pick = paths[Math.floor(r() * paths.length)];
  const kind = r();

  if (kind < 0.4) {
    // Edit: same basename, new content — the incremental re-add path.
    const content = `# ${path.basename(pick, ".md")}\nedit ${tick}\n`;
    state.set(pick, content);
    fs.writeFileSync(path.join(vaultPath, pick), content);
    setMtime(path.join(vaultPath, pick), tick);
    return;
  }

  if (kind < 0.7) {
    // Rename: remove plus add, keeping a shared token in the new basename.
    const name = `${ADJECTIVES[Math.floor(r() * ADJECTIVES.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]} ${tick}`;
    const folder = pick.split("/")[0];
    const target = `${folder}/${name}.md`;
    fs.rmSync(path.join(vaultPath, pick));
    state.delete(pick);
    const content = `# ${name}\n`;
    state.set(target, content);
    fs.writeFileSync(path.join(vaultPath, target), content);
    setMtime(path.join(vaultPath, target), tick);
    return;
  }

  if (kind < 0.9) {
    fs.rmSync(path.join(vaultPath, pick));
    state.delete(pick);
    return;
  }

  // Add a note that was never indexed.
  const name = `${ADJECTIVES[Math.floor(r() * ADJECTIVES.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]} new`;
  const target = `Notes/${name}.md`;
  const content = `# ${name}\n`;
  state.set(target, content);
  fs.writeFileSync(path.join(vaultPath, target), content);
  setMtime(path.join(vaultPath, target), tick);
}

describe("random mutation parity with a cold build", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: incremental scores equal a cold build within ${EPSILON}`, () => {
      const state = initialState(seed);
      const vaultPath = materialize(state);
      const r = rng(seed * 7919);
      let tick = 100;

      // Three diffs in a row: a long-lived process churns between searches.
      for (let round = 0; round < 3; round++) {
        // Resolve the index before mutating, so the next call sees a diff.
        incrementalScores(vaultPath, "note");

        for (let i = 0; i < 6; i++) {
          mutate(state, vaultPath, r, tick++);
        }

        // The incremental index for this round's vault…
        const incremental = new Map(
          QUERIES.map((query) => [query, incrementalScores(vaultPath, query)]),
        );

        // …and a cold build of the same vault materialised in a fresh
        // directory: a different cache key with no snapshot on disk, so it
        // takes the cold path a brand-new process would take.
        const coldPath = materialize(state);
        for (const query of QUERIES) {
          expectSameScores(
            incremental.get(query) ?? new Map(),
            getBasenameScoresForTests(coldPath, coldPath, query),
            `seed ${seed} round ${round} "${query}"`,
          );
        }
      }
    });
  }
});

// ── Disk cache: the snapshot must not carry the drift (#100) ────

/** Flush the throttled cache write so a new process sees the latest state. */
function flushCacheWrite(): void {
  vi.advanceTimersByTime(30_000);
}

describe("disk cache snapshots keep BM25 statistics exact", () => {
  const OPTIONS = {
    fields: ["basename"],
    storeFields: ["file"],
    idField: "file",
    searchOptions: { boost: { basename: 2 }, fuzzy: 0.2, prefix: true },
  };

  test("a snapshot written after a diff loads into a cold-equivalent index", () => {
    vi.useFakeTimers();
    const v = makeVault({
      "daily note.md": "# Daily\n",
      "meeting note.md": "# Meeting\n",
      "project note.md": "# Project\n",
    });

    // Cold build writes the snapshot immediately; the edit is inside the
    // throttle window, so it flushes on the trailing timer.
    searchVault(v.vaultPath, v.vaultPath, "note", { snippets: false });
    const notePath = path.join(v.vaultPath, "project note.md");
    fs.writeFileSync(notePath, "# Project\nedited body text\n");
    setMtime(notePath, 1);
    incrementalScores(v.vaultPath, "note");
    flushCacheWrite();

    // A new process: only the snapshot on disk survives.
    resetSearchIndexForTests();
    const fromDisk = incrementalScores(v.vaultPath, "note");
    expectSameScores(
      fromDisk,
      coldScores(v.vaultPath, "note"),
      "note from a persisted snapshot",
    );
  });

  test("a snapshot carrying discarded docs is rebuilt instead of trusted", () => {
    const v = makeVault({
      "daily note.md": "# Daily\n",
      "meeting note.md": "# Meeting\n",
      "project note.md": "# Project\n",
    });
    searchVault(v.vaultPath, v.vaultPath, "note", { snippets: false });

    // Recreate a snapshot the way the pre-fix code wrote one: discard the old
    // version and re-add the doc, leaving stale posting entries behind.
    const cachePath = path.join(v.vaultPath, "search-cache.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const dirty = MiniSearch.loadJSON(raw.index, OPTIONS);
    const target = "project note.md";
    dirty.discard(target);
    dirty.add({ file: target, basename: "project note" });
    expect(dirty.dirtCount).toBe(1);
    raw.index = JSON.stringify(dirty);
    fs.writeFileSync(cachePath, JSON.stringify(raw));

    resetSearchIndexForTests();
    const fromDirtySnapshot = incrementalScores(v.vaultPath, "note");
    expectSameScores(
      fromDirtySnapshot,
      coldScores(v.vaultPath, "note"),
      "note from a dirty snapshot",
    );
  });
});
