import { describe, expect, it } from 'vitest';
import { inverseDocumentFrequency, lengthNormalization, saturate } from '../../src/engine/bm25';
import { countPhraseMatches } from '../../src/engine/execute';
import type { QueryNode } from '../../src/query/ast';
import { SearchIndex } from '../../src/search-index';

const ids = (index: SearchIndex, query: string | QueryNode, options = {}): string[] =>
  index.search(query, options).map((result) => result.id);

describe('BM25 building blocks', () => {
  it('computes the Lucene-style idf, which stays positive for common terms', () => {
    expect(inverseDocumentFrequency(10, 1)).toBeCloseTo(Math.log(1 + 9.5 / 1.5), 12);
    expect(inverseDocumentFrequency(10, 10)).toBeGreaterThan(0);
  });

  it('normalizes length relative to the average', () => {
    expect(lengthNormalization(0.75, 10, 10)).toBe(1);
    expect(lengthNormalization(0.75, 20, 10)).toBeCloseTo(1.75, 12);
    expect(lengthNormalization(0, 20, 10)).toBe(1);
    expect(lengthNormalization(0.75, 5, 0)).toBe(1);
  });

  it('saturates term frequency towards k1 + 1', () => {
    expect(saturate(0, 1.2)).toBe(0);
    expect(saturate(1, 1.2)).toBeCloseTo(1, 12);
    expect(saturate(1000, 1.2)).toBeLessThan(2.2);
    expect(saturate(3, 0)).toBe(1);
  });
});

describe('BM25 on a single field (hand-computed)', () => {
  // avgdl = (2 + 3 + 4) / 3 = 3, N = 3, df(apple) = 2.
  const docs = [
    { id: 'd1', body: 'apple banana' },
    { id: 'd2', body: 'apple apple cherry' },
    { id: 'd3', body: 'banana cherry date fig' },
  ];
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));

  it('matches the textbook formula with k1 = 1.2 and b = 0.75', () => {
    const index = new SearchIndex({ fields: { body: { stemming: false } } });
    index.addAll(docs);
    const [first, second, third] = index.search('apple');
    // d2: tf = 2, length 3 → B = 1, so tf/B = 2 and the saturation is 2.2·2 / (1.2 + 2).
    expect(first?.id).toBe('d2');
    expect(first?.score).toBeCloseTo(idf * ((2.2 * 2) / (1.2 + 2)), 12);
    // d1: tf = 1, length 2 → B = 0.25 + 0.75·2/3 = 0.75, so tf/B = 4/3.
    expect(second?.id).toBe('d1');
    expect(second?.score).toBeCloseTo(idf * ((2.2 * (4 / 3)) / (1.2 + 4 / 3)), 12);
    expect(third).toBeUndefined();
  });

  it('ignores length when b = 0 and frequency when k1 = 0', () => {
    const noLength = new SearchIndex({ fields: { body: { stemming: false } }, b: 0 });
    noLength.addAll(docs);
    expect(noLength.search('apple').map((result) => result.score)).toEqual([
      expect.closeTo(idf * (4.4 / 3.2), 12),
      expect.closeTo(idf, 12),
    ]);

    const binary = new SearchIndex({ fields: { body: { stemming: false } }, k1: 0 });
    binary.addAll(docs);
    const results = binary.search('apple');
    // Equal scores, so insertion order breaks the tie.
    expect(results.map((result) => result.id)).toEqual(['d1', 'd2']);
    expect(results[0]?.score).toBeCloseTo(idf, 12);
    expect(results[1]?.score).toBeCloseTo(idf, 12);
  });
});

