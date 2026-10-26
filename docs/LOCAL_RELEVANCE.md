# Check a saved local index against labelled questions

The [browser workbench](https://ult666666.github.io/searchlite/relevance.html) deliberately uses the authored glossary. For your own small collection, the existing built-package consumer now evaluates saved document snapshots against a local judgment manifest. It uses public `SearchIndex` and `evaluate` exports, the same safe reader as local search, and no provider or network retrieval. It is a source consumer, not an installed executable or new library API.

## Run the complete fictional example

From a source checkout, use Node20+ and a new temporary directory:

```sh
npm ci
npm run build
searchlite_evaluation_dir=$(mktemp -d)
searchlite_evaluation_dir=$(cd "$searchlite_evaluation_dir" && pwd -P)
node examples/search-docs.js index examples/fixtures/relevance-notes "$searchlite_evaluation_dir/notes.json"
node examples/search-docs.js evaluate "$searchlite_evaluation_dir/notes.json" examples/fixtures/relevance-notes/judgments.json
```

The three fictional `.md` notes are indexed; the two `.json` manifests are ignored by indexing. The passing manifest has three literal phrase questions, each with its expected note graded3 and a minimum nDCG@10 of1. Each retrieves the expected note at rank1, yielding P@5=0.200, R@10=1, MRR=1, MAP=1 and nDCG@10=1. These intentionally simple labels illustrate the contract; they do not estimate real relevance quality.

Now exercise a valid unmet criterion:

```sh
node examples/search-docs.js evaluate "$searchlite_evaluation_dir/notes.json" examples/fixtures/relevance-notes/judgments-unmet.json
```

This deliberately searches for an absent phrase while requiring `retention.md`. The command prints a complete report with status`fail`, nDCG@10=0 and the failed query ID, then exits3. This is an expected negative control, not an observed production regression. The snapshot/manifests remain unchanged. Direct Node is canonical; an unsilenced npm script would add npm's argument banner to stdout.

The `pwd -P` step resolves the newly created directory's physical path. On macOS, a temporary path can pass through the `/var` symlink; the consumer deliberately refuses linked ancestors. This keeps the example portable without relaxing that check. The example directory remains available for inspecting or rerunning its snapshot.

## Write labels for your own saved collection

```json
{
  "schema": "searchlite.local-judgments/1",
  "queries": [
    {
      "id": "invoice-retention",
      "text": "\"invoice retention\"",
      "minimumNdcgAt10": 0.85,
      "relevance": [{ "documentId": "retention.md", "grade": 3 }]
    }
  ]
}
```

Use the relative IDs produced by `index`. IDs are checked against the loaded snapshot and never opened as filesystem paths. Grade3 means directly relevant,2 substantially relevant,1 partly relevant,0 not relevant; unlisted retrieved documents receive0. Label the questions and choose criteria deliberately rather than tuning them to make a run pass. At least one positive judgment is required per query so its nDCG denominator is meaningful. Negative/no-relevance question sets need a different contract and are refused here.

The exact manifest fields are shown above. Unknown fields are refused. Query IDs must be unique ASCII identifiers of1–64 characters, start with an alphanumeric and then contain only alphanumeric/dot/underscore/hyphen. Query text must be nonempty, contain no NUL, and use at most1000 UTF-16 code units. Duplicate query/document IDs are refused. Grades are integers0–3; every `minimumNdcgAt10` is a required finite number in[0,1]. This accepts ordinary JSON syntax/parser semantics; it does not claim to reject duplicated object keys. Give each field once.

## What the report means

The deterministic JSON schema is `searchlite.local-evaluation/1`. It retains the saved index's actual options, all query text/judgments/criteria, retrieved IDs/scores/grades, missing relevant top10 IDs, per-query measured metrics and failed query IDs. It records SHA-256 of the **same exact snapshot and judgment bytes used**, plus document/query counts. Original document folders are never reread. Hashes identify those input bytes; they do not authenticate a source or establish that the snapshot reflects current files.

- P@5 includes empty positions in its denominator of5. R@10 and nDCG@10 use top10; nDCG uses the existing linear grades and log₂(rank+1) discount. MRR/MAP use the full retrieved ranking, up to100 results. A relevant item at rank11 affects MRR/MAP while missing top10 metrics.
- Every query must meet its own unrounded nDCG@10 threshold. There is no average-based override that can hide a failed query, no rounding tolerance and no automatic statistical-significance claim. Raw BM25F scores are meaningful within a query/configuration.
- Reports contain query text and relative document IDs, which may be private. They omit source document bodies. Keep reports local unless intentionally sharing them. JSON escapes terminal/bidirectional/separator controls while preserving the parsed strings.

| Exit | Meaning                                             | Stdout                               |
| ---- | --------------------------------------------------- | ------------------------------------ |
| 0    | Valid evaluation; every criterion met               | Complete JSON report                 |
| 3    | Valid evaluation; one or more criteria unmet        | Complete JSON report with failed IDs |
| 1    | File, encoding, snapshot, manifest or query failure | Empty; bounded diagnostic on stderr  |
| 2    | Invalid command usage                               | Empty; usage on stderr               |

The command writes no files and modifies no inputs. Shell redirection is the caller's choice; select a new report destination to preserve earlier results. Valid reports contain no time/random fields. Running against unchanged saved inputs gives identical JSON even after original source folders are removed. Criteria are caller decisions for this collection, not production readiness, source authenticity or execution authority.

## Bounds and verification

Judgment files are limited to256KiB,1–32 queries and1–128 judgment records per query. Existing snapshot bounds remain16MiB,128 documents and the local consumer's title/body/text restrictions. Symlinked paths/ancestors, nonregular or multiply linked files, invalid UTF-8, malformed structures, unknown document IDs and invalid queries are refused without partial reports. Reads check file identity before/after opening and reading; the safe-reader scope is for files you control, not protection against a hostile concurrent filesystem owner.

The real process tests exercise built-package exports, hand-derived metrics, relevant rank11, passing/unmet criteria, exact used-byte hashes, removal of original folders, JSON control safety, prototype-named document IDs, malformed/oversized/unsafe inputs and unchanged inputs. Both CLI suites build the package once in Vitest global setup before parallel workers, avoiding concurrent `dist` clean/builds. Existing search/index tests remain intact. Run `npm run check`, `npm run eval` and the separately installed Chromium `npm run test:browser`; see the README for development setup.
