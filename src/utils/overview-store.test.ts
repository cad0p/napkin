import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getOverview } from "../core/overview.js";
import {
  createOverviewStore,
  resetOverviewStoresForTests,
  SqliteOverviewStore,
} from "./overview-store.js";
import { loadSqlite } from "./sqlite-store.js";
import {
  createTempVault,
  dropOverviewStoreFiles,
  useJsonOverviewStore,
} from "./test-helpers.js";

/**
 * The SQLite per-note overview store (#118): per-note re-tokenization,
 * per-folder re-aggregation, term interning, folder deletion, the JSON
 * fallback, and recovery from an unusable database file. Output equivalence
 * with the JSON path is pinned by the golden/equivalence suites (they run
 * the default store) plus the store-agreement test below.
 */

const FIXTURE: Record<string, string> = {
  "NAPKIN.md": "# Fixture project\nContext note for the store vault.",
  "alpha/kubernetes.md":
    "# Cluster\nkubernetes ingress routing autoscaling telemetry dashboards",
  "alpha/mesh.md":
    "# Mesh\nkubernetes service mesh sidecar proxies observability tracing",
  "beta/payroll.md":
    "# Payroll\npayroll withholding contractors ledger invoices quarterly",
  "beta/ledger.md":
    "# Ledger\ndouble entry ledger reconciliation journal corrections audit",
  "gamma/sourdough.md":
    "# Sourdough\nfermentation hydration levain schedules starter feeding",
};

type TempVault = { path: string; vaultPath: string; cleanup: () => void };
const vaults: TempVault[] = [];

