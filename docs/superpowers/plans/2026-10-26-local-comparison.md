# Local Relevance Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native task-by-task execution.

**Goal:** Compare two supplied same-document indexes against actual local labels with a deterministic per-query gate.
**Architecture:** Reuse examples/search-docs.js readers/restore/manifest/evaluate/serializer; factor evaluation into a side-effect-free internal report builder, preserve evaluate wrapper, add compare wrapper.
**Tech Stack:** Node20+ ESM and existing public searchlite exports, Vitest process tests; no dependencies.
**Spec:** docs/superpowers/specs/2026-10-26-local-comparison-design.md

## Global Constraints

Existing index/search/evaluate schema/output/error behavior unchanged. Exactly4comparearguments. No network/providers/filesystem writes or source-folder reads. Existing reader limits unchanged. Identical supplied ID/title/body collection required, sorted canonical digest is not source authenticity. New schema searchlite.local-comparison/1; candidate unrounded nDCG must meet each declared minimum and not drop from baseline; no average override/tolerance. Full report only after all inputs validated; exits0/3/1/2 as spec. No public API/version/dependency change.

## Review Focus

- Different snapshot document ordering and prototype/control IDs must not confuse comparability or escape report text.
- A candidate that meets minimum but regresses, or improves average while one query drops, must fail.
- A baseline below minimum must not veto an improved candidate meeting criteria.
- Any invalid second snapshot or late bad query must leave stdout empty and inputs unchanged.
- Existing evaluate output must remain byte-identical for unchanged input; hash exactly the bytes actually used.

## Task 1: Real-input comparison command and process tests

Files: modify examples/search-docs.js; create test/local-comparison.test.ts.
Interfaces: consume existing restore(file)->{index,data}, loadJudgments(data,index), readBounded, safeJson and public evaluate. Produce comparison CLI/report as spec and internal createEvaluationReport({index,data},judgmentsData) returning unchanged evaluation report.
- [ ] Write real-process tests first: literal reorder/offsetting gate, unchanged, improved baseline-failure, exacthashes/determinism/deletedsource, compatibleorder, differentcontent/IDs, malformed/UTF8/oversize/linked/nonregular on eachside/judgments, latequery, usage/control/prototype/no writes. Run focused test; Expected: newcomparecases failUSAGE beforeimplementation.
- [ ] Implement minimal factor+command, format/lint/type, run focusednew+existinglocaltests; Expected: allgreen. Capture old b85 evaluate and new output on exactsame fixture; Expected: byte-identical. Commit.
- [ ] Run full npm run check and npm run test:browser / eval; Expected: allgreen. Final task command: npx vitest run test/local-comparison.test.ts test/local-evaluation.test.ts test/search-docs.test.ts.

## Task 2: Runnable guide, integration and final review

Files: docs/LOCAL_COMPARISON.md, README.md, docs/LOCAL_RELEVANCE.md, CHANGELOG.md.
Interfaces: consume exact Task1 CLI/schema/gate. Produce truthful source-consumer instructions with fresh private tempfile destinations, deterministic synthetic baseline/candidate rebuild from public exports, passing/expectedregression examples and explicitcollection/privacy/precisionlimits.
- [ ] Run actual guide from freshsource using bounded syntheticfixtures, includingpassing andexpected3regression; check originalfiles unchanged and reporthashes correct. Document exactobservedmetrics; keep controls.
- [ ] Link guide and describe noAPI/schema break; formatcheck/typed source check; Expected: pass. Commit.
- [ ] One independent whole-branch review, handle Critical/Important inoneTDDfixpass; deferMinors, ledgerallrulings. Exactgreenreviewedhead merge, realpublic/deployed parity and fullsourcebundle/ZIP recovery beforecompletion.
