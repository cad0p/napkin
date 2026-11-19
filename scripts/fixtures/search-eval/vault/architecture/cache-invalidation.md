---
tags: [cache, architecture]
---

# Cache invalidation

The search cache is a full snapshot of the basename index plus file metadata.
Invalidation is an mtime and size diff: changed files are re-read, removed
files are discarded, and backlinks are recomputed in memory.

The cache never stores note text. Dropping the cache is always safe — the next
query rebuilds it from the vault.
