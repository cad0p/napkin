#!/usr/bin/env node
// Vault-growth scaling benchmark for napkin search.
// Measures cold + warm + touch-one latency at increasing vault sizes by
// symlinking N files from Goldmine into a synthetic vault, then running the
// real CLI. Produces the latency-vs-size log pattern.
//
// Usage: node scripts/scale-bench.mjs [goldmineRoot] [outCsv]
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const GOLDMINE = process.argv[2] || "/home/pier/personal/github/Goldmine";
const OUT = process.argv[3] || path.join(os.tmpdir(), "napkin-scale.csv");
const NAPKIN = "/home/pier/open-source/github/napkin/bin/napkin.js";
const SIZES = [100, 250, 500, 1000, 1500, 2000, 2714];

// Gather all .md files in Goldmine (sorted for determinism).
const allFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.endsWith(".md")) allFiles.push(path.relative(GOLDMINE, full));
  }
})(GOLDMINE);
allFiles.sort();

function timeMs(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function runCli(vaultDir, query) {
  execFileSync("node", [NAPKIN, "search", query, "--limit", "20", "--json", "--vault", vaultDir], { stdio: "pipe" });
}

const rows = ["files,sizeMB,coldMs,warmMs,touchMs"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-scale-"));

for (const n of SIZES) {
  // Build a synthetic vault with N symlinks into Goldmine, preserving layout.
  const vaultDir = path.join(tmp, `v${n}`);
  fs.mkdirSync(path.join(vaultDir, ".napkin"), { recursive: true });
  let bytes = 0;
  const picked = allFiles.slice(0, Math.min(n, allFiles.length));
  for (const rel of picked) {
    const src = path.join(GOLDMINE, rel);
    const dst = path.join(vaultDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst);
    bytes += fs.statSync(src).size;
  }
  // Minimal napkin config so vault detection + search work.
  fs.writeFileSync(path.join(vaultDir, ".napkin", "config.json"), JSON.stringify({
    overview: { depth: 3, keywords: 8 },
    search: { limit: 30, snippetLines: 0 },
    vault: { root: "." },
  }));

  const sizeMB = (bytes / 1e6).toFixed(1);
  // Cold: clear cache.
  fs.rmSync(path.join(vaultDir, ".napkin", "search-cache.json"), { force: true });
  const coldMs = timeMs(() => runCli(vaultDir, "distill"));
  // Warm: cache present, fresh process.
  const warmMs = timeMs(() => runCli(vaultDir, "distill"));
  // Touch-one: modify one file's mtime, fresh process.
  const touchTarget = path.join(vaultDir, picked[Math.min(5, picked.length - 1)]);
  fs.utimesSync(touchTarget, new Date(), new Date());
  const touchMs = timeMs(() => runCli(vaultDir, "distill"));

  console.log(`${n} files (${sizeMB}MB): cold=${coldMs.toFixed(0)}ms warm=${warmMs.toFixed(0)}ms touch=${touchMs.toFixed(0)}ms`);
  rows.push(`${n},${sizeMB},${coldMs.toFixed(0)},${warmMs.toFixed(0)},${touchMs.toFixed(0)}`);
}

fs.writeFileSync(OUT, rows.join("\n"));
console.log(`\nWrote ${OUT}`);
fs.rmSync(tmp, { recursive: true, force: true });
