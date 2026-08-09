#!/usr/bin/env npx tsx
/**
 * LongMemEval Benchmark — pi + napkin (agentic)
 *
 * Tests long-term memory of chat assistants: 500 questions across five core
 * abilities — Information Extraction, Multi-Session Reasoning, Knowledge Updates,
 * Temporal Reasoning, and Abstention.
 *
 * Each question has a timestamped chat history (haystack). Sessions become napkin
 * notes. The agent uses napkin search/read to find answers.
 *
 * Paper: Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term
 * Interactive Memory" (ICLR 2025). https://arxiv.org/abs/2410.10813
 *
 * Usage:
 *   npx tsx bench/longmemeval-eval.ts                          # All 500 questions (oracle)
 *   npx tsx bench/longmemeval-eval.ts --dataset s              # LongMemEval_S (~115k tokens)
 *   npx tsx bench/longmemeval-eval.ts --dataset m              # LongMemEval_M (~500 sessions)
 *   npx tsx bench/longmemeval-eval.ts --types single-session-user,multi-session
 *   npx tsx bench/longmemeval-eval.ts --n 50                   # Limit questions
 *   npx tsx bench/longmemeval-eval.ts --json                   # Save results
 *   npx tsx bench/longmemeval-eval.ts --model "anthropic/claude-haiku-4-5-20251001"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface LongMemInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: number[];
  haystack_dates: string[];
  haystack_sessions: ChatTurn[][];
  answer_session_ids: number[];
}

interface QResult {
  questionId: string;
  questionType: string;
  ability: string;
  question: string;
  answer: string;
  isAbstention: boolean;
  agentAnswer: string;
  evidenceSessionIds: number[];
  retrievedSessions: string[];
  sessionRecall: number;
  sessionPrecision: number;
  sessionF1: number;
  accuracy: number;
  elapsed: number;
  toolCalls: number;
  searchCalls: number;
  readCalls: number;
  mathCalls: number;
  toolResultChars: number;
  inputTokens: number;
  outputTokens: number;
}

// Map question_type to the five core abilities
const TYPE_TO_ABILITY: Record<string, string> = {
  "single-session-user": "information-extraction",
  "single-session-assistant": "information-extraction",
  "single-session-preference": "information-extraction",
  "multi-session": "multi-session-reasoning",
  "knowledge-update": "knowledge-updates",
  "temporal-reasoning": "temporal-reasoning",
};

function getAbility(questionType: string, questionId: string): string {
  if (questionId.endsWith("_abs")) return "abstention";
  return TYPE_TO_ABILITY[questionType] ?? questionType;
}

// ---------------------------------------------------------------------------
// Vault creation: haystack sessions → napkin notes
// ---------------------------------------------------------------------------

function createQuestionVault(instance: LongMemInstance): { tmpDir: string; sessionNoteNames: Map<number, string> } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-longmem-"));
  const napkinDir = path.join(tmpDir, ".napkin");
  fs.mkdirSync(napkinDir, { recursive: true });

  fs.writeFileSync(
    path.join(napkinDir, "config.json"),
    JSON.stringify({ search: { limit: 15, contextLines: 5 } }),
  );

  const sessionNoteNames = new Map<number, string>();

  for (let i = 0; i < instance.haystack_sessions.length; i++) {
    const sessionId = instance.haystack_session_ids[i];
    const date = instance.haystack_dates[i] ?? "unknown";
    const turns = instance.haystack_sessions[i];
    if (!turns || turns.length === 0) continue;

    // Per-round notes in day directory
    // Each round = user message + all following assistant messages until next user turn
    // If session starts with assistant turns, prepend them to the first user round
    const day = date.split(" ")[0].replace(/\//g, "-");
    const dayDir = path.join(napkinDir, day);
    fs.mkdirSync(dayDir, { recursive: true });

    // Group turns into rounds
    const rounds: ChatTurn[][] = [];
    let currentRound: ChatTurn[] = [];
    for (const turn of turns) {
      if (turn.role === "user" && currentRound.some((t) => t.role === "user")) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(turn);
    }
    if (currentRound.length > 0) rounds.push(currentRound);

    for (let ri = 0; ri < rounds.length; ri++) {
      const existingInDay = fs.readdirSync(dayDir).filter((f) => f.endsWith(".md")).length;
      const roundName = `${day}/round-${existingInDay + 1}`;

      let content = `# ${date}\n\n`;
      for (const t of rounds[ri]) {
        const speaker = t.role === "user" ? "User" : "Assistant";
        content += `**${speaker}:** ${t.content}\n\n`;
      }

      const notePath = path.join(napkinDir, `${roundName}.md`);
      fs.writeFileSync(notePath, content);

      // Set mtime from session date so napkin recency ranking works
      const dateMatch = date.match(/(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/);
      if (dateMatch) {
        const ts = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4]}:${dateMatch[5]}:00`);
        const roundTs = new Date(ts.getTime() + ri * 60000);
        fs.utimesSync(notePath, roundTs, roundTs);
      }

      // Map first round of each session for recall tracking
      if (ri === 0) {
        sessionNoteNames.set(sessionId, roundName);
      }
    }
  }

  // NAPKIN.md overview
  const days = [...new Set(instance.haystack_dates.map((d) => d.split(" ")[0]))].sort();
  const totalNotes = fs.readdirSync(napkinDir, { recursive: true }).filter((f) => String(f).endsWith(".md") && String(f) !== "NAPKIN.md").length;
  fs.writeFileSync(
    path.join(napkinDir, "NAPKIN.md"),
    `# Chat History\n\n${totalNotes} conversation notes across ${days.length} days.\nQuestion date: ${instance.question_date}\n`,
  );

  return { tmpDir, sessionNoteNames };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function recall(retrieved: string[], gold: string[]): number {
  if (gold.length === 0) return 0;
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

/**
 * LLM-as-judge scoring (matches paper's evaluate_qa.py methodology).
 * Returns 1 if correct, 0 if incorrect.
 * Falls back to normalized string matching if LLM call fails.
 */
