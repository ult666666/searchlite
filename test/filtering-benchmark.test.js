import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFilteringWorkload } from '../examples/filtering-workload.js';
import { runFilteringBenchmark } from '../scripts/bench-filtering.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const built = join(root, 'dist/index.js');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cli = (...args) =>
  spawnSync(process.execPath, [join(root, 'scripts/bench-filtering.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
const pair = ['--baseline=' + built, '--candidate=' + built, '--smoke'];

test('fixed synthetic skew, query controls and independent copies are literal and bounded', () => {
  const a = makeFilteringWorkload(120, 1, 1);
  const original = JSON.stringify(a);
  assert.equal(a.protocol, 'searchlite.filtering-workload/1');
  assert.equal(a.documents.length, 120);
  assert.equal(new Set(a.documents.map((d) => d.id)).size, 120);
  assert.equal(a.queries.length, 8);
  assert.equal(a.documents[0].body, 'common needle shared phrase excluded');
  assert.equal(a.documents.filter((d) => d.body.includes('needle')).length, 2);
  assert.equal(a.queries[0].text, 'needle AND common');
  assert.equal(a.queries[1].text, 'common AND needle');
  assert.equal(a.queries[7].text, 'common OR secondary');
  a.documents[0].tags.push('mutated');
  a.queries[0].text = 'mutated';
  assert.equal(JSON.stringify(makeFilteringWorkload(120, 1, 1)), original);
  for (const bad of [0, 10001, 1.5, NaN])
    assert.throws(() => makeFilteringWorkload(bad, 1, 1), RangeError);
  assert.throws(() => makeFilteringWorkload(120, -1, 1), RangeError);
  assert.throws(() => makeFilteringWorkload(120, 1, 0), RangeError);
});

test('real smoke uses two fresh public-module workers and reconciles all raw samples', () => {
  const run = cli(...pair);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const report = JSON.parse(run.stdout);
  assert.equal(report.schema, 'searchlite.filtering-benchmark/1');
  assert.deepEqual(report.profile.documentCounts, [120]);
  assert.equal(report.modules.baseline.sha256, digest(readFileSync(built)));
  assert.deepEqual(report.modules.baseline, report.modules.candidate);
  const size = report.sizes[0];
  const expectedHash = digest(JSON.stringify(makeFilteringWorkload(120, 1, 1)));
  assert.equal(size.workloadSha256, expectedHash);
  assert.equal(size.trials.length, 2);
  assert.equal(new Set(size.trials.map((t) => t.processId)).size, 2);
  for (const trial of size.trials) {
    assert.notEqual(trial.processId, process.pid);
    assert.equal(trial.documentCount, 120);
    assert.equal(trial.workloadSha256, expectedHash);
    assert.equal(trial.samples.length, 8);
    assert.equal(trial.rankings.length, 8);
    assert.equal(trial.rankings[0].resultCount, 2);
    assert.equal(trial.rankings[6].resultCount, 118);
    assert(trial.buildMs >= 0 && Number.isFinite(trial.buildMs));
  }
  assert.deepEqual(size.trials[0].rankings, size.trials[1].rankings);
  for (const summary of size.queries)
    for (const label of ['baseline', 'candidate']) {
      const samples = size.trials
        .filter((t) => t.module === label)
        .flatMap((t) => t.samples.filter((s) => s.queryId === summary.id).map((s) => s.searchMs));
      const sorted = [...samples].sort((a, b) => a - b);
      assert.equal(summary[label].count, samples.length);
      assert.equal(summary[label].meanMs, samples.reduce((a, b) => a + b, 0) / samples.length);
      assert.equal(summary[label].p50Ms, sorted[Math.ceil(samples.length * 0.5) - 1]);
      assert.equal(summary[label].p95Ms, sorted[Math.ceil(samples.length * 0.95) - 1]);
    }
  assert.equal(report.exactRankingParity, true);
  assert(!run.stdout.includes(root), 'Report excludes module paths');
});

test('usage failures and missing trusted module produce no partial success or private argument echo', () => {
  assert.equal(cli('--help').status, 0);
  for (const args of [
    [],
    ['--help', '--smoke'],
    ['--smoke'],
    [...pair, '--smoke'],
    [...pair, '--baseline=' + built],
    ['--baseline=relative.js', '--candidate=' + built],
    [...pair, '--private-canary-argument'],
  ]) {
    const run = cli(...args);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^Usage:/);
    assert(!run.stderr.includes(root));
    assert(!run.stderr.includes('private-canary-argument'));
  }
  const missing = cli('--baseline=/missing/private-canary.js', '--candidate=' + built, '--smoke');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^Filtering benchmark failed/);
  assert(!missing.stderr.includes('private-canary'));
});

test('divergent rankings and throwing/oversized-output modules are refused without partial JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'searchlite-filtering-refusal-'));
  try {
    const file = join(directory, 'candidate.mjs');
    for (const source of [
      'export class SearchIndex { addAll(d){this.size=d.length} search(){return []} }',
      'throw new Error("SYNTHETIC_PRIVATE_CANARY");',
      'process.stdout.write("x".repeat(3*1024*1024)); export class SearchIndex {}',
    ]) {
      writeFileSync(file, source);
      const run = cli('--baseline=' + built, '--candidate=' + file, '--smoke');
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^Filtering benchmark failed/);
      assert(!run.stderr.includes(directory));
      assert(!run.stderr.includes('SYNTHETIC_PRIVATE_CANARY'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual nonterminating owned module is killed at an injected internal deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'searchlite-filtering-deadline-'));
  try {
    const file = join(directory, 'hang.mjs');
    writeFileSync(file, 'while(true) {}');
    assert.throws(
      () =>
        runFilteringBenchmark({
          baseline: file,
          candidate: built,
          smoke: true,
          workerTimeoutMs: 200,
        }),
      { code: 'WORKER_DEADLINE' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual oversized child stdout is bounded and an ordinary concurrent module rebuild is detected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'searchlite-filtering-module-change-'));
  try {
    const overflow = join(directory, 'overflow.mjs');
    writeFileSync(
      overflow,
      'process.stdout.write("x".repeat(3*1024*1024)); export class SearchIndex {addAll(d){this.size=d.length} search(){return []}}',
    );
    assert.throws(
      () => runFilteringBenchmark({ baseline: overflow, candidate: built, smoke: true }),
      { code: 'WORKER_OUTPUT_LIMIT' },
    );
    const change = join(directory, 'change.mjs');
    writeFileSync(
      change,
      'import {appendFileSync} from "node:fs"; import {fileURLToPath} from "node:url"; export {SearchIndex} from ' +
        JSON.stringify(new URL('../dist/index.js', import.meta.url).href) +
        '; appendFileSync(fileURLToPath(import.meta.url), "\\n// synthetic rebuild");',
    );
    const run = cli('--baseline=' + built, '--candidate=' + change, '--smoke');
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^Filtering benchmark failed/);
    assert(!run.stderr.includes(directory));
    assert(readFileSync(change, 'utf8').endsWith('\n// synthetic rebuild'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
