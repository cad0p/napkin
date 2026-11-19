import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles } from "./files.js";
import type { Ignorer } from "./ignore.js";

/**
 * A wikilink target classified the way resolution narrows it (#92).
 *
 * Shared by `search.ts` (in-memory link tallies) and `SqliteStore` (#94),
 * which persists the same classification in `links`/`link_counts`: a target
 * with a slash or a `.md` suffix resolves as a path (keeping its own
 * spelling); anything else is a bare basename lookup.
 */
export interface LinkTarget {
  /** Lowercased basename the target resolves through. */
  key: string;
  /** Path-style ref ("folder/note.md"), or null for a bare-name link. */
  ref: string | null;
}

export function linkTarget(target: string): LinkTarget {
  if (target.includes("/") || target.endsWith(".md")) {
    const ref = target.endsWith(".md") ? target : `${target}.md`;
    return { key: path.basename(ref, ".md").toLowerCase(), ref };
  }
  return { key: target.toLowerCase(), ref: null };
}

/**
 * The `link_counts` row key for a classified target: the bare basename for
 * bare links, `p:<ref>` for path links — so the two namespaces never collide
 * (a path ref keeps its folder spelling).
 */
export function linkCountKey(link: LinkTarget): string {
  return link.ref === null ? link.key : `p:${link.ref}`;
}

/**
 * Per-file stat signatures for the search index, and the diff that turns two
 * of them into "what to re-read" and "what to forget".
 *
 * This module is deliberately store-agnostic: the persisted snapshot lives
 * behind `IndexStore` (`JsonStore` today, a SQLite store next, #94), and both
 * need the same change detection — an mtime+size signature per file, compared
 * the same way, with the same "an unchanged vault touches no I/O" outcome.
 */
export interface FileMtimeEntry {
  file: string;
  mtime: number;
  /** File size in bytes — a second change signal alongside mtime. */
  size: number;
}

/**
 * Stat all .md files in the vault (within optional folder scope).
 * Single directory walk + per-file stat — the unavoidable per-search floor.
 *
 * Captures `mtimeMs` AND `size` because some filesystems (ext4/tmpfs) report
 * identical `mtimeMs` for rapid successive writes within the same tick — an
 * mtime-only diff would miss a same-tick content edit and serve a stale index.
 * Size catches the common case (any edit that changes byte length) at zero
 * extra cost. A same-tick AND same-size edit is a pathological corner that
 * would require content hashing to detect; we deliberately accept that
 * tradeoff to keep the warm path free of full-content reads.
 */
export function statAllFiles(
  contentPath: string,
  folder?: string,
  ignore?: Ignorer,
): FileMtimeEntry[] {
  const files = listFiles(contentPath, { folder, ext: "md", ignore });
  const entries: FileMtimeEntry[] = [];
  for (const file of files) {
    const stat = fs.statSync(path.join(contentPath, file));
    entries.push({ file, mtime: stat.mtimeMs, size: stat.size });
  }
  return entries;
}

/**
 * Compute a fingerprint of all .md files based on paths and mtimes.
 * Changes when files are added, removed, or modified.
 *
 * @deprecated Used by legacy tests; `searchVault` now uses `statAllFiles` +
 * `diffFileMtimes` for incremental updates. Kept for backward compatibility.
 */
export function computeFingerprint(
  contentPath: string,
  folder?: string,
): string {
  const entries = statAllFiles(contentPath, folder);
  const hash = crypto.createHash("md5");
  for (const { file, mtime, size } of entries) {
    hash.update(`${file}:${mtime}:${size}\n`);
  }
  return hash.digest("hex");
}

export interface FileDiff {
  /** New or modified files (need to be read + indexed). */
  toAdd: FileMtimeEntry[];
  /** Deleted files (need to be discarded from index). */
  toRemove: string[];
  /** True when nothing changed — the fast warm path. */
  unchanged: boolean;
}

/**
 * Cached per-file stat signature used for change detection.
 * Keyed by file path; a file is "changed" when mtime OR size differs.
 */
export interface FileStatSig {
  mtime: number;
  size: number;
}

/**
 * Diff cached file stats against current stat results.
 * Returns the set of files to add/modify and to remove.
 *
 * A file is treated as modified when its mtime OR its size differs from the
 * cached value. Comparing size in addition to mtime catches same-tick edits
 * (where the filesystem reports an unchanged mtimeMs) as long as the byte
 * length changed — the common case for real edits.
 */
export function diffFileMtimes(
  cached: Record<string, FileStatSig>,
  current: FileMtimeEntry[],
): FileDiff {
  const currentMap = new Map(current.map((e) => [e.file, e]));
  const toAdd: FileMtimeEntry[] = [];
  const toRemove: string[] = [];

  for (const entry of current) {
    const cachedSig = cached[entry.file];
    if (
      cachedSig === undefined ||
      cachedSig.mtime !== entry.mtime ||
      cachedSig.size !== entry.size
    ) {
      toAdd.push(entry);
    }
  }
  for (const file of Object.keys(cached)) {
    if (!currentMap.has(file)) {
      toRemove.push(file);
    }
  }

  return {
    toAdd,
    toRemove,
    unchanged: toAdd.length === 0 && toRemove.length === 0,
  };
}
