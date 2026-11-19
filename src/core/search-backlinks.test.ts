import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listFiles } from "../utils/files.js";
import { loadIgnorer } from "../utils/ignore.js";
import { extractLinks } from "../utils/markdown.js";
import { createTempVault } from "../utils/test-helpers.js";
import {
  getCachedBacklinkCountsForTests,
  resetSearchIndexForTests,
  searchVault,
} from "./search.js";

const QUERY = "zzzz-no-such-token-zzzz";

let v: { path: string; vaultPath: string; cleanup: () => void };

afterEach(() => {
  resetSearchIndexForTests();
  v.cleanup();
});

function writeNote(relPath: string, targets: string[], tick: number): void {
  const full = path.join(v.vaultPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = targets.map((t) => `[[${t}]]`).join("\n");
  fs.writeFileSync(full, `# ${relPath}\n\n${body}\n`);
  // Explicit, strictly increasing mtimes: rapid same-tick edits can share
  // mtimeMs on some filesystems, and the diff falls back to size only.
  const stamp = new Date(2021, 0, 1, 0, 0, tick);
  fs.utimesSync(full, stamp, stamp);
}

function removeNote(relPath: string): void {
  fs.rmSync(path.join(v.vaultPath, relPath), { force: true });
}

/**
 * Independent reference: enumerate the vault, build the basename map with the
 * documented resolution rules (path-style = own spelling when the basename
 * exists; bare = shallowest path, lexical tie-break) and count every link.
 */
function referenceCounts(): Map<string, number> {
  const { ignorer } = loadIgnorer(v.vaultPath, v.vaultPath);
  const files = listFiles(v.vaultPath, { ext: "md", ignore: ignorer });

  const byKey = new Map<string, string[]>();
  for (const file of files) {
    const key = path.basename(file, ".md").toLowerCase();
    const paths = byKey.get(key);
    if (paths) paths.push(file);
    else byKey.set(key, [file]);
  }
  for (const paths of byKey.values()) {
    if (paths.length < 2) continue;
    paths.sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length;
      if (depth !== 0) return depth;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  const counts = new Map<string, number>();
  for (const file of files) {
    const content = fs.readFileSync(path.join(v.vaultPath, file), "utf-8");
    for (const target of extractLinks(content).wikilinks) {
      let resolved: string | null;
      if (target.includes("/") || target.endsWith(".md")) {
        const ref = target.endsWith(".md") ? target : `${target}.md`;
        const key = path.basename(ref, ".md").toLowerCase();
        resolved = byKey.has(key) ? ref : null;
      } else {
        resolved = byKey.get(target.toLowerCase())?.[0] ?? null;
      }
      if (resolved === null) continue;
      counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
    }
  }
  return counts;
}

function liveCounts(): Map<string, number> {
  const counts = getCachedBacklinkCountsForTests(v.vaultPath);
  if (!counts) throw new Error("no cached backlink counts");
  return counts;
}

/** Force a cold rebuild and return its counts: the strongest oracle. */
function coldCounts(): Map<string, number> {
  resetSearchIndexForTests();
  fs.rmSync(path.join(v.vaultPath, "search-cache.json"), { force: true });
  searchVault(v.vaultPath, v.vaultPath, QUERY);
  return liveCounts();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOLDERS = ["", "a", "b", "a/deep", "c", "b/deep"];
// "missing" and "path" let a path-style ref to a nonexistent file flip into
// existence (and back), which is the only way path refs move.
const NAMES = [
  "note",
  "hub",
  "index",
  "orphan",
  "alpha",
  "new",
  "missing",
  "path",
];

/** Enough unrelated notes that a one-file diff stays on the delta path. */
function fillers(count = 8): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) files[`fill/f${i}.md`] = `# filler ${i}\n`;
  return files;
}
const TARGETS = [
  "note",
  "hub",
  "index",
  "orphan",
  "alpha",
  "new",
  "missing",
  "a/note",
  "b/note",
  "a/deep/note",
  "a/note.md",
  "b/hub",
  "c/alpha",
  "missing/path",
  "Note",
  "HUB",
  "orphan.md",
];

function initialVault(): Map<string, string[]> {
  const state = new Map<string, string[]>();
  state.set("index.md", ["note", "hub", "a/note"]);
  state.set("orphan.md", ["note", "note", "index"]);
  state.set("a/note.md", ["hub", "a/note", "missing"]);
  state.set("b/note.md", ["note", "b/hub"]);
  state.set("a/deep/note.md", ["note", "orphan"]);
  state.set("a/hub.md", ["note", "index"]);
  state.set("b/hub.md", ["hub", "hub", "a/hub"]);
  state.set("a/alpha.md", ["alpha", "index"]);
  state.set("b/alpha.md", ["a/alpha", "orphan"]);
  state.set("c/alpha.md", ["alpha", "note"]);
  for (let i = 0; i < 12; i++) {
    state.set(`c/n${i}.md`, [TARGETS[i % TARGETS.length], "index"]);
  }
  for (let i = 0; i < 4; i++) {
    state.set(`a/deep/d${i}.md`, [TARGETS[(i + 3) % TARGETS.length]]);
  }
  return state;
}

describe("backlink counts by delta (#92)", () => {
  test("randomised add/edit/delete/rename matches a full recompute", () => {
    v = createTempVault();
    const state = initialVault();
    let tick = 0;
    for (const [relPath, targets] of state) {
      writeNote(relPath, targets, ++tick);
    }

    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts()).toEqual(referenceCounts());

    const rand = mulberry32(92);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const randomLinks = (self: string | null): string[] => {
      const n = Math.floor(rand() * 5);
      const links: string[] = [];
      for (let i = 0; i < n; i++) {
        // Sometimes link to this very note (bare or path) or repeat a link.
        if (self && rand() < 0.15) {
          links.push(rand() < 0.5 ? path.basename(self, ".md") : self);
        } else if (links.length > 0 && rand() < 0.2) {
          links.push(links[links.length - 1]);
        } else {
          links.push(pick(TARGETS));
        }
      }
      return links;
    };

    const ops = { add: 0, edit: 0, delete: 0, rename: 0 };
    for (let step = 0; step < 80; step++) {
      const files = [...state.keys()];
      const roll = rand();
      if (roll < 0.3 || files.length === 0) {
        const relPath = `${pick(FOLDERS)}/${pick(NAMES)}.md`.replace(/^\//, "");
        const links = randomLinks(relPath);
        state.set(relPath, links);
        writeNote(relPath, links, ++tick);
        ops.add++;
      } else if (roll < 0.7) {
        const relPath = pick(files);
        const links = randomLinks(relPath);
        state.set(relPath, links);
        writeNote(relPath, links, ++tick);
        ops.edit++;
      } else if (roll < 0.85 && files.length > 1) {
        const relPath = pick(files);
        state.delete(relPath);
        removeNote(relPath);
        ops.delete++;
      } else {
        const relPath = pick(files);
        const next = `${pick(FOLDERS)}/${pick(NAMES)}.md`.replace(/^\//, "");
        if (state.has(next)) continue;
        const links = randomLinks(next);
        state.delete(relPath);
        removeNote(relPath);
        state.set(next, links);
        writeNote(next, links, ++tick);
        ops.rename++;
      }

      searchVault(v.vaultPath, v.vaultPath, QUERY);
      expect(liveCounts(), `step ${step}`).toEqual(referenceCounts());

      // Periodically rebuild from disk: keeps the oracle external and
      // catches drift the in-process reference cannot see.
      if (step % 20 === 19 || step === 79) {
        expect(coldCounts(), `cold step ${step}`).toEqual(referenceCounts());
      }
    }

    for (const [op, n] of Object.entries(ops)) {
      expect(n, `${op} operations exercised`).toBeGreaterThan(0);
    }
  });

  test("a large change set falls back to a full recompute", () => {
    v = createTempVault();
    const state = initialVault();
    let tick = 0;
    for (const [relPath, targets] of state) {
      writeNote(relPath, targets, ++tick);
    }
    searchVault(v.vaultPath, v.vaultPath, QUERY);

    // 20 existing notes: adding 16 at once is well past the 1/8 threshold.
    for (let i = 0; i < 16; i++) {
      const relPath = `bulk/b${i}.md`;
      const links = ["note", "index", "b/hub", `bulk/b${i}`];
      state.set(relPath, links);
      writeNote(relPath, links, ++tick);
    }
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts()).toEqual(referenceCounts());
    expect(coldCounts()).toEqual(referenceCounts());
  });

  test("duplicates count twice, self-links count, case folds", () => {
    v = createTempVault({
      ...fillers(),
      "a/target.md": "# t\n",
      "b/target.md": "# t\n",
      "src/one.md": "[[target]] [[target]] [[Target]]\n",
      "src/two.md": "[[target.md]] [[a/target]] [[src/one]]\n",
    });
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts()).toEqual(
      new Map([
        // Three bare [[target]] links land on the shallowest collision.
        ["a/target.md", 4],
        // [[target.md]] is a path-style ref and keeps its own spelling.
        ["target.md", 1],
        // [[src/one]] is the self-link-equivalent path ref.
        ["src/one.md", 1],
      ]),
    );
    expect(liveCounts()).toEqual(referenceCounts());
  });

  test("a new shallower note re-points bare links and re-points back", () => {
    // 11 docs: a single add/remove stays below the 1/8 full-rebuild floor.
    v = createTempVault({
      ...fillers(),
      "a/note.md": "# a\n",
      "b/note.md": "# b\n",
      "src/linker.md": "[[note]]\n",
    });
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts().get("a/note.md")).toBe(1);
    expect(liveCounts().get("b/note.md")).toBeUndefined();

    // Shallower collision wins.
    writeNote("note.md", [], 100);
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts().get("note.md")).toBe(1);
    expect(liveCounts().get("a/note.md")).toBeUndefined();

    // Removing it gives the count back to the next shallowest.
    removeNote("note.md");
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts().get("a/note.md")).toBe(1);
    expect(liveCounts()).toEqual(referenceCounts());
  });

  test("a link to a missing note starts counting when it appears", () => {
    v = createTempVault({
      ...fillers(),
      "src/linker.md": "[[later]] [[later]]\n",
    });
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts().size).toBe(0);

    writeNote("later.md", [], 100);
    searchVault(v.vaultPath, v.vaultPath, QUERY);
    expect(liveCounts().get("later.md")).toBe(2);
  });

  test("counts are derived on load, not trusted from the snapshot", () => {
    vi.useFakeTimers();
    try {
      v = createTempVault({
        ...fillers(),
        "a/note.md": "# a\n",
        "src/linker.md": "[[note]] [[note]]\n",
      });
      searchVault(v.vaultPath, v.vaultPath, QUERY);
      vi.advanceTimersByTime(30_000);

      // A stale or pre-#92 snapshot must not seed the delta bookkeeping.
      const cachePath = path.join(v.vaultPath, "search-cache.json");
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      raw.backlinkCounts = { "a/note.md": 999 };
      fs.writeFileSync(cachePath, JSON.stringify(raw));

      resetSearchIndexForTests();
      searchVault(v.vaultPath, v.vaultPath, QUERY);
      expect(liveCounts().get("a/note.md")).toBe(2);
      expect(liveCounts()).toEqual(referenceCounts());
    } finally {
      vi.useRealTimers();
    }
  });

  test("counters survive a disk-cache reload", () => {
    vi.useFakeTimers();
    try {
      v = createTempVault();
      const state = initialVault();
      let tick = 0;
      for (const [relPath, targets] of state) {
        writeNote(relPath, targets, ++tick);
      }
      searchVault(v.vaultPath, v.vaultPath, QUERY);

      writeNote("a/note.md", ["hub", "index"], ++tick);
      searchVault(v.vaultPath, v.vaultPath, QUERY);
      vi.advanceTimersByTime(30_000);

      // New process: only the disk snapshot (and its outgoing links) exists.
      resetSearchIndexForTests();
      searchVault(v.vaultPath, v.vaultPath, QUERY);
      expect(liveCounts()).toEqual(referenceCounts());

      // The next diff starts from counters derived at load time.
      writeNote("b/hub.md", ["note", "a/note"], ++tick);
      searchVault(v.vaultPath, v.vaultPath, QUERY);
      expect(liveCounts()).toEqual(referenceCounts());
      expect(coldCounts()).toEqual(referenceCounts());
    } finally {
      vi.useRealTimers();
    }
  });
});
