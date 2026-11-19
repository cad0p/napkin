/**
 * LLM-judge mode for the search eval harness (#108).
 *
 * identity and ranking answer "did results change" and "by how much"; this
 * module answers "is the change better or worse". For every query whose
 * baseline and candidate top-k lists differ, an LLM judge sees the query and
 * both lists — unlabelled A and B — where every hit carries the
 * vault-relative path, the note title and an excerpt read from the vault at
 * judge time, so the judge compares documents rather than snippet formats.
 * Each query is judged twice with A and B swapped to cancel position bias;
 * disagreeing verdicts count as a tie.
 *
 * The judge is spawned as a lean pi process (no extensions, skills, prompt
 * templates, context files, tools, themes or session) with --mode json and
 * the prompt on stdin. Verdicts are cached on disk keyed by sha256 of the
 * model plus the prompt, so a re-run only pays for new pairs.
 *
 * This mode is dev-only: it sends query text, note titles, paths and short
 * excerpts to the chosen model — run it locally on private vaults, never in
 * CI. Tests inject a fake judge command via --judge-cmd, so no test or CI run
 * touches the network or a real model.
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { QueryRecord } from "./harness.js";

// ── Types ────────────────────────────────────────────────────────

export type JudgeSide = "A" | "B" | "tie";

/** One orientation's parsed verdict, exactly as the judge answered it. */
export interface JudgeVerdict {
  winner: JudgeSide;
  reason: string;
}

/** Outcome for the candidate: win | tie | loss; error = judge unusable. */
export type QueryOutcome = "win" | "tie" | "loss" | "error";

export type PreferredSide = "baseline" | "candidate" | "tie";

export interface JudgedHit {
  file: string;
  title: string;
  excerpt: string;
}

export interface JudgedQuery {
  query: string;
  outcome: QueryOutcome;
  /** Mapped side each orientation preferred; null = that call failed. */
  sides: [PreferredSide | null, PreferredSide | null];
  /** Judge reasons for the two orientations ("" when missing). */
  reasons: [string, string];
  baselineTop: string[];
  candidateTop: string[];
  /** Baseline top-k files absent from the candidate top-k. */
  missingFromCandidate: string[];
}

export interface JudgeUsage {
  calls: number;
  cacheHits: number;
  errors: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** false when the judge output carried no usage events. */
  reported: boolean;
}

export interface JudgeRunResult {
  judged: JudgedQuery[];
  /** Queries whose top-k lists were identical — ties without a model call. */
  identicalCount: number;
  usage: JudgeUsage;
}

// ── Note presentation ────────────────────────────────────────────

const MAX_EXCERPT_CHARS = 600;
const FALLBACK_EXCERPT_CHARS = 300;
/** Hard cap on the rendered prompt. */
export const MAX_PROMPT_CHARS = 64_000;

/** Strip a leading YAML frontmatter block. */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

/** Note title: the first H1, else the file basename without extension. */
export function noteTitle(content: string, file: string): string {
  const h1 = stripFrontmatter(content).match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const base = path.basename(file);
  return base.replace(/\.[^.]*$/, "");
}

/** Meaningful query terms: alphanumeric tokens of length >= 2, deduped. */
export function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);
  return [...new Set(terms)];
}

/**
 * Excerpt for the judge: up to three lines around the first line matching
 * any query term (case-insensitive), else the first ~300 chars of the body
 * after frontmatter. Built identically for both lists so the judge compares
 * documents, not snippet formats.
 */
export function noteExcerpt(content: string, query: string): string {
  const body = stripFrontmatter(content);
  const lines = body.split(/\r?\n/);
  const terms = queryTerms(query);
  let match = -1;
  if (terms.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (terms.some((term) => line.includes(term))) {
        match = i;
        break;
      }
    }
  }
  if (match >= 0) {
    const from = Math.max(0, match - 1);
    const excerpt = lines
      .slice(from, match + 2)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" / ");
    return excerpt.slice(0, MAX_EXCERPT_CHARS).trim();
  }
  return body.replace(/\s+/g, " ").trim().slice(0, FALLBACK_EXCERPT_CHARS);
}

// ── Prompt ───────────────────────────────────────────────────────

function formatList(label: string, hits: JudgedHit[]): string {
  if (hits.length === 0) return `List ${label}: (no results)`;
  const lines = [`List ${label}:`];
  hits.forEach((hit, i) => {
    lines.push(`${i + 1}. ${hit.file}`);
    lines.push(`   Title: ${hit.title}`);
    lines.push(`   Excerpt: ${hit.excerpt}`);
  });
  return lines.join("\n");
}

