# Changelog

All notable changes to this project will be documented in this file.

## [0.10.0] - 2026-08-01

<!-- USER-EDITABLE SECTION START -->
Search performance rewrite: `napkin search` now returns results on large
vaults within seconds — the previous implementation could take minutes.

### Highlights

- **Search is now interactive on large vaults.** On a 2714-file / 70MB vault
  (the Goldmine reference), cold search went from **3m55s → ~2.5–3.9s**,
  warm from 4.9s → ~2.0–3.4s, and touch-one-file from **3m51s → ~2.1s**.
  The target: **≤5s** for all three, met.
- **Scales linearly, not quadratically.** The backlink computation was
  fused into the index build (removing an O(n²) walk — ~4 min of per-link
  `listFiles`). Latency-vs-vault-size grows extremely slowly (search work
  ~0.25ms/file cold, ~0.08ms/file warm; a 10k-file vault extrapolates to
  ~4.1s cold).
- **Incremental reindexing.** Only changed files are re-indexed after a
  note edit (touch-one-file: 3m51s → ~2.1s) instead of the whole vault.
- **Smaller cache.** The on-disk search cache shrank 17.5MB → 2.2MB.

### How it works

- MiniSearch now indexes **basenames only** (~70ms build) instead of full
  content (~12s); content is matched at query time via an in-memory
  case-insensitive substring scan (~100ms over 27MB). Ranking is preserved:
  `bm25 × 2 + tf × 0.05 + backlinks × 0.5 + recency × 1.0`.
- Index staleness detection now keys on **mtime + size** (ext4/tmpfs report
  the same `mtimeMs` for rapid successive writes, which mtime-only diffing
  missed — same-tick edits now invalidate correctly).
- A module-scope memory cache persists the index across in-process calls
  (the pi extension path gets ~230ms warm searches).

### Upgrade notes

- Behavior- and API-compatible. Search results, ranking, `--page`/`--limit`
  and `--section` work as before; only internals + speed changed.
- If you hit the rare same-tick same-size edit (identical byte length within
  the same mtime tick), the index may be stale until the next touch that
  changes size — an accepted tradeoff to keep the warm path free of full
  content reads.

<!-- USER-EDITABLE SECTION END -->

### ⚡ Performance

- *(search)* Approach G — basename-only MiniSearch + substring content scan; incremental mtime+size diff; fused backlinks; memory cache ([#19](https://github.com/cad0p/napkin/pull/19))

### ⚙️ Miscellaneous Tasks

- Add AGENTS.md with project onboarding instructions ([#17](https://github.com/cad0p/napkin/pull/17))


## [0.9.0] - 2026-07-21

<!-- USER-EDITABLE SECTION START -->
First release on the `@cad0p/napkin` scoped package to ship on the same
pnpm + vitest stack as `@cad0p/pi-napkin`, and the first to bring in
upstream `Michaelliv/napkin` changes since the fork diverged.

### Highlights

- **Synced with upstream v0.9.0** — noise-robust overview (structured-noise
  stripping + homogeneous-sibling collapse), `napkin update` self-update
  command, ESM-safe `graph` command, and warnings moved to stderr so
  `--json` output is always parseable.
- **Progressive disclosure API refinements** — search pagination (`--page`)
  and section reads (`--section`) for token-efficient vault access.
- **Migrated from bun to pnpm + vitest** — standardizes the toolchain
  across the cad0p fork, removes the bun runtime dependency, and drops
  the dead `build:bun*` standalone-binary scripts and `tsc`/`dist` build
  target (the package ships `src/` + `bin/napkin.js`, not `dist/`).
- **Runs TypeScript sources directly** — no committed `dist/`; the `napkin`
  bin is a tiny jiti launcher that loads `src/` directly under node.

### Upgrade notes

- **`overview.collapse`** now defaults to `true`. Real-world vaults with
  imported/converted document subtrees (OCR'd PDFs, DocuSign exports) get a
  dramatically cleaner overview. Pass `--no-collapse` to opt out.
- The `overview --json` output gains an additive `collapsedFolders` field
  (only present when a folder rolls up subfolders).
- `napkin update` runs `pnpm add -g @cad0p/napkin@latest` (or `npm install`
  as fallback) — no external dependency on bun.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Run TypeScript sources directly, drop committed dist
- Progressive disclosure API refinements (search pagination & section read) ([#10](https://github.com/cad0p/napkin/pull/10))
- Sync with upstream Michaelliv/napkin (v0.8.2 - v0.9.0) ([#14](https://github.com/cad0p/napkin/pull/14))
- Noise-robust overview with homogeneous-sibling collapse
- `napkin update` self-update command (pnpm preferred, npm fallback)
- ESM-safe `graph` command
- Warnings moved to stderr so `--json` stays parseable

### 📚 Documentation

- *(readme)* Install from the @cad0p scope, show both pnpm and npm
- *(readme)* Point pi-napkin reference at cad0p fork

### ⚙️ Miscellaneous Tasks

- Migrate from bun to pnpm + vitest, drop dead build scripts ([#15](https://github.com/cad0p/napkin/pull/15))
- Drop `build:bun*` standalone-binary scripts and `tsc`/`dist` build target
