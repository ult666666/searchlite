# searchlite

A full-text search engine for TypeScript with no runtime dependencies. It ranks documents with
BM25F, parses a query language (boolean operators, phrases, field scopes, prefix and fuzzy
terms), highlights matches and explains every score. It runs in Node and in the browser.

[![CI](https://github.com/ult666666/searchlite/actions/workflows/ci.yml/badge.svg)](https://github.com/ult666666/searchlite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)

[Try the live demo](https://ult666666.github.io/searchlite/): search a 60-entry glossary of
software, data and finance terms in your browser, with highlighted snippets and score
explanations.

## Install

searchlite is not on npm. Install it from the GitHub release, which also attaches a SHA-256
checksum (Node 20 or newer, ESM and CommonJS):

```bash
npm install https://github.com/ult666666/searchlite/releases/download/v0.2.0/searchlite-0.2.0.tgz
```

To build from source, clone the repository and run `npm ci && npm run build`, then
`npm install ../searchlite` from your own project.

## Quick start

```ts
import { SearchIndex, formatExplanation } from 'searchlite';

const index = new SearchIndex({
  fields: { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } },
});

index.addAll([
  {
    id: 'heap',
    title: 'Binary heap',
    body: 'A complete binary tree stored in an array, and the usual way to build a priority queue.',
    tags: ['data-structures'],
  },
  {
    id: 'trie',
    title: 'Trie',
    body: 'A prefix tree that shares common prefixes between strings, used for autocomplete.',
    tags: ['data-structures', 'strings'],
  },
  {
    id: 'npv',
    title: 'Net present value',
    body: 'Future cash flows discounted back to today, minus the initial investment.',
    tags: ['finance'],
  },
]);

for (const result of index.search('priority queue OR prefix*')) {
  console.log(result.id, result.score.toFixed(3), result.terms);
}
console.log(index.highlight('heap', 'body', '"priority queue"'));
console.log(formatExplanation(index.explain('heap', 'priority queue')));
```

Output (from `npx tsx examples/quick-start.ts`, which runs the same code against the source):

```text
heap 1.876 [ 'prioriti', 'queue' ]
trie 1.392 [ 'prefix' ]
A complete binary tree stored in an array, and the usual way to build a <mark>priority queue</mark>.
heap: score 1.876 (k1 = 1.2)
  priority [prioriti] 0.938 = idf 0.981 × saturation(tf̃ 0.923)
    body: tf 1, length 10 (avg 9), boost 1, b 0.75 → 0.923
  queue [queue] 0.938 = idf 0.981 × saturation(tf̃ 0.923)
    body: tf 1, length 10 (avg 9), boost 1, b 0.75 → 0.923
```

`prioriti` is the Porter stem of "priority". Documents and queries go through the same analysis,
so "priorities" would match too.

## Query syntax

| Syntax                                 | Meaning                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `cash flow`                            | Either word (OR is the default operator); documents with both rank higher |
| `cash AND flow`                        | Both words                                                                |
| `"cash flow"`                          | The exact phrase (stopword gaps are respected)                            |
| `risk -option`, `risk NOT option`      | Exclude documents that match `option`                                     |
| `(index OR tree) AND disk`             | Grouping; `NOT` binds tighter than `AND`, which binds tighter than `OR`   |
| `title:heap`, `tags:(finance OR risk)` | Restrict a term or a group to one field                                   |
| `hash*`                                | Terms starting with "hash"                                                |
| `volatlity~1`, `teh~2`                 | Terms within 1 or 2 edits (insert, delete, substitute, swap neighbours)   |

Operators must be upper case; lower-case `and`, `or` and `not` are ordinary words. A query made
only of exclusions (`-draft`) returns nothing, because exclusions only remove documents. Pass
`defaultOperator: 'AND'` to require every word. The grammar is in
[docs/DESIGN.md](docs/DESIGN.md#5-query-language).

## API sketch

```ts
const index = new SearchIndex({ fields, storeFields, k1, b, defaultOperator });
index.addAll(docs); // also add, remove and replace
index.search(query, { limit, fields, filter }); // [{ id, score, fields, terms, match }]
index.highlight(id, field, query); // HTML-escaped snippet with <mark> around matches
index.explain(id, query); // per-clause, per-field breakdown that sums to the score
index.searchHybrid({ query, vector, k }); // BM25F and cosine rankings fused with RRF
SearchIndex.fromJSON(index.toJSON()); // versioned snapshots
evaluate(run, qrels, { k }); // P@k, R@k, MRR, MAP and nDCG@k
```

[docs/API.md](docs/API.md) lists every export and option.

## How it works

Each field is scored with BM25F (Robertson and Zaragoza, 2009): per field,
`B_f = 1 − b_f + b_f · len/avglen`; the weighted, normalized frequencies are summed,
`tf̃ = Σ w_f · tf_f / B_f`, and saturated once, `score = idf · (k1 + 1) · tf̃ / (k1 + tf̃)`.
Phrases are matched by intersecting position lists. Prefix and fuzzy words expand through a trie
per field; fuzzy matching computes edit distance along trie paths instead of scanning every term.

Postings are stored as delta and variable-byte coded blocks of 128 documents. Queries run
document at a time: MaxScore (Turtle and Flood, 1995) sets aside clauses whose upper bounds
cannot lift a document into the current top k, and per-block upper bounds (Ding and Suel, 2011)
skip whole blocks. The bounds carry a small safety margin, so pruning never changes a result, and
property tests compare it with exhaustive scoring on random corpora and queries.
[docs/DESIGN.md](docs/DESIGN.md) covers the data structures, the formulas, the trade-offs, the
tests and the references.

## Evaluation

`npm run eval` indexes the glossary under several configurations, runs 22 queries and scores the
rankings against graded relevance judgements:

```text
Corpus: 60 documents, 22 queries, 51 graded judgements (1-3) by the author.
P@5, R@10 and nDCG@10 use those cutoffs; MRR and MAP use the top 100 results.
```

| Configuration                                             | P@5   | R@10  | MRR   | MAP   | nDCG@10 |
| --------------------------------------------------------- | ----- | ----- | ----- | ----- | ------- |
| BM25F, default analysis, boosts title 3 / tags 2 / body 1 | 0.364 | 0.904 | 1.000 | 0.811 | 0.927   |
| no stemming                                               | 0.355 | 0.870 | 0.977 | 0.785 | 0.904   |
| no stopword removal                                       | 0.373 | 0.919 | 1.000 | 0.833 | 0.936   |
| no field boosts (all weights 1)                           | 0.355 | 0.904 | 1.000 | 0.807 | 0.925   |
| single field (title + body + tags as one text)            | 0.364 | 0.904 | 1.000 | 0.811 | 0.925   |
| hybrid: default BM25F + toy trigram vectors, RRF          | 0.382 | 0.904 | 1.000 | 0.843 | 0.935   |

I wrote both the documents and the judgements, and the collection is small, so the table shows
that the harness works, not that one configuration is better. Most queries have one to three
relevant entries, which keeps P@5 well below 1. With 22 queries, a single query can explain gaps
this small. The trigram vectors capture spelling overlap rather than meaning; they only exercise
the hybrid code path. The [relevance workbench](https://ult666666.github.io/searchlite/relevance.html)
shows the comparison query by query ([guide](docs/RELEVANCE_WORKBENCH.md)).

## Performance

Compared with the term-at-a-time engine it replaced, on synthetic collections of 10,000
documents (a shared 4-CPU Linux machine, November 2, 2026):

| Synthetic workload, 10,000 documents | Median top-10 latency | Postings heap  | Snapshot size  |
| ------------------------------------ | --------------------- | -------------- | -------------- |
| Copies of the glossary               | 2.06 → 0.30 ms        | 35.0 → 3.29 MB | 8.07 → 5.63 MB |
| Zipf-distributed labels              | 8.48 → 0.57 ms        | 49.9 → 6.04 MB | 9.31 → 6.04 MB |

The gains are smaller at 1,000 documents, and one phrase-heavy query got slower.
[docs/EXECUTION.md](docs/EXECUTION.md#measured-results-november-2-2026) has the method, the
machine and the full results.

## Search your own files

[`examples/search-docs.js`](examples/search-docs.js) is a small command-line tool on top of the
built package. It indexes a folder of Markdown or text files into a snapshot, searches it, and
checks or compares saved indexes against relevance labels you write. The guides cover
[indexing and searching](docs/LOCAL_SEARCH.md), [evaluating](docs/LOCAL_RELEVANCE.md) and
[comparing](docs/LOCAL_COMPARISON.md). The
[local file workbench](https://ult666666.github.io/searchlite/local.html) runs comparisons in
the browser, and the [v0.2.0 release](https://github.com/ult666666/searchlite/releases/tag/v0.2.0)
includes an offline bundle of the tool ([notes](docs/RELEASING.md)).

## Development

```bash
npm ci
npm run check         # lint, format, typecheck, tests with coverage, builds and the demo
npm run eval          # the evaluation table above
npm run test:browser  # the demo's browser journeys (install Chromium first)
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) lists every script, what CI runs, how to run the
benchmarks and the source layout.

## Limits

- The index lives in memory in one thread, and the only persistence is a full JSON snapshot.
- Analysis is English-only: no stemmers for other languages, and no word segmentation for Chinese
  or Japanese.
- Block-max WAND is not implemented, and the performance numbers come from synthetic collections
  of at most 10,000 documents.
- Vector search is an exact linear scan over embeddings you supply.
- The evaluation collection is small and labelled by one person.

[docs/DESIGN.md](docs/DESIGN.md#13-trade-offs-and-limitations) covers the other trade-offs and
the roadmap.

Built with AI coding assistants. I reviewed the code and the tests that check it.

## License

[MIT](LICENSE) © 2026 Charles Dai
