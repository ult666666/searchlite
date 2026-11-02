import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analysis/analyzer';
import { topDocuments, type PruningStatistics } from '../../src/engine/daat';
import { documentFrequencyOf, executePlan, type ExecutionContext } from '../../src/engine/execute';
import { FieldIndex } from '../../src/engine/field-index';
import { compileQuery, type Plan } from '../../src/engine/plan';
import { parseQuery, type DefaultOperator } from '../../src/query/parser';
import { SearchIndex, type SearchResult } from '../../src/search-index';

const WORDS = [
  'apple',
  'berry',
  'cedar',
  'delta',
  'ember',
  'fable',
  'grove',
  'haven',
  'ivory',
  'jolly',
  'koala',
  'lunar',
  'maple',
  'north',
  'ocean',
  'pearl',
  'quill',
  'raven',
  'solar',
  'tulip',
];
const NAMES = ['title', 'body', 'note'];

function random(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** A skewed vocabulary: the first words are very common, the last ones rare. */
function word(next: () => number): string {
  return WORDS[Math.floor(WORDS.length * next() ** 2.5)] ?? 'apple';
}

function text(next: () => number, maxWords: number, everywhere: boolean): string {
  const words = Array.from({ length: Math.floor(next() * (maxWords + 1)) }, () =>
    next() < 0.08 ? 'the' : word(next),
  );
  if (everywhere) words.push('apple');
  return words.join(' ');
}

interface Engine {
  fields: FieldIndex[];
  documents: Map<number, { lengths: number[] }>;
  k1: number;
  context: () => ExecutionContext;
}

/** Builds field indexes the way SearchIndex does, plus removals and out-of-order re-adds. */
function engine(next: () => number, size: number): Engine {
  const fields = NAMES.map(
    (name, f) =>
      new FieldIndex(
        name,
        [0.5, 1, 2.5, 4][Math.floor(next() * 4)] ?? 1,
        [0, 0.3, 0.75, 1][Math.floor(next() * 4)] ?? 0.75,
        new Analyzer({ stemming: f !== 2 || next() < 0.5, stopwords: true }),
      ),
  );
  const k1 = [0, 0.4, 1.2, 1.2, 3][Math.floor(next() * 5)] ?? 1.2;
  const everywhere = next() < 0.3;
  const documents = new Map<number, { lengths: number[] }>();
  const terms = new Map<number, string[][]>();
  const put = (n: number): void => {
    const lengths: number[] = [];
    const distinct: string[][] = [];
    fields.forEach((field, f) => {
      const tokens = field.analyzer.analyze(text(next, [3, 25, 6][f] ?? 5, everywhere && f === 1));
      const positions = new Map<string, number[]>();
      for (const token of tokens) {
        positions.set(token.term, [...(positions.get(token.term) ?? []), token.position]);
      }
      field.addDocument(n, positions, tokens.length);
      lengths.push(tokens.length);
      distinct.push([...positions.keys()]);
    });
    documents.set(n, { lengths });
    terms.set(n, distinct);
  };
  const drop = (n: number): void => {
    const lengths = documents.get(n)?.lengths ?? [];
    fields.forEach((field, f) => {
      field.removeDocument(n, terms.get(n)?.[f] ?? [], lengths[f] ?? 0);
    });
    documents.delete(n);
  };
  for (let n = 0; n < size; n++) put(n);
  // Removals leave gaps; re-adding under the same number (as replace does) inserts mid-list.
  for (let i = 0; i < size / 10; i++) {
    const n = Math.floor(next() * size);
    if (!documents.has(n)) continue;
    drop(n);
    if (next() < 0.6) put(n);
  }
  return {
    fields,
    documents,
    k1,
    context: () => ({
      fields,
      documents,
      documentCount: documents.size,
      k1,
      trace: false,
      cache: new Map(),
      documentFrequencies: new Map(),
    }),
  };
}

function leaf(next: () => number, depth: number): string {
  const w = word(next);
  const r = next();
  if (r < 0.4) return w;
  if (r < 0.52) return `"${w} ${word(next)}"`;
  if (r < 0.6) return `${w.slice(0, 2)}*`;
  if (r < 0.66) return `${w.slice(0, 2)}${w.slice(3)}~1`;
  if (r < 0.78) return `${NAMES[Math.floor(next() * 3)] ?? 'title'}:${w}`;
  if (r < 0.82) return 'the';
  if (depth > 1) return w;
  return `(${query(next, depth + 1)})`;
}

function query(next: () => number, depth = 0): string {
  const parts = [leaf(next, depth)];
  for (let i = 0, count = Math.floor(next() * 5); i < count; i++) {
    const r = next();
    const joiner =
      r < 0.55 ? ' ' : r < 0.75 ? ' OR ' : r < 0.88 ? ' AND ' : r < 0.94 ? ' -' : ' NOT ';
    parts.push(joiner + leaf(next, depth));
  }
  return parts.join('');
}

function compile(
  e: Engine,
  text: string,
  operator: DefaultOperator,
  defaults: number[],
): Plan | null {
  const ast = parseQuery(text, { defaultOperator: operator, fields: NAMES });
  return ast
    ? compileQuery(ast, {
        query: text,
        fields: e.fields,
        defaultFields: defaults,
        maxExpansions: 6,
      })
    : null;
}

/** Reference: score every match term-at-a-time, filter, sort by score then document number. */
function exhaustive(
  e: Engine,
  plan: Plan,
  limit: number,
  accept?: (document: number) => boolean,
): [number, number][] {
  return [...executePlan(plan, e.context())]
    .map(([document, hit]): [number, number] => [document, hit.score])
    .filter(([document]) => accept?.(document) ?? true)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit);
}

