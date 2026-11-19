import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadSearchCache } from "../utils/search-cache.js";
import { createTempVault } from "../utils/test-helpers.js";
import { resetSearchIndexForTests, searchVault } from "./search.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  v = createTempVault({
    "Projects/alpha.md": "# Alpha\nalpha-project-marker\n",
    "Projects/beta.md": "# Beta\nbeta-project-marker\n",
    "Resources/guide.md": "# Guide\nRefer to the [[alpha]] project",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("searchVault ignore support", () => {
  test("ignored files are absent from results", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );

    const results = searchVault(
      v.vaultPath,
      v.vaultPath,
      "beta-project-marker",
    );
    expect(results.map((r) => r.file)).not.toContain("Projects/beta.md");

    const alphaResults = searchVault(
      v.vaultPath,
      v.vaultPath,
      "alpha-project-marker",
    );
    expect(alphaResults.map((r) => r.file)).toContain("Projects/alpha.md");
  });

  test("fingerprint mismatch triggers a cold rebuild when .napkinignore is added", () => {
    // Search once — builds and persists the index with no ignore state.
    const before = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(before.map((r) => r.file)).toContain("Projects/beta.md");

    // Add an ignore file, then search again. The stored cache has a
    // different ignoreFingerprint, so the index is rebuilt and the
    // ignored file disappears without any manual invalidation.
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const after = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(after.map((r) => r.file)).not.toContain("Projects/beta.md");
    // A non-ignored file still matches.
    const alpha = searchVault(v.vaultPath, v.vaultPath, "alpha-project-marker");
    expect(alpha.map((r) => r.file)).toContain("Projects/alpha.md");
  });

  test("fingerprint mismatch triggers a cold rebuild when .napkinignore is deleted", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Projects/beta.md\n",
    );
    const before = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(before.map((r) => r.file)).not.toContain("Projects/beta.md");

    fs.unlinkSync(path.join(v.vaultPath, ".napkinignore"));
    const after = searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
    expect(after.map((r) => r.file)).toContain("Projects/beta.md");
  });

  test("ignore.dotfiles: false restores dotfiles to the index", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".hidden.md"),
      "# Hidden\nhidden-dotfile-marker\n",
    );
    // Default dotfiles: true — dotfiles are not indexed.
    const hidden = searchVault(
      v.vaultPath,
      v.vaultPath,
      "hidden-dotfile-marker",
    );
    expect(hidden.map((r) => r.file)).not.toContain(".hidden.md");

    const configPath = path.join(v.vaultPath, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.ignore = { ...config.ignore, dotfiles: false };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const visible = searchVault(
      v.vaultPath,
      v.vaultPath,
      "hidden-dotfile-marker",
    );
    expect(visible.map((r) => r.file)).toContain(".hidden.md");
  });

  test("backlinks do not count ignored files as sources or targets", () => {
    fs.writeFileSync(
      path.join(v.vaultPath, ".napkinignore"),
      "Resources/guide.md\n",
    );
    // guide.md links to [[alpha]]; with guide ignored, alpha's backlink
    // count must not include it.
    const results = searchVault(v.vaultPath, v.vaultPath, "alpha");
    const alpha = results.find((r) => r.file === "Projects/alpha.md");
    expect(alpha).toBeDefined();
    expect(alpha?.links).toBe(0);
  });
});

