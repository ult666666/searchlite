# Stable finite-vector cosine implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans natively; one final fresh independent reviewer. User delegated routine AI-tool fixes and shipping.

**Goal:** Make supported extreme finite vectors rank correctly and refuse sparse vectors atomically.

**Architecture:** Existing cosine API retains a safe ordinary path and uses max-absolute scaling plus compensated sums for unsafe raw arithmetic. The existing shared vector validator visits every element.

**Tech Stack:** Existing TypeScript/Vitest/Node built ESM+CJS; optional Python3 standard-library Decimal reference generator, no dependencies.

**Spec:** docs/superpowers/specs/2026-10-26-stable-cosine-design.md

## Global Constraints

- Same public API/formula/zero convention/version/snapshot schema; finite array elements required and readonly inputs unchanged. Structured INVALID_ARGUMENT for invalid standalone/query vectors; existing document/snapshot error codes preserved.
- Fast path only finite nonzero-normal dot and normal norms/finite denominator; use2**-1022 as minimum normal, not Number.MIN_VALUE. Fallback scales each vector separately and compensates dot/squared sums, clamps final range.
- Sparse vectors cannot enter add/addAll/replace/snapshots or queries; rejected operations preserve exact index state. No network/provider/dependency/new inference/ANN/authority.
- Independent reference uses Decimal.from_float/3500digits/standard raw formula with fixed seed, fixture contains only finite inputs. Absolute8*EPS plus relative tests for selected tiny nonzero answers. No universal correctly-rounded or timing claim.
- Exact reviewed green current-main shipping and recoverable exact-source checkpoints, actual parent accounting only.

## Review Focus

1. Huge/tiny/mixed-scale finite vectors and true zeros must yield finite bounded cosine and correct nearest-neighbor ordering, including restored/mutated indexes (Task1 literal API tests and Task2 reference).
2. Subnormal raw norms/dot or a zero from cancellation must not enter an unsafe ordinary fast path; negative correlations and tiny representable residuals must survive (Tasks1/2 literal and relative cases).
3. Holes in document/query/snapshot arrays must be refused before any addAll/replace state change; ordinary dense zeros remain legal (Task1 atomic input tests).
4. Numerical correctness evidence must be independent of JS implementation and regeneration deterministic, with input binary64 provenance, precision and tolerance explicit (Task2 Decimal fixture/regeneration checks).
5. Existing ordinary/hybrid/lexical behavior, exported builds, browser evaluation and historical performance claims must remain truthful; no hidden model quality or universally correctly-rounded promise (Task2 full suites/public checks/docs).

### Task 1: Reproduce and repair supported-input failures

**Files:** src/hybrid.ts; src/search-index.ts; test/hybrid-numerics.test.ts (new).

**Interfaces:** existing cosineSimilarity(a,b):number and SearchIndex vector API; private compensated sum helper only.

- [ ] Write literal large/tiny/subnormal/opposed/zero/empty/cancellation tests, actual top1/fusion and frozen-input invariants; sparse/nonfinite standalone and document/batch/replacement/query/snapshot tests. Run focused test: expected current NaN/zero/wrongrank/sparse acceptance failures.
- [ ] Implement validation, finite ordinary path and separately scaled compensated fallback, visiting all vector elements. Keep existing pure lexical code unchanged.
- [ ] Run focused and complete npm test/lint/typecheck, commit and record task.

### Task 2: Independent conformance evidence, docs and shipping

**Files:** scripts/generate-cosine-reference.py; test/fixtures/cosine-reference.json; test/hybrid-numerics.test.ts; docs/VECTOR_NUMERICS.md; README.md; CHANGELOG.md.

**Interfaces:** generator accepts no arguments, stdout deterministic schema searchlite.cosine-reference/1 with precision3500, input provenance, seed and finite cases{id,left,right,expected,relative}; test reads fixture through Node fs (no TS config/runtime dependency).

- [ ] Generate fixed literal/seeded/mixed/extreme reference using independent Decimal arithmetic; add all-case bounds/symmetry/absolute error and selected relative/permutation/scale checks. Regenerate twice and compare bytes; test analytic references.
- [ ] Document original failure, algorithm/fast-path/validation, optional regeneration, tolerances/finite evidence/near-cancellation limits and no model/scalability claim. Preserve exact historical candidate benchmark receipt.
- [ ] Run npmcheck, built browser, evaluation, original benchmark smoke, installed ESM+CJS/vector/snapshot parity and lexical paired smoke. Commit, whole-branch independent review, TDD fixes only Critical/Important; exact green attached PR/merge, actual public/source verification and durable checkpoint. Integrate truthful shipped AI capabilities into current portfolio without overwriting concurrent work.
