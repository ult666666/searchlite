import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repo, 'examples/search-docs.js');
let temporary: string, baseline: string, candidate: string, judgments: string, original: string;
const records = [
  { id: 'a.md', title: 'quartz', body: 'other private-body-a' },
  { id: 'b.md', title: 'other', body: 'quartz private-body-b' },
];
const fieldsBefore = { title: { boost: 3 }, body: {} };
const fieldsAfter = { title: {}, body: { boost: 3 } };
const build = `import {SearchIndex} from 'searchlite';
import {readFileSync,writeFileSync} from 'node:fs';
const [destination,fields,source]=process.argv.slice(1);
const index=new SearchIndex({fields:JSON.parse(fields)});
index.addAll(JSON.parse(readFileSync(source,'utf8')));
writeFileSync(destination,JSON.stringify(index.toJSON())+'\\n',{flag:'wx',mode:0o600});`;
interface Metrics {
  precisionAt5: number;
  recallAt10: number;
  mrr: number;
  map: number;
  ndcgAt10: number;
}
interface Side {
  passed: boolean;
  metrics: Metrics;
  ranking: { id: string; grade: number; rank: number; score: number }[];
  missingRelevantAt10: string[];
}
interface Comparison {
  schema: string;
  status: string;
  inputs: {
    baselineSnapshotSha256: string;
    candidateSnapshotSha256: string;
    judgmentsSha256: string;
    collectionSha256: string;
    documentCount: number;
    queryCount: number;
  };
  baseline: { status: string; failedQueries: string[]; configuration: unknown };
  candidate: { status: string; failedQueries: string[]; configuration: unknown };
  queries: {
    id: string;
    text: string;
    minimumNdcgAt10: number;
    baseline: Side;
    candidate: Side;
    delta: Metrics;
    passed: boolean;
  }[];
  regressedQueries: string[];
  failedMinimumQueries: string[];
  failedQueries: string[];
}
function at<T>(values: readonly T[], position: number): T {
  const value = values[position];
  if (value === undefined) throw new Error('Missing test fixture at ' + String(position));
  return value;
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
function snapshot(
  file: string,
  fields: Record<'title' | 'body', { boost?: number }> = fieldsBefore,
  documents = records,
) {
  writeFileSync(original, JSON.stringify(documents));
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', build, '--', file, JSON.stringify(fields), original],
    { cwd: repo, encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
}
function query(id = 'a', documentId = 'a.md', minimumNdcgAt10 = 0.5) {
  return { id, text: 'quartz', minimumNdcgAt10, relevance: [{ documentId, grade: 3 }] };
}
function save(queries = [query()]) {
  writeFileSync(
    judgments,
    JSON.stringify({ schema: 'searchlite.local-judgments/1', queries }) + '\n',
  );
}
function hash(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function compare(left = baseline, right = candidate, labels = judgments) {
  return run('compare', left, right, labels);
}
function report() {
  const result = compare();
  expect([0, 3], result.stderr).toContain(result.status);
  return { result, value: JSON.parse(result.stdout) as Comparison };
}
function refuses(args: string[], code: string) {
  const before = [baseline, candidate, judgments].map(hash);
  const result = run(...args);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(code);
  expect(result.stderr).not.toMatch(/\n\s+at /);
  expect([baseline, candidate, judgments].map(hash)).toEqual(before);
}

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'searchlite-local-compare-')));
  const source = join(temporary, 'original');
  mkdirSync(source);
  original = join(source, 'records.json');
  baseline = join(temporary, 'baseline.json');
  candidate = join(temporary, 'candidate.json');
  judgments = join(temporary, 'judgments.json');
  snapshot(baseline);
  snapshot(candidate, fieldsAfter);
  save();
});
afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

