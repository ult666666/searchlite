# Search a local folder

[`examples/search-docs.js`](../examples/search-docs.js) indexes a folder of Markdown and text
files into a saved snapshot, then searches that snapshot. The
[README walkthrough](../README.md#search-your-local-documents) shows the commands. This page lists
the exact behavior and limits.

## Index

`index` creates one document per nonempty UTF-8 `.md` or `.txt` file (extensions are
case-insensitive). IDs are root-relative paths with forward slashes; titles are filenames
without extensions, boosted by 3; bodies contain the complete literal text. Markdown/code is
searchable text. Directory entries are walked in sorted code-unit order, giving deterministic
IDs and tie order. The output is the existing `SearchIndex.toJSON()` format.

## Search

`search` restores the saved title/body index with `SearchIndex.fromJSON()` and prints at most
five matches: ID, score, a plain snippet and `formatExplanation()`'s BM25F breakdown. It reads
no original document, so the snapshot remains searchable after those files move or change.
Reindex into a new snapshot to refresh it. Snippets use the first 180 Unicode characters with
whitespace collapsed; control and bidirectional formatting characters are escaped throughout
results, explanations and diagnostics. Source markup remains plain terminal text.

## Limits

| Bound                                                             | Limit                   |
| ----------------------------------------------------------------- | ----------------------- |
| Each eligible file                                                | 128 KiB                 |
| All eligible file bytes, including whitespace-only files          | 1 MiB                   |
| Eligible `.md`/`.txt` files                                       | 128                     |
| Visited entries, including skipped entries in visited directories | 4,096                   |
| Directory levels below the selected root                          | 16                      |
| Snapshot file                                                     | 16 MiB                  |
| Query                                                             | 1,000 UTF-16 code units |

Hidden entries and symlinks are skipped. These dependency/generated directory names are skipped
case-insensitively: `node_modules`, `bower_components`, `vendor`, `dist`, `build`, `coverage`,
`out`, `output`, `target`, `generated`, `__pycache__`. A selected root inside an excluded path,
linked roots/ancestors/snapshots, nonregular or multiply-linked inputs, invalid UTF-8, NUL text,
and unreadable included inputs are refused. Unsupported extensions and whitespace-only files
are ignored. Failed source scans create no snapshot.

## Outputs and exit codes

Snapshot parents must already exist. **Existing output files are never overwritten**, including
when the requested output collides with a source document; indexing preserves input bytes.
Search is read-only and leaves malformed snapshots untouched. Exit 0 means success (including
no matches), 1 an input/read/query/snapshot failure, and 2 invalid command arguments.

## Scope

Snapshots contain the original document text and are historical local data, without freshness
or authenticity guarantees. This is a bounded example for folders you control. It is not
production filesystem search, and it does not protect against another process changing the
folder while it runs. No provider, embedding, browser or internet retrieval is involved.
