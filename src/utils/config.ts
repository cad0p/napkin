import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultLayout {
  /** Content root relative to .napkin/ dir (e.g. ".." for sibling layout) */
  root: string;
  /** .obsidian/ dir relative to .napkin/ dir (e.g. "../.obsidian" for sibling layout) */
  obsidian: string;
}

export interface NapkinConfig {
  vault?: VaultLayout;
  overview: {
    depth: number;
    keywords: number;
  };
  search: {
    limit: number;
    snippetLines: number;
  };
  daily: {
    folder: string;
    format: string;
  };
  templates: {
    folder: string;
  };
  graph: {
    renderer: "auto" | "glimpse" | "browser";
  };
}

/**
 * Thrown when a config file exists but contains malformed JSON.
 */
export class MalformedConfigError extends Error {
  readonly configPath: string;
  readonly parseError: string;
  constructor(configPath: string, parseError: string) {
    super(`${configPath} is not valid JSON: ${parseError}`);
    this.name = "MalformedConfigError";
    this.configPath = configPath;
    this.parseError = parseError;
  }
}

export const DEFAULT_CONFIG: NapkinConfig = {
  overview: {
    depth: 3,
    keywords: 8,
  },
  search: {
    limit: 30,
    snippetLines: 0,
  },
  daily: {
    folder: "daily",
    format: "YYYY-MM-DD",
  },
  templates: {
    folder: "Templates",
  },
  graph: {
    renderer: "auto",
  },
};

/**
 * Load napkin config from config.json in the .napkin/ directory.
 * If config.local.json exists, it is deep-merged on top (local overrides).
 * Missing fields fall back to defaults.
 *
 * Throws {@link MalformedConfigError} if a config file exists but contains
 * malformed JSON. This allows callers to surface actionable error messages
 * to the user.
 *
 * config.local.json is gitignored and intended for per-machine overrides
 * (e.g. different model providers available on different machines).
 */
export function loadConfig(napkinDir: string): NapkinConfig {
  const configPath = path.join(napkinDir, "config.json");
  const localConfigPath = path.join(napkinDir, "config.local.json");

  if (!fs.existsSync(configPath) && !fs.existsSync(localConfigPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let config: NapkinConfig = { ...DEFAULT_CONFIG };

  // Load base config if it exists
  if (fs.existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      throw new MalformedConfigError(
        configPath,
        err instanceof Error ? err.message : String(err),
      );
    }
    config = deepMerge(DEFAULT_CONFIG, raw as Record<string, unknown>);
  }

  // Load and merge local override if it exists (local takes precedence)
  if (fs.existsSync(localConfigPath)) {
    let localRaw: unknown;
    try {
      localRaw = JSON.parse(
        fs.readFileSync(localConfigPath, "utf-8"),
      );
    } catch (err) {
      throw new MalformedConfigError(
        localConfigPath,
        err instanceof Error ? err.message : String(err),
      );
    }
    config = deepMerge(config, localRaw as Record<string, unknown>);
  }

  return config;
}

/**
 * Save napkin config to config.json in the .napkin/ directory and sync to .obsidian/.
 * If obsidianDir is not provided, resolves it from config.vault or defaults to .napkin/.obsidian/.
 */
export function saveConfig(
  napkinDir: string,
  config: NapkinConfig,
  obsidianDir?: string,
): void {
  const configPath = path.join(napkinDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const resolvedObsidian =
    obsidianDir ||
    (config.vault?.obsidian
      ? path.resolve(napkinDir, config.vault.obsidian)
      : path.join(napkinDir, ".obsidian"));
  syncObsidianConfig(resolvedObsidian, config);
}

/**
 * Update specific config fields, save, and sync.
 */
export function updateConfig(
  napkinDir: string,
  partial: Record<string, unknown>,
): NapkinConfig {
  const current = loadConfig(napkinDir);
  const updated = deepMerge(current, partial) as NapkinConfig;
  saveConfig(napkinDir, updated);
  return updated;
}

/**
 * Write .obsidian/ config files derived from napkin config.
 * napkin is the source of truth — Obsidian reads from these.
 */
function syncObsidianConfig(obsidianDir: string, config: NapkinConfig): void {
  if (!fs.existsSync(obsidianDir)) {
    fs.mkdirSync(obsidianDir, { recursive: true });
  }

  // daily-notes.json
  fs.writeFileSync(
    path.join(obsidianDir, "daily-notes.json"),
    JSON.stringify(
      {
        folder: config.daily.folder,
        format: config.daily.format,
        template: `${config.templates.folder}/Daily Note`,
      },
      null,
      2,
    ),
  );

  // templates.json
  fs.writeFileSync(
    path.join(obsidianDir, "templates.json"),
    JSON.stringify(
      {
        folder: config.templates.folder,
      },
      null,
      2,
    ),
  );

  // app.json
  const appPath = path.join(obsidianDir, "app.json");
  let app: Record<string, unknown> = {};
  if (fs.existsSync(appPath)) {
    try {
      app = JSON.parse(fs.readFileSync(appPath, "utf-8"));
    } catch {
      // ignore
    }
  }
  app.alwaysUpdateLinks = true;
  fs.writeFileSync(appPath, JSON.stringify(app, null, 2));
}

// biome-ignore lint/suspicious/noExplicitAny: deep merge requires flexible types
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Record<string, any>,
): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (target as Record<string, any>)[key];
    if (
      srcVal &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, any>)[key] = deepMerge(tgtVal, srcVal);
    } else {
      (result as Record<string, any>)[key] = srcVal;
    }
  }
  return result;
}
