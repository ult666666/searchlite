import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIGURATIONS } from '../corpus/retrieval';
import { createComparison, serializeComparison } from '../examples/relevance-comparison';

describe('fixed-collection relevance comparison', () => {
  it('retains the existing evaluation values and full-ranking metric cutoffs', () => {
    const report = createComparison();
    expect(report.schema).toBe('searchlite.relevance-comparison/1');
    expect(report.collection.documents).toHaveLength(60);
    expect(report.collection.queries).toHaveLength(22);
    expect(report.depth).toBe(100);
    expect(report.baseline.metrics.precisionAt5).toBeCloseTo(0.364, 3);
    expect(report.baseline.metrics.recallAt10).toBeCloseTo(0.904, 3);
    expect(report.baseline.metrics.mrr).toBe(1);
    expect(report.baseline.metrics.map).toBeCloseTo(0.811, 3);
    expect(report.baseline.metrics.ndcgAt10).toBeCloseTo(0.927, 3);
    expect(report.candidate.metrics.mrr).toBeCloseTo(0.977, 3);
    expect(report.candidate.metrics.map).toBeCloseTo(0.785, 3);
    expect(report.candidate.metrics.ndcgAt10).toBeCloseTo(0.904, 3);
    expect(report.meanDelta.ndcgAt10).toBeLessThan(0);
  });

  it('shows short-run misses and grades without inflating precision denominators', () => {
    const report = createComparison('bm25f', 'bm25f');
    const query = report.queries.find((q) => q.id === 'q22');
    expect(query?.baseline.ranking[0]).toMatchObject({
      id: 'rate-limiting',
      rank: 1,
      grade: 3,
      title: 'Rate limiting',
    });
    expect(query?.baseline.metrics).toEqual({
      precisionAt5: 0.2,
      recallAt10: 1,
      mrr: 1,
      map: 1,
      ndcgAt10: 1,
    });
    expect(query?.baseline.missingRelevantAt10).toEqual([]);
    expect(query?.baseline.ranking[0]?.score).toBeGreaterThan(0);
    expect(report.baseline.scoreKind).toBe('BM25F');
    const rankingQuery = report.queries.find((q) => q.id === 'q02');
    expect(rankingQuery?.baseline.missingRelevantAt10).toEqual(['precision-and-recall']);
  });

  it('reports zero for identical configs and inverts every delta when swapped', () => {
    const same = createComparison('toy-hybrid', 'toy-hybrid');
    expect(Object.values(same.meanDelta)).toEqual([0, 0, 0, 0, 0]);
    expect(same.queries.every((q) => Object.values(q.delta).every((v) => v === 0))).toBe(true);
    const forward = createComparison('bm25f', 'no-stemming');
    const reverse = createComparison('no-stemming', 'bm25f');
    expect(reverse.baseline).toEqual(forward.candidate);
    expect(reverse.candidate).toEqual(forward.baseline);
    expect(reverse.meanDelta.ndcgAt10).toBe(-forward.meanDelta.ndcgAt10);
    expect(reverse.queries.map((q) => q.delta.ndcgAt10)).toEqual(
      forward.queries.map((q) => (q.delta.ndcgAt10 === 0 ? 0 : -q.delta.ndcgAt10)),
    );
  });

  it('owns exported input objects and remains deterministic across calls', () => {
    const first = createComparison();
    const original = serializeComparison(first);
    const document = first.collection.documents[0];
    const query = first.collection.queries[0];
    if (!document || !query) throw new Error('Missing collection fixture');
    document.title = 'mutated export';
    document.tags.push('mutated');
    query.judgements['hash-table'] = 0;
    expect(serializeComparison(createComparison())).toBe(original);
    expect(JSON.parse(original)).toMatchObject({
      schema: 'searchlite.relevance-comparison/1',
      baseline: { id: 'bm25f' },
      candidate: { id: 'no-stemming' },
    });
    expect(original.endsWith('\n')).toBe(true);
  });

  it('exercises all six real retrieval variants and refuses unknown identities', () => {
    expect(CONFIGURATIONS.map((c) => c.id)).toEqual([
      'bm25f',
      'no-stemming',
      'no-stopwords',
      'no-boosts',
      'single-field',
      'toy-hybrid',
    ]);
    const hybrid = createComparison('single-field', 'toy-hybrid');
    expect(hybrid.candidate.metrics.map).toBeCloseTo(0.843, 3);
    expect(hybrid.candidate.scoreKind).toBe('RRF');
    expect(hybrid.baseline.metrics.ndcgAt10).toBeCloseTo(0.925, 3);
    expect(hybrid.limits.join(' ')).toMatch(/spelling.*not meaning/);
    for (const id of ['__proto__', 'toString', '', 'BM25F']) {
      expect(() => createComparison(id)).toThrow(/configuration/i);
      expect(() => createComparison('bm25f', id)).toThrow(/configuration/i);
    }
  });
});

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/eval-compare.ts', import.meta.url));

describe('native comparison command', () => {
  it('emits the same complete deterministic report through its actual process', () => {
    const stdout = execFileSync(
      process.execPath,
      [tsx, cli, '--baseline=bm25f', '--candidate=no-stemming'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(stdout).toBe(serializeComparison(createComparison()));
  });

  it('prints help and refuses ambiguous flags without echoing supplied data', () => {
    const help = spawnSync(process.execPath, [tsx, cli, '--help'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/--baseline=ID/);
    for (const flags of [
      ['--candidate=/private/control\u001b[31m'],
      ['--baseline=bm25f', '--baseline=bm25f'],
      ['--help', '--candidate=bm25f'],
      ['--unknown=secret'],
      ['positional-secret'],
    ]) {
      const result = spawnSync(process.execPath, [tsx, cli, ...flags], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toMatch(/private|secret/);
      expect(result.stderr).not.toContain(String.fromCharCode(27));
      expect(result.stderr).toMatch(/Usage/);
    }
  });
});
