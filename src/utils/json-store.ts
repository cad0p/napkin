import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IndexedDoc, IndexSnapshot, IndexStore } from "./index-store.js";

const CACHE_FILE = "search-cache.json";

/**
 * The JSON snapshot store: one file, rewritten whole (today's #84 cache).
 *
 * The file name, the validation and the atomic rename are unchanged from the
 * pre-#94 cache — this module is that code, moved behind `IndexStore`. The
 * format itself (field names, versioning by shape, legacy `content` stripping)
 * is this store's business; `search.ts` only sees `IndexSnapshot`.
 *
 * Write cost is O(vault): the whole snapshot is serialized and renamed. That is
 * what makes the search-side throttle (30 s, leading edge plus one trailing
 * write) necessary today, and what `SqliteStore`'s per-file deltas will retire.
 */
export class JsonStore implements IndexStore {
  constructor(private readonly configPath: string) {}

  load(): IndexSnapshot | null {
    return loadSearchCache(this.configPath);
  }

  save(snapshot: IndexSnapshot): void {
    saveSearchCache(this.configPath, snapshot);
  }
}

/**
 * Load cached search index if it exists and is valid.
 * Returns null if no cache or corrupted data.
 * The caller is responsible for diffing fileMtimes to decide warm vs incremental.
 */
export function loadSearchCache(configPath: string): IndexSnapshot | null {
  const cachePath = path.join(configPath, CACHE_FILE);
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as Partial<IndexSnapshot>;
    // Shape validation — reject old-format caches (with `fingerprint` instead
    // of `fileMtimes`) and missing fields.
    if (
      !data.fileMtimes ||
      typeof data.fileMtimes !== "object" ||
      !data.index ||
      !Array.isArray(data.docs) ||
      !data.backlinkCounts ||
      !data.outgoingLinks ||
      typeof data.ignoreFingerprint !== "string"
    ) {
      return null;
    }
    // Docs carry metadata only (#85). Rebuild the entries instead of
    // returning them as parsed so a legacy cache that still embeds
    // `docs[].content` is accepted (no rejection, correct recall) but the
    // note text is dropped here — it never reaches the in-memory cache.
    const docs: IndexedDoc[] = [];
    for (const doc of data.docs) {
      if (
        !doc ||
        typeof doc.file !== "string" ||
        typeof doc.basename !== "string" ||
        typeof doc.mtime !== "number" ||
        typeof doc.size !== "number"
      ) {
        return null;
      }
      docs.push({
        file: doc.file,
        basename: doc.basename,
        mtime: doc.mtime,
        size: doc.size,
      });
    }
    return {
      folder: data.folder as string | null,
      fileMtimes: data.fileMtimes,
      index: data.index,
      docs,
      backlinkCounts: data.backlinkCounts,
      outgoingLinks: data.outgoingLinks,
      ignoreFingerprint: data.ignoreFingerprint,
    };
  } catch {
    return null;
  }
}

/**
 * Save search index cache to disk.
 *
 * Atomic: the snapshot is written to a temp file in the same directory and
 * renamed over the target, so a reader never observes a half-written cache
 * and a crash mid-write leaves the previous snapshot intact. Concurrent
 * writers are safe without locking — every write is a full snapshot that
 * `loadSearchCache` re-validates against file mtime+size, so last-writer-wins
 * is correct.
 *
 * Throws on I/O failure (after removing the temp file); callers that treat
 * persistence as best-effort swallow it.
 */
export function saveSearchCache(configPath: string, data: IndexSnapshot): void {
  const cachePath = path.join(configPath, CACHE_FILE);
  // pid + random suffix: two writers (or a run that crashed mid-write) never
  // share a temp path, so one cannot clobber the other's half-written file.
  const tmpPath = path.join(
    configPath,
    `${CACHE_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, cachePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; the write error below is the one that matters.
    }
    throw err;
  }
}
