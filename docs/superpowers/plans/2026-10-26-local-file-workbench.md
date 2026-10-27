# Local-file Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring actual bounded saved-index comparison to the browser with byte-identical native reports and local-only files.
**Architecture:** Extract existing example semantics into a platform-neutral dependency-injected core. Use it from the existing Node wrapper and one inline browser worker. The UI owns file selection, generation invalidation,15second deadlines, safe rendering and blob lifecycle.
**Tech Stack:** Existing Node20+/TypeScript/Vite/Playwright/Pythonstdlib maintainer tooling; no new dependencies.
**Spec:** docs/superpowers/specs/2026-10-26-local-file-workbench-design.md

## Global Constraints

- Current branch based on231ef73; preserve all prior public APIs, schema, CLI report bytes, exit codes, filesystem protections and immutablev0.2/tag591.
- Existing bounds16MiB/snapshot,256KiB judgments,128documents,128KiB/body,1MiB bodies,32queries,1000queryunits,100resultdepth. No runtime dependencies/provider/storage/network upload.
- Browser worker inline/self-contained; end-to-end15000ms deadline, Clear/change cancels and invalidates all stale completion. DOM text only, bounded diagnostics; private inputs never enter URLs/storage.

## Review Focus

- Async reads finishing after Clear/change/navigation must not recreate report/download; test deferred reads and late worker events in Task2.
- A malformed second snapshot or late query must never leave partial/previous success; test real restored invalid files and actual CLI parity in Task1/2.
- After a fully loaded page goes offline, a fresh comparison must still run; actual inline-worker offline test in Task2.
- New shared helper must be present in portable consumers without altering historical release bytes; actual extracted empty-cache bundle test in Task1/3.
- Untrusted filenames/query/document IDs must stay literal and absent from URL/storage/network; real browser text injection, request interception and storage sentinels in Task2.

### Task 1: Shared example comparison core and native parity

**Files:** examples/local-review-core.js, examples/local-review-core.d.ts; examples/search-docs.js; test/local-review-core.test.ts; scripts/package_local_review.py; test/local-package.test.js.
**Interfaces:** `createLocalReviewer({SearchIndex,evaluate,digest})` returns `restore(Uint8Array)`, async `evaluate(loaded,judgmentsBytes)`, async `compare(baseline,candidate,judgmentsBytes)`; named `LocalReviewError`, `serializeLocalReport`. Digest acceptsUint8Array andreturnshexstring/Promise. Return shape is exactly current comparison schema; declarations expose needed typed projections to UI. Node reader/walker/output remain in CLI.

- [ ] Write failing direct-core tests using actual built-engine fixtures; pin legacy stdout/exit/report hashes from prior CLI independently. Verify module-missingRED, literal weight changefailure/title-task and unchangedpass/invalid inputs/hash determinism assertions.
- [ ] Extract existing code unchanged except platform-neutral byte/path handling and injected digest. Await existing CLI calls. Include helper in explicit bundle whitelist and expected inventory. No new public export or runtime dependency.
- [ ] Run new core, existing94consumer, package/nativepipeline checks and lint/type/format. Compare actual old/new CLI byte output on identical input buffers; commit. Final command `npx vitest run test/local-review-core.test.ts test/local-comparison.test.ts test/local-evaluation.test.ts test/search-docs.test.ts`.

### Task 2: Real local-file browser workflow

**Files:** demo/local.html; demo/src/local.ts, local-worker.ts, local.css; demo/vite.config.ts; demo/index.html/relevance.html navigation; test/browser/local-review.test.js; package.json/browserCI wiring as needed.
**Interfaces:** InlineWorker receives compare byte buffers or synthetic-control request; returns serialized report and optional exact fixture bytes, or bounded error code/message. UI stores only selected File objects and resulting report/downloads; generation plus owned-worker cleanup prevents stale completion.

- [ ] Add built browser regression; observe404/missingheadingRED before implementation. Actual uploads and nativeCLI downloads must match for0/3controls. Add deferred reads/messages,15s deadline, invalid/late/oversized/UTF8/query/XSS, offline, storage/request/URL and responsive/keyboard assertions.
- [ ] Implement accessible input controls, per-query actual rankings/metrics, exact JSON download, synthetic control/input downloads, Clear lifecycle and end-to-end deadline. Existing demo design reused; no persistence/newbackend.
- [ ] Run new real Chromium suite plus existing browser workflow; build/type/lint/format, commit. Final command `npm run test:browser` with both suites included.

### Task 3: Source-backed docs and reproducible checks

**Files:** README.md, docs/LOCAL_FILE_WORKBENCH.md, docs/LOCAL_COMPARISON.md, docs/RELEASING.md, CHANGELOG.md and integration assertion updates that reflect the new helper.
**Interfaces:** Publiclocal.html and exact CLI schema; public docs distinguish currentmain browser work from immutable0.2download.

- [ ] Document full reproducible synthetic/browser/private-file flow, bounds/gate/limits, worker deadline/Clear and input privacy. Update obsolete QuickStart0.1install link to existing0.2; oldrelease staysintact.
- [ ] Full check/browser/eval and actual package/pipeline proof; commit the documented local implementation.
- [ ] Final local taskcommand `npm run check`.

## Integration gates after local tasks

Fresh whole-branch independent review, exact green merge, actual public asset/worker/offline/native parity. Integrate the portfolio route only after current-main reconciliation and an independent reviewed/green change. Save a new source ZIP/full Git bundle/empty-repository recovery/public CI receipts/sealed checkpoint and actual accounting. Preserve older checkpoints. These post-review gates must pass before claiming delivery.
