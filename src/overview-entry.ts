import {
  getOverview,
  type OverviewFolder,
  type VaultOverview,
} from "./core/overview.js";
import { findVault, type VaultInfo } from "./utils/vault.js";

/**
 * The slim `@cad0p/napkin/overview` entry (#123): the vault overview for
 * processes that only build it (pi-napkin's forked overview child), without
 * loading the rest of the SDK — search, bases, canvas, tasks, templates,
 * links, gray-matter, minisearch. The import-graph test in
 * overview-entry.test.ts keeps this entry's static graph slim.
 *
 * {@link Napkin.overview} calls the same {@link overviewForVault} helper, so
 * the entry's output can never diverge from the SDK method's.
 */

/** Options of {@link buildVaultOverview} / {@link Napkin.overview}. */
export interface OverviewOptions {
  depth?: number;
  keywords?: number;
  collapse?: boolean;
  collapseDepth?: number;
  maxRows?: number;
}

export type { OverviewFolder, VaultOverview };

/**
 * `getOverview` plus the vault root — the body shared by
 * {@link buildVaultOverview} and `Napkin#overview`.
 *
 * Root is attached fresh at this layer, after the (possibly cached) core
 * result — it must never be persisted into the overview cache, or a moved
 * vault would serve a stale root.
 */
export function overviewForVault(
  vault: VaultInfo,
  opts?: OverviewOptions,
): VaultOverview & { root: string } {
  return {
    ...getOverview(vault.contentPath, vault.configPath, opts),
    root: vault.contentPath,
  };
}

/**
 * Build the vault overview for the vault found at or above `cwd` — exactly
 * what `new Napkin(cwd).overview(opts)` returns. Throws
 * {@link VaultNotFoundError} when there is no vault.
 */
export function buildVaultOverview(
  cwd: string,
  opts?: OverviewOptions,
): VaultOverview & { root: string } {
  return overviewForVault(findVault(cwd), opts);
}
