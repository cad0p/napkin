import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createTempVault,
  dropOverviewStoreFiles,
  useJsonOverviewStore,
} from "../utils/test-helpers.js";
import { getOverview } from "./overview.js";

/**
 * Incremental-path tests: the per-folder cache must be indistinguishable from
 * a cold computation.
 *
 * Every test computes the overview once (cold, writing the cache), mutates the
 * vault, computes again (where the per-folder layer decides what to rebuild),
 * then clears both cache files and recomputes cold on the mutated vault. The
 * incremental result must deep-equal the cold one — for edits, adds, removes,
 * folder deletes/adds, option changes, and ignore-rule changes.
 *
 * #118 moved the default per-folder store to SQLite
 * (.napkin/cache/overview-v3.db). Tests that assert on the JSON cache FILE
 * (overview-folders-cache.json — its bytes, its mtime, its compaction) pin the
 * vault to the JSON fallback via useJsonOverviewStore; behavioral tests run
 * the default store. overview-store.test.ts covers the SQLite side directly.
 *
 * Notes are well-formed markdown on purpose: gray-matter memoizes by content
 * string (see overview.equivalence.test.ts), so re-parsing identical content
 * is deterministic only when nothing throws. The malformed-frontmatter path
 * is covered separately, through the warnings-assembly test below.
 */

const FIXTURE: Record<string, string> = {
  "NAPKIN.md": "# Fixture project\nContext note for the incremental vault.",
  "alpha/kubernetes.md":
    "# Cluster\nkubernetes ingress routing autoscaling telemetry dashboards",
  "alpha/mesh.md":
    "# Mesh\nkubernetes service mesh sidecar proxies observability tracing",
  "beta/payroll.md":
    "# Payroll\npayroll withholding contractors ledger invoices quarterly",
  "beta/ledger.md":
    "# Ledger\ndouble entry ledger reconciliation journal corrections audit",
  "gamma/sourdough.md":
    "# Sourdough\nfermentation hydration levain schedules starter feeding",
};

// Six homogeneous siblings: exercises the collapse merge, which sums the
// per-folder maps (a place cached data could silently diverge).
const SHARED = [
  "Lease agreement between landlord and tenant with signature page.",
  "Rent schedule and lease term apply as stated in the appendix.",
  "Bank guarantee and insurance certificate required before occupancy.",
];
for (let i = 0; i < 6; i++) {
  FIXTURE[`imports/tenant-${i}/contract.md`] =
    `# Converted document ${i}\n${SHARED.filter((_, j) => j !== i % 3).join("\n")}\nSuite ${100 + i}.`;
}

const RESULT_CACHE = "overview-cache.json";
const FOLDERS_CACHE = "overview-folders-cache.json";

function cacheFiles(vaultPath: string): { result: string; folders: string } {
  return {
    result: path.join(vaultPath, RESULT_CACHE),
    folders: path.join(vaultPath, FOLDERS_CACHE),
  };
}

/** Cold recomputation of the current vault state: all caches removed first. */
function cold(vaultPath: string, opts?: Parameters<typeof getOverview>[2]) {
  dropOverviewStoreFiles(vaultPath);
  return getOverview(vaultPath, vaultPath, opts);
}

interface CachedEntryShape {
  sig: string;
  n: number;
  tf: number[];
  body: number[];
  head: number[];
  headOnly: number[];
  tags: string[];
  warn: string[];
}

/** The persisted per-folder cache, as written to disk. */
function readFoldersCache(vaultPath: string): {
  terms: string[];
  folders: Record<string, CachedEntryShape>;
} {
  return JSON.parse(fs.readFileSync(cacheFiles(vaultPath).folders, "utf-8"));
}

/**
 * Semantic view of a cache entry: dictionary indices resolved to terms, so
 * two encodings of the same FolderData compare equal (rebuilding one folder
 * interns new terms and compacts the dictionary, which renumbers indices
 * without changing what any entry means).
 */
function decodeEntry(entry: CachedEntryShape, terms: string[]) {
  const pairs = (flat: number[]) => {
    const out: [string, number][] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push([terms[flat[i]], flat[i + 1]]);
    }
    return out;
  };
  return {
    sig: entry.sig,
    n: entry.n,
    tf: pairs(entry.tf),
    body: pairs(entry.body),
    head: pairs(entry.head),
    headOnly: entry.headOnly.map((index) => terms[index]),
    tags: entry.tags,
    warn: entry.warn,
  };
}

