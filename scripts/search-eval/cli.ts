#!/usr/bin/env node
/**
 * Search accuracy and ranking eval harness (#90).
 *
 * The gate for every change that touches search matching or ranking:
 * behaviour-preserving changes must record a baseline and compare it in
 * `identity` mode (exit non-zero on any difference); matching/ranking
 * changes compare in `ranking` mode and report recall / overlap / RBO.
 *
 * Search goes through `Napkin.search` (the public SDK), so the harness
 * measures exactly what SDK and CLI users get: the full ranked list with
 * scores. Snippets are disabled — snippet text is derived from the ranking
 * and would only make baselines large.
 *
 * Usage:
 *   # record a baseline
 *   node --import tsx scripts/search-eval/cli.ts \
 *     --vault ~/vault --queries /path/to/queries.txt \
 *     --record /path/to/baseline.json
 *
 *   # behaviour-preserving gate (exit 1 on any difference)
 *   node --import tsx scripts/search-eval/cli.ts \
 *     --vault ~/vault --compare /path/to/baseline.json
 *
 *   # intended ranking change: metrics + worst queries
 *   node --import tsx scripts/search-eval/cli.ts \
 *     --vault ~/vault --compare /path/to/baseline.json \
 *     --mode ranking --report /path/to/report.md
 *
 * The vault must not change between record and compare. Both runs carry a
 * fingerprint of the indexed files (path + size + mtime); a mismatch is
 * reported as a warning (or an error with --strict-vault).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Napkin } from "../../src/index.js";
import {
  BASELINE_SCHEMA,
  type Baseline,
  compareIdentity,
  compareRanking,
  dropSearchCache,
  formatIdentityReport,
  formatRankingMarkdown,
  peakRssMb,
  readQueries,
  recordRun,
  sampleQueries,
  summariseRanking,
  type VaultFingerprint,
  vaultFingerprint,
  worstQueries,
} from "./harness.js";

const EXIT_DIFFERENT = 1;
const EXIT_USAGE = 2;

/** Minimum result list length: enough to compare a real ranking. */
const MIN_LIMIT = 30;

const DEFAULT_SEED = 90;

interface Options {
  vault: string;
  queries: string | null;
  limit: number | null;
  folder: string | null;
  record: string | null;
  compare: string | null;
  mode: "identity" | "ranking";
  report: string | null;
  sample: number | null;
  seed: number;
  epsilon: number;
  maxDiffs: number;
  topK: number;
  rboP: number;
  reuseCache: boolean;
  strictVault: boolean;
}

function usageText(): string {
  return `usage: node --import tsx scripts/search-eval/cli.ts --vault <path> (--record <out.json> --queries <file> | --compare <baseline.json>) [options]

  --vault <path>        vault (dir containing .napkin/, or a path inside one)
  --queries <file>      one query per line; blank lines and # comments ignored
  --record <out.json>   run every query, write the ranked lists + latency
  --compare <file>      re-run and compare against a recorded baseline
  --mode <m>            identity (default; exit 1 on any difference) | ranking
  --limit <n>           results per query (default: config search.limit, min ${MIN_LIMIT})
  --folder <path>       restrict search to a vault folder
  --report <out.md>     write the ranking report as markdown
  --sample <n>          record only a seeded sample of n queries
  --seed <n>            sample seed (default ${DEFAULT_SEED})
  --epsilon <n>         identity score tolerance (default 1e-9)
  --max-diffs <n>       differing queries to print in identity mode (default 20)
  --k <n>               top-k for recall@k / jaccard (default 10)
  --rbo-p <n>           RBO persistence (default 0.9)
  --reuse-cache         keep the on-disk search index (default: dropped, so
                        both runs cold-build the same index)
  --strict-vault        fail when the vault fingerprint differs from the baseline
  --help`;
}

function help(): never {
  console.log(usageText());
  process.exit(0);
}