const FILTERS: (((document: number) => boolean) | undefined)[] = [
  undefined,
  (document) => Math.imul(document, 2654435761) >>> 0 < 2 ** 31,
  (document) => document % 7 === 0,
  () => false,
];

// Property tests do real work; coverage instrumentation on a busy runner needs more than 5 s.
describe('document-at-a-time top-k equals exhaustive scoring', { timeout: 30_000 }, () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('on random corpora and queries (seed %i)', (seed) => {
    const next = random(seed * 104729);
    const sizes = [1, 2, 7, 60, 300, 700];
    let compared = 0;
    for (const size of sizes) {
      const e = engine(next, size);
      for (let q = 0; q < 25; q++) {
        const text = query(next);
        const operator: DefaultOperator = next() < 0.75 ? 'OR' : 'AND';
        const defaults = next() < 0.8 ? [0, 1, 2] : [Math.floor(next() * 3)];
        const plan = compile(e, text, operator, defaults);
        if (!plan) continue;
        for (const limit of [1, 3, 10, 50, Infinity]) {
          const accept = FILTERS[Math.floor(next() * FILTERS.length)];
          const actual = topDocuments(plan, e.context(), limit, accept);
          expect(actual, `${text} (limit ${limit}, ${operator})`).toEqual(
            exhaustive(e, plan, limit, accept),
          );
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(400);
  });

  it('handles a single document, every document matching and complete ties', () => {
    const one = new SearchIndex({ fields: ['body'] });
    one.add({ id: 'only', body: 'apple berry' });
    expect(one.search('apple OR cedar').map((r) => r.id)).toEqual(['only']);
    expect(one.search('cedar OR delta')).toEqual([]);

    const tied = new SearchIndex({ fields: ['body'], k1: 0 });
    tied.addAll(Array.from({ length: 300 }, (_, i) => ({ id: `d${i}`, body: 'apple berry' })));
    // Every document matches with the same score, so insertion order decides.
    expect(tied.search('apple OR berry', { limit: 4 }).map((r) => r.id)).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
    ]);
    expect(tied.search('apple', { limit: 300 })).toHaveLength(300);
    // A query made only of stopwords has no terms left and returns nothing.
    expect(tied.search('the OF and')).toEqual([]);
  });

  it('applies a filter before the k-th best score, so rejected documents never raise it', () => {
    const index = new SearchIndex({ fields: ['body'] });
    index.addAll(
      Array.from({ length: 400 }, (_, i) => ({
        id: `d${i}`,
        body: i < 20 ? 'apple apple apple' : `apple ${'berry '.repeat(1 + (i % 9))}`,
      })),
    );
    const seen: string[] = [];
    const results = index.search('apple', {
      limit: 5,
      filter: (id, fields) => {
        seen.push(id);
        fields.body = 'changed';
        return Number(id.slice(1)) >= 20;
      },
    });
    const expected = Array.from({ length: 400 }, (_, i) => `d${i}`)
      .map((id, order) => ({ ...index.explain(id, 'apple'), order }))
      .filter((x) => Number(x.id.slice(1)) >= 20)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 5);
    expect(results.map((r) => [r.id, r.score])).toEqual(expected.map((x) => [x.id, x.score]));
    // Called only for documents that could enter the results, and given a copy of the fields.
    expect(seen.length).toBeLessThan(400);
    expect(index.get('d0')?.body).toBe('apple apple apple');
    expect(() => index.search('apple', { filter: 'yes' as never })).toThrow(
      /filter must be a function/,
    );
  });

  it('falls back to exhaustive scoring when parameters make a bound infinite', () => {
    const index = new SearchIndex({ fields: { title: { boost: 1e308 }, body: {} } });
    index.addAll([
      { id: 'a', title: 'apple apple', body: 'berry' },
      { id: 'b', title: 'berry', body: 'apple' },
      { id: 'c', title: 'cedar', body: 'apple berry' },
    ]);
    for (const text of ['apple OR berry', 'apple', 'apple AND berry']) {
      const expected = ['a', 'b', 'c']
        .map((id, order) => ({ ...index.explain(id, text), order }))
        .filter((x) => x.matched)
        .sort((a, b) => b.score - a.score || a.order - b.order);
      expect(
        index.search(text).map((r) => [r.id, r.score]),
        text,
      ).toEqual(expected.map((x) => [x.id, x.score]));
    }
  });

  it('counts document frequencies from cached tables, phrases and postings alike', () => {
    const e = engine(random(5), 80);
    for (const text of ['"apple berry"', 'apple', 'title:berry']) {
      const plan = compile(e, text, 'OR', [0, 1, 2]);
      if (plan?.kind !== 'match') throw new Error('Expected a single clause');
      const fromTable = executePlan(plan, e.context()).size;
      const cached = e.context();
      executePlan(plan, cached);
      expect(documentFrequencyOf(plan, e.context()), text).toBe(fromTable);
      expect(documentFrequencyOf(plan, cached), text).toBe(fromTable);
    }
  });

  it('skips work that cannot change the results', () => {
    const index = new SearchIndex({ fields: ['body'] });
    const documents = Array.from({ length: 5000 }, (_, i) => ({
      id: `d${i}`,
      body: i < 10 ? 'common common common' : `common ${i % 97 === 0 ? 'rare ' : ''}filler words`,
    }));
    index.addAll(documents);
    const field = new FieldIndex('body', 1, 0.75, new Analyzer());
    documents.forEach((document, n) => {
      const tokens = field.analyzer.analyze(document.body);
      const positions = new Map<string, number[]>();
      for (const t of tokens) positions.set(t.term, [...(positions.get(t.term) ?? []), t.position]);
      field.addDocument(n, positions, tokens.length);
    });
    const context = (): ExecutionContext => ({
      fields: [field],
      documents: new Map(documents.map((_, n) => [n, { lengths: [field.lengths[n] ?? 0] }])),
      documentCount: documents.length,
      k1: 1.2,
      trace: false,
      cache: new Map(),
      documentFrequencies: new Map(),
    });
    const plan = (text: string): Plan => {
      const ast = parseQuery(text);
      const compiled =
        ast &&
        compileQuery(ast, { query: text, fields: [field], defaultFields: [0], maxExpansions: 64 });
      if (!compiled) throw new Error('Expected a plan');
      return compiled;
    };
    for (const text of ['common', 'common OR rare']) {
      const statistics: PruningStatistics = { scored: 0, skippedWindows: 0 };
      const actual = topDocuments(plan(text), context(), 10, undefined, statistics);
      expect(actual).toEqual(
        [...executePlan(plan(text), context())]
          .map(([d, hit]) => [d, hit.score])
          .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || (a[0] ?? 0) - (b[0] ?? 0))
          .slice(0, 10),
      );
      // Thousands of documents match; pruning scores only a small fraction of them.
      expect(statistics.scored, text).toBeLessThan(500);
      expect(statistics.skippedWindows, text).toBeGreaterThan(0);
    }
  });
});

