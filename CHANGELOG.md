# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