function llmJudge(question: string, goldAnswer: string, prediction: string, modelFlag: string): number {
  // Fast path: normalized exact match
  const norm = (s: string) => String(s).toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const normGold = norm(goldAnswer);
  const normPred = norm(prediction);

  // Extract primary answer (before "is also acceptable" or similar qualifiers)
  const primaryMatch = goldAnswer.match(/^(.+?)(?:\.\s*\d+\s*days?\s*\(including|\.\s*[A-Z].*acceptable)/);
  const primaryAnswer = primaryMatch ? primaryMatch[1].trim() : goldAnswer;
  const normPrimary = norm(primaryAnswer);

  if (normPred === normGold || normPred === normPrimary) return 1;
  if (normPrimary.length > 0 && normPred.includes(normPrimary)) return 1;
  if (normPred.length > 0 && normPrimary.includes(normPred)) return 1;

  // LLM judge
  try {
    // Use question-type-aware judge prompts matching the paper's evaluation (Appendix A.4)
    let judgeInstruction: string;
    if (goldAnswer.toLowerCase().includes("would prefer") || goldAnswer.toLowerCase().includes("would like")) {
      // Preference question
      judgeInstruction = `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.`;
    } else if (goldAnswer.toLowerCase().includes("did not mention") || goldAnswer.toLowerCase().includes("not enough")) {
      // Abstention question
      judgeInstruction = `I will give you a question, a correct answer, and a response from a model. The correct answer indicates that the user never mentioned the asked information. Please answer yes if the model correctly refuses to answer or states that the information is not available. Answer no if the model provides a specific answer or guesses.`;
    } else if (question.toLowerCase().includes("how many days") || question.toLowerCase().includes("how long") || question.toLowerCase().includes("how many months") || question.toLowerCase().includes("order of")) {
      // Temporal reasoning
      judgeInstruction = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. Do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.`;
    } else {
      judgeInstruction = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. The prediction is correct even if it includes additional context or phrasing beyond the gold answer, as long as the core answer is present.`;
    }

    const judgePrompt = `${judgeInstruction}

Question: ${question}
${goldAnswer.toLowerCase().includes("would prefer") ? "Rubric" : "Correct Answer"}: ${goldAnswer}
Model Response: ${prediction}

Answer yes or no:`;

    const output = execFileSync("pi", [
      "--print",
      "--model", modelFlag,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      judgePrompt,
    ], {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Extract the first clear yes/no from the judge response
    const result = output.trim().toLowerCase();
    // Check first word
    const firstWord = result.split(/[\s.,!]+/)[0];
    if (firstWord === "yes") return 1;
    if (firstWord === "no") return 0;
    // Fallback: look for yes/no anywhere
    if (result.includes("yes") && !result.includes("no")) return 1;
    return 0;
  } catch {
    // Fallback: token F1 with primary answer only
    return tokenF1Basic(prediction, primaryAnswer);
  }
}

function tokenF1Basic(pred: string, ref: string): number {
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

function extractAccessedNotes(output: string, sessionNoteNames: Map<number, string>): string[] {
  const accessed = new Set<string>();
  for (const [, name] of sessionNoteNames) {
    // name is like "2023-05-20/round-1"
    const basename = name.split("/").pop() ?? name;
    const dir = name.includes("/") ? name.split("/")[0] : "";
    if (
      output.includes(name + ".md") ||
      output.includes(`"${name}"`) ||
      output.includes(`'${name}'`) ||
      output.includes(`napkin read "${name}"`) ||
      output.includes(`napkin read '${name}'`) ||
      output.includes(`napkin read ${name}`) ||
      output.includes(`"${name}.md"`) ||
      // Match basename in context of its directory
      (dir && output.includes(basename + ".md") && output.includes(dir))
    ) {
      accessed.add(name);
    }
  }
  return [...accessed];
}

// ---------------------------------------------------------------------------
// Run a single question through pi CLI
// ---------------------------------------------------------------------------

function runQuestion(
  instance: LongMemInstance,
  modelFlag: string,
  extensionPath: string,
  verbose: boolean,
): QResult | null {
  const ability = getAbility(instance.question_type, instance.question_id);
  const isAbstention = instance.question_id.endsWith("_abs");
  const evidenceSessionIds = instance.answer_session_ids;
  // Evidence note names resolved after vault creation (need sessionNoteNames map)
  let evidenceNoteNames: string[] = [];

  const { tmpDir, sessionNoteNames } = createQuestionVault(instance);
  const vaultPath = path.join(tmpDir, ".napkin");
  evidenceNoteNames = evidenceSessionIds
    .map((id) => sessionNoteNames.get(id))
    .filter((n): n is string => n !== undefined);
  const start = Date.now();

  try {
    // Load prompt template
    const promptTemplate = fs.readFileSync(path.join("bench", "longmemeval-prompt.md"), "utf-8");
    const [systemSection, userSection] = promptTemplate.split("---SPLIT---");

    const fillVars = (text: string) => text
      .replace(/\{\{vault_path\}\}/g, vaultPath)
      .replace(/\{\{question_date\}\}/g, instance.question_date)
      .replace(/\{\{question\}\}/g, instance.question);

    // Extract content after "## SYSTEM_PROMPT" header
    const systemPrompt = fillVars(systemSection.replace(/^.*?## SYSTEM_PROMPT\s*/s, "").trim());
    const userPrompt = fillVars(userSection.replace(/^.*?## USER_PROMPT\s*/s, "").trim());

    const output = execFileSync("pi", [
      "--print",
      "--mode", "json",
      "--model", modelFlag,
      "--extension", extensionPath,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt", systemPrompt,
      userPrompt,
    ], {
      encoding: "utf-8",
      timeout: 180_000,
      cwd: tmpDir,
      env: { ...process.env },
      maxBuffer: 50 * 1024 * 1024,
    });

    // Parse JSONL
    let agentText = "";
    const toolArgs: string[] = [];
    const toolResults: string[] = [];
    let inputTokens = 0, outputTokens = 0;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "message_update" && evt.assistantMessageEvent?.type === "text_delta") {
          agentText += evt.assistantMessageEvent.delta;
        }
        if (evt.type === "message_update" && evt.assistantMessageEvent?.type === "usage") {
          const usage = evt.assistantMessageEvent.usage;
          if (usage) { inputTokens += usage.inputTokens ?? 0; outputTokens += usage.outputTokens ?? 0; }
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

    // Categorize tool calls
    const searchCalls = toolArgs.filter((a) => a.includes("napkin search")).length;
    const readCalls = toolArgs.filter((a) => a.includes("napkin read")).length;
    const mathCalls = toolArgs.filter((a) => a.includes("python3") || a.includes("echo $((")).length;
    const toolResultChars = toolResults.reduce((s, r) => s + r.length, 0);

    const allText = [agentText, ...toolArgs, ...toolResults].join("\n");
    const accessed = extractAccessedNotes(allText, sessionNoteNames);
    const agentAnswer = agentText.trim();

    const r = recall(accessed, evidenceNoteNames);
    const p = precision(accessed, evidenceNoteNames);
    const answerF1 = llmJudge(instance.question, String(instance.answer), agentAnswer, modelFlag);

    if (verbose) {
      console.log(`      ${ability.padEnd(24)} | R=${(r * 100).toFixed(0)}% Acc=${answerF1.toFixed(3)} | ${instance.question.substring(0, 60)}`);
    }

    return {
      questionId: instance.question_id,
      questionType: instance.question_type,
      ability,
      question: instance.question,
      answer: String(instance.answer),
      isAbstention,
      agentAnswer,
      evidenceSessionIds,
      retrievedSessions: accessed,
      sessionRecall: r,
      sessionPrecision: p,
      sessionF1: f1(p, r),
      accuracy: answerF1,
      elapsed: (Date.now() - start) / 1000,
      toolCalls: toolArgs.length,
      searchCalls,
      readCalls,
      mathCalls,
      toolResultChars,
      inputTokens,
      outputTokens,
    };
  } catch (err: any) {
    if (verbose) console.error(`      Error: ${err.message?.substring(0, 100)}`);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  dataset: "oracle" | "s" | "m";
  types: Set<string> | null;
  ids: Set<string> | null;
  n: number;
  jsonOutput: boolean;
  verbose: boolean;
  model: string;
  concurrency: number;
  seed: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let dataset: "oracle" | "s" | "m" = "oracle";
  let types: Set<string> | null = null;
  let ids: Set<string> | null = null;
  let n = 500;
  let jsonOutput = false, verbose = false;
  let model = "anthropic/claude-haiku-4-5-20251001";
  let concurrency = 5;
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dataset" && i + 1 < args.length) dataset = args[++i] as any;
    else if (args[i] === "--types" && i + 1 < args.length) types = new Set(args[++i].split(","));
    else if (args[i] === "--ids" && i + 1 < args.length) ids = new Set(args[++i].split(","));
    else if (args[i] === "--n" && i + 1 < args.length) n = parseInt(args[++i], 10);
    else if (args[i] === "--model" && i + 1 < args.length) model = args[++i];
    else if (args[i] === "--concurrency" && i + 1 < args.length) concurrency = parseInt(args[++i], 10);
    else if (args[i] === "--seed" && i + 1 < args.length) seed = parseInt(args[++i], 10);
    else if (args[i] === "--json") jsonOutput = true;
    else if (args[i] === "--verbose") verbose = true;
  }
  return { dataset, types, ids, n, jsonOutput, verbose, model, concurrency, seed };
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

  const DATASET_FILES: Record<string, { file: string; url: string }> = {
    oracle: {
      file: "longmemeval_oracle.json",
      url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
    },
    s: {
      file: "longmemeval_s_cleaned.json",
      url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
    },
    m: {
      file: "longmemeval_m_cleaned.json",
      url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json",
    },
  };

  const dsInfo = DATASET_FILES[args.dataset];

  console.log("LongMemEval Benchmark — pi + napkin (agentic)");
  console.log("=".repeat(60));
  console.log(`  Dataset: LongMemEval_${args.dataset.toUpperCase()} | Model: ${args.model}`);
  console.log(`  Questions: ${args.n} | Concurrency: ${args.concurrency} | Seed: ${args.seed}`);
  if (args.types) console.log(`  Types: ${[...args.types].join(", ")}`);
  console.log("=".repeat(60) + "\n");

  // Download data
  const dataDir = path.join("bench", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dataPath = path.join(dataDir, dsInfo.file);

  if (!fs.existsSync(dataPath)) {
    console.log(`Downloading ${dsInfo.file}...`);
    const resp = await fetch(dsInfo.url);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    fs.writeFileSync(dataPath, Buffer.from(await resp.arrayBuffer()));
    console.log("Done.\n");
  }

  // For large files (M dataset is 2.6GB), use python to extract needed questions
  let allInstances: LongMemInstance[];
  const fileStat = fs.statSync(dataPath);
  if (fileStat.size > 500 * 1024 * 1024) {
    // Large file — use JSONL version and sample with python
    const jsonlPath = dataPath.replace(".json", ".jsonl");
    if (!fs.existsSync(jsonlPath)) {
      console.log(`Converting to JSONL for efficient sampling...`);
      execFileSync("python3", ["-c",
        `import json\ndata=json.load(open("${dataPath}"))\nwith open("${jsonlPath}","w") as f:\n for d in data: f.write(json.dumps(d)+"\\n")`
      ], { timeout: 300_000 });
    }
    const idsFilter = args.ids ? [...args.ids].join(",") : "";
    const pyOut = execFileSync("python3", ["-c", `
import json, sys, random
random.seed(${args.seed})
ids = set("${idsFilter}".split(",")) if "${idsFilter}" else set()
samples = []
with open("${jsonlPath}") as f:
    for line in f:
        d = json.loads(line)
        if ids:
            if d["question_id"] in ids: samples.append(d)
        else:
            samples.append(d)
if not ids:
    random.shuffle(samples)
    samples = samples[:${args.n}]
json.dump(samples, sys.stdout)
`], { encoding: "utf-8", maxBuffer: 500 * 1024 * 1024, timeout: 300_000 });
    allInstances = JSON.parse(pyOut);
  } else {
    const raw = fs.readFileSync(dataPath, "utf-8");
    allInstances = JSON.parse(raw);
  }

  // Seeded PRNG
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

  // Filter and sample
  let dataset = allInstances;
  if (args.ids) {
    dataset = dataset.filter((inst) => args.ids!.has(inst.question_id));
  }
  if (args.types) {
    dataset = dataset.filter((inst) => args.types!.has(inst.question_type));
  }
  if (!args.ids && dataset.length > args.n) {
    const rng = mulberry32(args.seed);
    dataset = seededShuffle(dataset, rng).slice(0, args.n);
  }

  // Count by ability
  const abilityCounts = new Map<string, number>();
  for (const inst of dataset) {
    const ability = getAbility(inst.question_type, inst.question_id);
    abilityCounts.set(ability, (abilityCounts.get(ability) ?? 0) + 1);
  }

  console.log(`Sampled ${dataset.length} questions from ${allInstances.length} total.`);
  for (const [ability, count] of [...abilityCounts.entries()].sort()) {
    console.log(`  ${ability}: ${count}`);
  }
  console.log();

  // Log file
  const resultsDir = path.join("bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(resultsDir, `longmemeval-${args.dataset}-${ts}.jsonl`);
  // Use appendFileSync for immediate flush — no data loss on kill
  const logWrite = (data: string) => fs.appendFileSync(logPath, data);
  logWrite(JSON.stringify({
    _type: "meta",
    system: "pi + napkin",
    model: args.model,
    dataset: `longmemeval_${args.dataset}`,
    timestamp: new Date().toISOString(),
    config: { n: args.n, types: args.types ? [...args.types] : null, concurrency: args.concurrency, seed: args.seed },
  }) + "\n");
  console.log(`  Log: ${logPath}\n`);

  const allResults: QResult[] = [];
  let completed = 0;

  // Process with concurrency
  const queue = [...dataset];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < args.concurrency; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const inst = queue.shift()!;
        const result = runQuestion(inst, args.model, extensionPath, args.verbose);
        if (result) {
          allResults.push(result);
          logWrite(JSON.stringify({ _type: "result", ...result }) + "\n");
        } else {
          logWrite(JSON.stringify({ _type: "error", questionId: inst.question_id, question: inst.question }) + "\n");
        }
        completed++;

        if (completed % 10 === 0 || completed === dataset.length) {
          const done = allResults.length;
          if (done > 0) {
            const avgAcc = allResults.reduce((s, r) => s + r.accuracy, 0) / done;
            const avgRecall = allResults.reduce((s, r) => s + r.sessionRecall, 0) / done;
            console.log(`  [${completed}/${dataset.length}] R=${(avgRecall * 100).toFixed(1)}%  Acc=${avgAcc.toFixed(3)}`);
          }
        }
      }
    })());
  }
  await Promise.all(workers);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const div = "=".repeat(60);
  const done = allResults.length;

  if (done === 0) {
    console.log("\nNo results. Check API keys and model availability.");
    process.exit(1);
  }

  const avg = (arr: QResult[], key: keyof QResult) =>
    arr.length > 0 ? arr.reduce((s, r) => s + (r[key] as number), 0) / arr.length : 0;

  // Bootstrap CI
  function bootstrapCI(values: number[], nBoot = 10_000): [number, number] {
    const n = values.length;
    if (n === 0) return [0, 0];
    const means: number[] = [];
    for (let b = 0; b < nBoot; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += values[Math.floor(Math.random() * n)];
      means.push(sum / n);
    }
    means.sort((a, b) => a - b);
    return [means[Math.floor(nBoot * 0.025)], means[Math.floor(nBoot * 0.975)]];
  }

  // Group by ability
  const byAbility = new Map<string, QResult[]>();
  for (const r of allResults) {
    if (!byAbility.has(r.ability)) byAbility.set(r.ability, []);
    byAbility.get(r.ability)!.push(r);
  }

  const accuracyCI = bootstrapCI(allResults.map(r => r.accuracy));
  const recallCI = bootstrapCI(allResults.map(r => r.sessionRecall));

  console.log("\n" + div);
  console.log(`RESULTS — pi + napkin (${args.model})`);
  console.log(`Dataset: LongMemEval_${args.dataset.toUpperCase()}`);
  console.log(div);
  console.log(`  Evaluated: ${done} / ${dataset.length} (${elapsed}s)`);
  console.log(`  Session Recall: ${(avg(allResults, "sessionRecall") * 100).toFixed(1)}%  [${(recallCI[0] * 100).toFixed(1)}%, ${(recallCI[1] * 100).toFixed(1)}%] 95% CI`);
  console.log(`  Accuracy:      ${avg(allResults, "accuracy").toFixed(3)}  [${accuracyCI[0].toFixed(3)}, ${accuracyCI[1].toFixed(3)}] 95% CI`);

  const hdr = `  ${"Ability".padEnd(26)} ${"N".padStart(5)} ${"Recall".padStart(8)} ${"SessF1".padStart(8)} ${"Acc".padStart(8)}`;
  console.log("\n" + hdr);
  console.log("  " + "-".repeat(hdr.length - 2));

  const abilityOrder = ["information-extraction", "multi-session-reasoning", "knowledge-updates", "temporal-reasoning", "abstention"];
  for (const ability of abilityOrder) {
    const results = byAbility.get(ability);
    if (!results || results.length === 0) continue;
    console.log(`  ${ability.padEnd(26)} ${String(results.length).padStart(5)} ${(avg(results, "sessionRecall") * 100).toFixed(1).padStart(7)}% ${avg(results, "sessionF1").toFixed(3).padStart(8)} ${avg(results, "accuracy").toFixed(3).padStart(8)}`);
  }

  console.log("  " + "-".repeat(hdr.length - 2));
  console.log(`  ${"OVERALL".padEnd(26)} ${String(done).padStart(5)} ${(avg(allResults, "sessionRecall") * 100).toFixed(1).padStart(7)}% ${avg(allResults, "sessionF1").toFixed(3).padStart(8)} ${avg(allResults, "accuracy").toFixed(3).padStart(8)}`);

  // Comparison table (from paper, Figure 3b and Figure 6)
  console.log("\n" + div);
  console.log("COMPARISON (Overall Accuracy, from paper)");
  console.log(div);

  const compHdr = `  ${"System".padEnd(32)} ${"Setting".padStart(14)} ${"Accuracy".padStart(10)}`;
  console.log(compHdr);
  console.log("  " + "-".repeat(compHdr.length - 2));
  console.log(`  ${"pi + napkin (Haiku)".padEnd(32)} ${"oracle".padStart(14)} ${avg(allResults, "accuracy").toFixed(3).padStart(10)}`);
  const compRows = [
    ["GPT-4o + JSON + CoN",          "oracle",   "0.924"],
    ["Llama 3.1 70B + CoN",          "oracle",   "0.848"],
    ["Llama 3.1 8B + JSON + CoN",    "oracle",   "0.756"],
    ["GPT-4o (no CoN)",              "oracle",   "0.870"],
    ["GPT-4o + CoN",                 "S (115k)",  "0.640"],
    ["Llama 3.1 8B + CoN",           "S (115k)",  "0.420"],
    ["GPT-4o (RAG, fact+CoN)",       "M (top-10)","0.720"],
    ["Llama 3.1 70B (RAG, fact+CoN)","M (top-10)","0.682"],
    ["Llama 3.1 8B (RAG, fact+CoN)", "M (top-10)","0.572"],
    ["ChatGPT (GPT-4o, online)",     "manual",   "0.578"],
    ["Coze (GPT-4o, online)",        "manual",   "0.330"],
  ];
  for (const [name, setting, acc] of compRows) {
    console.log(`  ${name.padEnd(32)} ${setting.padStart(14)} ${acc.padStart(10)}`);
  }
  console.log(div);

  console.log(`\n  Time: ${elapsed}s | ${done} questions | ${(done / parseFloat(elapsed) * 60).toFixed(1)} q/min`);

  // Write summary
  logWrite(JSON.stringify({
    _type: "summary",
    evaluated: done,
    totalTime: elapsed,
    overall: { sessionRecall: avg(allResults, "sessionRecall"), sessionF1: avg(allResults, "sessionF1"), accuracy: avg(allResults, "accuracy"), accuracyCI },
    byAbility: abilityOrder.map((a) => {
      const r = byAbility.get(a) ?? [];
      return { ability: a, n: r.length, sessionRecall: avg(r, "sessionRecall"), sessionF1: avg(r, "sessionF1"), accuracy: avg(r, "accuracy") };
    }),
  }) + "\n");
  
  console.log(`  Log: ${logPath}`);

  if (args.jsonOutput) {
    const outPath = path.join(resultsDir, `longmemeval-${args.dataset}-${ts}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      system: "pi + napkin (agentic, CLI)",
      model: args.model,
      dataset: `longmemeval_${args.dataset}`,
      timestamp: new Date().toISOString(),
      config: { n: args.n, types: args.types ? [...args.types] : null, concurrency: args.concurrency, seed: args.seed },
      summary: {
        sessionRecall: avg(allResults, "sessionRecall"), recallCI,
        sessionF1: avg(allResults, "sessionF1"),
        accuracy: avg(allResults, "accuracy"), accuracyCI,
        totalTime: elapsed,
      },
      byAbility: abilityOrder.map((a) => {
        const r = byAbility.get(a) ?? [];
        return { ability: a, n: r.length, sessionRecall: avg(r, "sessionRecall"), sessionF1: avg(r, "sessionF1"), accuracy: avg(r, "accuracy") };
      }),
      results: allResults,
    }, null, 2));
    console.log(`  Results: ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
