# Candidate-aware retrieval execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans natively, then one fresh whole-branch reviewer. User delegated routine design/engineering/shipping; no implementation delegation.

**Goal:** Avoid scoring already-excluded Boolean candidates while preserving exact public results, and provide a reproducible paired benchmark that refuses ranking drift.

**Architecture:** Existing term-at-a-time interpreter gains read-only candidate membership and score suppression for negative clauses. Pure-Node fixed-workload parent/workers measure trusted built ESM modules and compare exact full/limited ranking digests.

**Tech Stack:** Existing TypeScript/Vitest, pure Node JS/node:test, built public ESM, pinned tooling; no new dependency/version.

**Spec:** docs/superpowers/specs/2026-10-26-candidate-execution-design.md

## Global Constraints

- Same public API/formula/clause addition order/tie order, global DF/full occurrence cache and only/trace behavior. No query rewrite/WAND/DAAT/compression/ANN claim.
- Internal ExecutionContext candidates?:ReadonlyMap<number,unknown>, score?:boolean; default scoring unchanged. Never mutate supplied candidates or narrow global statistics.
- Fixed benchmark1000/10000docs,3fresh workers/module/size,2warmup/4measure,limit10; smoke120docs,1worker/module,1warmup/1measure. Eight fixed queries, exact full/timed ranking digest equality, alternating module order, all trials retained.
- Trusted absolute ESM paths only, no harness network/install/file writes, bounded stdin8MiB/output2MiB/worker30s. Native test-only timeout injection, no CLI knob. Success one JSON; exit2usage/1failure, sanitized stderr/no partial JSON. Actual selected module code has ordinary Node permissions.
- Fresh-main isolated branch; actual baseline9b7fd56 built bytes captured before source changes. User synthetic truth/no paid providers/authority/history. Preserve concurrent heads and exact reviewed green PR/deployment/source checkpoints.

## Review Focus

1. Candidate filtering must never narrow IDF or occurrence caches, including per-document explanations and later unrestricted calls sharing a cache (Task1 global-statistics/cache tests).
2. Nested AND/OR/alternatives/exclusions, repeated clauses, empty groups and candidate/only intersections must retain exact score accumulation/membership and insertion tie order after remove/replace/snapshot (Task1 exhaustive public and engine tests).
3. Negative clauses must retain membership while avoiding all normalization/trace work; an empty intersection must not accidentally match excluded-only groups (Task1 actual length-getter and nested empty tests).
4. Paired benchmark failures, divergent rankings, missing/rebuilt modules or deadline/oversized output must never emit a partial success; module paths/raw failures must stay out of sanitized refusals (Task2 actual child/CLI tests).
5. A favorable pooled timing must not hide reversed-order/broad-query regressions or be presented as production/general scale evidence (Task3 raw per-query controls/limits and actual public docs).

### Task 1: Candidate-aware execution with exact-result regression checks

**Files:** src/engine/execute.ts; test/engine/candidates.test.ts (new).

**Interfaces:** extend internal ExecutionContext as above, preserve executePlan(plan,context):Hits and existing scorer. No SearchIndex API edits.

- [ ] Write actual FieldIndex/context tests using length getters: rare-first AND reads lengths only for matches surviving each child; negative membership never normalizes or traces; global IDF/caches/caller candidate map unchanged. Run focused test and see expected extra-scoring failures.
- [ ] Add deterministic public exhaustive-explain ranking comparisons across mixed grammar/field/tie/mutation/snapshot/finite-limit cases before production edits. Keep independent literal BM25F expectations in old tests.
- [ ] Implement candidate filtering/score suppression in existing interpreter, preserving recursive addition order and shared full occurrences. Run focused tests then complete npm test. Expected all pass. Commit and task-done with npm test.

### Task 2: Maintained exact paired benchmark

**Files:** examples/filtering-workload.js; scripts/bench-filtering.js; scripts/bench-filtering-worker.js; test/filtering-benchmark.test.js (new); package.json.

**Interfaces:** makeFilteringWorkload(documentCount,warmupCycles,measurementCycles) returns fixed protocol/documents/eightqueries/options/limit10; runFilteringBenchmark({baseline,candidate,smoke=false,workerTimeoutMs=30000}) returns JSON report or throws; CLI accepts only two absolute trusted module paths plus optional --smoke/standalone --help. Worker reads fixed bounded stdin and writes one raw trial; imports selected module, records input/module hashes, full ranking digests and timed samples/digests. Parent validates counts/identities/hashes, compares all ranking digests, rechecks module bytes and summarizes per query with existing nearest-rank summarize logic (pure JS local function or move existing generic helper only if useful; do not modify old benchmark contract).

- [ ] Before production runner, write node:test actual-workload literal/determinism/bounds tests and smoke parent/worker parity/identity/raw summaries, invalid flags/missing files, divergent fake module, and real killed hung-module tests. Run node --test test/filtering-benchmark.test.js; expected missing helper/command failure.
- [ ] Implement fixed workload and bounded synchronous fresh workers with alternating module order, module bytes/digests, complete ranking parity and all raw samples. No hidden tuning or writes. Add bench:filtering and test:filtering scripts; include test:filtering in npm check. Existing glossary benchmark untouched.
- [ ] Run native tests plus formatting/lint/typecheck. Expected all pass. Commit and task-done npm run test:filtering.

### Task 3: Measurements, docs, complete verification and shipping

**Files:** docs/EXECUTION.md (new), docs/benchmarks/2026-10-26-filtering.json (new raw report); README.md; docs/DESIGN.md; CHANGELOG.md.

**Interfaces:** document candidate-aware TAAT and remaining full occurrence materialization; report source/module context and per-query controls accurately.

- [ ] Run maintained full paired benchmark on captured9b7fd56 ESM and candidate built ESM. Independently reconcile raw statistics/digests/PIDs/module hashes. Publish raw receipt/all per-query summaries, including slower controls and limitations. No favorable-only selection.
- [ ] Run npm run check, npm run test:browser, npm run eval and original benchmark smoke. Capture installed-package/no-runtime-deps parity. Commit.
- [ ] Generate package9b7fd56..exactHEAD, one fresh independent review, resolve only Critical/Important via RED→GREEN and full suite; ledger deferred minors/rulings/costs. Attach PR, connector-only hosted CI reads, exact reviewed green merge, actual public demo/source verification. Integrate useful truthful capability in portfolio from current main and save exact full recoverable source/output checkpoint and actual session accounting.