describe('public search against per-document explanations', { timeout: 30_000 }, () => {
  it.each([11, 12, 13])('with filters, array fields, mutations and snapshots (seed %i)', (seed) => {
    const next = random(seed);
    const index = new SearchIndex({
      fields: { title: { boost: 3 }, body: { b: 0.5 }, tags: { boost: 2, stemming: false } },
      k1: next() < 0.3 ? 0 : 1.2,
    });
    const documents = Array.from({ length: 150 }, (_, i) => ({
      id: `doc${i}`,
      title: text(next, 3, false),
      body: text(next, 20, i % 3 === 0),
      tags: Array.from({ length: Math.floor(next() * 3) }, () => word(next)),
    }));
    index.addAll(documents);
    for (let i = 0; i < 12; i++) index.remove(`doc${Math.floor(next() * 150)}`);
    for (let i = 0; i < 12; i++) {
      const id = `doc${Math.floor(next() * 150)}`;
      if (index.has(id))
        index.replace({ id, title: text(next, 3, false), body: text(next, 20, true) });
    }
    const restored = SearchIndex.fromJSON(JSON.parse(JSON.stringify(index)));
    const ids = documents.map((d) => d.id).filter((id) => index.has(id));
    for (const target of [index, restored]) {
      for (let q = 0; q < 18; q++) {
        const text = query(next).replaceAll('note:', 'tags:');
        const keep = (id: string): boolean => (Number(id.slice(3)) * 7) % 5 !== 0;
        const expected = ids
          .map((id, order) => ({ ...target.explain(id, text), order }))
          .filter((x) => x.matched && keep(x.id))
          .sort((a, b) => b.score - a.score || a.order - b.order);
        for (const limit of [1, 5, 20, Infinity]) {
          const actual = target.search(text, { limit, filter: (id) => keep(id) });
          expect(
            actual.map((r) => [r.id, r.score]),
            text,
          ).toEqual(expected.slice(0, limit).map((x) => [x.id, x.score]));
        }
      }
    }
  });
});

describe('snapshot migration', () => {
  interface Fixture {
    snapshot: { version: number };
    queries: { text: string; results: SearchResult[] }[];
  }
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/snapshot-v1.json', import.meta.url), 'utf8'),
  ) as Fixture;

  it('reads a version 1 snapshot written by searchlite 0.2.0 with identical results', () => {
    expect(fixture.snapshot.version).toBe(1);
    const migrated = SearchIndex.fromJSON(fixture.snapshot);
    const rewritten = SearchIndex.fromJSON(JSON.parse(JSON.stringify(migrated)));
    expect(migrated.toJSON().version).toBe(2);
    for (const { text, results } of fixture.queries) {
      for (const index of [migrated, rewritten]) {
        expect(index.search(text, { limit: Infinity }), text).toEqual(results);
        expect(index.search(text, { limit: 2 }), text).toEqual(results.slice(0, 2));
      }
    }
    // The compressed postings make the snapshot smaller than the version 1 original.
    expect(JSON.stringify(migrated).length).toBeLessThan(JSON.stringify(fixture.snapshot).length);
  });
});
