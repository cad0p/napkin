import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getFileInfo,
  listFiles,
  listFolders,
  readFile,
  resolveFile,
} from "./files.js";
import { createTempVault } from "./test-helpers.js";

let vault: { path: string; vaultPath: string; cleanup: () => void };

beforeEach(() => {
  vault = createTempVault({
    "README.md": "# My Vault\nWelcome to the vault.",
    "Projects/Active Projects.md":
      "# Active Projects\n- Project A\n- Project B",
    "Projects/K Logic/Meeting.md": "# Meeting Notes\nSome notes here.",
    "Resources/Runbooks/Deploy.md": "# Deploy\nStep 1\nStep 2",
    "Inbox/Daily/2026-02-24.md":
      "# Daily\n- [ ] Buy groceries\n- [x] Ship feature",
    "Templates/Daily Note.md": "# {{date}}\n\n## Tasks\n- [ ] ",
    "Templates/Meeting Note.md": "# Meeting: {{title}}\n\n## Notes\n",
    "image.png": "fake-png-data",
  });
});

afterEach(() => {
  vault.cleanup();
});

describe("listFiles", () => {
  test("lists all files", () => {
    const files = listFiles(vault.vaultPath);
    expect(files.length).toBe(8);
    // Should not include .obsidian files
    for (const f of files) {
      expect(f).not.toMatch(/^\.obsidian\//);
    }
  });

  test("filters by extension", () => {
    const files = listFiles(vault.vaultPath, { ext: "md" });
    expect(files.length).toBe(7);
    for (const f of files) {
      expect(f).toEndWith(".md");
    }
  });

  test("filters by folder", () => {
    const files = listFiles(vault.vaultPath, { folder: "Projects" });
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(f).toMatch(/^Projects\//);
    }
  });

  test("returns empty for nonexistent folder", () => {
    const files = listFiles(vault.vaultPath, { folder: "Nope" });
    expect(files).toEqual([]);
  });
});

describe("listFolders", () => {
  test("lists folders", () => {
    const folders = listFolders(vault.vaultPath);
    expect(folders).toContain("Projects");
    expect(folders).toContain("Resources");
    expect(folders).toContain("Templates");
  });

  test("filters by parent folder", () => {
    const folders = listFolders(vault.vaultPath, "Resources");
    expect(folders).toEqual(["Resources/Runbooks"]);
  });
});

describe("resolveFile", () => {
  test("resolves by exact path", () => {
    const result = resolveFile(vault.vaultPath, "README.md");
    expect(result).toBe("README.md");
  });

  test("resolves by wikilink name", () => {
    const result = resolveFile(vault.vaultPath, "Active Projects");
    expect(result).toBe("Projects/Active Projects.md");
  });

  test("resolves case-insensitively", () => {
    const result = resolveFile(vault.vaultPath, "active projects");
    expect(result).toBe("Projects/Active Projects.md");
  });

  test("returns null for missing file", () => {
    const result = resolveFile(vault.vaultPath, "nonexistent-file");
    expect(result).toBeNull();
  });
});

describe("readFile", () => {
  test("reads file by wikilink name", () => {
    const { path, content } = readFile(vault.vaultPath, "README");
    expect(path).toBe("README.md");
    expect(content).toContain("My Vault");
  });

  test("reads file by exact path", () => {
    const { content } = readFile(
      vault.vaultPath,
      "Projects/Active Projects.md",
    );
    expect(content).toContain("Project A");
  });

  test("throws for missing file", () => {
    expect(() => readFile(vault.vaultPath, "nonexistent")).toThrow(
      "File not found",
    );
  });
});

describe("sibling layout", () => {
  let siblingVault: { path: string; cleanup: () => void };

  beforeEach(() => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-sibling-files-"),
    );
    // Content at root level
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note");
    fs.mkdirSync(path.join(tmpDir, "folder"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "folder", "deep.md"), "# Deep");
    // .napkin/ and .obsidian/ as siblings
    fs.mkdirSync(path.join(tmpDir, ".napkin"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".napkin", "config.json"), "{}");
    siblingVault = {
      path: tmpDir,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  });

  afterEach(() => {
    siblingVault.cleanup();
  });

  test("listFiles skips .napkin/ when content root is parent", () => {
    const files = listFiles(siblingVault.path);
    expect(files).toContain("note.md");
    expect(files).toContain("folder/deep.md");
    // Should NOT include .napkin/ contents
    for (const f of files) {
      expect(f).not.toMatch(/^\.napkin\//);
    }
  });

  test("listFolders skips .napkin/ when content root is parent", () => {
    const folders = listFolders(siblingVault.path);
    expect(folders).toContain("folder");
    expect(folders).not.toContain(".napkin");
  });
});

describe("getFileInfo", () => {
  test("returns file info", () => {
    const info = getFileInfo(vault.vaultPath, "README.md");
    expect(info.name).toBe("README");
    expect(info.extension).toBe("md");
    expect(info.size).toBeGreaterThan(0);
    expect(info.created).toBeGreaterThan(0);
    expect(info.modified).toBeGreaterThan(0);
  });
});

describe("symlink following", () => {
  let tmpRoot: string;
  let linkedVault: { path: string; vaultPath: string; cleanup: () => void };

  beforeEach(() => {
    // External directory outside the vault that we'll symlink into it.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-symlink-src-"));
    fs.mkdirSync(path.join(tmpRoot, "subdir"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "top-level.md"),
      "# Top-level\nLinked file content.",
    );
    fs.writeFileSync(
      path.join(tmpRoot, "subdir", "nested.md"),
      "# Nested\nDeep content.",
    );

    linkedVault = createTempVault({
      "README.md": "# Vault with symlinks",
    });
    // Symlinked directory: wikis/linked-dir -> tmpRoot
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "linked-dir"));
    // Symlinked file: linked-file.md -> tmpRoot/top-level.md
    fs.symlinkSync(
      path.join(tmpRoot, "top-level.md"),
      path.join(linkedVault.vaultPath, "linked-file.md"),
    );
  });

  afterEach(() => {
    linkedVault.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("listFiles follows a symlinked directory into its files", () => {
    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    expect(files).toContain("linked-dir/top-level.md");
    expect(files).toContain("linked-dir/subdir/nested.md");
  });

  test("listFiles includes a symlinked file", () => {
    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    expect(files).toContain("linked-file.md");
  });

  test("listFolders surfaces a symlinked directory", () => {
    const folders = listFolders(linkedVault.vaultPath);
    expect(folders).toContain("linked-dir");
    expect(folders).toContain("linked-dir/subdir");
  });

  test("listFiles silently skips a broken symlink", () => {
    fs.symlinkSync(
      path.join(tmpRoot, "does-not-exist.md"),
      path.join(linkedVault.vaultPath, "broken.md"),
    );
    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    // Real + symlinked-target files are present; broken link is skipped.
    expect(files).toContain("README.md");
    expect(files).toContain("linked-file.md");
    expect(files).not.toContain("broken.md");
  });

  test("listFiles handles symlink cycles without infinite loop", () => {
    // a/ contains link 'loop' that points back to the vault root.
    const subdir = path.join(linkedVault.vaultPath, "a");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "inside.md"), "# inside");
    fs.symlinkSync(linkedVault.vaultPath, path.join(subdir, "loop"));

    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    // Cycle is detected before re-entry: the vault is not walked a
    // second time via the `loop` symlink, so the result is the same
    // as if `loop` didn't exist.
    expect(new Set(files)).toEqual(
      new Set([
        "README.md",
        "a/inside.md",
        "linked-dir/subdir/nested.md",
        "linked-dir/top-level.md",
        "linked-file.md",
      ]),
    );
  });

  test("listFolders detects a symlink cycle back to an ancestor", () => {
    const subdir = path.join(linkedVault.vaultPath, "a");
    fs.mkdirSync(subdir, { recursive: true });
    fs.symlinkSync(linkedVault.vaultPath, path.join(subdir, "loop"));

    // Should return cleanly (not hang or overflow). `loop` itself
    // appears once as a visible folder, but its contents are not
    // re-walked.
    const folders = listFolders(linkedVault.vaultPath);
    expect(folders).toContain("a");
    expect(folders).toContain("linked-dir");
    // No entry should re-enter the vault via the loop prefix.
    for (const f of folders) {
      expect(f.startsWith("a/loop/a/")).toBe(false);
    }
  });

  test("sibling symlinks pointing at the same target are both walked", () => {
    // Two distinct symlink names, same underlying tmpRoot. Each
    // sibling should contribute its own prefixed entries.
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "mirror-a"));
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "mirror-b"));

    const files = listFiles(linkedVault.vaultPath, { ext: "md" });
    expect(files).toContain("mirror-a/top-level.md");
    expect(files).toContain("mirror-a/subdir/nested.md");
    expect(files).toContain("mirror-b/top-level.md");
    expect(files).toContain("mirror-b/subdir/nested.md");
  });

  test("symlink named like a skipDir entry is still skipped", () => {
    // A symlink named 'node_modules' should be excluded just like a real one.
    fs.symlinkSync(tmpRoot, path.join(linkedVault.vaultPath, "node_modules"));
    const files = listFiles(linkedVault.vaultPath);
    for (const f of files) {
      expect(f.startsWith("node_modules/")).toBe(false);
    }
  });
});

