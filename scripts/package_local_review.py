#!/usr/bin/env python3
"""Build a new, public-source-only local-review bundle. Requires npm/dev dependencies."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COPIED = (
    'LICENSE', 'docs/LOCAL_COMPARISON.md', 'docs/LOCAL_RELEVANCE.md',
    'examples/search-docs.js', 'examples/local-review-core.js',
    'examples/fixtures/relevance-notes/recovery.md',
    'examples/fixtures/relevance-notes/retention.md',
    'examples/fixtures/relevance-notes/webhooks.md',
    'examples/fixtures/relevance-notes/judgments.json',
    'examples/fixtures/relevance-notes/judgments-unmet.json',
)


class Refusal(Exception):
    pass


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=True) + '\n').encode()


def record(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def run_build(command, timeout=120):
    if os.name != 'posix':
        raise Refusal('BUILD_FAILED: The maintainer builder requires a POSIX process-group host.')
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException as error:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.stdout.close()
            process.stderr.close()
            process.wait(timeout=5)
        if isinstance(error, subprocess.TimeoutExpired):
            raise Refusal('BUILD_FAILED: npm pack exceeded its build deadline.') from error
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def prepare():
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    if not isinstance(package, dict):
        raise Refusal('BUILD_FAILED: Expected searchlite package metadata.')
    version = package.get('version', '')
    if (package.get('name') != 'searchlite' or not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version)
            or package.get('dependencies', {}) != {}):
        raise Refusal('BUILD_FAILED: Expected a stable zero-runtime-dependency searchlite package.')
    npm = shutil.which('npm')
    if npm is None:
        raise Refusal('BUILD_FAILED: npm is required; install development dependencies first.')
    name = 'searchlite-' + version + '.tgz'
    with tempfile.TemporaryDirectory(prefix='searchlite-pack-') as scratch:
        try:
            completed = run_build([npm, 'pack', '--offline', '--pack-destination', scratch])
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Refusal('BUILD_FAILED: npm pack did not complete within its build boundary.') from error
        if completed.returncode:
            raise Refusal('BUILD_FAILED: npm pack failed; check installed dependencies and npm run build.')
        packed = Path(scratch) / name
        if not packed.is_file() or packed.stat().st_size > 8 * 1024 * 1024:
            raise Refusal('BUILD_FAILED: Missing or excessive package tarball.')
        tarball = packed.read_bytes()
    files = {name: tarball}
    for relative in COPIED:
        source = ROOT / relative
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 1024 * 1024:
            raise Refusal('BUILD_FAILED: Invalid public source whitelist entry.')
        files[relative] = source.read_bytes()
    files['package.json'] = encoded({
        'name': 'searchlite-local-review', 'version': version, 'private': True, 'type': 'module',
        'engines': {'node': '>=20'}, 'dependencies': {'searchlite': 'file:./' + name},
    })
    files['README.md'] = f'''# Searchlite local review {version}

This bundle uses Node20+ and npm. It contains the built library, the exact public
local-document example and fictional note fixtures; no compiler, Python or other
build dependencies are needed to use it. Extract into a new directory, enter it,
then run:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund
node examples/search-docs.js index examples/fixtures/relevance-notes notes.json
node examples/search-docs.js search notes.json '"invoice retention"'
node examples/search-docs.js evaluate notes.json examples/fixtures/relevance-notes/judgments.json
node examples/search-docs.js compare notes.json notes.json examples/fixtures/relevance-notes/judgments.json
```

The last two commands produce complete passing JSON reports and exit0. With
judgments-unmet.json instead, they deliberately produce failing reports and exit3.
Choose a fresh snapshot filename when indexing again; existing files are refused.
Search, evaluation and comparison read saved snapshots, never original folders.
The copied local guides describe source-checkout build setup; that build is already
included here. Their comparison/relevance commands apply after this installation.

Use your own small Markdown/text folder and deliberate labels for your own checks.
Comparison requires the same stored document IDs/title/body, and any per-query
nDCG drop fails even when an average or minimum still passes. Reports may contain
private query text and document IDs; keep private reports local. No provider or
network retrieval is used. Fictional labels do not establish production quality.

bundle-manifest.json records exact payload bytes; external SHA256SUMS identifies
the tarball and ZIP. These hashes identify bytes, not authorship or source truth.
Source, full tests and release history: https://github.com/ult666666/searchlite/tree/v{version}
MIT license: LICENSE. This is a GitHub download, not an npm-registry publication.
'''.encode()
    manifest = {'schema': 'searchlite.local-review-bundle/1', 'version': version,
                'files': {key: record(raw) for key, raw in sorted(files.items())}}
    files['bundle-manifest.json'] = encoded(manifest)
    archive_name = 'searchlite-local-review-' + version + '.zip'
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as z:
        for relative, raw in sorted(files.items()):
            info = zipfile.ZipInfo('searchlite-local-review-' + version + '/' + relative,
                                   date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            z.writestr(info, raw, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    outputs = {name: tarball, archive_name: archive.getvalue()}
    outputs['SHA256SUMS'] = ''.join(
        record(raw)['sha256'] + '  ' + filename + '\n'
        for filename, raw in sorted(outputs.items())).encode()
    return version, outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', help='new output directory with an existing parent')
    args = parser.parse_args()
    # Keep the final path component un-followed so broken symlinks are also refused.
    output = Path(os.path.abspath(args.output))
    created = False
    written = []
    try:
        if output.exists() or output.is_symlink() or not output.parent.is_dir():
            raise Refusal('OUTPUT_REFUSED: Choose a new directory with an existing parent.')
        version, outputs = prepare()
        output.mkdir(exist_ok=False)
        created = True
        for filename, raw in outputs.items():
            target = output / filename
            with target.open('xb') as handle:
                written.append(target)
                handle.write(raw)
        print(json.dumps({'schema': 'searchlite.local-review-build/1', 'version': version,
                          'files': {key: record(raw) for key, raw in sorted(outputs.items())}}))
    except (Refusal, OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        for target in reversed(written):
            try:
                target.unlink()
            except OSError:
                pass
        if created:
            try:
                output.rmdir()
            except OSError:
                pass
        message = (str(error) if isinstance(error, Refusal) else
                   'BUILD_INTERRUPTED: Owned build stopped.' if isinstance(error, KeyboardInterrupt) else
                   'PACKAGE_FAILED: Bundle could not be completed.')
        print(message, file=sys.stderr)
        return 130 if isinstance(error, KeyboardInterrupt) else 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
