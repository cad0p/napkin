# Overview — Keyword Extraction

The `napkin overview` command generates a vault-wide index by extracting distinctive keywords per folder using TF-IDF with source weighting and bigram support.

## Pipeline

```
Files → Group by folder → Collect weighted text → Build TF → Collapse homogeneous siblings → Compute IDF across folders → Score TF-IDF → Deduplicate bigrams → Top N keywords
```

The whole pipeline runs behind an mtime-fingerprint cache (see
[Caching](#caching)); a cache hit skips everything below.

### 1. Text Collection & Weighting

Not all text is equal. Sources are weighted by signal strength:

| Source | Weight | Rationale |
|--------|--------|-----------|
| Headings | 3x | Curated by the author, high intent |
| Filenames | 2x | Chosen names are strong signals |
| Frontmatter title | 2x | Explicit metadata |
| Other frontmatter values | 2x | Explicit metadata (wikilink-only and date values excluded) |
| Body text | 1x | Bulk content, noisier |

### 2. Noise Stripping

Before tokenization, we strip:
- URLs (`https://...`) and emails
- Code blocks (fenced and inline)
- HTML tags and entities (residue of converted documents)
- Hex hashes (commit SHAs), dashed GUIDs (`AAAA1111-2222-...`), and
  mixed-digit blobs (`INV20240915X`) — ID shrapnel from OCR'd PDFs and
  DocuSign-style exports that would otherwise pollute keywords

Each pattern only runs when a cheap necessary condition holds (an email
needs `@`, a URL needs `http`), so clean prose skips the regex scans.

### 3. Tokenization

- Lowercase, alpha-only, 3+ characters
- Filtered against a stop word list (~120 common English words)

### 4. Bigram Extraction

Two-word phrases are extracted alongside unigrams. Bigrams are kept only if:
- They appear **2+ times** in the folder (otherwise likely noise)
- The two words are **not identical** (filters "tbd tbd" type garbage)

### 5. Homogeneous-Sibling Collapse

Parents with 5+ children whose body-term distributions are lexically
similar (mean pairwise cosine ≥ 0.15 over top terms) are rendered as one
aggregate row — `imports/ (+6 similar subfolders)` — so imported document
dumps don't drown the overview. Similarity uses body text only, so shared
filename conventions cannot fake content homogeneity. Top-level folders
never collapse into the root. Disable with `--no-collapse`.

### 6. TF-IDF Scoring

Each folder is treated as a "document":

- **TF** = weighted term frequency within the folder
- **IDF** = `log(1 + totalFolders / foldersContainingTerm)`

The `1 +` dampening prevents over-penalizing terms that appear in a few folders. A word in 3 out of 9 folders still gets reasonable weight, while a word in all 9 gets suppressed.

Candidates are also filtered for corroboration — a term must appear outside
headings or in 2+ heading lines (single heading-only terms are usually
section labels like "Notes") — and terms matching the folder's own name
(including singular/plural variants) are excluded as redundant.

### 7. Bigram Deduplication

When a bigram is selected (e.g., "knowledge base"), its constituent unigrams ("knowledge", "base") are suppressed from the results. This prevents redundant keyword slots.

## Caching

The final result is cached in `.napkin/overview-cache.json`, keyed by a
vault fingerprint (file paths + mtimes) plus the resolved options.
Any file add, remove, or touch — including `NAPKIN.md` — invalidates it;
so does changing `depth`, `keywords`, `collapse`, `collapseDepth`, `maxRows`, or `templates.folder`. A cache hit costs one
stat pass instead of reading and tokenizing every note (~25ms vs ~1s on a
5,000-note vault). Corrupt cache files are ignored and rebuilt.

The walk is bounded to the configured `depth`: notes in deeper folders can
never reach the output, so they are not walked, not statted, and do not
invalidate the cache (#117).

On a miss, the per-folder data comes from
`.napkin/cache/overview-v3.db` (#118, #125, #126): one row per note holding
that note's term data as an Int32 blob, plus SQL rows per folder term
(weights, heading counts, first-seen keys), keyword candidates in tf
order, and per-term document frequency. A changed note costs a
re-tokenization of that note plus a per-note delta on the rows of the terms
it touches — the first-seen keys reproduce the exact term order a cold
build produces — and keywords are scored with a top-k query per shown
folder. The schema-v1 store of older versions (`overview-v2.db`) is
migrated into a copy on first use and left in place for them. The JSON
`overview-folders-cache.json` remains only as the fallback for
environments where `node:sqlite` is unavailable.

A cold build (first run, a new store format, or an ignore/templates
change) and any folder with no stored rows are built in batches (#131):
up to 256 notes or 65,536 distinct terms are tokenized, interned through
SQL in one lookup (a 2 MB Bloom filter skips the lookup for terms the
build has never seen), and aggregated per folder in typed arrays before
the folder's rows are bulk-inserted in term-id order. There is no
in-memory term dictionary, so memory stays bounded by one batch and one
folder rather than by the vault: on a 29.5k-note vault the cold build
peaks around 210–250 MB instead of ~600 MB with the flags pi-napkin runs
the overview child with (`--max-semi-space-size=2`, `MALLOC_ARENA_MAX=1`);
with V8's default young generation the peak is higher (279 MB on a
synthetic 30k-note vault with 1.47M terms). Document frequency is counted
once at the end with one `GROUP BY`, and the build runs with a 16 MB page
cache for its transaction only.

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--keywords <n>` | 8 | Max keywords per folder |
| `--depth <n>` | 3 | Max folder depth to index |
| `--no-collapse` | collapse on | Disable homogeneous-sibling collapse |

## Example

```
Resources/Runbooks/
  keywords: remote, vercel, context, runbook, auth, handoff, rule, pipeline
  notes: 6
```

"runbook" appears here because it's distinctive to this folder (high IDF), while "notes" — which appears in every folder — is suppressed.
