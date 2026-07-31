# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

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
