---
tags: [changelog]
---

# 2026-01-10 Search rewrite

The rewrite replaced the content index with a per-query content scan: note
text is read from disk, counted, and dropped. Cold index build dropped from
eight seconds to under one on a large vault, and a process no longer pins
every note's text in memory.

Ranking itself is unchanged — the composite is still basename BM25, content
term frequency, backlinks and recency.
