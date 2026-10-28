# Inspect a relevance change before trusting an average

For your own saved document collection, use the separate [local labelled-question evaluation](LOCAL_RELEVANCE.md) workflow. This page keeps its fixed public glossary and accepts no uploads.

[Open the workbench](https://ult666666.github.io/searchlite/relevance.html). Select a baseline and candidate, then inspect the queries behind an aggregate metric. The workbench runs the actual searchlite engine locally over the existing authored glossary. It neither calls a provider nor imports private data.

Try **BM25F** against **no stemming**. The collection mean nDCG@10 is about 0.927 versus 0.904, but an average alone hides individual changes. Inspect q01 to see its ranked answers and grades, then q22 to see a short three-result ranking whose P@5 is 0.200: only one result is relevant and the denominator stays 5. Swap the configurations to reverse the deltas, or select the same configuration on both sides to get zero deltas. These examples explain this collection; they do not establish which configuration is best for another task.

The overview retains every query in collection order. Each **Inspect** button moves focus to the labelled query selector, so keyboard users can inspect without returning through all previous rows. Query details show the top 10, raw scores with their units, grades and relevant documents missing from the top 10. Tables scroll inside their own labelled regions on narrow screens. Baseline/candidate/query IDs are kept in the URL for sharing and reload; unsupported values show a notice and use defaults for the unsupported selections.

**Download comparison JSON** includes all 60 source documents, 22 queries, 51 judgments, selected configuration identities/options, full retrieved rankings (up to 100), raw scores, per-query metrics, aggregate metrics and candidate-minus-baseline deltas. Selecting a different query changes only the inspected view, not the report. Changing a configuration recomputes both rankings and metrics and replaces the download. JSON retains full numeric precision; the page rounds metric cells to three decimals. It contains no clock/random fields and does not claim authenticated provenance.

## Native reproduction

Use Node 20.19+ or 22.12+ for the current Vite development toolchain (CI also runs 24). The zero-runtime-dependency library and native examples retain their declared Node 20+ floor. In a source checkout:

```sh
npm ci
npm run --silent eval:compare -- --baseline=bm25f --candidate=no-stemming
```

The command prints only JSON on stdout when invoked with npm's **--silent** flag. Ordinary npm adds its own banner, so its stdout is not the report alone. You can save to an explicitly new temporary directory:

```sh
searchlite_comparison_dir=$(mktemp -d)
npm run --silent eval:compare -- --baseline=bm25f --candidate=no-stemming > "$searchlite_comparison_dir/comparison.json"
```

The command itself reads no input files and writes no output files. It accepts only the two fixed-configuration flags, each at most once, or standalone `--help`. Unknown IDs, duplicate flags and mixed help exit 2 with bounded usage text; raw supplied arguments are not echoed. Success exits 0. The supported IDs are:

| ID           | Existing configuration                                              |
| ------------ | ------------------------------------------------------------------- |
| bm25f        | Title boost 3 / tags boost 2 / body boost 1; default analysis       |
| no-stemming  | Disable stemming for all fields                                     |
| no-stopwords | Keep stopwords in all fields                                        |
| no-boosts    | All field weights 1                                                 |
| single-field | Concatenate title, body and tags into one field                     |
| toy-hybrid   | Default BM25F plus hashed character-trigram vectors, fused with RRF |

The shared `corpus/retrieval.ts` implementations also power the unchanged `npm run eval` table. `examples/relevance-comparison.ts` composes the public engine/metric functions; it is a source consumer, not a new installed-package export. Its report schema is `searchlite.relevance-comparison/1`. It copies exported input objects so editing a report cannot alter future evaluations. The browser test compares every download with native stdout for the same selection. The text must match exactly apart from numbers, integers must be identical, and other numbers must agree within 1e-12 × max(1, |value|). Bytes can differ because JavaScript engines may round `Math.log` (used by BM25F scores) and `Math.log2` (used by nDCG) differently in the last place; Chromium 153, for example, rounds some of these scores differently from Node 22 and 24.

## Metric and interpretation boundaries

- **P@5:** relevant hits in the top 5 divided by 5, including empty slots. **R@10:** relevant hits in the top 10 divided by all relevant judgments.
- **nDCG@10:** the existing linear grade gain with log₂(rank+1) discount, normalized by ideal judged order. **MRR/MAP:** computed over the full retrieved ranking, up to 100, rather than truncating at 10.
- Grades 3/2/1 mean directly/substantially/partly relevant. Unlisted documents receive 0 under this collection's judgments. Query text runs literally; the search demo's final-word prefix completion is not applied.
- Raw BM25F scores are comparable within one query/configuration. Toy-hybrid RRF scores have different units. Compare ranks and relevance metrics across configurations, not raw score subtraction.
- This is a tiny, single-annotator, authored demonstration. Configurations were fixed before evaluation. A difference can come from one query. There is no statistical significance or general-quality claim, no production traffic, and no external benchmark.
- The toy vector path captures **spelling overlap, not meaning**. It is not a semantic embedding model and adds no provider integration. Original engine formulas, judgments and corpus text are unchanged.

The browser uses no cookies, local/session storage or private uploads. Sharing its URL shares only the three fixed IDs. Downloaded reports contain the full public authored collection; they are ordinary reproducible data, not an approval or authenticity mechanism.

Download URLs are replaced when a configuration changes. A persisted `pagehide` retains the current URL so a page restored from browser history keeps its report link; final unload releases it. This follows the browser's [page lifecycle distinction between frozen and terminated pages](https://developer.chrome.com/docs/web-platform/page-lifecycle-api). The browser regression dispatches a real persisted page-transition event and reads the retained Blob, in addition to normal back navigation; it does not claim to force every browser's cache eligibility policy.

## Development and actual browser verification

```sh
npm run check
npm run eval
npx playwright install chromium
npm run test:browser
```

`npm run build:demo` builds both `/searchlite/` and `/searchlite/relevance.html`. The browser test serves that real build on an owned ephemeral loopback listener, owns its Chromium/download context, and closes them in `finally`. A 90-second test deadline and bounded browser/process operations constrain work; hosted browser job has a five-minute outer limit. It never reuses another listener. External requests are blocked and counted as failures. It exercises configuration/query/swap/identical comparisons, native/download parity within that number tolerance, keyboard inspection, narrow viewports, reload/history, invalid selections, toy-vector disclosures, no-JavaScript guidance and the existing search/explanation demo. Browser dependencies are development-only; the public page needs no installation.
