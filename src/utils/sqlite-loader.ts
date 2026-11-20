import { createRequire } from "node:module";

/**
 * The lazy `node:sqlite` loader shared by the search store
 * (sqlite-store.ts) and the overview store (overview-store.ts) — #123.
 * Extracted so the overview's import graph (`@cad0p/napkin/overview`)
 * reaches the loader without pulling in the search store (json-store,
 * name-search, search-cache), which the overview never uses.
 */
export type SqliteModule = typeof import("node:sqlite");

let sqliteModule: SqliteModule | null | undefined;

/**
 * Import `node:sqlite`, suppressing only its ExperimentalWarning (Node 22
 * prints it on first load; 24+ print nothing). The warning is filtered for
 * the synchronous duration of the `require` only, so every other warning —
 * experimental or not — still reaches stderr.
 *
 * The module is loaded through `createRequire` because a static `import`
 * would run before this code has a chance to install the filter.
 */
export function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (
    this: typeof process,
    warning: unknown,
    ...rest: unknown[]
  ) {
    const message =
      typeof warning === "string"
        ? warning
        : (warning as { message?: string } | undefined)?.message;
    const opt = rest[0];
    const type =
      typeof opt === "string"
        ? opt
        : (opt as { type?: string } | undefined)?.type;
    if (
      typeof message === "string" &&
      message.includes("SQLite") &&
      typeof type === "string" &&
      type.includes("Experimental")
    ) {
      return undefined as never;
    }
    return emitWarning.apply(process, [warning, ...rest] as never);
  } as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)("node:sqlite");
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqliteModule ?? null;
}
