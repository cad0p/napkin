import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { searchVault } from "../core/search.js";
import {
  computeFingerprint,
  diffFileMtimes,
  loadSearchCache,
  saveSearchCache,
  statAllFiles,
} from "./search-cache.js";
import { createTempVault } from "./test-helpers.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  vault = createTempVault({
    "README.md": "# Vault\nWelcome",
    "Projects/alpha.md": "# Alpha\nThe alpha project",
    "Projects/beta.md": "# Beta\nBeta project",
  });
});

afterEach(() => {
  vault.cleanup();
});

describe("computeFingerprint", () => {
  test("returns consistent fingerprint for same files", () => {
    const fp1 = computeFingerprint(vault.vaultPath);
    const fp2 = computeFingerprint(vault.vaultPath);
    expect(fp1).toBe(fp2);
  });

  test("changes when a file is added", () => {
    const fp1 = computeFingerprint(vault.vaultPath);
    fs.writeFileSync(path.join(vault.vaultPath, "new.md"), "# New");
    const fp2 = computeFingerprint(vault.vaultPath);
    expect(fp1).not.toBe(fp2);
  });

  test("changes when a file is modified", () => {
    const fp1 = computeFingerprint(vault.vaultPath);
    // Ensure mtime changes (some filesystems have 1s resolution)
    const filePath = path.join(vault.vaultPath, "README.md");
    const futureTime = Date.now() + 2000;
    fs.utimesSync(filePath, futureTime / 1000, futureTime / 1000);
    const fp2 = computeFingerprint(vault.vaultPath);
    expect(fp1).not.toBe(fp2);
  });

  test("changes when a file is deleted", () => {
    const fp1 = computeFingerprint(vault.vaultPath);
    fs.unlinkSync(path.join(vault.vaultPath, "README.md"));
    const fp2 = computeFingerprint(vault.vaultPath);
    expect(fp1).not.toBe(fp2);
  });
});

describe("diffFileMtimes", () => {
  test("detects change when mtime differs", () => {
    const cached = { "a.md": { mtime: 1000, size: 10 } };
    const diff = diffFileMtimes(cached, [
      { file: "a.md", mtime: 2000, size: 10 },
    ]);
    expect(diff.unchanged).toBe(false);
    expect(diff.toAdd).toEqual([{ file: "a.md", mtime: 2000, size: 10 }]);
  });

  test("detects change when size differs but mtime is identical (same-tick edit)", () => {
    // Regression test: some filesystems report identical mtimeMs for rapid
    // successive writes. An mtime-only diff would miss the edit and serve a
    // stale index. Comparing size catches the common same-tick case where the
    // byte length changed.
    const cached = { "a.md": { mtime: 1000, size: 10 } };
    const diff = diffFileMtimes(cached, [
      { file: "a.md", mtime: 1000, size: 15 },
    ]);
    expect(diff.unchanged).toBe(false);
    expect(diff.toAdd).toHaveLength(1);
  });

  test("unchanged when mtime AND size both match", () => {
    const cached = { "a.md": { mtime: 1000, size: 10 } };
    const diff = diffFileMtimes(cached, [
      { file: "a.md", mtime: 1000, size: 10 },
    ]);
    expect(diff.unchanged).toBe(true);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toRemove).toHaveLength(0);
  });

  test("detects added and removed files", () => {
    const cached = {
      "old.md": { mtime: 1000, size: 10 },
      "kept.md": { mtime: 1000, size: 5 },
    };
    const diff = diffFileMtimes(cached, [
      { file: "kept.md", mtime: 1000, size: 5 },
      { file: "new.md", mtime: 3000, size: 7 },
    ]);
    expect(diff.toAdd.map((e) => e.file)).toEqual(["new.md"]);
    expect(diff.toRemove).toEqual(["old.md"]);
  });
});

