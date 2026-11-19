import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createIndexStore, type IndexSnapshot } from "./index-store.js";
import { JsonStore } from "./json-store.js";
import { createTempVault, useJsonIndexStore } from "./test-helpers.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  vault = createTempVault({ "README.md": "# Vault\nWelcome" });
  // These tests assert on JsonStore behaviour — pin the fallback, since
  // automatic selection picks SqliteStore (#106).
  useJsonIndexStore(vault.vaultPath);
});

afterEach(() => {
  vault.cleanup();
});

function snapshot(ignoreFingerprint = "fp-test"): IndexSnapshot {
  return {
    folder: null,
    fileMtimes: { "README.md": { mtime: 1000, size: 42 } },
    index: '{"serialized":"index"}',
    docs: [{ file: "README.md", basename: "README", mtime: 1000, size: 42 }],
    backlinkCounts: { "README.md": 2 },
    outgoingLinks: { "README.md": [] },
    ignoreFingerprint,
  };
}

describe("createIndexStore", () => {
  test("selects the pinned JsonStore", () => {
    expect(createIndexStore(vault.vaultPath)).toBeInstanceOf(JsonStore);
  });

  test("an empty vault has no snapshot to load", () => {
    expect(createIndexStore(vault.vaultPath).load()).toBeNull();
  });

  test("round-trips a snapshot through the unchanged JSON cache file", () => {
    // The seam is introduced with no behaviour change (#94): the JSON store is
    // still one `.napkin/search-cache.json` in the same format, so a store
    // written here is the file every earlier napkin version wrote and reads.
    const store = createIndexStore(vault.vaultPath);
    store.save(snapshot());

    expect(fs.existsSync(path.join(vault.vaultPath, "search-cache.json"))).toBe(
      true,
    );
    expect(createIndexStore(vault.vaultPath).load()).toEqual(snapshot());
  });
});