/** The judge prompt: query + two unlabelled lists, JSON-only answer. */
export function buildJudgePrompt(
  query: string,
  listA: JudgedHit[],
  listB: JudgedHit[],
): string {
  const prompt =
    "You are comparing two ranked lists of search results from a personal markdown note vault.\n\n" +
    "Someone searched their notes with the query below. Decide which list better serves that search: " +
    "weight the relevance of the top-ranked results most heavily, then coverage — whether the list " +
    "surfaces the notes the query is looking for. Answer 'tie' when the lists serve the query " +
    "equally well or equally badly.\n\n" +
    "Query: " +
    query +
    "\n\n" +
    formatList("A", listA) +
    "\n\n" +
    formatList("B", listB) +
    "\n\n" +
    "Answer with ONLY a JSON object on one line, no other text:\n" +
    '{"winner":"A"|"B"|"tie","reason":"<one line>"}';
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  // Over the cap: keep the instruction tail, truncate inside the lists.
  const tail = prompt.slice(-200);
  return `${prompt.slice(0, MAX_PROMPT_CHARS - 220)}\n…[truncated]…\n${tail}`;
}

// ── Verdict parsing ──────────────────────────────────────────────

/**
 * Parse the judge's answer. Tolerates fences, prose around the JSON and
 * case variations; returns null on anything unparseable (the caller retries
 * once, then records an error).
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict | null {
  const candidates: string[] = [raw.trim()];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const brace = raw.match(/\{[^{}]*"winner"[^{}]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        winner?: unknown;
        reason?: unknown;
      };
      const winner = String(parsed.winner ?? "")
        .trim()
        .toLowerCase();
      if (winner === "a" || winner === "b" || winner === "tie") {
        return {
          winner:
            winner === "tie" ? "tie" : (winner.toUpperCase() as "A" | "B"),
          reason:
            typeof parsed.reason === "string"
              ? parsed.reason.split("\n")[0].trim().slice(0, 300)
              : "",
        };
      }
    } catch {
      // try the next candidate shape
    }
  }
  return null;
}

// ── Swap mapping ─────────────────────────────────────────────────

/** Map an A/B verdict back to which recorded side it preferred. */
export function mapVerdict(
  verdict: JudgeVerdict,
  aIsBaseline: boolean,
): PreferredSide {
  if (verdict.winner === "tie") return "tie";
  const aWins = verdict.winner === "A";
  return aWins === aIsBaseline ? "baseline" : "candidate";
}

/**
 * Combine the two orientations: they must agree on the same side, otherwise
 * position bias makes the verdict untrustworthy and the query counts as tie.
 */
export function combineSides(
  first: PreferredSide,
  second: PreferredSide,
): "win" | "tie" | "loss" {
  if (first !== second) return "tie";
  if (first === "candidate") return "win";
  if (first === "baseline") return "loss";
  return "tie";
}

// ── Judge invocation ─────────────────────────────────────────────

export interface JudgeCommandResult {
  /** The judge's answer text (pi's assistant text, or raw stdout). */
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Whether the output carried token usage (pi --mode json does). */
  usageReported: boolean;
  error: string | null;
}

/** Lean pi flags for the judge: nothing loaded but the model itself. */
export function judgeArgs(model: string): string[] {
  return [
    "--print",
    "--mode",
    "json",
    "--model",
    model,
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-tools",
    "--no-themes",
  ];
}

interface PiEvent {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input?: number; output?: number; totalTokens?: number };
    errorMessage?: string;
  };
}

/**
 * Extract the last assistant message's text and token usage from pi
 * --mode json event output. Returns null when stdout is not pi JSONL —
 * e.g. a --judge-cmd fake that echoes the verdict directly.
 */
export function parsePiJsonOutput(stdout: string): {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error: string | null;
} | null {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let error: string | null = null;
  let sawAssistant = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: PiEvent;
    try {
      event = JSON.parse(trimmed) as PiEvent;
    } catch {
      continue;
    }
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (message?.role !== "assistant") continue;
    sawAssistant = true;
    text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    inputTokens += message.usage?.input ?? 0;
    outputTokens += message.usage?.output ?? 0;
    totalTokens += message.usage?.totalTokens ?? 0;
    error = message.errorMessage ?? null;
  }
  if (!sawAssistant) return null;
  return { text, inputTokens, outputTokens, totalTokens, error };
}

