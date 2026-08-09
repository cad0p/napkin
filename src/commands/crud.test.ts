import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "../utils/test-helpers.js";
import { append, create, del, move, prepend, read, rename } from "./crud.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

async function captureJson(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const orig = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  await fn();
  console.log = orig;
  return JSON.parse(logs.join(""));
}

beforeEach(() => {
  v = createTempVault({
    "README.md": "# Vault\nWelcome",
    "Projects/note.md": "---\ntitle: Note\n---\nBody content",
    "Templates/Daily Note.md": "# {{date}}\n\n## Tasks\n",
  });
});

afterEach(() => {
  v.cleanup();
});

describe("read", () => {
  test("reads file content", async () => {
    const data = await captureJson(() =>
      read("README", { json: true, vault: v.path }),
    );
    expect(data.content).toContain("Welcome");
  });
});

describe("create", () => {
  test("creates a new file", async () => {
    const data = await captureJson(() =>
      create({ json: true, vault: v.path, name: "New Note", content: "Hello" }),
    );
    expect(data.created).toBe(true);
    const content = fs.readFileSync(
      path.join(v.vaultPath, "New Note.md"),
      "utf-8",
    );
    expect(content).toBe("Hello");
  });

  test("creates from template", async () => {
    const data = await captureJson(() =>
      create({
        json: true,
        vault: v.path,
        name: "Today",
        template: "Daily Note",
      }),
    );
    expect(data.created).toBe(true);
    const content = fs.readFileSync(
      path.join(v.vaultPath, "Today.md"),
      "utf-8",
    );
    expect(content).toContain("{{date}}");
  });

  test("creates with path in subfolder", async () => {
    await captureJson(() =>
      create({
        json: true,
        vault: v.path,
        path: "Archive/old-note",
        content: "archived",
      }),
    );
    const content = fs.readFileSync(
      path.join(v.vaultPath, "Archive/old-note.md"),
      "utf-8",
    );
    expect(content).toBe("archived");
  });
});

describe("append", () => {
  test("appends content to file", async () => {
    await captureJson(() =>
      append({
        json: true,
        vault: v.path,
        file: "README",
        content: "New line",
      }),
    );
    const content = fs.readFileSync(
      path.join(v.vaultPath, "README.md"),
      "utf-8",
    );
    expect(content).toContain("Welcome\nNew line");
  });

  test("appends inline without newline", async () => {
    await captureJson(() =>
      append({
        json: true,
        vault: v.path,
        file: "README",
        content: " extra",
        inline: true,
      }),
    );
    const content = fs.readFileSync(
      path.join(v.vaultPath, "README.md"),
      "utf-8",
    );
    expect(content).toContain("Welcome extra");
  });
});

describe("prepend", () => {
  test("prepends after frontmatter", async () => {
    await captureJson(() =>
      prepend({
        json: true,
        vault: v.path,
        file: "Projects/note.md",
        content: "Prepended",
      }),
    );
    const content = fs.readFileSync(
      path.join(v.vaultPath, "Projects/note.md"),
      "utf-8",
    );
    expect(content).toContain("title: Note");
    // Prepended should come before Body content
    const prependIdx = content.indexOf("Prepended");
    const bodyIdx = content.indexOf("Body content");
    expect(prependIdx).toBeLessThan(bodyIdx);
  });
});

describe("move", () => {
  test("moves file to new folder", async () => {
    await captureJson(() =>
      move({ json: true, vault: v.path, file: "README", to: "Archive" }),
    );
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.vaultPath, "Archive/README.md"))).toBe(
      true,
    );
  });
});

describe("rename", () => {
  test("renames a file", async () => {
    await captureJson(() =>
      rename({ json: true, vault: v.path, file: "README", name: "INDEX" }),
    );
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.vaultPath, "INDEX.md"))).toBe(true);
  });
});

describe("delete", () => {
  test("moves file to .trash by default", async () => {
    await captureJson(() => del({ json: true, vault: v.path, file: "README" }));
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.vaultPath, ".trash/README.md"))).toBe(
      true,
    );
  });

  test("permanently deletes with --permanent", async () => {
    await captureJson(() =>
      del({ json: true, vault: v.path, file: "README", permanent: true }),
    );
    expect(fs.existsSync(path.join(v.vaultPath, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.vaultPath, ".trash/README.md"))).toBe(
      false,
    );
  });
});
