# Changelog

All notable changes to this project will be documented in this file.

## [0.12.1] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
Paginated reads never exceed the advertised page size: the always-appended page
hint + outline nudge are now budgeted with the exact worst-case hint for the
actual page-count magnitude. Previously the reserve assumed at most 6-digit page
counts, so files with >= 1,000,000 pages (> ~50GB) emitted pages 1 char over
`pageSize`. Byte-identical output for page counts <= 999999.
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- *(crud)* Reserve exact worst-case page hint for >6-digit page counts ([#40](https://github.com/cad0p/napkin/pull/40))

### ⚙️ Miscellaneous Tasks

- Give validate workflows distinct job names ([#39](https://github.com/cad0p/napkin/pull/39))


## [0.12.0] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
The vault overview now protects the top-level taxonomy: `overview.collapseDepth`
(default 2) restricts homogeneous-sibling collapse to merge targets at depth ≥ 2,
so curated namespaces (e.g. `amazon/`, `open-source/`) always render their real
children instead of one rolled-up row. A new `overview.maxRows` (default 100,
0 = unlimited) caps the listing at the most relevant folders — rows sort by
depth, then note count desc, then path — and truncated listings report exactly
how many rows/notes were dropped (`VaultOverview.truncated`), so consumers can
print an honest footer.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Overview collapseDepth + maxRows — taxonomy-safe collapse and row cap ([#37](https://github.com/cad0p/napkin/pull/37))

### 📚 Documentation

- Point AGENTS.md kanban check at gh project ([#35](https://github.com/cad0p/napkin/pull/35))

### ⚙️ Miscellaneous Tasks

- *(release)* From v0.11.1 (TBD) ([#36](https://github.com/cad0p/napkin/pull/36))


## [calver-released]

<!-- USER-EDITABLE SECTION START -->
The vault overview now protects the top-level taxonomy: `overview.collapseDepth`
(default 2) restricts homogeneous-sibling collapse to merge targets at depth ≥ 2,
so curated namespaces (e.g. `amazon/`, `open-source/`) always render their real
children instead of one rolled-up row. A new `overview.maxRows` (default 100,
0 = unlimited) caps the listing at the most relevant folders — rows sort by
depth, then note count desc, then path — and truncated listings report exactly
how many rows/notes were dropped (`VaultOverview.truncated`), so consumers can
print an honest footer.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Overview collapseDepth + maxRows — taxonomy-safe collapse and row cap ([#37](https://github.com/cad0p/napkin/pull/37))

### 📚 Documentation

- Point AGENTS.md kanban check at gh project ([#35](https://github.com/cad0p/napkin/pull/35))


## [0.11.1] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
Paginated reads (kb_read / napkin read --page) now stay within the advertised
page size: the page hint and the always-on outline nudge are reserved inside
the chunk budget instead of being appended on top, so page output never
exceeds 50,000 chars.
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- Budget page hint + outline nudge into read page size ([#34](https://github.com/cad0p/napkin/pull/34))

### 📚 Documentation

- Point AGENTS.md vault check at kb tools ([#31](https://github.com/cad0p/napkin/pull/31))
- Make AGENTS.md bootstrap mandatory for every request ([#33](https://github.com/cad0p/napkin/pull/33))


## [0.11.0] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Always nudge toward outline (search pagination + multi-page reads) ([#27](https://github.com/cad0p/napkin/pull/27))

### 📚 Documentation

- *(changelog)* Changes from v0.10.1 to v0.10.1-20260807.0 ([#29](https://github.com/cad0p/napkin/pull/29))

### ⚙️ Miscellaneous Tasks

- Re-trigger release after GitHub Actions outage ([#28](https://github.com/cad0p/napkin/pull/28))

## [0.10.1] - 2026-08-03

<!-- USER-EDITABLE SECTION START -->
Critical hotfix for the warm-path search regression introduced in 0.10.0.
After the first cold search built the on-disk cache, every subsequent search
silently lost all content matches (returned only basename hits — e.g. 22
results instead of 388 on a large vault). See #22 for the deep A-vs-B
analysis.
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- *(search)* Restore warm-path content recall by persisting content in cache ([#22](https://github.com/cad0p/napkin/pull/22)) ([#23](https://github.com/cad0p/napkin/pull/23))


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

### 🐛 Bug Fixes

- *(search)* Biome lint — drop unused import, organize imports, avoid assign-in-expression in contentScan ([#21](https://github.com/cad0p/napkin/pull/21))

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
