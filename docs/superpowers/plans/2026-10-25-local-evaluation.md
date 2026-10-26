# Local snapshot relevance evaluation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans natively with one fresh independent whole-branch review.

**Goal:** Evaluate caller-labelled questions against a saved bounded local snapshot with explicit per-query nDCG@10 criteria.

**Architecture:** Extend the existing built-package ESM consumer and reuse its safe reader/snapshot validator. Compose public SearchIndex/evaluate; emit a deterministic identity-bearing JSON report without writing files or modifying engine/browser behavior.

**Tech Stack:** Node20+ standard libraries, built searchlite exports, existing Vitest/process tests. No new dependency.

**Spec:** docs/superpowers/specs/2026-10-25-local-evaluation-design.md

## Global constraints

- Command: node examples/search-docs.js evaluate SNAPSHOT JUDGMENTS. Existing index/search behavior preserved.
- Manifest searchlite.local-judgments/1:1–32 unique queries, each <=1000 UTF-16 units/no NUL, exact fields, finite[0,1] minimumNdcgAt10,1–128 unique existing document judgments with integer0–3 and at least one positive.
- Snapshot bound16MiB and existing128-document/text/path restrictions remain; judgments <=256KiB and existing regular/unlinked safe reads. Hash the same bytes used, no rereads of user sources.
- JSON report searchlite.local-evaluation/1; complete raw metrics/rankings/thresholds/input identity and saved options, terminal-safe string encoding, no source bodies, clocks/randomness or authenticity claim.
- Exit0 pass,3 valid unmet criterion,1 malformed/read/query failure with no partial report,2 usage. No writes, private uploads, provider calls, core API/formula/corpus/browser changes or new dependencies.

## Review focus

1. A valid unmet criterion emits full JSON and exit3, while malformed late records emit no partial report (Task1 process tests).
2. Snapshot/input hashes must identify the actual used bytes; deletion of original folders must not change results or trigger reads (Task1).
3. Numeric boundaries, empty/negative labels, duplicate IDs, prototypes/unknown fields and missing doc references cannot silently weaken criteria (Task1 matrix).
4. Private query/ID controls must remain semantically intact in JSON without raw terminal controls; read-only refusal must cover unsafe/oversized/invalid UTF-8 manifests (Task1).
5. Native examples must work through an externally installed packed package, with public metric cutoffs and documented failure exits (Task2).

## Task1: Validated built-package evaluation and real process tests

Files: modify examples/search-docs.js; create test/local-evaluation.test.ts.

Interfaces: existing restore(file) becomes {index,data}; searchSnapshot destructures index without behavior change. evaluateSnapshot(snapshotFile,judgmentsFile) uses shared readBounded, validates full exact manifest, calls public evaluate over100-result rankings, emits report and sets exit0/3. Imported createHash identifies both exact byte buffers. Existing catch emits bounded errors; new invalid-input codes INVALID_JUDGMENTS/JUDGMENTS_LIMIT/INVALID_QUERY preserve no-stdout failures.

- [ ] Write process tests before implementation with a tiny three-document corpus and hand-derived expected ranks/metrics, pass/failed thresholds, exact bytes/hashes, safe Unicode JSON and deterministic/no-write behavior. Add table-driven malformed-schema/reference/numeric/bounds/encoding/unsafe-file cases including late invalid query syntax.
- [ ] Witness missing-command RED, then implement existing-safe-reader reuse, complete validation, public metric composition and JSON string safety. Run focused tests and the full suite/lint/type/format/package/browser/eval; commit.

## Task2: Fictional end-to-end fixture and maintained documentation

Files: create examples/fixtures/relevance-notes/{retention.md,webhooks.md,recovery.md,judgments.json}, docs/LOCAL_RELEVANCE.md; modify README.md and existing workbench guide to point to this separate local workflow without changing browser scope.

Interfaces: direct Node index/evaluate commands use a new mktemp directory and explicit bundled manifest. Show a valid unmet criterion via a copied/edited manifest and exit3, with unchanged source inputs. Reports carry no approval or production-quality claim. Correct npm run check wording to exclude both separate eval and Chromium journey.

- [ ] Run actual fixture through built package, independently inspect positive and unmet reports, then pack/install into a new external consumer and run the same source consumer copied outside the repo against installed exports. Confirm no runtime dependencies and original saved inputs unchanged.
- [ ] Document all fields/limits/cutoffs/privacy/identity/exit semantics and run full checks/browser/eval. Commit and get fresh exact-head independent review; fix Important findings with witnessed regressions.
- [ ] Reconcile current remote/open jobs, attach PR, merge only exact approved green head, verify mainCI/public source. Integrate both shipped searchlite workflows into catalog with independent review/exact-green publication/public checks; archive exact sources/reports/reviews/CI/public evidence and finish actual accounting.
