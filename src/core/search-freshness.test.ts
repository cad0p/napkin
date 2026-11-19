import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Napkin } from "../sdk.js";
import { createTempVault } from "../utils/test-helpers.js";
import {
  getCachedDocForTests,
  resetSearchIndexForTests,
  searchVault,
} from "./search.js";

/**
 * Search freshness gate (#93): a search inside the configured window reuses
 * the index instead of walking the vault, while writes made through napkin in
 * the same process stay visible (read-your-writes).
 *
 * "Another process" is simulated by writing straight to disk with fs, which
 * is exactly what the distill CLI or a second pi session does.
 */

/** Long enough that no test can cross the window by accident. */
const TTL = 60_000;

let v: { path: string; vaultPath: string; cleanup: () => void };
let n: Napkin;

beforeEach(() => {
  resetSearchIndexForTests();
  v = createTempVault({
    "Projects/existing.md": "# Existing\n- [ ] zqtask\n[[zqtarget]]\n",
    "Projects/zqtarget.md": "# Target\nbacklink-target\n",
    "Templates/Marker.md": "# Marker\n\n[[zqtarget]]\n",
    "Templates/Daily Note.md": "# {{date}}\nzqdailyseed\n",
  });
  n = new Napkin(v.path);
});

afterEach(() => {
  resetSearchIndexForTests();
  vi.useRealTimers();
  v.cleanup();
});

/** Search as the CLI does (no freshness window). */
function walkSearch(query: string): string[] {
  return searchVault(v.vaultPath, v.vaultPath, query, {
    snippets: false,
  }).map((r) => r.file);
}

/** Search inside a freshness window; the default for a long-lived consumer. */
function windowSearch(query: string, freshnessMs = TTL): string[] {
  return searchVault(v.vaultPath, v.vaultPath, query, {
    snippets: false,
    freshnessMs,
  }).map((r) => r.file);
}