describe("saveSearchCache / loadSearchCache", () => {
  const makeData = (over = {}) => ({
    engine: "ferrosearch",
    folder: null,
    fileMtimes: { "README.md": { mtime: 1000, size: 42 } },
    index: '{"serialized":"index"}',
    docs: [
      {
        file: "README.md",
        basename: "README",
        content: "# readme body",
        mtime: 1000,
        size: 42,
      },
    ],
    backlinkCounts: { "README.md": 2 },
    outgoingLinks: { "README.md": [] },
    ...over,
  });

  test("round-trips cache data", () => {
    const data = makeData();

    saveSearchCache(vault.vaultPath, data);
    const loaded = loadSearchCache(vault.vaultPath);

    expect(loaded).not.toBeNull();
    expect(loaded?.index).toBe(data.index);
    expect(loaded?.docs).toEqual(data.docs);
    expect(loaded?.backlinkCounts).toEqual(data.backlinkCounts);
    expect(loaded?.fileMtimes).toEqual(data.fileMtimes);
    expect(loaded?.folder).toBeNull();
    expect(loaded?.engine).toBe("ferrosearch");
  });

  test("rejects legacy minisearch-era caches (no engine) — avoids ferrosearch addAll panic + 22-hit recall quirk", () => {
    // Fork ≤0.12.1 wrote engine-less caches whose index blob is minisearch
    // format. FerroSearch.loadJson parses them, but any later addAll panics
    // the native engine ("no entry found for key") and warm recall degrades
    // (22 docs for "distill" instead of 375). Reject → one-time cold rebuild.
    const data = makeData();
    delete data.engine;

    saveSearchCache(vault.vaultPath, data);
    expect(loadSearchCache(vault.vaultPath)).toBeNull();
  });

  test("rejects content-less caches (legacy format) so cold-rebuild restores recall", () => {
    // v0.10.0 wrote caches WITHOUT doc.content; on the warm path contentScan
    // then matched nothing and recall collapsed (bug #22). Such caches must be
    // rejected here so searchVault falls back to a cold rebuild in the new
    // (content-bearing) format instead of loading and silently degrading recall.
    const data = makeData({ docs: [{ file: "README.md", basename: "README", mtime: 1000, size: 42 }] });

    saveSearchCache(vault.vaultPath, data);
    expect(loadSearchCache(vault.vaultPath)).toBeNull();
  });

  test("returns null when no cache exists", () => {
    const loaded = loadSearchCache(vault.vaultPath);
    expect(loaded).toBeNull();
  });

  test("returns null when cache shape is invalid (missing fileMtimes)", () => {
    // Old-format cache (with `fingerprint` instead of `fileMtimes`) must be
    // rejected so `searchVault` falls back to a cold build.
    const data = {
      engine: "ferrosearch",
      fingerprint: "old-fingerprint",
      index: "{}",
      docs: [],
      backlinkCounts: {},
    };
    fs.writeFileSync(
      path.join(vault.vaultPath, "search-cache.json"),
      JSON.stringify(data),
    );

    const loaded = loadSearchCache(vault.vaultPath);
    expect(loaded).toBeNull();
  });

  test("cache file lives in config dir", () => {
    const data = makeData({ fileMtimes: {}, docs: [] });
    saveSearchCache(vault.vaultPath, data);

    expect(fs.existsSync(path.join(vault.vaultPath, "search-cache.json"))).toBe(
      true,
    );
  });

  test("returns null on corrupted cache file", () => {
    fs.writeFileSync(
      path.join(vault.vaultPath, "search-cache.json"),
      "not valid json{{{",
    );

    const loaded = loadSearchCache(vault.vaultPath);
    expect(loaded).toBeNull();
  });
});

describe("minisearch cache migration", () => {
  test("a cache blob written by minisearch loads and searches identically", () => {
    // A fresh vault: nothing cached yet, so the legacy blob below is what the
    // warm path actually loads from disk (the module memory cache is keyed by
    // vault path and has no entry for it).
    const legacyVault = createTempVault({
      "README.md": "# Vault\nWelcome to the vault",
      "Projects/alpha.md": "# Alpha\nThe alpha project with rustlang notes",
      "Projects/beta.md": "# Beta\nBeta project",
      "Resources/guide.md": "# Guide\nRefer to the [[alpha]] project here",
    });

    // Vaults in the wild have search-cache.json blobs serialized by
    // minisearch (napkin < ferrosearch swap). ferrosearch reads the same
    // version-2 format with the same options, so old caches must keep working
    // without a rebuild. The options here mirror src/core/search.ts's
    // INDEX_OPTIONS — loadJson requires the exact options the blob was
    // serialized with.
    const files = [
      "README.md",
      "Projects/alpha.md",
      "Projects/beta.md",
      "Resources/guide.md",
    ];
    const legacy = new MiniSearch({
      fields: ["basename", "content"],
      storeFields: ["file"],
      idField: "file",
      searchOptions: { boost: { basename: 2 }, fuzzy: 0.2, prefix: true },
    });
    legacy.addAll(
      files.map((file) => ({
        file,
        basename: path.basename(file, ".md"),
        content: fs.readFileSync(
          path.join(legacyVault.vaultPath, file),
          "utf-8",
        ),
      })),
    );

    const stats = Object.fromEntries(
      statAllFiles(legacyVault.vaultPath).map((e) => [
        e.file,
        { mtime: e.mtime, size: e.size },
      ]),
    );
    saveSearchCache(legacyVault.vaultPath, {
      // Engine-marked so validation accepts it: this simulates a minisearch-
      // FORMAT index blob that passes the engine check (the format-compat
      // contract). Real engine-less minisearch-era caches are rejected in
      // loadSearchCache (see regression test above) — mutating a
      // minisearch-loaded index panics ferrosearch's native engine.
      engine: "ferrosearch",
      folder: null,
      fileMtimes: stats,
      index: JSON.stringify(legacy), // the old serialization call
      docs: files.map((file) => ({
        file,
        basename: path.basename(file, ".md"),
        content: fs.readFileSync(
          path.join(legacyVault.vaultPath, file),
          "utf-8",
        ),
        mtime: fs.statSync(path.join(legacyVault.vaultPath, file)).mtimeMs,
        size: fs.statSync(path.join(legacyVault.vaultPath, file)).size,
      })),
      backlinkCounts: {},
      outgoingLinks: {},
    });

    const fromLegacyCache = searchVault(
      legacyVault.vaultPath,
      legacyVault.vaultPath,
      "alpha",
    );

    // Rebuild fresh (delete the cache) and compare — scores must be identical
    // whether the index came from a minisearch-serialized blob or a native
    // ferrosearch build.
    fs.rmSync(path.join(legacyVault.vaultPath, "search-cache.json"), {
      force: true,
    });
    const fresh = searchVault(
      legacyVault.vaultPath,
      legacyVault.vaultPath,
      "alpha",
    );
    expect(fromLegacyCache.map((r) => [r.file, r.score])).toEqual(
      fresh.map((r) => [r.file, r.score]),
    );

    legacyVault.cleanup();
  });
});
