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
