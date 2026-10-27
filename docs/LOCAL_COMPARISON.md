# Compare configurations on your own saved documents

The [local file workbench](https://ult666666.github.io/searchlite/local.html) can run this same comparison from selected files in browser memory, with exact native JSON and synthetic input downloads. See its [workflow and privacy guide](https://github.com/ult666666/searchlite/blob/main/docs/LOCAL_FILE_WORKBENCH.md).

The glossary [relevance workbench](https://ult666666.github.io/searchlite/relevance.html) compares fixed examples. The local source consumer can now compare two actual saved title/body indexes against the same labels:

```sh
node examples/search-docs.js compare BASELINE CANDIDATE JUDGMENTS
```

It uses the public built library and the same bounded reader, judgment contract and metric implementation as [local evaluation](LOCAL_RELEVANCE.md). No original document folders, provider, network service or report-input claims are consulted. The command writes no files. It is a source-checkout example, not an installed executable or a new library API.

## Run a complete synthetic comparison

Use Node20+, install the development dependencies and build the library. Start with a fresh physical temporary directory; `pwd -P` resolves macOS temporary-path aliases without relaxing the reader's symlink refusal.

```sh
npm ci
npm run build
searchlite_compare_dir=$(mktemp -d)
searchlite_compare_dir=$(cd "$searchlite_compare_dir" && pwd -P)
node --input-type=module - "$searchlite_compare_dir" <<'JS'
import { SearchIndex } from 'searchlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const documents = [
  { id: 'a.md', title: 'quartz', body: 'other' },
  { id: 'b.md', title: 'other', body: 'quartz' },
];
for (const [name, fields] of [
  ['baseline.json', { title: { boost: 3 }, body: {} }],
  ['candidate.json', { title: {}, body: { boost: 3 } }],
]) {
  const index = new SearchIndex({ fields });
  index.addAll(documents);
  writeFileSync(join(directory, name), JSON.stringify(index.toJSON()) + '\n',
    { flag: 'wx', mode: 0o600 });
}
const queries = [
  { id: 'title-task', text: 'quartz', minimumNdcgAt10: 0.5,
    relevance: [{ documentId: 'a.md', grade: 3 }] },
  { id: 'body-task', text: 'quartz', minimumNdcgAt10: 0.5,
    relevance: [{ documentId: 'b.md', grade: 3 }] },
];
writeFileSync(join(directory, 'judgments.json'),
  JSON.stringify({ schema: 'searchlite.local-judgments/1', queries }) + '\n',
  { flag: 'wx', mode: 0o600 });
JS
node examples/search-docs.js compare "$searchlite_compare_dir/baseline.json" "$searchlite_compare_dir/baseline.json" "$searchlite_compare_dir/judgments.json"
```

The unchanged comparison passes, exits0 and has zero metric deltas. Now compare the actual field-weight change:

```sh
node examples/search-docs.js compare "$searchlite_compare_dir/baseline.json" "$searchlite_compare_dir/candidate.json" "$searchlite_compare_dir/judgments.json"
```

This deliberately exits3 with a complete report and `failedQueries: ["title-task"]`. The title task's relevant item moves from rank1 to rank2: nDCG@10 goes from1 to approximately0.630930 and MRR from1 to0.5. The body task improves by the same amount. Both candidate queries meet their declared0.5 minimum, and the mean is unchanged, yet the title-task drop still fails the comparison. This is a fictional negative control illustrating the gate, not a production regression or a claim that one field weighting is universally better.

The unchanged comparison can be rerun byte-for-byte on the same inputs/runtime. Neither snapshots nor labels are modified. Shell redirection is your choice; use a new private output destination if saving a report.

## Comparability and the gate

Both snapshots must contain exactly the same IDs and stored title/body strings. Record order may differ. Configuration and postings may differ, allowing actual analyzer/weight/index changes to be evaluated. Added, removed, renamed or edited documents are refused with `INCOMPARABLE_COLLECTION`; this command isolates configuration comparisons instead of mixing them with corpus edits. Rebuild the candidate from the same documents using deliberate complete options, rather than only relabelling snapshot metadata: the actual postings are searched.

Every query uses the same supplied labels and existing required `minimumNdcgAt10`. A query passes only if the candidate's **unrounded nDCG@10 meets that minimum and is at least its baseline nDCG@10**. Any drop fails, with no rounding tolerance or average override. An improved candidate that meets its minimum can pass even when the baseline failed that minimum. This is a deterministic engineering gate, not a statistical significance test or an automatic choice of acceptance criteria. Label questions and choose criteria deliberately.

Metric deltas are candidate minus baseline. P@5, R@10, MRR and MAP remain visible but do not decide the comparison gate. Raw BM25F ranking scores belong to their own query/configuration and are not subtracted or treated as cross-configuration relevance values. The existing cutoffs remain top5 precision, top10 recall/nDCG and a maximum100 retrieved results for full-ranking MRR/MAP.

## Report, privacy and errors

The new schema is `searchlite.local-comparison/1`. Existing `searchlite.local-evaluation/1` output is unchanged. The report retains:

- SHA-256 of each exact snapshot and the one judgment byte buffer actually used, plus a SHA-256 of canonical sorted `[id,title,body]` triples and document/query counts.
- Each side's normalized configuration, minimum-criterion status and failed minimum IDs.
- Shared query text, labels and minimum; both actual rankings/grades/metrics/missing relevant IDs; metric deltas and the combined per-query result.
- `regressedQueries`, `failedMinimumQueries` and their union `failedQueries`, all in manifest order. No average can override an individual failure.

Reports omit source bodies and absolute filesystem paths but retain potentially private query text, labels and document IDs. Keep private files and reports local. Terminal/bidirectional/separator controls are JSON-escaped without changing parsed strings. Hashes identify supplied bytes and stored-text comparability; they do not authenticate postings, labels, configuration, author, source history or current filesystem freshness. Matching text alone does not prove a snapshot was correctly generated.

| Exit | Meaning                                                                          | Stdout                              |
| ---- | -------------------------------------------------------------------------------- | ----------------------------------- |
| 0    | Valid comparison; every candidate query passes both conditions                   | Full JSON report                    |
| 3    | Valid comparison; a minimum or non-regression condition fails                    | Full JSON report with failed IDs    |
| 1    | Unreadable, unsafe, malformed, incompatible or incomparable input; invalid query | Empty; bounded diagnostic on stderr |
| 2    | Wrong command arguments                                                          | Empty; usage on stderr              |

Both snapshots must independently satisfy the existing16MiB,128-document, bounded title/body contract. Labels retain the256KiB,1–32-query,1–128-judgment-per-query contract. Linked paths/ancestors, multiply linked/nonregular files, invalid UTF-8, malformed snapshots, unknown document IDs and invalid query syntax are refused. Reads own exact byte buffers and check file identity, under the existing scope for files you control; this is not a sandbox against a hostile concurrent filesystem owner. No partial success is printed if either side or a late query fails.

## Verify the implementation

```sh
npx vitest run test/local-comparison.test.ts test/local-evaluation.test.ts test/search-docs.test.ts
npm run check
```

The real process tests exercise built public exports, literal hand-derived rankings/deltas, offsetting improvements, minimum-only failure, a previously failing baseline, canonical collection ordering, exact used-byte hashes, deleted original sources, unsafe/malformed/oversized inputs on both sides, late query errors, control/prototype identifiers and unchanged input bytes. The existing evaluation/search tests remain intact; a separate cross-revision check confirms unchanged evaluation JSON. These finite synthetic checks demonstrate the contract, not general retrieval quality or model effectiveness.
