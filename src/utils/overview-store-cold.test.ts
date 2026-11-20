import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { afterEach, describe, expect, test } from "vitest";
import { originalGetOverview } from "../core/__tests__/overview-original.js";
import {
  _lastOverviewSyncStats,
  getOverview,
  setOverviewColdBatchForTests,
} from "../core/overview.js";
import {
  coldFilterForTests,
  createOverviewStore,
  type SqliteOverviewStore,
  setOverviewColdFilterBitsForTests,
} from "./overview-store.js";
import { loadSqlite } from "./sqlite-loader.js";
import {
  createTempVault,
  dropOverviewStoreFiles,
  resetOverviewIndexForTests,
} from "./test-helpers.js";

/**
 * The cold batch build (#131): a whole store rebuilt folder by folder in
 * batches, interned through SQL with no in-memory dictionary. Its rows and
 * output must equal a warm (incrementally built) store's and the original
 * implementation's, whatever the batch bounds and however saturated the
 * cold Bloom filter is; and a ~30k-note vault must build cold under a
 * 200 MB old-space cap.
 */

type TempVault = { path: string; vaultPath: string; cleanup: () => void };
type Opts = Parameters<typeof getOverview>[2];
const vaults: TempVault[] = [];

afterEach(() => {
  setOverviewColdBatchForTests();
  setOverviewColdFilterBitsForTests();
  resetOverviewIndexForTests();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(files: Record<string, string>): TempVault {
  const v = createTempVault(files);
  vaults.push(v);
  return v;
}

function overview(v: TempVault, opts?: Opts) {
  matter.clearCache();
  return getOverview(v.vaultPath, v.vaultPath, opts);
}

function write(v: TempVault, file: string, content: string) {
  const full = path.join(v.vaultPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Row tables in an id- and ord-independent form (terms as text, first-
 *  seen keys as note paths), plus dictionary sanity. */
function rows(vaultPath: string) {
  const sqlite = loadSqlite();
  if (sqlite === null) throw new Error("node:sqlite unavailable");
  const db = new sqlite.DatabaseSync(
    path.join(vaultPath, "cache", "overview-v3.db"),
    { readOnly: true },
  );
  try {
    const dict = db
      .prepare("SELECT count(*) AS n, count(DISTINCT term) AS d FROM terms")
      .get() as { n: number; d: number };
    expect(dict.n, "no term interned twice").toBe(dict.d);
    const ft = (
      db
        .prepare(
          "SELECT d.path AS folder, t.term, f.w, f.lc, n1.path AS np, f.npos, " +
            "n2.path AS hp, f.hpos FROM ft f JOIN fdir d ON d.fid = f.fid " +
            "JOIN terms t ON t.id = f.tid " +
            "LEFT JOIN notes n1 ON n1.folder = d.path AND n1.ord = f.nord " +
            "LEFT JOIN notes n2 ON n2.folder = d.path AND n2.ord = f.hord",
        )
        .all() as Record<string, unknown>[]
    )
      .map((r) => JSON.stringify(Object.values(r)))
      .sort(byKey);
    const cand = (
      db
        .prepare(
          "SELECT d.path AS folder, t.term, c.tf FROM cand c " +
            "JOIN fdir d ON d.fid = c.fid JOIN terms t ON t.id = c.tid " +
            "ORDER BY d.path, c.sec, c.o1, c.o2",
        )
        .all() as Record<string, unknown>[]
    ).map((r) => JSON.stringify(Object.values(r)));
    const dft = (
      db
        .prepare("SELECT t.term, d.n FROM dft d JOIN terms t ON t.id = d.tid")
        .all() as Record<string, unknown>[]
    )
      .map((r) => JSON.stringify(Object.values(r)))
      .sort(byKey);
    const headrc = (
      db
        .prepare(
          "SELECT d.path, h.text, h.n FROM headrc h JOIN fdir d ON d.fid = h.fid",
        )
        .all() as Record<string, unknown>[]
    )
      .map((r) => JSON.stringify(Object.values(r)))
      .sort(byKey);
    return { ft, cand, dft, headrc };
  } finally {
    db.close();
  }
}

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

/** Collapse groups (homogeneous and mixed siblings), headings repeated
 *  across notes, bigrams, a malformed note, and enough random words that a
 *  tiny batch bound splits every folder into many batches. */
function fixture(): Record<string, string> {
  const rand = mulberry32(131);
  const vocab = Array.from({ length: 300 }, (_, i) =>
    (i * 7919).toString(36).replace(/[0-9]/g, (d) => "qwxyzjkvbp"[Number(d)]),
  ).filter((w) => w.length >= 3);
  const words = (n: number) =>
    Array.from(
      { length: n },
      () => vocab[Math.floor(rand() * vocab.length)],
    ).join(" ");
  const shared =
    "Lease agreement between landlord and tenant.\n" +
    "Bank guarantee and insurance certificate required.";
  const files: Record<string, string> = {
    "NAPKIN.md": "# Context\nCold fixture.",
    "proj/overview.md": "# Project\nportfolio lease summary",
    "notes/broken.md": "---\n  bad: [unclosed\n---\nmalformed",
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
  const heads = ["Plan", "Shared plan", "Open questions", "Review"];
  for (const folder of ["notes", "notes/deep", "log", "/"]) {
    for (let i = 0; i < 12; i++) {
      const name = `${folder === "/" ? "" : `${folder}/`}n${String(i).padStart(2, "0")}.md`;
      let s =
        i % 4 === 0 ? `---\ntitle: ${words(2)}\ntags: [t${i % 3}]\n---\n` : "";
      s += `# ${words(2)}\n${words(20)}\n`;
      s += `## ${heads[i % heads.length]}\n${words(10)}\n`;
      s += `## ${heads[(i + 1) % heads.length]}\n${words(6)} ${words(2)} ${words(2)}\n`;
      files[name] = s;
    }
  }
  return files;
}

const CONFIGS: { name: string; opts: Opts; oracle: boolean }[] = [
  {
    name: "collapse, collapseDepth 1, maxRows 0",
    opts: {
      depth: 3,
      keywords: 6,
      collapse: true,
      collapseDepth: 1,
      maxRows: 0,
    },
    oracle: true,
  },
  {
    name: "collapse, collapseDepth 2, maxRows 0",
    opts: {
      depth: 3,
      keywords: 6,
      collapse: true,
      collapseDepth: 2,
      maxRows: 0,
    },
    oracle: false,
  },
  {
    name: "no collapse, maxRows 0",
    opts: { depth: 3, keywords: 5, collapse: false, maxRows: 0 },
    oracle: true,
  },
  {
    name: "depth 2, maxRows 4",
    opts: {
      depth: 2,
      keywords: 4,
      collapse: true,
      collapseDepth: 1,
      maxRows: 4,
    },
    // The original predates the fork's maxRows cap.
    oracle: false,
  },
];

describe("cold batch build (#131)", () => {
  for (const { name, opts, oracle } of CONFIGS) {
    test(`${name}: cold ≡ cold in tiny batches ≡ warm ≡ original`, () => {
      const files = fixture();
      // Cold, default bounds.
      const cold = vault(files);
      const coldOut = JSON.stringify(overview(cold, opts));
      expect(_lastOverviewSyncStats().whole.length).toBeGreaterThan(0);
      const coldRows = rows(cold.vaultPath);

      // Cold in batches of 2 notes / 8 terms with a saturated 64-bit
      // filter: every folder splits into many batches and every term is
      // a filter "maybe" (a lookup that mostly misses).
      setOverviewColdBatchForTests(2, 8);
      setOverviewColdFilterBitsForTests(64);
      const tiny = vault(files);
      expect(JSON.stringify(overview(tiny, opts))).toBe(coldOut);
      expect(_lastOverviewSyncStats().whole.length).toBeGreaterThan(0);
      expect(rows(tiny.vaultPath)).toEqual(coldRows);
      setOverviewColdBatchForTests();
      setOverviewColdFilterBitsForTests();

      // Warm: half the notes first, then the rest arrive as per-note
      // deltas (stored folders) and whole-folder builds (new folders).
      const names = Object.keys(files).sort();
      const first: Record<string, string> = {};
      names.forEach((n, i) => {
        if (i % 2 === 0 || n === "NAPKIN.md") first[n] = files[n];
      });
      const warm = vault(first);
      overview(warm, opts);
      for (const n of names) if (!(n in first)) write(warm, n, files[n]);
      expect(JSON.stringify(overview(warm, opts))).toBe(coldOut);
      expect(_lastOverviewSyncStats().delta.length).toBeGreaterThan(0);
      expect(rows(warm.vaultPath)).toEqual(coldRows);

      if (oracle) {
        matter.clearCache();
        const want = originalGetOverview(cold.vaultPath, cold.vaultPath, opts);
        expect(coldOut).toBe(JSON.stringify(want));
      }

      // A forced rebuild of the warm store is cold again.
      dropOverviewStoreFiles(warm.vaultPath);
      resetOverviewIndexForTests();
      expect(JSON.stringify(overview(warm, opts))).toBe(coldOut);
    });
  }

  test("the cold Bloom filter has no false negatives", () => {
    const rand = mulberry32(7);
    const f = coldFilterForTests.create(1 << 16);
    const added: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      const len = 1 + Math.floor(rand() * 24);
      let s = "";
      for (let j = 0; j < len; j++) {
        // ASCII letters, spaces (bigrams) and some non-Latin code units.
        const r = rand();
        s += String.fromCharCode(
          r < 0.8
            ? 97 + Math.floor(rand() * 26)
            : r < 0.9
              ? 32
              : 0x3b1 + Math.floor(rand() * 900),
        );
      }
      coldFilterForTests.add(f, s);
      added.push(s);
    }
    for (const s of added) expect(coldFilterForTests.has(f, s)).toBe(true);
    // A sparse filter still rules out most unseen terms (it is useful).
    const fresh = coldFilterForTests.create(1 << 20);
    for (const s of added.slice(0, 1000)) coldFilterForTests.add(fresh, s);
    let maybe = 0;
    for (let i = 0; i < 1000; i++) {
      if (coldFilterForTests.has(fresh, `unseen term ${i}`)) maybe++;
    }
    expect(maybe).toBeLessThan(10);
  });

  test("internList gives a repeated term one id (no UNIQUE failure)", () => {
    const v = vault(fixture());
    overview(v);
    const store = createOverviewStore(v.vaultPath) as SqliteOverviewStore;
    expect(store).not.toBeNull();
    const before = store.maxTermId();
    const g = store.internList(["zz dup", "zz other", "zz dup"]);
    expect(g[0]).toBe(g[2]);
    expect(g[1]).not.toBe(g[0]);
    expect(Math.min(...g)).toBeGreaterThan(before);
    expect(store.maxTermId()).toBe(before + 2);
    // Interning again finds both: no new ids.
    expect([...store.internList(["zz other", "zz dup"])]).toEqual([g[1], g[0]]);
    expect(store.maxTermId()).toBe(before + 2);
    resetOverviewIndexForTests();
    // rows() asserts no term is stored twice.
    rows(v.vaultPath);
  });

  test("a store without the terms(term) index gets it back, and a miss still commits", () => {
    const v = vault(fixture());
    const first = JSON.stringify(overview(v));
    resetOverviewIndexForTests();
    const dbFile = path.join(v.vaultPath, "cache", "overview-v3.db");
    const sqlite = loadSqlite();
    if (sqlite === null) throw new Error("node:sqlite unavailable");
    const indexed = (): boolean => {
      const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        return (
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'terms_term'",
            )
            .get() !== undefined
        );
      } finally {
        db.close();
      }
    };
    expect(indexed()).toBe(true);
    const db = new sqlite.DatabaseSync(dbFile);
    try {
      db.exec("DROP INDEX terms_term");
    } finally {
      db.close();
    }
    expect(indexed()).toBe(false);

    // A cache hit needs no interning and must not change anything.
    expect(JSON.stringify(overview(v))).toBe(first);

    // A miss: a new note with a term no other note has.
    const folder = Object.keys(fixture())
      .filter((n) => n.includes("/"))
      .sort()[0]
      .split("/")[0];
    write(
      v,
      `${folder}/zz-new.md`,
      "# Quokkasaurus\n\nquokkasaurus quokkasaurus\n",
    );
    overview(v);
    expect(_lastOverviewSyncStats().delta).toContain(folder);
    resetOverviewIndexForTests();
    expect(indexed()).toBe(true);
    const check = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    try {
      const hit = check
        .prepare("SELECT count(*) AS n FROM terms WHERE term = 'quokkasaurus'")
        .get() as { n: number };
      expect(hit.n).toBe(1);
    } finally {
      check.close();
    }
  });
});

// ─── memory regression: a ~30k-note cold build under a 200 MB heap cap ───

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("cold build memory (#131)", () => {
  test("30k notes, ~1.5M distinct terms, build cold under --max-old-space-size=200", () => {
    // 30,000 short notes in 60 folders. Each note is 45 words drawn from
    // 150k pseudo-words, so almost every bigram is new: the dictionary
    // reaches ~1.5M terms (the 29.5k-note reference vault has 1.45M).
    // Measured: the pre-#131 cold path (a whole-vault in-memory
    // dictionary) aborts with a heap OOM under this cap at 45 words per
    // note, the batch path peaks at ~140 MB RSS.
    const v = vault({});
    const rand = mulberry32(30_000);
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const word = (i: number) => {
      let s = "";
      for (let n = i + 26 * 26 * 26; n > 0; n = Math.floor(n / 26)) {
        s += letters[n % 26];
      }
      return `${s}ographic`;
    };
    for (let f = 0; f < 60; f++) {
      const dir = path.join(
        v.vaultPath,
        f < 30 ? `area${f}` : `area${f - 30}/sub`,
      );
      fs.mkdirSync(dir, { recursive: true });
      for (let n = 0; n < 500; n++) {
        const ws: string[] = [];
        for (let k = 0; k < 45; k++) {
          ws.push(word(Math.floor(rand() * 150_000)));
        }
        fs.writeFileSync(
          path.join(dir, `note${n}.md`),
          `# ${ws[0]} ${ws[1]}\n${ws.join(" ")}\n`,
        );
      }
    }
    const overviewUrl = pathToFileURL(
      path.join(ROOT, "src", "core", "overview.ts"),
    ).href;
    const script =
      `const { getOverview, _lastOverviewSyncStats } = await import(${JSON.stringify(overviewUrl)});` +
      `const r = getOverview(${JSON.stringify(v.vaultPath)}, ${JSON.stringify(v.vaultPath)}, { depth: 2, maxRows: 100 });` +
      "const s = _lastOverviewSyncStats();" +
      "console.log(JSON.stringify({ rows: r.overview.length, whole: s.whole.length, warnings: r.warnings ?? [] }));";
    const out = execFileSync(
      process.execPath,
      [
        "--max-old-space-size=200",
        "--max-semi-space-size=2",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, MALLOC_ARENA_MAX: "1" },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 170_000,
      },
    );
    const result = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    // Every folder was built through the SQLite store (no JSON fallback).
    expect(result).toEqual({ rows: 60, whole: 60, warnings: [] });
    const sqlite = loadSqlite();
    if (sqlite === null) throw new Error("node:sqlite unavailable");
    const db = new sqlite.DatabaseSync(
      path.join(v.vaultPath, "cache", "overview-v3.db"),
      { readOnly: true },
    );
    try {
      const n = db.prepare("SELECT count(*) AS n FROM terms").get() as {
        n: number;
      };
      expect(n.n).toBeGreaterThan(1_300_000);
    } finally {
      db.close();
    }
  }, 180_000);
});