describe('same-collection comparison through actual built package and CLI processes', () => {
  it('fails a per-query drop even when both minima pass and aggregate improvement offsets it', () => {
    save([query('a', 'a.md'), query('b', 'b.md')]);
    const { result, value } = report();
    expect(result.status).toBe(3);
    expect(value.schema).toBe('searchlite.local-comparison/1');
    expect(value.status).toBe('fail');
    expect(value.baseline.status).toBe('pass');
    expect(value.candidate.status).toBe('pass');
    expect(value.regressedQueries).toEqual(['a']);
    expect(value.failedMinimumQueries).toEqual([]);
    expect(value.failedQueries).toEqual(['a']);
    const a = at(value.queries, 0),
      b = at(value.queries, 1);
    const discounted = 1 / Math.log2(3);
    expect(a.baseline.metrics.ndcgAt10).toBe(1);
    expect(a.candidate.metrics.ndcgAt10).toBeCloseTo(discounted, 14);
    expect(a.baseline.metrics.mrr).toBe(1);
    expect(a.candidate.metrics.mrr).toBe(0.5);
    expect(a.delta.ndcgAt10).toBe(3 / Math.log2(3) / 3 - 1);
    expect(a.delta.ndcgAt10).toBe(a.candidate.metrics.ndcgAt10 - a.baseline.metrics.ndcgAt10);
    expect(a.delta.mrr).toBe(-0.5);
    expect(a.passed).toBe(false);
    expect(a.candidate.passed).toBe(true);
    expect(b.passed).toBe(true);
    expect(a.delta.ndcgAt10 + b.delta.ndcgAt10).toBe(0);
    expect(a.baseline.ranking.map((r) => r.id)).toEqual(['a.md', 'b.md']);
    expect(a.candidate.ranking.map((r) => r.id)).toEqual(['b.md', 'a.md']);
    expect(result.stdout).not.toContain('private-body');
    expect(result.stdout).not.toContain(temporary);
  });
  it('passes identical inputs with zero deltas and byte-stable reruns after original source deletion', () => {
    const before = [baseline, judgments].map(hash);
    const result = compare(baseline, baseline);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout) as Comparison;
    expect(value.status).toBe('pass');
    expect(value.failedQueries).toEqual([]);
    expect(at(value.queries, 0).delta).toEqual({
      precisionAt5: 0,
      recallAt10: 0,
      mrr: 0,
      map: 0,
      ndcgAt10: 0,
    });
    expect(value.inputs).toEqual({
      baselineSnapshotSha256: hash(baseline),
      candidateSnapshotSha256: hash(baseline),
      judgmentsSha256: hash(judgments),
      collectionSha256: createHash('sha256')
        .update(JSON.stringify(records.map((d) => [d.id, d.title, d.body])))
        .digest('hex'),
      documentCount: 2,
      queryCount: 1,
    });
    rmSync(join(temporary, 'original'), { recursive: true });
    expect(compare(baseline, baseline).stdout).toBe(result.stdout);
    expect([baseline, judgments].map(hash)).toEqual(before);
  });
  it('passes an improved candidate meeting its minimum even when baseline failed that minimum', () => {
    save([query('better', 'b.md', 0.9)]);
    const { result, value } = report();
    expect(result.status).toBe(0);
    expect(value.baseline.failedQueries).toEqual(['better']);
    expect(value.candidate.failedQueries).toEqual([]);
    expect(value.failedQueries).toEqual([]);
    expect(value.regressedQueries).toEqual([]);
    expect(at(value.queries, 0).candidate.metrics.ndcgAt10).toBe(1);
  });
  it('fails a candidate minimum independently when it has not regressed', () => {
    save([query('minimum', 'b.md', 0.9)]);
    const result = compare(baseline, baseline);
    expect(result.status).toBe(3);
    const value = JSON.parse(result.stdout) as Comparison;
    expect(value.regressedQueries).toEqual([]);
    expect(value.failedMinimumQueries).toEqual(['minimum']);
    expect(value.failedQueries).toEqual(['minimum']);
  });
  it('accepts identical stored documents in a different snapshot order and records actual used hashes', () => {
    rmSync(candidate);
    snapshot(candidate, fieldsBefore, [...records].reverse());
    const { result, value } = report();
    expect(result.status).toBe(0);
    expect(value.inputs.baselineSnapshotSha256).toBe(hash(baseline));
    expect(value.inputs.candidateSnapshotSha256).toBe(hash(candidate));
    expect(value.inputs.judgmentsSha256).toBe(hash(judgments));
    expect(value.inputs.baselineSnapshotSha256).not.toBe(value.inputs.candidateSnapshotSha256);
  });
  for (const change of ['title', 'body', 'id', 'added', 'removed'] as const) {
    it(`refuses changed stored collection (${change}) before emitting any report`, () => {
      const documents = records.map((d) => ({ ...d }));
      if (change === 'added') documents.push({ id: 'c.md', title: 'extra', body: 'other' });
      else if (change === 'removed') documents.pop();
      else at(documents, 0)[change] += '-changed';
      rmSync(candidate);
      snapshot(candidate, fieldsAfter, documents);
      refuses(['compare', baseline, candidate, judgments], 'INCOMPARABLE_COLLECTION');
    });
  }
  for (const side of [0, 1] as const) {
    for (const bad of ['malformed', 'utf8', 'oversized', 'snapshot-schema'] as const) {
      it(`refuses ${bad} snapshot on side${side} without partial stdout or input changes`, () => {
        const file = at([baseline, candidate], side);
        const data =
          bad === 'malformed'
            ? Buffer.from('{')
            : bad === 'utf8'
              ? Buffer.from([0xff])
              : bad === 'oversized'
                ? Buffer.alloc(16 * 1024 * 1024 + 1)
                : Buffer.from('{}');
        writeFileSync(file, data);
        refuses(
          ['compare', baseline, candidate, judgments],
          bad === 'oversized' ? 'SNAPSHOT_LIMIT' : 'INVALID_SNAPSHOT',
        );
      });
    }
  }
  for (const position of [0, 1, 2] as const) {
    for (const kind of ['symlink', 'hardlink', 'directory'] as const) {
      it(`refuses ${kind} at input${position} without output or input mutation`, () => {
        const paths = [baseline, candidate, judgments];
        const alternative = join(temporary, 'unsafe');
        if (kind === 'symlink') symlinkSync(at(paths, position), alternative);
        else if (kind === 'hardlink') linkSync(at(paths, position), alternative);
        else mkdirSync(alternative);
        paths[position] = alternative;
        refuses(['compare', ...paths], kind === 'symlink' ? 'UNSAFE_PATH' : 'UNSAFE_FILE');
      });
    }
  }
  it('refuses bad, unknown-document, oversized or invalid-UTF8 labels after loading both snapshots', () => {
    for (const data of [
      Buffer.from('{}'),
      Buffer.from([0xff]),
      Buffer.alloc(256 * 1024 + 1),
      Buffer.from(
        JSON.stringify({
          schema: 'searchlite.local-judgments/1',
          queries: [query('bad', 'missing.md')],
        }),
      ),
    ]) {
      writeFileSync(judgments, data);
      refuses(
        ['compare', baseline, candidate, judgments],
        data.length > 256 * 1024 ? 'JUDGMENTS_LIMIT' : 'INVALID_JUDGMENTS',
      );
    }
  });
  it('refuses a late malformed query without exposing the earlier valid query report', () => {
    save([query(), { ...query('late'), text: '"' }]);
    refuses(['compare', baseline, candidate, judgments], 'INVALID_QUERY');
  });
  it('keeps control and prototype-named document/query identifiers inert and unlabelled grade zero', () => {
    const documents = [
      { id: 'a\u001b\u202e.md', title: 'quartz', body: 'other' },
      { id: '__proto__', title: 'other', body: 'quartz' },
    ];
    rmSync(baseline);
    rmSync(candidate);
    snapshot(baseline, fieldsBefore, documents);
    snapshot(candidate, fieldsBefore, documents);
    save([query('constructor', at(documents, 0).id)]);
    const { result, value } = report();
    expect(result.status).toBe(0);
    expect(at(value.queries, 0).id).toBe('constructor');
    expect(at(at(value.queries, 0).baseline.ranking, 1).grade).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout).not.toContain('\u202e');
    expect(at(at(value.queries, 0).baseline.ranking, 0).id).toBe(at(documents, 0).id);
  });
  it('retains canonical help and refuses missing, extra or blank comparison arguments as usage only', () => {
    expect(run('--help').stdout).toContain('compare BASELINE CANDIDATE JUDGMENTS');
    for (const args of [
      ['compare'],
      ['compare', baseline, candidate],
      ['compare', baseline, candidate, judgments, 'extra'],
      ['compare', '', candidate, judgments],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('USAGE');
    }
  });
});
