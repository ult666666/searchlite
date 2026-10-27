# Compare your saved files in the browser

Open the [local file workbench](https://ult666666.github.io/searchlite/local.html), choose a baseline title/body index, a candidate index and one `searchlite.local-judgments/1` labels file, then select **Compare saved indexes**. The page restores and searches the actual supplied indexes. Both must contain identical stored document IDs and title/body strings; edited, added, removed or renamed documents are refused.

Each candidate query must meet its declared minimum and have **unrounded nDCG@10 at least as high as baseline**. Any drop fails, even when another query improves or the mean improves. This is the same contract as the [native local comparison](LOCAL_COMPARISON.md), with the same `searchlite.local-comparison/1` JSON, cutoffs, metric order and exact-byte SHA-256 inputs.

This page is delivered from current `main` through GitHub Pages. The existing v0.2.0 download and immutable tag remain unchanged. That download's native CLI can reproduce the same comparison; its original self-contained implementation is preserved. Current source shares example semantics through `examples/local-review-core.js`, with platform-specific hashing and I/O kept at their respective boundaries. The helper is example code, not a new library API.

## Try and reproduce both outcomes

1. Choose **Weight regression**, then **Load synthetic example**. Two fictional notes put “quartz” in different fields. The real field-weight change produces a failing title task and an improving body task. Both candidate minimums pass, but the title regression still fails the comparison.
2. Inspect `title-task` and `body-task`. Tables show precision@5, recall@10, MRR, MAP and nDCG@10 for both sides and candidate-minus-baseline deltas. Rankings show actual document IDs, grades and scores. Scores belong to each query/configuration; they are not cross-configuration relevance values.
3. Download the comparison JSON and all three synthetic inputs. Run the native command against those exact files. From a built source checkout or extracted offline local-review bundle:

```sh
node examples/search-docs.js compare /path/to/synthetic-baseline.json /path/to/synthetic-candidate.json /path/to/synthetic-judgments.json
```

The weight-change control deliberately exits3 with a complete report. The report bytes agree with the browser download on identical inputs and supported runtime. For a complete terminal-generated fixture without browser steps, use the [native walkthrough](LOCAL_COMPARISON.md#run-a-complete-synthetic-comparison).

4. Choose **Unchanged**, then load the example again. The candidate is rebuilt with the same options as baseline. The comparison passes with zero deltas. Its downloaded inputs can be passed to the same command, which exits0.
5. **Clear local files** removes selected files, rendered reports and download links. You can then choose your own three files. Every input change invalidates the previous result and requires a fresh comparison.

Use the full source checkout (`npm ci`, `npm run build`) or matching release bundle when running the CLI. Copying only the current `search-docs.js` omits its shared helper.

## Your own data

The source [local-document workflow](LOCAL_RELEVANCE.md) creates the baseline snapshot and labels. Build the candidate from the same documents with deliberate analyzer/field options. Snapshot metadata alone does not establish that postings were constructed correctly. Invalid UTF-8, malformed/incompatible snapshots, unknown/duplicate document labels and invalid query syntax are rejected before any report appears. A bad second snapshot or late failing query cannot leave a partial report.

| Input or work                      | Bound                                               |
| ---------------------------------- | --------------------------------------------------- |
| Baseline and candidate file        | 16 MiB each; 1–128 documents                        |
| Each stored body / combined bodies | 128 KiB / 1 MiB per index                           |
| Judgment file                      | 256 KiB; 1–32 queries                               |
| Each query / judgments per query   | 1,000 UTF-16 units / 1–128 labels                   |
| Retrieved ranking depth            | 100 results per query                               |
| End-to-end comparison deadline     | 15 seconds, including file reads and worker startup |

The selected file size is checked before reading; returned byte lengths are checked again. Parsing, restoring, hashing and searching run in an owned worker. Clear, changed files, a replacement example, read/worker errors and the deadline terminate the active worker and invalidate late reads/messages. The deadline is a browser timer, subject to browser scheduling; it is not a hard real-time guarantee. A cancelled native file read may finish internally, but its result is discarded.

The input selectors have stable accessible names and selected-file descriptions. Query selection supports native keyboard navigation/typeahead; narrow-screen tables stay in focusable horizontal scroll regions. Metrics are rounded for display only. Input-derived filenames, query text and IDs render as literal text, with control/bidirectional characters visibly escaped.

## Privacy and offline behavior

Input bytes remain in the current page/worker's memory. The application sends no file, query, label or report to a server, stores none in local/session storage, writes none into URLs and uses no analytics, account or provider. The page's Content Security Policy disables connection requests. The ordinary initial page/script/style downloads and intentional external guide navigation still use the network.

After the page has fully loaded, the worker's code is already included in that page. Fresh synthetic and selected-file comparisons work offline. This is not an installable application or a claim that an unloaded page can start offline. Completed downloads survive a persisted page transition; pending work is cancelled on navigation. Reloading requires selecting files again.

Clear drops application references and revokes obsolete blob URLs; it does not securely erase browser-managed memory. Reports omit source bodies but include potentially private query text, document IDs, labels and exact-byte hashes. Keep downloaded reports private unless you choose to share them. Hashes and matching stored text do not establish source/posting authenticity, current freshness or approval. Caller labels and deterministic criteria do not establish statistical significance or general retrieval quality.

## Run the verification

```sh
npm ci
npm run build
npm run build:demo
npm run test:browser
npm run check
```

The six local-workbench browser stories use real worker comparisons and actual File inputs, compare downloaded reports to native stdout, exercise both synthetic controls offline, reject malformed/oversized/incomparable inputs and late query errors, and check stale reads, late worker replies, deadline termination, literal markup/control strings, unchanged storage/URLs, keyboard operation and 320–1440 pixel layouts. The existing glossary/search browser workflow remains part of the same command. The deadline path uses a controlled stalled worker and browser clock; successful paths use the real worker and engine.

To explicitly verify the public deployment against your matching checkout, the new suite accepts only this public origin:

```sh
SEARCHLITE_BROWSER_ORIGIN=https://ult666666.github.io node --test test/browser/local-review.test.js
```

This performs public GETs for the app and uses synthetic in-memory files; it does not publish anything. Default tests use an owned ephemeral loopback preview and close their browser/server/temporary files. Current source package tests also extract a fresh bundle and prove the explicitly whitelisted shared helper works with an empty offline npm cache. Published v0.2.0 assets are not rebuilt or replaced by these tests.
