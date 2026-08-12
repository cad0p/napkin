import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTempVault } from "./test-helpers.js";
import { findVault, getVaultConfig, VaultNotFoundError } from "./vault.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  vault = createTempVault();
});

afterEach(() => {
  vault.cleanup();
});

describe("findVault", () => {
  test("finds vault from project root", () => {
    const result = findVault(vault.path);
    expect(result.configPath).toBe(path.join(vault.path, ".napkin"));
  });

  test("finds vault from subdirectory", () => {
    const sub = path.join(vault.path, "some", "nested", "dir");
    fs.mkdirSync(sub, { recursive: true });
    const result = findVault(sub);
    expect(result.configPath).toBe(path.join(vault.path, ".napkin"));
  });

  test("throws VaultNotFoundError when none found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-auto-"));
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir; // isolate from global config
    try {
      expect(() => findVault(tmpDir)).toThrow(VaultNotFoundError);
      try {
        findVault(tmpDir);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("No napkin vault found");
        expect(msg).toContain("napkin init");
        expect(msg).toContain("--vault");
        expect(msg).toContain("global vault");
      }
      // Must not create any stray vault artifacts
      expect(fs.existsSync(path.join(tmpDir, ".napkin"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "NAPKIN.md"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, ".obsidian"))).toBe(false);
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to global vault from XDG config", () => {
    const globalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-global-vault-"),
    );
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-global-config-"),
    );
    const napkinConfigDir = path.join(configDir, "napkin");
    fs.mkdirSync(napkinConfigDir, { recursive: true });
    // Create a vault in globalDir
    const napkinDir = path.join(globalDir, ".napkin");
    fs.mkdirSync(path.join(napkinDir, ".obsidian"), { recursive: true });
    fs.writeFileSync(
      path.join(napkinDir, "config.json"),
      JSON.stringify({ vault: { root: "..", obsidian: "../.obsidian" } }),
    );
    // Write global config pointing to globalDir
    fs.writeFileSync(
      path.join(napkinConfigDir, "config.json"),
      JSON.stringify({ vault: globalDir }),
    );
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDir;
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-fallback-"));
      const result = findVault(tmpDir);
      expect(result.configPath).toBe(path.join(globalDir, ".napkin"));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(globalDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("throws when global config is invalid", () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-bad-config-"),
    );
    const napkinConfigDir = path.join(configDir, "napkin");
    fs.mkdirSync(napkinConfigDir, { recursive: true });
    fs.writeFileSync(path.join(napkinConfigDir, "config.json"), "not json");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-no-vault-"));
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDir;
    try {
      // No vault anywhere — must throw, never create one
      expect(() => findVault(tmpDir)).toThrow(VaultNotFoundError);
      expect(fs.existsSync(path.join(tmpDir, ".napkin"))).toBe(false);
    } finally {
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("throws when .napkin/ exists but config lacks vault.root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-only-test-"));
    fs.mkdirSync(path.join(tmpDir, ".napkin"));
    try {
      // A bare .napkin/ with no config is the legacy embedded layout —
      // refused, not guessed.
      expect(() => findVault(tmpDir)).toThrow(VaultNotFoundError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("layout: embedded (.napkin/.obsidian/)", () => {
    test("contentPath is .napkin/, obsidianPath is .napkin/.obsidian/", () => {
      const result = findVault(vault.path);
      expect(result.contentPath).toBe(path.join(vault.path, ".napkin"));
      expect(result.configPath).toBe(path.join(vault.path, ".napkin"));
      expect(result.obsidianPath).toBe(
        path.join(vault.path, ".napkin", ".obsidian"),
      );
    });

    test("config without vault field is refused with a migration hint", () => {
      // Simulate a pre-layout vault: config.json has no vault field. The
      // implicit embedded-layout fallback is gone — it must throw and tell
      // the user how to migrate.
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "napkin-existing-test-"),
      );
      const napkinDir = path.join(tmpDir, ".napkin");
      fs.mkdirSync(path.join(napkinDir, ".obsidian"), { recursive: true });
      fs.writeFileSync(
        path.join(napkinDir, "config.json"),
        JSON.stringify({
          overview: { depth: 3, keywords: 8 },
          daily: { folder: "daily", format: "YYYY-MM-DD" },
        }),
      );
      fs.writeFileSync(path.join(napkinDir, "README.md"), "# Hello");

      try {
        try {
          findVault(tmpDir);
          expect.unreachable("expected VaultNotFoundError");
        } catch (e) {
          expect(e).toBeInstanceOf(VaultNotFoundError);
          const msg = (e as Error).message;
          expect(msg).toContain("legacy embedded layout");
          expect(msg).toContain('"root": ".."');
          expect(msg).toContain('"root": "."');
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("layout: sibling (.napkin/ alongside .obsidian/)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-sibling-test-"));
      // Existing Obsidian vault with .obsidian/ at root
      fs.mkdirSync(path.join(tmpDir, ".obsidian"), { recursive: true });
      // napkin adopted — .napkin/ as sibling
      fs.mkdirSync(path.join(tmpDir, ".napkin"), { recursive: true });
      // config tells napkin the layout
      fs.writeFileSync(
        path.join(tmpDir, ".napkin", "config.json"),
        JSON.stringify({ vault: { root: "..", obsidian: "../.obsidian" } }),
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("contentPath is parent dir, obsidianPath is sibling .obsidian/", () => {
      const result = findVault(tmpDir);
      expect(result.contentPath).toBe(tmpDir);
      expect(result.configPath).toBe(path.join(tmpDir, ".napkin"));
      expect(result.obsidianPath).toBe(path.join(tmpDir, ".obsidian"));
    });

    test("finds vault from subdirectory", () => {
      const sub = path.join(tmpDir, "notes", "deep");
      fs.mkdirSync(sub, { recursive: true });
      const result = findVault(sub);
      expect(result.contentPath).toBe(tmpDir);
    });
  });

  describe("layout: nested (.obsidian/.napkin/)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-nested-test-"));
      // Existing Obsidian vault
      fs.mkdirSync(path.join(tmpDir, ".obsidian", ".napkin"), {
        recursive: true,
      });
      // config inside .obsidian/.napkin/
      fs.writeFileSync(
        path.join(tmpDir, ".obsidian", ".napkin", "config.json"),
        JSON.stringify({ vault: { root: "../..", obsidian: ".." } }),
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("contentPath is grandparent, obsidianPath is parent .obsidian/", () => {
      const result = findVault(tmpDir);
      expect(result.contentPath).toBe(tmpDir);
      expect(result.configPath).toBe(path.join(tmpDir, ".obsidian", ".napkin"));
      expect(result.obsidianPath).toBe(path.join(tmpDir, ".obsidian"));
    });
  });
});

describe("getVaultConfig", () => {
  test("reads existing config file", () => {
    const obsidianPath = path.join(vault.path, ".napkin", ".obsidian");
    const config = getVaultConfig(obsidianPath, "app.json");
    expect(config).not.toBeNull();
    expect(config?.alwaysUpdateLinks).toBe(true);
  });

  test("returns null for missing config", () => {
    const obsidianPath = path.join(vault.path, ".napkin", ".obsidian");
    const config = getVaultConfig(obsidianPath, "nonexistent.json");
    expect(config).toBeNull();
  });
});
