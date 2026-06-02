import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles, resolveFile } from "../utils/files.js";
import { extractLinks } from "../utils/markdown.js";

export interface VaultLinks {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  unresolved: Map<string, string[]>;
}

export function buildLinkIndex(vaultPath: string): VaultLinks {
  const files = listFiles(vaultPath, { ext: "md" });
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const unresolved = new Map<string, string[]>();

  for (const f of files) incoming.set(f, []);

  for (const file of files) {
    const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
    const links = extractLinks(content);
    outgoing.set(file, links.outgoing);

    for (const target of links.wikilinks) {
      const resolved = resolveFile(vaultPath, target);
      if (resolved) {
        if (!incoming.has(resolved.path)) incoming.set(resolved.path, []);
        incoming.get(resolved.path)?.push(file);
      } else {
        if (!unresolved.has(target)) unresolved.set(target, []);
        unresolved.get(target)?.push(file);
      }
    }
  }

  return { outgoing, incoming, unresolved };
}

export function getBacklinks(vaultPath: string, fileRef: string): string[] {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }
  const { incoming } = buildLinkIndex(vaultPath);
  return incoming.get(resolved.path) || [];
}

export function getOutgoingLinks(vaultPath: string, fileRef: string): string[] {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }
  const content = fs.readFileSync(path.join(vaultPath, resolved.path), "utf-8");
  const { outgoing } = extractLinks(content);
  return outgoing;
}

export function getUnresolvedLinks(vaultPath: string): [string, string[]][] {
  const { unresolved } = buildLinkIndex(vaultPath);
  return [...unresolved.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function getOrphans(vaultPath: string): string[] {
  const { incoming } = buildLinkIndex(vaultPath);
  return [...incoming.entries()]
    .filter(([_, links]) => links.length === 0)
    .map(([file]) => file)
    .sort();
}

export function getDeadends(vaultPath: string): string[] {
  const { outgoing } = buildLinkIndex(vaultPath);
  return [...outgoing.entries()]
    .filter(([_, links]) => links.length === 0)
    .map(([file]) => file)
    .sort();
}
