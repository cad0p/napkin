/**
 * Process-local search freshness state (#93).
 *
 * `searchVault` validates its index with a full stat walk of the vault —
 * ~340 ms on a 28.7k-note vault, ~7 s at ten times that — and it does so on
 * every query, in every process, even when nothing changed. A long-lived
 * consumer that searches in a loop (the pi extension's `kb_search`) pays that
 * walk for each `new Napkin(cwd)`, so the walk dominates query latency.
 *
 * Two pieces of process state let a search skip it safely:
 *
 *  - **walk timestamps** per cache key: a walk younger than the configured
 *    freshness window is trusted, so the next search inside the window reuses
 *    the index as-is. Changes made by OTHER processes therefore become visible
 *    after at most one window. A window of 0 (the default) never skips, so the
 *    CLI and a default SDK instance behave exactly as before.
 *  - **dirty paths** per vault: every write napkin performs in this process
 *    names the file it touched, so the next search re-stats just those paths
 *    and feeds them through the incremental diff. That is read-your-writes
 *    inside the window — a handful of stats instead of a full walk.
 *
 * State is module-level on purpose: the pi extension constructs a `Napkin`
 * per call, so per-instance state would never survive to the next search. The
 * dirty set is keyed by the vault content path (a write knows the path but not
 * the ignore fingerprint) and the walk timestamps by the same
 * `contentPath + ignoreFingerprint` key the search index cache uses, so two
 * vaults — or two ignore states of one vault — never share freshness state.
 */

/** Paths written by this process, plus a "the walk is stale" flag. */
interface VaultFreshness {
  /** Vault-relative POSIX paths written since the last walk. */
  dirty: Set<string>;
  /** Force a full walk on the next search (bulk writes we cannot enumerate). */
  forceWalk: boolean;
  /** Search cache key → `Date.now()` when a walk last completed. */
  lastWalkAt: Map<string, number>;
}

const freshness = new Map<string, VaultFreshness>();

function stateFor(contentPath: string): VaultFreshness {
  let state = freshness.get(contentPath);
  if (!state) {
    state = { dirty: new Set(), forceWalk: false, lastWalkAt: new Map() };
    freshness.set(contentPath, state);
  }
  return state;
}

/**
 * Normalise a vault-relative path the way the index keys files: POSIX
 * separators, no leading `./`. Anything absolute or escaping the vault is
 * dropped — the walk could never enumerate it.
 */
function normalizePath(file: string): string | null {
  const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel === "" || rel.startsWith("/") || rel.startsWith(".napkin/"))
    return null;
  if (rel.split("/").includes("..")) return null;
  return rel;
}

/**
 * Record that this process wrote `paths` in the vault at `contentPath`.
 *
 * The next search re-stats exactly these paths, so a note created, edited,
 * moved, renamed or deleted through napkin is visible immediately — even
 * inside the freshness window. Null/undefined entries are ignored so callers
 * can pass an optional destination path inline.
 */
export function markSearchPathsDirty(
  contentPath: string,
  ...paths: (string | null | undefined)[]
): void {
  const state = stateFor(contentPath);
  for (const raw of paths) {
    if (!raw) continue;
    const file = normalizePath(raw);
    if (file !== null) state.dirty.add(file);
  }
}

/**
 * Force the next search in this process to walk the vault.
 *
 * For writes that are not a fixed set of note paths (scaffolding a template,
 * adding a vault template) where enumerating every created file is not worth
 * it: one walk after a bulk write is cheaper than tracking hundreds of paths
 * that the search may never ask about.
 */
export function markSearchWalkStale(contentPath: string): void {
  stateFor(contentPath).forceWalk = true;
}

/** Pending freshness work for one vault, consumed by the next search. */
export interface PendingFreshness {
  /** Vault-relative paths written since the last search. */
  dirty: string[];
  /** True when a full walk is required regardless of the window. */
  forceWalk: boolean;
}

/**
 * Take — and clear — the pending freshness work for a vault.
 *
 * Taken unconditionally, even when the caller then decides to walk: a walk
 * sees every change the dirty paths describe, and keeping applied paths
 * around would make the process state grow without bound.
 */
export function takeSearchFreshness(contentPath: string): PendingFreshness {
  const state = freshness.get(contentPath);
  if (!state) return { dirty: [], forceWalk: false };
  const pending = { dirty: [...state.dirty], forceWalk: state.forceWalk };
  state.dirty.clear();
  state.forceWalk = false;
  return pending;
}

/** When this process last completed a walk for `cacheKey`, if ever. */
export function lastSearchWalkAt(
  contentPath: string,
  cacheKey: string,
): number | undefined {
  return freshness.get(contentPath)?.lastWalkAt.get(cacheKey);
}

/** Record that a walk covering `cacheKey` completed now (or at `at`). */
export function recordSearchWalk(
  contentPath: string,
  cacheKey: string,
  at: number = Date.now(),
): void {
  stateFor(contentPath).lastWalkAt.set(cacheKey, at);
}

/**
 * True when the index behind `cacheKey` was walked less than
 * `freshnessMs` ago — the window in which a search may skip the walk.
 *
 * A window of 0 is never open (`now - at` is never negative), and a cache
 * key that has never been walked in this process always walks.
 */
export function isFreshnessWindowOpen(
  contentPath: string,
  cacheKey: string,
  freshnessMs: number,
  now: number = Date.now(),
): boolean {
  if (!(freshnessMs > 0)) return false;
  const at = lastSearchWalkAt(contentPath, cacheKey);
  if (at === undefined) return false;
  return now - at < freshnessMs;
}

/**
 * Test-only hook: drop all freshness state, as a fresh process would have.
 * Called from `resetSearchIndexForTests` so a test file's cases never inherit
 * a walk timestamp or a dirty path from an earlier case.
 */
export function resetSearchFreshnessForTests(): void {
  freshness.clear();
}
