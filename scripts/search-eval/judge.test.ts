import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { QueryRecord } from "./harness.js";
import {
  bootstrapNetWinRate,
  combineSides,
  exactTitleLosses,
  mapVerdict,
  normalizeTitle,
  noteExcerpt,
  noteTitle,
  parseJudgeVerdict,
  parsePiJsonOutput,
  type QueryOutcome,
  runJudge,
  signTestPValue,
  stripFrontmatter,
  summariseJudge,
  topKDiffers,
} from "./judge.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDir = path.join(repoRoot, "scripts/fixtures/search-eval");
const fixtureVault = path.join(fixtureDir, "vault");
const fixtureQueries = path.join(fixtureDir, "queries.txt");

let dir: string;
let vault: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-judge-"));
  vault = path.join(dir, "vault");
  fs.cpSync(fixtureVault, vault, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(query: string, files: string[]): QueryRecord {
  return {
    query,
    latencyMs: 1,
    results: files.map((file, i) => ({ file, score: 10 - i })),
  };
}

/** A deterministic fake judge: prefers the list whose first hit sorts first. */
function fakeJudge(): string {
  const file = path.join(dir, "fake-judge.mjs");
  fs.writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      'let input = "";',
      'process.stdin.on("data", (c) => (input += c));',
      'process.stdin.on("end", () => {',
      "  const lines = input.split(String.fromCharCode(10));",
      "  const first = (label) => {",
      '    const i = lines.indexOf("List " + label + ":");',
      '    const line = i >= 0 && i + 1 < lines.length ? lines[i + 1] : "";',
      "    return line.replace(/^[0-9]+[.] /, '');",
      "  };",
      '  const a = first("A");',
      '  const b = first("B");',
      '  const winner = a === "" ? "B" : b === "" ? "A" : a <= b ? "A" : "B";',
      '  process.stdout.write(JSON.stringify({ winner, reason: "first hit sorts first" }));',
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

/** A fake judge that never answers parseably. */
function junkJudge(): string {
  const file = path.join(dir, "junk-judge.mjs");
  fs.writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      'process.stdout.write("I refuse to answer in JSON");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

describe("verdict parsing", () => {
  test("parses clean JSON", () => {
    expect(parseJudgeVerdict('{"winner":"A","reason":"better"}')).toEqual({
      winner: "A",
      reason: "better",
    });
  });

  test("parses fenced JSON with prose around it", () => {
    const raw =
      'Here is my answer:\n```json\n{"winner":"B","reason":"more relevant"}\n```\nHope that helps.';
    expect(parseJudgeVerdict(raw)).toEqual({
      winner: "B",
      reason: "more relevant",
    });
  });

  test("parses a bare object embedded in prose and lowercases the winner", () => {
    expect(
      parseJudgeVerdict('The verdict is {"winner":"a","reason":"x"} done'),
    ).toEqual({ winner: "A", reason: "x" });
  });

  test("returns null on junk and on invalid winners", () => {
    expect(parseJudgeVerdict("no json here")).toBeNull();
    expect(parseJudgeVerdict('{"winner":"C","reason":"x"}')).toBeNull();
    expect(parseJudgeVerdict('{"reason":"x"}')).toBeNull();
  });

  test("missing reason becomes an empty string", () => {
    expect(parseJudgeVerdict('{"winner":"tie"}')).toEqual({
      winner: "tie",
      reason: "",
    });
  });
});

describe("pi JSON output parsing", () => {
  test("extracts assistant text and usage from message_end events", () => {
    const stdout = [
      '{"type":"session","id":"x"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer text"}],"usage":{"input":10,"output":5,"totalTokens":15}}}',
      '{"type":"agent_end"}',
    ].join("\n");
    expect(parsePiJsonOutput(stdout)).toEqual({
      text: "answer text",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      error: null,
    });
  });

  test("returns null when stdout is not pi JSONL", () => {
    expect(parsePiJsonOutput('{"winner":"A","reason":"x"}')).toBeNull();
  });
});

describe("swap mapping", () => {
  test("maps A/B back to the side that held each list", () => {
    expect(mapVerdict({ winner: "A", reason: "" }, true)).toBe("baseline");
    expect(mapVerdict({ winner: "B", reason: "" }, true)).toBe("candidate");
    expect(mapVerdict({ winner: "A", reason: "" }, false)).toBe("candidate");
    expect(mapVerdict({ winner: "B", reason: "" }, false)).toBe("baseline");
    expect(mapVerdict({ winner: "tie", reason: "" }, true)).toBe("tie");
  });

  test("agreement decides, disagreement ties", () => {
    expect(combineSides("candidate", "candidate")).toBe("win");
    expect(combineSides("baseline", "baseline")).toBe("loss");
    expect(combineSides("candidate", "baseline")).toBe("tie");
    expect(combineSides("candidate", "tie")).toBe("tie");
    expect(combineSides("tie", "tie")).toBe("tie");
  });
});

describe("statistics", () => {
  test("bootstrap CI is deterministic for a seed", () => {
    const outcomes: QueryOutcome[] = [
      "win",
      "win",
      "loss",
      "tie",
      "win",
      "loss",
      "tie",
      "error",
    ];
    const a = bootstrapNetWinRate(outcomes, 42);
    const b = bootstrapNetWinRate(outcomes, 42);
    expect(a).toEqual(b);
    expect(a[0]).toBeLessThanOrEqual(0);
    expect(a[1]).toBeGreaterThanOrEqual(0);
    // All wins: the CI collapses to 1; errors never enter N.
    expect(bootstrapNetWinRate(["win", "win", "error"], 1)).toEqual([1, 1]);
    expect(bootstrapNetWinRate([], 1)).toEqual([0, 0]);
  });

  test("sign test is symmetric and one-sided extremes are tiny", () => {
    expect(signTestPValue(5, 5)).toBe(signTestPValue(5, 5));
    expect(signTestPValue(10, 0)).toBeCloseTo(2 / 1024, 5);
    expect(signTestPValue(0, 0)).toBe(1);
    expect(signTestPValue(3, 7)).toBe(signTestPValue(7, 3));
    expect(signTestPValue(5, 4)).toBe(1);
  });

  test("normalizeTitle folds case, spaces/underscores and .md", () => {
    expect(normalizeTitle("  My Note.md ")).toBe("my-note");
    expect(normalizeTitle("my_note")).toBe("my-note");
    expect(normalizeTitle("MY-NOTE")).toBe("my-note");
  });
});

describe("pass rule", () => {
  const judged = (outcomes: QueryOutcome[]) =>
    outcomes.map((outcome, i) => ({
      query: `q${i}`,
      outcome,
      sides: [null, null] as [null, null],
      reasons: ["", ""] as [string, string],
      baselineTop: [],
      candidateTop: [],
      missingFromCandidate: [],
    }));

  test("wins >= losses with a safe CI and no exact-title loss passes", () => {
    const many = judged([
      "win",
      "win",
      "win",
      "win",
      "win",
      "win",
      "win",
      "win",
    ]);
    const summary = summariseJudge(10, 2, many, [], 1);
    expect(summary.pass).toBe(true);
    expect(summary.wins).toBe(8);
    expect(summary.judged).toBe(8);
  });

  test("more losses than wins fails", () => {
    const summary = summariseJudge(
      2,
      0,
      judged(["loss", "loss", "loss", "win"]),
      [],
      1,
    );
    expect(summary.pass).toBe(false);
    expect(summary.passReasons.join(" ")).toContain("loses");
  });

  test("an exact-title loss fails regardless of judge verdicts", () => {
    const baseline = [
      record("alpha marker", ["notes/alpha-marker.md", "x.md"]),
    ];
    const candidate = [record("alpha marker", ["x.md", "y.md"])];
    const losses = exactTitleLosses(baseline, candidate, 10);
    expect(losses).toEqual([
      { query: "alpha marker", file: "notes/alpha-marker.md" },
    ]);
    const summary = summariseJudge(1, 0, judged(["win", "win"]), losses, 1);
    expect(summary.pass).toBe(false);
    expect(summary.passReasons.join(" ")).toContain("exact-title");
  });

  test("exact-title match is normalization-insensitive", () => {
    const baseline = [record("Alpha Marker", ["notes/alpha-marker.md"])];
    const kept = [record("Alpha Marker", ["z.md", "notes/alpha-marker.md"])];
    expect(exactTitleLosses(baseline, kept, 10)).toEqual([]);
  });
});

describe("note presentation", () => {
  test("stripFrontmatter removes a leading block only", () => {
    expect(stripFrontmatter("---\ntags: [x]\n---\nbody")).toBe("body");
    expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
  });

  test("title is the first H1 else the basename", () => {
    expect(noteTitle("# Alpha\nbody", "a/b.md")).toBe("Alpha");
    expect(noteTitle("---\nx: 1\n---\n# Beta\nbody", "a/b.md")).toBe("Beta");
    expect(noteTitle("no heading", "a/b-c.md")).toBe("b-c");
  });

  test("excerpt centres on the first query-term line else the body head", () => {
    const content = "intro\nsome cache note\nmore lines\ntail";
    expect(noteExcerpt(content, "cache invalidation")).toContain("cache note");
    const fallback = noteExcerpt("x".repeat(500), "zzz missing");
    expect(fallback.length).toBeLessThanOrEqual(300);
  });
});

describe("runJudge with a fake judge", () => {
  const opts = (cmd: string) => ({
    judgeCmd: cmd,
    model: "fake/model",
    concurrency: 2,
    timeoutMs: 10_000,
    cacheDir: path.join(dir, "cache"),
    k: 10,
    vaultRoot: vault,
  });

  test("identical top-k lists skip the judge entirely", async () => {
    const baseline = [record("q1", ["a.md", "b.md"]), record("q2", ["c.md"])];
    const result = await runJudge(baseline, baseline, opts(fakeJudge()));
    expect(result.identicalCount).toBe(2);
    expect(result.judged).toHaveLength(0);
    expect(result.usage.calls).toBe(0);
  });

  test("a differing query is judged twice with the swap mapped back", async () => {
    const baseline = [
      record("q1", ["b.md", "c.md"]),
      record("q2", ["same.md"]),
    ];
    // Candidate drops everything for q1: the fake prefers the non-empty list.
    const candidate = [record("q1", []), record("q2", ["same.md"])];
    const result = await runJudge(baseline, candidate, opts(fakeJudge()));
    expect(result.identicalCount).toBe(1);
    expect(result.judged).toHaveLength(1);
    expect(result.judged[0].outcome).toBe("loss");
    expect(result.judged[0].sides).toEqual(["baseline", "baseline"]);
    expect(result.usage.calls).toBe(2);
    expect(result.judged[0].missingFromCandidate).toEqual(["b.md", "c.md"]);
  });

  test("verdicts are cached: a second run pays for nothing", async () => {
    const baseline = [record("q1", ["b.md"])];
    const candidate = [record("q1", [])];
    const cache = opts(fakeJudge());
    const first = await runJudge(baseline, candidate, cache);
    expect(first.usage.calls).toBe(2);
    expect(first.usage.cacheHits).toBe(0);
    const second = await runJudge(baseline, candidate, cache);
    expect(second.usage.calls).toBe(0);
    expect(second.usage.cacheHits).toBe(2);
    expect(second.judged[0].outcome).toBe("loss");
  });

  test("unparseable output retries once then records an error", async () => {
    const baseline = [record("q1", ["b.md"])];
    const candidate = [record("q1", [])];
    const result = await runJudge(baseline, candidate, opts(junkJudge()));
    expect(result.judged[0].outcome).toBe("error");
    expect(result.usage.errors).toBe(1);
    expect(result.usage.calls).toBe(4); // 2 orientations x 1 retry
    const summary = summariseJudge(1, 0, result.judged, [], 1);
    expect(summary.judged).toBe(0); // errors excluded
  });

  test("topKDiffers compares ordered top-k only", () => {
    const a = record("q", ["a.md", "b.md", "c.md"]);
    const same = record("q", ["a.md", "b.md", "different.md"]);
    expect(topKDiffers(a, same, 2)).toBe(false);
    expect(topKDiffers(a, same, 3)).toBe(true);
    expect(topKDiffers(a, undefined, 10)).toBe(true);
  });
});

describe("CLI judge mode end-to-end", () => {
  const cli = path.join(repoRoot, "scripts/search-eval/cli.ts");

  function run(args: string[]): { status: number; output: string } {
    try {
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", cli, ...args],
        { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" },
      );
      return { status: 0, output };
    } catch (error) {
      const failure = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        status: failure.status ?? -1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  test(
    "judge mode compares two recordings and exits on the pass rule",
    () => {
      const baselinePath = path.join(dir, "baseline.json");
      const recordRun = run([
        "--vault",
        vault,
        "--queries",
        fixtureQueries,
        "--record",
        baselinePath,
      ]);
      expect(recordRun.status).toBe(0);

      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as {
        queries: Array<{ query: string; results: Array<{ file: string }> }>;
      };

      // PASS case: swap the top-2 for queries whose second hit sorts before
      // the first — the fake then prefers the candidate, and no file leaves
      // the top-k (no eviction, no exact-title risk).
      const winning = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
      let winCount = 0;
      for (const q of winning.queries) {
        if (
          q.results.length >= 2 &&
          q.results[1].file < q.results[0].file &&
          winCount < 4
        ) {
          [q.results[0], q.results[1]] = [q.results[1], q.results[0]];
          winCount++;
        }
      }
      expect(winCount).toBeGreaterThan(0);
      const winningPath = path.join(dir, "winning.json");
      fs.writeFileSync(winningPath, JSON.stringify(winning));

      const judge = fakeJudge();
      const pass = run([
        "--vault",
        vault,
        "--compare",
        baselinePath,
        "--candidate",
        winningPath,
        "--mode",
        "judge",
        "--judge-model",
        "fake/model",
        "--judge-cmd",
        judge,
        "--judge-cache",
        path.join(dir, "jcache"),
        "--judge-json",
        path.join(dir, "judge.json"),
      ]);
      expect(pass.status).toBe(0);
      expect(pass.output).toContain(`${winCount}W/0T/0L`);
      expect(pass.output).toContain("PASS");
      const json = JSON.parse(
        fs.readFileSync(path.join(dir, "judge.json"), "utf-8"),
      ) as { summary: { pass: boolean; wins: number } };
      expect(json.summary.pass).toBe(true);
      expect(json.summary.wins).toBe(winCount);

      // FAIL case: empty the candidate list for one query.
      const losing = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
      losing.queries[0].results = [];
      const losingPath = path.join(dir, "losing.json");
      fs.writeFileSync(losingPath, JSON.stringify(losing));

      const fail = run([
        "--vault",
        vault,
        "--compare",
        baselinePath,
        "--candidate",
        losingPath,
        "--mode",
        "judge",
        "--judge-model",
        "fake/model",
        "--judge-cmd",
        judge,
        "--judge-cache",
        path.join(dir, "jcache2"),
      ]);
      expect(fail.status).toBe(1);
      expect(fail.output).toContain("0W/0T/1L");
      expect(fail.output).toContain("FAIL");
    },
    { timeout: 60_000 },
  );

  test(
    "judge mode can run the candidate live against the vault",
    () => {
      const baselinePath = path.join(dir, "live-baseline.json");
      expect(
        run([
          "--vault",
          vault,
          "--queries",
          fixtureQueries,
          "--record",
          baselinePath,
        ]).status,
      ).toBe(0);

      // Empty the top hit for a couple of queries: the live run disagrees.
      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as {
        queries: Array<{ query: string; results: Array<{ file: string }> }>;
      };
      let emptied = 0;
      for (const q of baseline.queries) {
        if (q.results.length >= 2 && emptied < 2) {
          q.results = q.results.slice(1);
          emptied++;
        }
      }
      expect(emptied).toBe(2);
      fs.writeFileSync(baselinePath, JSON.stringify(baseline));

      const live = run([
        "--vault",
        vault,
        "--compare",
        baselinePath,
        "--mode",
        "judge",
        "--judge-model",
        "fake/model",
        "--judge-cmd",
        fakeJudge(),
        "--judge-cache",
        path.join(dir, "live-cache"),
      ]);
      expect(live.output).toContain("candidate: live run");
      expect(live.output).toContain("2 differing queries");
      // The exact W/L split depends on the fixture ranking; what matters is
      // that the live path judged both and the wide n=2 CI kept it a FAIL.
      expect(live.output).toMatch(/[0-9]W\/[0-9]T\/[0-9]L/);
      expect(live.status).toBe(1);
    },
    { timeout: 60_000 },
  );
});
