import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const built = join(root, 'dist/index.js');
const temporary = mkdtempSync(join(tmpdir(), 'searchlite-pruning-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const cli = (...args) =>
  spawnSync(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/bench-pruning.ts'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );

test('smoke run pairs one build with itself and reports memory, size and exact parity', () => {
  const result = cli(`--baseline=${built}`, `--candidate=${built}`, '--smoke');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'searchlite.pruning-benchmark/1');
  assert.equal(report.exactRankingParity, true);
  assert.deepEqual(
    report.workloads.map((w) => [w.workload, w.documentCount]),
    [
      ['glossary', 120],
      ['zipf', 120],
    ],
  );
  for (const workload of report.workloads) {
    for (const side of [workload.baseline, workload.candidate]) {
      assert(Number.isInteger(side.postingsBytes) && side.postingsBytes > 0);
      assert(Number.isInteger(side.snapshotBytes) && side.snapshotBytes > 0);
    }
    // The same build in two processes: heap snapshots can differ by a few hundred bytes.
    const [a, b] = [workload.baseline.postingsBytes, workload.candidate.postingsBytes];
    assert(Math.abs(a - b) <= 0.01 * a, `${a} vs ${b}`);
    assert(workload.queries.every((q) => q.baseline.count === 1 && q.candidate.count === 1));
  }
});

test('refuses builds whose rankings differ, and invalid usage', () => {
  const different = join(temporary, 'reversed.js');
  writeFileSync(
    different,
    `import { SearchIndex as Base } from ${JSON.stringify(pathToFileURL(built).href)};\n` +
      'export class SearchIndex extends Base { search(q, o) { return super.search(q, o).reverse(); } }\n',
  );
  const mismatch = cli(`--baseline=${built}`, `--candidate=${different}`, '--smoke');
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stdout, '');
  assert.match(mismatch.stderr, /no report is available/);
  assert.equal(cli('--help').status, 0);
  for (const args of [
    [],
    ['--smoke'],
    [`--baseline=${built}`],
    ['--baseline=dist/index.js', `--candidate=${built}`],
    [`--baseline=${built}`, `--candidate=${built}`, '--smoke', '--smoke'],
    ['--help', '--smoke'],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage/);
  }
});
