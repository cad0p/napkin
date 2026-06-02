import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTempVault } from "../utils/test-helpers.js";
import { readFile } from "./crud.js";

let v: { path: string; vaultPath: string; cleanup: () => void };

afterEach(() => {
  v.cleanup();
});

describe("readFile with section support", () => {
  beforeEach(() => {
    v = createTempVault({
      "sectioned.md": [
        "# Title",
        "",
        "## Introduction",
        "Some intro text.",
        "",
        "## Methods",
        "Method details here.",
        "",
        "### Step 1",
        "First step.",
        "",
        "### Step 2",
        "Second step.",
        "",
        "## Results",
        "Final results.",
      ].join("\n"),
    });
  });

  test("reads entire file without options", () => {
    const result = readFile(v.vaultPath, "sectioned.md");
    expect(result.content).toContain("# Title");
    expect(result.content).toContain("## Results");
    expect(result.totalPages).toBeUndefined();
    expect(result.currentPage).toBeUndefined();
  });

  test("extracts a section by heading", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Methods",
    });
    expect(result.content).toContain("## Methods");
    expect(result.content).toContain("### Step 1");
    expect(result.content).toContain("### Step 2");
  });

  test("extracts a nested subsection", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Step 1",
    });
    expect(result.content).toBe("### Step 1\nFirst step.\n");
  });

  test("throws on missing section", () => {
    expect(() =>
      readFile(v.vaultPath, "sectioned.md", { section: "Nonexistent" }),
    ).toThrow('Heading "Nonexistent" not found');
  });

  test("does not paginate when content fits pageSize", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Introduction",
      pageSize: 1000,
    });
    expect(result.totalPages).toBeUndefined();
    expect(result.currentPage).toBeUndefined();
  });

  test("paginates content exceeding pageSize", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
    });
    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.currentPage).toBe(1);
    expect(result.content).toContain("[Page 1 of");
    expect(result.content).toContain("Use --page 2 to continue.]");
  });

  test("returns second page when requested", () => {
    const page1 = readFile(v.vaultPath, "sectioned.md", { pageSize: 50 });
    const page2 = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
      page: 2,
    });
    expect(page2.currentPage).toBe(2);
    expect(page2.content).not.toBe(page1.content);
  });

  test("paginates within section content", () => {
    const result = readFile(v.vaultPath, "sectioned.md", {
      section: "Methods",
      pageSize: 20,
    });
    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.currentPage).toBe(1);
  });

  test("last page does not include continuation hint", () => {
    const result = readFile(v.vaultPath, "sectioned.md", { pageSize: 50 });
    const lastPage = readFile(v.vaultPath, "sectioned.md", {
      pageSize: 50,
      page: result.totalPages,
    });
    expect(lastPage.content).not.toContain("Use --page");
  });

  test("extracts section via wikilink heading", () => {
    const result = readFile(v.vaultPath, "[[sectioned#Methods]]");
    expect(result.content).toContain("## Methods");
    expect(result.content).toContain("### Step 1");
    expect(result.content).toContain("### Step 2");
    expect(result.content).not.toContain("## Results");
    expect(result.content).not.toContain("## Introduction");
  });

  test("--section flag takes precedence over wikilink heading", () => {
    const result = readFile(v.vaultPath, "[[sectioned#Methods]]", {
      section: "Introduction",
    });
    expect(result.content).toContain("## Introduction");
    expect(result.content).not.toContain("## Methods");
  });
});
