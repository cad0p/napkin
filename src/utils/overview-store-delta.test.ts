import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, test } from "vitest";
import { originalGetOverview } from "../core/__tests__/overview-original.js";
import {
  _aggregateFolder,
  _lastOverviewSyncStats,
  getOverview,
} from "../core/overview.js";
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
 * Per-note deltas on the folder-term rows (#126). A miss on a stored folder
 * updates only the rows of the terms a changed note touches; every case
 * here is checked against a FULL REBUILD of the same vault state:
 *
 *   - the row tables, ord-independent: ft (w, lc, first-seen note PATH and
 *     position for both keys), cand in stored order (sec, o1, o2), dft,
 *     headrc, and the folder rows;
 *   - every folder's ordered cand rows against the _aggregateFolder oracle,
 *     and dft against a recount;
 *   - the overview JSON, byte-for-byte.
 */

type TempVault = { path: string; vaultPath: string; cleanup: () => void };
type Opts = Parameters<typeof getOverview>[2];
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

/** gray-matter memoizes parses (see overview.equivalence.test.ts). */
function isolated<T>(fn: () => T): T {
  matter.clearCache();
  return fn();
}

function overview(v: TempVault, opts?: Opts) {
  return isolated(() => getOverview(v.vaultPath, v.vaultPath, opts));
}

function rawDb(vaultPath: string) {
  const sqlite = loadSqlite();
  if (sqlite === null) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(
    path.join(vaultPath, "cache", "overview-v3.db"),
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

const depthOf = (f: string) => (f === "/" ? 0 : f.split("/").length);
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The row tables in an ord-independent form (order keys resolved to the
 * note path they point at; term ids resolved to text), restricted to the
 * folders at depth ≤ bound. Also asserts the ord invariant: within every
 * folder, ord order is the JS path-sort order and every key is set.
 */
function rowSnapshot(vaultPath: string, bound: number) {
  const db = rawDb(vaultPath);
  try {
    const notes = db
      .prepare("SELECT path, folder, ord FROM notes ORDER BY folder, ord")
      .all() as { path: string; folder: string; ord: number | null }[];
    const byFolder = new Map<string, string[]>();
    for (const n of notes) {
      expect(n.ord, `ord of ${n.path}`).not.toBeNull();
      const list = byFolder.get(n.folder) ?? [];
      list.push(n.path);
      byFolder.set(n.folder, list);
    }
    for (const [folder, list] of byFolder) {
      expect(list, `ord order of ${folder}`).toEqual(list.slice().sort());
    }
    const keep = (folder: string) => depthOf(folder) <= bound;
    const ft = (
      db
        .prepare(
          "SELECT d.path AS folder, t.term, f.w, f.lc, f.nord, f.hord, " +
            "n1.path AS np, f.npos, n2.path AS hp, f.hpos FROM ft f " +
            "JOIN fdir d ON d.fid = f.fid JOIN terms t ON t.id = f.tid " +
            "LEFT JOIN notes n1 ON n1.folder = d.path AND n1.ord = f.nord " +
            "LEFT JOIN notes n2 ON n2.folder = d.path AND n2.ord = f.hord",
        )
        .all() as {
        folder: string;
        term: string;
        w: number;
        lc: number;
        nord: number | null;
        hord: number | null;
        np: string | null;
        npos: number | null;
        hp: string | null;
        hpos: number | null;
      }[]
    )
      .filter((r) => keep(r.folder))
      .map((r) => {
        // A first-seen key always points at a stored note of the folder.
        if (r.nord !== null) expect(r.np, `nord of ${r.term}`).not.toBeNull();
        if (r.hord !== null) expect(r.hp, `hord of ${r.term}`).not.toBeNull();
        return [r.folder, r.term, r.w, r.lc, r.np, r.npos, r.hp, r.hpos];
      })
      .sort((a, b) => byKey(`${a[0]}\0${a[1]}`, `${b[0]}\0${b[1]}`));
    const cand = new Map<string, [string, number][]>();
    for (const r of db
      .prepare(
        "SELECT d.path AS folder, t.term, c.tf FROM cand c " +
          "JOIN fdir d ON d.fid = c.fid JOIN terms t ON t.id = c.tid " +
          "ORDER BY c.fid, c.sec, c.o1, c.o2",
      )
      .all() as { folder: string; term: string; tf: number }[]) {
      if (!keep(r.folder)) continue;
      const list = cand.get(r.folder) ?? [];
      list.push([r.term, r.tf]);
      cand.set(r.folder, list);
    }
    const dft = (
      db
        .prepare("SELECT t.term, d.n FROM dft d JOIN terms t ON t.id = d.tid")
        .all() as { term: string; n: number }[]
    )
      .map((r) => [r.term, r.n])
      .sort((a, b) => byKey(a[0] as string, b[0] as string));
    const headrc = (
      db
        .prepare(
          "SELECT d.path AS folder, h.text, h.n FROM headrc h " +
            "JOIN fdir d ON d.fid = h.fid",
        )
        .all() as { folder: string; text: string; n: number }[]
    )
      .filter((r) => keep(r.folder))
      .map((r) => [r.folder, r.text, r.n])
      .sort((a, b) => byKey(`${a[0]}\0${a[1]}`, `${b[0]}\0${b[1]}`));
    const folders = (
      db.prepare("SELECT path, notes, tags, warn FROM folders").all() as {
        path: string;
        notes: number;
        tags: string;
        warn: string;
      }[]
    )
      .filter((r) => keep(r.path))
      .map((r) => [r.path, r.notes, JSON.parse(r.tags).sort(), r.warn])
      .sort((a, b) => byKey(a[0] as string, b[0] as string));
    return {
      ft,
      cand: [...cand].sort((a, b) => byKey(a[0], b[0])),
      dft,
      headrc,
      folders,
    };
  } finally {
    db.close();
  }
}

/** Every folder's cand rows equal the oracle; dft equals a recount. */
function expectOracleConsistent(v: TempVault): void {
  const store = createOverviewStore(v.vaultPath) as SqliteOverviewStore;
  expect(store).not.toBeNull();
  const bound = store.metaState().dfDepth ?? 0;
  const byFolder = new Map<string, string[]>();
  for (const m of store.noteMeta()) {
    const list = byFolder.get(m.folder) ?? [];
    list.push(m.path);
    byFolder.set(m.folder, list);
  }
  const dfExpected = new Map<number, number>();
  for (const row of store.folderRows()) {
    const files = (byFolder.get(row.path) ?? []).slice().sort();
    const expected = _aggregateFolder(store, row.path, files, (file) => {
      const r = store.getNote(file);
      return {
        skip: r?.skip === 1,
        tags: JSON.parse(r?.tags ?? "[]") as string[],
        heads: JSON.parse(r?.heads ?? "[]") as [string, number[]][],
        data: r?.data == null ? null : i32(r.data),
      };
    });
    expect([...store.folderCandPairs(row.fid)], `cand of ${row.path}`).toEqual([
      ...expected.cand,
    ]);
    if (depthOf(row.path) <= bound) {
      for (const id of store.folderTfIds(row.fid)) {
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
}

let copies = 0;
/**
 * Run the incremental miss, then rebuild the same vault state from scratch
 * in a copy (so the incremental store keeps going) and compare rows,
 * oracle consistency and output.
 */
function expectMatchesRebuild(v: TempVault, opts?: Opts) {
  const incremental = overview(v, opts);
  const stats = { ..._lastOverviewSyncStats() };
  expectOracleConsistent(v);
  const bound = opts?.depth ?? 3;
  const copyRoot = `${v.path}-rebuild-${copies++}`;
  fs.cpSync(v.path, copyRoot, { recursive: true, preserveTimestamps: true });
  const copy = {
    path: copyRoot,
    vaultPath: path.join(copyRoot, path.basename(v.vaultPath)),
    cleanup: () => fs.rmSync(copyRoot, { recursive: true, force: true }),
  };
  vaults.push(copy);
  dropOverviewStoreFiles(copy.vaultPath);
  const cold = overview(copy, opts);
  expect(JSON.stringify(incremental)).toBe(JSON.stringify(cold));
  expect(rowSnapshot(v.vaultPath, bound)).toEqual(
    rowSnapshot(copy.vaultPath, bound),
  );
  return { incremental, stats };
}

function write(v: TempVault, file: string, content: string, mtime?: number) {
  const full = path.join(v.vaultPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mtime !== undefined) fs.utimesSync(full, mtime, mtime);
}

const FIXTURE: Record<string, string> = {
  "NAPKIN.md": "# Delta fixture\nContext note.",
  "alpha/a.md":
    "# Alpha intro\nzeta quorum lattice ferment\n## Shared plan\nshared words here\n## Unique onlyina\nbody of a",
  "alpha/b.md": "# Bravo\nquorum lattice braid\n## Shared plan\nbody of b",
  "alpha/c.md":
    "# Charlie\nzeta lattice braid ferment xylo\n## Zeta notes\nmore zeta here",
  "alpha/d.md":
    "# Delta\nlattice zeta ferment quorum xylo\n## Zeta notes\nsecond zeta",
  "beta/x.md": "# Xray\npayroll ledger invoices quarterly ledger",
  "beta/y.md": "# Yankee\nledger reconciliation journal audit",
  "deep/one/two/n.md": "# Deep\nabyssal trench bathysphere hadal pelagic",
  "deep/one/m.md": "# Mid\nabyssal reef lattice",
};

const OPTS = { depth: 3, keywords: 5, maxRows: 0, collapseDepth: 1 };

function base(): TempVault {
  const v = vault(FIXTURE);
  overview(v, OPTS);
  return v;
}

describe("overview per-note deltas (#126)", () => {
  test("orphaned first occurrence: non-heading and heading keys move to a later note", () => {
    const v = base();
    // a.md was the first occurrence of zeta/quorum/ferment and of the
    // "Shared plan" heading terms; all still occur later in the folder.
    write(v, "alpha/a.md", "# Alpha intro\nlattice only now\n## Other\nx");
    const { stats } = expectMatchesRebuild(v, OPTS);
    expect(stats.delta).toEqual(["alpha"]);
    expect(stats.whole).toEqual([]);
    expect(stats.orphanScans).toBeGreaterThan(0);
  });

  test("an orphan whose only later occurrence is the folder's last note", () => {
    const v = base();
    write(v, "alpha/c.md", "# Charlie\nlattice braid ferment");
    write(v, "alpha/a.md", "# Alpha intro\nlattice\n## Shared plan\nkept");
    const { stats } = expectMatchesRebuild(v, OPTS);
    expect(stats.orphanScans).toBeGreaterThan(0);
  });

  test("insert in the middle of a folder takes a midpoint ord", () => {
    const v = base();
    write(v, "alpha/b5.md", "# Between\nxylo newterm braid\n## Zeta notes\nz");
    const { stats } = expectMatchesRebuild(v, OPTS);
    expect(stats.delta).toEqual(["alpha"]);
    const db = rawDb(v.vaultPath);
    const ords = db
      .prepare(
        "SELECT path, ord FROM notes WHERE folder = 'alpha' ORDER BY ord",
      )
      .all() as { path: string; ord: number }[];
    db.close();
    expect(ords.map((r) => r.path)).toEqual([
      "alpha/a.md",
      "alpha/b.md",
      "alpha/b5.md",
      "alpha/c.md",
      "alpha/d.md",
    ]);
    expect(ords[2].ord).toBe(2 * ORD_GAP + ORD_GAP / 2);
  });

  test("append as the last note takes last + ORD_GAP", () => {
    const v = base();
    write(v, "alpha/z.md", "# Zulu\nquorum fresh tail");
    expectMatchesRebuild(v, OPTS);
    const db = rawDb(v.vaultPath);
    const row = db
      .prepare("SELECT ord FROM notes WHERE path = 'alpha/z.md'")
      .get() as { ord: number };
    db.close();
    expect(row.ord).toBe(5 * ORD_GAP);
  });

  test("delete: the first note, then the last", () => {
    const v = base();
    fs.rmSync(path.join(v.vaultPath, "alpha/a.md"));
    let r = expectMatchesRebuild(v, OPTS);
    expect(r.stats.delta).toEqual(["alpha"]);
    expect(r.stats.orphanScans).toBeGreaterThan(0);
    fs.rmSync(path.join(v.vaultPath, "alpha/d.md"));
    r = expectMatchesRebuild(v, OPTS);
    expect(r.stats.delta).toEqual(["alpha"]);
  });

  test("heading refcount 0→1 adds lc, 1→0 removes it", () => {
    const v = base();
    // 0→1: a brand-new heading text in b.md.
    write(
      v,
      "alpha/b.md",
      "# Bravo\nquorum lattice braid\n## Shared plan\nbody\n## Fresh lattice heading\nx",
    );
    expectMatchesRebuild(v, OPTS);
    // 1→0: a.md's unique heading goes (its heading-only term row dies), and
    // one of the two "Zeta notes" headings goes (2→1, lc unchanged).
    write(
      v,
      "alpha/a.md",
      "# Alpha intro\nzeta quorum lattice ferment\n## Shared plan\nshared words here",
    );
    write(v, "alpha/c.md", "# Charlie\nzeta lattice braid ferment xylo");
    expectMatchesRebuild(v, OPTS);
    const db = rawDb(v.vaultPath);
    const gone = db
      .prepare("SELECT count(*) AS n FROM headrc WHERE text = 'Unique onlyina'")
      .get() as { n: number };
    db.close();
    expect(gone.n).toBe(0);
  });

  test("a note edited into malformed frontmatter and back", () => {
    const v = base();
    write(v, "beta/x.md", "---\n  bad: [unclosed\n---\nmalformed body ledger");
    expectMatchesRebuild(v, OPTS);
    write(v, "beta/x.md", "# Xray\npayroll ledger invoices again");
    expectMatchesRebuild(v, OPTS);
  });

  test("folder add and folder remove", () => {
    const v = base();
    write(v, "gamma/new.md", "# Gamma\nlattice telescope collimation");
    write(v, "deep/one/two/three.md", "# Deeper sibling\nhadal trench");
    let r = expectMatchesRebuild(v, OPTS);
    expect(r.stats.whole).toEqual(["gamma"]);
    expect(r.stats.delta).toEqual(["deep/one/two"]);
    fs.rmSync(path.join(v.vaultPath, "beta"), { recursive: true });
    r = expectMatchesRebuild(v, OPTS);
    expect(r.stats.whole).toEqual([]);
  });

  test("maxDepth change recomputes dft under the new bound", () => {
    const v = base();
    write(v, "alpha/a.md", "# Alpha intro\nlattice abyssal reef");
    expectMatchesRebuild(v, { ...OPTS, depth: 2 });
    write(v, "deep/one/m.md", "# Mid\nabyssal reef lattice zeta");
    expectMatchesRebuild(v, { ...OPTS, depth: 1 });
    expectMatchesRebuild(v, OPTS);
  });

  test("ord-gap exhaustion renumbers the folder", () => {
    const v = vault({
      "gap/n-00.md": "# Start\nalpha beta gamma",
      "gap/n-99.md": "# End\nbeta gamma delta",
    });
    overview(v, OPTS);
    // 25 notes between the same two neighbours, in one run: each midpoint
    // halves the remaining gap, which runs out after twenty.
    for (let i = 1; i <= 25; i++) {
      write(
        v,
        `gap/n-${String(i).padStart(2, "0")}.md`,
        `# Note ${i}\nbeta term${i} ${i % 3 === 0 ? "delta" : "alpha"}\n## Head ${i % 4}\nx`,
      );
    }
    const r = expectMatchesRebuild(v, OPTS);
    expect(r.stats.renumbers).toBeGreaterThan(0);
    // And again across runs: insert before the renumbered first notes.
    for (let i = 0; i < 22; i++) {
      write(
        v,
        `gap/n-00-${String.fromCharCode(122 - i)}.md`,
        `# X\nalpha t${i}`,
      );
      const s = expectMatchesRebuild(v, OPTS);
      expect(s.stats.whole).toEqual([]);
    }
  });
});

// ─── streamed scoring window ───────────────────────────────────────────

describe("streamed top-3·keywords scoring window (#126)", () => {
  test("score ties and bigram suppression select exactly like the full sort", () => {
    const files: Record<string, string> = {
      "ties/one.md":
        "# One\nalpha beta gamma delta alpha beta gamma delta\nepsilon zeta eta theta",
      "ties/two.md":
        "# Two\nalpha beta gamma delta epsilon zeta eta theta\niota kappa lambda mu",
      "ties/three.md":
        "# Three\ngamma delta alpha beta iota kappa lambda mu nu xi",
      "other/a.md": "# Other\nalpha gamma epsilon iota nu",
      "other/b.md": "# More\nbeta delta zeta kappa xi",
      "third/c.md": "# Third\nalpha beta eta theta lambda",
    };
    const v = vault(files);
    for (const keywords of [1, 2, 3, 4, 6, 9]) {
      const opts = {
        depth: 2,
        keywords,
        collapse: false,
        collapseDepth: 1,
        maxRows: 0,
      };
      write(
        v,
        "ties/one.md",
        `${files["ties/one.md"]}\n${"x".repeat(keywords)}`,
      );
      const got = overview(v, opts);
      const want = isolated(() =>
        originalGetOverview(v.vaultPath, v.vaultPath, opts),
      );
      expect(JSON.stringify(got)).toBe(JSON.stringify(want));
    }
  });
});

// ─── depth-3 collapse equivalence ──────────────────────────────────────

describe("collapse stays identical across deltas (#126)", () => {
  const shared =
    "Lease agreement between landlord and tenant.\n" +
    "Bank guarantee and insurance certificate required.";
  const files: Record<string, string> = {
    "NAPKIN.md": "# Context\nCollapse fixture.",
    "proj/overview.md": "# Project\nportfolio lease summary",
  };
  for (let i = 0; i < 7; i++) {
    files[`proj/leases/tenant-${i}/contract.md`] =
      `# Converted document ${i}\n${shared}\nSuite ${100 + i}.`;
    files[`proj/leases/tenant-${i}/notes.md`] =
      `# Notes ${i}\n## Inspection\nboiler inspection ${i}`;
  }
  const topics = [
    "Kubernetes ingress routing and pod autoscaling.",
    "Payroll tax withholding for hourly contractors.",
    "Sourdough fermentation schedules and hydration.",
    "Telescope collimation for reflector optics.",
    "Beehive winterization and varroa treatment.",
  ];
  topics.forEach((body, i) => {
    files[`mixed/topic-${i}/note.md`] = `# Topic ${i}\n${body}`;
  });

  for (const collapseDepth of [1, 2]) {
    test(`depth 3, collapseDepth ${collapseDepth}: incremental ≡ rebuild ≡ original`, () => {
      const v = vault(files);
      const opts = {
        depth: 3,
        keywords: 6,
        collapse: true,
        collapseDepth,
        maxRows: 0,
      };
      const check = () => {
        const { incremental } = expectMatchesRebuild(v, opts);
        if (collapseDepth === 1) {
          const want = isolated(() =>
            originalGetOverview(v.vaultPath, v.vaultPath, opts),
          );
          expect(JSON.stringify(incremental)).toBe(JSON.stringify(want));
        }
        return incremental;
      };
      const first = check();
      expect(first.overview.some((f) => f.collapsedFolders !== undefined)).toBe(
        true,
      );
      write(
        v,
        "proj/leases/tenant-2/contract.md",
        `# Converted document 2\n${shared}\nSuite 102 amended rider.`,
      );
      check();
      write(
        v,
        "proj/leases/tenant-7/contract.md",
        `# Converted document 7\n${shared}\nSuite 107.`,
      );
      check();
      fs.rmSync(path.join(v.vaultPath, "proj/leases/tenant-0/contract.md"));
      check();
      write(v, "proj/leases/tenant-3/notes.md", "# Notes 3\nno inspection");
      check();
      write(v, "mixed/topic-1/note.md", `# Topic 1\n${shared}`);
      check();
    });
  }
});

// ─── property test: random edit sequences ≡ full rebuild ───────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "lattice quorum ferment braid zeta xylo ledger audit payroll trench reef " +
  "abyssal hadal telescope optics boiler lease tenant suite rider sourdough " +
  "hydration levain kubernetes ingress routing proxy mesh sidecar"
).split(" ");
const HEADINGS = [
  "Plan",
  "Shared plan",
  "Zeta notes",
  "Lattice review",
  "Open questions",
  "Ledger audit",
];
const FOLDERS = ["p", "q", "q/r", "q/r/s", "t/u", "/"];
const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h", "m", "z"];

function randomContent(rand: () => number): string {
  if (rand() < 0.05) return "---\n  bad: [unclosed\n---\nmalformed";
  const words = (n: number) =>
    Array.from(
      { length: n },
      () => WORDS[Math.floor(rand() * WORDS.length)],
    ).join(" ");
  let s =
    rand() < 0.3
      ? `---\ntitle: ${words(2)}\ntags: [t${Math.floor(rand() * 3)}]\n---\n`
      : "";
  s += `# ${words(2)}\n${words(1 + Math.floor(rand() * 8))}\n`;
  const nh = Math.floor(rand() * 3);
  for (let i = 0; i < nh; i++) {
    s += `## ${HEADINGS[Math.floor(rand() * HEADINGS.length)]}\n${words(Math.floor(rand() * 5))}\n`;
  }
  return s;
}

describe("random edit sequences ≡ full rebuild (#126)", () => {
  test("30 seeded sequences × 6 steps: rows, cand order, dft, headrc and output", () => {
    const rand = mulberry32(0x126);
    let clock = 1_700_000_000;
    for (let seq = 0; seq < 30; seq++) {
      const live = new Set<string>();
      const files: Record<string, string> = {};
      const nFiles = 4 + Math.floor(rand() * 8);
      for (let i = 0; i < nFiles; i++) {
        const folder = FOLDERS[Math.floor(rand() * FOLDERS.length)];
        const name = NAMES[Math.floor(rand() * NAMES.length)];
        const file = folder === "/" ? `${name}.md` : `${folder}/${name}.md`;
        files[file] = randomContent(rand);
        live.add(file);
      }
      const v = vault(files);
      const opts = {
        depth: 1 + Math.floor(rand() * 4),
        keywords: 3 + Math.floor(rand() * 4),
        collapse: rand() < 0.5,
        collapseDepth: 1,
        maxRows: 0,
      };
      overview(v, opts);
      for (let step = 0; step < 6; step++) {
        clock += 1000;
        const ops = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < ops; k++) {
          const r = rand();
          const existing = [...live];
          if (r < 0.35 || existing.length === 0) {
            const folder = FOLDERS[Math.floor(rand() * FOLDERS.length)];
            const name = NAMES[Math.floor(rand() * NAMES.length)];
            const file = folder === "/" ? `${name}.md` : `${folder}/${name}.md`;
            write(v, file, randomContent(rand), clock);
            live.add(file);
          } else if (r < 0.65) {
            const file = existing[Math.floor(rand() * existing.length)];
            write(v, file, randomContent(rand), clock);
          } else if (r < 0.8) {
            const file = existing[Math.floor(rand() * existing.length)];
            const full = path.join(v.vaultPath, file);
            fs.appendFileSync(
              full,
              `\n${WORDS[Math.floor(rand() * WORDS.length)]}\n`,
            );
            fs.utimesSync(full, clock, clock);
          } else if (r < 0.95) {
            const file = existing[Math.floor(rand() * existing.length)];
            fs.rmSync(path.join(v.vaultPath, file));
            live.delete(file);
          } else {
            const folder = FOLDERS[Math.floor(rand() * (FOLDERS.length - 1))];
            fs.rmSync(path.join(v.vaultPath, folder), {
              recursive: true,
              force: true,
            });
            for (const f of existing) {
              if (f.startsWith(`${folder}/`)) live.delete(f);
            }
          }
        }
        const { incremental } = expectMatchesRebuild(v, opts);
        if (step === 5) {
          const want = isolated(() =>
            originalGetOverview(v.vaultPath, v.vaultPath, opts),
          );
          expect(JSON.stringify(incremental)).toBe(JSON.stringify(want));
        }
      }
    }
  });
});
