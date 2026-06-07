import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles, resolveFile } from "../utils/files.js";
import {
  parseFrontmatter,
  removeProperty as removeProp,
  setProperty as setProp,
} from "../utils/frontmatter.js";

export function collectProperties(
  vaultPath: string,
  fileFilter?: string,
): Map<string, number> {
  const propCounts = new Map<string, number>();

  const files = fileFilter
    ? (() => {
        const r = resolveFile(vaultPath, fileFilter);
        return r ? [r.path] : [];
      })()
    : listFiles(vaultPath, { ext: "md" });

  for (const file of files) {
    const content = fs.readFileSync(path.join(vaultPath, file), "utf-8");
    const { properties } = parseFrontmatter(content);
    for (const key of Object.keys(properties)) {
      propCounts.set(key, (propCounts.get(key) || 0) + 1);
    }
  }

  return propCounts;
}

export function setProperty(
  vaultPath: string,
  fileRef: string,
  name: string,
  value: string,
): { path: string; property: string; value: unknown } {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const content = fs.readFileSync(fullPath, "utf-8");

  let parsedValue: unknown = value;
  if (value === "true") parsedValue = true;
  else if (value === "false") parsedValue = false;
  else if (!Number.isNaN(Number(value)) && value.trim() !== "")
    parsedValue = Number(value);

  const updated = setProp(content, name, parsedValue);
  fs.writeFileSync(fullPath, updated);

  return { path: resolved.path, property: name, value: parsedValue };
}

export function removeProperty(
  vaultPath: string,
  fileRef: string,
  name: string,
): { path: string; removed: string } {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const content = fs.readFileSync(fullPath, "utf-8");
  const updated = removeProp(content, name);
  fs.writeFileSync(fullPath, updated);

  return { path: resolved.path, removed: name };
}

export function readProperty(
  vaultPath: string,
  fileRef: string,
  name: string,
): { property: string; value: unknown } {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const content = fs.readFileSync(fullPath, "utf-8");
  const { properties: props } = parseFrontmatter(content);

  return { property: name, value: props[name] ?? null };
}