describe("folder-scoped search over the whole-vault index", () => {
  // Distinctive mtime stamp used to prove the disk cache file was NOT
  // rewritten (a cold rebuild would overwrite it with a fresh mtime).
  const OLD_MTIME = new Date("2000-01-01T00:00:00Z");

  test("results never include out-of-folder files; nested subfolders match, same-prefix siblings do not", () => {
    const vault = createTempVault({
      "foo/target.md": "# Target\nfolder-scope-marker\n",
      "foo/bar/nested.md": "# Nested\nfolder-scope-marker\n",
      "foobar/sibling.md": "# Target sibling\nfolder-scope-marker\n",
      "other/target.md": "# Other target\nfolder-scope-marker\n",
    });
    try {
      // Content-scan path: "folder-scope-marker" lives in every file.
      const scoped = searchVault(
        vault.vaultPath,
        vault.vaultPath,
        "folder-scope-marker",
        { path: "foo" },
      );
      expect(scoped.map((r) => r.file).sort()).toEqual([
        "foo/bar/nested.md",
        "foo/target.md",
      ]);

      // Basename path: "target" is the basename of both foo/target.md and
      // other/target.md — only the in-folder one may be returned.
      const byName = searchVault(vault.vaultPath, vault.vaultPath, "target", {
        path: "foo",
      });
      expect(byName.map((r) => r.file)).toEqual(["foo/target.md"]);
    } finally {
      vault.cleanup();
    }
  });

  test("a nonexistent folder returns no results", () => {
    // Matches prior listFiles behaviour: a missing base dir yields an
    // empty file list, hence an empty result set (no throw).
    const results = searchVault(v.vaultPath, v.vaultPath, "alpha", {
      path: "no-such-folder",
    });
    expect(results).toEqual([]);
  });

  test("backlinks from outside the folder still count", () => {
    // Resources/guide.md links to [[alpha]] — it is outside the search
    // scope but still contributes to alpha's backlink count (#87).
    const results = searchVault(v.vaultPath, v.vaultPath, "alpha", {
      path: "Projects",
    });
    const alpha = results.find((r) => r.file === "Projects/alpha.md");
    expect(alpha).toBeDefined();
    expect(alpha?.links).toBe(1);
  });

  test("a folder search persists a whole-vault snapshot reusable in a fresh process", () => {
    const scoped = searchVault(v.vaultPath, v.vaultPath, "alpha", {
      path: "Projects",
    });
    expect(scoped.map((r) => r.file)).toEqual(["Projects/alpha.md"]);

    // The persisted snapshot covers the WHOLE vault, not just the folder.
    const cache = loadSearchCache(v.vaultPath);
    expect(cache?.folder).toBeNull();
    expect(cache?.docs.map((d) => d.file)).toContain("Resources/guide.md");

    // Simulate a fresh process: only the disk cache survives.
    resetSearchIndexForTests();

    // A whole-vault search must be a pure disk hit — a cold rebuild would
    // rewrite the cache file. Stamp an old mtime to detect any rewrite.
    const cachePath = path.join(v.vaultPath, "search-cache.json");
    fs.utimesSync(cachePath, OLD_MTIME, OLD_MTIME);
    const results = searchVault(v.vaultPath, v.vaultPath, "alpha");
    expect(fs.statSync(cachePath).mtimeMs).toBe(OLD_MTIME.getTime());
    expect(results.map((r) => r.file)).toContain("Resources/guide.md");
    expect(results.map((r) => r.file)).toContain("Projects/alpha.md");
  });

  test("a disk cache with a non-null folder is treated as a miss and rebuilt", () => {
    // Build a real whole-vault cache, then mark it as an old-style
    // per-folder snapshot.
    searchVault(v.vaultPath, v.vaultPath, "alpha");
    const cachePath = path.join(v.vaultPath, "search-cache.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    raw.folder = "Projects";
    fs.writeFileSync(cachePath, JSON.stringify(raw));

    resetSearchIndexForTests();
    fs.utimesSync(cachePath, OLD_MTIME, OLD_MTIME);

    const results = searchVault(v.vaultPath, v.vaultPath, "alpha");
    // The stale snapshot was rejected and a whole-vault cache rewritten.
    expect(fs.statSync(cachePath).mtimeMs).not.toBe(OLD_MTIME.getTime());
    expect(loadSearchCache(v.vaultPath)?.folder).toBeNull();
    expect(results.map((r) => r.file)).toContain("Resources/guide.md");
    expect(results.map((r) => r.file)).toContain("Projects/alpha.md");
  });
});

// ── Incremental cache persistence (#84) ─────────────────────────
// The disk cache used to be written only on the cold path, so a vault with
// churn re-read every added/edited note in each new process.

/** Cached mtime+size signature for one file, read back from disk. */
function cachedSig(vaultPath: string, file: string) {
  return loadSearchCache(vaultPath)?.fileMtimes[file];
}

describe("incremental cache persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSearchIndexForTests();
  });

  test("persists a diff: the on-disk cache carries the new mtime and doc", () => {
    vi.useFakeTimers();
    searchVault(v.vaultPath, v.vaultPath, "alpha-project-marker");

    const alphaPath = path.join(v.vaultPath, "Projects/alpha.md");
    fs.writeFileSync(
      alphaPath,
      "# Alpha\nalpha-project-marker alpha-updated\n",
    );
    fs.writeFileSync(
      path.join(v.vaultPath, "Projects/gamma.md"),
      "# Gamma\ngamma-note-marker\n",
    );

    searchVault(v.vaultPath, v.vaultPath, "gamma-note-marker");
    // The immediate write happened for the cold build, so this diff is inside
    // the throttle window and flushes on the trailing timer.
    vi.advanceTimersByTime(30_000);

    const cache = loadSearchCache(v.vaultPath);
    const stat = fs.statSync(alphaPath);
    expect(cachedSig(v.vaultPath, "Projects/alpha.md")).toEqual({
      mtime: stat.mtimeMs,
      size: stat.size,
    });
    expect(cache?.docs.map((d) => d.file)).toContain("Projects/gamma.md");
    expect(
      cache?.docs.find((d) => d.file === "Projects/alpha.md")?.content,
    ).toContain("alpha-updated");
  });

  test("a folder-scoped search persists a whole-vault snapshot", () => {
    vi.useFakeTimers();
    searchVault(v.vaultPath, v.vaultPath, "alpha", { path: "Projects" });

    const alphaPath = path.join(v.vaultPath, "Projects/alpha.md");
    fs.writeFileSync(
      alphaPath,
      "# Alpha\nalpha-project-marker folder-scope-edit\n",
    );

    // A scoped search shares the whole-vault index (#87), so its diff must
    // persist a whole-vault snapshot — not a folder slice that a plain
    // search would have to reject.
    searchVault(v.vaultPath, v.vaultPath, "alpha", { path: "Projects" });
    vi.advanceTimersByTime(30_000);

    const cache = loadSearchCache(v.vaultPath);
    expect(cache?.folder).toBeNull();
    expect(cache?.docs.map((d) => d.file)).toContain("Resources/guide.md");
    const stat = fs.statSync(alphaPath);
    expect(cachedSig(v.vaultPath, "Projects/alpha.md")).toEqual({
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  });

  test.skipIf(process.getuid?.() === 0)(
    "a fresh process serves unchanged notes from the persisted cache",
    () => {
      vi.useFakeTimers();
      searchVault(v.vaultPath, v.vaultPath, "beta-project-marker");
      fs.writeFileSync(
        path.join(v.vaultPath, "Projects/delta.md"),
        "# Delta\ndelta-note-marker\n",
      );
      searchVault(v.vaultPath, v.vaultPath, "delta-note-marker");
      vi.advanceTimersByTime(30_000);

      // Simulate a new process: the on-disk cache is all that survives.
      resetSearchIndexForTests();

      // A re-read of this unchanged note would throw EACCES; the cache hit
      // serves its persisted content instead.
      const betaPath = path.join(v.vaultPath, "Projects/beta.md");
      fs.chmodSync(betaPath, 0o000);
      try {
        const beta = searchVault(
          v.vaultPath,
          v.vaultPath,
          "beta-project-marker",
        );
        expect(beta.map((r) => r.file)).toContain("Projects/beta.md");
        // The note added by the previous process is in the cache too.
        const delta = searchVault(
          v.vaultPath,
          v.vaultPath,
          "delta-note-marker",
        );
        expect(delta.map((r) => r.file)).toContain("Projects/delta.md");
      } finally {
        fs.chmodSync(betaPath, 0o600);
      }
    },
  );

  test("throttles: leading edge for the first diff, one trailing write after", () => {
    vi.useFakeTimers();
    const alphaPath = path.join(v.vaultPath, "Projects/alpha.md");

    searchVault(v.vaultPath, v.vaultPath, "alpha-project-marker");
    const coldSig = cachedSig(v.vaultPath, "Projects/alpha.md");
    // Cold build writes immediately — nothing left pending.
    expect(vi.getTimerCount()).toBe(0);

    // Past the window: the diff is written on the leading edge.
    vi.advanceTimersByTime(31_000);
    fs.writeFileSync(alphaPath, "# Alpha\nalpha-v2\n");
    searchVault(v.vaultPath, v.vaultPath, "alpha-v2");
    const v2Stat = fs.statSync(alphaPath);
    const v2Sig = cachedSig(v.vaultPath, "Projects/alpha.md");
    expect(v2Sig).toEqual({ mtime: v2Stat.mtimeMs, size: v2Stat.size });
    expect(v2Sig).not.toEqual(coldSig);
    expect(vi.getTimerCount()).toBe(0);

    // Inside the window: nothing is written, one trailing timer is armed.
    fs.writeFileSync(alphaPath, "# Alpha\nalpha-v3-longer\n");
    searchVault(v.vaultPath, v.vaultPath, "alpha-v3-longer");
    expect(cachedSig(v.vaultPath, "Projects/alpha.md")).toEqual(v2Sig);
    expect(vi.getTimerCount()).toBe(1);

    // A third dirty diff coalesces into that same timer.
    fs.writeFileSync(alphaPath, "# Alpha\nalpha-v4-longest-yet\n");
    searchVault(v.vaultPath, v.vaultPath, "alpha-v4-longest-yet");
    expect(vi.getTimerCount()).toBe(1);

    // One trailing write, with the latest state.
    vi.advanceTimersByTime(30_000);
    expect(vi.getTimerCount()).toBe(0);
    const v4Stat = fs.statSync(alphaPath);
    expect(cachedSig(v.vaultPath, "Projects/alpha.md")).toEqual({
      mtime: v4Stat.mtimeMs,
      size: v4Stat.size,
    });

    // The trailing write restarts the window: an immediate diff defers again.
    fs.writeFileSync(alphaPath, "# Alpha\nalpha-v5-even-longer\n");
    searchVault(v.vaultPath, v.vaultPath, "alpha-v5-even-longer");
    expect(vi.getTimerCount()).toBe(1);
  });
});
