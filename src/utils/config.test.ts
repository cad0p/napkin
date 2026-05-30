import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, MalformedConfigError, DEFAULT_CONFIG } from "./config.js";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-config-test-"));
    fs.mkdirSync(path.join(tmpDir, ".napkin"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const napkinDir = () => path.join(tmpDir, ".napkin");

  it("returns defaults when no config files exist", () => {
    const config = loadConfig(napkinDir());
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("loads config.json", () => {
    const custom = { overview: { depth: 5, keywords: 10 } };
    fs.writeFileSync(
      path.join(napkinDir(), "config.json"),
      JSON.stringify(custom),
    );
    const config = loadConfig(napkinDir());
    expect(config.overview.depth).toBe(5);
    expect(config.overview.keywords).toBe(10);
    // Other fields fall back to defaults
    expect(config.search.limit).toBe(DEFAULT_CONFIG.search.limit);
  });

  it("throws MalformedConfigError for malformed config.json", () => {
    fs.writeFileSync(
      path.join(napkinDir(), "config.json"),
      "{ this is not valid JSON",
    );
    expect(() => loadConfig(napkinDir())).toThrow(MalformedConfigError);
  });

  it("merges config.local.json on top of config.json", () => {
    fs.writeFileSync(
      path.join(napkinDir(), "config.json"),
      JSON.stringify({
        overview: { depth: 3, keywords: 8 },
        daily: { folder: "daily", format: "YYYY-MM-DD" },
      }),
    );
    fs.writeFileSync(
      path.join(napkinDir(), "config.local.json"),
      JSON.stringify({
        overview: { depth: 5 },
      }),
    );
    const config = loadConfig(napkinDir());
    // Local overrides base
    expect(config.overview.depth).toBe(5);
    // Base preserved where local doesn't override
    expect(config.overview.keywords).toBe(8);
    expect(config.daily.folder).toBe("daily");
  });

  it("throws MalformedConfigError for malformed config.local.json", () => {
    fs.writeFileSync(
      path.join(napkinDir(), "config.json"),
      JSON.stringify({ overview: { depth: 3, keywords: 8 } }),
    );
    fs.writeFileSync(
      path.join(napkinDir(), "config.local.json"),
      "not json",
    );
    expect(() => loadConfig(napkinDir())).toThrow(MalformedConfigError);
  });

  it("uses config.local.json even when config.json is missing", () => {
    fs.writeFileSync(
      path.join(napkinDir(), "config.local.json"),
      JSON.stringify({ overview: { depth: 7 } }),
    );
    const config = loadConfig(napkinDir());
    expect(config.overview.depth).toBe(7);
    // Other fields fall back to defaults
    expect(config.overview.keywords).toBe(DEFAULT_CONFIG.overview.keywords);
  });

  it("preserves unknown keys (like distill)", () => {
    fs.writeFileSync(
      path.join(napkinDir(), "config.json"),
      JSON.stringify({
        overview: { depth: 3, keywords: 8 },
        distill: { enabled: true, intervalMinutes: 30 },
      }),
    );
    const config = loadConfig(napkinDir());
    // Unknown keys are preserved in the returned config
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown keys
    expect((config as any).distill).toEqual({
      enabled: true,
      intervalMinutes: 30,
    });
  });
});
