import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../utils/config.js";
import { listFiles, resolveFile } from "../utils/files.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { extractSection } from "../utils/markdown.js";
import type { VaultInfo } from "../utils/vault.js";

/**
 * Default page size for `readFile` pagination, in bytes.
 *
 * 50KB is large enough to hold a typical section or a moderate file in a single
 * page, while keeping the per-call token cost bounded for AI agents. Empirically,
 * a 50KB page is ~12,500 tokens — well within a single tool-result budget.
 */
const DEFAULT_READ_PAGE_SIZE_BYTES = 50000;

export interface ReadOptions {
  section?: string;
  page?: number;
  pageSize?: number;
}

export interface ReadResult {
  path: string;
  content: string;
  totalPages?: number;
  currentPage?: number;
}

export interface CreateOptions {
  name?: string;
  path?: string;
  content?: string;
  template?: string;
  overwrite?: boolean;
}

export interface CreateResult {
  path: string;
  created: boolean;
}

export interface MoveResult {
  from: string;
  to: string;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  permanent: boolean;
}

export function readFile(
  vaultPath: string,
  fileRef: string,
  opts?: ReadOptions,
): ReadResult {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  let content = fs.readFileSync(path.join(vaultPath, resolved.path), "utf-8");

  const section = opts?.section ?? resolved.heading;
  if (section) {
    content = extractSection(content, section);
  }

  const pageSize = opts?.pageSize ?? DEFAULT_READ_PAGE_SIZE_BYTES;
  if (content.length <= pageSize) {
    return { path: resolved.path, content };
  }

  const totalPages = Math.ceil(content.length / pageSize);
  const page = opts?.page ?? 1;

  if (page < 1) {
    throw new Error("Page must be >= 1");
  }
  if (page > totalPages) {
    throw new Error(`Page ${page} exceeds total pages (${totalPages})`);
  }

  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, content.length);
  const chunk = content.slice(start, end);

  const suffix =
    page < totalPages
      ? `\n\n[Page ${page} of ${totalPages}. Use --page ${page + 1} to continue.]`
      : "";

  return {
    path: resolved.path,
    content: chunk + suffix,
    totalPages,
    currentPage: page,
  };
}

export function createFile(v: VaultInfo, opts: CreateOptions): CreateResult {
  let targetPath: string;
  if (opts.path) {
    targetPath = opts.path.endsWith(".md") ? opts.path : `${opts.path}.md`;
  } else {
    const name = opts.name || "Untitled";
    targetPath = `${name}.md`;
  }

  const fullPath = path.join(v.contentPath, targetPath);

  if (fs.existsSync(fullPath) && !opts.overwrite) {
    throw new Error(
      `File already exists: ${targetPath}. Use --overwrite to replace.`,
    );
  }

  let content = opts.content || "";

  if (opts.template) {
    const config = loadConfig(v.configPath);
    const templateRef =
      resolveFile(v.contentPath, opts.template) ||
      resolveFile(v.contentPath, `${config.templates.folder}/${opts.template}`);
    if (templateRef) {
      content = fs.readFileSync(
        path.join(v.contentPath, templateRef.path),
        "utf-8",
      );
    } else {
      const tmplFiles = listFiles(v.contentPath, {
        folder: config.templates.folder,
        ext: "md",
      }).map((f: string) => path.basename(f, ".md"));
      throw new Error(
        `Template not found: ${opts.template}. Available: ${tmplFiles.slice(0, 3).join(", ")}`,
      );
    }
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  return { path: targetPath, created: true };
}

export function appendFile(
  vaultPath: string,
  fileRef: string,
  content: string,
  inline?: boolean,
): string {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const existing = fs.readFileSync(fullPath, "utf-8");
  const separator = inline ? "" : "\n";
  fs.writeFileSync(fullPath, existing + separator + content);

  return resolved.path;
}

export function prependFile(
  vaultPath: string,
  fileRef: string,
  content: string,
  inline?: boolean,
): string {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);
  const existing = fs.readFileSync(fullPath, "utf-8");
  const separator = inline ? "" : "\n";

  const { properties, body, raw } = parseFrontmatter(existing);
  if (Object.keys(properties).length > 0) {
    const frontmatter = `---\n${raw}\n---\n`;
    fs.writeFileSync(fullPath, frontmatter + content + separator + body);
  } else {
    fs.writeFileSync(fullPath, content + separator + existing);
  }

  return resolved.path;
}

export function moveFile(
  vaultPath: string,
  fileRef: string,
  destination: string,
): MoveResult {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  let destPath = destination;
  if (!destPath.endsWith(".md")) {
    destPath = path.join(destPath, path.basename(resolved.path));
  }

  const srcFull = path.join(vaultPath, resolved.path);
  const destFull = path.join(vaultPath, destPath);
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(srcFull, destFull);

  return { from: resolved.path, to: destPath };
}

export function renameFile(
  vaultPath: string,
  fileRef: string,
  newName: string,
): MoveResult {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const name = newName.endsWith(".md") ? newName : `${newName}.md`;
  const destPath = path.join(path.dirname(resolved.path), name);
  const srcFull = path.join(vaultPath, resolved.path);
  const destFull = path.join(vaultPath, destPath);
  fs.renameSync(srcFull, destFull);

  return { from: resolved.path, to: destPath };
}

export function deleteFile(
  vaultPath: string,
  fileRef: string,
  permanent?: boolean,
): DeleteResult {
  const resolved = resolveFile(vaultPath, fileRef);
  if (!resolved) {
    throw new Error(`File not found: ${fileRef}`);
  }

  const fullPath = path.join(vaultPath, resolved.path);

  if (permanent) {
    fs.unlinkSync(fullPath);
  } else {
    const trashDir = path.join(vaultPath, ".trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const trashPath = path.join(trashDir, path.basename(resolved.path));
    fs.renameSync(fullPath, trashPath);
  }

  return { path: resolved.path, deleted: true, permanent: !!permanent };
}
