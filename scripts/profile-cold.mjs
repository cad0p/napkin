// Cold-path profiler for Approach G (current search.ts).
// Times each phase of the cold build against the Goldmine vault.
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";

const VAULT = process.argv[2] || "/home/pier/personal/github/Goldmine";
const t0 = performance.now();
let mark = t0;
const lap = (label) => {
  const now = performance.now();
  console.log(`${label.padEnd(38)} ${(now - mark).toFixed(1).padStart(9)} ms  (cum ${(now - t0).toFixed(0)}ms)`);
  mark = now;
};

// --- listFiles (walk) ---
const results = [];
(function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.endsWith(".md")) results.push(path.relative(VAULT, full));
  }
})(VAULT);
const files = results.sort();
lap(`listFiles (walk, ${files.length} files)`);

// --- readFiles + stat ---
const docs = [];
let totalBytes = 0;
for (const f of files) {
  const full = path.join(VAULT, f);
  const content = fs.readFileSync(full, "utf-8");
  const st = fs.statSync(full);
  totalBytes += content.length;
  docs.push({ file: f, basename: path.basename(f, ".md"), content, mtime: st.mtimeMs });
}
lap(`readFileSync+statSync ×${files.length} (${(totalBytes/1e6).toFixed(1)}MB)`);

// --- extractLinks (regex per file) ---
// replicate markdown.ts extractLinks wikilink extraction
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
for (const d of docs) {
  const links = [];
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(d.content)) !== null) links.push(m[1]);
  d.outgoingLinks = links;
}
lap(`extractLinks (wikilink regex) ×${files.length}`);

// --- basename map + backlinks ---
const basenameMap = new Map();
for (const d of docs) {
  const key = d.basename.toLowerCase();
  const ex = basenameMap.get(key);
  if (ex) ex.push(d.file); else basenameMap.set(key, [d.file]);
}
for (const paths of basenameMap.values()) {
  if (paths.length > 1) paths.sort((a, b) => a.split("/").length - b.split("/").length);
}
const backlinkCounts = new Map();
let linkCount = 0;
for (const d of docs) {
  for (const tgt of d.outgoingLinks) {
    linkCount++;
    const key = tgt.includes("/") || tgt.endsWith(".md")
      ? path.basename(tgt.endsWith(".md") ? tgt : tgt + ".md", ".md").toLowerCase()
      : tgt.toLowerCase();
    const matches = basenameMap.get(key);
    if (matches && matches.length) {
      const resolved = tgt.includes("/") || tgt.endsWith(".md")
        ? (tgt.endsWith(".md") ? tgt : tgt + ".md")
        : matches[0];
      backlinkCounts.set(resolved, (backlinkCounts.get(resolved) || 0) + 1);
    }
  }
}
lap(`backlinks in-memory (${linkCount} links)`);

// --- basename-only MiniSearch addAll ---
const idx = new MiniSearch({ fields: ["basename"], storeFields: ["file"], idField: "file" });
idx.addAll(docs);
lap(`MiniSearch.addAll basename-only ×${docs.length}`);

// --- cache serialize ---
const cacheObj = {
  folder: null,
  fileMtimes: Object.fromEntries(docs.map((d) => [d.file, d.mtime])),
  index: JSON.stringify(idx),
  docs: docs.map((d) => ({ file: d.file, basename: d.basename, mtime: d.mtime })),
  backlinkCounts: Object.fromEntries(backlinkCounts),
  outgoingLinks: Object.fromEntries(docs.map((d) => [d.file, d.outgoingLinks])),
};
const json = JSON.stringify(cacheObj);
lap(`JSON.stringify(cache) → ${(json.length/1e6).toFixed(2)}MB`);

fs.writeFileSync("/tmp/_bench-cache.json", json);
lap(`fs.writeFileSync`);
fs.unlinkSync("/tmp/_bench-cache.json");

// --- content scan (query-time) ---
const terms = ["distill"];
for (const d of docs) {
  const lo = d.content.toLowerCase();
  let c = 0, i = 0;
  while ((i = lo.indexOf("distill", i)) !== -1) { c++; i += 7; }
}
lap(`contentScan ×${docs.length} ("distill")`);

console.log(`\nTOTAL (excl startup): ${(performance.now() - t0).toFixed(0)} ms`);
