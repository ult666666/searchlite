# Developing searchlite

Requires Node 20 or newer. CI runs Node 20, 22 and 24.

## Scripts

```bash
npm ci
npm run lint            # ESLint (typescript-eslint strict + stylistic, type-aware)
npm run format:check    # Prettier
npm run typecheck       # tsc for the tests/scripts, the browser-safe library and the demo
npm run test:coverage   # Vitest; fails below 90% line/branch/function/statement coverage
npm run test:filtering  # paired filtering benchmark: failures, deadlines and output bounds
npm run test:pruning    # paired pruning and memory harness: smoke run, parity and refusals
npm run test:package    # the offline local-review bundle builder
npm run test:release    # the release workflow: pack, checksums and smoke test
npm run build           # tsup: ESM + CJS + .d.ts in dist/
npm run check:dist      # loads both builds through package.json "exports"
npm run build:demo      # Vite build of demo/ into demo/dist
npm run eval            # the evaluation table in the README
npm run test:browser    # Chromium journeys through the built demo (needs build and build:demo)
npm run dev             # demo dev server at http://localhost:5173/searchlite/
```

`npm run check` runs everything from `lint` to `build:demo`. The browser tests need Chromium
(`npx playwright install chromium`).

The [CI workflow](../.github/workflows/ci.yml) runs `npm run check`'s steps and `npm run eval` on
every push and pull request, on all three Node versions, and the browser journeys in a separate
job. The [Pages workflow](../.github/workflows/pages.yml) deploys the demo to GitHub Pages on
pushes to `main` (Pages must use the "GitHub Actions" source in the repository settings). Why
some toolchain packages stay on older majors is in
[DESIGN.md](DESIGN.md#15-toolchain-notes).

## Benchmarks

`npm run build && npm run --silent bench > benchmark.json` records build and search timings,
process memory and the machine and Node versions at 1,000 and 10,000 synthetic documents.
`npm run --silent bench -- --smoke` runs the same workflow on smaller collections without a timing
gate. [BENCHMARK.md](BENCHMARK.md) describes the method and a recorded run. The glossary
vocabulary repeats and the query mix is uniform, so these numbers say little about production
latency.

`npm run --silent bench:pruning -- --baseline=/abs/main/dist/index.js --candidate=/abs/dist/index.js`
measures two builds side by side and reports only when their rankings are byte-identical.
[EXECUTION.md](EXECUTION.md#measured-results-november-2-2026) has the results behind the
README's performance table, including the 1,000-document runs, where the median speedups are
1.4× and 2.5×. It also covers the earlier candidate-aware AND and exclusion change, measured the
same way against a baseline build.

## Layout

```text
src/
  analysis/    tokenizer, normalization, stopwords, Porter stemmer, per-field analyzer
  query/       lexer, recursive-descent parser, AST types
  structures/  trie, edit distance, top-k heap
  engine/      field index, query planning, execution, BM25, highlighting
  internal/    shared helpers
  index.ts, search-index.ts, hybrid.ts, evaluation.ts, format.ts, options.ts, errors.ts
test/          unit, property and process tests; browser/ holds the Chromium journeys
corpus/        glossary documents and judged queries
examples/      quick start, local search CLI, relevance comparison, benchmark workloads
scripts/       evaluation, comparison, benchmarks, dist check, local-review bundle builder
demo/          Vite web demo: search, relevance workbench, local file workbench
docs/          design notes, workflow guides and benchmark records
```
