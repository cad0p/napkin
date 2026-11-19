/**
 * Record/compare orchestration for the search eval harness (#90).
 *
 * Kept free of CLI concerns (arg parsing, printing) so its behaviour is unit
 * testable: the CLI injects a search function — the real one is
 * `Napkin.search`, so the harness measures exactly what SDK/CLI users get.
 *
 * ## Determinism
 *
 * Record and compare must see the same vault state and the same index state,
 * otherwise a behaviour-preserving change could look like a regression:
 *
 *  - The ranked list is a function of vault content + file mtimes only.
 *    Recency is normalised over the result set
 *    (`(mtime - min) / (max - min)`), NOT against the wall clock; the only
 *    wall-clock value in a hit is the human-readable `modified` string,
 *    which this harness never records. Scores are therefore stable.
 *  - The index build order (file walk order) breaks score ties, so both runs
 *    must start from the same cache state: the CLI drops
 *    `.napkin/search-cache.json` before each run (pass `--reuse-cache` to
 *    keep the warm cache), which makes both runs cold-build identically.
 *  - The vault itself must not change: every baseline carries a fingerprint
 *    of the indexed files (path + size + mtime), and a mismatch is reported.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Napkin } from "../../src/index.js";
import { listFiles } from "../../src/utils/files.js";
import { loadIgnorer } from "../../src/utils/ignore.js";
import {
  type IdentityDiff,
  identityDiffs,
  jaccardAtK,
  kendallTau,
  mean,
  median,
  percentile,
  type RankedResult,
  rbo,
  recall,
  recallAtK,
} from "./metrics.js";

/** The injection point: one query in, the full ranked list out. */
export type SearchFn = (query: string) => RankedResult[];

export interface QueryRecord {
  query: string;
  latencyMs: number;
  results: RankedResult[];
}

export interface LatencySummary {
  /** First query — includes the cold index build. */
  coldMs: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
}

export interface VaultFingerprint {
  contentPath: string;
  configPath: string;
  fileCount: number;
  /** sha256 over `file\0size\0mtimeMs` of every indexed file, sorted. */
  digest: string;
}

export interface RunMetadata {
  version: string;
  gitSha: string | null;
  gitDirty: boolean | null;
}

export interface Baseline {
  schema: 1;
  createdAt: string;
  napkin: RunMetadata;
  vault: VaultFingerprint;
  options: { limit: number; folder: string | null; snippets: false };
  latency: LatencySummary;
  peakRssMb: number;
  queries: QueryRecord[];
}

export const BASELINE_SCHEMA = 1;

// ── Query set ────────────────────────────────────────────────────

