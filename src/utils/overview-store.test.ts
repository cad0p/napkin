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
 * The SQLite per-folder overview store (#112): per-folder rewrites, term
 * dictionary maintenance, folder deletion, the JSON fallback, and recovery
 * from an unusable database file. Output equivalence with the JSON path is
 * pinned by the golden/equivalence suites (they run the default store) plus
 * the store-agreement test below.
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

// Six homogeneous siblings: exercises the collapse merge over stored data.
const SHARED = [
  "Lease agreement between landlord and tenant with signature page.",
  "Rent schedule and lease term apply as stated in the appendix.",
  "Bank guarantee and insurance certificate required before occupancy.",
];
for (let i = 0; i < 6; i++) {
  FIXTURE["imports/tenant-" + i + "/contract.md"] =
    "# Converted document " +
    i +
    "\n" +
    SHARED.filter((_, j) => j !== i % 3).join("\n") +
    "\nSuite " +
    (100 + i) +
    ".";
}

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
  test("incremental folder rewrite: only the changed folder's rows move", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    expect(first.overview.length).toBeGreaterThan(0);
    const s = store(v);
    const betaSig = s.folderForTests("beta")?.sig;
    const betaTerms = s.folderTermsForTests("beta");

    writeNote(
      v.vaultPath,
      "alpha/kubernetes.md",
      "# Cluster\nkubernetes ingress routing sourdough fermentation hydration",
    );
    const second = getOverview(v.vaultPath, v.vaultPath);

    // Untouched folders keep their stored data; the changed folder moved.
    expect(s.folderForTests("beta")?.sig).toBe(betaSig);
    expect(s.folderTermsForTests("beta")).toEqual(betaTerms);
    expect([...s.folderTermsForTests("alpha").keys()]).toContain("sourdough");
    expect([...s.folderTermsForTests("alpha").keys()]).not.toContain(
      "telemetry",
    );

    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath)),
    );
  });

  test("a new term inserts one dictionary row; an orphaned term is swept", () => {
    const v = vault(FIXTURE);
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    const before = s.inspectForTests();
    expect(before.orphanedTerms).toBe(0);
    expect(s.folderTermsForTests("alpha").has("telemetry")).toBe(true);

    writeNote(
      v.vaultPath,
      "alpha/kubernetes.md",
      "# Cluster\nkubernetes ingress routing telescopes collimators",
    );
    getOverview(v.vaultPath, v.vaultPath);

    const alpha = s.folderTermsForTests("alpha");
    expect(alpha.has("telescopes")).toBe(true);
    expect(alpha.has("telemetry")).toBe(false);
    // "telemetry" only existed in alpha — its dictionary row is gone.
    expect(
      [...s.folderTermsForTests("beta").keys()].includes("telemetry"),
    ).toBe(false);
    expect(s.inspectForTests().orphanedTerms).toBe(0);
  });

  test("folder deletion removes the folder and its private vocabulary", () => {
    const v = vault({
      ...FIXTURE,
      "ephemeral/temporary.md":
        "# Ephemeral\nquarantine placeholder temporary scaffolding",
    });
    getOverview(v.vaultPath, v.vaultPath);
    const s = store(v);
    expect(s.folderForTests("ephemeral")).toBeDefined();
    expect(s.folderPathsForTests()).toContain("ephemeral");

    fs.rmSync(path.join(v.vaultPath, "ephemeral"), { recursive: true });
    const result = getOverview(v.vaultPath, v.vaultPath);

    expect(s.folderForTests("ephemeral")).toBeUndefined();
    expect(s.folderPathsForTests()).not.toContain("ephemeral");
    // The folder's private terms left the dictionary entirely.
    expect(s.inspectForTests().orphanedTerms).toBe(0);
    expect(result.overview.some((f) => f.path === "ephemeral")).toBe(false);
    dropOverviewStoreFiles(v.vaultPath);
    expect(result).toEqual(getOverview(v.vaultPath, v.vaultPath));
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

  test("a schema-versioned-out database is rebuilt, not trusted", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    const dbPath = path.join(v.vaultPath, "cache", "overview-v1.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    // Simulate a same-name schema the store cannot read: bump user_version.
    // (Drop cached handles first so the file is free to be rewritten.)
    resetOverviewStoresForTests();
    const sqlite = SqliteOverviewStore.open(v.vaultPath);
    expect(sqlite).not.toBeNull();
    sqlite?.close();
    // Write the version marker by hand through a fresh connection is not
    // possible without node:sqlite access here, so flip bytes via the store
    // seam instead: a fully-garbage file also exercises the same ladder.
    fs.writeFileSync(dbPath, "this is not a sqlite database at all");
    // Remove the whole-result cache so the run must consult the store.
    fs.rmSync(path.join(v.vaultPath, "overview-cache.json"), { force: true });
    const second = getOverview(v.vaultPath, v.vaultPath);
    expect(second).toEqual(first);
    // The unusable file was parked aside and a fresh database built.
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(dbPath))
        .some((f) => f.startsWith("overview-v1.db.corrupt-")),
    ).toBe(true);
    expect(store(v).folderForTests("alpha")).toBeDefined();
  });

  test("an older user_version is parked and recreated", () => {
    const v = vault(FIXTURE);
    const first = getOverview(v.vaultPath, v.vaultPath);
    const dbPath = path.join(v.vaultPath, "cache", "overview-v1.db");
    resetOverviewStoresForTests();
    // Hand-build an "older" database: real SQLite file, wrong user_version,
    // no overview tables. The versioned file name would normally carry this,
    // but user_version is the second line of defence.
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

    const changed = getOverview(v.vaultPath, v.vaultPath, { keywords: 3 });
    expect(changed.overview.length).toBeGreaterThan(0);
    // No folder data rewritten: identical row counts, and the whole result is
    // unchanged versus a cold run under the same options.
    expect(s.inspectForTests()).toEqual(before);
    dropOverviewStoreFiles(v.vaultPath);
    expect(JSON.stringify(changed)).toBe(
      JSON.stringify(getOverview(v.vaultPath, v.vaultPath, { keywords: 3 })),
    );
  });
});
