---
tags: [guide, benchmark]
---

# Running benchmarks

Benchmarks and the eval harness both want a frozen vault: record a baseline,
change the code, then compare. Re-recording after every note edit defeats the
purpose — the baseline carries a vault fingerprint for exactly this reason.

The harness reports recall, top-k overlap and rank-biased overlap, plus
latency and peak RSS.