/**
 * Spawn the judge command once: lean pi (or a fake in tests) with the prompt
 * on stdin. Resolves on exit; a non-zero exit, a timeout or a pi-level error
 * is reported via error, never thrown.
 */
export function callJudge(
  judgeCmd: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<JudgeCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(judgeCmd, judgeArgs(model), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parsePiJsonOutput(stdout);
      resolve({
        text: parsed ? parsed.text : stdout,
        inputTokens: parsed?.inputTokens ?? 0,
        outputTokens: parsed?.outputTokens ?? 0,
        totalTokens: parsed?.totalTokens ?? 0,
        usageReported: parsed !== null,
        error: error ?? parsed?.error ?? null,
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`judge timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => finish(`cannot spawn judge: ${err.message}`));
    child.on("close", (code) => {
      if (code !== 0) {
        const last = stderr.trim().split("\n").pop() ?? "";
        finish(`judge exited ${code}${last ? `: ${last}` : ""}`);
        return;
      }
      finish(null);
    });
    child.stdin.on("error", () => {
      // EPIPE when the judge exits without reading stdin; close reports it.
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ── Verdict cache ────────────────────────────────────────────────

export function defaultJudgeCacheDir(): string {
  return path.join(os.tmpdir(), "napkin-search-eval-judge");
}

function cachePath(cacheDir: string, model: string, prompt: string): string {
  const key = crypto
    .createHash("sha256")
    .update(model)
    .update("\0")
    .update(prompt)
    .digest("hex");
  return path.join(cacheDir, `${key}.json`);
}

/** One judged call: cache lookup, spawn, retry once on unusable output. */
async function judgedCall(
  judge: { cmd: string; model: string; timeoutMs: number },
  cacheDir: string | null,
  prompt: string,
  usage: JudgeUsage,
): Promise<JudgeVerdict | null> {
  const file = cacheDir ? cachePath(cacheDir, judge.model, prompt) : null;
  if (file && fs.existsSync(file)) {
    usage.cacheHits++;
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf-8"));
      const verdict = parseJudgeVerdict(JSON.stringify(cached));
      if (verdict) return verdict;
    } catch {
      // corrupt cache entry: fall through to a fresh call
    }
  }

  // One retry: a judge answer that will not parse is asked for once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callJudge(
      judge.cmd,
      judge.model,
      prompt,
      judge.timeoutMs,
    );
    usage.calls++;
    usage.inputTokens += result.inputTokens;
    usage.outputTokens += result.outputTokens;
    usage.totalTokens += result.totalTokens;
    if (result.usageReported) usage.reported = true;
    if (result.error) continue;
    const verdict = parseJudgeVerdict(result.text);
    if (verdict) {
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify(verdict)}\n`);
        } catch {
          // a cache we cannot write is a slowdown, not a failure
        }
      }
      return verdict;
    }
  }
  return null;
}

// ── Orchestration ────────────────────────────────────────────────

export interface JudgeOptions {
  judgeCmd: string;
  model: string;
  concurrency: number;
  timeoutMs: number;
  cacheDir: string | null;
  k: number;
  /** Vault content root the hit paths are relative to. */
  vaultRoot: string;
  onProgress?: (done: number, total: number) => void;
}

function judgableHits(
  files: string[],
  query: string,
  vaultRoot: string,
  noteCache: Map<string, string>,
): JudgedHit[] {
  return files.map((file) => {
    let content = noteCache.get(file);
    if (content === undefined) {
      try {
        content = fs.readFileSync(path.join(vaultRoot, file), "utf-8");
      } catch {
        content = "";
      }
      noteCache.set(file, content);
    }
    return {
      file,
      title: noteTitle(content, file),
      excerpt: content ? noteExcerpt(content, query) : "",
    };
  });
}

/** Do the ordered top-k file lists differ? Then the query needs a judge. */
export function topKDiffers(
  baseline: QueryRecord,
  candidate: QueryRecord | undefined,
  k: number,
): boolean {
  const a = baseline.results.slice(0, k).map((r) => r.file);
  const b = (candidate?.results ?? []).slice(0, k).map((r) => r.file);
  return a.length !== b.length || a.some((file, i) => file !== b[i]);
}

/**
 * Judge every query whose top-k differs, twice with A and B swapped, under a
 * bounded worker pool. Identical lists count as ties without a model call.
 */
