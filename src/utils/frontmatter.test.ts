import matter from "gray-matter";
import { describe, expect, test } from "vitest";
import {
  parseFrontmatter,
  removeProperty,
  setProperty,
} from "./frontmatter.js";

// gray-matter's clearCache() replaces the cache object, so read it each time.
const cacheKeys = (): string[] =>
  Object.keys((matter as unknown as { cache: Record<string, unknown> }).cache);

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

  test("throws on malformed YAML", () => {
    const bad = "---\ntags: [#malformed, #unique-a]\n---\nBody";
    expect(() => parseFrontmatter(bad)).toThrow();
  });

  test("throws consistently on repeated parses of identical malformed YAML", () => {
    // gray-matter caches the file object BEFORE parsing, so without eviction
    // the second parse of the same string silently returns empty data.
    const bad = "---\ntags: [#malformed, #unique-b]\n---\nBody";
    expect(() => parseFrontmatter(bad)).toThrow();
    expect(() => parseFrontmatter(bad)).toThrow();
    expect(() => parseFrontmatter(bad)).toThrow();
  });

  test("does not fill gray-matter's parse cache by default (#132)", () => {
    matter.clearCache();
    // The same module instance napkin parses with: a call without options
    // does cache.
    matter("---\ntitle: probe\n---\nBody");
    expect(cacheKeys()).toHaveLength(1);
    matter.clearCache();
    for (let i = 0; i < 200; i++) {
      const parsed = parseFrontmatter(`---\ntitle: n${i}\n---\nBody ${i}`);
      expect(parsed.properties.title).toBe(`n${i}`);
    }
    expect(() =>
      parseFrontmatter("---\ntags: [#malformed, #unique-d]\n---\nBody"),
    ).toThrow();
    setProperty("---\ntitle: a\n---\nBody", "status", "draft");
    removeProperty("---\ntitle: a\nstatus: x\n---\nBody", "status");
    expect(cacheKeys()).toHaveLength(0);
  });

  test("{ cache: true } opts in, and a failed cached parse still throws every time", () => {
    matter.clearCache();
    const good = "---\ntitle: cached\n---\nBody";
    expect(parseFrontmatter(good, { cache: true }).properties.title).toBe(
      "cached",
    );
    expect(cacheKeys()).toEqual([good]);
    const bad = "---\ntags: [#malformed, #unique-e]\n---\nBody";
    expect(() => parseFrontmatter(bad, { cache: true })).toThrow();
    expect(() => parseFrontmatter(bad, { cache: true })).toThrow();
    matter.clearCache();
  });

  test("valid content still parses after a malformed parse", () => {
    const bad = "---\ntags: [#malformed, #unique-c]\n---\nBody";
    expect(() => parseFrontmatter(bad)).toThrow();
    const good = parseFrontmatter("---\ntitle: Fine\n---\nBody");
    expect(good.properties.title).toBe("Fine");
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