describe('BM25F across fields (hand-computed)', () => {
  const docs = [
    { id: 'd1', title: 'apple pie', body: 'fresh apple' },
    { id: 'd2', title: 'banana bread', body: 'apple apple apple banana' },
    { id: 'd3', title: 'cherry', body: 'cherry tart' },
  ];
  const fields = { title: { boost: 2, stemming: false }, body: { stemming: false } };
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));
  const saturation = (tf: number): number => (2.2 * tf) / (1.2 + tf);
  // Average lengths: title (2 + 2 + 1) / 3 = 5/3, body (2 + 4 + 2) / 3 = 8/3.
  const titleB = (length: number): number => 0.25 + (0.75 * length) / (5 / 3);
  const bodyB = (length: number): number => 0.25 + (0.75 * length) / (8 / 3);

  it('weights and normalizes each field before saturating once', () => {
    const index = new SearchIndex({ fields });
    index.addAll(docs);
    const scores = Object.fromEntries(
      index.search('apple').map((result) => [result.id, result.score]),
    );
    const d1 = idf * saturation((2 * 1) / titleB(2) + 1 / bodyB(2));
    const d2 = idf * saturation(3 / bodyB(4));
    expect(scores.d1).toBeCloseTo(d1, 12);
    expect(scores.d2).toBeCloseTo(d2, 12);
    expect(Object.keys(scores)).toEqual(['d1', 'd2']);
  });

  it('scores less than adding up independent per-field BM25 scores', () => {
    const index = new SearchIndex({ fields });
    index.addAll(docs);
    const combined = index.search('apple')[0]?.score ?? 0;
    const perFieldSum = idf * saturation((2 * 1) / titleB(2)) + idf * saturation(1 / bodyB(2));
    expect(combined).toBeLessThan(perFieldSum);
  });

  it('restricts a field-scoped term to that field, including its statistics', () => {
    const index = new SearchIndex({ fields });
    index.addAll(docs);
    const [only, ...rest] = index.search('title:apple');
    expect(only?.id).toBe('d1');
    expect(rest).toEqual([]);
    const titleIdf = Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5));
    expect(only?.score).toBeCloseTo(titleIdf * saturation((2 * 1) / titleB(2)), 12);
  });
});

describe('phrases', () => {
  it('count positional matches in linear time', () => {
    expect(
      countPhraseMatches(
        [
          [0, 5, 9],
          [1, 6, 12],
        ],
        [0, 1],
      ),
    ).toBe(2);
    expect(
      countPhraseMatches(
        [
          [0, 5],
          [2, 7],
        ],
        [0, 2],
      ),
    ).toBe(2);
    expect(countPhraseMatches([[3], [1]], [0, 1])).toBe(0);
    expect(
      countPhraseMatches(
        [
          [0, 1, 2],
          [1, 2, 3],
        ],
        [0, 1],
      ),
    ).toBe(3);
    expect(countPhraseMatches([[0, 4], [1, 5], [9]], [0, 1, 2])).toBe(0);
    expect(countPhraseMatches([], [])).toBe(0);
  });

  it('match words in order and score the phrase as a single pseudo-term', () => {
    const index = new SearchIndex({ fields: ['body'] });
    index.addAll([
      { id: 'p1', body: 'binary heap' },
      { id: 'p2', body: 'heap binary' },
      { id: 'p3', body: 'binary tree with a heap' },
    ]);
    expect(ids(index, '"binary heap"')).toEqual(['p1']);
    const explanation = index.explain('p1', '"binary heap"');
    const clause = explanation.clauses[0];
    expect(clause?.documentFrequency).toBe(1);
    expect(clause?.idf).toBeCloseTo(Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5)), 12);
    expect(clause?.terms).toEqual(['binari', 'heap']);
  });

  it('keep stopword gaps, so "bank of america" does not match "bank america"', () => {
    const index = new SearchIndex({ fields: ['body'] });
    index.addAll([
      { id: 'gap', body: 'Bank of America' },
      { id: 'adjacent', body: 'bank america' },
    ]);
    expect(ids(index, '"bank of america"')).toEqual(['gap']);
    expect(ids(index, '"bank america"')).toEqual(['adjacent']);
  });

  it('treat a word split by the tokenizer as a phrase', () => {
    const index = new SearchIndex({ fields: ['body'] });
    index.addAll([
      { id: 'hyphen', body: 'real-time systems' },
      { id: 'apart', body: 'time is real' },
    ]);
    expect(ids(index, 'real-time')).toEqual(['hyphen']);
  });

  it('do not match across the elements of an array field', () => {
    const index = new SearchIndex({ fields: ['tags'] });
    index.add({ id: 'x', tags: ['binary', 'heap'] });
    index.add({ id: 'y', tags: ['binary heap'] });
    expect(ids(index, '"binary heap"')).toEqual(['y']);
    // Same frequency and length, so the scores tie and insertion order decides.
    expect(ids(index, 'heap')).toEqual(['x', 'y']);
  });
});