export async function runJudge(
  baseline: QueryRecord[],
  candidate: QueryRecord[],
  opts: JudgeOptions,
): Promise<JudgeRunResult> {
  const byQuery = new Map(candidate.map((r) => [r.query, r]));
  const differing = baseline.filter((record) =>
    topKDiffers(record, byQuery.get(record.query), opts.k),
  );
  const usage: JudgeUsage = {
    calls: 0,
    cacheHits: 0,
    errors: 0,
    wallMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reported: false,
  };
  const judge = {
    cmd: opts.judgeCmd,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
  };
  const noteCache = new Map<string, string>();
  const started = performance.now();
  let done = 0;
  const judged = new Array<JudgedQuery>(differing.length);

  let next = 0;
  const worker = async () => {
    while (next < differing.length) {
      const index = next++;
      const record = differing[index];
      const other = byQuery.get(record.query);
      const baselineTop = record.results.slice(0, opts.k).map((r) => r.file);
      const candidateTop = (other?.results ?? [])
        .slice(0, opts.k)
        .map((r) => r.file);
      const listBaseline = judgableHits(
        baselineTop,
        record.query,
        opts.vaultRoot,
        noteCache,
      );
      const listCandidate = judgableHits(
        candidateTop,
        record.query,
        opts.vaultRoot,
        noteCache,
      );

      const prompts: [string, string] = [
        buildJudgePrompt(record.query, listBaseline, listCandidate),
        buildJudgePrompt(record.query, listCandidate, listBaseline),
      ];
      // Sequential per worker: at most "concurrency" calls in flight.
      const verdicts: [JudgeVerdict | null, JudgeVerdict | null] = [null, null];
      for (let i = 0; i < 2; i++) {
        verdicts[i] = await judgedCall(judge, opts.cacheDir, prompts[i], usage);
      }
      const sides: [PreferredSide | null, PreferredSide | null] = [
        verdicts[0] ? mapVerdict(verdicts[0], true) : null,
        verdicts[1] ? mapVerdict(verdicts[1], false) : null,
      ];
      let outcome: QueryOutcome;
      if (sides[0] === null || sides[1] === null) {
        outcome = "error";
        usage.errors++;
      } else {
        outcome = combineSides(sides[0], sides[1]);
      }
      judged[index] = {
        query: record.query,
        outcome,
        sides,
        reasons: [verdicts[0]?.reason ?? "", verdicts[1]?.reason ?? ""],
        baselineTop,
        candidateTop,
        missingFromCandidate: baselineTop.filter(
          (file) => !candidateTop.includes(file),
        ),
      };
      done++;
      opts.onProgress?.(done, differing.length);
    }
  };
  const poolSize = Math.max(1, Math.floor(opts.concurrency));
  await Promise.all(Array.from({ length: poolSize }, worker));
  usage.wallMs = Math.round(performance.now() - started);
  return {
    judged,
    identicalCount: baseline.length - differing.length,
    usage,
  };
}

// ── Statistics ───────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so the bootstrap CI is seeded. */
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

export function countOutcomes(judged: JudgedQuery[]): {
  wins: number;
  ties: number;
  losses: number;
  errors: number;
} {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let errors = 0;
  for (const query of judged) {
    if (query.outcome === "win") wins++;
    else if (query.outcome === "loss") losses++;
    else if (query.outcome === "tie") ties++;
    else errors++;
  }
  return { wins, ties, losses, errors };
}

/**
 * 95% bootstrap CI of the net win rate (W-L)/N over judged non-error
 * queries, 10k seeded resamples. N=0 returns [0, 0].
 */
export function bootstrapNetWinRate(
  outcomes: QueryOutcome[],
  seed: number,
  resamples = 10_000,
): [number, number] {
  const scored = outcomes
    .filter((o) => o !== "error")
    .map((o) => (o === "win" ? 1 : o === "loss" ? -1 : 0));
  const n = scored.length;
  if (n === 0) return [0, 0];
  const rand = mulberry32(seed);
  const nets: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += scored[Math.floor(rand() * n)];
    }
    nets[r] = sum / n;
  }
  nets.sort((a, b) => a - b);
  const lo = nets[Math.floor(0.025 * resamples)];
  const hi = nets[Math.min(resamples - 1, Math.floor(0.975 * resamples))];
  return [lo, hi];
}

/** Two-sided sign test on wins vs losses (ties excluded). */
export function signTestPValue(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  // 2 * P(X <= k) for X ~ Binomial(n, 0.5), computed stably via logs.
  let cumulative = 0;
  let logChoose = 0; // log C(n, 0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    cumulative += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, 2 * cumulative);
}

