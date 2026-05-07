import * as fs from "node:fs";
import * as path from "node:path";

export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  created: number;
  modified: number;
}

export interface ListFilesOptions {
  folder?: string;
  ext?: string;
}

/**
 * Classify a Dirent that may be a symlink.
 * - Regular dir/file: returns the native kind.
 * - Symbolic link: follows via statSync and reports the target kind.
 * - Broken symlink or other special types (sockets, FIFOs, etc.): returns null.
 *
 * Using this lets callers treat symlinks to directories/files as first-class
 * entries while still gracefully skipping unreadable targets.
 */
function classifyEntry(
  fullPath: string,
  entry: fs.Dirent,
): { isDir: boolean; isFile: boolean } | null {
  if (entry.isDirectory()) return { isDir: true, isFile: false };
  if (entry.isFile()) return { isDir: false, isFile: true };
  if (entry.isSymbolicLink()) {
    try {
      const stat = fs.statSync(fullPath); // follows symlinks
      return { isDir: stat.isDirectory(), isFile: stat.isFile() };
    } catch {
      // Broken symlink or target inaccessible — silently skip.
      return null;
    }
  }
  return null;
}

/**
 * Resolve a directory's real path for cycle detection. Returns null if the
 * path can't be resolved (e.g. permission error on a traversed symlink).
 */
function safeRealpath(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * Recursively list files in a vault, skipping .obsidian, .git, .trash, node_modules.
 *
 * Symlinks to files and directories are followed; symlink cycles are detected
 * via real-path tracking and a cycle is entered at most once.
 */
export function listFiles(
  vaultPath: string,
  opts?: ListFilesOptions,
): string[] {
  const results: string[] = [];
  const skipDirs = new Set([
    ".obsidian",
    ".git",
    ".trash",
    ".nanny",
    ".napkin",
    "node_modules",
  ]);
  // Internal napkin files that shouldn't appear in vault content listings
  const skipFiles = new Set(["config.json", "search-cache.json"]);

  const baseDir = opts?.folder ? path.join(vaultPath, opts.folder) : vaultPath;
  if (!fs.existsSync(baseDir)) return results;

  const visited = new Set<string>();

  function walk(dir: string) {
    const real = safeRealpath(dir);
    if (real !== null) {
      if (visited.has(real)) return;
      visited.add(real);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && skipDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const kind = classifyEntry(fullPath, entry);
      if (!kind) continue;
      if (kind.isDir) {
        if (!skipDirs.has(entry.name)) walk(fullPath);
      } else if (kind.isFile) {
        // Skip internal config files at vault root
        if (dir === vaultPath && skipFiles.has(entry.name)) continue;
        const rel = path.relative(vaultPath, fullPath);
        if (opts?.ext) {
          if (path.extname(entry.name).slice(1) === opts.ext) {
            results.push(rel);
          }
        } else {
          results.push(rel);
        }
      }
    }
  }

  walk(baseDir);
  return results.sort();
}

/**
 * List folders in a vault, skipping hidden/system dirs.
 *
 * Symlinks to directories are followed; symlink cycles are detected via
 * real-path tracking.
 */
export function listFolders(
  vaultPath: string,
  parentFolder?: string,
): string[] {
  const results: string[] = [];
  const skipDirs = new Set([
    ".obsidian",
    ".git",
    ".trash",
    ".nanny",
    ".napkin",
    "node_modules",
  ]);

  const baseDir = parentFolder ? path.join(vaultPath, parentFolder) : vaultPath;
  if (!fs.existsSync(baseDir)) return results;

  const visited = new Set<string>();

  function walk(dir: string) {
    const real = safeRealpath(dir);
    if (real !== null) {
      if (visited.has(real)) return;
      visited.add(real);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const kind = classifyEntry(fullPath, entry);
      if (!kind) continue;
      if (kind.isDir) {
        results.push(path.relative(vaultPath, fullPath));
        walk(fullPath);
      }
    }
  }

  walk(baseDir);
  return results.sort();
}

/**
 * Find all .md files matching a wikilink-style name or exact path.
 */
function findMatches(vaultPath: string, fileRef: string): string[] {
  // Exact path
  if (fileRef.includes("/") || fileRef.endsWith(".md")) {
    const ref = fileRef.endsWith(".md") ? fileRef : `${fileRef}.md`;
    const fullPath = path.join(vaultPath, ref);
    return fs.existsSync(fullPath) ? [ref] : [];
  }

  // Wikilink-style: search by basename
  const target = fileRef.toLowerCase();
  const allFiles = listFiles(vaultPath, { ext: "md" });
  return allFiles.filter(
    (file) => path.basename(file, ".md").toLowerCase() === target,
  );
}

/**
 * Resolve a file reference (wikilink-style name or exact path) to a relative path in the vault.
 * Throws on ambiguous matches so the user can disambiguate.
 */
export function resolveFile(vaultPath: string, fileRef: string): string | null {
  const matches = findMatches(vaultPath, fileRef);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous file reference "${fileRef}" matches ${matches.length} files: ${matches.join(", ")}. Use the full path to disambiguate.`,
    );
  }
  return matches[0] ?? null;
}

/**
 * Like resolveFile but never throws on ambiguous matches.
 * Returns the shallowest match (fewest path segments), matching Obsidian's behavior.
 */
export function resolveFileLoose(
  vaultPath: string,
  fileRef: string,
): string | null {
  const matches = findMatches(vaultPath, fileRef);
  if (matches.length > 1) {
    matches.sort((a, b) => a.split("/").length - b.split("/").length);
  }
  return matches[0] ?? null;
}

/**
 * Suggest similar filenames when a file isn't found.
 * Returns up to 3 suggestions sorted by similarity.
 */
export function suggestFile(vaultPath: string, fileRef: string): string[] {
  const target = fileRef.toLowerCase();
  const allFiles = listFiles(vaultPath, { ext: "md" });
  const scored = allFiles
    .map((f) => {
      const basename = path.basename(f, ".md").toLowerCase();
      // Simple substring match scoring
      let score = 0;
      if (basename.includes(target) || target.includes(basename)) score += 3;
      // Shared prefix
      let prefix = 0;
      while (
        prefix < basename.length &&
        prefix < target.length &&
        basename[prefix] === target[prefix]
      )
        prefix++;
      score += prefix;
      return { file: f, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return scored.map((s) => s.file);
}

/**
 * Read a file's contents, resolving by name or path.
 */
export function readFile(
  vaultPath: string,
  fileRef: string,
): { path: string; content: string } {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }
  const fullPath = path.join(vaultPath, resolved);
  const content = fs.readFileSync(fullPath, "utf-8");
  return { path: resolved, content };
}

/**
 * Get file info for a resolved file path.
 */
export function getFileInfo(vaultPath: string, relativePath: string): FileInfo {
  const fullPath = path.join(vaultPath, relativePath);
  const stat = fs.statSync(fullPath);
  const ext = path.extname(relativePath);
  return {
    path: relativePath,
    name: path.basename(relativePath, ext),
    extension: ext.slice(1),
    size: stat.size,
    created: stat.birthtimeMs,
    modified: stat.mtimeMs,
  };
}
