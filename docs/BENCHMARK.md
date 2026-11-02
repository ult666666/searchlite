# Reproduce the synthetic microbenchmark

```bash
npm ci --ignore-scripts
npm run build
npm run --silent bench > benchmark.json
# Small correctness exercise; no timing threshold:
npm run --silent bench -- --smoke > smoke.json
```

Run from a source checkout with Node 20 or newer. `--help` must stand alone. The command writes JSON only when successful; invalid usage exits 2, and a worker/build failure exits 1 with no partial report. Each worker has a 30-second kill deadline and 2 MiB output bound. The command makes no network calls or file writes itself. Shell redirection creates the requested output file, which can be empty on failure; check the exit status.

## Fixed workload and method

Defaults were chosen before recording the result below: 1,000 and 10,000 documents, three fresh Node workers per size, two warmup cycles and four measured cycles. Each cycle runs all 22 existing glossary query texts followed by phrase, prefix, Boolean and fuzzy examples, in that order, with a result limit of ten. Smoke uses 60 and 120 documents, one worker each, one warmup and one measured cycle. There is no automatic tuning, retry, best-run selection or performance gate.

Documents are round-robin copies of the repository's 60 authored glossary entries with unique ordinal-prefixed IDs and copied tags. Vocabulary and document lengths repeat. Fields use the normal BM25F title boost 3, tag boost 2 with tag stemming disabled, and body defaults; normal stored fields are enabled. This measures collection-size effects on this deliberately repetitive corpus, not diverse production data. Query texts, generation rules, original-fixture digest and exact serialized worker-workload digests are in the report.

Workers import the built public `searchlite` export in plain Node, without the source TS loader. Generation, payload transfer, process startup and warmup are outside search samples. A sample surrounds the full public `index.search(text, {limit: 10})` call, including parsing, analysis, planning, execution and result construction. Constructor plus `addAll` time is recorded separately as `buildMs`. Raw per-query durations and result counts remain available for every trial; result counts also contribute to a checksum.

Timing uses [`performance.now()`](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow). Each size pools its 312 measured search calls: 26 queries × four cycles × three workers. The mean weights calls equally; p50/p95 use nearest rank, `sorted[ceil(p*N)-1]`, rather than interpolation. Build time is the median of three trials. Query types have different costs, and pooled calls are not independent population samples or confidence intervals. Inspect individual queries/trials before comparing runs.

[`process.memoryUsage()`](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage) snapshots before/after index construction are bytes for the whole worker, including runtime and parsed input. They are neither isolated index allocation nor peak memory; garbage collection can change them. No CPU pinning or forced GC is used. JIT, finite warmup, OS scheduling and concurrent desktop activity affect measurements. Machine/Node/V8 context and UTC timestamp are recorded; username, hostname, environment variables and local paths are omitted.

## Actual local receipt

[Raw report, recorded October 25, 2026 Pacific](benchmarks/2026-10-25-local.json) (UTC October 26): Apple M5 Pro, 15 logical CPUs, 24 GiB RAM, Darwin 25.6.0 arm64, Node v24.18.0, V8 13.6.233.17-node.50. These are measured values from one local run, rounded here to three decimals; the report preserves full precision and all six workers.

| Synthetic documents | Median build ms | Search mean ms | Search p50 ms | Search p95 ms | Measured calls |
| ------------------- | --------------: | -------------: | ------------: | ------------: | -------------: |
| 1,000               |          29.173 |          0.116 |         0.102 |         0.237 |            312 |
| 10,000              |         214.495 |          0.548 |         0.419 |         1.341 |            312 |

This is a reproducibility receipt for the disclosed workload and machine. It does not establish a production latency, concurrency or service-level guarantee, compare competing engines, or measure retrieval relevance. Use the [relevance workbench](RELEVANCE_WORKBENCH.md) and [your own labelled questions](LOCAL_RELEVANCE.md) for quality checks.

## Before and after pruning, November 2, 2026

The same command, run three times for main (c2f5751) and three times for the compressed-postings
and pruning change, alternating builds. Machine: Linux 6.18 x86_64 container, Intel Xeon @ 2.10GHz,
4 logical CPUs, 16 GB RAM, Node v22.22.0. Other jobs shared the machine (1-minute load average 10
to 13), which inflates means and 95th percentiles; medians move least. For main, `bench.ts`,
`bench-worker.js` and `examples/benchmark.ts` from main ran against main's build in a separate
folder.

| Build | Run | 1,000 docs: build ms | mean ms | p50 ms | p95 ms | 10,000 docs: build ms | mean ms | p50 ms | p95 ms |
| ----- | --: | -------------------: | ------: | -----: | -----: | --------------------: | ------: | -----: | -----: |
| main  |   1 |                  174 |   0.984 |  0.364 |  4.701 |                   912 |   3.175 |  2.164 |  8.448 |
| this  |   1 |                  344 |   3.443 |  0.371 | 17.888 |                  1010 |   1.852 |  0.447 |  9.308 |
| main  |   2 |                  204 |   0.851 |  0.356 |  3.851 |                   906 |   3.639 |  2.192 | 10.352 |
| this  |   2 |                  303 |   1.537 |  0.316 |  8.974 |                  1135 |   1.538 |  0.630 |  5.998 |
| main  |   3 |                  162 |   1.574 |  0.464 |  8.562 |                   990 |   3.949 |  2.889 |  9.647 |
| this  |   3 |                  175 |   0.983 |  0.302 |  5.265 |                   972 |   1.345 |  0.493 |  5.507 |

At 10,000 documents every run of this change has a lower mean and a median 3.5× to 5.9× lower. At
1,000 documents the medians are within 0.1 ms of each other and the means swing both ways from run
to run; these processes stop after two warmup cycles, before the longer document-at-a-time code
is fully compiled. Building the index takes about as long at 10,000 documents and up to twice as
long at 1,000: each posting is now encoded and its block's impacts updated. Steady-state latency,
postings memory and snapshot size for both builds are in [EXECUTION.md](EXECUTION.md#measured-results-november-2-2026).

The filtering benchmark, `node scripts/bench-filtering.js --baseline=/absolute/main/dist/index.js --candidate=/absolute/this/dist/index.js`,
also ran once on these builds with exact ranking parity. Mean milliseconds:

| Query          | 1k main | 1k this | 10k main | 10k this |
| -------------- | ------: | ------: | -------: | -------: |
| rare-first     |   3.527 |   0.227 |    4.009 |    0.347 |
| common-first   |   2.824 |   0.500 |   12.150 |    1.471 |
| nested-or      |   2.557 |   0.374 |    5.481 |    1.823 |
| exclusion      |   2.279 |   0.861 |    5.139 |    0.360 |
| prefix         |   0.737 |   0.216 |    2.196 |    0.352 |
| phrase         |   2.025 |   5.456 |    4.743 |   13.351 |
| broad-negative |   3.730 |   1.584 |    8.617 |    4.406 |
| broad-or       |   2.637 |   1.098 |   10.904 |    5.729 |

The phrase control is slower: a phrase that occurs in three of four documents still has to be
matched in all of them for its document frequency, and positions are now decoded from
variable-byte bytes.
