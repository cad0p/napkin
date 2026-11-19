# Configuration

napkin uses a single config file at `.napkin/config.json`. CLI flags override config values. Changes sync automatically to `.obsidian/` for Obsidian compatibility.

## Commands

```bash
napkin config show                        # Show full config
napkin config get --key search.limit      # Get a specific value
napkin config set --key search.limit --value 50
```

## Reference

### overview

| Key | Default | Description |
|-----|---------|-------------|
| `overview.depth` | `3` | Max folder depth in vault map |
| `overview.keywords` | `8` | Max TF-IDF keywords per folder |
| `overview.collapse` | `true` | Roll up numerous, lexically similar sibling folders into one row |
| `overview.collapseDepth` | `2` | Minimum depth of a collapse target (parent) row; depth-1 rows never collapse |
| `overview.maxRows` | `100` | Cap on rows in the vault map (prevents huge outputs) |

### search

| Key | Default | Description |
|-----|---------|-------------|
| `search.limit` | `30` | Max results returned (total pool available across all pages) |
| `search.contextLines` | `5` | Context lines around matches. 0 = match-only |
| `search.resultsPerPage` | `10` | Max results returned per page. Use `--page N` to paginate. |
| `search.freshnessMs` | `0` | Freshness window for the search index walk. `0` = validate against disk on every search; N = reuse the index for N ms (see below) |
| `search.indexStore` | `"sqlite"` | Where the search index persists: `"sqlite"` keeps `.napkin/cache/index-v1.db` updated by per-file diff (one transaction per change; ~1 ms and ~30 KB for a single-file diff vs ~35 MB full rewrites). `"json"` uses the whole-snapshot `search-cache.json`. Falls back to JSON automatically when the database cannot be opened (read-only or network filesystem, no `node:sqlite`). Per-call SDK override: `search(q, { indexStore })` / `new Napkin(path, { searchIndexStore })` |

#### Search freshness

Every search validates its index by listing and statting the whole vault —
~0.4 s on a 28.7k-note vault, paid on every query. `search.freshnessMs`
bounds how often that walk runs in one process:

- **`0` (default)** — walk on every search, so a `napkin search` reflects the
  disk at the moment it runs. The CLI always behaves this way.
- **`N > 0`** — a search that starts less than `N` ms after this process's
  last walk reuses the index as-is: no directory listing, no per-file stat.

Writes made through napkin in the same process stay visible inside the window:
create, append/prepend, move/rename, delete, daily notes, template inserts,
frontmatter/property changes and task updates all record the path they wrote,
and the next search re-stats just those paths (a few stats, not a walk).
Writes made by a **different** process (the distill CLI, an editor, another pi
session) are visible after at most `N` ms.

The intended user is a long-lived library consumer that searches in a loop. Set
it per instance with `new Napkin(path, { searchFreshnessMs: N })` or per call
with `n.search(query, { freshnessMs: N })` — the per-call option wins, and both
override this config key.

### daily

| Key | Default | Description |
|-----|---------|-------------|
| `daily.folder` | `"daily"` | Folder for daily notes |
| `daily.format` | `"YYYY-MM-DD"` | Date format for daily note filenames |

### templates

| Key | Default | Description |
|-----|---------|-------------|
| `templates.folder` | `"Templates"` | Folder for note templates |

### graph

| Key | Default | Description |
|-----|---------|-------------|
| `graph.renderer` | `"auto"` | How to render the graph. `auto` uses Glimpse on macOS, browser elsewhere. `glimpse` forces native window. `browser` forces browser |

### ignore

| Key | Default | Description |
|-----|---------|-------------|
| `ignore.respectGitignore` | `true` | Honor `.gitignore` at the vault root (gitignore-style patterns) |
| `ignore.dotfiles` | `true` | Exclude dot-prefixed files and folders (Obsidian "hidden files" parity) |

## Ignore rules

napkin can exclude files and directories from enumeration (search, overview,
links, tags, tasks, templates, graph, file listings, …) and from
basename/wikilink resolution. Three sources are unioned — a path is ignored
when **any** of them matches, all evaluated on **vault-relative** paths:

