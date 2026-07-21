import { describe, expect, test } from "bun:test";
import { createTempVault } from "../utils/test-helpers.js";
import { overview } from "./overview.js";

async function runOverviewJson(
  vault: string,
  opts: Partial<Parameters<typeof overview>[0]> = {},
): Promise<unknown> {
  const captured: unknown[] = [];
  const origLog = console.log;

  try {
    console.log = (...args: unknown[]) => captured.push(...args);
    await overview({
      vault,
      json: true,
      quiet: false,
      copy: false,
      ...opts,
    });
  } finally {
    console.log = origLog;
  }

  return JSON.parse(captured[0] as string);
}

describe("overview", () => {
  test("generates overview for vault with folders", async () => {
    const vault = createTempVault({
      "projects/roadmap.md":
        "---\ntags: [active]\n---\n# Roadmap\nLaunch the product in Q2",
      "projects/design.md": "# Design\nUI mockups and #wireframes",
      "notes/meeting.md": "# Meeting Notes\nDiscussed #hiring timeline",
      "readme.md": "# Welcome\nThis is the vault root",
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; notes: number; tags: string[] }>;
    };
    expect(result.overview).toBeArray();
    expect(result.overview.length).toBeGreaterThanOrEqual(3);

    const projectsFolder = result.overview.find((f) => f.path === "projects");
    expect(projectsFolder).toBeDefined();
    expect(projectsFolder?.notes).toBe(2);
    expect(projectsFolder?.tags).toContain("active");

    vault.cleanup();
  });

  test("respects depth limit", async () => {
    const vault = createTempVault({
      "a/b/c/deep.md": "# Deep note",
      "top.md": "# Top",
    });

    const result = (await runOverviewJson(vault.path, { depth: "1" })) as {
      overview: Array<{ path: string }>;
    };
    const paths = result.overview.map((f) => f.path);
    expect(paths).not.toContain("a/b/c");

    vault.cleanup();
  });

  test("skips files with malformed YAML frontmatter", async () => {
    const vault = createTempVault({
      "notes/good.md": "---\ntags: [valid]\n---\n# Good note\nHello",
      "notes/bad.md":
        "---\ntags: [#foo, #bar]\n---\n# Bad YAML\nBroken frontmatter",
      "notes/also-good.md": "# No frontmatter\nJust content",
    });

    const warnings: string[] = [];
    const captured: unknown[] = [];
    const origLog = console.log;
    const origError = console.error;

    try {
      // Warnings go to stderr so they never corrupt --json output on stdout.
      console.error = (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        if (msg.includes("⚠")) warnings.push(msg);
      };
      console.log = (...args: unknown[]) => {
        captured.push(...args);
      };
      await overview({
        vault: vault.path,
        json: true,
        quiet: false,
        copy: false,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const result = JSON.parse(captured[0] as string) as {
      overview: Array<{ path: string; notes: number }>;
    };
    const notesFolder = result.overview.find((f) => f.path === "notes");
    expect(notesFolder).toBeDefined();
    // bad.md is skipped for keywords/tags but still counted
    expect(notesFolder?.notes).toBe(3);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("bad.md");

    vault.cleanup();
  });

  test("empty vault", async () => {
    const vault = createTempVault({});

    const result = (await runOverviewJson(vault.path)) as {
      overview: unknown[];
    };
    expect(result.overview).toEqual([]);

    vault.cleanup();
  });

  test("excludes scaffold files and folders from overview", async () => {
    const vault = createTempVault({
      "NAPKIN.md": "# Project context\nAlways shown separately as context.",
      "Templates/Decision.md": "# {{title}}\n## Context\n## Decision",
      "decisions/_about.md": "# Decisions\nArchitecture Decision Records.",
      "decisions/postgres.md":
        "# Use PostgreSQL\nPostgreSQL stores ledger entries and merchant balances.",
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; notes: number; keywords: string[] }>;
    };
    const paths = result.overview.map((f) => f.path);
    expect(paths).toEqual(["decisions"]);

    const decisionsFolder = result.overview[0];
    expect(decisionsFolder.notes).toBe(1);
    expect(decisionsFolder.keywords).toContain("postgresql");
    expect(decisionsFolder.keywords).not.toContain("template");
    expect(decisionsFolder.keywords).not.toContain("decisions");

    vault.cleanup();
  });

  test("suppresses repeated structural headings", async () => {
    const vault = createTempVault({
      "decisions/postgres.md": `# Use PostgreSQL
## Context
Ledger writes need transactional storage.
## Decision
Use PostgreSQL for balances.
## Consequences
We operate backups.`,
      "decisions/outbox.md": `# Adopt transactional outbox
## Context
Kafka dual writes lost events.
## Decision
Write outbox events in the database transaction.
## Consequences
Relay latency increases slightly.`,
      "decisions/braintree.md": `# Deprecate Braintree
## Context
Braintree maintenance cost is high.
## Decision
Migrate merchants to Adyen.
## Consequences
Two merchants need migration plans.`,
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; keywords: string[] }>;
    };
    const decisionsFolder = result.overview.find((f) => f.path === "decisions");
    expect(decisionsFolder?.keywords).toContain("postgresql");
    expect(decisionsFolder?.keywords).toContain("outbox");
    expect(decisionsFolder?.keywords).toContain("braintree");
    expect(decisionsFolder?.keywords).not.toContain("context");
    expect(decisionsFolder?.keywords).not.toContain("decision");
    expect(decisionsFolder?.keywords).not.toContain("consequences");

    vault.cleanup();
  });

  test("indexes frontmatter values without exposing folder-name keywords", async () => {
    const vault = createTempVault({
      "people/asha.md":
        "---\nrole: VP Engineering\nlocation: Boston\n---\n# Asha Mehta\nOwns platform strategy.",
      "people/lukas.md":
        "---\nrole: Staff Engineer\nlocation: Berlin\n---\n# Lukas Weber\nOwns fleet dispatch.",
    });

    const result = (await runOverviewJson(vault.path)) as {
      overview: Array<{ path: string; keywords: string[] }>;
    };
    const peopleFolder = result.overview.find((f) => f.path === "people");
    expect(peopleFolder?.keywords).toContain("engineering");
    expect(peopleFolder?.keywords).toContain("boston");
    expect(peopleFolder?.keywords).not.toContain("people");
    expect(peopleFolder?.keywords).not.toContain("person");

    vault.cleanup();
  });
});
