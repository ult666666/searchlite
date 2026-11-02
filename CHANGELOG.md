# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Document-at-a-time top-k evaluation. A top-level OR runs MaxScore (Turtle and Flood, 1995) in
  windows that end at block boundaries, with block-max upper bounds from per-block impacts (Ding
  and Suel, 2011); single clauses, AND, prefix and fuzzy queries skip whole blocks the same way.
  Results equal exhaustive scoring exactly: the same documents, order and scores bit for bit. A
  relative margin of 1e-9 on every bound keeps floating-point rounding from pruning a document
  that belongs in the top k, and absurd parameters that make a bound infinite fall back to
  exhaustive scoring.
- Compressed postings: sorted blocks of 128 documents, delta and variable-byte coded, with skip
  entries and a Pareto frontier of (frequency, length) impacts per block. Small lists share one
  byte arena per field; lists past 4 KiB get their own buffer.
- `search(query, { filter })` drops documents by id and stored fields before they enter the top
  k, without changing scores or IDF.
- Snapshot version 2 stores postings as base64 varints. Version 1 snapshots still load, so
  `SearchIndex.fromJSON(old).toJSON()` migrates one; a fixture written by 0.2.0 must give
  identical results.
- `npm run bench:pruning` measures two builds side by side (top-10 latency, index heap, postings
  heap from a V8 heap snapshot, snapshot size) and reports only if their rankings match;
  `npm run test:pruning` runs its smoke profile in CI.
- Property tests that compare pruned top k with exhaustive scoring over random corpora, queries,
  options, filters and mutations, model-based postings tests, and codec tests against the
  Protocol Buffers and RFC 4648 examples.

- Local-file browser workbench: two actual saved indexes and shared labels, native-format comparison
  JSON, per-query inspection, synthetic input downloads, offline-after-load execution and owned
  worker cancellation/deadlines. Files remain in memory without storage, URLs or upload.
- Shared private example evaluation/comparison core, preserving legacy CLI bytes/exits and included
  explicitly in future source-built portable bundles. Existing v0.2.0/tag assets remain unchanged.

### Changed

- `IndexSnapshot.postings` is now `[term, base64][]` per field (the old shape is exported as
  `IndexSnapshotV1`) and `SNAPSHOT_VERSION` is 2. Version 1 snapshots with empty, unsorted or
  repeated positions, which searchlite never wrote, are now rejected.
- `explain`, `highlight` and the matched terms of each result look single documents up in the
  postings instead of building occurrence tables for term clauses.
- Browser tests compare downloaded reports with native output by text and by number (within
  1e-12) instead of byte for byte. JavaScript engines can round `Math.log` and `Math.log2`
  differently in the last place, so BM25F scores and nDCG values may differ in their final
  digits. The browser tests now run on Playwright 1.63.0 (Chromium 153), where some
  BM25F scores differ from Node's in the last digit.
- The README leads with the library and its live demo; the local-search limits moved to
  `docs/LOCAL_SEARCH.md`.

## [0.2.0] - 2026-10-26

### Added

- Offline-installable GitHub local-review bundle with exact public-source payload, byte
  manifests, maintained builder and actual empty-cache install/CLI checks on Node 20/22/24.
- Browser relevance workbench with shared native comparison JSON, per-query regressions,
  rankings, labels and downloadable inputs.
- Local snapshot evaluation against explicit per-query labels/minima, exact used-byte hashes
  and distinct valid unmet-criterion exits.
- Same-collection local index comparison through built public exports, with shared labels,
  exact input hashes, per-query metric deltas and a minimum-plus-non-regression gate.
- A bounded paired-build benchmark with complete/top10 ranking digest parity, fixed query
  controls, raw per-query timings, trusted-code inputs and actual worker failure tests.
- Candidate-aware AND/exclusion scoring that retains global IDF, addition/tie order and exact
  public results while avoiding irrelevant normalization and negative-clause traces.

- A runnable local-document consumer using built public package exports: bounded, deterministic
  UTF-8 Markdown/text indexing, persisted JSON snapshot search, plain safe snippets and score
  explanations. Real CLI tests cover temporary corpora, roundtrips, input preservation,
  overwrite refusal, filesystem/size boundaries and terminal-safe output.

### Fixed

- Finite-vector cosine overflow/underflow and wrong nearest-neighbor ordering, with an ordinary
  fast path and a scaled compensated fallback; independent Decimal conformance fixtures.
- Sparse vectors accepted by skipped-hole validation: document/batch/replacement/query/snapshot
  boundaries now reject missing components before state changes.

## [0.1.0] - 2026-10-23

### Added

- Text analysis: Unicode NFKD normalization with combining marks removed, lowercasing, a
  tokenizer that keeps positions and source offsets, English stopwords and a Porter (1980)
  stemmer, configurable per field.
- `SearchIndex` with multi-field documents, per-field boosts, a positional inverted index, a
  document store, `add`/`addAll`/`remove`/`replace` with incrementally maintained statistics,
  and versioned `toJSON()`/`SearchIndex.fromJSON()` snapshots.
- BM25F ranking (configurable `k1` and `b`, per-field `b`) with top-k selection on a binary heap.
- Query language: terms, phrases, `AND`/`OR`/`NOT`, `-term`, parentheses, `field:` scopes,
  `prefix*` and `fuzzy~N` (optimal string alignment distance over a trie), a configurable default
  operator and errors that report the column.
- `highlight()` snippets with HTML escaping, `explain()` score breakdowns and
  `formatExplanation()`.
- `searchHybrid()` fusing BM25F and cosine-similarity rankings with Reciprocal Rank Fusion.
- `evaluate()` with precision@k, recall@k, MRR, MAP and nDCG@k.
- A 60-entry glossary corpus with 22 judged queries, `npm run eval`, and a Vite web demo.
