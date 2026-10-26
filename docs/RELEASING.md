# Reproduce the local-review release

Searchlite's GitHub release provides a built library tarball and an offline-installable local-review ZIP. The npm registry is not a publication target of this workflow. Older releases and their tags remain intact.

## Use the download

Download `searchlite-local-review-0.2.0.zip` and `SHA256SUMS` from [v0.2.0](https://github.com/ult666666/searchlite/releases/tag/v0.2.0). Compare the archive's SHA-256 with the published checksum, extract it into a new directory and enter its one top-level folder. The archive contains a README, local library tarball, private package manifest, exact public CLI example, fictional notes/labels, two guides, MIT license and a payload byte manifest.

With Node20+ and npm, run:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund
node examples/search-docs.js index examples/fixtures/relevance-notes notes.json
node examples/search-docs.js search notes.json '"invoice retention"'
node examples/search-docs.js evaluate notes.json examples/fixtures/relevance-notes/judgments.json
node examples/search-docs.js compare notes.json notes.json examples/fixtures/relevance-notes/judgments.json
```

No compiler, Python or build dependencies are needed by the extracted consumer. Installation uses the included local tarball and works with an empty npm cache. Only `searchlite` is installed, with zero runtime dependencies. Existing snapshots are never overwritten; use a new filename when indexing again. Search/evaluation/comparison use the snapshot even after original folders are removed. The copied guides describe source-checkout build setup; this download already includes that build.

The evaluation and unchanged comparison above pass with exit0. Using `judgments-unmet.json` deliberately produces a complete failing report and exit3. This is a synthetic negative control. Follow [local comparison](LOCAL_COMPARISON.md) for a real field-weight change whose offsetting improvements cannot conceal a per-query drop.

The standalone `searchlite-0.2.0.tgz` asset is the library package for consumers who want to install just the ESM/CJS builds and types. The local-review ZIP includes that same exact tarball. Neither artifact implies npm-registry publication.

## Build from reviewed source

Maintainer tooling uses Node20+, npm, Python3's standard library and a POSIX process-group host (tested on macOS and Ubuntu). Python is a build-time tool only. From a clean, reviewed source revision with development dependencies installed:

```sh
npm ci
npm run check
npm run test:browser
npm run eval
npm run package:local -- /absolute/path/to/a-new-release-directory
```

The parent directory must exist; the destination must be new. The builder refuses an existing file/directory or broken symlink before npm work. It runs `npm pack --offline`, whose existing prepack step builds fresh library outputs from this checkout. A 120-second deadline owns the npm process group; timeout terminates its spawned workers. It never installs missing dependencies or reads a private library. Only an explicit public-source whitelist is copied; there is no broad repository or filesystem scan.

It collects all payload bytes before creating the final destination and writes files exclusively. Expected failures remove only newly created output files and its owned temporary staging. It does not claim crash-proof filesystem transactions or containment against a hostile filesystem owner. Help exits0; invalid usage2; build/output failures1 with no success JSON. Ctrl+C terminates the owned build group, removes newly created outputs and exits130. A successful build prints one JSON receipt identifying these three files:

- `searchlite-0.2.0.tgz`: freshly built public package.
- `searchlite-local-review-0.2.0.zip`: fixed-metadata, sorted regular-file payload, including a local dependency manifest and `bundle-manifest.json`.
- `SHA256SUMS`: SHA-256 of the two actual downloadable artifacts.

The inner manifest records byte lengths and hashes of all other payload files. ZIP entries have relative paths and regular-file modes, with fixed metadata and no timestamp field in either JSON manifest. Compression tooling can affect archive bytes across environments; verify the actual built checksums and extracted payload rather than assuming universal byte-for-byte rebuild equivalence. Hashes identify bytes, not author identity, a signature or source truth.

## Verify and publish

```sh
npm run test:package
```

The maintained real-process suite builds the actual artifact, validates its exact inventory/source bytes/manifests, extracts it, installs with an empty offline cache, checks ESM/CJS and extreme-vector behavior, and runs index/search/evaluate/compare with both passing and expected exit3 controls. It deletes the original notes before evaluation and verifies unchanged saved inputs. Other cases cover usage, existing/broken/missing-parent outputs, absent npm and actual descendant cleanup on a short internal deadline and Ctrl+C interrupt. Existing Node20/22/24 CI includes this suite. No test-only deadline override is exposed by the builder CLI.

Before publishing, verify the exact reviewed head is green, merge without unrelated changes and build again from the merged source. Create a new tag on that exact merged revision and publish its three artifacts, keeping old tags/releases. Read hosted CI through the normal GitHub review tools. Finally download the public assets, verify their hashes and rerun the extracted offline consumer; a prepared local artifact alone does not establish public delivery.

This package retains the source CLI's bounds and privacy/authenticity limits. Reports can contain private query text, labels and IDs; keep private reports local. Synthetic fixtures, finite numerical checks and paired historical timings do not establish general retrieval/model quality, production latency, source authenticity or organizational approval.