/** Write a note directly to disk, bypassing napkin — another process. */
function externalWrite(file: string, content: string): void {
  const full = path.join(v.vaultPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("freshness window", () => {
  test("inside the window another process's note is not seen", () => {
    expect(windowSearch("zqexternal")).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    // No walk, so the new note is invisible — the documented trade-off.
    expect(windowSearch("zqexternal")).toEqual([]);
  });

  test("after the window expires the walk picks the note up", () => {
    vi.useFakeTimers();
    expect(windowSearch("zqexternal")).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    expect(windowSearch("zqexternal")).toEqual([]);

    vi.setSystemTime(Date.now() + TTL + 1);
    expect(windowSearch("zqexternal")).toEqual(["Projects/zqexternal.md"]);
  });

  test("a window of 0 (the default) walks on every search", () => {
    expect(walkSearch("zqexternal")).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    expect(walkSearch("zqexternal")).toEqual(["Projects/zqexternal.md"]);
  });

  test("no option and no config key means a window of 0", () => {
    expect(n.search("zqexternal", { snippets: false })).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    expect(
      n.search("zqexternal", { snippets: false }).map((r) => r.file),
    ).toEqual(["Projects/zqexternal.md"]);
  });

  test("config search.freshnessMs opens the window", () => {
    n.configSet("search.freshnessMs", String(TTL));
    expect(n.search("zqexternal", { snippets: false })).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    expect(n.search("zqexternal", { snippets: false })).toEqual([]);
  });

  test("a per-call window of 0 overrides the instance default", () => {
    const instance = new Napkin(v.path, { searchFreshnessMs: TTL });
    const search = (freshnessMs?: number) =>
      instance
        .search("zqexternal", { snippets: false, freshnessMs })
        .map((r) => r.file);

    expect(search()).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    expect(search()).toEqual([]);
    // An explicit 0 asks for a walk: the other process's note appears.
    expect(search(0)).toEqual(["Projects/zqexternal.md"]);
  });

  test("a second vault is not covered by the first vault's window", () => {
    const other = createTempVault({ "Note.md": "# Note\nzqother\n" });
    try {
      expect(windowSearch("zqtarget")).toContain("Projects/zqtarget.md");
      // The second vault has never been walked in this process, so its first
      // search must walk — freshness state is per content path.
      const results = searchVault(other.vaultPath, other.vaultPath, "zqother", {
        snippets: false,
        freshnessMs: TTL,
      });
      expect(results.map((r) => r.file)).toEqual(["Note.md"]);
    } finally {
      other.cleanup();
    }
  });

  test("resetSearchIndexForTests drops the window", () => {
    expect(windowSearch("zqexternal")).toEqual([]);
    externalWrite("Projects/zqexternal.md", "# External\nzqexternal\n");
    expect(windowSearch("zqexternal")).toEqual([]);

    resetSearchIndexForTests();
    expect(windowSearch("zqexternal")).toEqual(["Projects/zqexternal.md"]);
  });
});

describe("read your writes inside the window", () => {
  /** Open the window with a first search, then search inside it. */
  function openWindow(): void {
    expect(windowSearch("zqtarget")).toContain("Projects/zqtarget.md");
  }

  test("create", () => {
    openWindow();
    n.create({ name: "zq-created", content: "# Created\nzqcreated\n" });
    expect(windowSearch("zqcreated")).toEqual(["zq-created.md"]);
  });

  test("delete", () => {
    openWindow();
    expect(walkSearch("backlink-target")).toEqual(["Projects/zqtarget.md"]);

    n.delete("Projects/zqtarget", true);
    // The basename index dropped it too, not just the content scan (which
    // reads from disk and would miss the file anyway).
    expect(windowSearch("zqtarget")).not.toContain("Projects/zqtarget.md");
    expect(windowSearch("backlink-target")).toEqual([]);
    expect(windowSearch("zqtask")).toEqual(["Projects/existing.md"]);
  });

  test("move", () => {
    openWindow();
    n.move("Projects/existing", "Archive");
    expect(windowSearch("zqtask")).toEqual(["Archive/existing.md"]);
  });

  test("rename", () => {
    openWindow();
    n.rename("Projects/existing", "zqrenamed");
    expect(windowSearch("zqtask")).toEqual(["Projects/zqrenamed.md"]);
  });

  test("append updates links and the indexed signature", () => {
    openWindow();
    n.create({
      path: "Projects/zqlinktarget",
      content: "# Target\nunrelated\n",
    });
    openWindow();

    n.append("Projects/existing", "\n[[zqlinktarget]]");
    expect(linkCount("Projects/zqlinktarget.md", "unrelated")).toBe(1);
    expectIndexedSignature("Projects/existing.md");
  });

  test("prepend updates links", () => {
    openWindow();
    n.create({
      path: "Projects/zqprepended",
      content: "# Target\nunrelated\n",
    });
    openWindow();

    n.prepend("Projects/existing", "[[zqprepended]]\n");
    expect(linkCount("Projects/zqprepended.md", "unrelated")).toBe(1);
  });

  test("frontmatter property set", () => {
    openWindow();
    n.propertySet("Projects/existing", "zqprop", "1");
    expectIndexedSignature("Projects/existing.md");
  });

  test("task update re-reads the note", () => {
    openWindow();
    const before = getCachedDocForTests(v.vaultPath, "Projects/existing.md");
    n.taskUpdate("Projects/existing.md", 2, "x");
    windowSearch("zqtarget");
    const after = getCachedDocForTests(v.vaultPath, "Projects/existing.md");
    // A status change keeps the byte length, so an unchanged signature cannot
    // prove the re-read: the record itself must be a fresh one.
    expect(after).not.toBe(before);
    expectIndexedSignature("Projects/existing.md");
  });

  test("daily note creation", () => {
    openWindow();
    const daily = n.dailyEnsure();
    expect(windowSearch("zqdailyseed")).toContain(daily.path);
  });

  test("daily append updates links", () => {
    openWindow();
    const daily = n.dailyEnsure();
    openWindow();
    const before = linkCount("Projects/zqtarget.md", "backlink-target");

    n.dailyAppend("[[zqtarget]]");
    expect(linkCount("Projects/zqtarget.md", "backlink-target")).toBe(
      before + 1,
    );
    expectIndexedSignature(daily.path);
  });

  test("template instantiation updates links", () => {
    openWindow();
    const before = linkCount("Projects/zqtarget.md", "backlink-target");
    n.templateInsert("Marker", "Projects/existing");
    expect(linkCount("Projects/zqtarget.md", "backlink-target")).toBe(
      before + 1,
    );
  });
});

/** Backlink count the index reports for `file` (found via `query`). */
function linkCount(file: string, query: string): number | undefined {
  return searchVault(v.vaultPath, v.vaultPath, query, {
    snippets: false,
    freshnessMs: TTL,
  }).find((r) => r.file === file)?.links;
}

/**
 * The next search picks the write up: the cached doc for `file` then carries
 * the on-disk mtime+size instead of the pre-write signature.
 */
function expectIndexedSignature(file: string): void {
  windowSearch("zqtarget");
  const doc = getCachedDocForTests(v.vaultPath, file);
  expect(doc).toBeDefined();
  const stat = fs.statSync(path.join(v.vaultPath, file));
  expect({ mtime: doc?.mtime, size: doc?.size }).toEqual({
    mtime: stat.mtimeMs,
    size: stat.size,
  });
}

describe("dirty paths must be enumerable", () => {
  test("an ignored path never enters the index", () => {
    fs.writeFileSync(path.join(v.vaultPath, ".napkinignore"), "build/\n");
    expect(windowSearch("zqignored")).toEqual([]);

    n.create({ path: "build/zqignored", content: "# Ignored\nzqignored\n" });
    expect(windowSearch("zqignored")).toEqual([]);

    // Nor after the window expires: the walk prunes build/ as before.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + TTL + 1);
    expect(windowSearch("zqignored")).toEqual([]);
  });

  test("a non-markdown write does not enter the index", () => {
    expect(windowSearch("zqcanvas")).toEqual([]);
    n.canvasCreate("zqcanvas");
    expect(windowSearch("zqcanvas")).toEqual([]);
  });
});
