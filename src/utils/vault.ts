import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_NO_VAULT } from "./exit-codes.js";

export interface VaultInfo {
  /** Vault display name (derived from content root directory) */
  name: string;
  /** Where vault content lives (project root, parent of .napkin/) */
  contentPath: string;
  /** Where config.json lives (always the .napkin/ directory) */
  configPath: string;
  /** Where .obsidian/ directory lives */
  obsidianPath: string;
}

/**
 * Thrown when no vault can be found — neither a walk-up hit (`.napkin/` at or
 * above the starting directory) nor a global vault from the user config.
 */
export class VaultNotFoundError extends Error {
  readonly exitCode = EXIT_NO_VAULT;

  constructor(startDir: string, globalConfigPath: string) {
    super(
      `No napkin vault found (searched up from ${startDir}).\n` +
        `  Run \`napkin init\` to create one here, pass --vault <path>, or set a` +
        ` global vault in ${globalConfigPath} ({"vault": "/path/to/vault"}).`,
    );
    this.name = "VaultNotFoundError";
  }
}

/**
 * Walk up from startDir looking for .napkin/ (or .obsidian/.napkin/ for nested layout).
 * Falls back to the global vault configured in $XDG_CONFIG_HOME/napkin/config.json.
 * Throws {@link VaultNotFoundError} when no vault exists — never silently
 * creates one in the user's cwd.
 */
export function findVault(startDir?: string): VaultInfo {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;

  const startingDir = dir;

  while (true) {
    const napkinDir = path.join(dir, ".napkin");

    if (fs.existsSync(napkinDir) && fs.statSync(napkinDir).isDirectory()) {
      return resolveVaultLayout(napkinDir, dir);
    }

    // Check for nested layout: .obsidian/.napkin/
    const nestedNapkin = path.join(dir, ".obsidian", ".napkin");
    if (
      fs.existsSync(nestedNapkin) &&
      fs.statSync(nestedNapkin).isDirectory()
    ) {
      return resolveVaultLayout(nestedNapkin, dir);
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      break;
    }
    dir = parent;
  }

  // Fall back to global vault from user config
  const globalVault = getGlobalConfigVault();
  if (globalVault) {
    return resolveVaultLayout(globalVault, path.dirname(globalVault));
  }

  // No vault found — fail loudly instead of creating a bare vault in the
  // user's cwd. Silent auto-create produced stray .napkin/ + .obsidian/ +
  // NAPKIN.md dirs in arbitrary directories (and in agent workspace dirs),
  // which users consistently reported as surprising.
  const globalConfigPath = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "napkin",
    "config.json",
  );
  throw new VaultNotFoundError(startingDir, globalConfigPath);
}

/**
 * Check for a global vault configured in the user's config directory.
 * Reads the `vault` field from $XDG_CONFIG_HOME/napkin/config.json
 * (defaults to ~/.config/napkin/config.json).
 *
 * Returns the .napkin/ path if a valid vault is configured, null otherwise.
 */
function getGlobalConfigVault(): string | null {
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const configPath = path.join(configHome, "napkin", "config.json");
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!raw.vault) return null;

    const vaultPath =
      raw.vault === "~" || raw.vault.startsWith("~/")
        ? path.join(os.homedir(), raw.vault.slice(1))
        : path.resolve(path.dirname(configPath), raw.vault);

    const napkinDir = path.join(vaultPath, ".napkin");
    if (fs.existsSync(napkinDir)) return napkinDir;
  } catch {
    // invalid config
  }

  return null;
}

/**
 * Resolve vault layout from .napkin/config.json vault paths.
 * If no vault config exists, defaults to sibling layout (content in project dir).
 */
function resolveVaultLayout(napkinDir: string, projectDir: string): VaultInfo {
  const configPath = path.join(napkinDir, "config.json");
  let vaultConfig: { root?: string; obsidian?: string } | undefined;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    vaultConfig = raw.vault;
  } catch {
    // no config or invalid — use defaults
  }

  if (vaultConfig?.root) {
    const contentPath = path.resolve(napkinDir, vaultConfig.root);
    const obsidianPath = vaultConfig.obsidian
      ? path.resolve(napkinDir, vaultConfig.obsidian)
      : path.join(contentPath, ".obsidian");
    return {
      name: path.basename(contentPath),
      contentPath,
      configPath: napkinDir,
      obsidianPath,
    };
  }

  // Legacy: embedded layout — .napkin/ is the vault root (no vault.root in config)
  return {
    name: path.basename(projectDir),
    contentPath: napkinDir,
    configPath: napkinDir,
    obsidianPath: path.join(napkinDir, ".obsidian"),
  };
}

/**
 * Read a JSON config file from .obsidian/ directory.
 * Returns parsed JSON or null if file doesn't exist.
 */
export function getVaultConfig(
  obsidianPath: string,
  configFile: string,
): Record<string, unknown> | null {
  const configPath = path.join(obsidianPath, configFile);
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
