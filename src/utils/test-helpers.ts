import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, saveConfig } from "./config.js";
import { forceJsonIndexStoreForTests } from "./index-store.js";
import {
  forceJsonOverviewStoreForTests,
  overviewStoreDbFileForTests,
  resetOverviewStoresForTests,
} from "./overview-store.js";
import { NAPKIN_MARKER } from "./vault.js";

/**
 * Create a temporary vault for testing.
 * Embedded layout with an EXPLICIT root: .napkin/ is the vault root (content
 * lives inside it), declared via vault.root = "." — never the implicit
 * legacy fallback, which is refused.
 * Returns:
 *   - path: parent dir (pass to --vault for commands, findVault walks up from here)
 *   - vaultPath: the .napkin/ dir (pass directly to utility functions like listFiles)
 *   - cleanup: removes everything
 */
export function createTempVault(files?: Record<string, string>): {
  path: string;
  vaultPath: string;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-test-"));

  // .napkin/ IS the vault root, declared explicitly
  const napkinDir = path.join(tmpDir, NAPKIN_MARKER);
  fs.mkdirSync(napkinDir, { recursive: true });

  // Write config.json which also syncs .obsidian/
  const testConfig = {
    ...DEFAULT_CONFIG,
    daily: {
      ...DEFAULT_CONFIG.daily,
      folder: "Inbox/Daily",
    },
    vault: { root: "." },
  };
  saveConfig(napkinDir, testConfig);

  // Write files inside .napkin/ (the vault root)
  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const full = path.join(napkinDir, filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  return {
    path: tmpDir,
    vaultPath: napkinDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Pin the vault's search index store to JSON (#106): for tests that assert
 * on `search-cache.json` itself — its bytes, its mtime, its throttle — now
 * that the store is SQLite (`.napkin/cache/index-v2.db`). Test-only seam:
 * there is no user-facing store selection, the pin lives in index-store
 * module state keyed by this vault's config dir.
 */
export function useJsonIndexStore(vaultPath: string): void {
  forceJsonIndexStoreForTests(vaultPath);
}

/**
 * Drop every on-disk search index — `search-cache.json` AND the SQLite
 * store's `cache/index-v2.db` (+ WAL/SHM sidecars) — so the next search
 * cold-builds regardless of the configured store (#106).
 */
export function dropSearchStoreFiles(vaultPath: string): void {
  fs.rmSync(path.join(vaultPath, "search-cache.json"), { force: true });
  const db = path.join(vaultPath, "cache", "index-v2.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${db}${suffix}`, { force: true });
  }
}

/**
 * Pin the vault's overview folder-data store to the JSON cache (#118): for
 * tests that assert on overview-folders-cache.json itself — its bytes, its
 * mtime, its compaction — now that the store is SQLite
 * (.napkin/cache/overview-v2.db). Test-only seam: there is no user-facing
 * store selection, the pin lives in overview-store module state keyed by
 * this vault's config dir.
 */
export function useJsonOverviewStore(vaultPath: string): void {
  forceJsonOverviewStoreForTests(vaultPath);
}

/**
 * Drop every on-disk overview store — overview-folders-cache.json AND the
 * SQLite store's cache/overview-v2.db (+ WAL/SHM sidecars) — so the next
 * overview rebuilds every folder regardless of the configured store (#118).
 * The whole-result overview-cache.json is removed too: a "cold" run means
 * computing, not answering from the result cache.
 */
export function dropOverviewStoreFiles(vaultPath: string): void {
  fs.rmSync(path.join(vaultPath, "overview-cache.json"), { force: true });
  fs.rmSync(path.join(vaultPath, "overview-folders-cache.json"), {
    force: true,
  });
  const db = path.join(vaultPath, "cache", overviewStoreDbFileForTests());
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${db}${suffix}`, { force: true });
  }
}

/**
 * Drop the cached overview-store objects so a test observes a fresh
 * selection (and a fresh SQLite connection) the way a new process would.
 */
export function resetOverviewIndexForTests(): void {
  resetOverviewStoresForTests();
}
