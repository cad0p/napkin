import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles, listFolders } from "../utils/files.js";
import type { VaultInfo } from "../utils/vault.js";

export interface VaultMetadata {
  name: string;
  path: string;
  files: number;
  folders: number;
  size: number;
}

function getVaultSize(vaultPath: string): number {
  let total = 0;
  const visited = new Set<string>();
  function walk(dir: string) {
    try {
      const real = fs.realpathSync(dir);
      if (visited.has(real)) return;
      visited.add(real);
    } catch {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".obsidian" ||
        entry.name === ".napkin"
      )
        continue;
      const full = path.join(dir, entry.name);
      // Resolve symlinks via statSync so symlinked dirs/files are counted.
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        // Broken symlink or inaccessible — skip.
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) total += stat.size;
    }
  }
  walk(vaultPath);
  return total;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getVaultMetadata(v: VaultInfo): VaultMetadata {
  const files = listFiles(v.contentPath);
  const folders = listFolders(v.contentPath);
  const size = getVaultSize(v.contentPath);

  return {
    name: v.name,
    path: v.contentPath,
    files: files.length,
    folders: folders.length,
    size,
  };
}
