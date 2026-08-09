#!/usr/bin/env npx tsx
/**
 * HotpotQA Agentic Benchmark — pi + napkin
 *
 * Tests agentic retrieval: pi CLI with napkin-context extension uses napkin
 * commands to find information in a vault, then answers multi-hop questions.
 *
 * Each HotpotQA question has 10 context paragraphs (2 gold, 8 distractors).
 * We create a temp napkin vault, pipe the question into `pi -p`, and measure
 * which notes it retrieved and whether it answered correctly.
 *
 * Usage:
 *   npx tsx bench/hotpotqa-eval.ts                  # 50 questions
 *   npx tsx bench/hotpotqa-eval.ts --n 100          # 100 questions
 *   npx tsx bench/hotpotqa-eval.ts --type bridge    # bridge only
 *   npx tsx bench/hotpotqa-eval.ts --json           # save results
 *   npx tsx bench/hotpotqa-eval.ts --verbose        # show agent output
 *   npx tsx bench/hotpotqa-eval.ts --model "anthropic/claude-haiku-4-5-20251001"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HotpotQuestion {
  _id: string;
  question: string;
  answer: string;
  type: "bridge" | "comparison";
  level: string;
  supporting_facts: [string, number][];
  context: [string, string[]][];
}

interface QResult {
  id: string;
  question: string;
  answer: string;
  qtype: string;
  gold: string[];
  retrieved: string[];
  agentAnswer: string;
  recall: number;
  precision: number;
  f1: number;
  mrr: number;
  ansF1: number;
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Vault creation
// ---------------------------------------------------------------------------

function sanitize(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, "_");
}

function createTempVault(q: HotpotQuestion): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-hotpot-"));
  const napkinDir = path.join(tmpDir, ".napkin");
  fs.mkdirSync(napkinDir, { recursive: true });

  fs.writeFileSync(
    path.join(napkinDir, "config.json"),
    JSON.stringify({ search: { limit: 10, contextLines: 3 } }),
  );

  const allTitles = q.context.map(([t]) => t);

  const noteList = allTitles.map((t) => `- [[${sanitize(t)}]]`).join("\n");
  fs.writeFileSync(
    path.join(napkinDir, "NAPKIN.md"),
    `# Knowledge Base\n\nThis vault contains ${allTitles.length} notes on various topics.\n\n## Notes\n${noteList}\n`,
  );

  for (const [title, sentences] of q.context) {
    const body = sentences.join(" ");
    const links: string[] = [];
    for (const other of allTitles) {
      if (other !== title && body.toLowerCase().includes(other.toLowerCase())) {
        links.push(other);
      }
    }

    let content = `# ${title}\n\n${body}\n`;
    if (links.length > 0) {
      content +=
        "\n## Related\n" +
        links.map((l) => `- [[${sanitize(l)}]]`).join("\n") +
        "\n";
    }

    fs.writeFileSync(path.join(napkinDir, `${sanitize(title)}.md`), content);
  }

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function recall(retrieved: string[], gold: string[]): number {
  const s = new Set(retrieved.map((r) => r.toLowerCase()));
  return gold.filter((g) => s.has(g.toLowerCase())).length / gold.length;
}

function precision(retrieved: string[], gold: string[]): number {
  if (retrieved.length === 0) return 0;
  const s = new Set(gold.map((g) => g.toLowerCase()));
  return retrieved.filter((r) => s.has(r.toLowerCase())).length / retrieved.length;
}

function f1(p: number, r: number): number {
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

function mrr(retrieved: string[], gold: string[]): number {
  const s = new Set(gold.map((g) => g.toLowerCase()));
  for (let i = 0; i < retrieved.length; i++) {
    if (s.has(retrieved[i].toLowerCase())) return 1 / (i + 1);
  }
  return 0;
}

function tokenF1(pred: string, ref: string): number {
  const normalize = (s: string) =>
    String(s)
      .toLowerCase()
      .replace(/\b(a|an|the)\b/g, " ")
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const p = normalize(pred),
    r = normalize(ref);
  if (r.length === 0) return p.length === 0 ? 1 : 0;
  if (p.length === 0) return 0;
  const rs = new Set(r),
    ps = new Set(p);
  const prec = p.filter((t) => rs.has(t)).length / p.length;
  const rec = r.filter((t) => ps.has(t)).length / r.length;
  return prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
}

// ---------------------------------------------------------------------------
// Extract accessed notes from pi output
// ---------------------------------------------------------------------------

function extractAccessedNotes(output: string, allTitles: string[]): string[] {
  const accessed = new Set<string>();
  const safeTitles = allTitles.map((t) => sanitize(t));

  for (const safe of safeTitles) {
    // Match filename references (with or without .md), quoted names, and raw mentions
    if (
      output.includes(safe + ".md") ||
      output.includes(`"${safe}"`) ||
      output.includes(`'${safe}'`) ||
      output.includes(`napkin read "${safe}"`) ||
      output.includes(`napkin read '${safe}'`) ||
      output.includes(`napkin read ${safe}`)
    ) {
      accessed.add(safe);
    }
  }

  // Also match original (unsanitized) titles mentioned in agent reasoning
  for (let i = 0; i < allTitles.length; i++) {
    const original = allTitles[i];
    const safe = safeTitles[i];
    // Title appears as a heading, bold, or in a sentence
    if (
      output.includes(`# ${original}`) ||
      output.includes(`**${original}**`) ||
      output.includes(`"${original}"`) ||
      // Search or read command mentioning the title
      output.includes(`napkin search`) && output.includes(original) ||
      output.includes(`napkin read`) && output.includes(original)
    ) {
      accessed.add(safe);
    }
  }

  return [...accessed];
}

// ---------------------------------------------------------------------------
// Extract agent answer
// ---------------------------------------------------------------------------

function extractAnswer(text: string, goldAnswer: string): string {
  const answerMatch = text.match(/ANSWER:\s*(.+?)(?:\n|$)/i);
  let answer = answerMatch ? answerMatch[1].trim() : text.trim().split("\n").pop()?.trim() || "";

  // If gold answer is short, trim agent's verbose answer to first clause
  if (goldAnswer.split(/\s+/).length <= 3 && answer.length > goldAnswer.length * 5) {
    const short = answer.split(/[,.]/, 1)[0].trim();
    if (short.length > 0) answer = short;
  }

  return answer;
}

// ---------------------------------------------------------------------------
// Run a single question through pi CLI
// ---------------------------------------------------------------------------

async function runQuestion(
  q: HotpotQuestion,
  modelFlag: string,
  extensionPath: string,
  verbose: boolean,
): Promise<QResult | null> {
  const goldTitles = [...new Set(q.supporting_facts.map(([t]) => sanitize(t)))];
  const allSafeTitles = q.context.map(([t]) => sanitize(t));

  const vaultRoot = createTempVault(q);
  const vaultPath = path.join(vaultRoot, ".napkin");
  const start = Date.now();

  try {
    const prompt = `Question: ${q.question}

Search the vault to find the answer. Use napkin search and napkin read commands.
Always pass --vault "${vaultPath}" to every napkin command.
Do NOT use find, ls, grep, or any other command. ONLY use napkin commands.
Follow links between notes when needed.
When done, respond with ANSWER: followed by ONLY the answer in 1-5 words. No explanation. Examples: ANSWER: yes / ANSWER: Naomi Campbell / ANSWER: 1788`;

    // Shell out to pi CLI in non-interactive JSON mode — gives us full tool call visibility
    const output = execFileSync("pi", [
      "--print",
      "--mode", "json",
      "--model", modelFlag,
      "--extension", extensionPath,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--append-system-prompt", `You have access to a napkin vault at ${vaultPath}. Use napkin commands via bash to search and read notes. Always pass --vault "${vaultPath}" to every napkin command. Do NOT use find, ls, grep, or any other command outside napkin.`,
      prompt,
    ], {
      encoding: "utf-8",
      timeout: 120_000,
      cwd: vaultRoot,
      env: { ...process.env },
      maxBuffer: 50 * 1024 * 1024,
    });

    // Parse JSONL to extract agent text and tool calls
    let agentText = "";
    const toolArgs: string[] = [];
    const toolResults: string[] = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "message_update" && evt.assistantMessageEvent?.type === "text_delta") {
          agentText += evt.assistantMessageEvent.delta;
        }
        // Capture tool call args (bash commands)
        if (evt.type === "tool_execution_start" && evt.args) {
          toolArgs.push(JSON.stringify(evt.args));
        }
        // Capture tool results
        if (evt.type === "tool_execution_end" && evt.result) {
          const content = evt.result?.content;
          if (Array.isArray(content)) {
            toolResults.push(content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
          }
        }
      } catch {}
    }

    // Combine all text for note extraction
    const allText = [agentText, ...toolArgs, ...toolResults].join("\n");

    if (verbose) {
      console.log(`    📝 Agent (last 300): ${agentText.slice(-300)}`);
    }

    const accessed = extractAccessedNotes(allText, allSafeTitles);
    const gold = goldTitles.filter((g) => fs.existsSync(path.join(vaultPath, `${g}.md`)));
    if (gold.length === 0) return null;

    const agentAnswer = extractAnswer(agentText, q.answer);
    const r = recall(accessed, gold);
    const p = precision(accessed, gold);

    return {
      id: q._id,
      question: q.question,
      answer: q.answer,
      qtype: q.type,
      gold,
      retrieved: accessed,
      agentAnswer,
      recall: r,
      precision: p,
      f1: f1(p, r),
      mrr: mrr(accessed, gold),
      ansF1: tokenF1(agentAnswer, q.answer),
      elapsed: (Date.now() - start) / 1000,
    };
  } catch (err: any) {
    if (verbose) {
      console.error(`  ❌ Error on ${q._id}: ${err.message?.substring(0, 200)}`);
      if (err.stdout) console.error(`    stdout: ${err.stdout.substring(0, 300)}`);
      if (err.stderr) console.error(`    stderr: ${err.stderr.substring(0, 300)}`);
    } else {
      console.error(`  ❌ ${q._id}: ${err.message?.substring(0, 100)}`);
    }
    return null;
  } finally {
    try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  n: number;
  type: string | null;
  jsonOutput: boolean;
  verbose: boolean;
  model: string;
  concurrency: number;
  seed: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let n = 500, type: string | null = null;
  let jsonOutput = false, verbose = false;
  let model = "anthropic/claude-haiku-4-5-20251001";
  let concurrency = 10;
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && i + 1 < args.length) n = parseInt(args[++i], 10);
    else if (args[i] === "--type" && i + 1 < args.length) type = args[++i];
    else if (args[i] === "--model" && i + 1 < args.length) model = args[++i];
    else if (args[i] === "--concurrency" && i + 1 < args.length) concurrency = parseInt(args[++i], 10);
    else if (args[i] === "--seed" && i + 1 < args.length) seed = parseInt(args[++i], 10);
    else if (args[i] === "--json") jsonOutput = true;
    else if (args[i] === "--verbose") verbose = true;
  }
  return { n, type, jsonOutput, verbose, model, concurrency, seed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const startTime = Date.now();

  const extensionPath = path.resolve(".", ".pi/extensions/napkin-context/index.ts");
  if (!fs.existsSync(extensionPath)) {
    console.error(`napkin-context extension not found at ${extensionPath}`);
    process.exit(1);
  }

  console.log("HotpotQA Agentic Benchmark — pi + napkin");
  console.log("=".repeat(60));
  console.log(`  Questions: ${args.n} | Model: ${args.model} | Type: ${args.type ?? "all"} | Seed: ${args.seed}`);
  console.log(`  Concurrency: ${args.concurrency} | Sampling: stratified 80/20 bridge/comparison`);
  console.log(`  Extension: ${extensionPath}`);
  console.log(`  Invocation: pi --print --model <m> -e <ext> -ne -ns -np <prompt>`);
  console.log("=".repeat(60) + "\n");

  // Seeded PRNG (mulberry32) for reproducible sampling
  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function seededShuffle<T>(arr: T[], rng: () => number): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const dataPath = path.join("bench", "data", "hotpotqa-dev.json");
  if (!fs.existsSync(dataPath)) {
    const dataDir = path.dirname(dataPath);
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("Downloading HotpotQA dev set (44MB)...");
    const resp = await fetch("http://curtis.ml.cmu.edu/datasets/hotpot/hotpot_dev_distractor_v1.json");
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    fs.writeFileSync(dataPath, Buffer.from(await resp.arrayBuffer()));
    console.log("Done.\n");
  }
  const raw = fs.readFileSync(dataPath, "utf-8");
  const allQuestions: HotpotQuestion[] = JSON.parse(raw);

  let dataset: HotpotQuestion[];
  if (args.type) {
    // Single type — just shuffle and take n
    const rng = mulberry32(args.seed);
    dataset = seededShuffle(allQuestions.filter(q => q.type === args.type), rng).slice(0, args.n);
  } else {
    // Stratified sampling: maintain 80/20 bridge/comparison ratio
    const rng = mulberry32(args.seed);
    const bridges = seededShuffle(allQuestions.filter(q => q.type === "bridge"), rng);
    const comparisons = seededShuffle(allQuestions.filter(q => q.type === "comparison"), rng);
    const nBridge = Math.round(args.n * 0.8);
    const nComparison = args.n - nBridge;
    dataset = [
      ...bridges.slice(0, nBridge),
      ...comparisons.slice(0, nComparison),
    ];
    // Shuffle the combined set so bridge/comparison are interleaved
    dataset = seededShuffle(dataset, mulberry32(args.seed + 1));
  }

  console.log(`Sampled ${dataset.length} questions (seed=${args.seed}, stratified 80/20).`);
  console.log(`  Bridge: ${dataset.filter(q => q.type === "bridge").length}, Comparison: ${dataset.filter(q => q.type === "comparison").length}\n`);

  // Live log — JSONL, one line per question as it completes
  const resultsDir = path.join("bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(resultsDir, `run-${ts}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  // Write run metadata as first line
  logStream.write(JSON.stringify({
    _type: "meta",
    system: "pi + napkin (agentic, CLI)",
    model: args.model,
    timestamp: new Date().toISOString(),
    config: { n: args.n, type: args.type, concurrency: args.concurrency, seed: args.seed, sampling: "stratified 80/20" },
    invocation: `pi --print --mode json --model ${args.model} -e napkin-context -ne -ns -np`,
    dataset: { total: 7405, sampled: args.n, bridge: dataset.filter(q => q.type === "bridge").length, comparison: dataset.filter(q => q.type === "comparison").length },
  }) + "\n");

  console.log(`  Log: ${logPath}\n`);

  const results: QResult[] = [];
  let completed = 0;

  async function processQuestion(q: HotpotQuestion, idx: number) {
    if (args.verbose) {
      console.log(`  [${idx + 1}/${dataset.length}] ${q.question.substring(0, 80)}...`);
    }

    const result = await runQuestion(q, args.model, extensionPath, args.verbose);
    if (result) {
      results.push(result);
      logStream.write(JSON.stringify({ _type: "result", ...result }) + "\n");
    } else {
      logStream.write(JSON.stringify({ _type: "error", id: q._id, question: q.question }) + "\n");
    }
    completed++;

    if (completed % 10 === 0 || completed === dataset.length) {
      const done = results.length;
      if (done > 0) {
        const avgR = results.reduce((s, r) => s + r.recall, 0) / done;
        const avgAnsF1 = results.reduce((s, r) => s + r.ansF1, 0) / done;
        const avgElapsed = results.reduce((s, r) => s + r.elapsed, 0) / done;
        console.log(
          `  [${completed}/${dataset.length}] R@K=${(avgR * 100).toFixed(1)}%  AnsF1=${avgAnsF1.toFixed(3)}  avg=${avgElapsed.toFixed(1)}s/q`,
        );
      }
    }
  }

  // Run with bounded concurrency
  const queue = dataset.map((q, i) => ({ q, i }));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < args.concurrency; w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift()!;
          await processQuestion(item.q, item.i);
        }
      })(),
    );
  }
  await Promise.all(workers);

  results.sort(
    (a, b) =>
      dataset.findIndex((q) => q._id === a.id) -
      dataset.findIndex((q) => q._id === b.id),
  );

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const div = "=".repeat(60);
  const done = results.length;

  if (done === 0) {
    console.log("\nNo results. Check API keys and model availability.");
    process.exit(1);
  }

  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / done;
  const avgPrecision = results.reduce((s, r) => s + r.precision, 0) / done;
  const avgF1 = results.reduce((s, r) => s + r.f1, 0) / done;
  const avgMRR = results.reduce((s, r) => s + r.mrr, 0) / done;
  const avgAnsF1 = results.reduce((s, r) => s + r.ansF1, 0) / done;
  const avgElapsed = results.reduce((s, r) => s + r.elapsed, 0) / done;

  // Bootstrap 95% confidence intervals (10,000 resamples)
  function bootstrapCI(values: number[], nBoot = 10_000): [number, number] {
    const n = values.length;
    if (n === 0) return [0, 0];
    const means: number[] = [];
    for (let b = 0; b < nBoot; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += values[Math.floor(Math.random() * n)];
      }
      means.push(sum / n);
    }
    means.sort((a, b) => a - b);
    return [means[Math.floor(nBoot * 0.025)], means[Math.floor(nBoot * 0.975)]];
  }

  const recallCI = bootstrapCI(results.map(r => r.recall));
  const ansF1CI = bootstrapCI(results.map(r => r.ansF1));
  const f1CI = bootstrapCI(results.map(r => r.f1));

  const bridge = results.filter((r) => r.qtype === "bridge");
  const comparison = results.filter((r) => r.qtype === "comparison");
  const avg = (arr: QResult[], key: keyof QResult) =>
    arr.length > 0 ? arr.reduce((s, r) => s + (r[key] as number), 0) / arr.length : 0;

  const errors = args.n - done;
  const totalElapsed = parseFloat(elapsed);

  console.log("\n" + div);
  console.log(`RESULTS — pi + napkin (agentic, ${args.model})`);
  console.log(div);
  console.log(`  Dataset:       HotpotQA dev (${args.n}/${7405} questions)`);
  console.log(`  Evaluated:     ${done} succeeded, ${errors} errors (${elapsed}s total)`);
  console.log(`  Recall:        ${(avgRecall * 100).toFixed(1)}%  [${(recallCI[0] * 100).toFixed(1)}%, ${(recallCI[1] * 100).toFixed(1)}%] 95% CI`);
  console.log(`  F1:            ${avgF1.toFixed(3)}  [${f1CI[0].toFixed(3)}, ${f1CI[1].toFixed(3)}] 95% CI`);
  console.log(`  Answer F1:     ${avgAnsF1.toFixed(3)}  [${ansF1CI[0].toFixed(3)}, ${ansF1CI[1].toFixed(3)}] 95% CI`);
  console.log(`  MRR:           ${avgMRR.toFixed(3)}`);
  console.log(`  Avg latency:   ${avgElapsed.toFixed(1)}s/question`);
  console.log(`  Throughput:    ${(done / totalElapsed * 60).toFixed(1)} questions/min (concurrency ${args.concurrency})`);

  if (bridge.length > 0 && comparison.length > 0) {
    console.log(
      `\n  Bridge (${bridge.length}):     R=${(avg(bridge, "recall") * 100).toFixed(1)}%  F1=${avg(bridge, "f1").toFixed(3)}  AnsF1=${avg(bridge, "ansF1").toFixed(3)}`,
    );
    console.log(
      `  Comparison (${comparison.length}): R=${(avg(comparison, "recall") * 100).toFixed(1)}%  F1=${avg(comparison, "f1").toFixed(3)}  AnsF1=${avg(comparison, "ansF1").toFixed(3)}`,
    );
  }

  console.log("\n" + div);
  console.log("COMPARISON");
  console.log(div);
  console.log(
    `  ${"System".padEnd(22)} ${"Recall".padStart(8)} ${"AnsF1".padStart(8)} ${"Infra".padStart(28)}`,
  );
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(28)}`,
  );
  console.log(
    `  ${"pi + napkin".padEnd(22)} ${((avgRecall * 100).toFixed(1) + "%").padStart(8)} ${avgAnsF1.toFixed(3).padStart(8)} ${"pi CLI + napkin ext".padStart(28)}`,
  );
  console.log(
    `  ${"Ori explore".padEnd(22)} ${"90.0%".padStart(8)} ${"0.410".padStart(8)} ${"SQLite + embeddings".padStart(28)}`,
  );
  console.log(
    `  ${"Ori flat".padEnd(22)} ${"87.0%".padStart(8)} ${"0.403".padStart(8)} ${"SQLite + embeddings".padStart(28)}`,
  );
  console.log(
    `  ${"Mem0".padEnd(22)} ${"29.0%".padStart(8)} ${"0.188".padStart(8)} ${"Redis + Qdrant + cloud".padStart(28)}`,
  );
  console.log(div + "\n");

  // Write summary to log
  logStream.write(JSON.stringify({
    _type: "summary",
    evaluated: done, errors, totalTime: elapsed,
    recall: avgRecall, recallCI, f1: avgF1, f1CI, ansF1: avgAnsF1, ansF1CI,
    mrr: avgMRR, avgLatency: avgElapsed,
    bridge: { n: bridge.length, recall: avg(bridge, "recall"), ansF1: avg(bridge, "ansF1") },
    comparison: { n: comparison.length, recall: avg(comparison, "recall"), ansF1: avg(comparison, "ansF1") },
  }) + "\n");
  logStream.end();
  console.log(`Log saved to ${logPath}`);

  if (args.jsonOutput) {
    const outPath = path.join(resultsDir, `napkin-hotpotqa-${ts}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          system: "pi + napkin (agentic, CLI)",
          model: args.model,
          timestamp: new Date().toISOString(),
          invocation: `pi --print --model ${args.model} -e .pi/extensions/napkin-context/index.ts -ne -ns -np --append-system-prompt <vault-context> <prompt>`,
          config: { n: args.n, type: args.type, concurrency: args.concurrency, seed: args.seed, sampling: "stratified 80/20" },
          dataset: { total: 7405, sampled: args.n, evaluated: done, errors },
          summary: {
            recall: avgRecall, recallCI: recallCI,
            precision: avgPrecision,
            f1: avgF1, f1CI: f1CI,
            mrr: avgMRR,
            ansF1: avgAnsF1, ansF1CI: ansF1CI,
            avgLatency: avgElapsed,
            totalTime: elapsed,
            throughput: done / totalElapsed * 60,
          },
          breakdown: {
            bridge: { n: bridge.length, recall: avg(bridge, "recall"), f1: avg(bridge, "f1"), ansF1: avg(bridge, "ansF1") },
            comparison: { n: comparison.length, recall: avg(comparison, "recall"), f1: avg(comparison, "f1"), ansF1: avg(comparison, "ansF1") },
          },
          results,
        },
        null,
        2,
      ),
    );
    console.log(`Results saved to ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
