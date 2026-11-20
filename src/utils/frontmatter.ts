import { createRequire } from "node:module";
import type matter from "gray-matter";

/**
 * gray-matter (with js-yaml and esprima) is loaded lazily on the first
 * parse, not at module load: the slim `@cad0p/napkin/overview` entry
 * (#123) reaches this module through core/overview.ts, but an all-hit
 * overview run never parses frontmatter — deferring the require keeps that
 * dependency out of processes that only read the overview caches.
 * `createRequire` is used because gray-matter is CJS.
 */
type Matter = typeof matter;
type GrayMatterFile = matter.GrayMatterFile<string>;

let matterModule: Matter | undefined;

function loadMatter(): Matter {
  if (matterModule === undefined) {
    matterModule = createRequire(import.meta.url)("gray-matter") as Matter;
  }
  return matterModule;
}

/**
 * gray-matter caches the file object keyed by content BEFORE parsing it, so
 * a failed parse leaves a poisoned entry: the next parse of a byte-identical
 * string silently returns the cached, unparsed object (empty data, no error).
 * Evict the cache when parsing throws so every parse of malformed content
 * fails deterministically.
 */
function safeMatter(content: string, cache = true): GrayMatterFile {
  const matter = loadMatter();
  try {
    // Any options object (even {}, which resolves to the same defaults)
    // bypasses gray-matter's process-lifetime cache.
    return cache ? matter(content) : matter(content, {});
  } catch (err) {
    // Runtime-only API not present in gray-matter's type declarations.
    (matter as unknown as { clearCache: () => void }).clearCache();
    throw err;
  }
}

export interface ParsedFrontmatter {
  properties: Record<string, unknown>;
  body: string;
  raw: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 *
 * gray-matter memoizes every parse it is given without options in a
 * module-level object keyed by the content string — the content, its Buffer
 * copy and the parse result stay reachable for the life of the process.
 * One-pass scans over a whole vault (the overview's note tokenizing, #131)
 * pass `{ cache: false }` so each note is garbage once it is tokenized; the
 * parse result is the same either way.
 */
export function parseFrontmatter(
  content: string,
  opts?: { cache?: boolean },
): ParsedFrontmatter {
  const result = safeMatter(content, opts?.cache ?? true);
  return {
    properties: result.data,
    body: result.content,
    raw: result.matter,
  };
}

/**
 * Set a property in frontmatter, creating the --- block if needed.
 */
export function setProperty(
  content: string,
  name: string,
  value: unknown,
): string {
  const matter = loadMatter();
  const result = safeMatter(content);
  const data = { ...result.data, [name]: value };
  return matter.stringify(result.content, data);
}

/**
 * Remove a property from frontmatter.
 */
export function removeProperty(content: string, name: string): string {
  const matter = loadMatter();
  const result = safeMatter(content);
  const data = { ...result.data };
  delete data[name];
  // If no properties left, return just the body
  if (Object.keys(data).length === 0) {
    const body = result.content;
    return body.startsWith("\n") ? body.slice(1) : body;
  }
  return matter.stringify(result.content, data);
}
