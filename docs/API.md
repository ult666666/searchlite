# searchlite API

Every export has TSDoc comments that explain the algorithm and cite its source. This page lists
the public surface; [DESIGN.md](DESIGN.md) explains how each part works.

| API                                                                                                                            | Purpose                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `new SearchIndex(options)`                                                                                                     | `fields` (each with `boost`, `b`, `stemming`, `stopwords`), `storeFields`, `idField`, `vectorField`, `k1`, `b`, `defaultOperator` |
| `add(doc)`, `addAll(docs)`, `remove(id)`, `replace(doc)`                                                                       | Maintain the index; `addAll` is atomic, `replace` keeps the document's tie-break position                                         |
| `search(query, { limit, fields, defaultOperator, maxExpansions, filter })`                                                     | Ranked results: `id`, `score`, stored `fields`, matched `terms`, and `match` (terms per field)                                    |
| `highlight(id, field, query, { maxLength, ellipsis })`                                                                         | HTML snippet of a stored field with `<mark>` around matches                                                                       |
| `explain(id, query)` and `formatExplanation(explanation)`                                                                      | Score breakdown per clause and field; its total equals the `search` score                                                         |
| `searchHybrid({ query, vector, k, depth, rrfK })`                                                                              | BM25F and cosine-similarity rankings fused with Reciprocal Rank Fusion                                                            |
| `toJSON()`, `SearchIndex.fromJSON(data)`, `stats()`, `size`, `has(id)`, `get(id)`                                              | Snapshots and introspection                                                                                                       |
| `parseQuery(text, { defaultOperator, fields })`                                                                                | The typed query AST, e.g. for rewriting queries in a UI                                                                           |
| `evaluate(run, qrels, { k })`, `precisionAtK`, `recallAtK`, `reciprocalRank`, `averagePrecision`, `ndcgAtK`                    | Retrieval metrics                                                                                                                 |
| `Analyzer`, `porterStem`, `tokenize`, `normalizeText`, `osaDistance`, `cosineSimilarity`, `reciprocalRankFusion`, `escapeHtml` | Building blocks, exported for reuse and testing                                                                                   |
| `SearchliteError` (with `code`), `QuerySyntaxError` (with `column`)                                                            | Typed errors thrown for invalid options, documents, queries and snapshots                                                         |

## Options worth knowing

- Each field takes its own `boost`, `b`, `stemming` and `stopwords`. Turning stemming off suits
  tags and identifiers.
- `search(query, { filter })` keeps only documents that pass a predicate. It never changes a
  score.
- `searchHybrid` fuses BM25F with cosine similarity over embeddings you supply, using Reciprocal
  Rank Fusion. Vectors of very large or very small magnitude use a scaled cosine; sparse and
  nonfinite vectors are refused before indexing ([VECTOR_NUMERICS.md](VECTOR_NUMERICS.md)).
- `toJSON()` writes a versioned snapshot. Version 2 stores the compressed postings as base64, and
  version 1 snapshots from 0.2.0 still load with identical results.
- Errors are typed: `SearchliteError` carries a `code`, and `QuerySyntaxError` the `column` where
  parsing failed.