function writeNote(vaultPath: string, file: string, content: string): void {
  const full = path.join(vaultPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

type Mutation = {
  name: string;
  apply: (vaultPath: string) => void;
  /** Folder expected to be rebuilt by the mutation. */
  rebuilt: string;
};

const MUTATIONS: Mutation[] = [
  {
    name: "edit a note in an existing folder",
    apply: (v) =>
      writeNote(
        v,
        "alpha/kubernetes.md",
        "# Cluster\nkubernetes ingress routing sourdough fermentation hydration",
      ),
    rebuilt: "alpha",
  },
  {
    name: "add a note to an existing folder",
    apply: (v) =>
      writeNote(
        v,
        "beta/invoices.md",
        "# Invoices\ninvoice numbering dunning reminders reconciliation",
      ),
    rebuilt: "beta",
  },
  {
    name: "delete a note, leaving the folder in place",
    apply: (v) => fs.rmSync(path.join(v, "gamma/sourdough.md")),
    rebuilt: "gamma",
  },
  {
    name: "delete every note in a folder (the folder disappears)",
    apply: (v) => fs.rmSync(path.join(v, "gamma"), { recursive: true }),
    rebuilt: "gamma",
  },
  {
    name: "add a new folder",
    apply: (v) =>
      writeNote(
        v,
        "delta/telescope.md",
        "# Optics\ntelescope collimation reflector focal ratio astrophotography",
      ),
    rebuilt: "delta",
  },
];

describe("per-folder overview cache", () => {
  test.each(MUTATIONS)(
    "one folder changed ($name): incremental ≡ cold",
    ({ apply, rebuilt }) => {
      const vault = createTempVault(FIXTURE);
      // White-box assertions read the JSON cache file — pin the fallback.
      useJsonOverviewStore(vault.vaultPath);
      try {
        const before = getOverview(vault.vaultPath, vault.vaultPath);
        expect(before.overview.length).toBeGreaterThan(0);
        const cacheBefore = readFoldersCache(vault.vaultPath);

        apply(vault.vaultPath);
        const incremental = getOverview(vault.vaultPath, vault.vaultPath);

        const coldResult = cold(vault.vaultPath);
        // JSON-level equality: byte-identical output, list order included.
        expect(JSON.stringify(incremental)).toBe(JSON.stringify(coldResult));
        expect(incremental).toEqual(coldResult);

        // The white-box half: the untouched folders kept their cached
        // FolderData (semantically identical — the dictionary may renumber),
        // and the changed folder's fingerprint moved.
        const cacheAfter = readFoldersCache(vault.vaultPath);
        for (const folder of [
          "alpha",
          "beta",
          "gamma",
          "imports/tenant-0",
          "imports/tenant-5",
        ]) {
          if (folder === rebuilt) continue;
          if (!(folder in cacheAfter.folders)) continue;
          expect(
            decodeEntry(cacheAfter.folders[folder], cacheAfter.terms),
          ).toEqual(
            decodeEntry(cacheBefore.folders[folder], cacheBefore.terms),
          );
        }
      } finally {
        vault.cleanup();
      }
    },
  );

  test("unchanged folders are not re-read (frozen-mtime, same-size edit is invisible)", () => {
    const vault = createTempVault(FIXTURE);
    const notePath = path.join(vault.vaultPath, "alpha/kubernetes.md");
    const fixed = new Date("2024-06-01T12:00:00Z");
    // Folder fingerprints are path + mtime + size (size catches same-tick
    // edits), so "invisible" requires holding BOTH signals still.
    const padded = (s: string) => s.padEnd(200, " ");
    try {
      fs.writeFileSync(
        notePath,
        padded(
          "# Cluster\nkubernetes ingress routing autoscaling telemetry dashboards",
        ),
      );
      getOverview(vault.vaultPath, vault.vaultPath);
      fs.utimesSync(notePath, fixed, fixed);

      // Same mtime and same size → same folder fingerprint → the cached
      // FolderData is reused even though the bytes on disk changed. A
      // different options key forces the per-folder path (the whole-result
      // fast path misses).
      fs.writeFileSync(
        notePath,
        padded(
          "# Cluster\nsourdough fermentation hydration levain schedules starter",
        ),
      );
      fs.utimesSync(notePath, fixed, fixed);

      const reused = getOverview(vault.vaultPath, vault.vaultPath, {
        keywords: 4,
      });
      // ... but beta was untouched too and still reflects disk.
      const coldResult = cold(vault.vaultPath, { keywords: 4 });
      expect(reused.overview).toEqual(coldResult.overview);

      const alpha = reused.overview.find((f) => f.path === "alpha");
      // Old content served: the file was never re-read.
      expect(alpha?.keywords).toContain("kubernetes");
      expect(alpha?.keywords).not.toContain("sourdough");
    } finally {
      vault.cleanup();
    }
  });

  test("same mtime but a different size is visible (size is part of the fingerprint)", () => {
    const vault = createTempVault(FIXTURE);
    // White-box: reads the rebuilt folder's terms from the JSON cache file.
    useJsonOverviewStore(vault.vaultPath);
    const notePath = path.join(vault.vaultPath, "alpha/kubernetes.md");
    const fixed = new Date("2024-06-01T12:00:00Z");
    try {
      getOverview(vault.vaultPath, vault.vaultPath);
      fs.utimesSync(notePath, fixed, fixed);

      // Unlike the test above, this rewrite changes the byte length: the
      // size signal moves even though mtime does not, so the folder must be
      // rebuilt. Different options force the per-folder path.
      fs.writeFileSync(
        notePath,
        "# Cluster\nsourdough fermentation hydration levain schedules starter feeding",
      );
      fs.utimesSync(notePath, fixed, fixed);

      const changed = getOverview(vault.vaultPath, vault.vaultPath, {
        keywords: 4,
      });
      // White-box: the rebuilt folder's cached terms now contain the rewrite's
      // vocabulary, so the stale entry was definitely not reused.
      const cache = readFoldersCache(vault.vaultPath);
      const alphaTerms = decodeEntry(cache.folders.alpha, cache.terms).tf.map(
        ([term]) => term,
      );
      expect(alphaTerms).toContain("sourdough");
      expect(changed.overview).toEqual(
        cold(vault.vaultPath, { keywords: 4 }).overview,
      );
    } finally {
      vault.cleanup();
    }
  });

  test("option change reuses every folder entry and does not rewrite the folder cache", () => {
    const vault = createTempVault(FIXTURE);
    // Asserts on the JSON cache file's bytes and mtime — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    const files = cacheFiles(vault.vaultPath);
    const fixed = new Date("2024-06-01T12:00:00Z");
    try {
      const base = getOverview(vault.vaultPath, vault.vaultPath);
      expect(base.overview.length).toBeGreaterThan(0);

      // Pin the folder cache's mtime: an unchanged mtime after the next run
      // proves it was neither recomputed nor rewritten.
      fs.utimesSync(files.folders, fixed, fixed);
      const foldersBefore = fs.readFileSync(files.folders, "utf-8");

      const changed = getOverview(vault.vaultPath, vault.vaultPath, {
        keywords: 3,
      });

      // Checked BEFORE the cold reference run, which rewrites both caches.
      expect(fs.readFileSync(files.folders, "utf-8")).toBe(foldersBefore);
      expect(fs.statSync(files.folders).mtimeMs).toBe(fixed.getTime());
      expect(changed.overview).toEqual(
        cold(vault.vaultPath, { keywords: 3 }).overview,
      );
      expect(readFoldersCache(vault.vaultPath).terms.length).toBeGreaterThan(0);
    } finally {
      vault.cleanup();
    }
  });

  test("warm result hit does not touch the per-folder cache", () => {
    const vault = createTempVault(FIXTURE);
    // Asserts on the JSON cache file's mtime — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    const files = cacheFiles(vault.vaultPath);
    const fixed = new Date("2024-06-01T12:00:00Z");
    try {
      const first = getOverview(vault.vaultPath, vault.vaultPath);
      fs.utimesSync(files.folders, fixed, fixed);
      fs.utimesSync(files.result, fixed, fixed);

      const second = getOverview(vault.vaultPath, vault.vaultPath);
      expect(second).toEqual(first);
      expect(fs.statSync(files.folders).mtimeMs).toBe(fixed.getTime());
      expect(fs.statSync(files.result).mtimeMs).toBe(fixed.getTime());
    } finally {
      vault.cleanup();
    }
  });

  test("corrupt folder cache is a miss, never an error", () => {
    const vault = createTempVault(FIXTURE);
    // Asserts on the JSON cache file — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    const files = cacheFiles(vault.vaultPath);
    try {
      getOverview(vault.vaultPath, vault.vaultPath);
      fs.writeFileSync(files.folders, "{not json!!");

      // Touch a note so the whole-result fast path misses too.
      writeNote(
        vault.vaultPath,
        "beta/payroll.md",
        "# Payroll\npayroll withholding contractors ledger invoices audited",
      );
      const after = getOverview(vault.vaultPath, vault.vaultPath);
      expect(after).toEqual(cold(vault.vaultPath));

      // The cache was rewritten in the current format.
      const rewritten = readFoldersCache(vault.vaultPath);
      expect(typeof rewritten.folders.alpha.sig).toBe("string");
    } finally {
      vault.cleanup();
    }
  });

  test("old cache version is a miss", () => {
    const vault = createTempVault(FIXTURE);
    // Asserts on the JSON cache file — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    const files = cacheFiles(vault.vaultPath);
    try {
      getOverview(vault.vaultPath, vault.vaultPath);
      const stale = JSON.parse(fs.readFileSync(files.folders, "utf-8"));
      stale.version = 1;
      fs.writeFileSync(files.folders, JSON.stringify(stale));
      fs.rmSync(files.result, { force: true });

      // Also poison one entry: a v1 file must be discarded wholesale, so the
      // poisoned data must never reach the output.
      const poisoned = JSON.parse(fs.readFileSync(files.folders, "utf-8"));
      poisoned.folders.alpha.tf = [poisoned.terms.length + 5, 3];
      fs.writeFileSync(files.folders, JSON.stringify(poisoned));

      const result = getOverview(vault.vaultPath, vault.vaultPath);
      const alpha = result.overview.find((f) => f.path === "alpha");
      expect(alpha?.keywords).toContain("kubernetes");
      expect(result).toEqual(cold(vault.vaultPath));
    } finally {
      vault.cleanup();
    }
  });

  test("an entry with an out-of-range term index rebuilds only that folder", () => {
    const vault = createTempVault(FIXTURE);
    // Asserts on the JSON cache file — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    const files = cacheFiles(vault.vaultPath);
    try {
      getOverview(vault.vaultPath, vault.vaultPath);
      const data = JSON.parse(fs.readFileSync(files.folders, "utf-8"));
      data.folders.alpha.tf = [data.terms.length + 5, 3];
      fs.writeFileSync(files.folders, JSON.stringify(data));
      fs.rmSync(files.result, { force: true });

      const result = getOverview(vault.vaultPath, vault.vaultPath);
      const alpha = result.overview.find((f) => f.path === "alpha");
      expect(alpha?.keywords).toContain("kubernetes");
      expect(result).toEqual(cold(vault.vaultPath));
    } finally {
      vault.cleanup();
    }
  });

  test("ignore-rule change invalidates the folder cache", () => {
    const vault = createTempVault(FIXTURE);
    try {
      const before = getOverview(vault.vaultPath, vault.vaultPath);
      expect(before.overview.some((f) => f.path === "beta")).toBe(true);

      fs.writeFileSync(path.join(vault.vaultPath, ".napkinignore"), "beta/\n");

      const after = getOverview(vault.vaultPath, vault.vaultPath);
      expect(after.overview.some((f) => f.path === "beta")).toBe(false);
      expect(after).toEqual(cold(vault.vaultPath));
    } finally {
      vault.cleanup();
    }
  });

  test("warnings from cached folders are replayed in cold order", () => {
    const fixture = {
      ...FIXTURE,
      "people/broken.md": "---\ntags: [#oops, #bad]\n---\n# Broken\nbody",
      "people/ok.md": "# Ok\npeople directory leadership roadmap",
    };
    const vault = createTempVault(fixture);
    try {
      const first = getOverview(vault.vaultPath, vault.vaultPath);
      expect(first.warnings).toEqual([
        "Skipping people/broken.md (malformed YAML frontmatter)",
      ]);

      // Different options → whole-result miss → per-folder path, which must
      // replay the cached warning instead of silently dropping it.
      const second = getOverview(vault.vaultPath, vault.vaultPath, {
        keywords: 3,
      });
      expect(second.warnings).toEqual(first.warnings);
      expect(second.overview.some((f) => f.path === "people")).toBe(true);
    } finally {
      vault.cleanup();
    }
  });

  test("deleted folders' dictionary terms are compacted away", () => {
    const fixture = {
      ...FIXTURE,
      "ephemeral/temporary.md":
        "# Ephemeral\nquarantine placeholder temporary scaffolding",
    };
    const vault = createTempVault(fixture);
    // Asserts dictionary compaction in the JSON cache file — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    try {
      getOverview(vault.vaultPath, vault.vaultPath);
      const before = readFoldersCache(vault.vaultPath);
      expect(before.terms).toContain("quarantine");

      fs.rmSync(path.join(vault.vaultPath, "ephemeral"), { recursive: true });
      getOverview(vault.vaultPath, vault.vaultPath);

      const after = readFoldersCache(vault.vaultPath);
      expect(after.folders.ephemeral).toBeUndefined();
      expect(after.terms).not.toContain("quarantine");
      expect(after.terms).toContain("kubernetes");
    } finally {
      vault.cleanup();
    }
  });

  test("deep folders survive a shallow run and are reused by a later deep run", () => {
    const fixture = {
      ...FIXTURE,
      "deep/one/two/buried.md":
        "# Buried\ntelescope collimation reflector focal optics",
    };
    const vault = createTempVault(fixture);
    // Asserts on the JSON cache file's retained entries — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    try {
      // maxDepth 3 builds deep/one/two (depth 3).
      const deep = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 3,
      });
      expect(deep.overview.some((f) => f.path === "deep/one/two")).toBe(true);

      const deepBefore = readFoldersCache(vault.vaultPath);

      // Shallow run: the deep entry is retained (still valid) but not built.
      const shallow = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 1,
      });
      expect(shallow.overview.some((f) => f.path === "deep/one/two")).toBe(
        false,
      );
      const deepAfter = readFoldersCache(vault.vaultPath);
      expect(
        decodeEntry(deepAfter.folders["deep/one/two"], deepAfter.terms),
      ).toEqual(
        decodeEntry(deepBefore.folders["deep/one/two"], deepBefore.terms),
      );

      // Deep again: result equals a cold deep run.
      const again = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 3,
      });
      expect(again).toEqual(cold(vault.vaultPath, { depth: 3 }));
    } finally {
      vault.cleanup();
    }
  });

  test("maxRows truncation is unaffected by the cache path", () => {
    const vault = createTempVault(FIXTURE);
    try {
      getOverview(vault.vaultPath, vault.vaultPath);
      const incremental = getOverview(vault.vaultPath, vault.vaultPath, {
        maxRows: 2,
      });
      const coldResult = cold(vault.vaultPath, { maxRows: 2 });
      expect(incremental).toEqual(coldResult);
      expect(incremental.overview).toHaveLength(2);
      expect(incremental.truncated?.rows).toBeGreaterThan(0);
    } finally {
      vault.cleanup();
    }
  });
});