/** One query per line; blank lines and `#` comments are ignored. */
export function readQueries(file: string): string[] {
  const raw = fs.readFileSync(file, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Deterministic PRNG (mulberry32) so `--sample` is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample `n` queries without replacement, preserving the file's order.
 * Same (queries, n, seed) always yields the same subset.
 */
export function sampleQueries(
  queries: string[],
  n: number,
  seed: number,
): string[] {
  if (n >= queries.length) return [...queries];
  const rand = mulberry32(seed);
  const indices = queries.map((_, i) => i);
  // Partial Fisher-Yates over the index list, then restore file order.
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices
    .slice(0, n)
    .sort((a, b) => a - b)
    .map((i) => queries[i]);
}

// ── Vault fingerprint ────────────────────────────────────────────

/**
 * Fingerprint the files search would index (same enumeration + ignore state
 * as `buildDocsAndBacklinks`). Any content edit, add, delete or rename
 * changes the digest; a re-record is required when it differs.
 */
export function vaultFingerprint(napkin: Napkin): VaultFingerprint {
  const { contentPath, configPath } = napkin.vault;
  const { ignorer } = loadIgnorer(contentPath, configPath);
  const files = listFiles(contentPath, { ext: "md", ignore: ignorer }).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const stat = fs.statSync(path.join(contentPath, file));
    hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return {
    contentPath,
    configPath,
    fileCount: files.length,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

/** Drop the on-disk search index so a run cold-builds from the vault. */
export function dropSearchCache(napkin: Napkin): boolean {
  let dropped = false;
  const cacheFile = path.join(napkin.vault.configPath, "search-cache.json");
  if (fs.existsSync(cacheFile)) {
    fs.rmSync(cacheFile, { force: true });
    dropped = true;
  }
  // The SQLite store (#106): the DB plus its WAL/SHM sidecars.
  const dbFile = path.join(napkin.vault.configPath, "cache", "index-v2.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbFile}${suffix}`;
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      dropped = true;
    }
  }
  return dropped;
}

// ── Recording ────────────────────────────────────────────────────

export function peakRssMb(): number {
  return Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
}

export function summariseLatency(records: QueryRecord[]): LatencySummary {
  const values = records.map((r) => r.latencyMs);
  return {
    coldMs: values.at(0) ?? 0,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    totalMs: values.reduce((sum, v) => sum + v, 0),
  };
}

/**
 * Run every query through `search` and keep the ranked list + latency.
 * Queries run sequentially: latency must not be polluted by concurrency
 * (disk-scan search is IO bound and would otherwise look faster).
 */
export function recordRun(
  search: SearchFn,
  queries: string[],
): { queries: QueryRecord[]; latency: LatencySummary } {
  const records: QueryRecord[] = [];
  for (const query of queries) {
    const started = performance.now();
    const results = search(query);
    const latencyMs = performance.now() - started;
    records.push({
      query,
      latencyMs: Math.round(latencyMs * 100) / 100,
      results,
    });
  }
  return { queries: records, latency: summariseLatency(records) };
}

// ── Identity comparison ──────────────────────────────────────────

export interface QueryIdentityDiff {
  query: string;
  diffs: IdentityDiff[];
}

/**
 * Behaviour-preserving gate: same files in the same order, scores within
 * `epsilon`. Returns one entry per differing query (empty = identical).
 */
export function compareIdentity(
  baseline: QueryRecord[],
  candidate: QueryRecord[],
  epsilon: number,
): QueryIdentityDiff[] {
  const byQuery = new Map(candidate.map((r) => [r.query, r]));
  const out: QueryIdentityDiff[] = [];
  for (const record of baseline) {
    const other = byQuery.get(record.query);
    if (!other) {
      out.push({
        query: record.query,
        diffs: [
          {
            index: 0,
            kind: "length",
            baseline: String(record.results.length),
            candidate: "missing",
          },
        ],
      });
      continue;
    }
    const diffs = identityDiffs(record.results, other.results, epsilon);
    if (diffs.length > 0) out.push({ query: record.query, diffs });
  }
  return out;
}

// ── Ranking comparison ───────────────────────────────────────────

export interface QueryRanking {
  query: string;
  recall: number;
  recallAt10: number;
  jaccardAt10: number;
  rbo: number;
  kendallTau: number | null;
  baselineCount: number;
  candidateCount: number;
  /** Baseline top-10 files absent from the candidate top-10. */
  missingAt10: string[];
}

export interface MetricAggregate {
  mean: number;
  median: number;
  p10: number;
}

export interface RankingSummary {
  recall: MetricAggregate;
  recallAt10: MetricAggregate;
  jaccardAt10: MetricAggregate;
  rbo: MetricAggregate;
  /** null when no query shared two files (tau is undefined). */
  kendallTau: MetricAggregate | null;
}

export function compareRanking(
  baseline: QueryRecord[],
  candidate: QueryRecord[],
  opts?: { k?: number; rboP?: number },
): QueryRanking[] {
  const k = opts?.k ?? 10;
  const p = opts?.rboP ?? 0.9;
  const byQuery = new Map(candidate.map((r) => [r.query, r]));
  return baseline.map((record) => {
    const other = byQuery.get(record.query);
    const baseFiles = record.results.map((r) => r.file);
    const candFiles = (other?.results ?? []).map((r) => r.file);
    const candidateTop = new Set(candFiles.slice(0, k));
    return {
      query: record.query,
      recall: recall(baseFiles, candFiles),
      recallAt10: recallAtK(baseFiles, candFiles, k),
      jaccardAt10: jaccardAtK(baseFiles, candFiles, k),
      rbo: rbo(baseFiles, candFiles, p),
      kendallTau: kendallTau(baseFiles, candFiles),
      baselineCount: baseFiles.length,
      candidateCount: candFiles.length,
      missingAt10: baseFiles
        .slice(0, k)
        .filter((file) => !candidateTop.has(file)),
    };
  });
}

function aggregate(values: number[]): MetricAggregate {
  return {
    mean: mean(values),
    median: median(values),
    p10: percentile(values, 10),
  };
}

export function summariseRanking(perQuery: QueryRanking[]): RankingSummary {
  const taus = perQuery
    .map((q) => q.kendallTau)
    .filter((t): t is number => t !== null);
  return {
    recall: aggregate(perQuery.map((q) => q.recall)),
    recallAt10: aggregate(perQuery.map((q) => q.recallAt10)),
    jaccardAt10: aggregate(perQuery.map((q) => q.jaccardAt10)),
    rbo: aggregate(perQuery.map((q) => q.rbo)),
    kendallTau: taus.length > 0 ? aggregate(taus) : null,
  };
}

/** Worst queries by recall@10 (then recall, then query) for manual review. */
export function worstQueries(perQuery: QueryRanking[], n = 20): QueryRanking[] {
  return [...perQuery]
    .sort(
      (a, b) =>
        a.recallAt10 - b.recallAt10 ||
        a.recall - b.recall ||
        a.query.localeCompare(b.query),
    )
    .slice(0, n);
}

// ── Reporting ────────────────────────────────────────────────────

function fixed(value: number, digits = 4): string {
  return value.toFixed(digits);
}

export function formatIdentityReport(
  diffs: QueryIdentityDiff[],
  ctx: { queryCount: number; epsilon: number; maxDiffs: number },
): string {
  const lines: string[] = [];
  const differing = diffs.length;
  lines.push(
    `identity: ${ctx.queryCount - differing}/${ctx.queryCount} queries identical (epsilon ${ctx.epsilon})`,
  );
  if (differing === 0) {
    lines.push("no differences");
    return lines.join("\n");
  }
  lines.push(`${differing} differing queries`);
  let printed = 0;
  for (const entry of diffs) {
    if (printed >= ctx.maxDiffs) {
      lines.push(
        `... ${diffs.length - printed} more differing queries (raise --max-diffs to see them)`,
      );
      break;
    }
    printed++;
    lines.push(`\n  query: ${entry.query}`);
    for (const diff of entry.diffs.slice(0, 5)) {
      lines.push(
        `    [${diff.index}] ${diff.kind}: ${diff.baseline} -> ${diff.candidate}`,
      );
    }
    if (entry.diffs.length > 5) {
      lines.push(`    ... ${entry.diffs.length - 5} more diffs in this query`);
    }
  }
  return lines.join("\n");
}

export function formatRankingMarkdown(
  perQuery: QueryRanking[],
  summary: RankingSummary,
  ctx: {
    baseline: Baseline;
    candidate: { latency: LatencySummary; peakRssMb: number };
    worst: QueryRanking[];
    k: number;
    rboP: number;
  },
): string {
  const lines: string[] = [];
  lines.push("# napkin search eval — ranking comparison");
  lines.push("");
  lines.push(`- queries: ${perQuery.length}`);
  lines.push(
    `- baseline: ${ctx.baseline.napkin.version} (${ctx.baseline.napkin.gitSha ?? "unknown sha"}), recorded ${ctx.baseline.createdAt}`,
  );
  lines.push(
    `- vault: ${ctx.baseline.vault.fileCount} note(s), ${ctx.baseline.vault.digest.slice(0, 23)}…`,
  );
  lines.push(
    `- limit: ${ctx.baseline.options.limit}, folder: ${ctx.baseline.options.folder ?? "(none)"}`,
  );
  lines.push(`- top-k for recall/Jaccard: ${ctx.k}, RBO p: ${ctx.rboP}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| metric | mean | median | p10 |");
  lines.push("| --- | ---: | ---: | ---: |");
  const rows: Array<[string, MetricAggregate]> = [
    ["recall", summary.recall],
    [`recall@${ctx.k}`, summary.recallAt10],
    [`jaccard@${ctx.k}`, summary.jaccardAt10],
    ["rbo", summary.rbo],
  ];
  if (summary.kendallTau) rows.push(["kendall tau", summary.kendallTau]);
  for (const [name, agg] of rows) {
    lines.push(
      `| ${name} | ${fixed(agg.mean)} | ${fixed(agg.median)} | ${fixed(agg.p10)} |`,
    );
  }
  lines.push("");
  lines.push("## Latency and memory");
  lines.push("");
  lines.push("| run | cold ms | p50 ms | p95 ms | total s | peak RSS MB |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  lines.push(
    `| baseline | ${fixed(ctx.baseline.latency.coldMs, 0)} | ${fixed(ctx.baseline.latency.p50Ms, 0)} | ${fixed(ctx.baseline.latency.p95Ms, 0)} | ${fixed(ctx.baseline.latency.totalMs / 1000, 1)} | ${fixed(ctx.baseline.peakRssMb, 1)} |`,
  );
  lines.push(
    `| candidate | ${fixed(ctx.candidate.latency.coldMs, 0)} | ${fixed(ctx.candidate.latency.p50Ms, 0)} | ${fixed(ctx.candidate.latency.p95Ms, 0)} | ${fixed(ctx.candidate.latency.totalMs / 1000, 1)} | ${fixed(ctx.candidate.peakRssMb, 1)} |`,
  );
  lines.push("");
  lines.push(`## Worst ${ctx.worst.length} queries by recall@${ctx.k}`);
  lines.push("");
  lines.push(
    `| recall@${ctx.k} | recall | rbo | query | missing from candidate top-${ctx.k} |`,
  );
  lines.push("| ---: | ---: | ---: | --- | --- |");
  for (const q of ctx.worst) {
    const missing =
      q.missingAt10.length === 0
        ? "—"
        : q.missingAt10.map((f) => `\`${f}\``).join(", ");
    lines.push(
      `| ${fixed(q.recallAt10, 2)} | ${fixed(q.recall, 2)} | ${fixed(q.rbo, 2)} | ${q.query.replaceAll("|", "\\|")} | ${missing} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
