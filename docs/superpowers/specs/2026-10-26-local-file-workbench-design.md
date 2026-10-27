# Local-file relevance workbench

## Intent and decision

The owner delegated comprehensive portfolio engineering and selected AI tools. The next source-backed gap is making the existing saved-index CLI comparison usable through the public browser demo. This is the implementer's choice under that delegation, not a new owner requirement. Main231ef73 and Lineage5d are clean, green, without open PRs; preserve concurrent work.

Approaches considered: another CLI lifecycle command adds capability but leaves browser reviewers outside the local-data workflow; a server upload endpoint adds storage/privacy/infrastructure without helping deterministic local comparison. Choose a static local-file workbench using the existing engine, metrics, bounded snapshot/label contracts and exact report schema. No new backend, account, provider, runtime dependency or library API.

## Contract

New `local.html`, discoverable from search and fixed relevance pages. Select baseline/candidate snapshot JSON plus one judgment JSON. The browser restores/searches both actual supplied indexes, requires identical storedID/title/body collections and applies the existing strict per-query minimum AND unrounded non-regression gate. Render pass/fail and failed IDs, a query selector, metrics and actual rank/grade lists; download the exact existing `searchlite.local-comparison/1` JSON. Render every input-derived value with textContent. Reports omit bodies but contain private queries/IDs. Input files are read in memory, without upload, storage, history/query parameters, analytics or provider calls.

Reuse one platform-neutral example core between Node CLI and browser worker. Inject existing SearchIndex/evaluate and SHA256 implementation; use global TextEncoder/TextDecoder. Preserve every legacy report byte, metric operation order, error code and CLI exit0/1/2/3. Preserve filesystem reader protections in the CLI. Helper is private example code, copied explicitly into future source-built portable bundles; publishedv0.2/tag591 remains unchanged. Node20+; browser uses existing supported Chromium verification.

Keep existing bounds:16MiB each snapshot,128documents,128KiB each body/1MiB bodies,256KiB judgments,1–32queries,1000UTF16 query units,1–128judgments/query,100retrieved results. Check File.size before reading and exact returned byte lengths before decoding. Both inputs/late queries must validate before any report or download exists.

Load a clearly synthetic two-document title/body weight-change example using real engine snapshots; offer unchanged and regressed controls, and download the three exact synthetic input files for CLI reproduction. These are fictional fixtures, not customer cases. Private file selection updates individual slots; show exactly which filenames are selected.

Worker is self-contained inline Vite output, available after page load offline. It owns parsing/restoration/search/hash work; one15second end-to-end deadline covers file reads/startup/comparison. Clear, input selection changes, replacement runs, deadline, error and nonpersisted navigation terminate the owned worker and invalidate pending file reads/messages. No partial/old report may reappear. Revoke obsolete blob downloads; persisted page transitions retain a completed report, cancel pending work. Clear drops application references/rendered data; no secure memory-erasure claim.

## Verification and delivery

Pin pre-refactor actual CLI outputs/errors and compare against extracted shared core on identical owned bytes. Existing94CLI consumer tests remain unchanged; package tests must prove the extra whitelisted helper runs in an extracted offline bundle. Built browser tests run real worker and real supplied files, compare downloads byte-for-byte to native CLI, cover both controls, mismatch/malformed/oversized/UTF8/query errors, stale reads/messages, cancellation/deadline, XSS/control strings, no storage/network leaks, offline use and narrow/keyboard operation. No weakened existing assertions, retries or hidden provider calls.

One fresh independent whole-branch review; fix substantive findings through TDD, exact green merge, verify actual Pages bytes and anonymous public full workflow. Integrate truthful discoverability in the portfolio if its current source still matches known main. Save a new exact-source/bundle/verification checkpoint; preserve priorsealed checkpoint. No new hours/automation inferred. Final accounting records only substantive work.
