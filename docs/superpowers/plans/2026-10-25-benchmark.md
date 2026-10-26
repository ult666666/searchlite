# Reproducible microbenchmark implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans natively with a fresh whole-branch reviewer.

**Goal:** Fulfill the existing README benchmark roadmap item with raw context-bearing measurements at1000/10000 synthetic documents.

**Architecture:** A typed source orchestrator prepares deterministic replicated glossary workloads; fresh pure-Node workers measure built public exports. Parent pools raw samples using a documented nearest-rank summary and emits JSON without performance gates.

**Tech Stack:** Existing TSX/TypeScript/Vitest and Node standard process/performance/memory/crypto APIs; no dependency changes.

**Spec:** docs/superpowers/specs/2026-10-25-benchmark-design.md

## Global constraints

- Default: sizes1000/10000,3 fresh trials,size;2warmup+4measured uniform cycles of26queries; top10. Smoke:60/120,1trial,size,1warmup+1measured cycle.
- Fixed round-robin copied glossary/ordinal IDs; existing default BM25F/stored fields; full text query path. No engine/formula/corpus/browser changes.
- Actual raw build/search/memory samples, Node/V8/machine context and timestamp; no username/hostname/env/paths, no fabricated results or general speed/SLA claim.
- Parent pure-Node worker:30s SIGKILL deadline/2MiB output bound; no partial root JSON on failure. CLI JSON only with silent npm; invalid usage2, worker failure1.
- searchlite.microbenchmark/1; nearest-rank min/mean/p50/p95/max; raw sample pooling limitations/process memory stated. Correctness smoke only, no CI timing threshold.

## Review focus

1. Repeated IDs or aliased fixture tags/options must not silently change workload size/content (Task1).
2. Warmup, process startup, payload generation and setup must not enter measured search samples; full query parsing must remain inside (Task1/2 actual worker).
3. Fresh process/trial identity and fixed query/sample counts must reconcile to report summaries (Task2 smoke/default receipts).
4. Percentiles, zero/empty/nonfinite samples and pooled weighting must have explicit semantics (Task1 literal summary tests).
5. Failure/usage cannot emit misleading partial JSON; report must not leak environment/path/user metadata or imply production/isolated memory quality (Task2 process/help/docs).

## Task1: Deterministic workload and summary contract

Files: create examples/benchmark.ts and test/benchmark.test.ts. Exports makeWorkload(documentCount,warmupCycles,measurementCycles), summarize(values) returning count/minMs/meanMs/p50Ms/p95Ms/maxMs. Workload includes copied documents/options,26 query IDs/texts and limits; SHA computed on serialized actual worker payload.

- [ ] Write literal nearest-rank cases and invalid sample tests; verify workload unique IDs/copies/known queries and stable digests; run missing module RED then implement helpers and run full suite.

## Task2: Actual workers, native command, method and measured receipt

Files: create scripts/bench.ts,scripts/bench-worker.js,docs/BENCHMARK.md and docs/benchmarks/2026-10-25-local.json; modify package.json/README.md.

- [ ] Add actual CLI smoke/invalid usage tests first; witness missing command RED. Implement pure Node worker and bounded parent using public built exports and helper summaries; ensure fresh PIDs, exact counts/digests and raw samples.
- [ ] Run full check/browser/eval, actual default benchmark, and independently reconcile raw timing summaries/workload hashes. Document exact methods/limits/machine context and link actual result; replace fulfilled README roadmap item. Commit.
- [ ] Get fresh exact-head independent review; handle Important findings through real regression/full checks. Attach PR/green reviewed merge/main/public-source verification; finish portfolio/profile integration and versioned checkpoint/accounting. No scheduler recreation or time padding.
