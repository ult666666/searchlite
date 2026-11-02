# Document-at-a-time pruning

`search` now evaluates document at a time over compressed postings. A top-level OR runs MaxScore in windows that end at block boundaries, with block-max upper bounds from each block's (frequency, length) impacts; other queries skip whole blocks whose bound cannot beat the current k-th best score. The design, the bound formula and the argument for exact results are in [DESIGN.md, sections 4.1 and 8](DESIGN.md#8-execution).

**Exactness.** Pruned top-k results equal exhaustive term-at-a-time scoring: the same document IDs, in the same order, with the same scores bit for bit (the documented tolerance is zero, because each scored document is scored with the same floating-point operations in the same order). Every bound carries a relative margin of 1e-9 so rounding cannot prune a competitive document. `test/engine/pruning.test.ts` checks this on 48 random corpora of 1 to 700 documents with removals and out-of-order re-additions, random queries (terms, phrases, prefix, fuzzy, field scopes, nested AND/OR/NOT, both default operators), random boosts, `b`, `k1` (including 0), limits from 1 to Infinity and four filter settings (none, a hashed half, every seventh document, nothing); plus public-API runs against per-document `explain`, a single document, every document matching, complete ties, and a version 1 snapshot from 0.2.0. Deliberate bugs make these tests fail: bounds 10% too small, the minimum impact instead of the maximum, summing in probe order, filtering after the heap, a stale impact frontier, a cursor off by one block, ignoring an exclusion, a max instead of a sum for AND bounds, a union document frequency taken from the largest list, and a halved phrase bound. Removing the 1e-9 margin is the one change the random tests do not catch: it guards against rounding differences of a few units in the last place, which random inputs essentially never hit.

## Measured results, November 2, 2026

Command, from a checkout of this branch with main's build saved elsewhere:

```sh
npm ci && npm run build
npm run --silent bench:pruning -- --baseline=/absolute/main/dist/index.js --candidate="$PWD/dist/index.js" > pruning.json
```

Baseline: main at c2f5751 (dist/index.js SHA-256 dfb4351b…e6f7). Candidate: this change (0c745760…f76c). Machine: Linux 6.18 x86_64 container, Intel Xeon @ 2.10GHz, 4 logical CPUs, 16 GB RAM, Node v22.22.0 (V8 12.4). Other jobs shared the machine: the 1-minute load average was 11 to 13 during the run, so latencies are noisier than on an idle machine and medians are more reliable than means. Each cell pools 3 fresh workers per build after 20 warmup cycles; 10 measured cycles of every query; top 10. Every top-10 and complete ranking of both builds was byte-identical. [Trimmed receipt](benchmarks/2026-11-02-pruning.json) (per-query summaries and per-trial memory; the raw samples are reproducible with the command).

| Workload (synthetic) | Documents |  Mean ms, main → this | Median ms, main → this | Postings heap, main → this |  Index heap, main → this |    Snapshot, main → this |
| -------------------- | --------: | --------------------: | ---------------------: | -------------------------: | -----------------------: | -----------------------: |
| glossary copies      |     1,000 |  0.361 → 0.262 (1.4×) |   0.237 → 0.168 (1.4×) |   3.74 MB → 0.55 MB (6.8×) | 6.47 MB → 3.39 MB (1.9×) |   788 KB → 576 KB (1.4×) |
| glossary copies      |    10,000 |  2.929 → 0.445 (6.6×) |   2.058 → 0.303 (6.8×) |  35.0 MB → 3.29 MB (10.6×) | 53.5 MB → 22.1 MB (2.4×) | 8.07 MB → 5.63 MB (1.4×) |
| Zipf labels          |     1,000 |  0.973 → 0.888 (1.1×) |   0.570 → 0.225 (2.5×) |   5.70 MB → 1.93 MB (2.9×) | 9.52 MB → 5.85 MB (1.6×) |   952 KB → 677 KB (1.4×) |
| Zipf labels          |    10,000 | 16.81 → 1.276 (13.2×) |  8.480 → 0.570 (14.9×) |   49.9 MB → 6.04 MB (8.3×) | 73.1 MB → 29.5 MB (2.5×) | 9.31 MB → 6.04 MB (1.5×) |

- _Postings heap_: bytes that a V8 heap snapshot shows reachable only through each field's postings (and, in this version, their byte arena), typed-array storage included. _Index heap_: `heapUsed + arrayBuffers` after forced GC, after minus before `addAll`, so it also counts stored-field records, the trie and the new per-document length arrays. _Snapshot_: UTF-8 bytes of `JSON.stringify(index)`, of which stored text is a large share.
- The glossary workload is the repository's scale workload (copies of 60 entries, 26 queries including phrase, prefix, Boolean and fuzzy syntax). The Zipf workload draws `w0001`…`w5000` with weight 1/rank, so a few labels are in most documents; its 8 queries are disjunctions mixing common and rare labels. Neither is real text or traffic.
- Pruning helps most on large collections with common terms. At 1,000 documents the means are close and the 95th percentiles are dominated by scheduling noise.

**Cold processes and the earlier filtering workload.** `npm run --silent bench` (2 warmup cycles in fresh processes) and the [filtering benchmark](#reproduce) below also ran on both builds; [BENCHMARK.md](BENCHMARK.md#before-and-after-pruning-november-2-2026) lists those numbers. In the filtering workload every query except one got faster, by 1.9× to 16× in mean time. The exception is the phrase control (`needle AND "shared phrase"`, a phrase in three of four documents): 2.0 → 5.5 ms at 1,000 documents and 4.7 → 13.4 ms at 10,000, with two warmup cycles. Its document frequency still needs positional matching in every document, and positions are now decoded from variable-byte bytes instead of being read from stored arrays.

**Limits.** Exact clause statistics are not skipped: a word searched in several fields counts the union of its lists, and phrases are matched in full. `limit: Infinity` scores every match, and with `k1 = 0` all clause scores tie, so the safety margin prevents most skipping. Block-max WAND is not implemented. `remove` and `replace` rewrite one block and shift the list's later bytes.

# Candidate-aware Boolean execution (October 2026)

This section describes the earlier term-at-a-time change, which `executePlan` still implements as the reference engine for explanations and highlighting. Its measurements below were taken before document-at-a-time execution existed.

AND carries its previous survivors into later clauses, so those clauses normalize and score only documents that can still match. Exclusions use the same Boolean interpreter for membership without calculating scores or traces. Empty intersections stop; unrestricted clauses retain direct entry iteration.

Full per-clause occurrences still determine global document frequency/IDF. Caches remain complete, child additions retain their order, and insertion order still breaks score ties. Search, explanations, highlighting, snapshots and hybrid lexical ranking retain the same public API and scoring formula. At the time this was still term-at-a-time execution with materialized occurrence tables; the section above replaces it for `search`.

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

## Actual local receipt, October 26, 2026

The [final report](benchmarks/2026-10-26-filtering.json) retains 12 fresh workers, 384 timed searches and 96 complete rankings, all with exact digest parity. Baseline source 9b7fd56; final engine source 06ae05e. This receipt pins that exact historical library bundle. Later numerical changes have separate module digests and do not turn this into a timing claim for evergreen main.

Machine: Apple M5 Pro, 15 logical CPUs, 24 GiB RAM, darwin 25.6.0 arm64, Node v24.18.0, V8 13.6.233.17-node.50. UTC: 2026-10-26T13:22:03.867Z.

Mean search milliseconds, 12 samples/module/query/size; full precision/p50/p95 in report:

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
