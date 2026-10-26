import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
let temporary: string, snapshot: string, judgments: string, docs: string;
interface QueryReport {
  id: string;
  text: string;
  minimumNdcgAt10: number;
  passed: boolean;
  ranking: { id: string; grade: number; score: number }[];
  missingRelevantAt10: string[];
  metrics: { precisionAt5: number; recallAt10: number; mrr: number; map: number; ndcgAt10: number };
}
interface Report {
  schema: string;
  status: string;
  inputs: {
    snapshotSha256: string;
    judgmentsSha256: string;
    documentCount: number;
    queryCount: number;
  };
  queries: [QueryReport, ...QueryReport[]];
  configuration: { fields: { name: string }[] };
  failedQueries: string[];
}

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'searchlite-local-eval-')));
  docs = join(temporary, 'notes');
  mkdirSync(docs);
  writeFileSync(join(docs, 'a.md'), 'quartz');
  writeFileSync(join(docs, 'b.md'), 'quartz');
  writeFileSync(join(docs, 'c.md'), 'saffron');
  snapshot = join(temporary, 'index.json');
  judgments = join(temporary, 'judgments.json');
  const result = run('index', docs, snapshot);
  expect(result.status, result.stderr).toBe(0);
  save(manifest());
});
afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
function queryFixture() {
  return {
    id: 'q1',
    text: 'quartz',
    minimumNdcgAt10: 0.5,
    relevance: [
      { documentId: 'a.md', grade: 1 },
      { documentId: 'b.md', grade: 3 },
      { documentId: 'c.md', grade: 2 },
    ],
  };
}
function manifest() {
  return {
    schema: 'searchlite.local-judgments/1',
    queries: [queryFixture()] as [ReturnType<typeof queryFixture>],
  };
}
function save(value: unknown) {
  writeFileSync(judgments, JSON.stringify(value) + '\n');
}
function hash(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function evaluate() {
  return run('evaluate', snapshot, judgments);
}
function invalid(code = 'INVALID_JUDGMENTS') {
  const before = [hash(snapshot), hash(judgments)];
  const result = evaluate();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(code);
  expect(result.stderr).not.toMatch(/\n\s+at /);
  expect([hash(snapshot), hash(judgments)]).toEqual(before);
}

describe('local snapshot relevance evaluation through built exports', () => {
  it('keeps relevant results beyond rank10 in full-ranking MRR and MAP', () => {
    rmSync(docs, { recursive: true });
    mkdirSync(docs);
    for (let i = 0; i < 11; i++)
      writeFileSync(join(docs, `doc-${String(i).padStart(2, '0')}.md`), 'quartz');
    rmSync(snapshot);
    expect(run('index', docs, snapshot).status).toBe(0);
    save({
      schema: 'searchlite.local-judgments/1',
      queries: [
        {
          id: 'deep',
          text: 'quartz',
          minimumNdcgAt10: 0,
          relevance: [{ documentId: 'doc-10.md', grade: 3 }],
        },
      ],
    });
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.queries[0].ranking).toHaveLength(11);
    expect(report.queries[0].metrics).toEqual({
      precisionAt5: 0,
      recallAt10: 0,
      mrr: 1 / 11,
      map: 1 / 11,
      ndcgAt10: 0,
    });
    expect(report.queries[0].missingRelevantAt10).toEqual(['doc-10.md']);
  });

  it('treats unlabelled prototype-named snapshot IDs as numeric grade0', () => {
    const raw = JSON.parse(readFileSync(snapshot, 'utf8')) as { documents: { id: string }[] };
    raw.documents.forEach((document, i) => {
      document.id = ['toString', 'constructor', '__proto__'][i] ?? document.id;
    });
    writeFileSync(snapshot, JSON.stringify(raw));
    save({
      schema: 'searchlite.local-judgments/1',
      queries: [
        {
          id: 'prototype-ids',
          text: 'quartz OR saffron',
          minimumNdcgAt10: 0,
          relevance: [{ documentId: 'constructor', grade: 3 }],
        },
      ],
    });
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.queries[0].ranking.find((row) => row.id === 'toString')?.grade).toBe(0);
    expect(report.queries[0].ranking.find((row) => row.id === '__proto__')?.grade).toBe(0);
    expect(report.queries[0].ranking.find((row) => row.id === 'constructor')?.grade).toBe(3);
  });

  it('reports hand-computed metrics, exact used input identities and missing relevant IDs', () => {
    const before = readdirSync(temporary).sort();
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.schema).toBe('searchlite.local-evaluation/1');
    expect(report.status).toBe('pass');
    expect(report.inputs).toEqual({
      snapshotSha256: hash(snapshot),
      judgmentsSha256: hash(judgments),
      documentCount: 3,
      queryCount: 1,
    });
    expect(report.queries[0].ranking.map((r: { id: string }) => r.id)).toEqual(['a.md', 'b.md']);
    expect(report.queries[0].ranking.map((r: { grade: number }) => r.grade)).toEqual([1, 3]);
    expect(report.queries[0].ranking[0]?.score).toBeGreaterThan(0);
    expect(report.queries[0].missingRelevantAt10).toEqual(['c.md']);
    const measured = report.queries[0].metrics;
    expect(measured.precisionAt5).toBe(2 / 5);
    expect(measured.recallAt10).toBe(2 / 3);
    expect(measured.mrr).toBe(1);
    expect(measured.map).toBe(2 / 3);
    expect(measured.ndcgAt10).toBeCloseTo(
      (1 + 3 / Math.log2(3)) / (3 + 2 / Math.log2(3) + 1 / Math.log2(4)),
      14,
    );
    expect(report.configuration.fields.map((f: { name: string }) => f.name)).toEqual([
      'title',
      'body',
    ]);
    expect(report.failedQueries).toEqual([]);
    expect(readdirSync(temporary).sort()).toEqual(before);
  });

  it('returns complete failed-criterion JSON with exit3 and no diagnostic or input writes', () => {
    const input = manifest();
    input.queries[0].minimumNdcgAt10 = 1;
    save(input);
    const before = [hash(snapshot), hash(judgments)];
    const result = evaluate();
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as Report;
    expect(report.status).toBe('fail');
    expect(report.failedQueries).toEqual(['q1']);
    expect(report.queries[0].passed).toBe(false);
    expect(report.queries[0].minimumNdcgAt10).toBe(1);
    expect(report.queries[0].metrics.ndcgAt10).toBeLessThan(1);
    expect([hash(snapshot), hash(judgments)]).toEqual(before);
  });

  it('uses only the saved snapshot and is deterministic after original documents are removed', () => {
    const before = evaluate();
    expect(before.status, before.stderr).toBe(0);
    rmSync(docs, { recursive: true });
    const after = evaluate();
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe(before.stdout);
    expect(existsSync(docs)).toBe(false);
  });

  it('preserves controlled string semantics while emitting no raw terminal/bidi controls', () => {
    const file = 'direction\u202e.md';
    writeFileSync(join(docs, file), 'quartz');
    rmSync(snapshot);
    expect(run('index', docs, snapshot).status).toBe(0);
    save({
      schema: 'searchlite.local-judgments/1',
      queries: [
        {
          id: 'controls',
          text: 'quartz\n\u007f\u202e',
          minimumNdcgAt10: 0,
          relevance: [{ documentId: file, grade: 3 }],
        },
      ],
    });
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(String.fromCharCode(127));
    expect(result.stdout).not.toContain('\u202e');
    const report = JSON.parse(result.stdout) as Report;
    expect(report.queries[0].text).toBe('quartz\n\u007f\u202e');
    expect(report.queries[0].ranking.some((r: { id: string }) => r.id === file)).toBe(true);
  });

  it('keeps all full-ranking metrics and refuses a late bad query without partial output', () => {
    const input = manifest();
    input.queries.push({ ...input.queries[0], id: 'q2', text: '(' });
    save(input);
    invalid('INVALID_QUERY');
  });

  it.each<[string, unknown]>([
    ['missing schema', { queries: [] }],
    ['wrong schema', { schema: 'other', queries: [] }],
    ['unknown field', { ...manifest(), extra: true }],
    ['zero queries', { ...manifest(), queries: [] }],
    [
      'too many queries',
      {
        ...manifest(),
        queries: Array.from({ length: 33 }, (_, i) => ({ ...manifest().queries[0], id: `q${i}` })),
      },
    ],
    [
      'duplicate queries',
      { ...manifest(), queries: [manifest().queries[0], manifest().queries[0]] },
    ],
    ...(
      [
        ['unknown query field', { extra: true }],
        ['empty text', { text: ' ' }],
        ['too long text', { text: 'x'.repeat(1001) }],
        ['NUL text', { text: 'quartz\0' }],
        ['prototype query id', { id: '__proto__' }],
        ['missing threshold', { minimumNdcgAt10: undefined }],
        ['string threshold', { minimumNdcgAt10: '0.5' }],
        ['negative threshold', { minimumNdcgAt10: -0.1 }],
        ['large threshold', { minimumNdcgAt10: 1.1 }],
        ['no relevance', { relevance: [] }],
        [
          'duplicate document',
          {
            relevance: [
              { documentId: 'a.md', grade: 1 },
              { documentId: 'a.md', grade: 3 },
            ],
          },
        ],
        ['unknown document', { relevance: [{ documentId: 'absent.md', grade: 3 }] }],
        ['negative grade', { relevance: [{ documentId: 'a.md', grade: -1 }] }],
        ['fractional grade', { relevance: [{ documentId: 'a.md', grade: 1.5 }] }],
        ['large grade', { relevance: [{ documentId: 'a.md', grade: 4 }] }],
        ['all irrelevant', { relevance: [{ documentId: 'a.md', grade: 0 }] }],
        ['unknown grade field', { relevance: [{ documentId: 'a.md', grade: 3, extra: true }] }],
      ] as [string, Record<string, unknown>][]
    ).map(([label, changes]): [string, unknown] => [
      label,
      { ...manifest(), queries: [{ ...queryFixture(), ...changes }] },
    ]),
  ])('refuses %s without modifying inputs', (_label, input) => {
    save(input);
    invalid();
  });

  it('refuses nonfinite thresholds from valid JSON numeric overflow', () => {
    writeFileSync(
      judgments,
      JSON.stringify(manifest()).replace('"minimumNdcgAt10":0.5', '"minimumNdcgAt10":1e400'),
    );
    invalid();
  });

  it('bounds and decodes the actual manifest bytes before parsing', () => {
    writeFileSync(judgments, ' '.repeat(256 * 1024 + 1));
    invalid('JUDGMENTS_LIMIT');
    writeFileSync(judgments, Buffer.from([0xff, 0xfe]));
    invalid();
    writeFileSync(judgments, '{');
    invalid();
  });

  it('refuses unsafe file kinds and linked ancestors without blocking or writes', () => {
    const original = readFileSync(judgments);
    const unsafe = join(temporary, 'unsafe.json');
    symlinkSync(judgments, unsafe);
    expect(run('evaluate', snapshot, unsafe).stderr).toContain('UNSAFE_PATH');
    rmSync(unsafe);
    linkSync(judgments, unsafe);
    expect(run('evaluate', snapshot, unsafe).stderr).toContain('UNSAFE_FILE');
    rmSync(unsafe);
    mkdirSync(unsafe);
    expect(run('evaluate', snapshot, unsafe).stderr).toContain('UNSAFE_FILE');
    rmSync(unsafe, { recursive: true });
    const linked = join(temporary, 'linked');
    symlinkSync(temporary, linked);
    expect(run('evaluate', snapshot, join(linked, 'judgments.json')).stderr).toContain(
      'UNSAFE_PATH',
    );
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [unsafe]);
      const result = run('evaluate', snapshot, unsafe);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('UNSAFE_FILE');
    }
    expect(readFileSync(judgments)).toEqual(original);
  });
});
