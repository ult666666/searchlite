# Searchlite relevance workbench implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement natively, with a fresh independent whole-branch review.

**Goal:** Make existing retrieval evaluation inspectable query by query in the browser and reproducible as a bounded JSON comparison.

**Architecture:** Share the existing six retrieval configurations between the old table and a pure comparison consumer. Compose existing engine/evaluate semantics; a second Vite page and native CLI consume one report contract.

**Tech Stack:** TypeScript, existing searchlite engine/Vitest/Vite, Node20+, pinned development-only Playwright.

**Spec:** docs/superpowers/specs/2026-10-25-relevance-workbench-design.md

## Global constraints

- Existing60 documents,22 queries,51 judgments, six config names/options/order and100-result depth stay unchanged.
- MRR/MAP use full retrieved rankings; P@5/R@10/nDCG@10 use existing metric functions with those cutoffs.
- No public library API, runtime dependencies, provider/network retrieval, file ingestion or output overwrites.
- JSON schema searchlite.relevance-comparison/1, deterministic full input/config/ranking/metric/delta data, copied input objects and explicit collection/toy-vector limits.
- Current /searchlite/ public base, existing demo search behavior, library coverage thresholds and Claude's work are preserved.
- Exact independent reviewed head and green hosted CI precede merge; actual public artifacts and final source checkpoint follow.

## Review focus

1. Identical/swapped configurations must yield zero/inverted deltas and consistent query rankings, not stale UI metrics (Tasks1/2).
2. Short rankings and misses must use the real P@5 and full-ranking MAP/MRR denominators, with missing relevant top10 IDs visible (Task1 literal fixture metrics/Task2 browser download).
3. A mutated export must not contaminate the fixture collection or subsequent runs (Task1 ownership test).
4. Unknown/duplicate CLI flags and malformed URL selections must refuse or fall back explicitly without raw arguments/HTML injection (Tasks1/2).
5. A changing selection must update the actual download, survive reload and stay keyboard-usable/narrow-screen bounded while toy-hybrid limitations remain visible (Task2 actual browser journey).

## Task1: Shared retrieval and deterministic native comparison

Files: create corpus/retrieval.ts, examples/relevance-comparison.ts, scripts/eval-compare.ts, test/relevance-comparison.test.ts; modify scripts/eval.ts and package.json.

Interfaces: retrieval exports CONFIGURATIONS (stable id/name/options), DEPTH=100 and runConfiguration(id): Run. Comparison exports createComparison(baselineId='bm25f',candidateId='no-stemming'): ComparisonReport and serializeComparison(report): string. The report provides collection,baseline,candidate,meanDelta,queries; each side's metrics use precisionAt5,recallAt10,mrr,map,ndcgAt10. Each query has id,text,judgements,baseline/candidate{ranking,metrics,missingRelevantAt10},delta. CLI flags only select fixed configurations.

- [ ] Record current eval stdout, then write real consumer tests for hand-checked aggregate values, exact query answers/misses, identical/swapped deltas, copied export inputs, all six configs and invalid IDs. Write process tests for native JSON/help/invalid flags/no argument echo.
- [ ] Run the focused tests and witness missing-module/command RED; implement shared extraction and report/CLI. Preserve the old eval stdout byte-for-byte. Run focused tests/full suite/type/lint and commit.

## Task2: Built browser workbench, maintained browser verification and docs

Files: create demo/relevance.html, demo/src/relevance.ts, demo/src/relevance.css, test/browser/relevance.test.mjs, docs/RELEVANCE_WORKBENCH.md; modify demo/index.html, demo/vite.config.ts, package.json/lock, .github/workflows/ci.yml and README.md.

Interfaces: page consumes the Task1 report; labels Baseline configuration,Candidate configuration,Inspect query; URL params baseline,candidate,query. Download searchlite-BASE-vs-CANDIDATE.json is serializeComparison(report), independent of inspected query. Browser QA serves only built files from an owned ephemeral loopback listener, closes server/browser/temp downloads, bounds suite execution and checks actual runtime/output effects.

- [ ] Add pinned Playwright development dependency and browser journey first; build current demo and witness the missing workbench failure.
- [ ] Implement accessible page/URL/compare/swap/download via shared report; add Vite multipage build and home link. Test real query/metrics/config/download/keyboard/mobile/reload/invalid URL/toy hybrid/existing search journeys.
- [ ] Add browser check to Ubuntu CI, write limitations and maintained CLI/browser commands, and run full npm check/eval/browser. Run fresh external source/package consumer and compare actual browser/native JSON bytes. Commit.

## Shipping and checkpoint

- [ ] Generate whole-branch review package; get fresh independent exact-head review, fix important findings with witnessed regression tests/full suite.
- [ ] Reconcile remote base; attach PR; read hosted checks through Code Review/GitHub tools; merge exact approved green head and verify mainCI/Pages.
- [ ] Update current portfolio catalog command/guide/scenario only, with independent scoped review/green checks/mainPages/public checks.
- [ ] Verify actual public workbench/download/existing search, archive exact source/input/output/review/CI/public records and finish actual session ledger. Preserve prior checkpoints and missing-scheduler state.
