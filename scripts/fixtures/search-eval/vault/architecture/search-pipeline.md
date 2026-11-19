---
tags: [search, architecture]
---

# Search pipeline

A query hits the basename index first (BM25 over filenames), then the content
scan reads each note from disk and counts term frequency. The composite score
adds basename relevance, content matches, backlink count and recency.

Backlinks and recency are whole-vault signals: a note linked from many places
ranks above an equally matching island, and a recently edited note edges out a
stale one. See [[cache-invalidation]].