describe('boolean queries', () => {
  const index = new SearchIndex({ fields: ['body'] });
  index.addAll([
    { id: 'a', body: 'red apple' },
    { id: 'b', body: 'green apple' },
    { id: 'c', body: 'red cherry' },
    { id: 'd', body: 'green pear' },
  ]);
  const matches = (query: string, options = {}): string[] => ids(index, query, options).sort();

  it('combine terms with OR by default and AND on request', () => {
    expect(matches('red apple')).toEqual(['a', 'b', 'c']);
    expect(ids(index, 'red apple')[0]).toBe('a');
    expect(matches('red AND apple')).toEqual(['a']);
    expect(matches('red apple', { defaultOperator: 'AND' })).toEqual(['a']);
    expect(matches('(red OR green) AND (apple OR pear)')).toEqual(['a', 'b', 'd']);
  });

  it('treat NOT and "-" as exclusions from the enclosing group', () => {
    expect(matches('apple -green')).toEqual(['a']);
    expect(matches('apple AND NOT green')).toEqual(['a']);
    expect(matches('apple OR NOT green')).toEqual(['a']);
    expect(matches('red -(apple OR pear)')).toEqual(['c']);
  });

  it('return nothing for a query made only of exclusions', () => {
    expect(matches('-green')).toEqual([]);
    expect(matches('NOT green')).toEqual([]);
    expect(matches('NOT green AND NOT red')).toEqual([]);
  });

  it('drop clauses that are only stopwords', () => {
    expect(matches('the apple')).toEqual(['a', 'b']);
    expect(matches('red AND the')).toEqual(['a', 'c']);
    expect(matches('the')).toEqual([]);
    expect(matches('-the')).toEqual([]);
    expect(matches('apple -the')).toEqual(['a', 'b']);
  });

  it('match nothing for unknown words, which still count inside AND', () => {
    expect(matches('zzz')).toEqual([]);
    expect(matches('apple AND zzz')).toEqual([]);
    expect(matches('apple OR zzz')).toEqual(['a', 'b']);
  });

  it('add up the scores of matching clauses', () => {
    const both = index.explain('a', 'red apple');
    expect(both.clauses.map((clause) => clause.clause)).toEqual(['red', 'apple']);
    expect(both.score).toBe(index.search('red apple')[0]?.score);
  });
});

describe('prefix queries', () => {
  const index = new SearchIndex({ fields: ['body'] });
  index.addAll([
    { id: 'design', body: 'database design' },
    { id: 'curation', body: 'dataset curation' },
    { id: 'lake', body: 'data lake' },
    { id: 'calendar', body: 'date' },
    { id: 'all', body: 'data database dataset' },
    { id: 'relational', body: 'relational model' },
    { id: 'relationship', body: 'relationship' },
  ]);

  it('expand to every dictionary term with the prefix', () => {
    expect(ids(index, 'data*').sort()).toEqual(['all', 'curation', 'design', 'lake']);
    expect(ids(index, 'dat*')).toContain('calendar');
  });

  it('score a document by its best expansion instead of the sum of all of them', () => {
    const explanation = index.explain('all', 'data*');
    expect(explanation.clauses).toHaveLength(1);
    const best = Math.max(
      ...['data', 'databas', 'dataset'].map((term) => index.explain('all', term).score),
    );
    expect(explanation.score).toBe(best);
  });

  it('also match the full word’s stem, which can be shorter than the word', () => {
    // "relational" is indexed as the stem "relat", which does not start with "relational".
    expect(ids(index, 'relational*')).toEqual(['relational']);
    expect(ids(index, 'relat*').sort()).toEqual(['relational', 'relationship']);
  });

  it('respect maxExpansions, keeping the shortest completions', () => {
    expect(ids(index, 'dat*', { maxExpansions: 1 }).sort()).toEqual(['all', 'lake']);
  });

  it('reject prefixes that are not a single word', () => {
    expect(() => index.search('real-ti*')).toThrow(/single word/);
    expect(() => index.search('..*')).toThrow(/single word/);
  });
});