/** Normalize a query or basename for the exact-title check. */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\.md$/, "")
    .replace(/[\s_]+/g, "-");
}

export interface ExactTitleLoss {
  query: string;
  file: string;
}

/**
 * A query equal to a note's basename (normalized) that was in the baseline
 * top-k must stay in the candidate top-k: losing it is a regression no
 * judge verdict can excuse.
 */
export function exactTitleLosses(
  baseline: QueryRecord[],
  candidate: QueryRecord[],
  k: number,
): ExactTitleLoss[] {
  const byQuery = new Map(candidate.map((r) => [r.query, r]));
  const losses: ExactTitleLoss[] = [];
  for (const record of baseline) {
    const wanted = normalizeTitle(record.query);
    const top = record.results.slice(0, k).map((r) => r.file);
    const match = top.find(
      (file) => normalizeTitle(path.basename(file)) === wanted,
    );
    if (!match) continue;
    const candidateTop = new Set(
      (byQuery.get(record.query)?.results ?? []).slice(0, k).map((r) => r.file),
    );
    if (!candidateTop.has(match)) {
      losses.push({ query: record.query, file: match });
    }
  }
  return losses;
}

// ── Pass rule and report ─────────────────────────────────────────

export interface JudgeSummary {
  queries: number;
  identical: number;
  judged: number;
  wins: number;
  ties: number;
  losses: number;
  errors: number;
  netWinRate: number;
  ci95: [number, number];
  signTestP: number;
  exactTitleLosses: ExactTitleLoss[];
  pass: boolean;
  passReasons: string[];
}

export const PASS_CI_FLOOR = -0.05;

export function summariseJudge(
  queryCount: number,
  identical: number,
  judged: JudgedQuery[],
  exactLosses: ExactTitleLoss[],
  seed: number,
): JudgeSummary {
  const counts = countOutcomes(judged);
  const n = judged.length - counts.errors;
  const netWinRate = n === 0 ? 0 : (counts.wins - counts.losses) / n;
  const ci95 = bootstrapNetWinRate(
    judged.map((q) => q.outcome),
    seed,
  );
  const signTestP = signTestPValue(counts.wins, counts.losses);

  const passReasons: string[] = [];
  if (counts.wins < counts.losses) {
    passReasons.push(
      "candidate loses " +
        counts.losses +
        " vs " +
        counts.wins +
        " wins (need wins >= losses)",
    );
  }
  if (ci95[0] <= PASS_CI_FLOOR) {
    passReasons.push(
      "net win rate CI lower bound " +
        ci95[0].toFixed(4) +
        " <= " +
        PASS_CI_FLOOR,
    );
  }
  if (exactLosses.length > 0) {
    passReasons.push(
      exactLosses.length +
        " exact-title loss(es): " +
        exactLosses.map((l) => l.query).join(", "),
    );
  }
  return {
    queries: queryCount,
    identical,
    judged: n,
    wins: counts.wins,
    ties: counts.ties,
    losses: counts.losses,
    errors: counts.errors,
    netWinRate,
    ci95,
    signTestP,
    exactTitleLosses: exactLosses,
    pass: passReasons.length === 0,
    passReasons,
  };
}

function fixed(value: number, digits = 4): string {
  return value.toFixed(digits);
}

/**
 * The judge report: verdicts, statistics and the pass rule, then the worst
 * losses with both lists side by side and the judge's reasons.
 */
