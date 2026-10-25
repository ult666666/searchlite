# Local Documents Consumer Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate real bounded local-document indexing, persisted snapshots and explained search using built public package exports.

**Architecture:** One ESM consumer with explicit index/search commands; Node filesystem reads are bounded and link-aware, and public SearchIndex APIs own indexing/snapshot restoration/scoring. Real CLI tests build the distribution once and exercise temporary corpora and persisted JSON.

**Tech Stack:** Node 20+, existing ESM searchlite distribution, standard filesystem/path/util APIs, existing Vitest/TypeScript development tools.

**Spec:** `docs/superpowers/specs/2026-10-25-local-docs-design.md`

## Global Constraints

- No new runtime dependency or provider/network/browser capability.
- Import only built searchlite public exports plus Node standard libraries.
- Limits: 128 KiB/file, 1 MiB/corpus, 128 eligible files, 4,096 visited entries, depth 16, 16 MiB/snapshot.
- Existing outputs are never overwritten; failed source scans write no snapshot.
- Parent reviews exact PR head; no merge or other repository edits.

## Review Focus

- Stable relative IDs and deterministic tie order survive the real JSON write/reload boundary.
- Linked roots/inputs/snapshots, excluded trees and malformed text never leak into an index.
- File, corpus, traversal and snapshot limits fail before unbounded reads/allocations.
- Terminal control/bidirectional characters cannot execute or rearrange printed results/diagnostics.
- Malformed/incompatible snapshots and unreadable inputs fail clearly without modifying originals.

### Task 1: Runnable consumer, real CLI contracts and documentation

**Files:** Create `examples/search-docs.js`, `test/search-docs.test.ts`; modify `package.json`, `README.md`, `CHANGELOG.md`.

**Interfaces:** `node examples/search-docs.js index DIRECTORY SNAPSHOT`; `node examples/search-docs.js search SNAPSHOT QUERY`; npm alias `search:docs`. Existing public library APIs and zero runtime dependencies remain unchanged.

- [ ] Write temporary-corpus CLI tests for real indexing/reload/search, literal results/explanation, stable IDs/order, source deletion after snapshot, safe output and input/output/link/size/depth/error boundaries.
- [ ] Run new tests against missing example; observe expected failures.
- [ ] Implement the consumer with bounded traversal/read/restore and explicit errors, then run new tests to GREEN.
- [ ] Document exact commands/semantics/limits and a real source-tree example; add npm alias and changelog.
- [ ] Run lint, formatting, typecheck, full coverage suite, build/ESM+CJS exports, browser-demo build and eval; preserve baseline evaluation output.
- [ ] Execute documented source-tree index → persisted search example; check the diff and public output.
- [ ] Commit, refresh public main, push scoped feature branch, create/attach PR and report exact head for parent review.
