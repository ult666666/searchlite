import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeWorkload, summarize } from '../examples/benchmark';

describe('benchmark workload and explicit nearest-rank summaries', () => {
  it('summarizes independent literal samples without mutating their order', () => {
    const values = [4, 1, 3, 2];
    expect(summarize(values)).toEqual({
      count: 4,
      minMs: 1,
      meanMs: 2.5,
      p50Ms: 2,
      p95Ms: 4,
      maxMs: 4,
    });
    expect(values).toEqual([4, 1, 3, 2]);
    expect(summarize([0])).toEqual({ count: 1, minMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    for (const bad of [[], [NaN], [Infinity], [-1]])
      expect(() => summarize(bad)).toThrow(/sample/i);
  });

  it('generates unique copied documents and the declared literal/grammar query mix', () => {
    const workload = makeWorkload(1000, 2, 4);
    expect(workload.documents).toHaveLength(1000);
    expect(new Set(workload.documents.map((d) => d.id)).size).toBe(1000);
    expect(workload.queries).toHaveLength(26);
    expect(workload.queries.map((q) => q.text)).toContain('"binary heap"');
    expect(workload.queries.map((q) => q.text)).toContain('title:hash*');
    expect(workload.queries.map((q) => q.text)).toContain('volatlity~1');
    const original = JSON.stringify(workload);
    const first = workload.documents[0];
    if (!first) throw new Error('No generated document');
    first.tags.push('changed');
    expect(JSON.stringify(makeWorkload(1000, 2, 4))).toBe(original);
    for (const count of [0, 10001, 1.5]) expect(() => makeWorkload(count, 2, 4)).toThrow();
  });
});

interface Trial {
  processId: number;
  documentCount: number;
  workloadSha256: string;
  buildMs: number;
  samples: { queryId: string; searchMs: number; resultCount: number }[];
  beforeIndex: { rss: number; heapUsed: number };
  afterIndex: { rss: number; heapUsed: number };
}
interface BenchReport {
  schema: string;
  profile: {
    id: string;
    documentCounts: number[];
    trials: number;
    warmupCycles: number;
    measurementCycles: number;
  };
  machine: { node: string; v8: string };
  sizes: { documentCount: number; trials: Trial[]; latency: ReturnType<typeof summarize> }[];
  limits: string[];
}
const root = fileURLToPath(new URL('..', import.meta.url));
function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    [root + '/node_modules/tsx/dist/cli.mjs', root + '/scripts/bench.ts', ...args],
    { cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  );
}

describe('actual benchmark source command and built public workers', () => {
  it('fails without partial JSON when the built public package is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'searchlite-benchmark-failure-'));
    try {
      for (const sub of ['scripts', 'examples', 'corpus']) mkdirSync(join(directory, sub));
      for (const file of [
        'scripts/bench.ts',
        'scripts/bench-worker.js',
        'examples/benchmark.ts',
        'corpus/glossary.ts',
        'corpus/queries.ts',
      ])
        copyFileSync(join(root, file), join(directory, file));
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'searchlite', type: 'module', exports: { '.': './absent.js' } }),
      );
      symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
      const result = spawnSync(
        process.execPath,
        [
          join(root, 'node_modules/tsx/dist/cli.mjs'),
          join(directory, 'scripts/bench.ts'),
          '--smoke',
        ],
        { cwd: directory, encoding: 'utf8', timeout: 15_000 },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^Benchmark failed/);
      expect(result.stderr).not.toContain(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('runs two fresh smoke workers with raw counts, identities and reconciled statistics', () => {
    const result = run('--smoke');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as BenchReport;
    expect(report.schema).toBe('searchlite.microbenchmark/1');
    expect(report.profile).toEqual({
      id: 'smoke',
      documentCounts: [60, 120],
      trials: 1,
      warmupCycles: 1,
      measurementCycles: 1,
    });
    expect(report.machine.node).toBe(process.version);
    expect(report.machine.v8).toBe(process.versions.v8);
    expect(report.sizes).toHaveLength(2);
    const pids = [];
    for (const size of report.sizes) {
      const trial = size.trials[0];
      if (!trial) throw new Error('Missing actual trial');
      pids.push(trial.processId);
      expect(trial.processId).not.toBe(process.pid);
      expect(trial.documentCount).toBe(size.documentCount);
      expect(trial.samples).toHaveLength(26);
      expect(trial.workloadSha256).toBe(
        createHash('sha256')
          .update(JSON.stringify(makeWorkload(size.documentCount, 1, 1)))
          .digest('hex'),
      );
      expect(size.latency.count).toBe(26);
      expect(size.latency.minMs).toBeGreaterThanOrEqual(0);
      expect(size.latency.maxMs).toBeGreaterThanOrEqual(size.latency.p95Ms);
      expect(size.latency.p95Ms).toBeGreaterThanOrEqual(size.latency.p50Ms);
      expect(trial.buildMs).toBeGreaterThanOrEqual(0);
      expect(trial.beforeIndex.rss).toBeGreaterThan(0);
      expect(trial.afterIndex.heapUsed).toBeGreaterThan(0);
      expect(new Set(trial.samples.map((s) => s.queryId)).size).toBe(26);
      expect(trial.samples.every((s) => s.resultCount >= 0 && s.resultCount <= 10)).toBe(true);
    }
    expect(new Set(pids).size).toBe(2);
    expect(report.limits.join(' ')).toMatch(/not.*production/);
  });

  it('provides standalone help and refuses ambiguous flags without echoing them', () => {
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/--smoke/);
    for (const args of [
      ['--smoke', '--smoke'],
      ['--help', '--smoke'],
      ['--output=/private/secret'],
      ['private-secret'],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Usage/);
      expect(result.stderr).not.toMatch(/private|secret|\n\s+at /);
    }
  });
});