export function formatJudgeMarkdown(
  summary: JudgeSummary,
  judged: JudgedQuery[],
  ctx: {
    model: string;
    k: number;
    usage: JudgeUsage;
    rankingBlock?: string;
  },
): string {
  const lines: string[] = [];
  lines.push("# napkin search eval — LLM judge comparison");
  lines.push("");
  lines.push(`- judge model: ${ctx.model}`);
  lines.push(`- top-k judged: ${ctx.k}`);
  lines.push(
    "- queries: " +
      summary.queries +
      " (" +
      summary.identical +
      " identical top-" +
      ctx.k +
      ", ties without a model call)",
  );
  lines.push(
    "- judged: " +
      summary.judged +
      " differing queries, " +
      summary.errors +
      " error(s) excluded from stats",
  );
  lines.push("");
  lines.push("## Verdict (candidate vs baseline)");
  lines.push("");
  lines.push(
    "| wins | ties | losses | net win rate | 95% CI | sign-test p | verdict |",
  );
  lines.push("| ---: | ---: | ---: | ---: | --- | ---: | --- |");
  lines.push(
    "| " +
      summary.wins +
      " | " +
      summary.ties +
      " | " +
      summary.losses +
      " | " +
      fixed(summary.netWinRate) +
      " | [" +
      fixed(summary.ci95[0]) +
      ", " +
      fixed(summary.ci95[1]) +
      "] | " +
      fixed(summary.signTestP) +
      " | **" +
      (summary.pass ? "PASS" : "FAIL") +
      "** |",
  );
  if (!summary.pass) {
    lines.push("");
    lines.push("Fail reasons:");
    for (const reason of summary.passReasons) lines.push(`- ${reason}`);
  }
  if (summary.exactTitleLosses.length > 0) {
    lines.push("");
    lines.push("Exact-title losses (must never regress):");
    for (const loss of summary.exactTitleLosses) {
      lines.push(`- ${loss.query} lost ${loss.file}`);
    }
  }
  lines.push("");
  lines.push("## Judge cost");
  lines.push("");
  lines.push(
    "- calls: " +
      ctx.usage.calls +
      " (" +
      ctx.usage.cacheHits +
      " cache hits); " +
      ctx.usage.errors +
      " query error(s)",
  );
  lines.push(`- wall time: ${(ctx.usage.wallMs / 1000).toFixed(1)} s`);
  if (ctx.usage.reported) {
    lines.push(
      "- tokens: " +
        ctx.usage.totalTokens +
        " total (" +
        ctx.usage.inputTokens +
        " in / " +
        ctx.usage.outputTokens +
        " out)",
    );
  }
  lines.push("");

  const losses = judged
    .filter((q) => q.outcome === "loss")
    .sort(
      (a, b) =>
        b.missingFromCandidate.length - a.missingFromCandidate.length ||
        a.query.localeCompare(b.query),
    )
    .slice(0, 10);
  if (losses.length > 0) {
    lines.push(`## Worst ${losses.length} losses`);
    lines.push("");
    for (const loss of losses) {
      lines.push(`### ${loss.query}`);
      lines.push("");
      const rows = Math.max(loss.baselineTop.length, loss.candidateTop.length);
      lines.push("| # | baseline | candidate |");
      lines.push("| ---: | --- | --- |");
      for (let i = 0; i < rows; i++) {
        const b = loss.baselineTop[i] ? `"${loss.baselineTop[i]}"` : "—";
        const c = loss.candidateTop[i] ? `"${loss.candidateTop[i]}"` : "—";
        lines.push(`| ${i + 1} | ${b} | ${c} |`);
      }
      lines.push("");
      lines.push(
        "- judge (A=baseline): " +
          (loss.reasons[0] || "(no reason)") +
          " -> " +
          (loss.sides[0] ?? "error"),
      );
      lines.push(
        "- judge (A=candidate): " +
          (loss.reasons[1] || "(no reason)") +
          " -> " +
          (loss.sides[1] ?? "error"),
      );
      lines.push("");
    }
  }
  if (ctx.rankingBlock) {
    lines.push("## Ranking metrics");
    lines.push("");
    lines.push(ctx.rankingBlock);
    lines.push("");
  }
  return lines.join("\n");
}

/** The machine-readable side of the report (--judge-json). */
export function judgeJsonReport(
  summary: JudgeSummary,
  judged: JudgedQuery[],
  usage: JudgeUsage,
  ctx: { model: string; k: number },
): Record<string, unknown> {
  return {
    schema: 1,
    mode: "judge",
    judge: { model: ctx.model, k: ctx.k },
    summary: {
      queries: summary.queries,
      identical: summary.identical,
      judged: summary.judged,
      wins: summary.wins,
      ties: summary.ties,
      losses: summary.losses,
      errors: summary.errors,
      netWinRate: summary.netWinRate,
      ci95: summary.ci95,
      signTestP: summary.signTestP,
      pass: summary.pass,
      passReasons: summary.passReasons,
      exactTitleLosses: summary.exactTitleLosses,
    },
    usage,
    queries: judged.map((q) => ({
      query: q.query,
      outcome: q.outcome,
      sides: q.sides,
      reasons: q.reasons,
      baselineTop: q.baselineTop,
      candidateTop: q.candidateTop,
      missingFromCandidate: q.missingFromCandidate,
    })),
  };
}
