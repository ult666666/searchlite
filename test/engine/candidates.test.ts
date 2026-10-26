import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analysis/analyzer';
import { executePlan, type ExecutionContext } from '../../src/engine/execute';
import { FieldIndex } from '../../src/engine/field-index';
import { compileQuery, type Plan } from '../../src/engine/plan';
import { parseQuery } from '../../src/query/parser';
import { SearchIndex } from '../../src/search-index';

function fixture() {
  const field = new FieldIndex('body', 1, 0, new Analyzer({ stemming: false, stopwords: false }));
  const reads: number[] = [];
  const documents = new Map<number, { readonly lengths: readonly number[] }>();
  ['rare common', 'common', 'common'].forEach((text, id) => {
    const positions = new Map<string, number[]>();
    text.split(' ').forEach((term, position) => {
      const values = positions.get(term) ?? [];
      values.push(position);
      positions.set(term, values);
    });
    field.addDocument(id, positions, text.split(' ').length);
    documents.set(id, {
      get lengths() {
        reads.push(id);
        return [text.split(' ').length];
      },
    });
  });
  const context: ExecutionContext = {
    fields: [field],
    documents,
    documentCount: 3,
    k1: 1.2,
    trace: false,
    cache: new Map(),
  };
  const plan = (query: string): Plan => {
    const ast = parseQuery(query);
    if (!ast) throw new Error('Expected a fixture query');
    const result = compileQuery(ast, {
      query,
      fields: [field],
      defaultFields: [0],
      maxExpansions: 64,
    });
    if (!result) throw new Error('Expected a fixture plan');
    return result;
  };
  return { reads, context, plan };
}

describe('candidate-aware work without narrowing global statistics', () => {
  it('normalizes only surviving AND candidates while retaining global IDF', () => {
    const { reads, context, plan } = fixture();
    const hits = executePlan(plan('rare AND common'), context);
    expect([...hits.keys()]).toEqual([0]);
    expect(hits.get(0)?.score).toBe(Math.log(1 + 2.5 / 1.5) + Math.log(1 + 0.5 / 3.5));
    expect(reads).toEqual([0, 0]);
    expect([...context.cache.values()].map((entries) => entries.size)).toEqual([1, 3]);
  });

  it('does not normalize excluded matches or construct their traces', () => {
    const { reads, context, plan } = fixture();
    const hits = executePlan(plan('common NOT rare'), { ...context, trace: true });
    expect([...hits.keys()]).toEqual([1, 2]);
    expect(reads).toEqual([0, 1, 2]);
    for (const hit of hits.values())
      expect(hit.trace?.map((entry) => entry.plan.clause)).toEqual(['common']);
  });

  it('supports membership-only nested evaluation without reading lengths', () => {
    const { reads, context, plan } = fixture();
    const membership = { ...context, trace: true, score: false };
    const hits = executePlan(plan('(rare OR common) AND common NOT rare'), membership);
    expect([...hits.entries()]).toEqual([
      [1, { score: 0, trace: undefined }],
      [2, { score: 0, trace: undefined }],
    ]);
    expect(reads).toEqual([]);
  });

  it('preserves caller membership and full reusable occurrences, including only intersections', () => {
    const { reads, context, plan } = fixture();
    const common = plan('common');
    const candidates = new Map<number, unknown>([[0, 'caller-owned']]);
    const scoped = { ...context, candidates };
    const first = executePlan(common, scoped);
    expect([...first.keys()]).toEqual([0]);
    expect(first.get(0)?.score).toBe(Math.log(1 + 0.5 / 3.5));
    expect(executePlan(common, { ...scoped, only: 1 }).size).toBe(0);
    expect(executePlan(common, { ...scoped, only: 0, trace: true }).get(0)?.trace).toHaveLength(1);
    expect([...executePlan(common, context).keys()]).toEqual([0, 1, 2]);
    expect([...candidates.entries()]).toEqual([[0, 'caller-owned']]);
    expect([...context.cache.values()].map((entries) => entries.size)).toEqual([3]);
    expect(reads).toEqual([0, 0, 0, 1, 2]);
  });

  it('short-circuits empty intersections and excluded-only groups', () => {
    const { reads, context, plan } = fixture();
    for (const query of ['absent AND common', '(absent AND common) OR (NOT rare)', 'NOT common']) {
      expect(executePlan(plan(query), context).size).toBe(0);
    }
    expect(reads).toEqual([]);
  });

  it('restricts alternatives and nested exclusions to surviving candidates', () => {
    const { reads, context, plan } = fixture();
    const hits = executePlan(
      plan('rare AND (comm* OR common~1) NOT (absent OR (common NOT rare))'),
      context,
    );
    expect([...hits.keys()]).toEqual([0]);
    expect(hits.get(0)?.score).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([0]));
  });
});

describe('public ranking versus exhaustive per-document explanations', () => {
  it.each([0, 1.2, 8])(
    'retains every score and insertion tie after mutations/restoration, k1=%s',
    (k1) => {
      let seed = 0x12345678;
      const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
      };
      const words = ['binary', 'heap', 'tree', 'shared', 'phrase', 'index', 'storage', 'running'];
      const text = () =>
        Array.from({ length: 1 + (next() % 9) }, () => words[next() % words.length]).join(' ');
      const documents = Array.from({ length: 48 }, (_, n) => ({
        id: 'd' + String(n),
        title: text(),
        body: n % 7 === 0 ? '' : text(),
        tags: n % 2 ? ['running', 'tree'] : [],
      }));
      const index = new SearchIndex({
        fields: { title: { boost: 3, b: 1 }, body: {}, tags: { stemming: false, boost: 2 } },
        k1,
      });
      index.addAll(documents);
      index.remove('d4');
      index.remove('d19');
      index.replace({
        id: 'd8',
        title: 'binary heap',
        body: 'shared phrase heap',
        tags: ['running'],
      });
      const restored = SearchIndex.fromJSON(index.toJSON());
      const ids = documents.map((d) => d.id).filter((id) => id !== 'd4' && id !== 'd19');
      const queries = [
        'heap AND tree',
        'tree AND heap',
        'heap AND (binary OR tree)',
        '(heap OR binary) AND tree NOT storage',
        'heap AND heap AND tree',
        'heap NOT (tree AND storage)',
        '(heap NOT tree) OR (binary AND tree)',
        '"shared phrase" AND heap',
        'heap AND title:bin*',
        'heap AND tre~1',
        'heap AND tags:running',
        '(absent AND heap) OR tree',
        'NOT heap',
        'heap tree',
        'title:running OR body:running',
      ];
      for (const target of [index, restored])
        for (const query of queries)
          for (const defaultOperator of ['AND', 'OR'] as const) {
            const expected = ids
              .map((id, order) => ({ ...target.explain(id, query, { defaultOperator }), order }))
              .filter((value) => value.matched)
              .sort((a, b) => b.score - a.score || a.order - b.order)
              .map(({ id, score }) => ({ id, score }));
            for (const limit of [1, 7, Infinity]) {
              const actual = target.search(query, { defaultOperator, limit });
              expect(
                actual.map(({ id, score }) => ({ id, score })),
                query,
              ).toEqual(expected.slice(0, limit));
            }
          }
    },
  );
});