function usage(problem?: string): never {
  if (problem) console.error(`error: ${problem}`);
  console.error(usageText());
  process.exit(EXIT_USAGE);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    vault: "",
    queries: null,
    limit: null,
    folder: null,
    record: null,
    compare: null,
    mode: "identity",
    report: null,
    sample: null,
    seed: DEFAULT_SEED,
    epsilon: 1e-9,
    maxDiffs: 20,
    topK: 10,
    rboP: 0.9,
    reuseCache: false,
    strictVault: false,
  };

  const value = (flag: string, i: number): string => {
    const raw = argv[i];
    if (raw === undefined) usage(`${flag} needs a value`);
    return raw;
  };
  const num = (flag: string, raw: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) usage(`${flag} must be a number`);
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        help();
        break;
      case "--vault":
        opts.vault = value(arg, ++i);
        break;
      case "--queries":
        opts.queries = value(arg, ++i);
        break;
      case "--limit":
        opts.limit = num(arg, value(arg, ++i));
        break;
      case "--folder":
        opts.folder = value(arg, ++i);
        break;
      case "--record":
        opts.record = value(arg, ++i);
        break;
      case "--compare":
        opts.compare = value(arg, ++i);
        break;
      case "--mode": {
        const raw = value(arg, ++i);
        if (raw !== "identity" && raw !== "ranking") {
          usage("--mode must be identity or ranking");
        }
        opts.mode = raw;
        break;
      }
      case "--report":
        opts.report = value(arg, ++i);
        break;
      case "--sample":
        opts.sample = num(arg, value(arg, ++i));
        break;
      case "--seed":
        opts.seed = num(arg, value(arg, ++i));
        break;
      case "--epsilon":
        opts.epsilon = num(arg, value(arg, ++i));
        break;
      case "--max-diffs":
        opts.maxDiffs = num(arg, value(arg, ++i));
        break;
      case "--k":
        opts.topK = num(arg, value(arg, ++i));
        break;
      case "--rbo-p":
        opts.rboP = num(arg, value(arg, ++i));
        break;
      case "--reuse-cache":
        opts.reuseCache = true;
        break;
      case "--strict-vault":
        opts.strictVault = true;
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }

  if (!opts.vault) usage("--vault is required");
  if (opts.record && opts.compare) {
    usage("--record and --compare are mutually exclusive");
  }
  if (!opts.record && !opts.compare)
    usage("one of --record or --compare is required");
  if (opts.record && !opts.queries) usage("--record needs --queries");
  return opts;
}

// ── Reproducibility metadata ─────────────────────────────────────

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readGitState(): { gitSha: string | null; gitDirty: boolean | null } {
  try {
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf-8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: packageRoot,
      encoding: "utf-8",
    }).trim();
    return { gitSha, gitDirty: status.length > 0 };
  } catch {
    return { gitSha: null, gitDirty: null };
  }
}

// ── Main ─────────────────────────────────────────────────────────

function loadBaseline(file: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    usage(`cannot read baseline ${file}: ${(error as Error).message}`);
  }
  const baseline = parsed as Partial<Baseline>;
  if (baseline.schema !== BASELINE_SCHEMA || !Array.isArray(baseline.queries)) {
    usage(
      `${file} is not a v${BASELINE_SCHEMA} search-eval baseline (re-record it)`,
    );
  }
  return baseline as Baseline;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Warn (or, with --strict-vault, fail) when the vault moved or changed. */
