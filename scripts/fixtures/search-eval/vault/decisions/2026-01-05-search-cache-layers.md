---
tags: [decision, cache, search]
---

# 2026-01-05 Search cache layers

We keep two cache layers: an in-memory index for the life of the process, and
a JSON snapshot on disk for the next process. The snapshot is written at most
once every thirty seconds (leading edge immediate, trailing write coalesced).

Alternative rejected: a SQLite store. It is a separate issue, and the store
seam does not change ranking.
