import { describe, expect, it } from 'vitest';
import { cosineSimilarity, reciprocalRankFusion } from '../src/hybrid';
import { SearchIndex } from '../src/search-index';

describe('reciprocalRankFusion', () => {
  it('matches hand-computed scores with the default k = 60', () => {
    const fused = reciprocalRankFusion([
      ['d1', 'd2', 'd3'],
      ['d3', 'd1', 'd4'],
    ]);
    expect(fused.map((result) => result.id)).toEqual(['d1', 'd3', 'd2', 'd4']);
    const scores = fused.map((result) => result.score);
    expect(scores[0]).toBeCloseTo(1 / 61 + 1 / 62, 15);
    expect(scores[1]).toBeCloseTo(1 / 63 + 1 / 61, 15);
    expect(scores[2]).toBeCloseTo(1 / 62, 15);
    expect(scores[3]).toBeCloseTo(1 / 63, 15);
  });

  it('uses 1 / (k + rank), so k = 0 gives plain reciprocal ranks', () => {
    expect(
      reciprocalRankFusion(
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
        { k: 0 },
      ),
    ).toEqual([
      { id: 'b', score: 1.5 },
      { id: 'a', score: 1 },
      { id: 'c', score: 0.5 },
    ]);
  });

  it('counts a repeated id once per ranking and breaks ties by id', () => {
    expect(reciprocalRankFusion([['x', 'x', 'y']], { k: 0 })).toEqual([
      { id: 'x', score: 1 },
      { id: 'y', score: 1 / 3 },
    ]);
    expect(reciprocalRankFusion([['b'], ['a']]).map((result) => result.id)).toEqual(['a', 'b']);
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('rejects an invalid k', () => {
    expect(() => reciprocalRankFusion([['a']], { k: -1 })).toThrow(/RRF k/);
    expect(() => reciprocalRankFusion([['a']], { k: Number.NaN })).toThrow(/RRF k/);
  });
});

describe('cosineSimilarity', () => {
  it('computes the cosine of the angle between vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(24 / 25, 12);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rejects vectors of different lengths', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/same length/);
  });
});

describe('SearchIndex.searchHybrid', () => {
  function build(): SearchIndex {
    const index = new SearchIndex({ fields: ['body'], vectorField: 'embedding' });
    index.addAll([
      { id: 'a', body: 'red apple', embedding: [1, 0] },
      { id: 'b', body: 'green apple', embedding: [0, 1] },
      { id: 'c', body: 'red cherry', embedding: [0.8, 0.6] },
      { id: 'd', body: 'no vector here' },
    ]);
    return index;
  }

  it('fuses the keyword and vector rankings with RRF (hand-computed)', () => {
    // Keyword ranking for "apple": a, b (tied scores, insertion order).
    // Vector ranking for [0, 1]: b (cos 1), c (cos 0.6), a (cos 0).
    const results = build().searchHybrid({ query: 'apple', vector: [0, 1] });
    expect(results.map((result) => result.id)).toEqual(['b', 'a', 'c']);
    expect(results[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 15);
    expect(results[1]?.score).toBeCloseTo(1 / 61 + 1 / 63, 15);
    expect(results[2]?.score).toBeCloseTo(1 / 62, 15);
    expect(results[0]?.semantic).toEqual({ rank: 1, similarity: 1 });
    expect(results[0]?.lexical?.rank).toBe(2);
    expect(results[2]?.lexical).toBeUndefined();
    expect(results[0]?.fields).toEqual({ body: 'green apple' });
  });

  it('works with only one of the two inputs', () => {
    const index = build();
    expect(index.searchHybrid({ vector: [1, 0] }).map((result) => result.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(index.searchHybrid({ query: 'red' }).map((result) => result.id)).toEqual(['a', 'c']);
  });

  it('honours k, depth and rrfK', () => {
    const index = build();
    expect(index.searchHybrid({ query: 'apple', vector: [0, 1], k: 1 })).toHaveLength(1);
    const shallow = index.searchHybrid({ query: 'apple', vector: [0, 1], depth: 1, rrfK: 0 });
    expect(shallow).toEqual([
      expect.objectContaining({ id: 'a', score: 1 }),
      expect.objectContaining({ id: 'b', score: 1 }),
    ]);
  });

  it('validates its input', () => {
    const index = build();
    expect(() => index.searchHybrid({})).toThrow(/needs a query, a vector, or both/);
    expect(() => index.searchHybrid(null as never)).toThrow(/options object/);
    expect(() => index.searchHybrid({ vector: [1, 2, 3] })).toThrow(/3 dimensions/);
    expect(() => index.searchHybrid({ vector: [] })).toThrow(/finite numbers/);
    expect(() => index.searchHybrid({ query: 'red', k: 0 })).toThrow(/k must be/);
    const plain = new SearchIndex({ fields: ['body'] });
    expect(() => plain.searchHybrid({ vector: [1] })).toThrow(/no vectorField/);
  });

  it('validates document vectors', () => {
    const index = build();
    expect(() => {
      index.add({ id: 'e', body: 'x', embedding: [1, 2, 3] });
    }).toThrow(/has 3 dimensions, but this index uses 2/);
    expect(() => {
      index.add({ id: 'f', body: 'x', embedding: 'nope' });
    }).toThrow(/non-empty array of finite numbers/);
    const empty = new SearchIndex({ fields: ['body'], vectorField: 'embedding' });
    expect(() => {
      empty.addAll([
        { id: 'g', embedding: [1, 2] },
        { id: 'h', embedding: [1, 2, 3] },
      ]);
    }).toThrow(/dimensions/);
  });

  it('keeps vectors through serialization and frees the dimension once none are left', () => {
    const index = build();
    const restored = SearchIndex.fromJSON(JSON.parse(JSON.stringify(index)));
    expect(restored.searchHybrid({ vector: [0, 1] })).toEqual(
      index.searchHybrid({ vector: [0, 1] }),
    );
    for (const id of ['a', 'b', 'c']) {
      index.remove(id);
    }
    index.add({ id: 'z', body: 'three dimensions', embedding: [0, 0, 1] });
    expect(index.searchHybrid({ vector: [0, 0, 1] })[0]?.id).toBe('z');
  });
});
