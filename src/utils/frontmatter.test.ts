import { describe, expect, test } from "vitest";
import {
  parseFrontmatter,
  removeProperty,
  setProperty,
} from "./frontmatter.js";

describe("parseFrontmatter", () => {
  test("parses YAML frontmatter", () => {
    const content = "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\nBody here";
    const result = parseFrontmatter(content);
    expect(result.properties.title).toBe("Hello");
    expect(result.properties.tags).toEqual(["a", "b"]);
    expect(result.body).toContain("Body here");
  });

  test("handles no frontmatter", () => {
    const result = parseFrontmatter("Just a body");
    expect(result.properties).toEqual({});
    expect(result.body).toContain("Just a body");
  });

  test("handles empty frontmatter", () => {
    const result = parseFrontmatter("---\n---\nBody");
    expect(result.properties).toEqual({});
    expect(result.body).toContain("Body");
  });
});

describe("setProperty", () => {
  test("adds property to existing frontmatter", () => {
    const content = "---\ntitle: Hello\n---\nBody";
    const result = setProperty(content, "status", "draft");
    const parsed = parseFrontmatter(result);
    expect(parsed.properties.title).toBe("Hello");
    expect(parsed.properties.status).toBe("draft");
    expect(parsed.body).toContain("Body");
  });

  test("creates frontmatter if none exists", () => {
    const result = setProperty("Just body", "title", "New");
    const parsed = parseFrontmatter(result);
    expect(parsed.properties.title).toBe("New");
    expect(parsed.body).toContain("Just body");
  });

  test("overwrites existing property", () => {
    const content = "---\ntitle: Old\n---\nBody";
    const result = setProperty(content, "title", "New");
    const parsed = parseFrontmatter(result);
    expect(parsed.properties.title).toBe("New");
  });
});

describe("removeProperty", () => {
  test("removes a property", () => {
    const content = "---\ntitle: Hello\nstatus: draft\n---\nBody";
    const result = removeProperty(content, "status");
    const parsed = parseFrontmatter(result);
    expect(parsed.properties.title).toBe("Hello");
    expect(parsed.properties.status).toBeUndefined();
  });

  test("removes frontmatter block when last property removed", () => {
    const content = "---\ntitle: Hello\n---\nBody";
    const result = removeProperty(content, "title");
    expect(result).not.toContain("---");
    expect(result).toContain("Body");
  });
});