afterEach(() => {
  resetOverviewStoresForTests();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(files: Record<string, string>): TempVault {
  const v = createTempVault(files);
  vaults.push(v);
  return v;
}

function store(v: TempVault): SqliteOverviewStore {
  const s = createOverviewStore(v.vaultPath);
  expect(s).toBeInstanceOf(SqliteOverviewStore);
  return s as SqliteOverviewStore;
}

function writeNote(vaultPath: string, file: string, content: string): void {
  const full = path.join(vaultPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("SqliteOverviewStore", () => {
  test("changed note: only that note re-tokenizes, its folder re-aggregates", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    expect(first.overview.length).toBeGreaterThan(0);
    const s = store(v);
    const betaCand = s.folderCandForTests("beta");
    const meshNote = s.noteForTests("alpha/mesh.md");
    expect(meshNote).toBeDefined();

    writeNote(
      v.vaultPath,
      "alpha/kubernetes.md",
      "# Cluster\nkubernetes ingress routing sourdough fermentation hydration",
    );
    const second = getOverview(v.vaultPath, v.vaultPath);

    // The untouched note kept its stored record; the changed one moved.
    expect(s.noteForTests("alpha/mesh.md")?.data).toEqual(meshNote?.data);
    const alpha = s.folderCandForTests("alpha").map(([term]) => term);
    expect(alpha).toContain("sourdough");
    expect(alpha).not.toContain("telemetry");
    // Untouched folder rows are byte-identical.
    expect(s.folderCandForTests("beta")).toEqual(betaCand);

    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath)),
    );
  });

  test("a new note inserts one row and re-aggregates its folder", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    const before = s.inspectForTests();

    writeNote(
      v.vaultPath,
      "beta/invoices.md",
      "# Invoices\ninvoice numbering dunning reminders reconciliation",
    );
    const second = getOverview(v.vaultPath, v.vaultPath);

    const after = s.inspectForTests();
    expect(after.notes).toBe(before.notes + 1);
    expect(s.noteForTests("beta/invoices.md")).toBeDefined();
    expect(s.folderForTests("beta")?.notes).toBe(3);
    const beta = s.folderCandForTests("beta").map(([term]) => term);
    expect(beta).toContain("dunning");

    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath)),
    );
  });

  test("a deleted note removes its row and re-aggregates its folder", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    const before = s.inspectForTests();
    expect(s.folderForTests("gamma")?.notes).toBe(1);

    fs.rmSync(path.join(v.vaultPath, "gamma/sourdough.md"));
    const second = getOverview(v.vaultPath, v.vaultPath);

    // The note row is gone — and so is the folder row (no visible files).
    expect(s.noteForTests("gamma/sourdough.md")).toBeUndefined();
    expect(s.folderForTests("gamma")).toBeUndefined();
    expect(s.inspectForTests().notes).toBe(before.notes - 1);
    expect(second.overview.some((f) => f.path === "gamma")).toBe(false);

    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath)),
    );
  });

  test("folder deletion removes the folder row and all of its notes", () => {
    const v = vault({
      ...FIXTURE,
      "ephemeral/temporary.md":
        "# Ephemeral\nquarantine placeholder temporary scaffolding",
      "ephemeral/second.md": "# Second\nplaceholder quarantine",
    });
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    expect(s.folderForTests("ephemeral")?.notes).toBe(2);
    const before = s.inspectForTests();

    fs.rmSync(path.join(v.vaultPath, "ephemeral"), { recursive: true });
    const result = getOverview(v.vaultPath, v.vaultPath);

    expect(s.folderForTests("ephemeral")).toBeUndefined();
    expect(s.noteForTests("ephemeral/temporary.md")).toBeUndefined();
    expect(s.noteForTests("ephemeral/second.md")).toBeUndefined();
    expect(s.inspectForTests().notes).toBe(before.notes - 2);
    expect(result.overview.some((f) => f.path === "ephemeral")).toBe(false);

    dropOverviewStoreFiles(v.vaultPath);
    expect(result).toEqual(getOverview(v.vaultPath, v.vaultPath));
  });

  test("a new term inserts one dictionary row with its flags", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    const before = s.inspectForTests();
    expect(s.termIdForTests("telemetry")).toBeDefined();

    writeNote(
      v.vaultPath,
      "alpha/kubernetes.md",
      "# Cluster\nkubernetes ingress routing telescopes collimators collimators",
    );
    getOverview(v.vaultPath, v.vaultPath);

    expect(s.termIdForTests("telescopes")).toBeDefined();
    expect(s.inspectForTests().terms).toBeGreaterThan(before.terms);
    // The bigram flag rides on the interned term.
    writeNote(
      v.vaultPath,
      "gamma/sourdough.md",
      "# Sourdough\nfermentation hydration levain levain hydration hydration",
    );
    getOverview(v.vaultPath, v.vaultPath);
    expect(s.flagForTests("levain hydration")).toBe(1);
  });

  test("JSON fallback produces the identical overview", () => {
    const vSql = vault(FIXTURE);
    const viaSqlite = getOverview(vSql.vaultPath, vSql.vaultPath);
    // The default path did not write the legacy file.
    expect(
      fs.existsSync(path.join(vSql.vaultPath, "overview-folders-cache.json")),
    ).toBe(false);

    const vJson = vault(FIXTURE);
    useJsonOverviewStore(vJson.vaultPath);
    const viaJson = getOverview(vJson.vaultPath, vJson.vaultPath);
    expect(
      fs.existsSync(path.join(vJson.vaultPath, "overview-folders-cache.json")),
    ).toBe(true);

    expect(JSON.stringify(viaSqlite)).toBe(JSON.stringify(viaJson));

    // And a mutation+incremental run still agrees across the two stores.
    for (const v of [vSql, vJson]) {
      writeNote(
        v.vaultPath,
        "beta/extra.md",
        "# Extra\ninvoice dunning reminders reconciliation overdue",
      );
    }
    const s2 = getOverview(vSql.vaultPath, vSql.vaultPath);
    const j2 = getOverview(vJson.vaultPath, vJson.vaultPath);
    expect(JSON.stringify(s2)).toBe(JSON.stringify(j2));
  });

  test("a garbage database file is parked aside and rebuilt", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    const dbPath = path.join(v.vaultPath, "cache", "overview-v3.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    resetOverviewStoresForTests();
    fs.writeFileSync(dbPath, "this is not a sqlite database at all");
    // Remove the whole-result cache so the run must consult the store.
    fs.rmSync(path.join(v.vaultPath, "overview-cache.json"), { force: true });
    const second = getOverview(v.vaultPath, v.vaultPath);
    expect(second).toEqual(first);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(dbPath))
        .some((f) => f.startsWith("overview-v3.db.corrupt-")),
    ).toBe(true);
    expect(store(v).folderForTests("alpha")).toBeDefined();
  });

  test("an older user_version is parked and recreated", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    const dbPath = path.join(v.vaultPath, "cache", "overview-v3.db");
    resetOverviewStoresForTests();
    // Hand-build an "older" database: real SQLite file, wrong user_version,
    // no overview tables.
    const sqlite = loadSqlite();
    expect(sqlite).not.toBeNull();
    if (sqlite === null) return;
    fs.rmSync(dbPath, { force: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.exec("CREATE TABLE something_else(x)");
    db.close();
    // Remove the whole-result cache so the run must consult the store.
    fs.rmSync(path.join(v.vaultPath, "overview-cache.json"), { force: true });
    const second = getOverview(v.vaultPath, v.vaultPath);
    expect(second).toEqual(first);
    expect(store(v).folderForTests("alpha")).toBeDefined();
  });

  test("option-only misses do not rewrite stored rows", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    const before = s.inspectForTests();
    const alphaCand = s.folderCandForTests("alpha");

    const changed = getOverview(v.vaultPath, v.vaultPath, { keywords: 3 });
    expect(changed.overview.length).toBeGreaterThan(0);
    // No note or folder data rewritten: identical row counts and candidates.
    expect(s.inspectForTests()).toEqual(before);
    expect(s.folderCandForTests("alpha")).toEqual(alphaCand);
    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(changed)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath, { keywords: 3 })),
    );
  });
});
