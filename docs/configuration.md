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

The `vault` field is resolved against the config directory (or `~` for home).
It is only used to locate a vault when no `.napkin/` is discoverable upward
from the working directory.
