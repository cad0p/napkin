import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSearchCache, saveSearchCache } from "./json-store.js";
import { computeFingerprint, diffFileMtimes } from "./search-cache.js";
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
  test("round-trips cache data", () => {
    const data = {
      folder: null,
      fileMtimes: { "README.md": { mtime: 1000, size: 42 } },
      index: '{"serialized":"index"}',
      docs: [
        {
          file: "README.md",
          basename: "README",
          mtime: 1000,
          size: 42,
        },
      ],
      backlinkCounts: { "README.md": 2 },
      outgoingLinks: { "README.md": [] },
      ignoreFingerprint: "fp-test",
    };

    saveSearchCache(vault.vaultPath, data);
    const loaded = loadSearchCache(vault.vaultPath);

    expect(loaded).not.toBeNull();
    expect(loaded?.index).toBe(data.index);
    expect(loaded?.docs).toEqual(data.docs);
    expect(loaded?.backlinkCounts).toEqual(data.backlinkCounts);
    expect(loaded?.fileMtimes).toEqual(data.fileMtimes);
    expect(loaded?.folder).toBeNull();
    expect(loaded?.ignoreFingerprint).toBe("fp-test");
  });

  test("rejects caches without ignoreFingerprint (pre-ignore format) so cold-rebuild applies ignores", () => {
    // Caches written before the ignore feature have no ignoreFingerprint.
    // Rejecting them forces a cold rebuild so the ignore state is applied
    // (files matched by .napkinignore/.gitignore/dotfiles must not linger).
    const data = {
      folder: null,
      fileMtimes: { "README.md": { mtime: 1000, size: 42 } },
      index: '{"serialized":"index"}',
      docs: [
        {
          file: "README.md",
          basename: "README",
          mtime: 1000,
          size: 42,
        },
      ],
      backlinkCounts: { "README.md": 2 },
      outgoingLinks: { "README.md": [] },
    };

    saveSearchCache(vault.vaultPath, data);
    expect(loadSearchCache(vault.vaultPath)).toBeNull();
  });

  test("loads a legacy content-bearing cache but discards note text", () => {
    // Pre-#85 caches persisted docs[].content (the #22 fix). They must keep
    // loading — rejecting them would force a needless cold rebuild on every
    // upgrade — but the text is dropped on load instead of retained (#85).
    const data = {
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
      ignoreFingerprint: "fp-test",
    };

    saveSearchCache(vault.vaultPath, data);
    const loaded = loadSearchCache(vault.vaultPath);

    expect(loaded).not.toBeNull();
    expect(loaded?.docs).toEqual([
      { file: "README.md", basename: "README", mtime: 1000, size: 42 },
    ]);
    expect(loaded?.docs[0]).not.toHaveProperty("content");
  });

  test("rejects a cache whose doc metadata is malformed", () => {
    const data = {
      folder: null,
      fileMtimes: { "README.md": { mtime: 1000, size: 42 } },
      index: '{"serialized":"index"}',
      docs: [{ file: "README.md", basename: "README" }],
      backlinkCounts: {},
      outgoingLinks: {},
      ignoreFingerprint: "fp-test",
    };

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
    const data = {
      folder: null,
      fileMtimes: {},
      index: "{}",
      docs: [],
      backlinkCounts: {},
      outgoingLinks: {},
    };
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

describe("saveSearchCache atomicity", () => {
  const cachePath = (dir: string) => path.join(dir, "search-cache.json");
  const tempFiles = (dir: string) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("search-cache.json.") && f.endsWith(".tmp"));

  function sampleData(ignoreFingerprint = "fp-test") {
    return {
      folder: null,
      fileMtimes: { "README.md": { mtime: 1000, size: 42 } },
      index: '{"serialized":"index"}',
      docs: [
        {
          file: "README.md",
          basename: "README",
          mtime: 1000,
          size: 42,
        },
      ],
      backlinkCounts: { "README.md": 2 },
      outgoingLinks: { "README.md": [] },
      ignoreFingerprint,
    };
  }

  test("leaves no temp files behind", () => {
    saveSearchCache(vault.vaultPath, sampleData());

    expect(fs.existsSync(cachePath(vault.vaultPath))).toBe(true);
    expect(tempFiles(vault.vaultPath)).toEqual([]);
    expect(loadSearchCache(vault.vaultPath)?.ignoreFingerprint).toBe("fp-test");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a failed write keeps the previous cache and removes the temp file",
    () => {
      saveSearchCache(vault.vaultPath, sampleData());
      const before = fs.readFileSync(cachePath(vault.vaultPath), "utf-8");

      // Read-only directory: the temp file cannot be created at all.
      fs.chmodSync(vault.vaultPath, 0o500);
      try {
        expect(() =>
          saveSearchCache(vault.vaultPath, sampleData("other-fp")),
        ).toThrow();
      } finally {
        fs.chmodSync(vault.vaultPath, 0o700);
      }

      // The previous snapshot is intact and still loads.
      expect(fs.readFileSync(cachePath(vault.vaultPath), "utf-8")).toBe(before);
      expect(loadSearchCache(vault.vaultPath)?.ignoreFingerprint).toBe(
        "fp-test",
      );
      expect(tempFiles(vault.vaultPath)).toEqual([]);
    },
  );

  test("cleans up the temp file when the rename fails", () => {
    // A directory occupying the target path makes rename(2) fail after the
    // temp file was written — the half-written temp must not be left behind.
    const target = cachePath(vault.vaultPath);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "occupied"), "x");

    expect(() => saveSearchCache(vault.vaultPath, sampleData())).toThrow();

    expect(tempFiles(vault.vaultPath)).toEqual([]);
    expect(fs.readdirSync(target)).toEqual(["occupied"]);
  });
});
