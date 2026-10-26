# Candidate-aware Boolean execution

AND carries its previous survivors into later clauses, so those clauses normalize and score only documents that can still match. Exclusions use the same Boolean interpreter for membership without calculating scores or traces. Empty intersections stop; unrestricted clauses retain direct entry iteration.

Full per-clause occurrences still determine global document frequency/IDF. Caches remain complete, child additions retain their order, and insertion order still breaks score ties. Search, explanations, highlighting, snapshots and hybrid lexical ranking retain the same public API and scoring formula. This remains term-at-a-time execution with materialized occurrence tables: no WAND/MaxScore, document-at-a-time cursors, compression or ANN.

Actual FieldIndex tests count document-length reads and protect global statistics, reusable caches and caller membership. Public deterministic tests compare search rankings with exhaustive per-document explanations across grammar, fields, k1, ties, missing fields, mutations and snapshot restoration. These are shared-implementation consistency checks; existing hand-computed BM25F fixtures remain the separate formula checks.

## Reproduce

Build baseline commit 9b7fd56a6a596b2bb1fcd656860ee45d18f66c40 in a separate checkout and current main here, using the pinned lockfile. No npm publication is needed.

```sh
npm ci --ignore-scripts
npm run build
node scripts/bench-filtering.js --baseline=/absolute/baseline/dist/index.js --candidate=/absolute/current/dist/index.js > filtering.json
# Same required paths, smaller workload, no timing gate:
node scripts/bench-filtering.js --baseline=/absolute/baseline/dist/index.js --candidate=/absolute/current/dist/index.js --smoke > filtering-smoke.json
npm run test:filtering
```

Node 20+; --help stands alone. Invalid/missing/duplicate flags or relative paths exit 2. Missing/changed modules, worker failures/deadlines or ranking mismatches exit 1, with bounded stderr and no partial JSON. Check the exit status; redirection can create an empty file on failure.

The harness makes no network calls, installs or file writes. **Selected ESM modules are executable trusted code with ordinary Node permissions. This is not a sandbox for untrusted packages.** Reports omit usernames, hostnames and module paths.

## Fixed method

The [workload](../examples/filtering-workload.js) uses unique fictional IDs, alternating titles, a common token in every document, a needle every 97 documents, a repeated phrase in three of four, exclusions every five documents and controlled tags. All eight queries include reversed-order and broad-OR controls. This skew is deliberate, with no user documents or model embeddings.

Defaults: 1,000/10,000 documents, three fresh workers per module/size, two warmup/four measured cycles, top 10. Worker order alternates by trial ordinal, serially; all trials are retained. Smoke: 120 documents, one worker/module, one warmup/one measured cycle. No retries, automatic tuning, best-run selection, CPU pinning, forced GC or timing gates.

Each performance.now sample surrounds the full public search call, including parsing/planning/execution/result construction. Generation, transfer, module import, build, warmup and result hashing are outside timing. Full Infinity rankings run **after** measured calls. Complete and top 10 JSON digests include IDs, exact scores, fields and matches, and must agree across every module/trial/cycle or no report is emitted.

Each worker has a 30-second SIGKILL deadline, 8 MiB input/2 MiB output bound. Module bytes/SHA256 are observed before/after; workload hashes, PIDs, raw timings/counts, build times and per-query summaries are preserved. This detects ordinary rebuilds/mismatches, not hostile-OS changes or authenticity. Means weight samples equally; p50/p95 use nearest rank. Shared-process/JIT/GC samples are not independent population samples or confidence intervals.

## Actual local receipt — October26,2026

The [final report](benchmarks/2026-10-26-filtering.json) retains 12 fresh workers, 384 timed searches and 96 complete rankings, all with exact digest parity. Baseline source 9b7fd56; final engine source 06ae05e. Later benchmark/documentation changes do not change the library bundle.

Machine: Apple M5 Pro, 15 logical CPUs, 24 GiB RAM, darwin 25.6.0 arm64, Node v24.18.0, V813.6.233.17-node.50. UTC: 2026-10-26T13:22:03.867Z.

Mean search milliseconds,12 samples/module/query/size; full precision/p50/p95 in report:

| Query          | 1k baseline | 1k candidate | 10k baseline | 10k candidate |
| -------------- | ----------: | -----------: | -----------: | ------------: |
| rare-first     |      0.2512 |       0.1773 |       2.2283 |        1.2212 |
| common-first   |      0.2767 |       0.2806 |       2.0926 |        2.0879 |
| nested-or      |      0.4907 |       0.2412 |       3.5545 |        1.5664 |
| exclusion      |      0.3963 |       0.2146 |       2.5448 |        1.3523 |
| prefix         |      0.1817 |       0.1031 |       1.5649 |        0.6988 |
| phrase         |      0.2799 |       0.1842 |       1.9264 |        1.1048 |
| broad-negative |      0.4135 |       0.3483 |       3.2640 |        2.5920 |
| broad-or       |      0.4121 |       0.4998 |       3.9076 |        3.3370 |

The targeted 10k rare-first/nested/exclusion/prefix/phrase cases measured lower means; the reversed-order common-first control is effectively unchanged. The 1k broad-OR control is **slower** (0.4121→0.4998ms). This is a workload-dependent tradeoff, not a universal speedup. Scheduling/JIT/GC and repetitive data limit interpretation; no production latency/scale guarantee follows.

The [first diagnostic report](benchmarks/2026-10-26-filtering-diagnostic.json) is retained too. It exposed 10,000 redundant occurrence lookups on 10,000 unrestricted matches. Restoring direct entry iteration removed them without changing scores; the final report measures that final code using the **same fixed workload/parameters**. Both reports retain every trial; no result was selected from a retry of the same code.

- baseline: 73497 bytes, SHA-256 0b4f21e645921eb1997be4c69abe1d6ea89e1e49bcde089efbcc92f03dd441dc.
- candidate: 74351 bytes, SHA-256 2380b03376309ca42c2c8e97bd97a665711d932c2ca16a06cc4ae1a607fba977.