/**
 * Sibling collapse ON at depth 3 (#118): the SQLite per-note store must
 * reproduce the collapse exactly — the merged parent's keywords come from
 * merged term data (not stored candidates), its df contribution is the
 * union of the absorbed children's, and a note change inside a collapsed
 * child re-aggregates only that folder before the merge is recomputed.
 */
describe("sibling collapse at depth 3", () => {
  // Two depth-3 sibling groups: "area/x/tenant-*" under a parent that has a
  // direct note of its own (the merge keeps the parent's own FolderData),
  // and "area/y/tenant-*" under a parent with no direct files (the merged
  // row is created where no folder row exists). Six homogeneous siblings
  // each: identical boilerplate, so mean pairwise body cosine collapses.
  const DEEP_FIXTURE: Record<string, string> = {
    ...FIXTURE,
    "area/x/index.md":
      "# Area X\nproject umbrella charter governance milestones",
  };
  const SHARED = [
    "Lease agreement between landlord and tenant with signature page.",
    "Rent schedule and lease term apply as stated in the appendix.",
    "Bank guarantee and insurance certificate required before occupancy.",
  ];
  for (const parent of ["area/x", "area/y"]) {
    for (let i = 0; i < 6; i++) {
      DEEP_FIXTURE[`${parent}/tenant-${i}/contract.md`] =
        `# Converted document ${i}\n${SHARED.filter((_, j) => j !== i % 3).join("\n")}\nSuite ${100 + i}.`;
    }
  }
  // A depth-3 sibling group that must NOT collapse: heterogeneous bodies.
  const TOPICS = [
    "Kubernetes ingress routing and pod autoscaling.",
    "Payroll tax withholding for hourly contractors.",
    "Sourdough fermentation schedules and hydration.",
    "Telescope collimation for reflector optics.",
    "Beehive winterization and varroa treatment.",
    "Marathon splits and lactate threshold pacing.",
  ];
  TOPICS.forEach((body, i) => {
    DEEP_FIXTURE[`area/z/topic-${i}/note.md`] = `# Topic ${i}\n${body}`;
  });

  const OPTS = { depth: 3, collapse: true, collapseDepth: 2 };

  test("collapse fires on stored data and the merged rows match cold", () => {
    const vault = createTempVault(DEEP_FIXTURE);
    try {
      const result = getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      const x = result.overview.find((f) => f.path === "area/x");
      const y = result.overview.find((f) => f.path === "area/y");
      expect(x?.collapsedFolders).toBe(6);
      expect(y?.collapsedFolders).toBe(6);
      // Children are gone; the heterogeneous group survives.
      expect(result.overview.some((f) => f.path === "area/x/tenant-0")).toBe(
        false,
      );
      expect(
        result.overview.filter((f) => f.path.startsWith("area/z/topic-")),
      ).toHaveLength(6);
      expect(result).toEqual(cold(vault.vaultPath, OPTS));
    } finally {
      vault.cleanup();
    }
  });

  test("a note edit inside a collapsed child re-aggregates and re-merges", () => {
    const vault = createTempVault(DEEP_FIXTURE);
    try {
      getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      // Diverge one child enough to flip the similarity below the gate:
      // the group then renders as six rows instead of one merged row.
      writeNote(
        vault.vaultPath,
        "area/x/tenant-2/contract.md",
        "# Telescope\ntelescope collimation reflector focal optics lens mirror",
      );
      const second = getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      expect(second).toEqual(cold(vault.vaultPath, OPTS));
    } finally {
      vault.cleanup();
    }
  });

  test("a note edit in the merge-target parent re-merges stored children", () => {
    const vault = createTempVault(DEEP_FIXTURE);
    try {
      getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      writeNote(
        vault.vaultPath,
        "area/x/index.md",
        "# Area X\ncharter governance milestones roadmap budget allocation",
      );
      const second = getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      expect(second).toEqual(cold(vault.vaultPath, OPTS));
    } finally {
      vault.cleanup();
    }
  });

  test("a new sibling joins the collapse group", () => {
    const vault = createTempVault(DEEP_FIXTURE);
    try {
      getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      writeNote(
        vault.vaultPath,
        "area/y/tenant-6/contract.md",
        `# Converted document 6\n${SHARED.join("\n")}\nSuite 106.`,
      );
      const second = getOverview(vault.vaultPath, vault.vaultPath, OPTS);
      expect(
        second.overview.find((f) => f.path === "area/y")?.collapsedFolders,
      ).toBe(7);
      expect(second).toEqual(cold(vault.vaultPath, OPTS));
    } finally {
      vault.cleanup();
    }
  });

  test("SQLite and JSON stores agree on collapsed output", () => {
    const vSql = createTempVault(DEEP_FIXTURE);
    const vJson = createTempVault(DEEP_FIXTURE);
    useJsonOverviewStore(vJson.vaultPath);
    try {
      const a = getOverview(vSql.vaultPath, vSql.vaultPath, OPTS);
      const b = getOverview(vJson.vaultPath, vJson.vaultPath, OPTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // Same agreement after a mutation inside a collapsed child.
      for (const v of [vSql, vJson]) {
        writeNote(
          v.vaultPath,
          "area/y/tenant-1/contract.md",
          `# Converted document 1\n${SHARED.join("\n")}\nSuite 777.`,
        );
      }
      expect(
        JSON.stringify(getOverview(vSql.vaultPath, vSql.vaultPath, OPTS)),
      ).toBe(
        JSON.stringify(getOverview(vJson.vaultPath, vJson.vaultPath, OPTS)),
      );
    } finally {
      vSql.cleanup();
      vJson.cleanup();
    }
  });
});

/**
 * The vault walk is bounded to the configured depth (#117): notes in
 * folders deeper than it are never listed or statted, so they cannot
 * change the whole-vault fingerprint or any per-folder signature.
 */
describe("bounded vault walk", () => {
  const DEEP_FIXTURE: Record<string, string> = {
    ...FIXTURE,
    "deep/one/two/buried.md":
      "# Buried\ntelescope collimation reflector focal optics",
  };

  test("a change below the configured depth does not invalidate the whole-vault cache", () => {
    const vault = createTempVault(DEEP_FIXTURE);
    // Asserts on the JSON cache file's mtime — pin the fallback.
    useJsonOverviewStore(vault.vaultPath);
    const files = cacheFiles(vault.vaultPath);
    const fixed = new Date("2024-06-01T12:00:00Z");
    try {
      const first = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 2,
      });
      // "deep/one/two" is folder depth 3 — outside the bound.
      expect(first.overview.some((f) => f.path === "deep/one/two")).toBe(false);
      fs.utimesSync(files.result, fixed, fixed);
      fs.utimesSync(files.folders, fixed, fixed);

      // Rewriting the deep note must leave the bounded fingerprint alone:
      // a whole-result hit returns the previous result without rewriting
      // either cache file (a miss always rewrites the result cache).
      writeNote(
        vault.vaultPath,
        "deep/one/two/buried.md",
        "# Buried\nsourdough fermentation hydration levain starter",
      );
      const second = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 2,
      });
      expect(second).toEqual(first);
      expect(fs.statSync(files.result).mtimeMs).toBe(fixed.getTime());
      expect(fs.statSync(files.folders).mtimeMs).toBe(fixed.getTime());

      // The same file is still visible to a run deep enough to reach it.
      const deep = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 3,
      });
      expect(deep.overview.some((f) => f.path === "deep/one/two")).toBe(true);
    } finally {
      vault.cleanup();
    }
  });

  test("a change at the boundary depth invalidates the whole-vault cache", () => {
    const vault = createTempVault(FIXTURE);
    const files = cacheFiles(vault.vaultPath);
    const fixed = new Date("2024-06-01T12:00:00Z");
    try {
      const first = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 2,
      });
      fs.utimesSync(files.result, fixed, fixed);

      // "imports/tenant-0" is folder depth 2 — exactly at the bound.
      writeNote(
        vault.vaultPath,
        "imports/tenant-0/contract.md",
        "# Converted document\nsourdough fermentation hydration levain starter",
      );
      const second = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 2,
      });

      // Miss: the result cache was rewritten, and the answer is the cold one.
      expect(fs.statSync(files.result).mtimeMs).not.toBe(fixed.getTime());
      expect(second).not.toEqual(first);
      expect(second).toEqual(cold(vault.vaultPath, { depth: 2 }));
    } finally {
      vault.cleanup();
    }
  });

  test("ignore and symlink semantics are unchanged at the walk boundary", () => {
    // alpha/ is ignored; "linked" is a symlink at depth 1 to an external
    // dir holding folders at depths 2 (inside the bound) and 3 (outside).
    const vault = createTempVault({
      ...FIXTURE,
      ".napkinignore": "alpha/\n",
    });
    try {
      const external = path.join(vault.path, "external");
      fs.mkdirSync(path.join(external, "sub/deep"), { recursive: true });
      fs.writeFileSync(
        path.join(external, "sub/note.md"),
        "# Linked\ntelescope collimation reflector focal optics",
      );
      fs.writeFileSync(
        path.join(external, "sub/deep/buried.md"),
        "# Buried\nsourdough fermentation hydration levain starter",
      );
      fs.symlinkSync(external, path.join(vault.vaultPath, "linked"));

      const shallow = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 2,
      });
      const paths = shallow.overview.map((f) => f.path);
      // An ignored dir inside the bound is still pruned (and not walked).
      expect(paths).not.toContain("alpha");
      // Depth follows the symlink path, so linked/sub is folder depth 2.
      expect(paths).toContain("linked/sub");
      expect(paths).not.toContain("linked/sub/deep");

      const deep = getOverview(vault.vaultPath, vault.vaultPath, {
        depth: 3,
      });
      expect(deep.overview.map((f) => f.path)).toContain("linked/sub/deep");
      expect(deep.overview.map((f) => f.path)).not.toContain("alpha");
    } finally {
      vault.cleanup();
    }
  });
});