function checkVaultUnchanged(
  recorded: VaultFingerprint,
  current: VaultFingerprint,
  strict: boolean,
): void {
  const warnings: string[] = [];
  if (recorded.digest !== current.digest) {
    warnings.push(
      `vault changed since the baseline: ${recorded.fileCount} -> ${current.fileCount} files (${recorded.digest.slice(0, 19)}… -> ${current.digest.slice(0, 19)}…)`,
    );
  }
  if (
    path.resolve(recorded.contentPath) !== path.resolve(current.contentPath)
  ) {
    warnings.push(
      `vault path differs: ${recorded.contentPath} -> ${current.contentPath}`,
    );
  }
  for (const warning of warnings) console.error(`warning: ${warning}`);
  if (warnings.length > 0 && strict) {
    console.error("error: --strict-vault and the vault fingerprint differs");
    process.exit(EXIT_USAGE);
  }
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const napkin = new Napkin(opts.vault);

  const config = napkin.config() as { search?: { limit?: number } };
  let limit =
    opts.limit ?? Math.max(config.search?.limit ?? MIN_LIMIT, MIN_LIMIT);
  let folder = opts.folder;

  const search = (query: string) =>
    napkin
      .search(query, { limit, path: folder ?? undefined, snippets: false })
      .map((hit) => ({ file: hit.file, score: hit.score }));

  // Both modes must start from the same index state: a cold build here, a
  // loaded cache there, can order score ties differently (see harness.ts).
  if (!opts.reuseCache) {
    const dropped = dropSearchCache(napkin);
    console.error(
      dropped
        ? "search cache: dropped (cold index build)"
        : "search cache: absent (cold index build)",
    );
  }

  if (opts.record) {
    const allQueries = readQueries(opts.queries as string);
    if (allQueries.length === 0) usage("query file is empty");
    const queries =
      opts.sample === null
        ? allQueries
        : sampleQueries(allQueries, opts.sample, opts.seed);

    console.error(
      `recording ${queries.length}/${allQueries.length} queries, limit ${limit}${folder ? `, folder ${folder}` : ""}`,
    );
    const { queries: records, latency } = recordRun(search, queries);
    const baseline: Baseline = {
      schema: BASELINE_SCHEMA,
      createdAt: new Date().toISOString(),
      napkin: { version: readPackageVersion(), ...readGitState() },
      vault: vaultFingerprint(napkin),
      options: { limit, folder, snippets: false },
      latency,
      peakRssMb: peakRssMb(),
      queries: records,
    };
    writeJson(opts.record, baseline);

    const hits = records.filter((r) => r.results.length > 0).length;
    console.log(
      `recorded ${records.length} queries (${hits} with hits) to ${opts.record}`,
    );
    console.log(
      `latency: cold ${latency.coldMs.toFixed(0)} ms, p50 ${latency.p50Ms.toFixed(0)} ms, p95 ${latency.p95Ms.toFixed(0)} ms, total ${(latency.totalMs / 1000).toFixed(1)} s; peak RSS ${baseline.peakRssMb.toFixed(1)} MB`,
    );
    console.log(
      `vault: ${baseline.vault.fileCount} note(s), ${baseline.vault.digest}`,
    );
    return 0;
  }

  const baseline = loadBaseline(opts.compare as string);
  if (opts.queries) {
    const provided = readQueries(opts.queries);
    const recorded = baseline.queries.map((r) => r.query);
    const same =
      provided.length === recorded.length &&
      provided.every((query, i) => query === recorded[i]);
    if (!same) {
      usage(
        "--queries differs from the baseline's query list; compare runs the recorded list",
      );
    }
  }
  // Options are part of the measurement: a different limit or folder is a
  // different experiment, not a comparison.
  if (opts.limit !== null && opts.limit !== baseline.options.limit) {
    usage(
      `--limit ${opts.limit} does not match the baseline's ${baseline.options.limit}`,
    );
  }
  if (opts.folder !== null && opts.folder !== baseline.options.folder) {
    usage(
      `--folder ${opts.folder} does not match the baseline's ${String(baseline.options.folder)}`,
    );
  }
  limit = baseline.options.limit;
  folder = baseline.options.folder;

  const currentVault = vaultFingerprint(napkin);
  checkVaultUnchanged(baseline.vault, currentVault, opts.strictVault);

  const queries = baseline.queries.map((r) => r.query);
  console.error(
    `comparing ${queries.length} queries, limit ${limit}${folder ? `, folder ${folder}` : ""}, mode ${opts.mode}`,
  );
  const { queries: records, latency } = recordRun(search, queries);

  if (opts.mode === "identity") {
    const diffs = compareIdentity(baseline.queries, records, opts.epsilon);
    console.log(
      formatIdentityReport(diffs, {
        queryCount: baseline.queries.length,
        epsilon: opts.epsilon,
        maxDiffs: opts.maxDiffs,
      }),
    );
    console.log(
      `latency: baseline p50 ${baseline.latency.p50Ms.toFixed(0)} ms / p95 ${baseline.latency.p95Ms.toFixed(0)} ms, candidate p50 ${latency.p50Ms.toFixed(0)} ms / p95 ${latency.p95Ms.toFixed(0)} ms; peak RSS ${baseline.peakRssMb.toFixed(1)} -> ${peakRssMb().toFixed(1)} MB`,
    );
    return diffs.length > 0 ? EXIT_DIFFERENT : 0;
  }

  const perQuery = compareRanking(baseline.queries, records, {
    k: opts.topK,
    rboP: opts.rboP,
  });
  const summary = summariseRanking(perQuery);
  const worst = worstQueries(perQuery);
  const report = formatRankingMarkdown(perQuery, summary, {
    baseline,
    candidate: { latency, peakRssMb: peakRssMb() },
    worst,
    k: opts.topK,
    rboP: opts.rboP,
  });
  if (opts.report) {
    fs.mkdirSync(path.dirname(path.resolve(opts.report)), { recursive: true });
    fs.writeFileSync(opts.report, report);
    console.log(
      `ranking report written to ${opts.report} (${perQuery.length} queries)`,
    );
  } else {
    console.log(report);
  }
  console.log(
    `recall ${summary.recall.mean.toFixed(4)} (median ${summary.recall.median.toFixed(4)}), recall@${opts.topK} ${summary.recallAt10.mean.toFixed(4)}, rbo ${summary.rbo.mean.toFixed(4)}`,
  );
  return 0;
}

process.exit(main());