describe("dotdir pruning", () => {
  let v: { path: string; vaultPath: string; cleanup: () => void };

  beforeEach(() => {
    v = createTempVault({
      "README.md": "# Vault",
      // Not in SKIP_DIRS — these are stricter-filter candidates.
      ".cache/notes.md": "# cache notes",
      ".cache/inner/deeper.md": "# deeper",
      ".vscode/tasks.md": "# tasks",
      "ok/fine.md": "# fine",
    });
  });

  afterEach(() => {
    v.cleanup();
  });

  test("listFolders prunes dotdir subtrees entirely", () => {
    const folders = listFolders(v.vaultPath);
    // Neither the dotdirs themselves nor any of their descendants.
    expect(folders).toContain("ok");
    expect(folders.some((f) => f.startsWith("."))).toBe(false);
    expect(folders.some((f) => f.includes(".cache"))).toBe(false);
    expect(folders.some((f) => f.includes(".vscode"))).toBe(false);
  });

  test("listFiles still lists dotdir contents (permissive by design)", () => {
    // listFiles's behavior pre-dates this PR: it only skips SKIP_DIRS,
    // not arbitrary dotdirs. Locked in so a future consolidation
    // doesn't accidentally shift it.
    const files = listFiles(v.vaultPath, { ext: "md" });
    expect(files).toContain("README.md");
    expect(files).toContain("ok/fine.md");
    expect(files).toContain(".cache/notes.md");
    expect(files).toContain(".cache/inner/deeper.md");
    expect(files).toContain(".vscode/tasks.md");
  });
});

describe("unreadable directories", () => {
  let v: { path: string; vaultPath: string; cleanup: () => void };
  let unreadableDir: string;

  beforeEach(() => {
    v = createTempVault({
      "keep.md": "# keep",
      "locked/note.md": "# note",
    });
    unreadableDir = path.join(v.vaultPath, "locked");
    // Drop read+exec perms so readdirSync throws. Skipped if running
    // as root (root bypasses DAC permissions).
    fs.chmodSync(unreadableDir, 0o000);
  });

  afterEach(() => {
    // Restore perms so cleanup can remove the tree.
    try {
      fs.chmodSync(unreadableDir, 0o755);
    } catch {
      // ignore
    }
    v.cleanup();
  });

  test("listFiles silently skips an unreadable subdirectory", () => {
    // process.geteuid is node-only; bun provides it via node:process.
    // Skip the assertion when running as root because chmod 0 is a
    // no-op for UID 0.
    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      return;
    }
    const files = listFiles(v.vaultPath, { ext: "md" });
    expect(files).toContain("keep.md");
    // locked/ was reported as a dir (via Dirent) but its contents
    // couldn't be read — walker should return cleanly without throwing.
    expect(files).not.toContain("locked/note.md");
  });
});
