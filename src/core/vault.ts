import * as fs from "node:fs";
import { listFiles, listFolders, walkDir } from "../utils/files.js";
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
  walkDir(vaultPath, (fullPath, _entry, kind) => {
    if (kind !== "file") return;
    try {
      total += fs.statSync(fullPath).size;
    } catch {
      // Entry disappeared between readdir and stat — skip.
    }
  });
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