describe('fuzzy queries', () => {
  const index = new SearchIndex({ fields: { title: {}, tags: { stemming: false } } });
  index.addAll([
    { id: 'volatility', title: 'Volatility', tags: ['risk'] },
    { id: 'database', title: 'Database index', tags: ['databases'] },
    { id: 'heap', title: 'Binary heap', tags: ['heap'] },
  ]);

  it('match misspelled words within the edit budget', () => {
    expect(ids(index, 'volatlity~1')).toEqual(['volatility']);
    expect(ids(index, 'databse~1')).toEqual(['database']);
    expect(ids(index, 'hepa~1')).toEqual(['heap']); // adjacent swap
    expect(ids(index, 'hepa~0')).toEqual([]);
    expect(ids(index, 'hepa')).toEqual([]);
  });

  it('down-weight matches by edit distance', () => {
    const exact = index.explain('heap', 'heap~1');
    const typo = index.explain('heap', 'hepa~1');
    expect(exact.clauses[0]?.weight).toBe(1);
    expect(typo.clauses[0]?.weight).toBe(0.5);
    expect(typo.score).toBeCloseTo(exact.score / 2, 12);
  });

  it('can be scoped to a field', () => {
    expect(ids(index, 'tags:databaes~2')).toEqual(['database']);
    expect(ids(index, 'tags:volatlity~1')).toEqual([]);
  });
});

describe('search options and results', () => {
  const index = new SearchIndex({ fields: { title: { boost: 2 }, body: {} } });
  index.addAll([
    { id: 1, title: 'Heap sort', body: 'Sorting with a binary heap.' },
    { id: 2, title: 'Merge sort', body: 'Divide and conquer sorting.' },
    { id: 3, title: 'Binary heap', body: 'A priority queue.' },
  ]);

  it('reports matched terms overall and per field', () => {
    const [result] = index.search('binary heap');
    expect(result?.id).toBe('3');
    expect(result?.terms).toEqual(['binari', 'heap']);
    expect(result?.match).toEqual({ title: ['binari', 'heap'] });
    expect(result?.fields).toEqual({ title: 'Binary heap', body: 'A priority queue.' });
  });

  it('limits results and can return every match', () => {
    expect(ids(index, 'sort', { limit: 1 })).toEqual(['1']);
    expect(ids(index, 'sort', { limit: Number.POSITIVE_INFINITY })).toHaveLength(2);
    expect(() => index.search('sort', { limit: 0 })).toThrow(/limit/);
    expect(() => index.search('sort', { limit: 1.5 })).toThrow(/limit/);
  });

  it('can restrict unscoped terms to some fields', () => {
    expect(ids(index, 'binary', { fields: ['body'] })).toEqual(['1']);
    expect(() => index.search('binary', { fields: ['nope'] })).toThrow(/not a searchable field/);
  });

  it('accepts a parsed query tree', () => {
    expect(ids(index, { type: 'term', text: 'merge', start: 0, end: 5 })).toEqual(['2']);
    expect(() => index.search(42 as unknown as string)).toThrow(/string or a parsed query/);
  });

  it('reports unknown fields with the column of the field name', () => {
    expect(() => index.search('heap price:low')).toThrow(
      'Unknown field "price"; searchable fields are: title, body (column 6)',
    );
    expect(() =>
      index.search({ type: 'term', text: 'x', field: 'price', start: 0, end: 1 }),
    ).toThrow(/Unknown field "price"/);
  });

  it('validates search options', () => {
    expect(() => index.search('x', null as unknown as object)).toThrow(/must be an object/);
    expect(() => index.search('x', { defaultOperator: 'XOR' as unknown as 'AND' })).toThrow(
      /defaultOperator/,
    );
  });

  it('explains every result with exactly the score search returned', () => {
    const queries = ['heap', 'binary heap', '"binary heap"', 'sort*', 'hepa~1', 'sort -merge'];
    for (const query of queries) {
      for (const result of index.search(query, { limit: Number.POSITIVE_INFINITY })) {
        const explanation = index.explain(result.id, query);
        expect(explanation.matched).toBe(true);
        expect(explanation.score).toBe(result.score);
        const clauseTotal = explanation.clauses.reduce((sum, clause) => sum + clause.score, 0);
        expect(clauseTotal).toBeCloseTo(result.score, 12);
      }
    }
  });

  it('explains a non-matching document as a zero score', () => {
    expect(index.explain(2, 'heap')).toEqual({
      id: '2',
      matched: false,
      score: 0,
      k1: 1.2,
      clauses: [],
    });
    expect(index.explain(2, 'the').matched).toBe(false);
    expect(() => index.explain('missing', 'heap')).toThrow(/No document/);
  });
});
