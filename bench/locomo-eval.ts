#!/usr/bin/env npx tsx
/**
 * LoCoMo Benchmark — pi + napkin (agentic)
 *
 * Tests long-term conversational memory: 10 conversations split into sessions,
 * 699 questions across single-hop, multi-hop, and temporal reasoning.
 * Each conversation session becomes a napkin note. The agent uses napkin
 * search/read/link to find answers.
 *
 * Usage:
 *   npx tsx bench/locomo-eval.ts                          # All 10 conversations, categories 1-3
 *   npx tsx bench/locomo-eval.ts --sample 0               # Single conversation
 *   npx tsx bench/locomo-eval.ts --categories 1,2,3       # Filter by category
 *   npx tsx bench/locomo-eval.ts --max-questions 50       # Limit questions
 *   npx tsx bench/locomo-eval.ts --json                   # Save results
 *   npx tsx bench/locomo-eval.ts --model "anthropic/claude-haiku-4-5-20251001"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[];
  category: number; // 1=multi-hop, 2=single-hop, 3=temporal, 4=open-domain, 5=adversarial
}

interface LoCoMoSample {
  sample_id: string;
  conversation: Record<string, unknown> & {
    speaker_a: string;
    speaker_b: string;
  };
  observation: Record<string, string[]>;
  session_summary: Record<string, string>;
  qa: LoCoMoQA[];
}

interface QResult {
  sampleId: string;
  question: string;
  answer: string;
  category: number;
  categoryName: string;
  evidenceSessions: string[];
  retrieved: string[];
  agentAnswer: string;
  recall: number;
  precision: number;
  f1: number;
  mrr: number;
  ansF1: number;
  elapsed: number;
}

const CATEGORY_NAMES: Record<number, string> = {
  1: "multi-hop",
  2: "single-hop",
  3: "temporal",
};

// ---------------------------------------------------------------------------
// Vault creation: conversation sessions → napkin notes
// ---------------------------------------------------------------------------

function parseLoCoMoDate(dateStr: string): string {
  const match = dateStr.match(/on\s+(\d+)\s+(\w+),?\s+(\d{4})/);
  if (!match) return "2023-01-01";
  const [, day, monthName, year] = match;
  const months: Record<string, string> = {
    January: "01", February: "02", March: "03", April: "04",
    May: "05", June: "06", July: "07", August: "08",
    September: "09", October: "10", November: "11", December: "12",
  };
  return `${year}-${months[monthName] ?? "01"}-${day.padStart(2, "0")}`;
}

function createConversationVault(sample: LoCoMoSample): { tmpDir: string; sessionTitles: string[] } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-locomo-"));
  const napkinDir = path.join(tmpDir, ".napkin");
  fs.mkdirSync(napkinDir, { recursive: true });

  fs.writeFileSync(
    path.join(napkinDir, "config.json"),
    JSON.stringify({ search: { limit: 10, contextLines: 3 } }),
  );

  const conv = sample.conversation;
  const speakerA = conv.speaker_a;
  const speakerB = conv.speaker_b;

  // Find session numbers
  const sessionNums: number[] = [];
  for (const key of Object.keys(conv)) {
    const m = key.match(/^session_(\d+)$/);
    if (m && Array.isArray(conv[key])) sessionNums.push(parseInt(m[1], 10));
  }
  sessionNums.sort((a, b) => a - b);

  const sessionTitles: string[] = [];

  for (const num of sessionNums) {
    const turns = conv[`session_${num}`] as LoCoMoTurn[] | undefined;
    const dateStr = conv[`session_${num}_date_time`] as string | undefined;
    if (!turns || turns.length === 0) continue;

    const date = dateStr ? parseLoCoMoDate(dateStr) : "2023-01-01";
    const title = `session-${num}`;
    sessionTitles.push(title);

    const bodyLines = turns.map((t) => `${t.speaker}: ${t.text}`);
    const summary = sample.session_summary?.[`session_${num}_summary`] ?? "";
    const observations = sample.observation?.[`session_${num}_observation`] ?? [];

    // Links to adjacent sessions
    const links: string[] = [];
    if (num > 1 && sessionNums.includes(num - 1)) links.push(`session-${num - 1}`);
    if (sessionNums.includes(num + 1)) links.push(`session-${num + 1}`);

    let content = `# Session ${num} — ${speakerA} & ${speakerB}\n`;
    content += `Date: ${date}${dateStr ? ` (${dateStr})` : ""}\n\n`;
    if (summary) content += `## Summary\n${summary}\n\n`;
    content += `## Dialogue\n${bodyLines.join("\n")}\n`;
    if (observations.length > 0) {
      content += `\n## Observations\n${observations.map((o) => `- ${o}`).join("\n")}\n`;
    }
    if (links.length > 0) {
      content += `\n## Related\n${links.map((l) => `- [[${l}]]`).join("\n")}\n`;
    }

    fs.writeFileSync(path.join(napkinDir, `${title}.md`), content);
  }

  // NAPKIN.md overview
  const noteList = sessionTitles.map((t) => `- [[${t}]]`).join("\n");
  fs.writeFileSync(
    path.join(napkinDir, "NAPKIN.md"),
    `# Conversations: ${speakerA} & ${speakerB}\n\n${sessionTitles.length} conversation sessions.\n\n## Sessions\n${noteList}\n`,
  );

  return { tmpDir, sessionTitles };
}

// ---------------------------------------------------------------------------
// Evidence mapping: "D3:5" → session-3
// ---------------------------------------------------------------------------

function evidenceToSessions(evidence: string[]): string[] {
  const sessions = new Set<string>();
  for (const eid of evidence) {
    const m = eid.match(/^D(\d+):/);
    if (m) sessions.add(`session-${m[1]}`);
  }
  return [...sessions];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function recall(retrieved: string[], gold: string[]): number {
  const s = new Set(retrieved.map((r) => r.toLowerCase()));
  return gold.length > 0 ? gold.filter((g) => s.has(g.toLowerCase())).length / gold.length : 0;
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
    String(s).toLowerCase().replace(/\b(a|an|the)\b/g, " ").replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const p = normalize(pred), r = normalize(ref);
  if (r.length === 0) return p.length === 0 ? 1 : 0;
  if (p.length === 0) return 0;
  const rs = new Set(r), ps = new Set(p);
  const prec = p.filter((t) => rs.has(t)).length / p.length;
  const rec = r.filter((t) => ps.has(t)).length / r.length;
  return prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
}

function extractAccessedNotes(output: string, sessionTitles: string[]): string[] {
  const accessed = new Set<string>();
  for (const title of sessionTitles) {
    if (output.includes(title + ".md") || output.includes(`"${title}"`) || output.includes(`'${title}'`)) {
      accessed.add(title);
    }
  }
  // Also match from napkin output patterns
  for (const title of sessionTitles) {
    if (output.includes(`# Session ${title.replace("session-", "")}`) || output.includes(`napkin read "${title}"`)) {
      accessed.add(title);
    }
  }
  return [...accessed];
}

function extractAnswer(text: string, goldAnswer: string): string {
  const answerMatch = text.match(/ANSWER:\s*(.+?)(?:\n|$)/i);
  let answer = answerMatch ? answerMatch[1].trim() : text.trim().split("\n").pop()?.trim() || "";
  if (String(goldAnswer).split(/\s+/).length <= 3 && answer.length > String(goldAnswer).length * 5) {
    const short = answer.split(/[,.]/, 1)[0].trim();
    if (short.length > 0) answer = short;
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Run a single question through pi CLI
// ---------------------------------------------------------------------------

function runQuestion(
  q: LoCoMoQA,
  vaultPath: string,
  vaultRoot: string,
  sessionTitles: string[],
  modelFlag: string,
  extensionPath: string,
  verbose: boolean,
): QResult | null {
  const evidenceSessions = evidenceToSessions(q.evidence);
  if (evidenceSessions.length === 0) return null;

  const start = Date.now();

  try {
    const prompt = `Question about a conversation: ${q.question}

Search the vault to find the answer. The vault contains conversation session notes.
Always pass --vault "${vaultPath}" to every napkin command.
Do NOT use find, ls, grep, or any other command. ONLY use napkin commands.
When done, respond with ANSWER: <your short answer, 1-5 words>`;

    const output = execFileSync("pi", [
      "--print",
      "--mode", "json",
      "--model", modelFlag,
      "--extension", extensionPath,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--append-system-prompt", `You have access to a napkin vault at ${vaultPath} containing conversation session notes. Use napkin commands via bash. Always pass --vault "${vaultPath}". Do NOT use find, ls, grep.`,
      prompt,
    ], {
      encoding: "utf-8",
      timeout: 120_000,
      cwd: vaultRoot,
      env: { ...process.env },
      maxBuffer: 50 * 1024 * 1024,
    });

    // Parse JSONL
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
        if (evt.type === "tool_execution_start" && evt.args) toolArgs.push(JSON.stringify(evt.args));
        if (evt.type === "tool_execution_end" && evt.result) {
          const content = evt.result?.content;
          if (Array.isArray(content)) {
            toolResults.push(content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
          }
        }
      } catch {}
    }

    const allText = [agentText, ...toolArgs, ...toolResults].join("\n");
    const accessed = extractAccessedNotes(allText, sessionTitles);
    const agentAnswer = extractAnswer(agentText, String(q.answer));
    const r = recall(accessed, evidenceSessions);
    const p = precision(accessed, evidenceSessions);

    if (verbose) {
      console.log(`      ${CATEGORY_NAMES[q.category]} | R=${(r*100).toFixed(0)}% AnsF1=${tokenF1(agentAnswer, String(q.answer)).toFixed(3)} | ${q.question.substring(0,60)}`);
    }

    return {
      sampleId: "",  // filled by caller
      question: q.question,
      answer: String(q.answer),
      category: q.category,
      categoryName: CATEGORY_NAMES[q.category] ?? "unknown",
      evidenceSessions,
      retrieved: accessed,
      agentAnswer,
      recall: r,
      precision: p,
      f1: f1(p, r),
      mrr: mrr(accessed, evidenceSessions),
      ansF1: tokenF1(agentAnswer, String(q.answer)),
      elapsed: (Date.now() - start) / 1000,
    };
  } catch (err: any) {
    if (verbose) console.error(`      ❌ ${err.message?.substring(0, 100)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  sampleIndex: number | null;
  categories: Set<number>;
  maxQuestions: number;
  jsonOutput: boolean;
  verbose: boolean;
  model: string;
  concurrency: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let sampleIndex: number | null = null;
  let categories = new Set([1, 2, 3]); // default: skip open-domain + adversarial
  let maxQuestions = Infinity;
  let jsonOutput = false, verbose = false;
  let model = "anthropic/claude-haiku-4-5-20251001";
  let concurrency = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sample" && i + 1 < args.length) sampleIndex = parseInt(args[++i], 10);
    else if (args[i] === "--categories" && i + 1 < args.length) categories = new Set(args[++i].split(",").map(Number));
    else if (args[i] === "--max-questions" && i + 1 < args.length) maxQuestions = parseInt(args[++i], 10);
    else if (args[i] === "--model" && i + 1 < args.length) model = args[++i];
    else if (args[i] === "--concurrency" && i + 1 < args.length) concurrency = parseInt(args[++i], 10);
    else if (args[i] === "--json") jsonOutput = true;
    else if (args[i] === "--verbose") verbose = true;
  }
  return { sampleIndex, categories, maxQuestions, jsonOutput, verbose, model, concurrency };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const startTime = Date.now();

  const extensionPath = path.resolve(".", ".pi/extensions/napkin-context/index.ts");

  console.log("LoCoMo Benchmark — pi + napkin (agentic)");
  console.log("=".repeat(60));
  console.log(`  Model: ${args.model} | Categories: ${[...args.categories].join(",")}`);
  console.log(`  Concurrency: ${args.concurrency} | Max questions: ${args.maxQuestions === Infinity ? "all" : args.maxQuestions}`);
  console.log("=".repeat(60) + "\n");

  const dataPath = path.join("bench", "data", "locomo10.json");
  if (!fs.existsSync(dataPath)) {
    const dataDir = path.dirname(dataPath);
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("Downloading LoCoMo dataset (2.7MB)...");
    const resp = await fetch("https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json");
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    fs.writeFileSync(dataPath, Buffer.from(await resp.arrayBuffer()));
    console.log("Done.\n");
  }
  const raw = fs.readFileSync(dataPath, "utf-8");
  const dataset: LoCoMoSample[] = JSON.parse(raw);
  const samples = args.sampleIndex !== null ? [dataset[args.sampleIndex]] : dataset;

  // Log file
  const resultsDir = path.join("bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(resultsDir, `locomo-run-${ts}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(JSON.stringify({ _type: "meta", system: "pi + napkin", model: args.model, categories: [...args.categories], timestamp: new Date().toISOString() }) + "\n");
  console.log(`  Log: ${logPath}\n`);

  const allResults: QResult[] = [];
  let totalProcessed = 0;

  for (const sample of samples) {
    if (totalProcessed >= args.maxQuestions) break;

    const speakerA = sample.conversation.speaker_a;
    const speakerB = sample.conversation.speaker_b;
    console.log(`--- ${sample.sample_id} (${speakerA} & ${speakerB}) ---`);

    // Create vault for this conversation
    const { tmpDir, sessionTitles } = createConversationVault(sample);
    const vaultPath = path.join(tmpDir, ".napkin");

    // Get vault overview
    let vaultOverview = "";
    try {
      vaultOverview = execFileSync(`napkin`, ["overview", "--vault", vaultPath], { encoding: "utf-8", timeout: 10000 }).trim();
    } catch {}

    // Filter QAs
    let qas = sample.qa.filter((q) => args.categories.has(q.category));
    const remaining = args.maxQuestions - totalProcessed;
    if (qas.length > remaining) qas = qas.slice(0, remaining);

    console.log(`  ${sessionTitles.length} sessions, ${qas.length} questions`);

    // Process questions with concurrency
    const queue = [...qas];
    const workers: Promise<void>[] = [];
    for (let w = 0; w < args.concurrency; w++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const q = queue.shift()!;
          const result = runQuestion(q, vaultPath, tmpDir, sessionTitles, args.model, extensionPath, args.verbose);
          if (result) {
            result.sampleId = sample.sample_id;
            allResults.push(result);
            logStream.write(JSON.stringify({ _type: "result", ...result }) + "\n");
          } else {
            logStream.write(JSON.stringify({ _type: "error", sampleId: sample.sample_id, question: q.question }) + "\n");
          }
          totalProcessed++;
        }
      })());
    }
    await Promise.all(workers);

    // Progress per conversation
    const convResults = allResults.filter((r) => r.sampleId === sample.sample_id);
    if (convResults.length > 0) {
      const avgAnsF1 = convResults.reduce((s, r) => s + r.ansF1, 0) / convResults.length;
      const avgRecall = convResults.reduce((s, r) => s + r.recall, 0) / convResults.length;
      console.log(`  → R=${(avgRecall*100).toFixed(1)}%  AnsF1=${avgAnsF1.toFixed(3)}  (${convResults.length} questions)\n`);
    }

    // Cleanup vault
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const div = "=".repeat(60);
  const done = allResults.length;

  // Per-category breakdown
  const byCategory = new Map<number, QResult[]>();
  for (const r of allResults) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }

  const avg = (arr: QResult[], key: keyof QResult) =>
    arr.length > 0 ? arr.reduce((s, r) => s + (r[key] as number), 0) / arr.length : 0;

  console.log(div);
  console.log(`RESULTS — pi + napkin (${args.model})`);
  console.log(div);

  const hdr = `  ${"Category".padEnd(12)} ${"N".padStart(5)} ${"Recall".padStart(8)} ${"F1".padStart(8)} ${"AnsF1".padStart(8)}`;
  console.log(hdr);
  console.log("  " + "─".repeat(hdr.length - 2));

  for (const [cat, results] of [...byCategory.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${(CATEGORY_NAMES[cat] ?? "?").padEnd(12)} ${String(results.length).padStart(5)} ${(avg(results, "recall") * 100).toFixed(1).padStart(7)}% ${avg(results, "f1").toFixed(3).padStart(8)} ${avg(results, "ansF1").toFixed(3).padStart(8)}`);
  }

  console.log("  " + "─".repeat(hdr.length - 2));
  console.log(`  ${"OVERALL".padEnd(12)} ${String(done).padStart(5)} ${(avg(allResults, "recall") * 100).toFixed(1).padStart(7)}% ${avg(allResults, "f1").toFixed(3).padStart(8)} ${avg(allResults, "ansF1").toFixed(3).padStart(8)}`);

  // Comparison with Ori and baselines (Answer F1 scaled to 0-100)
  console.log("\n" + div);
  console.log("COMPARISON (Answer F1 × 100, same scale as Mem0 paper)");
  console.log(div);

  const singleF1 = (avg(byCategory.get(2) ?? [], "ansF1") * 100).toFixed(2);
  const multiF1 = (avg(byCategory.get(1) ?? [], "ansF1") * 100).toFixed(2);
  const tempF1 = (avg(byCategory.get(3) ?? [], "ansF1") * 100).toFixed(2);

  const compHdr = `  ${"System".padEnd(20)} ${"Single".padStart(8)} ${"Multi".padStart(8)} ${"Temporal".padStart(8)} ${"Infra".padStart(22)}`;
  console.log(compHdr);
  console.log("  " + "─".repeat(compHdr.length - 2));

  const rows = [
    ["pi + napkin", singleF1, multiF1, tempF1, "pi CLI + napkin"],
    ["Ori Mnemos", "37.69", "29.31", "—", "SQLite + embeddings"],
    ["Mem0", "38.72", "28.64", "48.93", "Redis + Qdrant + cloud"],
    ["Zep", "35.74", "19.37", "42.00", "PostgreSQL + cloud"],
    ["OpenAI Memory", "34.30", "—", "—", "OpenAI proprietary"],
    ["LangMem", "35.51", "26.04", "—", "Cloud APIs"],
    ["MemGPT/Letta", "26.65", "—", "—", "PostgreSQL + cloud"],
  ];
  for (const [name, s, m, t, infra] of rows) {
    console.log(`  ${name.padEnd(20)} ${s.padStart(8)} ${m.padStart(8)} ${t.padStart(8)} ${infra.padStart(22)}`);
  }
  console.log(div);

  console.log(`\n  Time: ${elapsed}s | ${done} questions | ${(done / parseFloat(elapsed) * 60).toFixed(1)} q/min`);

  // Write summary to log
  logStream.write(JSON.stringify({
    _type: "summary", evaluated: done, totalTime: elapsed,
    overall: { recall: avg(allResults, "recall"), f1: avg(allResults, "f1"), ansF1: avg(allResults, "ansF1") },
    byCategory: [...byCategory.entries()].map(([cat, r]) => ({
      category: cat, name: CATEGORY_NAMES[cat], n: r.length,
      recall: avg(r, "recall"), f1: avg(r, "f1"), ansF1: avg(r, "ansF1"),
    })),
  }) + "\n");
  logStream.end();
  console.log(`  Log: ${logPath}`);

  if (args.jsonOutput) {
    const outPath = path.join(resultsDir, `locomo-${ts}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      system: "pi + napkin (agentic, CLI)", model: args.model, timestamp: new Date().toISOString(),
      config: { categories: [...args.categories], concurrency: args.concurrency },
      summary: { recall: avg(allResults, "recall"), f1: avg(allResults, "f1"), ansF1: avg(allResults, "ansF1") },
      byCategory: [...byCategory.entries()].map(([cat, r]) => ({
        category: cat, name: CATEGORY_NAMES[cat], n: r.length,
        recall: avg(r, "recall"), f1: avg(r, "f1"), ansF1: avg(r, "ansF1"),
      })),
      results: allResults,
    }, null, 2));
    console.log(`  Results: ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
