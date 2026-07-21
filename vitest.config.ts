import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Mirror the old `bun test` discovery surface: every *.test.ts under
    // src/. tsx resolves extensionless TS imports.
    include: ["src/**/*.test.ts"],
    // Default pool (forks) runs each test file in its own process in
    // parallel. napkin's tests are parallel-safe: createTempVault() makes
    // a per-test mkdtempSync under os.tmpdir(), and the search cache lives
    // inside each vault (not a shared tmpdir location). No test scans
    // os.tmpdir() for sibling entries, so no singleFork isolation is
    // needed. Tests within a file still run sequentially by default.
    testTimeout: 5_000,
  },
});