1. **`.napkinignore`** — a gitignore-style pattern file at the vault root,
   always honored when present (an empty file is a no-op). No config flag;
   presence-based.
2. **`.gitignore`** — the vault-root file, honored when
   `ignore.respectGitignore: true` (default). Only the vault root is
   consulted: nested `.gitignore` files and monorepo roots above the vault
   do **not** apply.
3. **Dotfiles rule** — `ignore.dotfiles: true` (default) excludes
   dot-prefixed entries, files **and** folders. When `false`, dotfiles and
   dotdirs surface everywhere.

Pattern semantics are gitignore's: `*`, `**`, trailing-slash dir-only
patterns, comments, and negation (`!`). Negation works **within** each
source — a `.napkinignore` line cannot un-ignore a file matched by
`.gitignore` (and neither can un-ignore the dotfiles rule).

```bash
# .napkinignore at the vault root
# Ignore a file
private-notes.md

# Ignore a directory (and everything under it)
build/

# Ignore by extension anywhere
*.tmp

# Keep something matched above
!important.tmp
```

### Read semantics

Ignore is **index-only**: ignored files are excluded from enumeration and from
basename/wikilink resolution, so `napkin read "Note"` on an ignored note says
not found. The escape hatch is an **exact path** — `napkin read <path>` works
regardless of ignore state (an explicit path is an explicit intent).
`linksBack` and backlinks treat ignored files as nonexistent.

Templates resolve via the constructed exact path `Templates/<name>` (the
configured `templates.folder`), so an ignored template is still readable and
insertable by bare name while staying hidden from `napkin template list`.

With `ignore.dotfiles: false`, `.gitignore` appears in `napkin file list` and
vault size — it is a user file like any other. `.napkinignore`, by contrast,
is napkin-internal and stays hidden from listings regardless of the dotfiles
rule.

Changing the config or either ignore file invalidates the search cache (the
cache embeds an ignore fingerprint), so results reflect the new state without
manual invalidation.

### distill

The `distill.*` keys are consumed by the **pi-napkin distill extension**, not by
this CLI — see [docs/distill.md](distill.md) for the full key reference. The
CLI itself ignores them (they are safe to keep in the vault config).

## Precedence

CLI flags > `config.json` > hardcoded defaults

## File location

```
project/
  .napkin/
    config.json            # This file
    search-cache.json      # Search index cache (auto-managed)
    overview-cache.json    # Overview result cache (auto-managed)
    .obsidian/             # Auto-synced from config.json
  .napkinignore            # Optional: gitignore-style ignore patterns
  .gitignore               # Optional: respected when ignore.respectGitignore is on
```

The cache files are keyed by a fingerprint of vault file mtimes and rebuild
automatically; they are safe to delete at any time.

Config is created on first `napkin config set` or `napkin init`. If the file doesn't exist, defaults are used.

## Global config fallback

When no vault is found from the current directory, napkin falls back to a
user-level config that can point at a default vault:

```
$XDG_CONFIG_HOME/napkin/config.json   # defaults to ~/.config/napkin/config.json
```

```json
{
  "vault": "~/projects/my-vault"
}
```

`~` is expanded; other relative paths resolve against the config file's
directory. **`napkin init` writes this file automatically** when it creates
a vault and no usable default exists yet (missing config, missing `vault`
field, or a stale path) — so the first vault on a machine becomes the
default, and commands work from any directory afterwards. An existing valid
default is never overwritten: it's an explicit user choice.

To unset the default, delete the `vault` field from this file (or the whole
file). A global config that fails to parse as JSON is treated as absent —
`napkin init` writes a fresh one on the next run.

The `vault` field is resolved against the config directory (or `~` for home).
It is only used to locate a vault when no `.napkin/` is discoverable upward
from the working directory.

The global vault can never point at `$HOME` (or `$HOME/.napkin`): home is
never a valid vault root, and a vault there would resolve for every cwd
under it. Such a `vault` value is ignored (and `napkin init` refuses to
write it). Keep vaults in a project/dev directory (e.g. `~/Notes`, a repo,
or a dedicated vault folder) instead.
